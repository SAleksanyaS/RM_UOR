import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkbenchRuntime } from '../../../server/workbench/bootstrap';
import { createWorkbenchApp } from '../../../server/workbench/app';
import type { WorkbenchRuntimeProviders } from '../../../server/workbench/runtime-contracts';
import type { OwnAccessProfile } from '../../identity/workbench-access-policy';
import { UpdateChannelService, createUpdateArchiveOwner } from '../../system/workbench/update-channel';
import { createNotificationStore } from '../../execution/workbench-notification-store';
import { createSubjectArchiveOwners } from './subject-archive-owners';
import JSZip from 'jszip';
import { buildCommonSetupPackage,setupHash } from './setup-package-builder';
const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse())
    await close(); });
async function runtime(providers: WorkbenchRuntimeProviders = {}) { const root = await mkdtemp(path.join(os.tmpdir(), 'uor-setup-http-')); closes.push(() => rm(root, { recursive: true, force: true })); await mkdir(path.join(root, 'config')); await writeFile(path.join(root, 'config/site.local.json'), JSON.stringify({ allowedWorkspaceRoots: [root] })); const runtime = await createWorkbenchRuntime({ projectRoot: root, codeRoot: process.cwd(), providers: { updates: { async check() { throw Error('offline fixture'); } }, ...providers } }); closes.push(runtime.close); const app = await createWorkbenchApp(runtime.deps); closes.push(() => app.close()); const session = await app.inject({ url: '/api/v1/session', headers: { host: 'localhost' } }); const headers = { host: 'localhost', origin: 'http://127.0.0.1:5173', cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().data.csrfToken }; return { runtime, app, headers, session: session.json().data, command: async (name: string, payload: unknown) => { const result = await app.inject({ method: 'POST', url: '/api/v1/commands', headers, payload: { commandId: randomUUID(), name, baseRevision: null, payload } }); if(result.statusCode===202){await runtime.deps.commands.idle();const job=runtime.deps.jobs.get(result.json().data.jobId,runtime.deps.installationId);expect(job?.status,JSON.stringify(job)).toBe('succeeded');return job!.result;} expect(result.statusCode, result.body.slice(0, 300)).toBe(200); return result.json().data.result; }, query: async (name: string) => { const result = await app.inject({ method: 'POST', url: '/api/v1/queries/' + name, headers, payload: { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } } }); expect(result.statusCode, result.body.slice(0, 300)).toBe(200); return result.json().data; } }; }
it('uses the real default runtime routes to install one portable package for two people with independent verified rescue archives', async () => {
    const packageValue = await buildCommonSetupPackage({ projectRoot: process.cwd(), selection: { materials: true, references: true, dashboards: true, reports: true, weeklyPrompts: true } });
    const reference=packageValue.records.find(r=>r.kind==='maturity-reference')!;(reference.value.teams as any[])[0].name='Reviewed setup team label';reference.sha256=setupHash(reference.value);const {sha256,...body}=packageValue;packageValue.sha256=setupHash(body);
    const a = await runtime(), b = await runtime();
    expect(a.session.personId).not.toBe(b.session.personId);
    expect(a.runtime.deps.installationId).not.toBe(b.runtime.deps.installationId);
    const archives: Buffer[] = [];
    for (const f of [a, b]) {
        const preview = await f.command('setup.preview', { package: packageValue });
        const applied = await f.command('setup.apply', { package: packageValue, previewDigest: preview.digest });
        expect(applied.rescueId).toBeTruthy();
        const backup = await f.app.inject({ url: '/api/v1/backups/' + applied.rescueId + '/file', headers: f.headers });
        expect(backup.statusCode).toBe(200);
        archives.push(backup.rawPayload);
        expect(backup.rawPayload.length).toBeGreaterThan(100);
        const installed = await f.query('setup.catalog');
        expect(installed.records).toHaveLength(6);expect((await f.query('maturity.overview')).teams[0].name).toBe('Reviewed setup team label');
        expect((await f.query('reports.recipes')).some((r: any) => r.template === 'goal-management-v1')).toBe(true);
        expect((await f.query('weekly.defaultPrompt')).version).toBe('weekly-analyst-critic-editor-v1');
        expect((await f.query('setup.dashboardPresets'))[0].value.title).toBe('Обзор целей');
    }
    const uploaded = await b.runtime.deps.files.stage({ installationId: b.runtime.deps.installationId, profilePersonId: b.session.personId, purpose: 'workspace-restore', name: 'foreign.zip', mediaType: 'application/zip', stream: (async function* () { yield archives[0]; })() });
    const response = await b.app.inject({ method: 'POST', url: '/api/v1/commands', headers: b.headers, payload: { commandId: randomUUID(), name: 'backup.restore.preview', baseRevision: null, payload: { fileHandle: uploaded.fileHandle } } });
    expect(response.statusCode).toBe(202);
    await b.runtime.deps.commands.idle();
    const job = b.runtime.deps.jobs.get(response.json().data.jobId, b.runtime.deps.installationId);
    expect(job?.status).toBe('failed');
    expect(job?.error?.code).toBe('ACCESS_DENIED');
    expect((await b.query('setup.catalog')).owner.personId).toBe(b.session.personId);
});

it('recovers backup, setup rescue and same-installation restore after admission loss with legacy unassigned update rows',async()=>{
 const personId=randomUUID();let access:OwnAccessProfile={personId,role:'viewer',displayName:null,policyState:'verified',checkedAt:null};let checks=0;
 const candidate={channel:'code' as const,expectedCommit:'a'.repeat(40),targetCommit:'b'.repeat(40),available:true,launcherAvailable:true};
 const provider={async check(){checks++;return candidate;}};
 const f=await runtime({updates:provider,accessPolicy:()=>({async resolveOwnAccess(){return access;},async assertCommandAllowed(){return access;},async assertFreshPublishAllowed(){return access;}})});
 await f.runtime.deps.notifications!.stop();
 const repository=f.runtime.deps.repository,installationId=f.runtime.deps.installationId,owner={installationId,personId};
 const channel=new UpdateChannelService({repository,provider});
 await channel.poll(owner,'startup',true);
 const context=()=>({installationId,clock:f.runtime.deps.clock,ownAccess:access});
 for(const policyState of ['unavailable','revoked'] as const){
   access={...access,personId:null,policyState};const before=checks;
   await channel.poll({...owner,personId:null},'periodic',true);
   await f.runtime.deps.queryPorts!.notifications.pump(context());expect(checks).toBe(before);
 }
 access={...access,personId,policyState:'verified'};
 // These exact rows model the pre-fix automatic writes. They remain unassigned.
 const unassigned={installationId,personId:null},key=JSON.stringify([installationId,null]);
 const notice={...channel.list(owner)[0],owner:unassigned};
 repository.sqlForModule('updates').run('INSERT INTO wb_updates_notices VALUES(?,?,?)',[key,notice.release,JSON.stringify(notice)]);
 repository.sqlForModule('updates').run('INSERT INTO wb_updates_status VALUES(?,?)',[key,JSON.stringify({...channel.status(owner),owner:unassigned})]);
 const cause=(await channel.causes(context()))[0];
 createNotificationStore({repository}).record({installationId,profilePersonId:null},'legacy-unassigned-update',{...cause,recipientPersonIds:[],localOwner:unassigned},'new',f.runtime.deps.clock.now());
 const env={installationId,personId:()=>personId,localPreview:false,subjectRoot:()=>''};
 const updateCodec=createUpdateArchiveOwner(repository,env),notificationCodec=createSubjectArchiveOwners(repository,env).find(v=>v.moduleId==='notifications')!;
 const beforeUpdates=updateCodec.exportRecords(repository),beforeNotifications=notificationCodec.exportRecords(repository);
 expect(()=>updateCodec.authorize(beforeUpdates,randomUUID(),installationId)).toThrow();
 expect(()=>updateCodec.authorize(beforeUpdates,personId,randomUUID())).toThrow();
 expect(()=>notificationCodec.authorize(beforeNotifications,personId,randomUUID())).toThrow();
 const backup=await f.command('backup.create',{label:'Recovered admission',includeOriginals:true});
 const download=await f.app.inject({url:'/api/v1/backups/'+backup.backupId+'/file',headers:f.headers});expect(download.statusCode).toBe(200);
 const archived=JSON.parse(await (await JSZip.loadAsync(download.rawPayload)).file('records.json')!.async('string'));
 expect(archived.filter((r:any)=>r.moduleId==='updates')).toEqual(beforeUpdates);
 expect(archived.filter((r:any)=>r.moduleId==='notifications')).toEqual(beforeNotifications);
 const packageValue=await buildCommonSetupPackage({projectRoot:process.cwd(),selection:{materials:false,references:false,dashboards:true,reports:true,weeklyPrompts:true}});
 const preview=await f.command('setup.preview',{package:packageValue});
 const applied=await f.command('setup.apply',{package:packageValue,previewDigest:preview.digest});expect(applied.rescueId).toBeTruthy();
 const rescue=await f.app.inject({url:'/api/v1/backups/'+applied.rescueId+'/file',headers:f.headers});expect(rescue.statusCode).toBe(200);
 const staged=await f.runtime.deps.files.stage({installationId,profilePersonId:personId,purpose:'workspace-restore',name:'own.zip',mediaType:'application/zip',stream:(async function*(){yield download.rawPayload;})()});
 const restore=await f.command('backup.restore.preview',{fileHandle:staged.fileHandle});
 await f.command('backup.restore.apply',{restoreToken:restore.restoreToken,confirmReplacement:true});
 expect(updateCodec.exportRecords(repository)).toEqual(beforeUpdates);
 expect(notificationCodec.exportRecords(repository)).toEqual(beforeNotifications);
 const renewed=await f.app.inject({url:'/api/v1/session',headers:{host:'localhost'}});f.headers.cookie=String(renewed.headers['set-cookie']).split(';')[0];f.headers['x-csrf-token']=renewed.json().data.csrfToken;
 const rebackup=await f.command('backup.create',{label:'After restore',includeOriginals:true});expect(rebackup.backupId).toBeTruthy();
 // A foreign personal notification and unrelated unassigned subscription remain closed.
 const store=createNotificationStore({repository});store.record({installationId,profilePersonId:randomUUID()},'foreign',{...cause,localOwner:{installationId,personId:randomUUID()}},'new',f.runtime.deps.clock.now());
 expect(()=>notificationCodec.authorize(notificationCodec.exportRecords(repository),personId,installationId)).toThrow();
 store.subscribe({installationId,profilePersonId:null},randomUUID(),true);
 expect(()=>notificationCodec.authorize(notificationCodec.exportRecords(repository).filter(r=>r.schemaId==='notifications.subscription'),personId,installationId)).toThrow();
});
