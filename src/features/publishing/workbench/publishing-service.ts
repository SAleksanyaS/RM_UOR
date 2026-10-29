import type { CommandContext } from '../../../server/workbench/command-registry';
import type { AccessPolicyService } from '../../identity/workbench-access-policy';
import { canUseCapability } from '../../identity/workbench-access-policy';
import type { JobStore, JobSink } from '../../../server/workbench/jobs';
import { createPackageStore } from './package-store';
import { assertPackagePreview, createPackagePreview, type PackagePreviewDependencies } from './package-preview';
import { fail } from './package-projection';
import type { PackagePreviewInput, PackagePreviewResult, PackageSubmitInput } from './contracts';

export type PublishingDependencies=PackagePreviewDependencies & {accessPolicy:AccessPolicyService;jobs:JobStore;jobSink:JobSink};
export class PublishingService {
  private readonly store;
  readonly readPort;
  constructor(private readonly deps:PublishingDependencies) {
    this.store=createPackageStore(deps.repository,deps.drafts); this.readPort=this.store.readPort;
    deps.jobs.registerStage('package.preview.check');
  }
  async preview(context:CommandContext,input:PackagePreviewInput):Promise<PackagePreviewResult> {
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
}
