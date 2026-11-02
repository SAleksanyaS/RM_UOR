import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { createWorkbenchRepository, type WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createNativeUpdateProvider } from './update-provider';
import { UpdateChannelService, createUpdateNotificationProvider } from './update-channel';
import { createNotificationService } from '../../execution/workbench-notifications';
const roots: string[] = [], repos: WorkbenchRepository[] = [];
afterEach(() => { repos.splice(0).forEach(r => r.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
const owner = { installationId: '00000000-0000-4000-8000-000000000001', personId: '00000000-0000-4000-8000-000000000007' };
function repo(root: string) { const r = createWorkbenchRepository({ filename: path.join(root, 'store.sqlite'), artifactRoot: path.join(root, 'files') }); repos.push(r); return r; }
function git(cwd: string, args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim(); }
function fixture() { const root = mkdtempSync(path.join(os.tmpdir(), 'uor-update-channel-')); roots.push(root); const remote = path.join(root, 'origin.git'), publisher = path.join(root, 'publisher'), checkout = path.join(root, 'checkout'); git(root, ['init', '--bare', '--initial-branch=main', remote]); git(root, ['clone', remote, publisher]); git(publisher, ['config', 'user.email', 'fixture@example.invalid']); git(publisher, ['config', 'user.name', 'Fixture']); git(publisher, ['checkout', '-b', 'main']); writeFileSync(path.join(publisher, 'package.json'), '{}'); writeFileSync(path.join(publisher, 'package-lock.json'), '{}'); mkdirSync(path.join(publisher, 'config')); writeFileSync(path.join(publisher, 'config/update-protocol.json'), '{"schemaVersion":1,"bootstrap":1}'); git(publisher, ['add', '.']); git(publisher, ['commit', '-m', 'initial']); git(publisher, ['push', 'origin', 'main']); git(root, ['clone', '-b', 'main', remote, checkout]); writeFileSync(path.join(publisher, 'README.md'), 'new release'); git(publisher, ['add', '.']); git(publisher, ['commit', '-m', 'release']); git(publisher, ['push', 'origin', 'main']); return { root, remote, publisher, checkout, expected: git(checkout, ['rev-parse', 'HEAD']), target: git(publisher, ['rev-parse', 'HEAD']) }; }
it('discovers real bare Git new main and emits one durable owner notice without reminder settings', async () => {
    const f = fixture(), r = repo(f.root), provider = createNativeUpdateProvider({ projectRoot: f.checkout, config: { repositoryUrl: f.remote, publishedBranch: 'main' }, launcherAvailable: async () => true });
    const channel = new UpdateChannelService({ repository: r, provider, now: () => '2026-11-02T10:00:00.000Z', random: () => 0.5 });
    const context = { installationId: owner.installationId, ownAccess: { role: 'viewer' as const, displayName: null, personId: owner.personId, policyState: 'verified' as const, checkedAt: null }, clock: { now: () => '2026-11-02T10:00:00.000Z' } };
    let recipientPreference:string|null=null;
    const notices = createNotificationService({ repository: r, provider: createUpdateNotificationProvider(channel), preferences: () => ({ notificationPersonId: recipientPreference }) });
    await Promise.all([notices.pump(context), notices.pump(context)]);
    expect(channel.list(owner)[0]).toMatchObject({ release: f.target, state: 'available', candidate: { expectedCommit: f.expected, targetCommit: f.target } });
    expect(notices.list(context)).toHaveLength(1);
    recipientPreference='00000000-0000-4000-8000-000000000009';await notices.pump(context);expect(notices.list(context)).toHaveLength(1);
    const restarted = new UpdateChannelService({ repository: r, provider, now: () => '2026-11-02T10:00:00.000Z' });
    await restarted.poll(owner, 'startup', true);
    await notices.pump(context);
    expect(notices.list(context)).toHaveLength(1);
    const notice = channel.list(owner)[0];
    channel.action(owner, { release: notice.release, action: 'snooze', revision: notice.revision });
    expect(channel.list(owner)[0].snoozedUntil).not.toBeNull();
    expect(channel.list({ ...owner, personId: '00000000-0000-4000-8000-000000000002' })).toEqual([]);
    git(f.publisher, ['remote', 'set-url', 'origin', path.join(f.root, 'missing.git')]);
    git(f.checkout, ['remote', 'set-url', 'origin', path.join(f.root, 'missing.git')]);
    await restarted.poll(owner, 'online', true);
    expect(channel.status(owner).error).toBeTruthy();
    expect(channel.list(owner)[0].release).toBe(f.target);
});
it('retains unknown activation ownership and rejects local-preview activation before invoking the owner', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'uor-update-owner-'));
    roots.push(root);
    const service = new UpdateChannelService({ repository: repo(root), now: () => '2026-11-02T10:00:00.000Z', provider: { async check() { return { channel: 'code', expectedCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), available: true, launcherAvailable: true }; } } });
    await service.poll(owner, 'startup', true);
    await expect(service.activationInput(owner, 'b'.repeat(40), 'local_preview')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
});
it('takes the actual bare Git notice through the existing native activation owner and reconciles applied state', async () => {
    const { executeCodeUpdate } = await import('../../../../scripts/code-update-runtime.mjs');
    const f = fixture(), r = repo(f.root), config = { repositoryUrl: f.remote, publishedBranch: 'main' };
    const channel = new UpdateChannelService({ repository: r, provider: createNativeUpdateProvider({ projectRoot: f.checkout, config, launcherAvailable: async () => true }), now: () => '2026-11-02T10:00:00.000Z' });
    await channel.poll(owner, 'startup', true);
    const ticket = await channel.activationInput(owner, f.target, 'verified');
    let active = true, stopped = 0;
    const phases: string[] = [];
    const options = { async quiesce() { if (active)
            throw Error('BROWSER_ACTIVE'); }, async stop() { stopped++; }, async start(mode?: string) { phases.push(mode ?? 'ordinary'); }, async ready() { return true; }, async activate() { phases.push('activation'); } };
    await expect(executeCodeUpdate(f.checkout, config, ticket, options)).rejects.toThrow('BROWSER_ACTIVE');
    expect(git(f.checkout, ['rev-parse', 'HEAD'])).toBe(f.expected);
    expect(stopped).toBe(0);
    active = false;
    const result = await executeCodeUpdate(f.checkout, config, ticket, options);
    expect(result).toMatchObject({ currentCommit: f.target, rolledBack: false });
    expect(phases).toEqual(['candidate', 'activation']);
    await channel.poll(owner, 'resume', true);
    expect(channel.list(owner)[0].state).toBe('applied');
    expect(git(f.checkout, ['rev-parse', 'HEAD'])).toBe(f.target);
});
it('detects moved accepted main during preparation and leaves active code untouched', async () => {
    const { executeCodeUpdate } = await import('../../../../scripts/code-update-runtime.mjs');
    const f = fixture();
    let paused = false;
    await expect(executeCodeUpdate(f.checkout, { repositoryUrl: f.remote, publishedBranch: 'main' }, { expectedCommit: f.expected, targetCommit: f.target }, { async install() { writeFileSync(path.join(f.publisher, 'README.md'), 'newer accepted release'); git(f.publisher, ['add', '.']); git(f.publisher, ['commit', '-m', 'newer']); git(f.publisher, ['push', 'origin', 'main']); }, async quiesce() { paused = true; } })).rejects.toMatchObject({ code: 'stale_remote' });
    expect(paused).toBe(false);
    expect(git(f.checkout, ['rev-parse', 'HEAD'])).toBe(f.expected);
});

it('honors configured durable backoff, preserves read state, and keeps imported personal update history portable',async()=>{
 const {createUpdateArchiveOwner}=await import('./update-channel');let now='2026-11-02T10:00:00.000Z',checks=0,offline=true;const root=mkdtempSync(path.join(os.tmpdir(),'uor-update-backoff-'));roots.push(root);const r=repo(root),person='00000000-0000-4000-8000-000000000005',o={...owner,personId:person};
 const provider={async check(){checks++;if(offline)throw Error('network unavailable');return{channel:'code' as const,expectedCommit:'a'.repeat(40),targetCommit:'b'.repeat(40),available:true,launcherAvailable:true};}};
 const service=new UpdateChannelService({repository:r,provider,now:()=>now,pollIntervalMs:1000,maxBackoffMs:4000,jitterRatio:0});await service.poll(o);expect(service.status(o).nextCheckAt).toBe('2026-11-02T10:00:02.000Z');await service.poll(o);expect(checks).toBe(1);now='2026-11-02T10:00:02.000Z';await service.poll(o);expect(service.status(o).nextCheckAt).toBe('2026-11-02T10:00:06.000Z');offline=false;await service.poll(o,'online',true);const n=service.list(o)[0];service.action(o,{release:n.release,revision:n.revision,action:'read'});expect(service.list(o)[0].readAt).toBe(now);
 const otherRoot=mkdtempSync(path.join(os.tmpdir(),'uor-update-restored-'));roots.push(otherRoot);const other=repo(otherRoot),installation='00000000-0000-4000-8000-000000000006';const env=(installationId:string)=>({installationId,personId:()=>person,localPreview:true,subjectRoot:()=>root});const source=createUpdateArchiveOwner(r,env(o.installationId)),target=createUpdateArchiveOwner(other,env(installation)),records=source.exportRecords(r);target.restoreRecords(other,records,{installationId:installation,personId:person,files:new Map(),stagedRoot:otherRoot,subjectPath:()=>{throw Error('No files');}});expect(target.exportRecords(other)).toEqual(records);
});
