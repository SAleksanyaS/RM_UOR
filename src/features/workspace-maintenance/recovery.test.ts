import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createContext,type ApplicationContext} from '../../server/workspace/context';
import type {CatalogSnapshot} from '../../domain/contracts';
import {createBackup} from '../system/backup-service';
import {beginMaintenanceJournal,journalMove,journalReplace,commitMaintenanceJournal} from './recovery';
import {sha256} from './zip';
const roots:string[]=[],contexts:ApplicationContext[]=[];
afterEach(async()=>{for(const c of contexts.splice(0))c.db.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const catalog:CatalogSnapshot={schemaVersion:1,id:'recovery-demo',name:'До сбоя',classification:'demo',importedAt:'2026-10-25T00:00:00Z',goals:[],leaders:[],assignments:[],sources:[],comments:[],entities:[]};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'uor-maintenance-crash-'));roots.push(root);await mkdir(join(root,'catalog'));await writeFile(join(root,'catalog/demo.json'),JSON.stringify(catalog));const context=await createContext({projectRoot:root,startupCheck:false});contexts.push(context);return{context,root};}
async function reopen(c:ApplicationContext){const projectRoot=c.paths.projectRoot;c.db.close();contexts.splice(contexts.indexOf(c),1);const next=await createContext({projectRoot,startupCheck:false});contexts.push(next);return next;}
it('startup reverses an interrupted quarantine before metadata commit and keeps a committed quarantine',async()=>{
 const {context}=await fixture(),runtime=context.paths.runtimeRoot,source='source-artifacts/orphan.csv',destination=`workspace-quarantine/${randomUUID()}/${randomUUID()}`;
 await writeFile(join(runtime,source),'recoverable');const journal=await beginMaintenanceJournal(runtime,'quarantine');await journalMove(runtime,journal,source,destination);await mkdir(join(runtime,destination,'..'),{recursive:true});await rename(join(runtime,source),join(runtime,destination));
 let next=await reopen(context);expect(await readFile(join(runtime,source),'utf8')).toBe('recoverable');await expect(readFile(join(runtime,destination))).rejects.toMatchObject({code:'ENOENT'});
 const committed=await beginMaintenanceJournal(runtime,'quarantine');await journalMove(runtime,committed,source,destination);await rename(join(runtime,source),join(runtime,destination));next.db.transaction(()=>{next.db.set('workspace-quarantine','committed',{id:'committed',storedPath:destination});commitMaintenanceJournal(next.db,committed);});
 next=await reopen(next);expect(await readFile(join(runtime,destination),'utf8')).toBe('recoverable');expect(next.db.get('workspace-quarantine','committed')).toBeTruthy();await expect(readFile(join(runtime,source))).rejects.toMatchObject({code:'ENOENT'});
});
it('startup rolls database and startup imports back together if the process stopped after database installation',async()=>{
 const {context}=await fixture(),runtime=context.paths.runtimeRoot,old=Buffer.from(JSON.stringify(catalog)),changed={...catalog,name:'Незавершённый перенос'};
 await writeFile(join(runtime,'imports/catalog.json'),old);context.db.set('settings','importHash',sha256(old));context.db.set('snapshots','preserved',{id:'preserved',original:true});
 const backup=await createBackup(context.db,runtime,'before_restore'),journal=await beginMaintenanceJournal(runtime,'bundle_restore',`backups/${backup.id}/database.sqlite`),bytes=Buffer.from(JSON.stringify(changed));
 await journalReplace(runtime,journal,'imports/catalog.json',bytes);await writeFile(join(runtime,'imports/catalog.json'),bytes);
 context.db.transaction(()=>{context.db.set('catalog','active',changed);context.db.set('settings','importHash',sha256(bytes));context.db.clear('snapshots');});
 const next=await reopen(context);expect((await next.catalogs.read()).name).toBe('До сбоя');expect(await readFile(join(runtime,'imports/catalog.json'),'utf8')).toBe(old.toString());expect(next.db.get('snapshots','preserved')).toEqual({id:'preserved',original:true});
});
it('startup preserves a completed transfer and refuses to overwrite a newly occupied recovery path',async()=>{
 const {context}=await fixture(),runtime=context.paths.runtimeRoot,changed={...catalog,name:'Завершённый перенос'},bytes=Buffer.from(JSON.stringify(changed)),backup=await createBackup(context.db,runtime,'before_restore'),journal=await beginMaintenanceJournal(runtime,'bundle_restore',`backups/${backup.id}/database.sqlite`);
 await journalReplace(runtime,journal,'imports/catalog.json',bytes);await writeFile(join(runtime,'imports/catalog.json'),bytes);context.db.transaction(()=>{context.db.set('catalog','active',changed);context.db.set('settings','importHash',sha256(bytes));commitMaintenanceJournal(context.db,journal);});
 const next=await reopen(context);expect((await next.catalogs.read()).name).toBe('Завершённый перенос');
 const source='source-artifacts/orphan.csv',destination=`workspace-quarantine/${randomUUID()}/${randomUUID()}`;await writeFile(join(runtime,source),'first');const pending=await beginMaintenanceJournal(runtime,'quarantine');await journalMove(runtime,pending,source,destination);await mkdir(join(runtime,destination,'..'),{recursive:true});await rename(join(runtime,source),join(runtime,destination));await writeFile(join(runtime,source),'newly occupied');next.db.close();contexts.splice(contexts.indexOf(next),1);
 await expect(createContext({projectRoot:next.paths.projectRoot,startupCheck:false})).rejects.toThrow(/Не завершён безопасный откат/);expect(await readFile(join(runtime,source),'utf8')).toBe('newly occupied');expect(await readFile(join(runtime,destination),'utf8')).toBe('first');
});
