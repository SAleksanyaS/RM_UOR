import { expect,it } from 'vitest';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { createCommandStore } from './command-store';
import { createJobStore } from './jobs';
import { captureLocalOperations, restoreLocalOperations } from './local-operation-handoff';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

it('preserves trusted current operation identity and receipt in the replacement database',()=>{
 const source=createWorkbenchRepository({filename:':memory:',artifactRoot:tmpdir()}),target=createWorkbenchRepository({filename:':memory:',artifactRoot:tmpdir()}),clock={now:()=> '2026-11-01T12:00:00Z'};
 try {
  const installation=randomUUID(),person=randomUUID(),commandId=randomUUID(),commands=createCommandStore(source),jobs=createJobStore({repository:source,clock});
  commands.begin({commandId,name:'backup.restore.apply',baseRevision:null,payload:{restoreToken:'trusted-local-token',confirmReplacement:true}},installation,{scope:'person',personId:person});
  const accepted=jobs.create(commandId,installation,'backup.restore.apply');commands.accept(installation,commandId,accepted);jobs.update(accepted.jobId,{status:'running',stage:'running'});jobs.checkpoint(accepted.jobId,{current:'retained'});
  const handoff=captureLocalOperations(source);restoreLocalOperations(target,handoff,clock);
  const restoredJobs=createJobStore({repository:target,clock}),restoredCommands=createCommandStore(target);
  expect(restoredJobs.get(accepted.jobId,installation)).toMatchObject({commandId,status:'running'});
  expect(restoredJobs.checkpoints(accepted.jobId,installation)).toEqual([{current:'retained'}]);
  expect(restoredCommands.assertAccess(installation,commandId,person)?.accepted_json).toBe(JSON.stringify(accepted));
  expect(()=>restoredCommands.assertAccess(installation,commandId,randomUUID())).toThrow();
  target.transaction(()=>{restoredCommands.receipt(installation,commandId,{result:{restored:true},changedRefs:[],editToken:null});restoredJobs.complete(accepted.jobId,{restored:true},[]);});
  expect(restoredJobs.get(accepted.jobId,installation)?.status).toBe('succeeded');
  expect(jobs.get(accepted.jobId,installation)?.status).toBe('running');
  expect(()=>restoreLocalOperations(target,handoff,clock)).toThrow(/empty/i);
 } finally {source.close();target.close();}
});
