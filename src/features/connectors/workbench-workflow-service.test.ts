import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { createJobStore } from '../../server/workbench/jobs';
import { createCommandRegistry } from '../../server/workbench/command-registry';
import { QueryRegistry } from '../../server/workbench/query-registry';
import { createWorkbenchApp } from '../../server/workbench/app';
import { createLocalSessionStore } from '../../server/workbench/session';
import { createFileStore, defaultFileLimits } from '../../server/workbench/files';
import type { OwnAccessProfile, AccessPolicyService } from '../identity/workbench-access-policy';
import { createBrowserProfileService } from './workbench-browser-profile';
import type { BrowserWorkflowRuntimePort } from './workbench-browser-runtime';
import { createOkoWorkflowService } from './workbench-workflow-service';
import { createOkoWorkflowModule } from './workbench-workflow-module';
import type { OkoWorkflowView, OkoDictionaryMapping } from './workbench-workflow-contracts';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(){
 const root=mkdtempSync(path.join(tmpdir(),'uor-oko-workflow-')),installationId=randomUUID(),personId=randomUUID(),clock={now:()=> '2026-10-28T10:00:00Z'};
 const repository=createWorkbenchRepository({filename:path.join(root,'own.sqlite'),artifactRoot:root}),jobs=createJobStore({repository,clock});
 let own:OwnAccessProfile={role:'curator',personId,displayName:'Synthetic',policyState:'verified',checkedAt:clock.now()};
 const accessPolicy:AccessPolicyService={resolveOwnAccess:async()=>own,assertCommandAllowed:async()=>own,assertFreshPublishAllowed:async()=>{throw Error('No publication');}};
 let replayBytes=Buffer.from('Key;Amount;Date\r\nP1;12,5;28.10.2026\r\nP2;7;28.10.2026'), failReplay=false, duringReplay:()=>Promise<void>=async()=>{};
 const closedOwners:string[]=[];
 const handle=randomUUID(),steps=[{action:'download' as const,locator:{kind:'css' as const,selector:'#export'}}];
 const runtime:BrowserWorkflowRuntimePort={openLogin:async()=>({handleId:randomUUID(),state:'open',mode:'login'}),startRecording:async()=>({handleId:handle,state:'open',mode:'record'}),finish:async()=>({recordingId:handle,startUrl:'https://report.example/report',authenticatedSelector:'#report',steps,parameterNames:[],screenshotHandles:[],hasDownload:true}),readRecordingStatus:async()=>({state:'completed',problem:null}),readRecordingDownload:async()=>({bytes:replayBytes,name:'report.csv',contentType:'text/csv'}),selectMarker:async()=>({selector:'#report',label:'Synthetic report'}),replay:async()=>{await duringReplay();if(failReplay)throw Error('Replay failed');return{bytes:replayBytes,name:'report.csv',contentType:'text/csv'};},screenshot:async()=>{throw Error('Unused');},waitForCompletion:async()=>{throw Error('Unused');},closeOwned:async(owner)=>{closedOwners.push(owner.installationId+'/'+owner.profilePersonId);}};
 const files=createFileStore({directory:path.join(root,'files'),limits:defaultFileLimits}),profiles=createBrowserProfileService({runtimeRoot:root,repository,clock}),service=createOkoWorkflowService({repository,runtime,profiles,files,jobs,clock,recheckGuard:async(context)=>{if(own.role==='viewer'||own.personId!==context.ownAccess.personId)throw Error('Access revoked');}}),commands=createCommandRegistry({repository,jobs,accessPolicy});
 const module=createOkoWorkflowModule({service});
 const app=await createWorkbenchApp({hostname:()=> 'SYNTHETIC-HOST',repository,clock,accessPolicy,commands,queries:new QueryRegistry(),jobs,modules:[module],sessions:createLocalSessionStore({clock}),allowedOrigins:['http://localhost:5173'],installationId,files,browserResults:{read:service.readResult}});
 closes.push(async()=>{await app.close();repository.close();if(!path.basename(root).startsWith('uor-oko-workflow-'))throw Error('Unsafe cleanup');rmSync(root,{recursive:true,force:true});});

 const session=await app.inject({method:'GET',url:'/api/v1/session',headers:{host:'localhost'}}),headers={host:'localhost',origin:'http://localhost:5173',cookie:String(session.headers['set-cookie']).split(';')[0],'x-csrf-token':session.json().data.csrfToken};
 const command=async(name:string,payload:unknown)=>{const response=await app.inject({method:'POST',url:'/api/v1/commands',headers,payload:{commandId:randomUUID(),name,baseRevision:null,payload}});if(![200,202].includes(response.statusCode))throw Error(name+JSON.stringify(response.json()));const data=response.json().data;if(data.jobId){await commands.idle();return jobs.get(data.jobId,installationId)!;}return data;};
 const result=async(name:string,payload:unknown):Promise<OkoWorkflowView>=>{const response=await command(name,payload);if('status'in response){expect(response.status,JSON.stringify(response)).toBe('succeeded');return response.result as OkoWorkflowView;}return response.result;};
 const prepare=async()=>{let v=await result('source.browser.workflow.open',{});v=await result('source.browser.profile.set',{workflowId:v.workflowId,expectedRevision:v.revision,reportUrl:'https://report.example/report',profile:{allowedOrigins:['https://report.example'],maxBytes:100000,timeoutMs:10000,retries:0,browser:{channel:'msedge',profileDirectory:'synthetic',headless:false}}});v=await result('source.browser.marker.select',{workflowId:v.workflowId,reportUrl:v.reportUrl});v=await result('source.browser.record.start',{workflowId:v.workflowId,expectedRevision:v.revision,reportUrl:v.reportUrl,parsingProfile:{...v.parsingProfile,decimalSeparator:',',csvDelimiter:';',dateFormat:'dd.mm.yyyy'}});v=await result('source.browser.record.finish',{workflowId:v.workflowId,recordingId:handle});v=await result('source.browser.mapping.save',{workflowId:v.workflowId,expectedRevision:v.revision,parsingProfile:v.parsingProfile,parameters:{},mapping:{rowKeyColumns:['Key'],productKeyColumn:'Key',dimensionColumns:{},numberColumns:{value:'Amount'},dateColumn:'Date',unitColumn:null,fixedUnitCode:'units'}});return v;};
 const context=()=>({requestId:randomUUID(),installationId,repository,clock,ownAccess:own});
 return{app,headers,service,profiles,runtime,closedOwners,command,result,prepare,files,installationId,context,repository,root,commands,jobs,restart:()=>createOkoWorkflowService({repository,runtime,profiles,files,jobs,clock}),setReplayFailure:(v:boolean)=>{failReplay=v;},setDuringReplay:(v:()=>Promise<void>)=>{duringReplay=v;},setOwn:(v:Partial<OwnAccessProfile>)=>{own={...own,...v};}};
}
it('full v1 own recording → mapping → real SQLite result + verified private downloads; failed replay preserves previous success',async()=>{
 const f=await fixture();let v=await f.prepare();expect(v.columns).toEqual(['Key','Amount','Date']);expect(v.sampleRows).toHaveLength(2);
 const before=f.repository.getStateRevision();const query=await f.app.inject({method:'POST',url:'/api/v1/queries/source.browser.workspace',headers:f.headers,payload:{context:null,filter:{workflowId:v.workflowId},sort:[]}});expect(query.statusCode,query.body).toBe(200);expect(f.repository.getStateRevision()).toBe(before);
 v=await f.result('source.browser.record.test',{workflowId:v.workflowId,expectedRevision:v.revision});expect(v.result).toMatchObject({rowCount:2,unresolvedRows:2,sourceDate:'2026-10-28'});expect(v.result!.previewRows[0]['number.value']).toBe('12.5');
 const original=await f.service.readResult(f.context(),v.result!.resultId,'original');expect(Buffer.from(original.bytes).toString()).toContain('12,5');const enriched=await f.service.readResult(f.context(),v.result!.resultId,'enriched');expect(Buffer.from(enriched.bytes).toString()).toContain('number.value');
 const download=await f.app.inject({method:'GET',url:v.result!.originalDownload,headers:f.headers});expect(download.statusCode,download.body).toBe(200);expect(download.headers['x-content-type-options']).toBe('nosniff');expect(download.body).toContain('12,5');
 const previous=structuredClone(v.result);f.setReplayFailure(true);const failed=await f.command('source.browser.record.test',{workflowId:v.workflowId,expectedRevision:v.revision});expect(failed.status).toBe('failed');expect((await f.service.workspace(f.context(),v.workflowId)).current!.result).toEqual(previous);
 f.setOwn({personId:randomUUID()});await expect(f.service.readResult(f.context(),previous!.resultId,'original')).rejects.toThrow(/not found/);expect((await f.service.workspace(f.context())).workflows).toEqual([]);
});
it('explicit directory UUIDs enrich only unambiguous graph; no guessed leaders or identifiers',async()=>{
 const f=await fixture();let v=await f.prepare();const names=['key','productId','productName','clusterId','clusterName','ditId','ditName','clusterLeaderId','clusterLeaderName','productLeaderId','productLeaderName'];const mapping=Object.fromEntries(names.map(n=>[n,n])) as OkoDictionaryMapping;mapping.teamId=null;mapping.teamName=null;
 const bytes=Buffer.from(names.join(';')+'\r\n'+['P1',randomUUID(),'Product',randomUUID(),'Cluster',randomUUID(),'DIT',randomUUID(),'Cluster leader',randomUUID(),'Product leader'].join(';'));
 const file=await f.files.stage({installationId:f.installationId,purpose:'goal-import',name:'directory.csv',mediaType:'text/csv',stream:(async function*(){yield bytes;})()});v=await f.result('source.browser.directory.preview',{workflowId:v.workflowId,fileHandle:file.fileHandle,parsingProfile:v.parsingProfile});v=await f.result('source.browser.directory.apply',{workflowId:v.workflowId,expectedRevision:v.revision,mapping});expect(v.dictionary.issues).toEqual([]);v=await f.result('source.browser.record.test',{workflowId:v.workflowId,expectedRevision:v.revision});expect(v.result!.unresolvedRows).toBe(1);expect(v.result!.previewRows[0]['directory.productName']).toBe('Product');
});
it('role, CSRF, CAS and cancellation/fresh access gate guard replay persistence',async()=>{
 const f=await fixture();let v=await f.prepare();const blocked=await f.app.inject({method:'POST',url:'/api/v1/commands',headers:{...f.headers,'x-csrf-token':''},payload:{commandId:randomUUID(),name:'source.browser.workflow.open',baseRevision:null,payload:{}}});expect(blocked.statusCode).toBe(403);
 await expect(f.command('source.browser.mapping.save',{workflowId:v.workflowId,expectedRevision:'stale',mapping:v.mapping,parameters:{},parsingProfile:v.parsingProfile})).rejects.toThrow(/REVISION_CONFLICT/);
 f.setDuringReplay(async()=>{f.setOwn({role:'viewer'});});const failed=await f.command('source.browser.record.test',{workflowId:v.workflowId,expectedRevision:v.revision});expect(failed.status).toBe('failed');expect((await f.service.workspace(f.context(),v.workflowId)).current!.result).toBeNull();await expect(f.command('source.browser.workflow.open',{})).rejects.toThrow(/COMMAND_FORBIDDEN/);
});
it('cancelled replay cannot persist a result even if the browser returns bytes after cancellation',async()=>{
 const f=await fixture(),v=await f.prepare();let release!:()=>void,entered!:()=>void;
 const enteredPromise=new Promise<void>(resolve=>{entered=resolve;}),releasePromise=new Promise<void>(resolve=>{release=resolve;});
 f.setDuringReplay(async()=>{entered();await releasePromise;});
 const accepted=await f.app.inject({method:'POST',url:'/api/v1/commands',headers:f.headers,payload:{commandId:randomUUID(),name:'source.browser.record.test',baseRevision:null,payload:{workflowId:v.workflowId,expectedRevision:v.revision}}});
 expect(accepted.statusCode).toBe(202);await enteredPromise;
 const jobId=accepted.json().data.jobId;await f.command('job.cancel',{jobId});release();await f.commands.idle();
 expect(f.jobs.get(jobId,f.installationId)!.status).toBe('cancelled');expect((await f.service.workspace(f.context(),v.workflowId)).current!.result).toBeNull();
});
it('new service reads durable drafts and result bytes, and reports an orphaned recording as interrupted without mutation',async()=>{
 const f=await fixture();let v=await f.prepare();v=await f.result('source.browser.record.test',{workflowId:v.workflowId,expectedRevision:v.revision});
 const restarted=f.restart();expect((await restarted.workspace(f.context(),v.workflowId)).current!.result).toEqual(v.result);expect((await restarted.readResult(f.context(),v.result!.resultId,'original')).bytes.length).toBeGreaterThan(0);
 v=await f.result('source.browser.record.start',{workflowId:v.workflowId,expectedRevision:v.revision,reportUrl:v.reportUrl,parsingProfile:v.parsingProfile});const before=f.repository.getStateRevision();
 expect((await f.restart().workspace(f.context(),v.workflowId)).current!.recording.state).toBe('interrupted');expect(f.repository.getStateRevision()).toBe(before);
});
it('invalid explicit directory IDs remain issues and never produce guessed identities',async()=>{
 const f=await fixture();let v=await f.prepare();const names=['key','productId','productName','clusterId','clusterName','ditId','ditName','clusterLeaderId','clusterLeaderName','productLeaderId','productLeaderName'];const mapping={...Object.fromEntries(names.map(n=>[n,n])),teamId:null,teamName:null} as OkoDictionaryMapping;
 const bytes=Buffer.from(names.join(';')+'\r\n'+['P1','product-by-name','Product',randomUUID(),'Cluster',randomUUID(),'DIT','','',randomUUID(),'Leader'].join(';'));const file=await f.files.stage({installationId:f.installationId,purpose:'goal-import',name:'directory.csv',mediaType:'text/csv',stream:(async function*(){yield bytes;})()});
 v=await f.result('source.browser.directory.preview',{workflowId:v.workflowId,fileHandle:file.fileHandle,parsingProfile:v.parsingProfile});v=await f.result('source.browser.directory.apply',{workflowId:v.workflowId,expectedRevision:v.revision,mapping});expect(v.dictionary.issues.some(issue=>issue.code==='DIRECTORY_UUID_REQUIRED')).toBe(true);
 v=await f.result('source.browser.record.test',{workflowId:v.workflowId,expectedRevision:v.revision});expect(v.result!.unresolvedRows).toBe(2);expect(v.result!.previewRows[0]['directory.productId']).toBeUndefined();
});
it('shutdown closes every server-derived browser owner across person changes',async()=>{
 const f=await fixture();await f.prepare();const first=f.context().ownAccess.personId;const second=randomUUID();f.setOwn({personId:second});await f.prepare();await f.service.shutdown();
 expect(new Set(f.closedOwners)).toEqual(new Set([f.installationId+'/'+first,f.installationId+'/'+second]));
});
it('one product mapped to several teams enriches a source row once using the core directory graph',async()=>{
 const f=await fixture();let v=await f.prepare();const names=['key','productId','productName','clusterId','clusterName','ditId','ditName','clusterLeaderId','clusterLeaderName','productLeaderId','productLeaderName','teamId','teamName'];const mapping=Object.fromEntries(names.map(n=>[n,n])) as OkoDictionaryMapping;
 const first=['P1',randomUUID(),'Product',randomUUID(),'Cluster',randomUUID(),'DIT',randomUUID(),'Cluster leader',randomUUID(),'Product leader',randomUUID(),'Team A'];const second=[...first];second[11]=randomUUID();second[12]='Team B';
 const bytes=Buffer.from([names.join(';'),first.join(';'),second.join(';')].join('\r\n'));const file=await f.files.stage({installationId:f.installationId,purpose:'goal-import',name:'directory.csv',mediaType:'text/csv',stream:(async function*(){yield bytes;})()});
 v=await f.result('source.browser.directory.preview',{workflowId:v.workflowId,fileHandle:file.fileHandle,parsingProfile:v.parsingProfile});v=await f.result('source.browser.directory.apply',{workflowId:v.workflowId,expectedRevision:v.revision,mapping});expect(v.dictionary.issues).toEqual([]);
 v=await f.result('source.browser.record.test',{workflowId:v.workflowId,expectedRevision:v.revision});expect(v.result).toMatchObject({rowCount:2,unresolvedRows:1});expect(v.result!.previewRows[0]['directory.teamNames']).toBe('Team A | Team B');
});
it('detects conflicting names for the same person UUID across cluster and product leader roles',async()=>{
 const f=await fixture();let v=await f.prepare();const names=['key','productId','productName','clusterId','clusterName','ditId','ditName','clusterLeaderId','clusterLeaderName','productLeaderId','productLeaderName'];const mapping={...Object.fromEntries(names.map(n=>[n,n])),teamId:null,teamName:null} as OkoDictionaryMapping;const person=randomUUID();
 const bytes=Buffer.from([names.join(';'),['P1',randomUUID(),'Product',randomUUID(),'Cluster',randomUUID(),'DIT',person,'Name A',person,'Name B'].join(';')].join('\r\n'));const file=await f.files.stage({installationId:f.installationId,purpose:'goal-import',name:'directory.csv',mediaType:'text/csv',stream:(async function*(){yield bytes;})()});
 v=await f.result('source.browser.directory.preview',{workflowId:v.workflowId,fileHandle:file.fileHandle,parsingProfile:v.parsingProfile});v=await f.result('source.browser.directory.apply',{workflowId:v.workflowId,expectedRevision:v.revision,mapping});expect(v.dictionary.issues.some(issue=>issue.code==='DIRECTORY_GRAPH_AMBIGUOUS')).toBe(true);
});
const directContext=(f:Awaited<ReturnType<typeof fixture>>)=>({...f.context(),commandId:randomUUID(),actor:{hostname:'SYNTHETIC-HOST',installationId:f.installationId,profilePersonId:f.context().ownAccess.personId}});
const gate=()=>{let release!:()=>void,enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});return{entered,release,wait:async()=>{enter();await released;}};};
it('serializes private profile write across awaited set so a concurrent mapping cannot cause 409 after that write',async()=>{
 const f=await fixture(),v=await f.prepare(),g=gate(),original=f.profiles.set;f.profiles.set=async(context,input)=>{await g.wait();return original(context,input);};
 const profile=f.service.setProfile(directContext(f),{workflowId:v.workflowId,expectedRevision:v.revision,reportUrl:v.reportUrl,profile:v.profile.profile!});await g.entered;
 let mappingSettled=false;const mapping=f.service.saveMapping(directContext(f),{workflowId:v.workflowId,expectedRevision:v.revision,mapping:v.mapping!,parameters:v.parameters,parsingProfile:v.parsingProfile}).then(value=>{mappingSettled=true;return{value};},error=>{mappingSettled=true;return{error};});
 await new Promise(resolve=>setTimeout(resolve,10));const settledBeforeRelease=mappingSettled;g.release();const outcome=await Promise.allSettled([profile,mapping]);expect(settledBeforeRelease).toBe(false);expect(outcome[0].status).toBe('fulfilled');expect(await mapping).toMatchObject({error:{code:'REVISION_CONFLICT'}});
});
it('freshly rechecks preparation after asynchronous recording start and closes denied owned browser without persisting',async()=>{
 const f=await fixture(),v=await f.prepare(),g=gate(),original=f.runtime.startRecording;f.runtime.startRecording=async(input,signal)=>{await g.wait();return original(input,signal);};
 const promise=f.service.start(directContext(f),{workflowId:v.workflowId,expectedRevision:v.revision,reportUrl:v.reportUrl,parsingProfile:v.parsingProfile});await g.entered;f.setOwn({role:'viewer'});g.release();await expect(promise).rejects.toThrow(/revoked/);const current=(await f.service.workspace(f.context(),v.workflowId)).current!;expect(current.revision).toBe(v.revision);expect(current.recording).toEqual(v.recording);expect(f.closedOwners.length).toBeGreaterThan(0);
});
it('revocation during completed download blocks finish persistence and keeps previous recording state',async()=>{
 const f=await fixture();let v=await f.prepare();v=await f.result('source.browser.record.start',{workflowId:v.workflowId,expectedRevision:v.revision,reportUrl:v.reportUrl,parsingProfile:v.parsingProfile});const before=(await f.service.workspace(f.context(),v.workflowId)).current!,g=gate(),original=f.runtime.readRecordingDownload;f.runtime.readRecordingDownload=async(input)=>{await g.wait();return original(input);};
 const promise=f.service.finish(directContext(f),{workflowId:v.workflowId,recordingId:v.recording.recordingId!});await g.entered;f.setOwn({role:'viewer'});g.release();await expect(promise).rejects.toThrow(/revoked/);expect((await f.service.workspace(f.context(),v.workflowId)).current!.revision).toBe(before.revision);
});
it.each(['revoked','changed-person'])('late directory parse/read %s cannot save or expose a new dictionary preview',async(change)=>{
 const f=await fixture(),v=await f.prepare(),g=gate(),original=f.files.read;const bytes=Buffer.from('Key;Value\r\nA;1');const file=await f.files.stage({installationId:f.installationId,profilePersonId:f.context().ownAccess.personId,purpose:'goal-import',name:'dictionary.csv',mediaType:'text/csv',stream:(async function*(){yield bytes;})()});
 f.files.read=async(...args)=>{await g.wait();return original(...args);};const oldContext=directContext(f);const promise=f.service.directoryPreview(oldContext,{workflowId:v.workflowId,fileHandle:file.fileHandle,parsingProfile:v.parsingProfile});await g.entered;if(change==='revoked')f.setOwn({role:'viewer'});else f.setOwn({personId:randomUUID()});g.release();await expect(promise).rejects.toThrow(/revoked/);expect((await f.service.workspace(oldContext,v.workflowId)).current!.revision).toBe(v.revision);
});
it('cancel closes a human picker before waiting for its mutation lock, then persists cancellation',async()=>{
 const f=await fixture(),v=await f.prepare();let enter!:()=>void,rejectPicker!:(error:unknown)=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});f.runtime.selectMarker=async()=>{enter();return new Promise((_,reject)=>{rejectPicker=reject;});};let closed=false;const close=f.runtime.closeOwned;f.runtime.closeOwned=async owner=>{closed=true;rejectPicker?.(new DOMException('Cancelled','AbortError'));await close(owner);};
 const marker=f.service.marker(directContext(f),{workflowId:v.workflowId,reportUrl:v.reportUrl});const observed=marker.catch(error=>error);await entered;const cancelled=await f.service.cancel(directContext(f),{workflowId:v.workflowId});expect(closed).toBe(true);expect(await observed).toMatchObject({name:'AbortError'});expect(cancelled.recording.state).toBe('idle');
});
