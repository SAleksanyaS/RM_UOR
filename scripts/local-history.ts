import {createHash,randomUUID} from 'node:crypto';
import {constants,createReadStream} from 'node:fs';
import {access,chmod,copyFile,lstat,mkdir,open,readFile,readdir,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createServer as createPortProbe} from 'node:net';
import {LocalDatabase} from '../src/server/storage/database';
import {loadSite} from '../src/server/workspace/context';
import {resolveWorkspace,safeArtifactPath} from '../src/server/workspace/paths';
import {createBackup} from '../src/features/system/backup-service';
import {recoverWorkspaceMaintenance} from '../src/features/workspace-maintenance/recovery';

export interface LocalHistoryArchive {
 version:1;id:string;at:string;backupId:string;sha256:string;bytes:number;counts:Record<string,number>;recordsSha256:string;
}
interface DatabaseInspection {counts:Record<string,number>;digest:string;changeIds:string[]}
interface HistoryBaseline {at:string;changeIds:string[]}

/** Legacy import/cleanup cannot bypass workbench staging or erase its indefinite history. */
export async function assertLegacyCliAllowed(projectRoot:string):Promise<void>{
 const root=path.resolve(projectRoot);
 for(const relative of ['.runtime/workbench.sqlite','.runtime/workbench/workbench.sqlite','.runtime/app.db']){
  const candidate=path.join(root,...relative.split('/'));let exists=true,current=root;const parts=relative.split('/');
  for(let index=0;index<parts.length;index++){
   current=path.join(current,parts[index]);
   try{const info=await lstat(current);if(info.isSymbolicLink()||(index<parts.length-1?!info.isDirectory():!info.isFile()||info.nlink!==1))throw new Error('WORKBENCH_MIGRATION_REQUIRED: нельзя безопасно проверить локальное хранилище.');}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){exists=false;break;}throw error;}
  }
  if(!exists)continue;
  let database:DatabaseSync|undefined;
  try{
   database=new DatabaseSync(candidate,{readOnly:true});
   if(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wb_meta'").get()||relative!=='.runtime/app.db')throw new Error('WORKBENCH_MIGRATION_REQUIRED: используйте проверяемый перенос и бессрочную историю нового рабочего места.');
  }catch(error){if(error instanceof Error&&error.message.startsWith('WORKBENCH_MIGRATION_REQUIRED:'))throw error;throw new Error('WORKBENCH_MIGRATION_REQUIRED: схема локального хранилища не подтверждена.');}
  finally{database?.close();}
 }
}

/** A stale heartbeat is not proof that a process has stopped. Do not reveal marker contents. */
async function requireLauncherStopped(projectRoot:string,runtimeRoot:string){
 let bytes:string;
 try{bytes=await readFile(await safeArtifactPath(runtimeRoot,'code-update/launcher.json'),'utf8');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 let marker:unknown;try{marker=JSON.parse(bytes);}catch{throw new Error('Не удалось проверить состояние запуска. Остановите приложение и проверьте локальный маркер запуска.');}
 if(!marker||typeof marker!=='object'||!('root' in marker)||typeof marker.root!=='string'||!('pid' in marker)||!Number.isSafeInteger(marker.pid)||(marker.pid as number)<=1)
  throw new Error('Не удалось проверить состояние запуска. Остановите приложение и проверьте локальный маркер запуска.');
 if(path.relative(projectRoot,path.resolve(marker.root))!=='')throw new Error('Маркер запуска относится к другой рабочей папке. Остановите приложение и проверьте настройки запуска.');
 try{process.kill(marker.pid as number,0);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw new Error('Остановите приложение: не удалось подтвердить завершение локального процесса.');}
 throw new Error('Остановите приложение перед архивированием журнала. Рабочее место ещё запущено.');
}

/** Also covers the supported dev:server entry, which has no launcher marker. */
async function requireStopped(projectRoot:string,runtimeRoot:string,apiPort:number){
 await requireLauncherStopped(projectRoot,runtimeRoot);
 if(!Number.isInteger(apiPort)||apiPort<1||apiPort>65535)throw new Error('Не удалось проверить локальный порт API. Проверьте порт в местных настройках перед архивированием.');
 await new Promise<void>((resolve,reject)=>{
  const probe=createPortProbe(),fail=()=>reject(new Error('Остановите приложение перед архивированием: локальный порт API занят или недоступен для проверки.'));
  probe.once('error',fail);
  try{probe.listen({host:'127.0.0.1',port:apiPort,exclusive:true},()=>probe.close(error=>error?fail():resolve()));}catch{fail();}
 });
}

function inspectDatabase(file:string):DatabaseInspection{
 const database=new DatabaseSync(file,{readOnly:true});
 try{
  if((database.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check!=='ok')throw new Error('База не прошла проверку целостности; журнал сохранён.');
  const columns=database.prepare('PRAGMA table_info(records)').all() as {name:string;type:string;notnull:number;pk:number}[];
  if(columns.length!==3||[['namespace',1],['id',2],['value',0]].some(([name,pk])=>!columns.some(column=>column.name===name&&column.type.toUpperCase()==='TEXT'&&column.notnull===1&&column.pk===pk)))
   throw new Error('Структура базы не поддерживается; журнал сохранён.');
  if(database.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='records'").all().length)throw new Error('В базе есть неподдерживаемые триггеры; журнал сохранён.');
  const digest=createHash('sha256'),counts:Record<string,number>=Object.create(null),changeIds:string[]=[];
  for(const row of database.prepare('SELECT namespace,id,value FROM records ORDER BY namespace,id').iterate()){
   const {namespace,id,value}=row;
   if(typeof namespace!=='string'||!namespace||typeof id!=='string'||!id||typeof value!=='string')throw new Error('В базе нарушены ключи записей; журнал сохранён.');
   JSON.parse(value);counts[namespace]=(counts[namespace]??0)+1;digest.update(JSON.stringify([namespace,id,value]));digest.update('\n');
   if(namespace==='changes'||namespace==='shared-changes')changeIds.push(id);
  }
  return{counts,digest:digest.digest('hex'),changeIds};
 }finally{database.close();}
}

async function shippedChangeIds(projectRoot:string,relative='changes'):Promise<string[]>{
 const directory=await safeArtifactPath(projectRoot,relative);let entries;
 try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}
 const ids:string[]=[];
 for(const entry of entries){
  const child=`${relative}/${entry.name}`;
  if(entry.isSymbolicLink())throw new Error('Каталог общих изменений содержит ссылку; журнал сохранён.');
  if(entry.isDirectory())ids.push(...await shippedChangeIds(projectRoot,child));
  else if(entry.isFile()&&entry.name.endsWith('.json')){
   const value:unknown=JSON.parse(await readFile(await safeArtifactPath(projectRoot,child),'utf8'));
   if(!value||typeof value!=='object'||!('id' in value)||typeof value.id!=='string'||!value.id)throw new Error('Не удалось определить прежние общие изменения; журнал сохранён.');
   ids.push(value.id);
  }
 }
 return ids;
}
async function fileHash(file:string){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function flushFile(file:string){const handle=await open(file,'r+');try{await handle.sync();}finally{await handle.close();}}
async function flushDirectory(directory:string){
 let handle;
 try{handle=await open(directory,'r');await handle.sync();}
 catch(error){if(process.platform!=='win32'||!['EPERM','EISDIR','EINVAL','ENOTSUP'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
 finally{await handle?.close();}
}
async function durableManifest(runtimeRoot:string,id:string,manifest:LocalHistoryArchive){
 const folder=await safeArtifactPath(runtimeRoot,`history-archive/${id}`);await mkdir(folder,{recursive:true,mode:0o700});
 const temporary=await safeArtifactPath(runtimeRoot,`history-archive/${id}/manifest.new`),destination=await safeArtifactPath(runtimeRoot,`history-archive/${id}/manifest.json`);
 const bytes=JSON.stringify(manifest,null,2),handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(bytes,'utf8');await handle.sync();}finally{await handle.close();}
 await rename(temporary,destination);await flushDirectory(folder);await flushDirectory(path.dirname(folder));await flushDirectory(runtimeRoot);
 if(await readFile(destination,'utf8')!==bytes)throw new Error('Не удалось проверить архивный манифест; журнал сохранён.');
}

/** Keep a separate archive outside normal backup retention, without removing the service copy. */
async function retainArchiveDatabase(runtimeRoot:string,manifest:LocalHistoryArchive){
 const folder=await safeArtifactPath(runtimeRoot,`history-archive/${manifest.id}`);await mkdir(folder,{recursive:true,mode:0o700});
 const sourceFolder=await safeArtifactPath(runtimeRoot,`backups/${manifest.backupId}`);
 for(const [sourceName,archiveName] of [['database.sqlite','database.sqlite'],['manifest.json','backup-manifest.json']]){
  const source=await safeArtifactPath(sourceFolder,sourceName),destination=await safeArtifactPath(folder,archiveName);
  await copyFile(source,destination,constants.COPYFILE_EXCL);await chmod(destination,0o600);await flushFile(destination);
 }
 const archiveDatabase=await safeArtifactPath(folder,'database.sqlite');
 if((await stat(archiveDatabase)).size!==manifest.bytes||await fileHash(archiveDatabase)!==manifest.sha256||inspectDatabase(archiveDatabase).digest!==manifest.recordsSha256)
  throw new Error('Независимая архивная копия не прошла проверку; журнал сохранён.');
 const backupManifest=JSON.parse(await readFile(await safeArtifactPath(folder,'backup-manifest.json'),'utf8')) as {id?:string;sha256?:string;bytes?:number};
 if(backupManifest.id!==manifest.backupId||backupManifest.sha256!==manifest.sha256||backupManifest.bytes!==manifest.bytes)throw new Error('Архивный паспорт копии не совпадает с базой; журнал сохранён.');
 await flushDirectory(folder);
}

/** Offline journal maintenance only. The full verified database remains in the private backup. */
export async function archiveLocalHistory({projectRoot}:{projectRoot:string}):Promise<LocalHistoryArchive>{
 await assertLegacyCliAllowed(projectRoot);
 const requestedRoot=path.resolve(projectRoot),site=await loadSite(requestedRoot),workspace=await resolveWorkspace({projectRoot:requestedRoot,allowedRoots:site.allowedWorkspaceRoots});
 await requireStopped(workspace.projectRoot,workspace.runtimeRoot,site.port);const databasePath=await safeArtifactPath(workspace.runtimeRoot,'app.db');await access(databasePath);
 const db=new LocalDatabase(databasePath);
 try{
  await recoverWorkspaceMaintenance(workspace.runtimeRoot,db);
  const before=inspectDatabase(databasePath),prior=db.get<HistoryBaseline>('settings','historyArchiveBaseline');
  if(prior&&(!Array.isArray(prior.changeIds)||prior.changeIds.some(id=>typeof id!=='string'||!id)))throw new Error('Повреждена отметка архивирования журнала; прежние данные сохранены.');
  const changeIds=[...new Set([...(prior?.changeIds??[]),...before.changeIds,...await shippedChangeIds(workspace.projectRoot)])].sort();
  const backup=await createBackup(db,workspace.runtimeRoot,'manual'),backupFolder=await safeArtifactPath(workspace.runtimeRoot,`backups/${backup.id}`),backupFile=await safeArtifactPath(backupFolder,'database.sqlite');
  await flushFile(backupFile);await flushFile(await safeArtifactPath(backupFolder,'manifest.json'));await flushDirectory(backupFolder);await flushDirectory(path.dirname(backupFolder));await flushDirectory(workspace.runtimeRoot);
  const checked=inspectDatabase(backupFile);
  if((await stat(backupFile)).size!==backup.bytes||await fileHash(backupFile)!==backup.sha256||checked.digest!==before.digest||JSON.stringify(checked.counts)!==JSON.stringify(before.counts))throw new Error('Резервная копия не совпадает с исходной базой; журнал сохранён.');
  const manifest:LocalHistoryArchive={version:1,id:randomUUID(),at:new Date().toISOString(),backupId:backup.id,sha256:backup.sha256,bytes:backup.bytes,counts:before.counts,recordsSha256:before.digest};
  await retainArchiveDatabase(workspace.runtimeRoot,manifest);await durableManifest(workspace.runtimeRoot,manifest.id,manifest);await requireStopped(workspace.projectRoot,workspace.runtimeRoot,site.port);
  db.transaction(()=>{
   if(inspectDatabase(databasePath).digest!==before.digest)throw new Error('Во время архивирования данные изменились; журнал сохранён.');
   db.clear('operations');db.clear('changes');db.clear('shared-changes');db.remove('settings','updates');
   db.set<HistoryBaseline>('settings','historyArchiveBaseline',{at:manifest.at,changeIds});
  });
  return manifest;
 }finally{db.close();}
}
