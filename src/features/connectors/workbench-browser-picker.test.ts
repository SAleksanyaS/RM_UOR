import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { expect, it } from 'vitest';
import { privateProfileSchema } from './contracts';
import { selectBrowserReportMarker } from './workbench-browser-picker';

it('validates allowed origin before launch and supports cancellation without opening a profile', async () => {
  const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { channel: 'fixture', profileDirectory: 'own' } });
  let launches = 0;
  const input = { runtimeRoot: os.tmpdir(), owner: { installationId: '00000000-0000-4000-8000-000000000001', profilePersonId: null }, profile, launcher: { launchPersistent: async () => { launches++; throw Error('must not launch'); } } };
  await expect(selectBrowserReportMarker({ ...input, startUrl: 'https://report.example.invalid.evil/report', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'configuration_required' });
  const controller = new AbortController(); controller.abort();
  await expect(selectBrowserReportMarker({ ...input, startUrl: 'https://report.example.invalid/report', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(launches).toBe(0);
});
it('accepts only a main-frame unique report marker and closes its owned context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-picker-'));
  const events = new EventEmitter(); let closed = false, authenticated = false;
  let binding!: (source: unknown, payload: unknown) => Promise<void>;
  const frame = {}, page = { mainFrame: () => frame, frames: () => [], url: () => 'https://report.example.invalid/report',
    locator: (selector: string) => ({ count: async () => selector === '#duplicate' ? 2 : 1, isVisible: async () => true,
      evaluateAll: async () => !authenticated, evaluate: async (fn: Function) => fn.toString().includes('const node') ? false : { selector: '#report', label: 'report' } }),
    goto: async () => { await binding({ page, frame }, { selector: '#report' }); authenticated = true; await binding({ page, frame: {} }, { selector: '#report' }); await binding({ page, frame }, { selector: '#duplicate' }); await binding({ page, frame }, { selector: '#report' }); } };
  const context = Object.assign(events, { pages: () => [page], setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    newCDPSession: async () => ({ send: async () => {}, on: () => {} }), route: async () => {}, routeWebSocket: async () => {},
    exposeBinding: async (_name: string, callback: typeof binding) => { binding = callback; }, addInitScript: async () => {},
    close: async () => { if (!closed) { closed = true; events.emit('close'); } } });
  try {
    const marker = await selectBrowserReportMarker({ runtimeRoot: root, owner: { installationId: '00000000-0000-4000-8000-000000000001', profilePersonId: null },
      profile: privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { channel: 'fixture', profileDirectory: 'own' } }),
      startUrl: page.url(), signal: new AbortController().signal, launcher: { launchPersistent: async () => context as unknown as BrowserContext } });
    expect(marker).toEqual({ selector: '#report', label: 'report' }); expect(closed).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('selects a real Edge marker after manual auth and serializes/cancels the own profile', async () => {
  const { createServer } = await import('node:http'); const { chromium } = await import('playwright');
  const { createBrowserRuntime } = await import('./workbench-browser-runtime');
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-picker-edge-'));
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<div data-authentication><input type="password"><button id="login">Login</button></div><h1 id="report">Report</h1><script>document.querySelector("#login").onclick=()=>document.querySelector("[data-authentication]").remove()</script>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  let launches = 0, selected = false; const contexts: BrowserContext[] = [];
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { launchPersistent: async (_profile, folder, options) => {
    launches++; const context = await chromium.launchPersistentContext(folder, { ...options, channel: 'msedge', headless: true }); contexts.push(context);
    const page = context.pages()[0];
    void page.waitForURL(`${origin}/report`).then(async () => {
      await page.locator('#report').click(); await page.waitForTimeout(100); expect(selected).toBe(false);
      await page.locator('#login').click(); await page.locator('#report').click();
    });
    return context;
  } } });
  const owner = { installationId: '00000000-0000-4000-8000-000000000001', profilePersonId: null };
  const input = { owner, profile: privateProfileSchema.parse({ allowedOrigins: [origin], timeoutMs: 3000, browser: { channel: 'msedge', profileDirectory: 'own' } }), startUrl: `${origin}/report` };
  try {
    const first = runtime.selectMarker(input, new AbortController().signal).then(value => { selected = true; return value; });
    await new Promise<void>(resolve => { const timer = setInterval(() => { if (launches) { clearInterval(timer); resolve(); } }, 10); });
    const controller = new AbortController(), queued = runtime.selectMarker(input, controller.signal); controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(await first).toEqual({ selector: '#report', label: 'report' }); expect(launches).toBe(1);
  } finally { await Promise.all(contexts.map(context => context.close().catch(() => {}))); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
it('lets passwordless SSO Continue navigate on a different allowed origin and rejects a forbidden marker with a hint', async () => {
  const { createServer } = await import('node:http'); const { chromium } = await import('playwright');
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-picker-sso-')); let reportOrigin = '';
  const sso = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<button id="continue" onclick="location.href='${reportOrigin}/ready'">Continue with smartcard</button>`); });
  await new Promise<void>(resolve => sso.listen(0, '127.0.0.1', resolve));
  const ssoOrigin = `http://127.0.0.1:${(sso.address() as {port:number}).port}`;
  const report = createServer((req, res) => { if (req.url === '/report') { res.writeHead(302, {location:ssoOrigin+'/'}).end(); return; } res.setHeader('content-type','text/html'); res.end('<main style="margin-top:100px"><h1 data-testid="session-title">Unsafe marker</h1><h2 id="report">Safe marker</h2></main>'); });
  await new Promise<void>(resolve => report.listen(0, '127.0.0.1', resolve)); reportOrigin = `http://127.0.0.1:${(report.address() as {port:number}).port}`;
  let context: BrowserContext | undefined; let driver: Promise<void> | undefined; const controller = new AbortController();
  try {
    const selected = selectBrowserReportMarker({runtimeRoot:root,owner:{installationId:'00000000-0000-4000-8000-000000000001',profilePersonId:null},profile:privateProfileSchema.parse({allowedOrigins:[reportOrigin,ssoOrigin],timeoutMs:1500,browser:{channel:'msedge',profileDirectory:'own'}}),startUrl:reportOrigin+'/report',signal:controller.signal,launcher:{launchPersistent:async(_profile,folder,options)=>{
      context=await chromium.launchPersistentContext(folder,{...options,channel:'msedge',headless:true});const page=context.pages()[0];
      driver=(async()=>{await page.waitForURL(ssoOrigin+'/');await page.locator('#continue').click();await page.waitForURL(reportOrigin+'/ready');await page.locator('[data-testid="session-title"]').click();await page.waitForTimeout(100);expect(await page.locator('[data-uor-marker-picker]').innerText()).toContain('Выберите другой элемент');await page.locator('#report').click();})();void driver.catch(()=>controller.abort());return context;
    }}}); await expect(selected).resolves.toEqual({selector:'#report',label:'report'}); await driver;
  } finally {controller.abort();await context?.close().catch(()=>{});await Promise.all([new Promise<void>(resolve=>sso.close(()=>resolve())),new Promise<void>(resolve=>report.close(()=>resolve()))]);await rm(root,{recursive:true,force:true});}
});
it('aborts an active unresolved navigation promptly and closes only the owned context', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'uor-picker-abort-'));const events=new EventEmitter();let closed=false, navigating!:()=>void;
  const started=new Promise<void>(resolve=>{navigating=resolve;});const page={goto:()=>{navigating();return new Promise(()=>{});}};
  const context=Object.assign(events,{pages:()=>[page],setDefaultTimeout:()=>{},setDefaultNavigationTimeout:()=>{},newCDPSession:async()=>({send:async()=>{},on:()=>{}}),route:async()=>{},routeWebSocket:async()=>{},exposeBinding:async()=>{},addInitScript:async()=>{},close:async()=>{closed=true;events.emit('close');}});
  const controller=new AbortController();try{
    const task=selectBrowserReportMarker({runtimeRoot:root,owner:{installationId:'00000000-0000-4000-8000-000000000001',profilePersonId:null},profile:privateProfileSchema.parse({allowedOrigins:['https://report.example.invalid'],browser:{channel:'fixture',profileDirectory:'own'}}),startUrl:'https://report.example.invalid/report',signal:controller.signal,launcher:{launchPersistent:async()=>context as unknown as BrowserContext}});
    await started;controller.abort();const outcome=await Promise.race([task.then(()=> 'unexpected',error=>(error as Error).name),new Promise(resolve=>setTimeout(()=>resolve('navigation still blocked'),250))]);expect(outcome).toBe('AbortError');expect(closed).toBe(true);
  }finally{controller.abort();await rm(root,{recursive:true,force:true});}
});
