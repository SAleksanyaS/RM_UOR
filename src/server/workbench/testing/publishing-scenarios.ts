import path from 'node:path';
import { createHash } from 'node:crypto';
import type { OwnAccessProfile } from '../../../features/identity/workbench-access-policy';
import type { composeGoalSetupPreview } from './goal-setup-scenarios';
import type { PreparedProposal, PublicationGitPort } from '../../../features/publishing/workbench/git-port';
import type { TerminalRunner } from '../../../features/publishing/workbench/terminal-runner';
import { PublishingService } from '../../../features/publishing/workbench/publishing-service';
import { registerPublishingCommands } from '../../../features/publishing/workbench/register-commands';
import { createPackageArtifactStore } from '../../../features/publishing/workbench/package-artifacts';
import { canonicalBytes } from '../../../features/publishing/workbench/package-manifest';
import { syntheticCandidateInput, syntheticProposalTree, syntheticPublishedTree } from '../../../features/publishing/workbench/testing/candidate-fixture';
import { createFakeBitbucket } from '../../../features/publishing/workbench/fake-bitbucket';
import { syntheticCapabilities } from '../../../../tests/fixtures/workbench/proposals';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
import type { WorkbenchRepository } from '../../storage/workbench-repository';
import type { Clock, VersionRef } from '../../../domain/workbench/primitives';
import type { GlobalContext } from '../protocol';
import { WorkbenchHttpError } from '../protocol';
import type { CommandContext } from '../command-registry';

/** Actual owners and command receipts, with in-memory external providers. Never production. */
export async function composePublishingScenario(input: Parameters<typeof composeGoalSetupPreview>[0] & { own: OwnAccessProfile }) {
  const accepted=input.repository.exportWorkspaceCore().filter(r=>r.entityType!=='publication_anchor'&&'publicationAnchorId' in r.value&&r.value.publicationAnchorId!==null).map(r=>({entityType:r.entityType,value:r.value as import('../../../domain/workbench/primitives').Header}));
  // Goal read-model fixtures do not need leaders; an accepted full publication
  // graph does. Add explicit synthetic links instead of bypassing its validator.
  const scopes=accepted.filter(r=>r.entityType==='directory_entity'&&['cluster','product'].includes((r.value as import('../../../domain/workbench/entities').DirectoryEntity).kind));
  for(const [index,row] of scopes.entries()){
    const scope=row.value as import('../../../domain/workbench/entities').DirectoryEntity;
    if(accepted.some(r=>r.entityType==='directory_link'&&(r.value as import('../../../domain/workbench/entities').DirectoryLink).kind==='leader'&&(r.value as Extract<import('../../../domain/workbench/entities').DirectoryLink,{kind:'leader'}>).scope.id===scope.id))continue;
    const link:import('../../../domain/workbench/entities').DirectoryLink={...makeHeader(360100+index,{publicationAnchorId:scope.publicationAnchorId}),kind:'leader',scope:{kind:scope.kind as 'cluster'|'product',id:scope.id},personId:fixtureId(17)};
    accepted.push({entityType:'directory_link',value:link});
  }
  const main = { repositoryId: 'synthetic-main', commit: 'b'.repeat(40), files: syntheticPublishedTree(accepted,'a'.repeat(40),input.clock.now(),input.own.personId??fixtureId(17)) };
  const remote = new Map<string,string>(), prepared = new Map<string,PreparedProposal>();
  const candidateTrees=new Map<string,Map<string,Uint8Array>>();
  const bitbucket = createFakeBitbucket({capabilities:syntheticCapabilities});
  let commits=0,pushes=0,authOpens=0;
  let mainGate:Promise<void>|null=null;
  let nativeAuth:{done:Promise<void>;entered():void}|null=null;
  const testing = {
    requireRestAuth:true, requireGitAuth:false, authCompletes:true,
    revoke(){input.own.role='viewer';input.own.policyState='revoked';},
    driftMain(){main.commit='d'.repeat(40);},
    holdMain(){let release!:()=>void;mainGate=new Promise<void>(resolve=>{release=resolve;});return()=>{mainGate=null;release();};},
    holdGitAuth(){let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;});nativeAuth={done:new Promise<void>(resolve=>{release=resolve;}),entered};return {waiting,complete(){nativeAuth=null;release();}};},
    counts:()=>({commits,pushes,creates:bitbucket.testing.creates,updates:bitbucket.testing.updates,authOpens}),
    provider:bitbucket, jobs:input.jobs, commands:input.commands,
  };
  input.accessPolicy.assertFreshPublishAllowed = async()=>{
    if(input.own.role==='viewer'||input.own.policyState!=='verified')throw new WorkbenchHttpError(403,'ACCESS_RECHECK_REQUIRED','Свежий допуск не подтверждён; пакет сохранён');
    return {...input.own};
  };
  const git:PublicationGitPort={async readMain(){await mainGate;return main;},async inspectRemote(branch){return remote.get(branch)??null;},async prepare(request){
    const revision=request.manifest.packageRevision,key=revision.packageId+':'+revision.revision;
    const old=prepared.get(key);if(old)return old;commits++;
    const candidate={packageRevision:revision,branch:`uor/${revision.curatorPersonId}/${revision.packageId}`,checkout:path.join(input.root,'synthetic-private-checkout'),commit:createHash('sha1').update(key+revision.contentHash).digest('hex'),expectedRemoteHead:request.expectedRemoteHead};prepared.set(key,candidate);
    candidateTrees.set(candidate.commit,new Map([...main.files,...(request.expectedRemoteHead?candidateTrees.get(request.expectedRemoteHead)??[]:[]),...syntheticProposalTree(request.manifest,request.files)]));return candidate;
  },async verifyPrepared(candidate){if((remote.get(candidate.branch)??null)!==candidate.expectedRemoteHead||candidate.packageRevision.baseCommit!==main.commit)throw new WorkbenchHttpError(409,'PREVIEW_STALE','Remote changed');},async readCandidate(candidate){await git.verifyPrepared(candidate);const files=candidateTrees.get(candidate.commit);if(!files)throw new WorkbenchHttpError(409,'PREVIEW_STALE','Missing candidate');return syntheticCandidateInput(candidate,main,files);}};
  const terminal:TerminalRunner={async runGitPush(request){await request.preTransferGate();if(testing.requireGitAuth)return {status:'auth_required',provider:'git'};
    if(nativeAuth){const auth=nativeAuth;request.onWaiting?.();auth.entered();await new Promise<void>(resolve=>{const cancelled=()=>resolve();request.signal.addEventListener('abort',cancelled,{once:true});void auth.done.then(()=>{request.signal.removeEventListener('abort',cancelled);resolve();});});if(request.signal.aborted)return {status:'cancelled',exitCode:null};await request.preTransferGate();}
    const candidate=[...prepared.values()].find(value=>value.commit===request.preparedCommit)!;pushes++;remote.set(candidate.branch,candidate.commit);return {status:'confirmed',exitCode:0,remoteCommit:candidate.commit};
  },async openAuth(){authOpens++;if(testing.authCompletes)testing.requireGitAuth=false;}};
  const create=bitbucket.createProposal.bind(bitbucket);
  bitbucket.createProposal=async request=>{if(testing.requireRestAuth)throw new WorkbenchHttpError(409,'PR_AUTH_REQUIRED','Требуется штатный вход Bitbucket');return create(request);};
  bitbucket.openAuth=async()=>{authOpens++;if(testing.authCompletes)testing.requireRestAuth=false;};
  const service=new PublishingService({...input,jobSink:input.jobs,git,terminal,bitbucket,artifacts:createPackageArtifactStore({artifactRoot:path.join(input.root,'synthetic-publishing-artifacts')}),publication:{mode:'demo-only',classifyRecord:()=>true}});
  registerPublishingCommands(input.commands,service);
  if(input.own.role!=='viewer') {
    const goal=input.repository.exportWorkspaceCore().find(row=>row.entityType==='core_goal_definition');
    if(!goal)throw Error('Publishing fixture requires a real synthetic goal');
    const context:CommandContext={repository:input.repository,clock:input.clock,requestId:fixtureId(360010),commandId:fixtureId(360011),installationId:fixtureId(1),ownAccess:input.own,actor:{hostname:'test-workbench-host',installationId:fixtureId(1),profilePersonId:input.own.personId}};
    const opened=await input.commands.execute({commandId:context.commandId,name:'draft.open',baseRevision:null,payload:{entityType:'core_goal_definition',ref:{entityType:'core_goal_definition',id:goal.value.id},packageId:null}},context);
    if(!('result'in opened))throw Error('Expected draft receipt');
    const entry=opened.result as {draftId:string};
    const definition=Object.fromEntries(Object.entries(goal.value).filter(([key])=>!['schemaVersion','id','revision','recordedAt','actor','publicationAnchorId'].includes(key)));
    const commandId=fixtureId(360012);
    await input.commands.execute({commandId,name:'goal.draft.save',baseRevision:opened.editToken,payload:{draftId:entry.draftId,definition:{...definition,description:'Пояснение к накопленному пакету'}}},{...context,commandId});
  }
  return {service,testing};
}
export type PublishingTesting=Awaited<ReturnType<typeof composePublishingScenario>>['testing'];

/** An accepted directory is a real first-launch prerequisite; no goal is fabricated. */
export function seedPublishingOrganization({repository,clock}:{repository:WorkbenchRepository;clock:Clock}):{refs:Record<string,VersionRef>;defaultContext:GlobalContext}{
 const input=makeNumericFixture({scope:{kind:'dit',id:fixtureId(100)}}),graph=makeEntityGraph(input);
 graph.entries=graph.entries.filter(row=>row.entityType==='directory_entity'||row.entityType==='directory_link');seedGraph(repository,graph);
 return {refs:{},defaultContext:{scopePath:{ditId:fixtureId(100),clusterId:null,productId:null,teamId:null},goalId:null,time:{kind:'as_of',date:clock.now().slice(0,10)},resultMode:'current',snapshotId:null}};
}
