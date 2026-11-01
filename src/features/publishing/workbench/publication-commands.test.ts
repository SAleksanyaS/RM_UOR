import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { draftCleanups,business,draftFixture } from '../../../../tests/fixtures/workbench/drafts';
import { syntheticCapabilities } from '../../../../tests/fixtures/workbench/proposals';
import { fixtureId,makeEntityGraph,makeNumericFixture } from '../../../../tests/fixtures/workbench/factories';
import { createFakeBitbucket } from './fake-bitbucket';
import { createPackageArtifactStore } from './package-artifacts';
import { canonicalBytes,buildPackageManifest } from './package-manifest';
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
  const base=draftFixture({input:makeNumericFixture({scope:{kind:'dit',id:fixtureId(101)}})});
  const f={...base,businessInput:base.input,fake:createFakeBitbucket({capabilities:syntheticCapabilities}),deps:{accessPolicy:base.policy}};
  const remote=new Map<string,string>();const prepared=new Map<number,PreparedProposal>();let commits=0,pushes=0,serial=245000;
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
it('registers explicit publication check and apply for a reader without sending or requiring REST',async()=>{
  const f=await fixture();f.main.files.clear();f.context.ownAccess={...f.context.ownAccess,role:'viewer'};
  f.fake.capabilities=async()=>{throw Error('REST must not be needed by a reader');};
  const checked=await f.send('publication.check',{});expect(checked.job.status).toBe('succeeded');expect(checked.job.result).toMatchObject({currentCommit:null,availableCommit:f.main.commit,available:true});
  const applied=await f.send('publication.apply',{mainCommit:f.main.commit});expect(applied.job.error).toBeNull();expect(applied.job.status).toBe('succeeded');expect(applied.job.result).toMatchObject({appliedCommit:f.main.commit,anchors:[]});
  const current=await f.send('publication.check',{});expect(current.job.result).toMatchObject({currentCommit:f.main.commit,available:false});expect(f.counts()).toEqual({commits:0,pushes:0});
});
it('refuses publication apply when the explicit checked commit has changed',async()=>{
  const f=await fixture();f.main.files.clear();const applied=await f.send('publication.apply',{mainCommit:'f'.repeat(40)});
  expect(applied.job.status).toBe('failed');expect(applied.job.error?.code).toBe('PREVIEW_STALE');expect(f.counts()).toEqual({commits:0,pushes:0});
});
it('retains actionable domain errors and leaves accepted state unchanged through the real apply registry',async()=>{
  const f=await fixture(),packageId=fixtureId(269300),goal={...f.businessInput.goal,id:fixtureId(269301),sourceId:fixtureId(269399),publicationAnchorId:packageId};
  const files=new Map([[`records/core_goal_definition/${goal.id}/1.json`,canonicalBytes(goal)]]),manifest=buildPackageManifest({package:{schemaVersion:1,packageId,cycleId:fixtureId(269302),curatorPersonId:fixtureId(17),revision:1,baseCommit:'a'.repeat(40),targetBranch:'main',createdAt:f.clock.now()},files});
  const prefix=`published/workbench/packages/${packageId}/1/`;f.main.files.clear();for(const[name,bytes]of files)f.main.files.set(prefix+name,bytes);f.main.files.set(prefix+'manifest.json',canonicalBytes(manifest));
  const applied=await f.send('publication.apply',{mainCommit:f.main.commit});
  expect(applied.job.status).toBe('failed');expect(applied.job.error?.code).toBe('REFERENCE_NOT_FOUND');
  expect(f.repository.readPublicationAnchor({entityType:'publication_anchor',id:packageId})).toBeNull();expect(f.repository.getHead({entityType:'core_goal_definition',id:goal.id})).toBeNull();
  const checked=await f.send('publication.check',{});expect(checked.job.result).toMatchObject({currentCommit:null});
});

