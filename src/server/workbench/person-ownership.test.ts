import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { createCommandRegistry, type CommandContext } from './command-registry';
import { createJobStore } from './jobs';
import type { AccessPolicyService, OwnAccessProfile } from '../../features/identity/workbench-access-policy';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanup.splice(0))close();});
function fixture(){
 const repository=createWorkbenchRepository({filename:':memory:',artifactRoot:process.env.TEMP!}),clock={now:()=> '2026-10-28T10:00:00Z'},installationId=randomUUID(),a=randomUUID(),b=randomUUID();
 let personId:OwnAccessProfile['personId']=a;const access=():OwnAccessProfile=>({role:'curator',personId,displayName:'Synthetic',policyState:'verified',checkedAt:clock.now()});
 const policy:AccessPolicyService={resolveOwnAccess:async()=>access(),assertCommandAllowed:async()=>access(),assertFreshPublishAllowed:async()=>access()},jobs=createJobStore({repository,clock}),registry=createCommandRegistry({repository,jobs,accessPolicy:policy});cleanup.push(()=>repository.close());
 const context=(commandId:string):CommandContext=>({repository,clock,installationId,commandId,requestId:randomUUID(),ownAccess:access(),actor:{installationId,profilePersonId:personId,hostname:'synthetic'}});
 const request=(name:string,commandId=randomUUID(),payload:Record<string,unknown>={})=>({name,commandId,baseRevision:null,payload});
 return{repository,jobs,registry,context,request,a,b,setPerson:(id:OwnAccessProfile['personId'])=>{personId=id;},policy,clock,installationId};
}
it('person commands hide receipts and accepted jobs from a second person on the same installation',async()=>{
 const f=fixture();f.registry.register({name:'private.save',ownership:'person',inputSchema:z.strictObject({}),outputSchema:z.strictObject({private:z.string()}),capability:'personal.write',effect:'local',execution:'sync',handler:async()=>({result:{private:'own'},changedRefs:[],editToken:null})});
 const command=f.request('private.save');await f.registry.execute(command,f.context(command.commandId));f.setPerson(f.b);await expect(f.registry.execute(command,f.context(command.commandId))).rejects.toMatchObject({statusCode:404});
 f.setPerson(f.a);f.registry.register({name:'private.run',ownership:'person',inputSchema:z.strictObject({}),outputSchema:z.strictObject({ok:z.boolean()}),capability:'personal.write',effect:'local',execution:'async',handler:async()=>({result:{ok:true},changedRefs:[],editToken:null})});
 const run=f.request('private.run'),accepted=await f.registry.execute(run,f.context(run.commandId));await f.registry.idle();if(!('jobId'in accepted))throw Error('Expected job');
 f.setPerson(f.b);await expect(f.registry.execute(run,f.context(run.commandId))).rejects.toMatchObject({statusCode:404});expect(()=>f.registry.assertJobAccess!(accepted.jobId,f.context(randomUUID()))).toThrow();
 for(const name of ['job.cancel','job.retry','job.openAuth']){const control=f.request(name,randomUUID(),{jobId:accepted.jobId});await expect(f.registry.execute(control,f.context(control.commandId))).rejects.toMatchObject({statusCode:404});}
 f.setPerson(f.a);expect(()=>f.registry.assertJobAccess!(accepted.jobId,f.context(randomUUID()))).not.toThrow();
});
it('foreign person cannot join an inflight promise, while installation commands retain compatibility',async()=>{
 const f=fixture();let entered!:()=>void,release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
 f.registry.register({name:'private.inflight',ownership:'person',inputSchema:z.strictObject({}),outputSchema:z.strictObject({secret:z.string()}),capability:'personal.write',effect:'local',execution:'sync',handler:async()=>{entered();await gate;return{result:{secret:'person-a'},changedRefs:[],editToken:null};}});
 const command=f.request('private.inflight'),pending=f.registry.execute(command,f.context(command.commandId));await started;f.setPerson(f.b);await expect(f.registry.execute(command,f.context(command.commandId))).rejects.toMatchObject({statusCode:404});release();await pending;
 f.registry.register({name:'shared.save',inputSchema:z.strictObject({}),outputSchema:z.strictObject({ok:z.boolean()}),capability:'personal.write',effect:'local',execution:'sync',handler:async()=>({result:{ok:true},changedRefs:[],editToken:null})});const shared=f.request('shared.save');const first=await f.registry.execute(shared,f.context(shared.commandId));f.setPerson(f.a);expect(await f.registry.execute(shared,f.context(shared.commandId))).toEqual(first);
});

it('refuses to create a person command when the current identity has no person ID', async () => {
 const f=fixture();f.registry.register({name:'private.unassigned',ownership:'person',inputSchema:z.strictObject({}),outputSchema:z.strictObject({ok:z.boolean()}),capability:'personal.write',effect:'local',execution:'sync',handler:async()=>({result:{ok:true},changedRefs:[],editToken:null})});
 const command=f.request('private.unassigned');
 f.setPerson(null);
 await expect(f.registry.execute(command,f.context(command.commandId))).rejects.toMatchObject({statusCode:403});
});

it('preserves private ownership through a registry restart and lets the owner retry', async () => {
 const f=fixture();
 const descriptor={name:'private.retryable',ownership:'person' as const,inputSchema:z.strictObject({}),outputSchema:z.strictObject({ok:z.boolean()}),capability:'personal.write' as const,effect:'local' as const,execution:'async' as const,handler:async()=>{
   const active=f.jobs.findByCommand(command.commandId,f.installationId)!;
   f.jobs.update(active.jobId,{status:'waiting_user',stage:'git.auth'});
   throw Error('Waiting for user action');
 }};
 f.registry.register(descriptor);
 const command=f.request('private.retryable');
 const accepted=await f.registry.execute(command,f.context(command.commandId));
 if(!('jobId'in accepted))throw Error('Expected job');
 await f.registry.idle();
 expect(f.jobs.get(accepted.jobId,f.installationId)?.status).toBe('waiting_user');

 const restoredJobs=createJobStore({repository:f.repository,clock:f.clock});
 const restored=createCommandRegistry({repository:f.repository,jobs:restoredJobs,accessPolicy:f.policy});
 restored.register(descriptor);
 restoredJobs.registerControl(accepted.jobId,{retry:async()=>{restoredJobs.complete(accepted.jobId,{ok:true},[]);}});
 f.setPerson(f.b);
 expect(()=>restored.assertJobAccess!(accepted.jobId,f.context(randomUUID()))).toThrow();
 const retry=f.request('job.retry',randomUUID(),{jobId:accepted.jobId});
 await expect(restored.execute(retry,f.context(retry.commandId))).rejects.toMatchObject({statusCode:404});
 f.setPerson(f.a);
 const originalAuthorize=f.policy.assertCommandAllowed;
 f.policy.assertCommandAllowed=async name=>{
   if(name==='private.retryable') f.setPerson(f.b);
   return originalAuthorize(name);
 };
 const diverted=f.request('job.retry',randomUUID(),{jobId:accepted.jobId});
 await expect(restored.execute(diverted,f.context(diverted.commandId))).rejects.toMatchObject({statusCode:404});
 f.policy.assertCommandAllowed=originalAuthorize;
 f.setPerson(f.a);
 expect(await restored.execute(retry,f.context(retry.commandId))).toMatchObject({jobId:accepted.jobId});
 await restored.idle();
 expect(restoredJobs.get(accepted.jobId,f.installationId)).toMatchObject({status:'succeeded',result:{ok:true}});
 f.setPerson(f.b);
 await expect(restored.execute(retry,f.context(retry.commandId))).rejects.toMatchObject({statusCode:404});
});
