import {afterEach,expect,it} from 'vitest';
import {copyFile,mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LocalDatabase} from '../../server/storage/database';
import {createBackup} from './backup-service';
import {beginMaintenanceJournal} from '../workspace-maintenance/recovery';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function unusedPort(){const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});const address=server.address();if(!address||typeof address==='string')throw new Error('Нет локального порта теста');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;}
async function fixture(){
 const projectRoot=await mkdtemp(path.join(tmpdir(),'uor-history-archive-'));roots.push(projectRoot);
 const runtime=path.join(projectRoot,'.runtime');await mkdir(path.join(runtime,'local-config'),{recursive:true});await mkdir(path.join(projectRoot,'config'));
 await writeFile(path.join(projectRoot,'config/site.local.json'),JSON.stringify({allowedWorkspaceRoots:[projectRoot],port:await unusedPort()}));
 const databasePath=path.join(runtime,'app.db'),db=new LocalDatabase(databasePath);
 db.set('operations','completed',{id:'completed',status:'completed',events:[],stage:{key:'done',label:'Готово'}});
 db.set('operations','interrupted',{id:'interrupted',status:'running',events:[],stage:{key:'start',label:'Начало'}});
 db.set('changes','old-local',{id:'old-local',text:'Прежняя локальная правка'});db.set('changes','old-shared',{id:'old-shared',text:'Прежний общий выпуск'});
 db.set('shared-changes','old-shared',true);db.set('shared-changes','orphaned-shared',true);
 db.set('settings','updates',{status:'available',changes:[{id:'old-shared'}]});db.set('settings','storageSchemaVersion',2);db.set('settings','installationId','synthetic-installation');db.set('settings','preferences',{compact:true});
 for(const namespace of ['catalog','snapshots','drafts','attestations','reports','report-templates','evidence','sessions','operation-owners'])db.set(namespace,'preserved',{id:'preserved',namespace,value:'Сохранённое содержимое'});
 const counts=db.counts();db.close();
 await writeFile(path.join(runtime,'local-config/curators.json'),'[{"id":"synthetic-curator","hash":"private-hash"}]');
 return{projectRoot,runtime,databasePath,counts};
}
async function archive(projectRoot:string){const {archiveLocalHistory}=await import('../../../scripts/local-history');return archiveLocalHistory({projectRoot});}
async function directories(root:string){try{return await readdir(root);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}}

it('archives recoverable exact history before clearing journals and keeps every other record and account file',async()=>{
 const f=await fixture();await mkdir(path.join(f.projectRoot,'changes/nested'),{recursive:true});await writeFile(path.join(f.projectRoot,'changes/nested/shipped.json'),JSON.stringify({id:'old-shipped'}));
 // A history-only tool must never initialize the catalog or load imports.
 await mkdir(path.join(f.runtime,'imports'));await writeFile(path.join(f.runtime,'imports/catalog.json'),'not a catalog');
 const result=await archive(f.projectRoot),manifest=JSON.parse(await readFile(path.join(f.runtime,'history-archive',result.id,'manifest.json'),'utf8'));
 expect(manifest.counts).toEqual(f.counts);expect(manifest.backupId).toBe(result.backupId);expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);expect(manifest.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
 const backup=path.join(f.runtime,'backups',result.backupId,'database.sqlite');expect(createHash('sha256').update(await readFile(backup)).digest('hex')).toBe(manifest.sha256);
 const archivedDatabase=path.join(f.runtime,'history-archive',result.id,'database.sqlite');expect(createHash('sha256').update(await readFile(archivedDatabase)).digest('hex')).toBe(manifest.sha256);
 expect(JSON.parse(await readFile(path.join(f.runtime,'history-archive',result.id,'backup-manifest.json'),'utf8')).id).toBe(result.backupId);
 const restoredPath=path.join(f.runtime,'restored-probe.sqlite');await copyFile(archivedDatabase,restoredPath);const restored=new LocalDatabase(restoredPath);
 try{expect(restored.counts()).toEqual(f.counts);expect(restored.get('changes','old-local')).toEqual({id:'old-local',text:'Прежняя локальная правка'});expect(restored.get('settings','updates')).toEqual({status:'available',changes:[{id:'old-shared'}]});}finally{restored.close();}
 const current=new LocalDatabase(f.databasePath);try{
  for(const namespace of ['operations','changes','shared-changes'])expect(current.list(namespace)).toEqual([]);
  expect(current.get('settings','updates')).toBeNull();expect(current.get('settings','preferences')).toEqual({compact:true});expect(current.get('settings','installationId')).toBe('synthetic-installation');expect(current.get('settings','storageSchemaVersion')).toBe(2);
  for(const namespace of ['catalog','snapshots','drafts','attestations','reports','report-templates','evidence','sessions','operation-owners'])expect(current.get(namespace,'preserved')).toEqual({id:'preserved',namespace,value:'Сохранённое содержимое'});
  expect(current.get<{changeIds:string[]}>('settings','historyArchiveBaseline')?.changeIds.sort()).toEqual(['old-local','old-shared','old-shipped','orphaned-shared']);
 }finally{current.close();}
 expect(await readFile(path.join(f.runtime,'local-config/curators.json'),'utf8')).toBe('[{"id":"synthetic-curator","hash":"private-hash"}]');
});

it('refuses a live launcher even with an old heartbeat and never prints its private token',async()=>{
 const f=await fixture();await mkdir(path.join(f.runtime,'code-update'));await writeFile(path.join(f.runtime,'code-update/launcher.json'),JSON.stringify({pid:process.pid,root:f.projectRoot,heartbeat:0,token:'never-print-this-secret'}));
 const error=await archive(f.projectRoot).then(()=>null,error=>error as Error);expect(error).toBeInstanceOf(Error);expect(error?.message).toMatch(/Остановите/);expect(error?.message).not.toContain('never-print-this-secret');
 const current=new LocalDatabase(f.databasePath);try{expect(current.counts()).toEqual(f.counts);}finally{current.close();}expect(await directories(path.join(f.runtime,'history-archive'))).toEqual([]);
});

it('refuses a launcher marker belonging to another workspace without touching history',async()=>{
 const f=await fixture();await mkdir(path.join(f.runtime,'code-update'));await writeFile(path.join(f.runtime,'code-update/launcher.json'),JSON.stringify({pid:process.pid,root:path.join(f.projectRoot,'other'),heartbeat:Date.now(),token:'another-private-token'}));
 await expect(archive(f.projectRoot)).rejects.toThrow(/другой рабочей папке/);const current=new LocalDatabase(f.databasePath);try{expect(current.counts()).toEqual(f.counts);}finally{current.close();}
 expect(await directories(path.join(f.runtime,'backups'))).toEqual([]);
});

it('refuses a live idle HTTP server at the configured API port even when there is no launcher marker',async()=>{
 const f=await fixture(),server=createServer((_request,response)=>response.end('running'));
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('Нет локального порта теста');
  await writeFile(path.join(f.projectRoot,'config/site.local.json'),JSON.stringify({allowedWorkspaceRoots:[f.projectRoot],port:address.port}));
  await expect(archive(f.projectRoot)).rejects.toThrow(/Остановите.*порт|порт.*Остановите/);
  const current=new LocalDatabase(f.databasePath);try{expect(current.counts()).toEqual(f.counts);}finally{current.close();}
  expect(await directories(path.join(f.runtime,'history-archive'))).toEqual([]);expect(await directories(path.join(f.runtime,'backups'))).toEqual([]);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it('refuses an invalid API port because stopped state cannot be established',async()=>{
 const f=await fixture();await writeFile(path.join(f.projectRoot,'config/site.local.json'),JSON.stringify({allowedWorkspaceRoots:[f.projectRoot],port:-1}));
 await expect(archive(f.projectRoot)).rejects.toThrow(/порт/);const current=new LocalDatabase(f.databasePath);try{expect(current.counts()).toEqual(f.counts);}finally{current.close();}
 expect(await directories(path.join(f.runtime,'history-archive'))).toEqual([]);
});

it('keeps history and settings untouched when a real backup destination cannot be created',async()=>{
 const f=await fixture();await writeFile(path.join(f.runtime,'backups'),'occupied by an existing file');
 const failure=await archive(f.projectRoot).then(()=>null,error=>error as NodeJS.ErrnoException);expect(failure).toBeInstanceOf(Error);expect(['ENOTDIR','EEXIST','ENOENT']).toContain(failure?.code);
 const current=new LocalDatabase(f.databasePath);try{expect(current.counts()).toEqual(f.counts);expect(current.get('settings','historyArchiveBaseline')).toBeNull();}finally{current.close();}
 expect(await readFile(path.join(f.runtime,'backups'),'utf8')).toBe('occupied by an existing file');expect(await directories(path.join(f.runtime,'history-archive'))).toEqual([]);
});

it('requires the durable archive manifest before clearing and retains an already created backup on failure',async()=>{
 const f=await fixture();await writeFile(path.join(f.runtime,'history-archive'),'occupied by an existing file');
 await expect(archive(f.projectRoot)).rejects.toThrow();const current=new LocalDatabase(f.databasePath);try{expect(current.counts()).toEqual(f.counts);}finally{current.close();}
 const backupIds=await directories(path.join(f.runtime,'backups'));expect(backupIds).toHaveLength(1);expect(await readFile(path.join(f.runtime,'backups',backupIds[0],'database.sqlite'))).not.toHaveLength(0);
});

it('finishes pending workspace recovery before taking the archive snapshot',async()=>{
 const f=await fixture(),db=new LocalDatabase(f.databasePath);let recoveryId:string;
 try{const backup=await createBackup(db,f.runtime,'before_restore');const journal=await beginMaintenanceJournal(f.runtime,'bundle_restore',`backups/${backup.id}/database.sqlite`);recoveryId=journal.id;db.set('snapshots','preserved',{id:'preserved',namespace:'snapshots',value:'Незавершённая замена'});db.set('changes','after-crash',{id:'after-crash'});}finally{db.close();}
 const result=await archive(f.projectRoot),restored=new LocalDatabase(path.join(f.runtime,'backups',result.backupId,'database.sqlite'));
 try{expect(restored.counts()).toEqual(f.counts);expect(restored.get('snapshots','preserved')).toEqual({id:'preserved',namespace:'snapshots',value:'Сохранённое содержимое'});expect(restored.get('changes','after-crash')).toBeNull();}finally{restored.close();}
 await expect(readFile(path.join(f.runtime,'workspace-maintenance-journals',recoveryId!,'journal.json'))).rejects.toMatchObject({code:'ENOENT'});
});

it('refuses an unapproved workspace before changing its database',async()=>{
 const f=await fixture(),other=await mkdtemp(path.join(tmpdir(),'uor-other-approved-'));roots.push(other);await writeFile(path.join(f.projectRoot,'config/site.local.json'),JSON.stringify({allowedWorkspaceRoots:[other]}));
 await expect(archive(f.projectRoot)).rejects.toThrow(/разрешён/);const current=new LocalDatabase(f.databasePath);try{expect(current.counts()).toEqual(f.counts);}finally{current.close();}
});

it('runs the offline CLI in the selected workspace and reports its recoverable private archive',async()=>{
 const f=await fixture(),script=fileURLToPath(new URL('../../../scripts/archive-local-history.ts',import.meta.url)),loader=new URL('../../../node_modules/tsx/dist/loader.mjs',import.meta.url).href;
 const output=await promisify(execFile)(process.execPath,['--import',loader,script],{cwd:f.projectRoot,windowsHide:true,env:{...process.env,NODE_NO_WARNINGS:'1'}});
 expect(output.stdout).toContain('Журнал архивирован');expect(output.stdout).toMatch(/\.runtime\/history-archive\/[a-f0-9-]{36}\/database\.sqlite/);expect(output.stdout).not.toContain('private-hash');
 const archives=await directories(path.join(f.runtime,'history-archive'));expect(archives).toHaveLength(1);const manifest=JSON.parse(await readFile(path.join(f.runtime,'history-archive',archives[0],'manifest.json'),'utf8'));expect(manifest.counts).toEqual(f.counts);
 const current=new LocalDatabase(f.databasePath);try{expect(current.list('operations')).toEqual([]);expect(current.get('drafts','preserved')).toEqual({id:'preserved',namespace:'drafts',value:'Сохранённое содержимое'});}finally{current.close();}
});
