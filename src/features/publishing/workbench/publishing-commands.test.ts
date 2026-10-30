import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { draftCleanups,business } from '../../../../tests/fixtures/workbench/drafts';
import { proposalFixture } from '../../../../tests/fixtures/workbench/proposals';
import { fixtureId,makeEntityGraph } from '../../../../tests/fixtures/workbench/factories';
import { createPackageArtifactStore } from './package-artifacts';
import { canonicalBytes } from './package-manifest';
import { PublishingService } from './publishing-service';
import { registerPublishingCommands } from './register-commands';
import type { PublicationGitPort,PreparedProposal } from './git-port';
import type { TerminalRunner } from './terminal-runner';
import { packagePreviewResultSchema,packageSubmitResultSchema,packageStatusResultSchema } from './contracts';
import { createJobStore } from '../../../server/workbench/jobs';
import { createCommandRegistry } from '../../../server/workbench/command-registry';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';

afterEach(async()=>{for(const cleanup of draftCleanups.splice(0)) await cleanup();});
async function fixture() {
  const f=proposalFixture();const remote=new Map<string,string>();const prepared=new Map<number,PreparedProposal>();let commits=0,pushes=0,serial=245000;
  const main={repositoryId:'synthetic-main',commit:'a'.repeat(40),files:new Map(makeEntityGraph(f.businessInput).entries.map(({entityType,value})=>[`records/${entityType}/${value.id}/${value.revision}.json`,canonicalBytes(value)]))};
  const git:PublicationGitPort={async readMain(){return main;},async inspectRemote(branch){return remote.get(branch)??null;},async prepare(input){
    const revision=input.manifest.packageRevision,old=prepared.get(revision.revision);if(old) return old;commits++;
    const value={packageRevision:revision,branch:`uor/${revision.curatorPersonId}/${revision.packageId}`,checkout:path.join(f.root,'private-checkout-'+revision.revision),commit:(revision.revision===1?'b':'c').repeat(40),expectedRemoteHead:input.expectedRemoteHead};prepared.set(revision.revision,value);return value;
  },async verifyPrepared(value){if((remote.get(value.branch)??null)!==value.expectedRemoteHead) throw Error('Stale prepared branch');}};
  const terminal:TerminalRunner={async runGitPush(input){await input.preTransferGate();const value=[...prepared.values()].find(value=>value.commit===input.preparedCommit)!;pushes++;remote.set(value.branch,value.commit);return {status:'confirmed',exitCode:0,remoteCommit:value.commit};}};
  const dependencies={repository:f.repository,clock:f.clock,drafts:f.service,artifacts:createPackageArtifactStore({artifactRoot:path.join(f.root,'packages')}),git,bitbucket:f.fake,terminal,accessPolicy:f.deps.accessPolicy,jobs:f.jobs,jobSink:f.jobs,publication:{mode:'demo-only' as const,classifyRecord:()=>true}};
  const service=new PublishingService(dependencies);
  registerPublishingCommands(f.registry,service);
  const edit=async(text:string)=>{const opened=await f.open('core_goal_definition',{entityType:'core_goal_definition',id:f.businessInput.goal.id});await f.execute('goal.draft.save',{draftId:opened.draftId,definition:{...business(f.businessInput.goal),description:text}});};
  const send=async(name:string,payload:Record<string,unknown>,commandId=fixtureId(serial++))=>{
    const request={commandId,name,baseRevision:name==='package.preview'?f.token():null,payload};const accepted=await f.registry.execute(request,{...f.context,commandId});if(!('jobId' in accepted)) throw Error('Expected async job');await f.registry.idle();return {request,accepted,job:f.jobs.get(accepted.jobId,f.context.installationId)!};
  };
  const preview=async()=>{const value=await send('package.preview',{packageId:f.packageId()});expect(value.job.error).toBeNull();return packagePreviewResultSchema.parse(value.job.result);};
  await edit('Первая редакция');
  return {...f,remote,prepared,main,git,terminal,dependencies,publishing:service,edit,send,preview,counts:()=>({commits,pushes})};
}
it('registers owned asynchronous submit/status and replays one typed command job',async()=>{
  const f=await fixture(),preview=await f.preview(),sent=await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});
  expect(sent.job.status).toBe('succeeded');const result=packageSubmitResultSchema.parse(sent.job.result);expect(result.state).toBe('open_pr');
  expect(await f.registry.execute(sent.request,{...f.context,commandId:sent.request.commandId})).toEqual(sent.accepted);expect(f.counts()).toEqual({commits:1,pushes:1});
  await expect(f.registry.execute({...sent.request,payload:{...sent.request.payload,previewToken:'changed'}},{...f.context,commandId:sent.request.commandId})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  f.context.ownAccess={...f.context.ownAccess,personId:fixtureId(245999)};
  await expect(f.registry.execute(sent.request,{...f.context,commandId:sent.request.commandId})).rejects.toMatchObject({code:'COMMAND_NOT_FOUND'});
});
it('recovers a lost native create through the same job without another commit or push',async()=>{
  const f=await fixture(),preview=await f.preview();f.fake.testing.loseNextCreateResponse=true;
  const sent=await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});expect(sent.job.status).toBe('retry_wait');expect(sent.job.warnings[0].code).toBe('REMOTE_STATE_UNKNOWN');
  await f.send('job.retry',{jobId:sent.job.jobId});const job=f.jobs.get(sent.job.jobId,f.context.installationId)!;
  expect(job.error).toBeNull();expect(job.status).toBe('succeeded');expect(packageSubmitResultSchema.parse(job.result).proposal.id).toBe('1');expect(f.fake.testing.creates).toBe(1);expect(f.counts()).toEqual({commits:1,pushes:1});
});
it('keeps sent revision frozen and updates the same PR after explicit rework',async()=>{
  const f=await fixture(),first=await f.preview();const sent=await f.send('package.submit',{packageId:f.packageId(),previewToken:first.previewToken});const proposal=packageSubmitResultSchema.parse(sent.job.result).proposal;
  f.fake.testing.addComment(proposal,{id:'1',version:'1',text:'Обычное замечание',createdAt:f.clock.now(),authorDisplayName:'Ревьюер',requiresRework:false});
  const normal=await f.send('package.refreshStatus',{packageId:f.packageId()});expect(packageStatusResultSchema.parse(normal.job.result).state).toBe('open_pr');
  f.fake.testing.setState(proposal,'needs_rework');const rework=await f.send('package.refreshStatus',{packageId:f.packageId()});expect(packageStatusResultSchema.parse(rework.job.result).state).toBe('needs_rework');
  await f.edit('Доработка');const second=await f.preview();expect(second.packageRevision.revision).toBe(2);
  expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())!.sent).toEqual(first.packageRevision);
  const updated=await f.send('package.submit',{packageId:f.packageId(),previewToken:second.previewToken});expect(packageSubmitResultSchema.parse(updated.job.result).proposal).toEqual(proposal);expect(f.fake.testing.creates).toBe(1);expect(f.fake.testing.updates).toBe(1);
});
it('preserves the observed package state when the provider reports unknown',async()=>{
  const f=await fixture(),preview=await f.preview();const sent=await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});const proposal=packageSubmitResultSchema.parse(sent.job.result).proposal;
  f.fake.testing.setState(proposal,'unknown');const refreshed=await f.send('package.refreshStatus',{packageId:f.packageId()});const result=packageStatusResultSchema.parse(refreshed.job.result);
  expect(result.state).toBe('open_pr');expect(result.warnings[0].code).toBe('REMOTE_STATE_UNKNOWN');expect(result.anchor).toBeNull();
  f.fake.testing.setState(proposal,'declined');const declined=await f.send('package.refreshStatus',{packageId:f.packageId()});expect(packageStatusResultSchema.parse(declined.job.result).state).toBe('declined');
});
it('discovers an already-created PR through status refresh after a lost create response',async()=>{
  const f=await fixture(),preview=await f.preview();f.fake.testing.loseNextCreateResponse=true;
  const sent=await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});expect(sent.job.status).toBe('retry_wait');
  const refreshed=await f.send('package.refreshStatus',{packageId:f.packageId()});const result=packageStatusResultSchema.parse(refreshed.job.result);
  expect(result.state).toBe('open_pr');expect(result.proposal?.id).toBe('1');expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())!.sent).toEqual(preview.packageRevision);expect(f.counts()).toEqual({commits:1,pushes:1});
});
it('requires a new package after the native proposal has been merged',async()=>{
  const f=await fixture(),preview=await f.preview();const sent=await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});
  f.fake.testing.setState(packageSubmitResultSchema.parse(sent.job.result).proposal,'merged');await f.send('package.refreshStatus',{packageId:f.packageId()});
  await f.edit('Правка после merge');const next=await f.send('package.preview',{packageId:f.packageId()});
  expect(next.job.status).toBe('failed');expect(next.job.error?.code).toBe('PACKAGE_CLOSED');expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())!.state).toBe('merged');
});
it('restores explicit job retry after recreating the registry and job store without sending automatically',async()=>{
  const f=await fixture(),preview=await f.preview();f.fake.testing.loseNextCreateResponse=true;
  const sent=await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});expect(sent.job.status).toBe('retry_wait');
  const jobs=createJobStore({repository:f.repository,clock:f.clock}),registry=createCommandRegistry({repository:f.repository,jobs,accessPolicy:f.deps.accessPolicy});
  registerPublishingCommands(registry,new PublishingService({...f.dependencies,jobs,jobSink:jobs}));
  await registry.recoverPending(f.context.installationId,async identity=>({...f.context,commandId:identity.commandId}));await registry.idle();expect(f.counts()).toEqual({commits:1,pushes:1});
  expect(await registry.execute(sent.request,{...f.context,commandId:sent.request.commandId})).toEqual(sent.accepted);
  const commandId=fixtureId(246001);await registry.execute({commandId,name:'job.retry',baseRevision:null,payload:{jobId:sent.job.jobId}},{...f.context,commandId});await registry.idle();
  expect(jobs.get(sent.job.jobId,f.context.installationId)!.status).toBe('succeeded');expect(f.fake.testing.creates).toBe(1);expect(f.counts()).toEqual({commits:1,pushes:1});
});
it('finds unresolved external submission even after a newer local preview changes package state',async()=>{
  const f=await fixture(),first=await f.preview();f.fake.testing.loseNextCreateResponse=true;await f.send('package.submit',{packageId:f.packageId(),previewToken:first.previewToken});
  await f.edit('Новая локальная редакция');const second=await f.preview();const refreshed=await f.send('package.refreshStatus',{packageId:f.packageId()});
  expect(packageStatusResultSchema.parse(refreshed.job.result).proposal?.id).toBe('1');const record=f.publishing.readPort.readOwnPackage(f.context,f.packageId())!;
  expect(record.sent).toEqual(first.packageRevision);expect(record.current).toEqual(second.packageRevision);expect(f.counts()).toEqual({commits:1,pushes:1});
});
it('does not claim open when the native proposal still requires rework on the same commit',async()=>{
  const f=await fixture(),preview=await f.preview();const first=await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});
  f.fake.testing.setState(packageSubmitResultSchema.parse(first.job.result).proposal,'needs_rework');
  const again=await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});
  expect(again.job.status).toBe('failed');expect(again.job.error?.code).toBe('PROPOSAL_NEEDS_REWORK');expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())!.state).toBe('needs_rework');
});
it('keeps a confirmation-read failure after push recoverable and reads before retry',async()=>{
  const f=await fixture(),preview=await f.preview(),inspect=f.git.inspectRemote;let failed=false;
  f.git.inspectRemote=async branch=>{if(f.counts().pushes>0&&!failed){failed=true;throw new WorkbenchHttpError(503,'GIT_PROVIDER_FAILED','Synthetic confirmation outage');}return inspect(branch);};
  const sent=await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});
  expect(sent.job.status).toBe('retry_wait');expect(sent.job.warnings[0]).toMatchObject({code:'REMOTE_STATE_UNKNOWN',provider:'git'});
  await f.send('job.retry',{jobId:sent.job.jobId});expect(f.jobs.get(sent.job.jobId,f.context.installationId)!.status).toBe('succeeded');expect(f.counts()).toEqual({commits:1,pushes:1});
});
it('does not present comments from an external snapshot rejected for another package',async()=>{
  const f=await fixture(),preview=await f.preview();await f.send('package.submit',{packageId:f.packageId(),previewToken:preview.previewToken});
  const foreign=await f.fake.createProposal(f.input());f.fake.testing.addComment(foreign.link,{id:'foreign',version:'1',text:'Чужое обсуждение',createdAt:f.clock.now(),authorDisplayName:'Другой автор',requiresRework:false});
  f.fake.readProposal=async()=>foreign;
  const refreshed=await f.send('package.refreshStatus',{packageId:f.packageId()});const result=packageStatusResultSchema.parse(refreshed.job.result);
  expect(result.comments).toEqual([]);expect(result.warnings[0].code).toBe('REMOTE_STATE_UNKNOWN');expect(result.proposal?.id).toBe('1');
});
