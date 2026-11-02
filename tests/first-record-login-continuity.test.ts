import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { createLocalRuntime } from './workbench/helpers/runtime';
import { testBrowserSelection } from './fixtures/workbench/test-browser-selection';

// Real public commands, SQLite journal and native Chromium. The two routes use
// a session-only cookie and an independent SSO origin, so reopening a profile
// cannot accidentally make a broken authentication handoff look successful.
it.each(['marker-first', 'login-first'] as const)('%s retains the original authenticated tab through first recording and durable raw capture', async route => {
  const raw = Buffer.from('ID;Value\nr1;9007199254740993.25\n'), secret = 'synthetic-first-login-canary';
  let reportOrigin = '', loginOrigin = '', logins = 0, launches = 0;
  let context: BrowserContext | undefined, fixture: Awaited<ReturnType<typeof createLocalRuntime>> | undefined;
  let firstCloseRows: unknown[] | undefined;
  const login = createServer((_request, response) => {
    logins++;
    response.setHeader('content-type', 'text/html');
    response.end(`<body style="margin-top:100px"><form data-authentication action="${reportOrigin}/grant" method="post"><input id="password" name="password" type="password"><button id="login">Sign in</button></form></body>`);
  });
  const report = createServer((request, response) => {
    if (request.url === '/grant') {
      request.resume(); request.once('end', () => response.writeHead(303, { 'set-cookie': 'session=present; HttpOnly; SameSite=Lax; Path=/', location: '/report' }).end()); return;
    }
    if (!request.headers.cookie?.includes('session=present')) { response.writeHead(302, { location: loginOrigin + '/login' }).end(); return; }
    if (request.url === '/export') { response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"', 'content-length': raw.length }).end(raw); return; }
    response.setHeader('content-type', 'text/html'); response.end('<body style="margin-top:100px"><h1 id="report">Report</h1><a id="export" href="/export">Export</a></body>');
  });
  try {
    await Promise.all([login, report].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
    reportOrigin = `http://127.0.0.1:${(report.address() as { port: number }).port}`;
    loginOrigin = `http://127.0.0.1:${(login.address() as { port: number }).port}`;
    fixture = await createLocalRuntime({ browserLauncher: { async launchPersistent(_profile, folder, options) {
      expect(options.chromiumSandbox).toBe(true); expect(options.ignoreHTTPSErrors).toBe(false); launches++;
      context = await chromium.launchPersistentContext(folder, { ...options, ...testBrowserSelection(), headless: true, chromiumSandbox: !(process.env.UOR_SYNTHETIC_CI === '1' && process.env.UOR_TEST_CI_NO_SANDBOX === '1') });
      const originalClose = context.close.bind(context);
      context.close = async options => {
        firstCloseRows ??= fixture!.runtime.deps.repository.sqlForModule('oko_workflow').all('SELECT operation_id,state,receipt_json FROM wb_oko_workflow_captures');
        await originalClose(options);
      };
      return context;
    } } });
    const api = fixture.request;
    await api.session();
    const opened = await api.settle(await api.command('oko.workflow.open', { title: route }));
    const workflowId = opened.result.workflowId;
    const configured = await api.settle(await api.command('oko.workflow.profile.set', { workflowId, expectedRevision: opened.result.revision, reportUrl: reportOrigin + '/report', profile: { allowedOrigins: [reportOrigin], loginAllowedOrigins: [loginOrigin], timeoutMs: 5000, maxBytes: 1048576, retries: 0, browser: { ...testBrowserSelection(), profileDirectory: workflowId } } }));
    let markerJob: any;
    let loginId: string | undefined;
    if (route === 'login-first') loginId = (await api.command('oko.workflow.login.open', { workflowId })).result.loginId;
    else markerJob = await api.command('oko.workflow.marker.select', { workflowId, reportUrl: configured.result.reportUrl });
    await vi.waitFor(() => expect(context?.pages().length).toBe(1), { timeout: 8000 });
    const originalContext = context!, page = originalContext.pages()[0];
    await page.locator('#password').fill(secret); await page.locator('#login').click(); await page.locator('#report').waitFor();
    expect((await originalContext.cookies(reportOrigin)).find(cookie => cookie.name === 'session')?.expires).toBe(-1);
    await page.evaluate(() => sessionStorage.setItem('same-tab', 'retained'));
    if (route === 'login-first') {
      expect((await api.command('oko.workflow.login.finish', { workflowId, loginId })).result).toEqual({ completed: true, windowRetained: true });
      expect(page.isClosed()).toBe(false);
      markerJob = await api.command('oko.workflow.marker.select', { workflowId, reportUrl: configured.result.reportUrl });
    }
    await page.locator('[data-uor-marker-picker]').waitFor(); await page.locator('#report').click();
    const marked = (await api.settle(markerJob)).result;
    expect(marked.recordingPreparation).toMatchObject({ state: 'ready' });
    expect(JSON.stringify(marked)).not.toContain(secret);
    const commandId = randomUUID();
    const recording = (await api.settle(await api.command('oko.workflow.record.start', { workflowId, expectedRevision: marked.revision, reportUrl: marked.reportUrl, parsingProfile: { ...marked.parsingProfile, csvDelimiter: ';', decimalSeparator: '.' } }, null, commandId))).result;
    expect(context).toBe(originalContext); expect(originalContext.pages()[0]).toBe(page);
    expect(await page.evaluate(() => sessionStorage.getItem('same-tab'))).toBe('retained');
    expect(launches).toBe(1); expect(logins).toBe(1);
    await page.locator('#export').click();
    await vi.waitFor(() => expect(firstCloseRows).toEqual([expect.objectContaining({ operation_id: commandId, state: 'committed', receipt_json: expect.any(String) })]), { timeout: 8000 });
    const finished = (await api.settle(await api.command('oko.workflow.record.finish', { workflowId, recordingId: recording.recording.recordingId }))).result;
    expect(finished.recording.steps).toEqual([{ action: 'download', locator: { kind: 'css', selector: '#export' } }]);
    expect(finished.recording.parameterNames).toEqual([]); expect(JSON.stringify(finished)).not.toContain(secret);
    const exports = (await api.query('oko.workflow.exports', { workflowId })).items;
    expect(exports).toHaveLength(1); expect(exports[0].sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(Buffer.from(await (await api.response(exports[0].downloadUrl)).arrayBuffer())).toEqual(raw);
  } finally {
    await fixture?.close(); await context?.close().catch(() => {});
    await Promise.all([login, report].map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); }));
  }
}, 30000);
