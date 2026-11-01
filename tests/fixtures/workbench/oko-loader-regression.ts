// Run with Node --import tsx, never Vitest's transformed module graph.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext } from 'playwright';
import { createBrowserRuntime } from '../../../src/features/connectors/workbench-browser-runtime';
import { privateProfileSchema } from '../../../src/features/connectors/contracts';
import { makeHeader, fixtureId } from './factories';

const termination = new AbortController();
process.once('SIGTERM', () => termination.abort(Error('Owned loader process is stopping')));

for (const mode of ['picker', 'recorder', 'session-continuation'] as const) test(`${mode} executes in real Chrome/Edge with the production tsx loader`, { timeout: 20000 }, async context => {
  const temp = await realpath(tmpdir()), root = await mkdtemp(path.join(temp, 'uor-oko-loader-'));
  let holdExport = false, startedDownload!: () => void;
  const downloadStarted = new Promise<void>(resolve => { startedDownload = resolve; });
  const server = createServer((request, response) => {
    if (mode === 'session-continuation') {
      if (request.url === '/login') { response.writeHead(200, { 'content-type': 'text/html' }).end('<a id="sign-in" href="/sign-in">Complete synthetic login</a>'); return; }
      if (request.url === '/sign-in') { response.writeHead(302, { location: '/report', 'set-cookie': 'synthetic-session=present; HttpOnly; SameSite=Lax; Path=/' }).end(); return; }
      if (!(request.headers.cookie ?? '').includes('synthetic-session=present')) { response.writeHead(302, { location: '/login' }).end(); return; }
    }
    if (request.url === '/export') { response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=report.csv' }); if(holdExport){response.write('ID;Value\n');startedDownload();}else response.end('ID;Value\nr1;123456789012345.67'); return; }
    response.setHeader('content-type', 'text/html'); response.end('<main style="margin-top:100px"><h1 id="ready">Report</h1><label for="period">Period</label><input id="period"><a id="export" href="/export">Export</a></main>');
  });
  const errors: string[] = [];
  let managed: BrowserContext | undefined, launched!: () => void, launches = 0;
  const opening = new Promise<void>(resolve => { launched = resolve; });
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { launchPersistent: async (_profile, folder, options) => {
    if (process.env.UOR_LOADER_LAUNCH_FAILURE === '1') throw Error('Synthetic browser launch rejection');
    assert.equal(options.chromiumSandbox, true); launches++;
    managed = await chromium.launchPersistentContext(folder, { ...options, headless: true, timeout: 10000 });
    managed.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    managed.pages()[0].on('pageerror', error => errors.push(error.message)); launched(); return managed;
  } } });
  const owner = { installationId: '00000000-0000-4000-8000-000000000001', profilePersonId: null };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(Error('Loader browser operation exceeded its deadline')), 15000);
  const signal = AbortSignal.any([controller.signal, context.signal, termination.signal]);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(signal.reason ?? Error('Loader operation aborted'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
    const browser = process.env.UOR_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.UOR_TEST_BROWSER_EXECUTABLE, profileDirectory: 'own' } : { channel: 'msedge', profileDirectory: 'own' };
    const input = { owner, profile: privateProfileSchema.parse({ allowedOrigins: [origin], timeoutMs: 3000, browser }), startUrl: origin + '/report', authenticatedSelector: '#ready' };
    const exercise = async () => {
    if (mode === 'picker') {
      const selected = runtime.selectMarker(input, signal);
      // A rejected launch settles the operation as well as the UI-opening wait.
      await Promise.race([opening, selected]); const page = managed!.pages()[0]; await page.waitForURL(input.startUrl);
      assert.deepEqual(errors, [], 'Picker page scripts must not depend on Node transform helpers');
      await page.locator('[data-uor-marker-picker]').waitFor({ timeout: 3000 }); await page.locator('#ready').click();
      assert.deepEqual(await selected, { selector: '#ready', label: 'ready' });
    } else if (mode === 'recorder') {
      const handle = await runtime.startRecording(input, signal), page = managed!.pages()[0];
      assert.deepEqual(errors, [], 'Recorder page scripts must not depend on Node transform helpers');
      assert.equal(await page.evaluate(() => typeof (window as unknown as {__uorRecorderDrain: unknown}).__uorRecorderDrain), 'function');
      await page.getByLabel('Period').fill('October'); await page.getByLabel('Period').press('Tab'); await page.locator('#export').click();
      const result = await runtime.waitForCompletion({ owner, handleId: handle.handleId });
      assert.equal(result.hasDownload, true); assert.deepEqual(result.steps.map(step => step.action), ['fill', 'download']);
      assert.deepEqual(result.parameterNames, ['field_period']); assert.equal(JSON.stringify(result).includes('October'), false);
    } else {
      const handle = await runtime.openLogin(input, signal), page = managed!.pages()[0];
      await page.locator('#sign-in').click(); await page.locator('#ready').waitFor();
      assert.equal((await managed!.cookies(origin)).find(cookie => cookie.name === 'synthetic-session')?.expires, -1, 'The synthetic authentication must remain session-only');
      const scenario = { ...makeHeader(9001), sourceId: fixtureId(9002), startUrl: input.startUrl, authenticatedSelector: '#ready', steps: [{ action: 'download' as const, locator: { kind: 'css' as const, selector: '#export' } }], parameters: {}, expectedExport: { format: 'csv' as const, requiredColumns: ['ID', 'Value'] } };
      const file = await runtime.replay({ owner, profile: input.profile, scenario, loginHandleId: handle.handleId }, AbortSignal.any([signal, AbortSignal.timeout(4000)]));
      assert.equal(Buffer.from(file.bytes).toString(), 'ID;Value\nr1;123456789012345.67');
      assert.equal(launches, 1, 'Continuation must use the authenticated native context without reopening the profile');
      await assert.rejects(runtime.replay({ owner, profile: input.profile, scenario, loginHandleId: handle.handleId }, signal), { code: 'BROWSER_HANDLE_NOT_FOUND' });
      holdExport = true;
      const second = await runtime.openLogin(input, signal), secondPage = managed!.pages()[0];
      await secondPage.locator('#sign-in').click(); await secondPage.locator('#ready').waitFor();
      const cancelled = runtime.replay({ owner, profile: input.profile, scenario, loginHandleId: second.handleId }, AbortSignal.any([signal, AbortSignal.timeout(4000)])).then(() => null, error => error);
      await Promise.race([downloadStarted, aborted]); await runtime.closeOwned(owner);
      assert.equal((await cancelled)?.name, 'AbortError');
      assert.equal(launches, 2, 'Cancel must close the existing login context rather than create an extra replay context');
    }
    };
    await Promise.race([exercise(), aborted]);
  } finally {
    clearTimeout(deadline); signal.removeEventListener('abort', abort); controller.abort();
    try { await runtime.shutdown(); }
    finally {
      await managed?.close().catch(() => {});
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('uor-oko-loader-')); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      console.log(`UOR_LOADER_CLEANUP ${mode} listener=${server.listening ? 'open' : 'closed'}`);
    }
  }
});
