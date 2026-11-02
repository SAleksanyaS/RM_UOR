import { browserPolicyCdpFixture, browserPolicyPageFixture } from '../../../tests/fixtures/workbench/browser-policy-cdp';
import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink,readFile,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterEach, expect, it,vi } from 'vitest';
import { privateProfileSchema } from './contracts';
import { createBrowserRuntime, type BrowserOwner } from './workbench-browser-runtime';
import * as browser from './browser';
import { makeHeader, fixtureId } from '../../../tests/fixtures/workbench/factories';

const owner: BrowserOwner = { installationId: '00000000-0000-4000-8000-000000000001', profilePersonId: null };
const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], timeoutMs: 1000, browser: { channel: 'fixture', profileDirectory: 'own' } });
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks();for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fakeContext(ready = false) {
  let closed = false;
  const events = new EventEmitter(); const page = browserPolicyPageFixture({ goto: async () => {}, url: () => 'https://report.example.invalid/report', isClosed: () => closed, locator: () => ({ isVisible: async () => ready, count: async () => 1, evaluateAll: async () => false, waitFor: async () => {} }) });
  return Object.assign(events, { setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {}, pages: () => closed ? [] : [page], newCDPSession: async () => browserPolicyCdpFixture(), setOffline: async () => {}, addInitScript: async () => {}, exposeBinding: async () => {},
    route: async () => {}, routeWebSocket: async () => {}, close: async () => { if (!closed) { closed = true; events.emit('close'); } } }) as unknown as BrowserContext;
}
it('isolates managed owner profiles and releases a cancelled waiter without overlap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-browser-runtime-')); roots.push(root);
  const launched: string[] = []; let active = 0, maximum = 0;
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { launchPersistent: async (_profile, folder) => {
    launched.push(folder); active++; maximum = Math.max(maximum, active); const context = fakeContext(); context.once('close', () => active--); return context;
  } } });
  const input = { owner, profile, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#report' };
  const first = await runtime.openLogin(input, new AbortController().signal);
  const cancellation = new AbortController(); const second = runtime.openLogin(input, cancellation.signal); cancellation.abort();
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  await expect(runtime.finish({ handleId: first.handleId, owner: { ...owner, profilePersonId: '00000000-0000-4000-8000-000000000002' }, save: false })).rejects.toMatchObject({ statusCode: 404 });
  await runtime.closeOwned(owner);
  const third = await runtime.openLogin(input, new AbortController().signal);
  expect(third.state).toBe('open'); expect(maximum).toBe(1);
  expect(launched[0]).toContain('browser-profiles'); expect(launched[0]).toContain(owner.installationId);
  await runtime.closeOwned(owner);
});
it('consumes only an exact own preparation once and preserves the active recording on rejected reuse', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-browser-prepared-')); roots.push(root);
  let launches = 0; const context = fakeContext(true);
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { async launchPersistent() { launches++; return context; } } });
  const input = { owner, profile, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready', preparationId: fixtureId(9020), preparationRevision: 'exact-source-revision' };
  try {
    const login = await runtime.openLogin(input, new AbortController().signal);
    await runtime.prepareLogin!({ ...input, loginHandleId: login.handleId });
    await expect(runtime.prepareLogin!({ ...input, loginHandleId: login.handleId })).rejects.toMatchObject({ code: 'BROWSER_HANDLE_NOT_FOUND' });
    for (const mismatch of [{ owner: { ...owner, installationId: fixtureId(9021) } }, { preparationId: fixtureId(9022) }]) {
      await expect(runtime.startRecording({ ...input, ...mismatch }, new AbortController().signal)).rejects.toMatchObject({ code: 'manual_login_required' });
    }
    for (const mismatch of [{ profile: { ...profile, maxBytes: profile.maxBytes - 1 } }, { startUrl: 'https://report.example.invalid/changed' }, { authenticatedSelector: '#changed' }, { preparationRevision: 'changed-source-revision' }]) {
      await expect(runtime.startRecording({ ...input, ...mismatch }, new AbortController().signal)).rejects.toMatchObject({ code: 'BROWSER_CONTEXT_MISMATCH' });
      expect(await runtime.readPreparation!(input)).toMatchObject({ state: 'ready' });
    }
    const recording = await runtime.startRecording(input, new AbortController().signal);
    expect(recording.handleId).not.toBe(login.handleId); expect(launches).toBe(1);
    await expect(runtime.startRecording({ ...input, allowFreshContext: true }, new AbortController().signal)).rejects.toMatchObject({ code: 'manual_login_required' });
    expect(await runtime.readRecordingStatus({ owner, handleId: recording.handleId })).toEqual({ state: 'recording', problem: null });
    expect(context.pages()).toHaveLength(1); expect(launches).toBe(1);
  } finally { await runtime.shutdown(); }
});
it.each(['closed', 'expired'] as const)('a %s preparation requires deliberate login even for a legacy fresh-profile caller', async state => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-browser-prepared-')); roots.push(root);
  let launches = 0; const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { async launchPersistent() { launches++; return fakeContext(true); } } });
  const input = { owner, profile, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready', preparationId: fixtureId(9030) };
  try {
    const login = await runtime.openLogin(input, new AbortController().signal);
    await runtime.prepareLogin!({ ...input, loginHandleId: login.handleId });
    if (state === 'closed') await runtime.closeOwned(owner);
    else vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    expect(await runtime.readPreparation!(input)).toEqual({ state: 'missing', expiresAt: null });
    await expect(runtime.startRecording({ ...input, allowFreshContext: true }, new AbortController().signal)).rejects.toMatchObject({ code: 'manual_login_required' });
    expect(launches).toBe(1);
  } finally { vi.restoreAllMocks(); await runtime.shutdown(); }
});
it('allows a new server capture operation after successful continuation while keeping every consumed operation single-use', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-browser-repeat-')); roots.push(root);
  const contexts: BrowserContext[] = [];
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { async launchPersistent() { const context = fakeContext(true); contexts.push(context); return context; } } });
  const input = { owner, profile, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready', preparationId: fixtureId(9040), preparationRevision: 'same-current-source-and-profile' };
  const scenario = { ...makeHeader(9041), sourceId: input.preparationId, startUrl: input.startUrl, authenticatedSelector: input.authenticatedSelector, steps: [{ action: 'download' as const, locator: { kind: 'css' as const, selector: '#export' } }], parameters: {}, expectedExport: { format: 'csv' as const, requiredColumns: ['Value'] } };
  const file = { bytes: Buffer.from('Value\n42'), name: 'report.csv', contentType: 'text/csv' };
  const continuation = vi.spyOn(browser, 'replayBrowserLogin').mockImplementation(async () => { await contexts.at(-1)!.close(); return file; });
  const fresh = vi.spyOn(browser, 'executeBrowser').mockResolvedValue(file);
  const first = { ...input, scenario, allowFreshContext: true, operationId: fixtureId(9042) };
  try {
    const login = await runtime.openLogin(input, new AbortController().signal);
    await runtime.prepareLogin!({ ...input, loginHandleId: login.handleId });
    expect(await runtime.replay(first, new AbortController().signal)).toEqual(file);
    expect(continuation).toHaveBeenCalledTimes(1); expect(fresh).not.toHaveBeenCalled();
    const second = { ...first, operationId: fixtureId(9043) };
    await expect(runtime.replay(second, new AbortController().signal)).resolves.toEqual(file);
    expect(fresh).toHaveBeenCalledTimes(1);
    // Keeping only lastOperationId would incorrectly permit the older first id.
    for (const used of [first, second]) await expect(runtime.replay(used, new AbortController().signal)).rejects.toMatchObject({ code: 'manual_login_required' });
    await expect(runtime.replay({ ...first, loginHandleId: login.handleId }, new AbortController().signal)).rejects.toMatchObject({ code: 'BROWSER_HANDLE_NOT_FOUND' });
    for (const changed of [{ preparationRevision: 'changed-source' }, { profile: { ...profile, maxBytes: profile.maxBytes - 1 } }, { scenario: { ...scenario, startUrl: input.startUrl + '?changed' } }, { scenario: { ...scenario, authenticatedSelector: '#different' } }]) {
      await expect(runtime.replay({ ...first, ...changed, operationId: fixtureId(9044) }, new AbortController().signal)).rejects.toMatchObject({ code: 'manual_login_required' });
    }
    expect(fresh).toHaveBeenCalledTimes(1);
    // An explicit new live login can authorize retry of that same server job.
    const renewed = await runtime.openLogin(input, new AbortController().signal);
    await runtime.prepareLogin!({ ...input, loginHandleId: renewed.handleId });
    await expect(runtime.replay(first, new AbortController().signal)).resolves.toEqual(file);
    await expect(runtime.replay(second, new AbortController().signal)).rejects.toMatchObject({ code: 'manual_login_required' });
    expect(continuation).toHaveBeenCalledTimes(2); expect(fresh).toHaveBeenCalledTimes(1);
    await runtime.discardPreparation!({ owner, preparationId: input.preparationId });
    await expect(runtime.replay({ ...first, operationId: fixtureId(9045) }, new AbortController().signal)).rejects.toMatchObject({ code: 'manual_login_required' });
    expect(fresh).toHaveBeenCalledTimes(1);
  } finally { await runtime.shutdown(); }
});
it('requires the visible authenticated marker before replaying actions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-browser-runtime-')); roots.push(root);
  const context = fakeContext(); const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { launchPersistent: async () => context } });
  await expect(runtime.replay({ owner, profile, scenario: { ...makeHeader(1), sourceId: fixtureId(2), startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready', steps: [{ action: 'download', locator: { kind: 'css', selector: '#export' } }], parameters: {}, expectedExport: { format: 'csv', requiredColumns: ['Value'] } } }, new AbortController().signal)).rejects.toMatchObject({ code: 'manual_login_required' });
});
it.each(['owner','profile','report','marker','handle','mutated-input'] as const)('rejects a login continuation with a different %s without opening or closing another context',async mismatch=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'uor-browser-runtime-'));roots.push(root);let launches=0,closed=false;
 const runtime=createBrowserRuntime({runtimeRoot:root,launcher:{async launchPersistent(){launches++;const context=fakeContext();context.once('close',()=>closed=true);return context;}}});
 const input={owner,profile:{...profile},startUrl:'https://report.example.invalid/report',authenticatedSelector:'#ready'};
 try{
  const login=await runtime.openLogin(input,new AbortController().signal);
  const scenario={...makeHeader(9010),sourceId:fixtureId(9011),startUrl:input.startUrl,authenticatedSelector:'#ready',steps:[{action:'download' as const,locator:{kind:'css' as const,selector:'#export'}}],parameters:{},expectedExport:{format:'csv' as const,requiredColumns:['Value']}};
  const request={owner,profile,scenario,loginHandleId:login.handleId};
  if(mismatch==='owner')request.owner={...owner,profilePersonId:fixtureId(9012)};
  if(mismatch==='profile')request.profile={...profile,maxBytes:profile.maxBytes-1};
  if(mismatch==='report')request.scenario={...scenario,startUrl:'https://report.example.invalid/other-report'};
  if(mismatch==='marker')request.scenario={...scenario,authenticatedSelector:'#different'};
  if(mismatch==='handle')request.loginHandleId=fixtureId(9013);
  if(mismatch==='mutated-input'){input.profile.maxBytes--;request.profile=input.profile;}
  await expect(runtime.replay(request,AbortSignal.timeout(300))).rejects.toMatchObject({code:mismatch==='owner'||mismatch==='handle'?'BROWSER_HANDLE_NOT_FOUND':'BROWSER_CONTEXT_MISMATCH'});
  expect(launches).toBe(1);expect(closed).toBe(false);
 }finally{await runtime.shutdown();}
});
it('closing one owner cancels its queued opens before another managed window can launch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-browser-runtime-')); roots.push(root);
  let launches = 0; const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { launchPersistent: async () => { launches++; return fakeContext(); } } });
  const input = { owner, profile, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready' };
  await runtime.openLogin(input, new AbortController().signal);
  const second = runtime.openLogin(input, new AbortController().signal).then(() => 'opened', error => (error as Error).name);
  await runtime.closeOwned(owner);
  expect(await second).toBe('AbortError'); expect(launches).toBe(1);
  await runtime.openLogin(input, new AbortController().signal); expect(launches).toBe(2); await runtime.closeOwned(owner);
});
it('rejects an owner root junction even when its target remains inside runtime', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-browser-runtime-')); roots.push(root);
  const another = path.join(root, 'another-owner'); await mkdir(another);
  const parent = path.join(root, 'workbench-browser', owner.installationId); await mkdir(parent, { recursive: true });
  await symlink(another, path.join(parent, 'unassigned'), 'junction');
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { launchPersistent: async () => { throw Error('must not launch'); } } });
  await expect(runtime.openLogin({ owner, profile, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready' }, new AbortController().signal)).rejects.toMatchObject({ code: 'BROWSER_CONFIGURATION_INVALID' });
});

it('final_I2_shutdown_cancels_queued_native_work_and_closes_only_owned_contexts',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'uor-browser-runtime-'));roots.push(root);
 const foreign=fakeContext();let foreignClosed=false;foreign.once('close',()=>foreignClosed=true);
 let launches=0,active=0;
 const runtime=createBrowserRuntime({runtimeRoot:root,launcher:{async launchPersistent(){launches++;active++;const context=fakeContext();context.once('close',()=>active--);return context;}}});
 const input={owner,profile,startUrl:'https://report.example.invalid/report',authenticatedSelector:'#ready'};
 await runtime.openLogin(input,new AbortController().signal);
 const queued=runtime.openLogin(input,new AbortController().signal).then(()=> 'opened',error=>error.name);
 await runtime.shutdown();expect(await queued).toBe('AbortError');expect(active).toBe(0);expect(launches).toBe(1);expect(foreignClosed).toBe(false);
 await expect(runtime.openLogin(input,new AbortController().signal)).rejects.toMatchObject({name:'AbortError'});
 runtime.resume();await expect(runtime.openLogin(input,new AbortController().signal)).rejects.toMatchObject({name:'AbortError'});await foreign.close();
});

it('production tracking wrapper creates and releases an actual app profile lease',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'uor-native-lease-'));roots.push(root);let leasePath='';
 vi.spyOn(chromium,'launchPersistentContext').mockImplementation(async(folder)=>{leasePath=path.join(String(folder),'.uor-browser-lease.json');expect(JSON.parse(await readFile(leasePath,'utf8'))).toMatchObject({pid:process.pid,profilePath:folder});return fakeContext();});
 const runtime=createBrowserRuntime({runtimeRoot:root});await runtime.openLogin({owner,profile,startUrl:'https://report.example.invalid/report',authenticatedSelector:'#report'},new AbortController().signal);expect(leasePath).not.toBe('');await runtime.closeOwned(owner);await vi.waitFor(async()=>{await expect(readFile(leasePath)).rejects.toMatchObject({code:'ENOENT'});});
});
it('production tracking wrapper recovers only an abandoned owned same-host lock set before native launch',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'uor-native-lease-'));roots.push(root);const folder=path.join(root,'workbench-browser',owner.installationId,'unassigned','browser-profiles','own');await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'.uor-browser-lease.json'),JSON.stringify({schemaVersion:1,host:os.hostname(),pid:4194304,profilePath:folder,token:'abandoned-own-instance'}));await symlink(`${os.hostname()}-4194304`,path.join(folder,'SingletonLock'));
 vi.spyOn(chromium,'launchPersistentContext').mockImplementation(async()=>{await expect(readFile(path.join(folder,'SingletonLock'))).rejects.toMatchObject({code:'ENOENT'});expect(JSON.parse(await readFile(path.join(folder,'.uor-browser-lease.json'),'utf8')).pid).toBe(process.pid);return fakeContext();});const runtime=createBrowserRuntime({runtimeRoot:root});try{await runtime.openLogin({owner,profile,startUrl:'https://report.example.invalid/report',authenticatedSelector:'#report'},new AbortController().signal);}finally{await runtime.closeOwned(owner);}
});

it('maintenance preflight refuses an open browser without closing or cancelling it',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'uor-browser-preflight-'));roots.push(root);let closed=false;
 const context=fakeContext();context.once('close',()=>closed=true);
 const runtime=createBrowserRuntime({runtimeRoot:root,launcher:{async launchPersistent(){return context;}}});
 const opened=await runtime.openLogin({owner,profile,startUrl:'https://report.example.invalid/report',authenticatedSelector:'#ready'},new AbortController().signal);
 expect(()=>runtime.assertIdle()).toThrowError(/BROWSER_ACTIVE/);expect(closed).toBe(false);
 expect(await runtime.observeLogin!({owner,handleId:opened.handleId})).toBe(false);
 await runtime.closeOwned(owner);expect(()=>runtime.assertIdle()).not.toThrow();await runtime.shutdown();
});
