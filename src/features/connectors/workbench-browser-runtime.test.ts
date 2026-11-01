import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterEach, expect, it } from 'vitest';
import { privateProfileSchema } from './contracts';
import { createBrowserRuntime, type BrowserOwner } from './workbench-browser-runtime';
import { makeHeader, fixtureId } from '../../../tests/fixtures/workbench/factories';

const owner: BrowserOwner = { installationId: '00000000-0000-4000-8000-000000000001', profilePersonId: null };
const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], timeoutMs: 1000, browser: { channel: 'fixture', profileDirectory: 'own' } });
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function fakeContext() {
  let closed = false;
  const events = new EventEmitter(); const page = { goto: async () => {}, url: () => 'https://report.example.invalid/report', locator: () => ({ isVisible: async () => false }) };
  const cdp = { send: async () => {}, on: () => {} };
  return Object.assign(events, { setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {}, pages: () => [page], newCDPSession: async () => cdp,
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
