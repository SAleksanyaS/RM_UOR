import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Download, type Page } from 'playwright';
import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { privateProfileSchema } from './contracts';
import { finishRecording, startRecording, waitForRecordingComplete } from './browser';
import { createBrowserRecorderService } from './workbench-browser-recorder';
import type { BrowserRuntimePort } from './workbench-browser-runtime';
import { createBrowserRuntime } from './workbench-browser-runtime';
import type { CommandContext } from '../../server/workbench/command-registry';
import { fixtureId, makeEntityGraph, makeHeader } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(useRuntime = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-recorded-export-')); roots.push(root);
  let authenticated = false, binding!: (source: unknown, event: unknown) => Promise<void>, closed = false;
  const masks: string[][] = [], pageEvents = new EventEmitter(), contextEvents = new EventEmitter();
  const frame = { url: () => 'https://report.example.invalid/report' };
  const locator = (selector: string) => ({ selector, count: async () => selector === '#ambiguous' ? 2 : 1, isVisible: async () => authenticated,
    evaluateAll: async () => !authenticated,
    evaluate: async () => false, });
  const page = Object.assign(pageEvents, { goto: async () => {}, url: frame.url, mainFrame: () => frame, locator,
    screenshot: async (options: { path: string; mask: Array<{ selector: string }> }) => { masks.push(options.mask.map(mask => mask.selector)); await writeFile(options.path, Buffer.from('synthetic-png')); },
    evaluate: async () => {}, });
  const context = Object.assign(contextEvents, { pages: () => [page], setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    newCDPSession: async () => ({ send: async () => {}, on: () => {} }), route: async () => {}, routeWebSocket: async () => {},
    exposeBinding: async (_name: string, callback: typeof binding) => { binding = callback; }, addInitScript: async () => {},
    close: async () => { if (!closed) { closed = true; contextEvents.emit('close'); } } });
  const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], timeoutMs: 1000, browser: { channel: 'fixture', profileDirectory: 'own' } });
  const launcher = { launchPersistent: async () => context as unknown as BrowserContext }, runtime = createBrowserRuntime({ runtimeRoot: root, launcher });
  const owner = { installationId: fixtureId(1), profilePersonId: fixtureId(2) };
  const handle = useRuntime ? await runtime.startRecording({ owner, profile, startUrl: frame.url(), authenticatedSelector: '#ready' }, new AbortController().signal) : null;
  const started = handle ? { recordingId: handle.handleId } : await startRecording(root, 'owner', profile, frame.url(), true, '#ready', undefined, { workbenchRecording: true, launcher });
  const emit = (event: unknown) => binding({ page, frame }, event);
  const download = async (bytes: Buffer, completed: Promise<string | null> = Promise.resolve(null)) => {
    const file = path.join(root, 'sample.csv'); await writeFile(file, bytes); let cancelled = false;
    const item = { failure: () => completed, path: async () => file, suggestedFilename: () => 'sample.csv', delete: async () => {}, cancel: async () => { cancelled = true; } };
    const pending = Promise.all(pageEvents.listeners('download').map(listener => listener(item as unknown as Download)));
    return { pending, cancelled: () => cancelled };
  };
  return { root, started, runtime, owner, emit, download, authenticate: () => { authenticated = true; }, emitForeign: (event: unknown) => binding({ page, frame: { url: () => 'https://sso.example.invalid/login' } }, event), masks, closed: () => closed, page: page as unknown as Page };
}
it('ends automatically only after completed nonempty download, retaining the last click and no field values', async () => {
  const f = await fixture();
  await f.emit({ action: 'fill', locator: { kind: 'css', selector: '#period' }, parameter: 'field_period' });
  expect(f.masks).toEqual([]); f.authenticate();
  await f.emit({ action: 'fill', locator: { kind: 'css', selector: '#period' }, parameter: 'field_period' });
  let complete!: (failure: string | null) => void; const completion = new Promise<string | null>(resolve => { complete = resolve; });
  const file = await f.download(Buffer.from('Value\n92'), completion);
  await f.emit({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  expect(f.closed()).toBe(false); expect(file.cancelled()).toBe(false);
  complete(null); await file.pending; await waitForRecordingComplete(f.root, 'owner', f.started.recordingId);
  expect(f.closed()).toBe(true);
  const result = await finishRecording(f.root, 'owner', f.started.recordingId, false);
  expect(result.workbenchSteps).toEqual([{ action: 'fill', locator: { kind: 'css', selector: '#period' }, parameter: 'field_period' }, { action: 'download', locator: { kind: 'css', selector: '#export' } }]);
  expect(result.completedDownload).toBe(true); expect(f.masks[0][0]).toContain('input,textarea,select');
  expect(await finishRecording(f.root, 'owner', f.started.recordingId, false)).toEqual(result);
  await expect(finishRecording(f.root, 'other', f.started.recordingId, false)).rejects.toMatchObject({ code: 'access_denied' });
});
it('rejects failed/empty downloads and ambiguous targets without declaring a completed recording', async () => {
  const f = await fixture(); f.authenticate();
  await f.emit({ action: 'click', locator: { kind: 'css', selector: '#ambiguous' } });
  await expect(finishRecording(f.root, 'owner', f.started.recordingId, false)).rejects.toMatchObject({ code: 'configuration_required' });
  const empty = await fixture(); empty.authenticate(); await empty.emit({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  const file = await empty.download(Buffer.alloc(0)); await file.pending;
  await expect(waitForRecordingComplete(empty.root, 'owner', empty.started.recordingId)).rejects.toMatchObject({ code: 'format' });
  await expect(finishRecording(empty.root, 'owner', empty.started.recordingId, false)).rejects.toMatchObject({ code: 'format' });
  const failed = await fixture(); failed.authenticate(); await failed.emit({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  const interrupted = await failed.download(Buffer.from('Value\n92'), Promise.resolve('interrupted')); await interrupted.pending;
  expect(interrupted.cancelled()).toBe(true);
  await expect(waitForRecordingComplete(failed.root, 'owner', failed.started.recordingId)).rejects.toMatchObject({ code: 'incomplete' });
  const foreign = await fixture(); foreign.authenticate(); await foreign.emitForeign({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  await expect(finishRecording(foreign.root, 'owner', foreign.started.recordingId, false)).rejects.toMatchObject({ code: 'configuration_required' });
});
it('uses the trusted own profile and denies foreign recording screenshots and viewer recording', async () => {
  const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { channel: 'fixture', profileDirectory: 'own' } });
  const calls: unknown[] = [], recordingId = fixtureId(70), screenshotId = fixtureId(71);
  const runtime = { startRecording: async (input: unknown) => { calls.push(input); return { handleId: recordingId, mode: 'record', state: 'open' }; }, finish: async () => ({ recordingId, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready', steps: [], parameterNames: [], screenshotHandles: [screenshotId], hasDownload: false }), screenshot: async () => ({ bytes: Buffer.from('png'), mediaType: 'image/png' }) } as unknown as BrowserRuntimePort;
  const context = { installationId: fixtureId(1), ownAccess: { role: 'curator', personId: fixtureId(2), policyState: 'verified' }, repository: {} } as CommandContext;
  const service = createBrowserRecorderService({ runtime, repository: { readPublishedHead: () => ({ ...makeHeader(3), kind: 'qlik' }) } as unknown as CommandContext['repository'], jobs: {} as never, clock: { now: () => '2026-10-28T09:00:00Z' }, profiles: { getOwn: async () => ({ configured: true, profile }), set: async () => { throw Error(); } } as never });
  const input = { sourceRef: { entityType: 'source_definition', id: fixtureId(3), revision: 1 }, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready' };
  await expect(service.start({ ...context, ownAccess: { ...context.ownAccess, role: 'viewer' } }, input)).rejects.toMatchObject({ statusCode: 403 });
  const opened = await service.start(context, input); expect(opened.recordingId).toBe(recordingId);
  expect(calls[0]).toMatchObject({ owner: { installationId: fixtureId(1), profilePersonId: fixtureId(2) }, profile });
  const foreign = { ...context, installationId: fixtureId(9) };
  await expect(service.finish(foreign, { recordingId, save: false })).rejects.toMatchObject({ statusCode: 404 });
  await service.finish(context, { recordingId, save: false });
  await expect(service.screenshot(foreign, recordingId, screenshotId)).rejects.toMatchObject({ statusCode: 404 });
  expect((await service.screenshot(context, recordingId, screenshotId)).mediaType).toBe('image/png');
});
it('starts through the actual published repository boundary while checking the requested source revision', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-recorded-export-')); roots.push(root);
  const repository = createWorkbenchRepository({ filename: path.join(root, 'workbench.sqlite'), artifactRoot: path.join(root, 'artifacts') });
  try {
    const graph = makeEntityGraph(); seedGraph(repository, graph);
    const source = graph.entries.find(entry => entry.entityType === 'source_definition')!.value;
    const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { channel: 'fixture', profileDirectory: 'own' } });
    let opens = 0;
    const runtime = { startRecording: async () => { opens++; return { handleId: fixtureId(70), mode: 'record', state: 'open' }; } } as unknown as BrowserRuntimePort;
    const context = { installationId: fixtureId(1), ownAccess: { role: 'curator', personId: fixtureId(2), policyState: 'verified' }, repository } as CommandContext;
    const service = createBrowserRecorderService({ runtime, repository, jobs: {} as never, clock: { now: () => '2026-10-28T09:00:00Z' }, profiles: { getOwn: async () => ({ configured: true, profile }), set: async () => { throw Error(); } } as never });
    const input = { sourceRef: { entityType: 'source_definition', id: source.id, revision: source.revision }, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready' };
    expect(await service.start(context, input)).toEqual({ recordingId: fixtureId(70), state: 'recording' });
    await expect(service.start(context, { ...input, sourceRef: { ...input.sourceRef, revision: source.revision + 1 } })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(opens).toBe(1);
  } finally { repository.close(); }
});
it('closes owned context promptly while download completion is unresolved', async () => {
  const f = await fixture(true); f.authenticate();
  await f.emit({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  let cleanup!: (failure: string | null) => void;
  const file = await f.download(Buffer.from('Value\n92'), new Promise(resolve => { cleanup = resolve; }));
  const closing = f.runtime.closeOwned(f.owner);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.closed()).toBe(true);
    await closing; await file.pending;
    expect(file.cancelled()).toBe(true);
  } finally { cleanup('test cleanup'); await closing; }
});
it('records a real authenticated Edge export, ends on completion, and replays exact label and role actions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-recorded-export-')); roots.push(root);
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/export')) { res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=report.csv' }).end('Value\n92'); return; }
    if (req.url === '/frame') { res.setHeader('content-type', 'text/html'); res.end('<label for="group">Group</label><input id="group">'); return; }
    res.setHeader('content-type', 'text/html'); res.end('<div data-authentication><input id="otp" autocomplete="one-time-code"><button id="login">Log in</button></div><div id="ready" hidden>Report</div><label for="period">Period</label><input id="period"><iframe id="report-frame" src="/frame"></iframe><a id="export" aria-label="Export" href="/export">Export</a><script>const login=()=>{document.querySelector("[data-authentication]")?.remove();document.querySelector("#ready").hidden=false;localStorage.setItem("fixture-auth","yes")};document.querySelector("#login")?.addEventListener("click",login);if(localStorage.getItem("fixture-auth"))login();</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const contexts: BrowserContext[] = [];
  const profile = privateProfileSchema.parse({ allowedOrigins: [origin], timeoutMs: 5000, browser: { channel: 'msedge', profileDirectory: 'own', headless: true } });
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { launchPersistent: async (_profile, folder, options) => { expect(options.downloadsPath).toBeTruthy(); expect(options.ignoreHTTPSErrors).toBe(false); const context = await chromium.launchPersistentContext(folder, { ...options, headless: true }); contexts.push(context); return context; } } });
  const owner = { installationId: fixtureId(1), profilePersonId: fixtureId(2) };
  try {
    const handle = await runtime.startRecording({ owner, profile, startUrl: origin + '/report', authenticatedSelector: '#ready' }, new AbortController().signal);
    const page = contexts[0].pages()[0];
    await page.locator('#otp').fill('synthetic-one-time-secret'); await page.locator('#login').click();
    await page.locator('#ready').waitFor({ state: 'visible' });
    await page.getByLabel('Period', { exact: true }).fill('2026-10'); await page.locator('#period').dispatchEvent('change');
    await page.evaluate(async () => { await (window as unknown as { __uorRecorderDrain: () => Promise<void> }).__uorRecorderDrain(); });
    await page.frameLocator('#report-frame').getByLabel('Group', { exact: true }).fill('synthetic-group'); await page.frameLocator('#report-frame').locator('#group').dispatchEvent('change');
    await page.frameLocator('#report-frame').locator('body').evaluate(async () => { await (window as unknown as { __uorRecorderDrain: () => Promise<void> }).__uorRecorderDrain(); });
    await page.getByRole('link', { name: 'Export', exact: true }).click();
    const recording = await runtime.waitForCompletion({ handleId: handle.handleId, owner });
    expect(recording.hasDownload).toBe(true); expect(recording.steps).toEqual([{ action: 'fill', locator: { kind: 'label', text: 'Period', exact: true }, parameter: 'field_period' }, { action: 'fill', locator: { kind: 'label', text: 'Group', exact: true }, parameter: 'field_group', framePath: [{ kind: 'css', selector: '#report-frame' }] }, { action: 'download', locator: { kind: 'role', role: 'link', name: 'Export', exact: true } }]);
    expect(JSON.stringify(recording)).not.toMatch(/synthetic-one-time-secret|2026-10|#login|#otp/);
    expect(await runtime.finish({ handleId: handle.handleId, owner, save: false })).toEqual(recording);
    const screenshot = await runtime.screenshot({ owner, recordingId: recording.recordingId, handleId: recording.screenshotHandles[0] }); expect(Buffer.from(screenshot.bytes).subarray(1, 4).toString()).toBe('PNG');
    await expect(runtime.screenshot({ owner: { ...owner, profilePersonId: fixtureId(9) }, recordingId: recording.recordingId, handleId: recording.screenshotHandles[0] })).rejects.toMatchObject({ statusCode: 404 });
    const file = await runtime.replay({ owner, profile, scenario: { ...makeHeader(90), sourceId: fixtureId(3), startUrl: origin + '/report', authenticatedSelector: '#ready', steps: recording.steps, parameters: { field_period: '2026-10', field_group: 'synthetic-group' }, expectedExport: { format: 'csv', requiredColumns: ['Value'] } } }, new AbortController().signal);
    expect(file.bytes.toString()).toBe('Value\n92');
  } finally { await runtime.closeOwned(owner); await Promise.all(contexts.map(context => context.close().catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);
