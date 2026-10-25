import { mkdir, readFile, readdir, writeFile, stat, rm, rmdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { LocalDatabase } from '../../server/storage/database';
import { safeArtifactPath } from '../../server/workspace/paths';
import { APP_VERSION, STORAGE_SCHEMA_VERSION } from '../../domain/app-version';
import { validateCatalog, validateSnapshot } from '../publishing/validate-version';
import type { Operation } from '../../domain/contracts';

export interface BackupInfo { id:string;at:string;reason:'manual'|'before_restore'|'before_migration';applicationVersion:string;storageSchemaVersion:number;sha256:string;bytes:number }
const backupInfoSchema=z.object({id:z.string().uuid(),at:z.iso.datetime({offset:true}),reason:z.enum(['manual','before_restore','before_migration']),applicationVersion:z.string().regex(/^\d+\.\d+\.\d+$/),storageSchemaVersion:z.number().int().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive()}).passthrough();
async function hashFile(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
function requireId(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Некорректный идентификатор резервной копии');}
async function location(root:string,id:string){requireId(id);return safeArtifactPath(root,`backups/${id}`);}
export async function createBackup(db:LocalDatabase,root:string,reason:BackupInfo['reason']='manual'):Promise<BackupInfo>{
  const id=randomUUID(),folder=await location(root,id);await mkdir(folder,{recursive:true});
  const file=join(folder,'database.sqlite');db.snapshot(file);
  const result:BackupInfo={id,at:new Date().toISOString(),reason,applicationVersion:APP_VERSION,storageSchemaVersion:db.get<number>('settings','storageSchemaVersion')??1,sha256:await hashFile(file),bytes:(await stat(file)).size};
  await writeFile(join(folder,'manifest.json'),JSON.stringify(result,null,2),'utf8');return result;
}
export async function listBackups(root:string):Promise<BackupInfo[]>{
  const folder=await safeArtifactPath(root,'backups');let names:string[];try{names=await readdir(folder);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e;}
  const results:BackupInfo[]=[];
  for(const id of names){if(!/^[a-f0-9-]{36}$/.test(id))continue;try{const directory=await location(root,id),item=backupInfoSchema.parse(JSON.parse(await readFile(await safeArtifactPath(directory,'manifest.json'),'utf8')));if(item.id===id)results.push(item);}catch{}}
  return results.sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id));
}
async function validateBackup(root:string,id:string){
  const folder=await location(root,id),file=await safeArtifactPath(folder,'database.sqlite');
  const info=backupInfoSchema.parse(JSON.parse(await readFile(await safeArtifactPath(folder,'manifest.json'),'utf8')));
  if(info.id!==id||info.storageSchemaVersion>STORAGE_SCHEMA_VERSION)throw new Error('Копия требует более новой версии программы');
  if((await stat(file)).size!==info.bytes||await hashFile(file)!==info.sha256)throw new Error('Контрольная сумма резервной копии не совпадает');
  let inspect:DatabaseSync|undefined;
  try{
    inspect=new DatabaseSync(file,{readOnly:true});
    if((inspect.prepare('PRAGMA integrity_check').get() as Record<string,unknown>).integrity_check!=='ok')throw new Error('Копия повреждена');
    const columns=inspect.prepare('PRAGMA table_info(records)').all() as {name:string;type:string;notnull:number;pk:number}[];
    const expected=[['namespace',1],['id',2],['value',0]] as const;
    if(columns.length!==3||expected.some(([name,pk])=>!columns.some(column=>column.name===name&&column.type.toUpperCase()==='TEXT'&&column.notnull===1&&column.pk===pk)))throw new Error('Таблица records в копии не соответствует схеме приложения');
    if(inspect.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='records'").all().length)throw new Error('Копия содержит неподдерживаемые триггеры хранилища');
    const records=inspect.prepare('SELECT namespace,id,value FROM records').all() as {namespace:string;id:string;value:string}[];
    let actualVersion:unknown=1;
    for(const row of records){
      if(typeof row.namespace!=='string'||!row.namespace||typeof row.id!=='string'||!row.id)throw new Error('В копии нарушены ключи записей');
      const value:unknown=JSON.parse(row.value);
      if(row.namespace==='settings'&&row.id==='storageSchemaVersion')actualVersion=value;
      if(row.namespace==='catalog'&&row.id==='active')validateCatalog(value);
      if(row.namespace==='snapshots')validateSnapshot(value);
      if(row.namespace==='operations'){
        const operation=value as Partial<Operation>|null;
        if(!operation||typeof operation!=='object'||operation.id!==row.id||!Array.isArray(operation.events)||!operation.stage||typeof operation.stage!=='object'||!['running','completed','partial','failed','cancelled','interrupted'].includes(String(operation.status)))throw new Error('В копии повреждён журнал операций');
      }
    }
    if(!Number.isSafeInteger(actualVersion)||(actualVersion as number)<1||(actualVersion as number)>STORAGE_SCHEMA_VERSION||actualVersion!==info.storageSchemaVersion)throw new Error('Фактическая версия хранилища не поддерживается или не совпадает с manifest');
  }finally{inspect?.close();}
  return file;
}
export interface RestoreResult {restored:string;rollbackId:string}
export interface RestoreOptions {afterRestore?:(result:RestoreResult)=>void|Promise<void>}
/** Quiescent callers only. All post-install work is guarded by the same physical rollback. */
export async function restoreBackup(db:LocalDatabase,root:string,id:string,options:RestoreOptions={}):Promise<RestoreResult>{
  const file=await validateBackup(root,id),rollback=await createBackup(db,root,'before_restore');
  const rollbackFile=await safeArtifactPath(await location(root,rollback.id),'database.sqlite');
  let replaced=false;
  try{
    db.replaceFrom(file);replaced=true;
    await migrateStorage(db,root);
    db.transaction(()=>{
      db.clear('sessions');db.clear('connector-schedules');db.clear('operation-owners');
      const at=new Date().toISOString();
      // No 50-row display limit: old running entries must not survive restoration.
      for(const operation of db.list<Operation>('operations'))if(operation.status==='running'){
        const message='Операция прервана восстановлением локальной копии. Повторите действие при необходимости.';
        db.set('operations',operation.id,{...operation,status:'interrupted',finishedAt:at,result:{status:'interrupted',message},events:[...operation.events,{id:operation.events.length+1,at,stage:operation.stage,message}]});
      }
    });
    const result={restored:id,rollbackId:rollback.id};await options.afterRestore?.(result);return result;
  }catch(error){
    if(replaced){try{db.replaceFrom(rollbackFile);}catch(rollbackError){throw new Error(`Не удалось автоматически вернуть исходную базу. Сохранена копия ${rollback.id}; остановите приложение и восстановите её.`,{cause:new AggregateError([error,rollbackError])});}}
    throw new Error(`${(error as Error).message}. Исходное состояние сохранено${replaced?' и автоматически восстановлено':''}.`,{cause:error});
  }
}
export async function migrateStorage(db:LocalDatabase,root:string){
  const current=db.get<number>('settings','storageSchemaVersion')??1;
  if(!Number.isSafeInteger(current)||current<1||current>STORAGE_SCHEMA_VERSION)throw new Error('Локальная база требует более новой версии программы');
  if(current===STORAGE_SCHEMA_VERSION)return;
  const copy=Object.values(db.counts()).some(count=>count>0)?await createBackup(db,root,'before_migration'):null;
  db.transaction(()=>{db.set('settings','storageSchemaVersion',STORAGE_SCHEMA_VERSION);db.set('storage-migrations',String(STORAGE_SCHEMA_VERSION),{from:current,to:STORAGE_SCHEMA_VERSION,at:new Date().toISOString(),backupId:copy?.id??null,description:'Версионирование локального хранилища и поддержка эксплуатационных записей'});});
}
/** Invalid manifests/files never count toward the minimum two recoverable copies. */
export async function pruneBackups(root:string,keep:number){
  if(!Number.isSafeInteger(keep)||keep<2||keep>1000)throw new Error('Сохраните от 2 до 1000 копий');
  const copies=await listBackups(root),valid:BackupInfo[]=[],invalid:{id:string;message:string}[]=[],removed:string[]=[];
  for(const info of copies){try{await validateBackup(root,info.id);valid.push(info);}catch(error){invalid.push({id:info.id,message:(error as Error).message});}}
  for(const info of valid.slice(keep)){
    if(info.reason==='before_restore')continue;
    const folder=await location(root,info.id);
    for(const file of ['database.sqlite','manifest.json']){const full=await safeArtifactPath(folder,file);if((await stat(full)).isFile())await rm(full);}
    await rmdir(folder);removed.push(info.id);
  }
  return{removed,invalid,verifiedRetained:valid.length-removed.length};
}
