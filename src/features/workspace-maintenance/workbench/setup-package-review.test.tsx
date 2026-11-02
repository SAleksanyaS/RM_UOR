// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { useSetupOperation } from './setup-package-operation';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { UpdateChannelService, createUpdateArchiveOwner, createUpdateNotificationProvider } from '../../system/workbench/update-channel';
import { createNotificationService } from '../../execution/workbench-notifications';
const fixture = vi.hoisted(() => ({ context: null as any }));
vi.mock('../../../app/workbench/context', () => ({ useWorkbench: () => fixture.context }));
afterEach(() => { cleanup(); sessionStorage.clear(); });
const owner = {installationId:'00000000-0000-4000-8000-000000000001',personId:'00000000-0000-4000-8000-000000000002'};
const now = '2026-11-02T10:00:00.000Z';
const provider = {async check(){return {channel:'code' as const,expectedCommit:'a'.repeat(40),targetCommit:'b'.repeat(40),available:true,launcherAvailable:true};}};
function database(){const root=mkdtempSync(path.join(os.tmpdir(),'task7-review-'));const repository=createWorkbenchRepository({filename:path.join(root,'db.sqlite'),artifactRoot:path.join(root,'files')});return {root,repository,close(){repository.close();rmSync(root,{recursive:true,force:true});}};}
it.each(['delayed','offline'])('retains the next active job when its readback is %s',async(mode)=>{
 let commands=0; const ids = new Map<string,string>();
 const client={command:vi.fn(async(request:any)=>{const jobId=++commands===1?'first-job':'second-job';ids.set(jobId,request.commandId);return{data:{jobId}};}),job:vi.fn(async(id:string)=>id==='first-job'?{data:{jobId:id,commandId:ids.get(id),status:'succeeded'}}:mode==='delayed'?new Promise(()=>{}):Promise.reject(Error('offline')))};
 fixture.context={client,session:{personId:owner.personId}};
 const h=renderHook(()=>useSetupOperation('review',async()=>{}));
 await act(()=>h.result.current.run('code.update.apply',{targetCommit:'b'.repeat(40)}));
 await waitFor(()=>expect(h.result.current.terminal).toBeTruthy());
 const oldDismiss=h.result.current.dismiss;
 act(()=>oldDismiss());
 await act(()=>h.result.current.run('code.update.apply',{targetCommit:'c'.repeat(40)}));
 expect(h.result.current.operation?.jobId).toBe('second-job');
 expect(h.result.current.terminal).toBeFalsy();
 expect(h.result.current.job).toBeNull();
 act(()=>oldDismiss());
 expect(h.result.current.operation?.jobId).toBe('second-job');
 act(()=>h.result.current.dismiss());
 expect(h.result.current.operation?.jobId).toBe('second-job');
 expect(h.result.current.blocked).toBe(true);
});
it('read before first pump suppresses a later unread update event',async()=>{
 const f=database();try{
 const channel=new UpdateChannelService({repository:f.repository,provider,now:()=>now});
 const notifications=createNotificationService({repository:f.repository,provider:createUpdateNotificationProvider(channel),preferences:()=>({notificationPersonId:null})});
 await channel.poll(owner,'manual',true);
 const notice=channel.list(owner)[0];channel.action(owner,{release:notice.release,revision:notice.revision,action:'read'});
 const context={installationId:owner.installationId,clock:{now:()=>now},ownAccess:{personId:owner.personId,role:'viewer' as const,displayName:null,policyState:'verified' as const,checkedAt:null}};
 await notifications.pump(context);
 expect(channel.list(owner)[0].readAt).toBe(now);
 expect(notifications.list(context)).toHaveLength(0);
 const restarted=new UpdateChannelService({repository:f.repository,provider,now:()=>now});
 await createNotificationService({repository:f.repository,provider:createUpdateNotificationProvider(restarted),preferences:()=>({notificationPersonId:null})}).pump(context);
 expect(notifications.list(context)).toHaveLength(0);
 }finally{f.close();}
});
it('unavailable identity produces no durable update history',async()=>{
 const f=database();try{
 const channel=new UpdateChannelService({repository:f.repository,provider:{async check(){throw Error('offline');}},now:()=>now});
 await channel.poll(owner,'startup',true);
 await channel.poll({...owner,personId:null},'periodic',true); // AccessPolicy unavailable/revoked
 await channel.poll(owner,'periodic',true); // access restored
 const codec=createUpdateArchiveOwner(f.repository,{installationId:owner.installationId,personId:()=>owner.personId,localPreview:false,subjectRoot:()=>f.root});
 const records=codec.exportRecords(f.repository);
 expect(records).toHaveLength(1);
 expect(()=>codec.authorize(records,owner.personId,owner.installationId)).not.toThrow();
 }finally{f.close();}
});
it('rejects a terminal snapshot belonging to another command and keeps recovery retained', async () => {
 const client={command:vi.fn(async()=>({data:{jobId:'current-job'}})),job:vi.fn(async()=>({data:{jobId:'current-job',commandId:'foreign-command',status:'succeeded'}}))};
 fixture.context={client,session:{personId:owner.personId}};
 const h=renderHook(()=>useSetupOperation('identity',async()=>{}));
 await act(()=>h.result.current.run('code.update.apply',{}));
 await waitFor(()=>expect(h.result.current.error).toContain('временно недоступен'));
 expect(h.result.current.job).toBeNull();expect(h.result.current.terminal).toBeFalsy();
 act(()=>h.result.current.dismiss());expect(h.result.current.operation?.jobId).toBe('current-job');
});
it('preserves read and snooze decisions across restart without generating duplicate unread events',async()=>{
 const f=database();try{
 let clock=now;
 const context={installationId:owner.installationId,clock:{now:()=>clock},ownAccess:{personId:owner.personId,role:'viewer' as const,displayName:null,policyState:'verified' as const,checkedAt:null}};
 let channel=new UpdateChannelService({repository:f.repository,provider,now:()=>clock});
 const notifications=()=>createNotificationService({repository:f.repository,provider:createUpdateNotificationProvider(channel),preferences:()=>({notificationPersonId:null})});
 await channel.poll(owner,'manual',true);
 let notice=channel.list(owner)[0];channel.action(owner,{release:notice.release,revision:notice.revision,action:'snooze'});
 await notifications().pump(context);expect(notifications().list(context)).toHaveLength(0);
 channel=new UpdateChannelService({repository:f.repository,provider,now:()=>clock});
 await notifications().pump(context);expect(notifications().list(context)).toHaveLength(0);
 notice=channel.list(owner)[0];channel.action(owner,{release:notice.release,revision:notice.revision,action:'unsnooze'});
 await notifications().pump(context);expect(notifications().list(context)).toHaveLength(1);
 notice=channel.list(owner)[0];channel.action(owner,{release:notice.release,revision:notice.revision,action:'read'});
 expect(notifications().list(context)[0].readAt).toBe(now);
 clock='2026-11-04T10:00:00.000Z';channel=new UpdateChannelService({repository:f.repository,provider,now:()=>clock});
 await channel.poll(owner,'startup',true);await notifications().pump(context);
 expect(notifications().list(context)).toHaveLength(1);expect(notifications().list(context)[0].readAt).toBe(now);
 }finally{f.close();}
});
