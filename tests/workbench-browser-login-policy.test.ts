import { createServer, type Server, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { chromium, type BrowserContext, type CDPSession } from 'playwright';
import { createBrowserRuntime } from '../src/features/connectors/workbench-browser-runtime';
import { privateProfileSchema } from '../src/features/connectors/contracts';
import { installedBrowserExecutable } from './fixtures/workbench/native-browser';
import { fixtureId, makeHeader } from './fixtures/workbench/factories';
import { problemFromError } from '../src/server/workbench/problem-from-error';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(rejectWorkerPolicy = false) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(path.join(parent, 'uor-login-policy-'));
  const requests: string[] = [], upgrades: string[] = [], contexts = new Set<BrowserContext>();
  const blocked = new Set<string>(), blocks = new EventEmitter();
  let reportOrigin = '', loginOrigin = '', foreignOrigin = '', current!: BrowserContext, launches = 0;
  let exportResponse: ServerResponse | undefined, startedExport!: () => void;
  const exportStarted = new Promise<void>(resolve => { startedExport = resolve; });
  let retiringResponse: ServerResponse | undefined, startedRetiringResponse!: () => void;
  const retiringResponseStarted = new Promise<void>(resolve => { startedRetiringResponse = resolve; });
  let authenticatedReports = 0, repeatedDocument!: () => void;
  const replayDocument = new Promise<void>(resolve => { repeatedDocument = resolve; });
  const foreign = createServer((request, response) => { requests.push(foreignOrigin + request.url); response.writeHead(200, { 'access-control-allow-origin': '*' }).end('foreign'); });
  const login = createServer((request, response) => {
    requests.push(loginOrigin + request.url);
    if (request.url === '/old-sw.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));setInterval(()=>fetch('/worker-tick').catch(()=>{}),25);`); return;
    }
    if (request.url === '/old-shared.js') { response.writeHead(200, { 'content-type': 'text/javascript' }).end("self.onconnect=event=>{event.ports[0].postMessage('ready')};setInterval(()=>fetch('/worker-tick').catch(()=>{}),25);"); return; }
    if (request.url === '/worker-tick') { response.end('tick'); return; }
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<a id="sign-in" target="_blank" href="${reportOrigin}/sign-in">Sign in</a>`);
  });
  const report = createServer((request, response) => {
    requests.push(reportOrigin + request.url);
    if (request.url === '/sign-in') { response.writeHead(302, { location: '/report', 'set-cookie': 'session=present; HttpOnly; SameSite=Lax; Path=/' }).end(); return; }
    if (!(request.headers.cookie ?? '').includes('session=present')) { response.writeHead(302, { location: loginOrigin + '/login' }).end(); return; }
    if (request.url === '/retiring-response') { retiringResponse = response; startedRetiringResponse(); return; }
    if (request.url === '/report' && ++authenticatedReports === 2) repeatedDocument();
    if (request.url === '/redirect-login') { response.writeHead(302, { location: loginOrigin + '/redirect-leak' }).end(); return; }
    if (request.url === '/redirect-foreign' || request.url === '/redirect-download') { response.writeHead(302, { location: foreignOrigin + request.url }).end(); return; }
    if (request.url === '/new-sw.js' || request.url === '/dedicated.js' || request.url === '/shared.js') { response.writeHead(200, { 'content-type': 'text/javascript' }).end(`fetch('${foreignOrigin}/worker-leak');new WebSocket('${foreignOrigin.replace('http:', 'ws:')}/worker-socket');`); return; }
    if (request.url === '/export') { exportResponse = response; response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=report.csv' }); response.write('ID;Value\n'); startedExport(); return; }
    const type = request.url === '/plain-frame' ? 'text/plain' : request.url === '/json-frame' ? 'application/json' : 'text/html';
    const document = gzipSync(type === 'text/html' ? '<h1 id="ready">Report</h1><a id="export" href="/export">Export</a><a id="new-window" target="_blank" href="/redirect-foreign">New window</a>' : '{"report":"ready"}');
    response.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', 'content-length': document.length, 'content-security-policy': "script-src 'self' 'unsafe-inline'" }).end(document);
  });
  for (const server of [report, login, foreign]) server.on('upgrade', (request, socket) => { upgrades.push(`${server === login ? loginOrigin : server === foreign ? foreignOrigin : reportOrigin}${request.url}`); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  const executablePath = await installedBrowserExecutable();
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { async launchPersistent(_profile, folder, options) {
    expect(options.chromiumSandbox).toBe(true); expect(options.ignoreHTTPSErrors).toBe(false); launches++;
    current = await chromium.launchPersistentContext(folder, { ...options, headless: true, chromiumSandbox: process.env.UOR_SYNTHETIC_CI !== '1' });
    contexts.add(current); current.once('close', () => contexts.delete(current));
    const nativeSession = current.newCDPSession.bind(current);
    current.newCDPSession = async target => {
      const session = await nativeSession(target), send = session.send.bind(session), urls = new Map<string, string>();
      session.on('Fetch.requestPaused', event => urls.set(event.requestId, event.request.url));
      session.send = (async (method: string, parameters?: { requestId?: string }) => {
        if (rejectWorkerPolicy && method === 'ServiceWorker.enable') throw Error('Synthetic unsupported worker policy');
        const result = await send(method as never, parameters as never);
        if (method === 'Fetch.failRequest') { const url = urls.get(parameters?.requestId ?? ''); if (url) { blocked.add(url); blocks.emit('blocked', url); } }
        return result;
      }) as CDPSession['send'];
      return session;
    };
    return current;
  } } });
  try {
    foreignOrigin = await listen(foreign); loginOrigin = await listen(login); reportOrigin = await listen(report);
    const owner = { installationId: fixtureId(950101), profilePersonId: null };
    const profile = privateProfileSchema.parse({ allowedOrigins: [reportOrigin], loginAllowedOrigins: [loginOrigin], timeoutMs: 3000, browser: { executablePath, profileDirectory: 'owned', headless: true } });
    const input = { owner, profile, startUrl: reportOrigin + '/report', authenticatedSelector: '#ready' };
    const scenario = { ...makeHeader(950102), sourceId: fixtureId(950103), startUrl: input.startUrl, authenticatedSelector: '#ready', steps: [{ action: 'download' as const, locator: { kind: 'css' as const, selector: '#export' } }], parameters: {}, expectedExport: { format: 'csv' as const, requiredColumns: ['ID', 'Value'] } };
    return { input, scenario, runtime, requests, upgrades, exportStarted, replayDocument, retiringResponseStarted, loginOrigin, foreignOrigin, reportOrigin,
      finishRetiringResponse: () => retiringResponse?.end('old login response'),
      context: () => current, launches: () => launches, openContexts: () => contexts.size,
      async waitForBlocked(url: string, signal: AbortSignal) {
        if (blocked.has(url)) return; signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const done = (value: string) => { if (value === url) { cleanup(); resolve(); } };
          const abort = () => { cleanup(); reject(signal.reason); };
          const cleanup = () => { blocks.off('blocked', done); signal.removeEventListener('abort', abort); };
          blocks.on('blocked', done); signal.addEventListener('abort', abort, { once: true });
        });
      },
      finishExport: () => exportResponse?.end('r1;42'),
      async close() {
        exportResponse?.end(); retiringResponse?.end(); await runtime.shutdown();
        for (const server of [report, login, foreign]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        expect(path.dirname(root)).toBe(parent); expect(path.basename(root)).toMatch(/^uor-login-policy-/); await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) { await runtime.shutdown(); for (const server of [report, login, foreign]) { server.closeAllConnections(); server.close(); } await rm(root, { recursive: true, force: true }); throw error; }
}

it('rejects an in-flight login response during the report transition without closing the authenticated context', async () => {
  const f = await fixture(), signal = AbortSignal.timeout(15000);
  let replay: ReturnType<typeof f.runtime.replay> | undefined;
  try {
    const login = await f.runtime.openLogin(f.input, signal), context = f.context(), page = context.pages()[0];
    await page.goto(f.reportOrigin + '/sign-in'); await page.locator('#ready').waitFor();
    expect((await context.cookies(f.reportOrigin)).find(cookie => cookie.name === 'session')?.expires).toBe(-1);
    await page.evaluate(() => { sessionStorage.setItem('transition-proof', 'kept'); void fetch('/retiring-response').catch(() => {}); });
    await f.retiringResponseStarted;
    const setOffline = context.setOffline.bind(context);
    context.setOffline = async offline => {
      if (offline) {
        // Model an already-sent response arriving while the native offline
        // command is pending. The real response must be blocked, not delivered.
        f.finishRetiringResponse(); await f.waitForBlocked(f.reportOrigin + '/retiring-response', signal);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return setOffline(offline);
    };
    replay = f.runtime.replay({ ...f.input, scenario: f.scenario, loginHandleId: login.handleId }, signal);
    const settled = replay.then(file => ({ file }), error => ({ error }));
    expect(await Promise.race([f.exportStarted.then(() => ({ started: true })), settled])).toEqual({ started: true });
    expect(f.launches()).toBe(1); expect(context.pages()).toEqual([page]);
    expect(await page.evaluate(() => sessionStorage.getItem('transition-proof'))).toBe('kept');
    f.finishExport(); expect((await replay).bytes.toString()).toBe('ID;Value\nr1;42');
  } finally { await f.close(); await replay?.catch(() => {}); }
});

it('keeps the authenticated popup and session while retiring login workers and enforcing the report origin policy', async () => {
  const f = await fixture(), signal = AbortSignal.timeout(15000);
  let replay: ReturnType<typeof f.runtime.replay> | undefined;
  try {
    const handle = await f.runtime.openLogin(f.input, signal), loginPage = f.context().pages()[0];
    const workerOpened = f.context().waitForEvent('serviceworker');
    await loginPage.evaluate(async () => { await navigator.serviceWorker.register('/old-sw.js'); await navigator.serviceWorker.ready; });
    const oldWorker = await workerOpened;
    expect(await oldWorker.evaluate(() => self.location.pathname)).toBe('/old-sw.js');
    await loginPage.evaluate(() => new Promise<void>(resolve => { const worker = new SharedWorker('/old-shared.js', { name: 'existing', extendedLifetime: true } as WorkerOptions); worker.port.onmessage = () => resolve(); worker.port.start(); }));
    const beforeTargets = await f.context().newCDPSession(loginPage), { targetInfos } = await beforeTargets.send('Target.getTargets');
    const sharedTarget = targetInfos.find(target => target.type === 'shared_worker' && target.url === f.loginOrigin + '/old-shared.js');
    expect(sharedTarget).toBeDefined();
    const popupOpened = f.context().waitForEvent('page'); await loginPage.locator('#sign-in').click();
    const page = await popupOpened; await page.locator('#ready').waitFor();
    await page.evaluate(() => { sessionStorage.setItem('tab-proof', 'kept'); localStorage.setItem('local-proof', 'kept'); });
    expect(await f.runtime.observeLogin!({ owner: f.input.owner, handleId: handle.handleId })).toBe(true);
    expect((await f.context().cookies(f.reportOrigin)).find(cookie => cookie.name === 'session')?.expires).toBe(-1);
    replay = f.runtime.replay({ ...f.input, scenario: f.scenario, loginHandleId: handle.handleId }, signal);
    // Handle an early rejection immediately; do not leave an unhandled replay promise.
    const settled = replay.then(file => ({ file }), error => ({ error }));
    const boundary = await Promise.race([f.exportStarted.then(() => ({ started: true })), settled]);
    expect(boundary).toEqual({ started: true });
    expect(f.launches()).toBe(1); expect(loginPage.isClosed()).toBe(true); expect(page.isClosed()).toBe(false);
    expect(await page.evaluate(() => [sessionStorage.getItem('tab-proof'), localStorage.getItem('local-proof')])).toEqual(['kept', 'kept']);
    await expect(oldWorker.evaluate(() => self.location.href)).rejects.toThrow();
    expect(f.context().serviceWorkers()).toEqual([]);
    const afterTargets = await f.context().newCDPSession(page);
    expect((await afterTargets.send('Target.getTargets')).targetInfos.some(target => target.targetId === sharedTarget?.targetId)).toBe(false); await afterTargets.detach();
    const afterBoundary = f.requests.length, beforeSockets = f.upgrades.length;
    const attempts = await page.evaluate(async ({ login, foreign }) => {
      const result: Record<string, boolean> = {};
      for (const [name, url] of Object.entries({ login: login + '/report-leak', foreign: foreign + '/report-leak', redirectLogin: '/redirect-login', redirectForeign: '/redirect-foreign' })) result[name] = await fetch(url).then(() => true, () => false);
      result.worker = await navigator.serviceWorker.register('/new-sw.js').then(() => true, () => false);
      for (const [name, url] of Object.entries({ loginSocket: login, foreignSocket: foreign })) result[name] = await new Promise<boolean>(resolve => { const ws = new WebSocket(url.replace('http:', 'ws:') + '/report-socket'); ws.onopen = () => { ws.close(); resolve(true); }; ws.onerror = () => resolve(false); ws.onclose = () => resolve(false); });
      return result;
    }, { login: f.loginOrigin, foreign: f.foreignOrigin });
    expect(attempts).toEqual({ login: false, foreign: false, redirectLogin: false, redirectForeign: false, worker: false, loginSocket: false, foreignSocket: false });
    const blockedFrame = page.waitForEvent('requestfailed', { predicate: request => request.url() === f.foreignOrigin + '/frame-leak' });
    await page.evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }, f.foreignOrigin + '/frame-leak'); await blockedFrame;
    // Browser-managed download redirects do not emit Playwright requestfailed.
    // Require the actual native failRequest acknowledgement, plus server counters.
    const blockedDownload = f.waitForBlocked(f.reportOrigin + '/redirect-download', signal);
    await page.evaluate(() => { const link = document.createElement('a'); link.href = '/redirect-download'; link.download = ''; document.body.append(link); link.click(); }); await blockedDownload;
    expect(f.requests.slice(afterBoundary)).toContain(f.reportOrigin + '/redirect-download');
    await page.evaluate(() => { for (const url of ['/worker-frame', '/plain-frame', '/json-frame']) { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); } });
    await page.frameLocator('iframe[src="/worker-frame"]').locator('#ready').waitFor();
    for (const frame of page.frames().filter(frame => frame.url().startsWith(f.reportOrigin))) {
      await frame.waitForLoadState();
      expect(await frame.evaluate(async () => {
        const attempts = [navigator.serviceWorker.register('/new-sw.js').then(() => true, () => false)];
        for (const kind of ['dedicated', 'shared']) attempts.push(new Promise<boolean>(resolve => {
          try { const worker = kind === 'dedicated' ? new Worker('/dedicated.js') : new SharedWorker('/shared.js'); worker.onerror = event => { event.preventDefault(); resolve(false); }; if (worker instanceof Worker) worker.onmessage = () => resolve(true); else { worker.port.onmessage = () => resolve(true); worker.port.start(); } }
          catch { resolve(false); }
        }));
        return Promise.all(attempts);
      })).toEqual([false, false, false]);
    }
    expect(f.context().serviceWorkers()).toEqual([]);
    expect(f.requests.slice(afterBoundary).filter(url => url.startsWith(f.foreignOrigin) || url.startsWith(f.loginOrigin))).toEqual([]);
    expect(f.requests.slice(afterBoundary).filter(url => /\/(new-sw|dedicated|shared)\.js/.test(url))).toEqual([]);
    expect(f.upgrades.slice(beforeSockets)).toEqual([]);
    f.finishExport(); const completed = await settled; expect(completed).toHaveProperty('file');
    if ('file' in completed) expect(Buffer.from(completed.file.bytes).toString()).toBe('ID;Value\nr1;42');
    expect(f.openContexts()).toBe(0);
    await expect(f.runtime.replay({ ...f.input, scenario: f.scenario, loginHandleId: handle.handleId }, signal)).rejects.toMatchObject({ code: 'BROWSER_HANDLE_NOT_FOUND' });
  } finally { f.finishExport(); await f.close(); await replay?.catch(() => {}); }
}, 20000);

it('fails closed without a second launch when the native worker fence is unavailable', async () => {
  const f = await fixture(true), signal = AbortSignal.timeout(10000);
  try {
    const handle = await f.runtime.openLogin(f.input, signal), login = f.context().pages()[0];
    const opened = f.context().waitForEvent('page'); await login.locator('#sign-in').click(); const page = await opened; await page.locator('#ready').waitFor();
    const requestsBefore = f.requests.length;
    const failed = await f.runtime.replay({ ...f.input, scenario: f.scenario, loginHandleId: handle.handleId }, signal).then(() => null, error => error);
    expect(failed).toMatchObject({ code: 'configuration_required', reason: 'REPORT_WORKER_POLICY_UNAVAILABLE' });
    const problem = problemFromError(failed, fixtureId(950104));
    expect(problem.code).toBe('BROWSER_CONFIGURATION_REQUIRED');
    expect(problem.details).toContainEqual(expect.objectContaining({ code: 'REPORT_WORKER_POLICY_UNAVAILABLE' }));
    expect(JSON.stringify(problem)).not.toMatch(/127\.0\.0\.1|Synthetic unsupported|session=|\/tmp\//);
    expect(f.launches()).toBe(1); expect(f.openContexts()).toBe(0);
    expect(f.requests.slice(requestsBefore)).not.toContain(f.reportOrigin + '/export');
    await expect(f.runtime.replay({ ...f.input, scenario: f.scenario, loginHandleId: handle.handleId }, signal)).rejects.toMatchObject({ code: 'BROWSER_HANDLE_NOT_FOUND' });
  } finally { await f.close(); }
}, 15000);

it.each(['source-popup', 'new-blank-page'] as const)('rejects %s before a new report document or redirect can escape the retained tab', async mode => {
  const f = await fixture(), signal = AbortSignal.timeout(10000);
  let replay: Promise<unknown> | undefined;
  try {
    const handle = await f.runtime.openLogin(f.input, signal), login = f.context().pages()[0];
    const opened = f.context().waitForEvent('page'); await login.locator('#sign-in').click(); const page = await opened; await page.locator('#ready').waitFor();
    const scenario = { ...f.scenario, steps: [{ action: 'download' as const, locator: { kind: 'css' as const, selector: mode === 'source-popup' ? '#new-window' : '#wait-for-window-check' } }] };
    replay = f.runtime.replay({ ...f.input, scenario, loginHandleId: handle.handleId }, signal).then(() => null, error => error);
    if (mode === 'new-blank-page') { await f.replayDocument; await page.locator('#ready').waitFor(); await f.context().newPage().catch(() => {}); }
    const error = await replay;
    expect(error).toMatchObject({ code: 'configuration_required', reason: 'REPORT_NEW_WINDOW_UNSUPPORTED' });
    expect(problemFromError(error, fixtureId(950105)).details).toContainEqual(expect.objectContaining({ code: 'REPORT_NEW_WINDOW_UNSUPPORTED' }));
    expect(f.requests.filter(url => url.endsWith('/redirect-foreign') || url.endsWith('/export') || url.startsWith(f.foreignOrigin))).toEqual([]);
    expect(f.launches()).toBe(1); expect(f.openContexts()).toBe(0);
  } finally { await f.close(); await replay; }
}, 15000);
