import path from 'node:path';
import { fixture } from './test-fixture';
import { MaintenanceService } from './maintenance-service';
import { registerMaintenanceCommands } from './register-commands';
import { registerMaintenanceQueries } from './maintenance-query';
import { createWorkbenchApp } from '../../../server/workbench/app';
import { createCommandRegistry } from '../../../server/workbench/command-registry';
import { createJobStore } from '../../../server/workbench/jobs';
import { QueryRegistry } from '../../../server/workbench/query-registry';
import { createLocalSessionStore } from '../../../server/workbench/session';
import { createPreferencesService } from '../../system/workbench-preferences';
import { registerPreferencesQueries } from '../../system/workbench-preferences-query';
import { createWorkbenchReadIndex } from '../../catalog/workbench-read-index';
import { createDraftStore } from '../../catalog/workbench-draft-store';
import { createDraftService } from '../../catalog/workbench-drafts';
import { createDirectoryStore } from '../../catalog/workbench-directory-store';
import { createSourceStore } from '../../connectors/workbench-source-store';
import { createEvidenceService } from '../../evidence/workbench-evidence';
import { composeGoalSetupPreview } from '../../../server/workbench/testing/goal-setup-scenarios';
import { WorkbenchClient } from '../../../app/workbench/api-client';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import type { AccessPolicyService } from '../../identity/workbench-access-policy';

/** Native SQLite + actual service/registry/HTTP; only the Git baseline is synthetic. */
export async function createMaintenanceUiFixture(origin='http://127.0.0.1:5173') {
 const f=await fixture('Исходные личные данные',{stable:true}),repository=f.deps.repository,clock=f.deps.clock;
 let jobs=createJobStore({repository,clock});
 const accessPolicy:AccessPolicyService={async resolveOwnAccess(){return f.context.ownAccess;},async assertCommandAllowed(){if(f.frozen())throw new WorkbenchHttpError(409,'RECOVERY_REQUIRED','Запись заблокирована до восстановления');return f.context.ownAccess;},async assertFreshPublishAllowed(){throw Error('No external writes in synthetic fixture');}};
 let commands=createCommandRegistry({repository,jobs,accessPolicy});
 let maintenance=new MaintenanceService({archive:f.deps,jobs,jobSink:jobs});registerMaintenanceCommands(commands,maintenance);
 const preferences=createPreferencesService({repository,installationId:f.context.installationId,clock});
 const store=createDraftStore({repository,artifactDirectory:path.join(f.root,'drafts')}),drafts=createDraftService({repository,store,clock,files:f.deps.files,directory:createDirectoryStore({repository}),sourceState:createSourceStore({repository}),evidence:createEvidenceService({repository,store,clock,files:f.deps.files})});
 composeGoalSetupPreview({repository,clock,drafts,accessPolicy,jobs,commands,root:f.root});
 const queries=new QueryRegistry();registerPreferencesQueries(queries,preferences);registerMaintenanceQueries(queries,maintenance,createWorkbenchReadIndex(repository));
 const sessions=createLocalSessionStore({clock});
 let app=await createWorkbenchApp({repository,clock,hostname:()=>f.context.actor.hostname,installationId:f.context.installationId,accessPolicy,commands,jobs,queries,modules:[],sessions,allowedOrigins:[origin],files:f.deps.files,maintenance});
 const requests:Array<{url:string;body:Record<string,unknown>|null}>=[];let cookie='';
 const fetcher:typeof fetch=async(input,init)=>{
  const url=new URL(String(input),origin),headers=new Headers(init?.headers);headers.set('origin',origin);if(cookie)headers.set('cookie',cookie);
  let payload:string|Buffer|undefined;
  if(init?.body instanceof FormData){const encoded=new Request(url,{method:'POST',body:init.body});headers.set('content-type',encoded.headers.get('content-type')!);payload=Buffer.from(await encoded.arrayBuffer());requests.push({url:url.pathname,body:{purpose:init.body.get('purpose')}});}
  else {payload=typeof init?.body==='string'?init.body:undefined;requests.push({url:url.pathname,body:payload?JSON.parse(payload):null});}
  const response=await app.inject({method:(init?.method??'GET') as 'GET'|'POST',url:url.pathname,headers:Object.fromEntries(headers.entries()),payload});
  if(response.cookies.length)cookie=response.cookies.map(v=>`${v.name}=${v.value}`).join('; ');
  return new Response(new Uint8Array(response.rawPayload),{status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([key,value])=>key!=='set-cookie'&&value!==undefined).map(([key,value])=>[key,String(value)]))});
 };
 return {...f,get app(){return app;},get jobs(){return jobs;},get commands(){return commands;},get maintenance(){return maintenance;},preferences,requests,fetch:fetcher,client:new WorkbenchClient({fetch:fetcher}),
 async restart(){await commands.idle();await app.close();f.reopen();jobs=createJobStore({repository,clock});commands=createCommandRegistry({repository,jobs,accessPolicy});maintenance=new MaintenanceService({archive:f.deps,jobs,jobSink:jobs});registerMaintenanceCommands(commands,maintenance);composeGoalSetupPreview({repository,clock,drafts,accessPolicy,jobs,commands,root:f.root});const newQueries=new QueryRegistry();registerPreferencesQueries(newQueries,preferences);registerMaintenanceQueries(newQueries,maintenance,createWorkbenchReadIndex(repository));app=await createWorkbenchApp({repository,clock,hostname:()=>f.context.actor.hostname,installationId:f.context.installationId,accessPolicy,commands,jobs,queries:newQueries,modules:[],sessions:createLocalSessionStore({clock}),allowedOrigins:[origin],files:f.deps.files,maintenance});cookie='';},
 async close(){await commands.idle();await app.close();await f.dispose();}};
}
