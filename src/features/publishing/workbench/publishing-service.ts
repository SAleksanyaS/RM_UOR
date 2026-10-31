import type { CommandContext } from '../../../server/workbench/command-registry';
import type { AccessPolicyService } from '../../identity/workbench-access-policy';
import { canUseCapability } from '../../identity/workbench-access-policy';
import type { JobStore, JobSink } from '../../../server/workbench/jobs';
import { createPackageStore } from './package-store';
import { assertPackagePreview, createPackagePreview, type PackagePreviewDependencies } from './package-preview';
import { fail } from './package-projection';
import { packageSubmitResultSchema,proposalSnapshotSchema,proposalCommentSchema,bitbucketCapabilitiesSchema,type PackagePreviewInput,type PackagePreviewResult,type PackageSubmitInput,type PackageSubmitResult,type PackageStatusResult,type PublicationPackageRecord } from './contracts';
import { WorkbenchHttpError,type Problem } from '../../../server/workbench/protocol';
import { commitCommandEffect,withCommandExecution } from '../../../server/workbench/command-store';
import { buildPackageManifest } from './package-manifest';
import { createUnavailableBitbucketPort,type BitbucketPort } from './bitbucket-port';
import { reconcileProposal } from './proposal-reconciliation';
import type { PublicationGitPort,PreparedProposal } from './git-port';
import type { TerminalRunner,TerminalRunResult } from './terminal-runner';
import { createPreTransferGate } from './pre-transfer-gate';

export type PublishingDependencies=PackagePreviewDependencies & {accessPolicy:AccessPolicyService;jobs:JobStore;jobSink:JobSink;bitbucket?:BitbucketPort;terminal?:TerminalRunner};
export class PublishingService {
  private readonly store;
  readonly readPort;
  constructor(private readonly deps:PublishingDependencies) {
    this.store=createPackageStore(deps.repository,deps.drafts); this.readPort=this.store.readPort;
    deps.jobs.registerStage('package.preview.check');
    for(const stage of ['package.prepare','package.push','git.auth','pr.write','pr.status','PR.auth']) deps.jobs.registerStage(stage);
  }
  async preview(context:CommandContext,input:PackagePreviewInput):Promise<PackagePreviewResult> {
    const previous=this.readPort.readOwnPackage(context,input.packageId);if(previous&&['merged','declined'].includes(previous.state)) return fail('PACKAGE_CLOSED',409);
    const job=this.deps.jobs.findByCommand(context.commandId,context.installationId);
    if(!job) return fail('COMMAND_JOB_MISSING',409);
    const cancellation=new AbortController();
    const wait=<T>(promise:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
      const cancel=()=>{reject(new Error('Preview cancelled'));};
      if(cancellation.signal.aborted) {promise.catch(()=>undefined);cancel();return;}
      cancellation.signal.addEventListener('abort',cancel,{once:true});
      promise.then(value=>{cancellation.signal.removeEventListener('abort',cancel);resolve(value);},error=>{cancellation.signal.removeEventListener('abort',cancel);reject(error);});
    });
    this.deps.jobs.registerControl(job.jobId,{async cancel(){cancellation.abort();}});
    this.deps.jobs.update(job.jobId,{cancelAvailable:true});
    const person=context.actor.profilePersonId;
    const recheck=async()=>{
      const fresh=await wait(this.deps.accessPolicy.assertCommandAllowed('package.preview'));
      if(fresh.personId!==person) return fail('COMMAND_CONTEXT_MISMATCH',409);
      if(!canUseCapability(fresh,'uor.prepare')) return fail('COMMAND_FORBIDDEN',403);
      if(cancellation.signal.aborted || ['cancelled','interrupted','failed'].includes(this.deps.jobs.get(job.jobId,context.installationId)?.status??'failed')) return fail('OPERATION_CANCELLED',409);
      context.ownAccess=fresh;
      const pkg=this.readPort.readOwnPackage(context,input.packageId);if(pkg&&['merged','declined'].includes(pkg.state)) return fail('PACKAGE_CLOSED',409);
    };
    await recheck();
    this.deps.jobSink.stage(job.jobId,'package.preview.check',{completed:0,total:null,unit:'checks'});
    return createPackagePreview(context,input,{...this.deps,store:this.store,recheck,wait});
  }
  assertPreview(context:CommandContext,input:PackageSubmitInput) {
    const person=context.actor.profilePersonId;
    const recheck=async()=>{
      const fresh=await this.deps.accessPolicy.assertCommandAllowed('package.preview');
      if(fresh.personId!==person) return fail('COMMAND_CONTEXT_MISMATCH',409);
      if(!canUseCapability(fresh,'uor.prepare')) return fail('COMMAND_FORBIDDEN',403);
      context.ownAccess=fresh;
    };
    return assertPackagePreview(context,input,{...this.deps,store:this.store,recheck});
  }
  private own(context:CommandContext,packageId:string):PublicationPackageRecord {
    if(context.repository!==this.deps.repository||context.actor.installationId!==context.installationId||!context.actor.profilePersonId||context.actor.profilePersonId!==context.ownAccess.personId||!canUseCapability(context.ownAccess,'uor.prepare')) return fail('COMMAND_FORBIDDEN',403);
    this.deps.drafts.readOwnPackage(context,packageId);const pkg=this.readPort.readOwnPackage(context,packageId);if(!pkg) return fail('PACKAGE_NOT_FOUND',404);return pkg;
  }
  async submit(context:CommandContext,input:PackageSubmitInput):Promise<PackageSubmitResult> {
    const initial=this.own(context,input.packageId);if(['merged','declined'].includes(initial.state)) return fail('PACKAGE_CLOSED',409);
    const job=this.deps.jobs.findByCommand(context.commandId,context.installationId);if(!job) return fail('COMMAND_JOB_MISSING',409);
    const git=this.deps.git as PublicationGitPort,bitbucket=this.deps.bitbucket??createUnavailableBitbucketPort(),terminal=this.deps.terminal;
    const capabilities=bitbucketCapabilitiesSchema.parse(await bitbucket.capabilities());
    if(!capabilities.nativePullRequests||!capabilities.findByPackageMarker||!capabilities.terminalAuthProfileId||!terminal||typeof git.prepare!=='function'||typeof git.inspectRemote!=='function'||typeof git.verifyPrepared!=='function') return fail('BITBUCKET_NOT_READY',503);
    const cancellation=new AbortController();
    let nativeFlight:Promise<TerminalRunResult>|null=null,currentCandidate:PreparedProposal|null=null,cancelPending=false;
    const previousIntent=this.deps.jobs.checkpoints(job.jobId,context.installationId).filter(value=>value.stage==='git.push.intent').at(-1);
    if(typeof previousIntent?.preparedCommit==='string') currentCandidate=this.store.preparationByCommit(context,input.packageId,previousIntent.preparedCommit);
    else if(initial.current) currentCandidate=this.store.preparation(context,initial.current);
    let finishCancellation!:()=>void;const cancellationDecision=new Promise<void>(resolve=>{finishCancellation=resolve;});
    const waitForCancellation=async()=>{if(cancelPending){await cancellationDecision;return fail('OPERATION_CANCELLED',409);}};
    const active=()=>{if(cancellation.signal.aborted||['cancelled','failed','interrupted'].includes(this.deps.jobs.get(job.jobId,context.installationId)?.status??'failed')) return fail('OPERATION_CANCELLED',409);this.own(context,input.packageId);};
    const pending=(code:string,provider:'git'|'bitbucket')=>{
      const auth=code==='GIT_AUTH_REQUIRED'||code==='PR_AUTH_REQUIRED';
      const opener=provider==='git'?terminal.openAuth:bitbucket.openAuth;
      if(auth&&opener) this.deps.jobs.registerControl(job.jobId,{openAuth:async()=>{
        const fresh=await this.deps.accessPolicy.assertCommandAllowed('package.submit');
        if(fresh.personId!==context.actor.profilePersonId||!canUseCapability(fresh,'package.submit')) return fail('COMMAND_FORBIDDEN',403);
        context.ownAccess=fresh;active();
        if(provider==='git') {if(!currentCandidate) return fail('PREVIEW_STALE',409);await terminal.openAuth!({cwd:currentCandidate.checkout,signal:cancellation.signal});}
        else await bitbucket.openAuth!({signal:cancellation.signal});
      }});
      this.deps.jobs.update(job.jobId,{status:auth?'waiting_user':'retry_wait',retryAvailable:true,stage:auth?(provider==='git'?'git.auth':'PR.auth'):(provider==='git'?'package.push':'pr.write'),warnings:[{code,message:code,retryable:true,details:[],operationId:job.jobId,provider}],nextAction:{commandName:auth?'job.openAuth':'job.retry',payload:{jobId:job.jobId},route:null,label:auth?'Открыть штатный вход':'Сверить и повторить',enabled:!auth||!!opener,disabledReason:auth&&!opener?'NATIVE_AUTH_UNAVAILABLE':null}});
      return fail(code,409);
    };
    let pushMayHaveOccurred=false,proposalConfirmed=false;
    this.deps.jobs.registerControl(job.jobId,{openAuth:undefined,cancel:async()=>{
      if(cancelPending){await cancellationDecision;if(this.deps.jobs.get(job.jobId,context.installationId)?.status!=='cancelled') return fail('REMOTE_STATE_UNKNOWN',409);return;}
      cancelPending=true;cancellation.abort();
      try {
        if(currentCandidate) {
          const outcome=nativeFlight?await nativeFlight.catch(()=>null):null;
          let observed:string|null|undefined;try{observed=await git.inspectRemote(currentCandidate.branch);}catch{observed=undefined;}
          if(observed===currentCandidate.commit||observed===undefined||nativeFlight&&(!outcome||!['cancelled','auth_required'].includes(outcome.status))||!nativeFlight&&previousIntent) {
            if(observed===currentCandidate.commit) this.deps.jobs.markIrreversible(job.jobId);
            return pending('REMOTE_STATE_UNKNOWN','git');
          }
        } else if(previousIntent) return pending('REMOTE_STATE_UNKNOWN','git');
        this.deps.jobs.update(job.jobId,{status:'cancelled',stage:'cancelled',result:null,error:null});
      } finally {finishCancellation();}
    },retry:()=>withCommandExecution(context,packageSubmitResultSchema,async()=>{const result=await this.submit(context,input);this.deps.jobs.complete(job.jobId,result,[]);})});
    this.deps.jobs.update(job.jobId,{retryAvailable:false});
    try {
      const preview=await this.assertPreview(context,input);active();const revision=preview.packageRevision;
      const files=await this.deps.artifacts.readRevision(revision);active();
      let prepared=this.store.preparation(context,revision);
      if(!prepared) {
        this.deps.jobSink.stage(job.jobId,'package.prepare',{completed:0,total:null,unit:'steps'});
        const branch=`uor/${revision.curatorPersonId}/${revision.packageId}`,expectedRemoteHead=await git.inspectRemote(branch);active();
        const {contentHash:_hash,...base}=revision;prepared=await git.prepare({manifest:buildPackageManifest({package:base,files}),files,expectedRemoteHead});active();
        await this.assertPreview(context,input);active();this.deps.repository.transaction(()=>this.store.savePreparation(context,prepared!));
      }
      const candidate=prepared;currentCandidate=candidate;
      const preTransfer=createPreTransferGate(context,candidate,{accessPolicy:this.deps.accessPolicy,git,artifacts:this.deps.artifacts,operationId:job.jobId,assertPreview:async()=>{active();await this.assertPreview(context,input);active();}});
      const gate=async(afterPush:boolean)=>{
        if(!afterPush){active();await preTransfer();active();return context.ownAccess;}
        active();await this.assertPreview(context,input);active();await this.deps.artifacts.readRevision(revision);active();
        if(afterPush) {if(await git.inspectRemote(candidate.branch)!==candidate.commit) return fail('PREVIEW_STALE',409);} else await git.verifyPrepared(candidate);
        active();const fresh=await this.deps.accessPolicy.assertFreshPublishAllowed(job.jobId);active();if(fresh.personId!==revision.curatorPersonId||!canUseCapability(fresh,'package.submit')) return fail('ACCESS_DENIED',403);context.ownAccess=fresh;return fresh;
      };
      let remote=await git.inspectRemote(candidate.branch);active();
      this.deps.repository.transaction(()=>this.store.transition(context,input.packageId,{state:'publishing'}));
      if(remote!==candidate.commit) {
        if(remote!==candidate.expectedRemoteHead) return fail('PREVIEW_STALE',409);await gate(false);
        this.deps.jobSink.stage(job.jobId,'package.push',{completed:0,total:null,unit:'steps'});
        this.deps.jobSink.checkpoint(job.jobId,{stage:'git.push.intent',packageId:revision.packageId,revision:revision.revision,preparedCommit:candidate.commit,intentAt:context.clock.now()});
        pushMayHaveOccurred=true;
        nativeFlight=terminal.runGitPush({cwd:candidate.checkout,args:['push','origin',candidate.commit+':refs/heads/'+candidate.branch],preparedCommit:candidate.commit,preTransferGate:async()=>{await gate(false);},signal:cancellation.signal,onWaiting:()=>{if(!cancelPending)this.deps.jobs.update(job.jobId,{status:'waiting_user',stage:'git.auth',retryAvailable:false,warnings:[{code:'GIT_AUTH_REQUIRED',message:'GIT_AUTH_REQUIRED',retryable:true,details:[],operationId:job.jobId,provider:'git'}],nextAction:null});}});
        const pushed=await nativeFlight;await waitForCancellation();
        this.deps.jobs.update(job.jobId,{status:'running',stage:'package.push',warnings:[],nextAction:null});
        active();remote=await git.inspectRemote(candidate.branch);active();
        if(pushed.status==='auth_required') return pending(pushed.provider==='git'?'GIT_AUTH_REQUIRED':'PR_AUTH_REQUIRED',pushed.provider);
        if(pushed.status==='cancelled') return fail('OPERATION_CANCELLED',409);
        if(remote!==candidate.commit) return pending('REMOTE_STATE_UNKNOWN','git');
        this.deps.jobSink.checkpoint(job.jobId,{stage:'git.push.confirmed',packageId:revision.packageId,preparedCommit:candidate.commit});
      }
      this.deps.jobs.markIrreversible(job.jobId);active();await gate(true);
      this.deps.jobSink.stage(job.jobId,'pr.write',{completed:0,total:null,unit:'steps'});
      pushMayHaveOccurred=false;
      const snapshot=await reconcileProposal(context,{packageRevision:revision,branch:candidate.branch,proposalCommit:candidate.commit,summary:`Пакет УОР ${revision.packageId}, редакция ${revision.revision}`,marker:`uor-package:${revision.packageId}`},{repository:this.deps.repository,repositoryId:(await git.readMain()).repositoryId,proposal:this.own(context,input.packageId).proposal,jobs:this.deps.jobs,bitbucket,accessPolicy:{...this.deps.accessPolicy,assertFreshPublishAllowed:()=>gate(true)}});
      proposalConfirmed=true;
      if(snapshot.state==='needs_rework') {this.deps.repository.transaction(()=>this.store.transition(context,input.packageId,{state:'needs_rework',sent:revision,proposal:snapshot.link}));return fail('PROPOSAL_NEEDS_REWORK',409);}
      active();await this.assertPreview(context,input);active();
      const result:PackageSubmitResult={packageRevision:revision,preparedCommit:candidate.commit,proposal:snapshot.link,state:'open_pr'};
      return commitCommandEffect(context,()=>({result,changedRefs:[this.store.transition(context,input.packageId,{state:'open_pr',sent:revision,proposal:snapshot.link})],editToken:null})).result;
    } catch(error) {
      await waitForCancellation();
      const state=this.deps.jobs.get(job.jobId,context.installationId);
      if(state?.status==='waiting_user'&&state.stage==='git.auth'&&!state.nextAction) this.deps.jobs.update(job.jobId,{status:'running',stage:'package.push',warnings:[],nextAction:null});
      if(['retry_wait','waiting_user','cancelled'].includes(this.deps.jobs.get(job.jobId,context.installationId)?.status??'')) throw error;
      if(pushMayHaveOccurred&&!(error instanceof WorkbenchHttpError&&['PREVIEW_STALE','ACCESS_DENIED','COMMAND_FORBIDDEN','OPERATION_CANCELLED'].includes(error.code))) return pending('REMOTE_STATE_UNKNOWN','git');
      if(!proposalConfirmed&&error instanceof WorkbenchHttpError&&['REMOTE_STATE_UNKNOWN','PR_AUTH_REQUIRED'].includes(error.code)) return pending(error.code,'bitbucket');throw error;
    }
  }
  async refreshStatus(context:CommandContext,packageId:string):Promise<PackageStatusResult> {
    let pkg=this.own(context,packageId);const owner=context.actor.profilePersonId,bitbucket=this.deps.bitbucket??createUnavailableBitbucketPort();const warnings:Problem[]=[];
    const job=this.deps.jobs.findByCommand(context.commandId,context.installationId);if(!job) return fail('COMMAND_JOB_MISSING',409);
    this.deps.jobSink.stage(job.jobId,'pr.status',{completed:0,total:null,unit:'steps'});let comments:PackageStatusResult['comments']=[];
    const warn=(code:string)=>warnings.push({code,message:code,retryable:true,details:[],operationId:job.jobId,provider:'bitbucket'});
    const recheck=async()=>{const fresh=await this.deps.accessPolicy.assertCommandAllowed('package.refreshStatus');if(fresh.personId!==owner||!canUseCapability(fresh,'uor.prepare')) return fail('COMMAND_FORBIDDEN',403);context.ownAccess=fresh;pkg=this.own(context,packageId);};
    let observed:PublicationPackageRecord['state']|null=null,observedSent:PublicationPackageRecord['sent']=null,observedLink=pkg.proposal;
    if(pkg.proposal||this.store.hasPreparation(context,packageId)) {
      try {
        const capabilities=bitbucketCapabilitiesSchema.parse(await bitbucket.capabilities());await recheck();
        const found=pkg.proposal?await bitbucket.readProposal(pkg.proposal):capabilities.findByPackageMarker?await bitbucket.findProposal(packageId):null;await recheck();
        if(!found) warn('REMOTE_STATE_UNKNOWN');
        else {
          const snapshot=proposalSnapshotSchema.parse(found),sent=this.store.preparationByCommit(context,packageId,snapshot.sourceCommit);
          const expectedRepository=pkg.proposal?.repositoryId??(await this.deps.git.readMain()).repositoryId;await recheck();
          const trustedIdentity=snapshot.packageId===packageId&&snapshot.link.repositoryId===expectedRepository&&(!pkg.proposal||JSON.stringify(snapshot.link)===JSON.stringify(pkg.proposal));
          if(!trustedIdentity||!sent||snapshot.state==='unknown'||['merged','declined'].includes(pkg.state)&&snapshot.state!==pkg.state) warn('REMOTE_STATE_UNKNOWN');
          else if(snapshot.state==='needs_rework'&&!capabilities.explicitReworkState) warn('REMOTE_STATE_UNKNOWN');
          else {observed=snapshot.state==='open'?'open_pr':snapshot.state;observedSent=sent.packageRevision;observedLink=snapshot.link;}
          if(trustedIdentity&&capabilities.readComments) {comments=(await bitbucket.readComments(snapshot.link)).map(value=>proposalCommentSchema.parse(value));await recheck();} else if(trustedIdentity) warn('COMMENTS_UNSUPPORTED');
        }
      } catch(error) {if(error instanceof WorkbenchHttpError&&['COMMAND_FORBIDDEN','COMMAND_CONTEXT_MISMATCH'].includes(error.code)) throw error;warn('REMOTE_STATE_UNKNOWN');}
    }
    await recheck();
    const result:PackageStatusResult={packageId,state:observed??pkg.state,proposal:observed?observedLink:pkg.proposal,comments,anchor:this.deps.repository.readPublicationAnchor({entityType:'publication_anchor',id:packageId}),warnings};
    return commitCommandEffect(context,()=>({result,changedRefs:observed&&(observed!==pkg.state||!pkg.proposal||pkg.sent?.revision!==observedSent?.revision)?[this.store.transition(context,packageId,{state:observed,proposal:observedLink,sent:observedSent})]:[],editToken:null})).result;
  }
}
