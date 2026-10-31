import path from 'node:path';
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { afterEach,expect,it,vi } from 'vitest';
import Fastify from 'fastify';
import type { ApplicationContext } from '../../../server/workspace/context';
import type { Session } from '../../../domain/contracts';
import { exportWorkspaceBundle,previewWorkspaceRestore,restoreWorkspaceBundle } from '../bundle-service';
import { previewStorageCleanup,quarantineStorageItems,purgeQuarantinedItems,restoreQuarantinedItem,saveStoragePolicy } from '../storage-service';
import { registerWorkspaceMaintenanceRoutes } from '../routes';
import { beginMaintenanceJournal,journalReplace,recoverWorkspaceMaintenance,rollbackMaintenanceJournal } from '../recovery';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { makeEntityGraph } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{vi.useRealTimers();for(const c of cleanup.splice(0).reverse())await c();});
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'uor-legacy-maintenance-guard-'));cleanup.push(async()=>{if(!path.basename(root).startsWith('uor-legacy-maintenance-guard-'))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});});await mkdir(path.join(root,'workbench'));await writeFile(path.join(root,'workbench','workbench.sqlite'),'synthetic marker');const read=vi.fn(()=>null);const context={paths:{runtimeRoot:root},maintenance:true,activeRequests:0,operations:{list:()=>[]},db:{get:read,list:()=>[]},async waitBackground(){}} as unknown as ApplicationContext;return {root,context,read};}
it('refuses legacy bundle and destructive storage operations before touching the new workspace',async()=>{
  const f=await fixture(),session={role:'curator',curatorId:'synthetic-owner'} as Session;
  const actions=[()=>exportWorkspaceBundle(f.context,session,{includeOriginals:true,includeReports:true}),()=>previewWorkspaceRestore(f.context,session,Buffer.from('invalid')),()=>restoreWorkspaceBundle(f.context,session,{previewId:'synthetic',rebindSelf:false,confirmation:'ВОССТАНОВИТЬ РАБОЧЕЕ МЕСТО'}),()=>previewStorageCleanup(f.context,session),()=>quarantineStorageItems(f.context,session,{previewId:'synthetic',itemIds:[]}),()=>purgeQuarantinedItems(f.context,session,[],'УДАЛИТЬ ИЗ КАРАНТИНА')];
  for(const action of actions)await expect(action()).rejects.toMatchObject({statusCode:410});expect(f.read).not.toHaveBeenCalled();
});
it('does not run the old retention timer against a workbench workspace',async()=>{
  const f=await fixture(),app=Fastify();f.context.maintenance=false;cleanup.push(()=>app.close());
  const filename=path.join(f.root,'workbench','workbench.sqlite');await rm(filename);
  const repository=createWorkbenchRepository({filename,artifactRoot:path.join(f.root,'workbench','artifacts')});cleanup.push(async()=>repository.close());
  const graph=makeEntityGraph();seedGraph(repository,graph);const metric=graph.input.metrics[0];
  repository.transaction(()=>{for(let revision=2;revision<=451;revision++)repository.append('metric_definition',{...metric,revision,name:`Historical revision ${revision}`},revision-1);});
  const previous=repository.exportWorkspaceCore(),previousRevision=repository.getStateRevision();
  vi.useFakeTimers();registerWorkspaceMaintenanceRoutes(app,f.context);
  await vi.advanceTimersByTimeAsync(3*30*60*1000);expect(f.read).not.toHaveBeenCalled();
  expect(repository.getStateRevision()).toBe(previousRevision);expect(repository.exportWorkspaceCore()).toEqual(previous);
  for(let revision=1;revision<=451;revision++)expect(repository.readVersion({entityType:'metric_definition',id:metric.id,revision})).toMatchObject({revision});
});
it('refuses policy writes and quarantine restore before reading new workspace records',async()=>{
  const f=await fixture(),session={role:'curator',curatorId:'synthetic-owner'} as Session;
  expect(()=>saveStoragePolicy(f.context,session,{})).toThrow(expect.objectContaining({statusCode:410}));
  await expect(restoreQuarantinedItem(f.context,session,'synthetic')).rejects.toMatchObject({statusCode:410});
  expect(f.read).not.toHaveBeenCalled();
});
it.each(['active-pointer','workbench-in-app-db','unknown-app-db','unknown-workbench-layout'])('fails closed for %s without changing its files',async layout=>{
  const f=await fixture();await rm(path.join(f.root,'workbench'),{recursive:true});
  let marker:string;
  if(layout==='active-pointer'){await mkdir(path.join(f.root,'workbench'));marker=path.join(f.root,'workbench','active.json');await writeFile(marker,'{"active":"do-not-follow-arbitrary-path"}');}
  else if(layout==='unknown-workbench-layout'){await mkdir(path.join(f.root,'workbench'));marker=path.join(f.root,'workbench','unrecognized');await writeFile(marker,'retained');}
  else {marker=path.join(f.root,'app.db');const db=new DatabaseSync(marker);try{db.exec(layout==='workbench-in-app-db'?'CREATE TABLE wb_meta(key TEXT PRIMARY KEY,value TEXT)':'CREATE TABLE unrecognized(value TEXT)');}finally{db.close();}}
  const before=await readFile(marker);
  await expect(exportWorkspaceBundle(f.context,{role:'curator',curatorId:'synthetic-owner'} as Session,{includeOriginals:true,includeReports:true})).rejects.toMatchObject({statusCode:410});
  expect(await readFile(marker)).toEqual(before);expect(f.read).not.toHaveBeenCalled();
});
it('returns HTTP 410 on legacy maintenance routes before creating an operation or reading the old database',async()=>{
  const f=await fixture(),app=Fastify();cleanup.push(()=>app.close());registerWorkspaceMaintenanceRoutes(app,f.context);
  for(const input of [{method:'GET',url:'/api/workspace-maintenance'},{method:'POST',url:'/api/workspace-maintenance/export'},{method:'POST',url:'/api/workspace-maintenance/cleanup/preview'},{method:'POST',url:'/api/workspace-maintenance/policy',payload:{}}] as const){const response=await app.inject(input);expect(response.statusCode).toBe(410);}
  expect(f.read).not.toHaveBeenCalled();expect(await readdir(f.root)).toEqual(['workbench']);
});
it('preserves an unfinished legacy journal and all recovery bytes when workbench storage is present',async()=>{
  const f=await fixture();await rm(path.join(f.root,'workbench'),{recursive:true});
  await mkdir(path.join(f.root,'imports'));await writeFile(path.join(f.root,'imports','catalog.json'),'previous');
  const journal=await beginMaintenanceJournal(f.root,'bundle_restore');await journalReplace(f.root,journal,'imports/catalog.json',Buffer.from('next'));
  await writeFile(path.join(f.root,'imports','catalog.json'),'next');await mkdir(path.join(f.root,'workbench'));await writeFile(path.join(f.root,'workbench','workbench.sqlite'),'synthetic marker');
  const journalPath=path.join(f.root,'workspace-maintenance-journals',journal.id,'journal.json'),before=await readFile(journalPath),previous=await readFile(path.join(f.root,journal.actions[0].kind==='replace'?journal.actions[0].previousPath!:'unreachable'));
  await expect(recoverWorkspaceMaintenance(f.root,f.context.db)).rejects.toMatchObject({code:'RECOVERY_REQUIRED'});
  await expect(rollbackMaintenanceJournal(f.root,f.context.db,journal)).rejects.toMatchObject({code:'RECOVERY_REQUIRED'});
  expect(await readFile(journalPath)).toEqual(before);expect(await readFile(path.join(f.root,'imports','catalog.json'),'utf8')).toBe('next');
  expect(await readFile(path.join(f.root,journal.actions[0].kind==='replace'?journal.actions[0].previousPath!:'unreachable'))).toEqual(previous);expect(f.read).not.toHaveBeenCalled();
});
