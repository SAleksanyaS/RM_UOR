import { browserPolicyCdpFixture } from '../../../tests/fixtures/workbench/browser-policy-cdp';
import { createOkoWorkflowStore } from './workbench-workflow-store';
import { testBrowserSelection } from '../../../tests/fixtures/workbench/test-browser-selection';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
// The recorder picks the artifact up from disk; tests must not wait for the stability window.
process.env.UOR_DOWNLOAD_SETTLE_MS = '0';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(useRuntime = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-recorded-export-')); roots.push(root);
  // For the real runtime the directory is created by the launcher, so it is read back from the trace.
  const engineDirectory = async () => {
    let found = ''; const walk = async (directory: string) => { for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = path.join(directory, entry.name); if (!entry.isDirectory()) continue;
      if (entry.name === 'browser-downloads') { const child = (await readdir(next))[0]; if (child) found = path.join(next, child); return; }
      await walk(next);
    } };
    await walk(root); return found;
  };
  let authenticated = false, binding!: (source: unknown, event: unknown) => Promise<void>, closed = false;
  const masks: string[][] = [], pageEvents = new EventEmitter();
  const frame = { url: () => 'https://report.example.invalid/report' };
  const locator = (selector: string) => ({ selector, count: async () => selector === '#ambiguous' ? 2 : 1, isVisible: async () => authenticated,
    evaluateAll: async () => !authenticated,
    evaluate: async (fn:Function) => fn.toString().includes("a[href]")?(selector==='#export'?'https://report.example.invalid/export':null):false, });
  const page = Object.assign(pageEvents, { goto: async () => {}, url: frame.url, mainFrame: () => frame, locator,
    screenshot: async (options: { path: string; mask: Array<{ selector: string }> }) => { masks.push(options.mask.map(mask => mask.selector)); await writeFile(options.path, Buffer.from('synthetic-png')); },
    evaluate: async () => {}, });
  // `once('close')` and `on('page')` are read from the context itself, so the context is the emitter: a closed
  // window must notify the recorder exactly as the real one does.
  const context = Object.assign(new EventEmitter(), { pages: () => [page], setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    newCDPSession: async () => browserPolicyCdpFixture(), setOffline: async () => {}, route: async () => {}, routeWebSocket: async () => {},
    exposeBinding: async (_name: string, callback: typeof binding) => { binding = callback; }, addInitScript: async () => {},
    close: async () => { if (!closed) { closed = true; context.emit('close'); } } });
  const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], timeoutMs: 8000, browser: { channel: 'fixture', profileDirectory: 'own' } });
  const launcher = { launchPersistent: async (_profile: unknown, _folder: string, launchOptions: { downloadsPath?: string }) => { await launchOptions.downloadsPath; return context as unknown as BrowserContext; } }, runtime = createBrowserRuntime({ runtimeRoot: root, launcher });
  const owner = { installationId: fixtureId(1), profilePersonId: fixtureId(2) };
  const handle = useRuntime ? await runtime.startRecording({ owner, profile, startUrl: frame.url(), authenticatedSelector: '#ready' }, new AbortController().signal) : null;
  const started = handle ? { recordingId: handle.handleId } : await startRecording(root, 'owner', profile, frame.url(), true, '#ready', undefined, { workbenchRecording: true, launcher });
  const emit = (event: unknown) => binding({ page, frame }, event);
  const download = async (bytes: Buffer, completed: Promise<string | null> = Promise.resolve(null), suggested = 'sample.csv', target?: string,sourceEvents:EventEmitter=pageEvents) => {
    const file = path.join(root, 'sample.csv'); await writeFile(file, bytes); let cancelled = false;
    // The real engine drops the archive a moment after the event: both forms are covered here.
    // An intact ZIP is the only format the recorder verifies, so a spreadsheet is written as a real archive.
    const payload=bytes;
    const written = path.join(target ?? await engineDirectory(), suggested.endsWith('.csv') ? `${randomUUID()}.crdownload` : `${randomUUID()}${path.extname(suggested)}`);
    await mkdir(path.dirname(written), { recursive: true }); await writeFile(written, payload);
    sourceEvents.emit('request',{isNavigationRequest:()=>true,method:()=> 'GET',frame:()=>frame,url:()=> 'https://report.example.invalid/export',redirectedFrom:()=>null});
    const item = {url:()=> 'https://report.example.invalid/export',failure: () => completed, path: async () => file, suggestedFilename: () => suggested, delete: async () => {}, cancel: async () => { cancelled = true; },
      // `saveAs` needs a live connection: the closed window must not be the reason a file disappears.
      saveAs: async (target: string) => { if (closed) throw new Error('saveAs: Target page, context or browser has been closed'); await writeFile(target, await readFile(file)); } };
    const pending = Promise.all(sourceEvents.listeners('download').map(listener => listener(item as unknown as Download)));
    return { pending, cancelled: () => cancelled };
  };
  return { root, started, runtime, owner, emit, download, engineDirectory, authenticate: () => { authenticated = true; }, emitForeign: (event: unknown) => binding({ page, frame: { url: () => 'https://sso.example.invalid/login' } }, event), masks, closed: () => closed, page: page as unknown as Page, context: () => context as unknown as BrowserContext };
}
it('ends automatically only after completed nonempty download, retaining the last click and no field values', async () => {
  const f = await fixture();
  await f.emit({ action: 'fill', locator: { kind: 'css', selector: '#period' }, parameter: 'field_period' });
  expect(f.masks).toEqual([]); f.authenticate();
  await f.emit({ action: 'fill', locator: { kind: 'css', selector: '#period' }, parameter: 'field_period' });
  let complete!: (failure: string | null) => void; const completion = new Promise<string | null>(resolve => { complete = resolve; });
  // The engine places the artifact in the directory the launcher created, not in a fixture folder.
  await f.emit({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  const file = await f.download(Buffer.from('Value\n92'), completion, 'sample.csv', await f.engineDirectory());
  expect(f.closed()).toBe(false); expect(file.cancelled()).toBe(false);
  complete(null); await file.pending; await waitForRecordingComplete(f.root, 'owner', f.started.recordingId);
  expect(f.closed()).toBe(true);
  const result = await finishRecording(f.root, 'owner', f.started.recordingId, false);
  expect(result.workbenchSteps).toEqual([{ action: 'fill', locator: { kind: 'css', selector: '#period' }, parameter: 'field_period' }, { action: 'download', locator: { kind: 'css', selector: '#export' } }]);
  expect(result.completedDownload).toBe(true); expect(f.masks[0][0]).toContain('input,textarea,select');
  expect(await finishRecording(f.root, 'owner', f.started.recordingId, false)).toEqual(result);
  await expect(finishRecording(f.root, 'other', f.started.recordingId, false)).rejects.toMatchObject({ code: 'access_denied' });
});
it('treats an unaddressable element as a gap and still ends the recording on the download', async () => {
  const f = await fixture(true), input = { owner: f.owner, handleId: f.started.recordingId };
  f.authenticate();
  await f.emit({ action: 'unsupported' });
  expect(f.closed()).toBe(false);
  expect(await f.runtime.readRecordingStatus(input)).toEqual({ state: 'recording', problem: null });
  const file = await f.download(Buffer.from('Value\n92'), undefined, 'sample.csv', await f.engineDirectory()); await file.pending;
  expect(f.closed()).toBe(true);
  expect(await f.runtime.readRecordingStatus(input)).toEqual({ state: 'completed', problem: null });
  expect((await f.runtime.finish({ ...input, save: false })).steps).toEqual([]);
});

it('keeps a finished download even when the report closes its own window during the export', async () => {
  const f = await fixture(); f.authenticate();
  // The report tears its page down right after the export: the artifact is already on disk at that point.
  const pending = f.download(Buffer.from('Value\n92'), undefined, 'sample.csv', await f.engineDirectory());
  await f.emit({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  await f.context().close();
  expect(f.closed()).toBe(true);
  const file = await pending; await file.pending;
  await waitForRecordingComplete(f.root, 'owner', f.started.recordingId);
  expect(file.cancelled()).toBe(false);
  const result = await finishRecording(f.root, 'owner', f.started.recordingId, false);
  expect(result.completedDownload).toBe(true);
  expect(result.workbenchSteps?.at(-1)).toEqual({ action: 'download', locator: { kind: 'css', selector: '#export' } });
});

it('quarantines a truncated XLS export instead of claiming successful completion', async () => {
  const f = await fixture(); f.authenticate();
  const file = await f.download(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), undefined, 'report.xls', await f.engineDirectory());
  await file.pending;
  await expect(waitForRecordingComplete(f.root,'owner',f.started.recordingId)).rejects.toMatchObject({code:'format'});
});

it('rejects failed/empty downloads and ambiguous targets without declaring a completed recording', async () => {
  const f = await fixture(); f.authenticate();
  await f.emit({ action: 'click', locator: { kind: 'css', selector: '#ambiguous' } });
  await expect(finishRecording(f.root, 'owner', f.started.recordingId, false)).rejects.toMatchObject({ code: 'configuration_required' });
  const empty = await fixture(); empty.authenticate(); await empty.emit({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  const emptyFile = await empty.download(Buffer.alloc(0), undefined, 'sample.csv', await empty.engineDirectory()); await emptyFile.pending;
  await expect(waitForRecordingComplete(empty.root, 'owner', empty.started.recordingId)).rejects.toMatchObject({ code: 'incomplete' });
  await expect(finishRecording(empty.root, 'owner', empty.started.recordingId, false)).rejects.toMatchObject({ code: 'incomplete' });
  const failed = await fixture(); failed.authenticate(); await failed.emit({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  // A failure reported by the engine no longer discards a file that is already complete on disk:
  // reports routinely close the page on export and the engine reports that as an interruption.
  const interrupted = await failed.download(Buffer.from('Value\n92'), Promise.resolve('interrupted'), 'sample.csv', await failed.engineDirectory()); await interrupted.pending;
  expect(interrupted.cancelled()).toBe(false);
  await waitForRecordingComplete(failed.root, 'owner', failed.started.recordingId);
  expect((await finishRecording(failed.root, 'owner', failed.started.recordingId, false)).completedDownload).toBe(true);
  const foreign = await fixture(); foreign.authenticate(); await foreign.emitForeign({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  await expect(finishRecording(foreign.root, 'owner', foreign.started.recordingId, false)).rejects.toMatchObject({ code: 'configuration_required' });
});
it('uses the trusted own profile and denies foreign recording screenshots and viewer recording', async () => {
  const profile = privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { channel: 'fixture', profileDirectory: 'own' } });
  const calls: unknown[] = [], recordingId = fixtureId(70), screenshotId = fixtureId(71);
  const runtime = { startRecording: async (input: unknown) => { calls.push(input); return { handleId: recordingId, mode: 'record', state: 'open' }; }, finish: async () => ({ recordingId, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#ready', steps: [], parameterNames: [], screenshotHandles: [screenshotId], hasDownload: false }), screenshot: async () => ({ bytes: Buffer.from('png'), mediaType: 'image/png' }) } as unknown as BrowserRuntimePort;
  const context = { installationId: fixtureId(1), ownAccess: { role: 'curator', personId: fixtureId(2), policyState: 'verified' }, repository: {} } as CommandContext;
  const service = createBrowserRecorderService({ runtime, repository: { readPublishedHead: () => ({ ...makeHeader(3), kind: 'qlik' }) } as unknown as CommandContext['repository'], jobs: {} as never, clock: { now: () => '2026-10-28T09:00:00Z' }, profiles: { getOwn: async () => ({ configured: true, profile, revision: null }), set: async () => { throw Error(); } } as never });
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
    const service = createBrowserRecorderService({ runtime, repository, jobs: {} as never, clock: { now: () => '2026-10-28T09:00:00Z' }, profiles: { getOwn: async () => ({ configured: true, profile, revision: null }), set: async () => { throw Error(); } } as never });
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
  const unfinished = await f.download(Buffer.from('Value\n92'), new Promise(resolve => { cleanup = resolve; }), 'sample.csv', await f.engineDirectory());
  const closing = f.runtime.closeOwned(f.owner);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.closed()).toBe(true);
    await closing; await unfinished.pending;
    // Closing the window must not discard an artifact that is already complete on disk.
    expect(unfinished.cancelled()).toBe(false);
  } finally { cleanup('test cleanup'); await closing; }
});
it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE)('records an explicitly selected synthetic native browser export, ends on completion, and replays exact label and role actions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-recorded-export-')); roots.push(root);
  let exportHtml=false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/export')) { res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=report.csv' }).end(exportHtml?'<html>Sign in</html>':'Value\n92'); return; }
    if (req.url === '/frame') { res.setHeader('content-type', 'text/html'); res.end('<label for="group">Group</label><input id="group">'); return; }
    res.setHeader('content-type', 'text/html'); res.end('<div data-authentication><input id="otp" autocomplete="one-time-code"><button id="login">Log in</button></div><div id="ready" hidden>Report</div><label for="period">Period</label><input id="period"><iframe id="report-frame" src="/frame"></iframe><button id="expand-filters">Expand filters</button><button id="js-export" data-export="/export" onclick="location.assign(this.dataset.export)">JS export</button><a id="export" aria-label="Export" href="/export">Export</a><script>const login=()=>{document.querySelector("[data-authentication]")?.remove();document.querySelector("#ready").hidden=false;localStorage.setItem("fixture-auth","yes")};document.querySelector("#login")?.addEventListener("click",login);if(localStorage.getItem("fixture-auth"))login();</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const contexts: BrowserContext[] = [];
  const profile = privateProfileSchema.parse({ allowedOrigins: [origin], timeoutMs: 5000, browser: { ...testBrowserSelection(), profileDirectory: 'own', headless: true } });
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { launchPersistent: async (_profile, folder, options) => { expect(options.downloadsPath).toBeTruthy(); expect(options.ignoreHTTPSErrors).toBe(false); const context = await chromium.launchPersistentContext(folder, { ...options, headless: true,...(process.env.UOR_TEST_CI_NO_SANDBOX==='1'?{chromiumSandbox:false}:{}) }); contexts.push(context); return context; } } });
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
    // Real ordinary-click timer downloads stay raw-only; explicit JS action selection remains testable.
    for(const kind of ['timer','js'] as const){const handle=await runtime.startRecording({owner,profile,startUrl:origin+'/report',authenticatedSelector:'#ready'},new AbortController().signal),active=contexts.at(-1)!.pages()[0];await active.locator('#ready').waitFor({state:'visible'});await active.locator(kind==='timer'?'#expand-filters':'#js-export').click();if(kind==='timer')await active.evaluate(()=>{location.assign('/export');});const captured=await runtime.waitForCompletion({owner,handleId:handle.handleId});expect(captured.hasDownload).toBe(true);expect(captured.steps).toHaveLength(1);expect(captured.steps[0].action).toBe('click');
      if(kind==='js'){if(captured.steps[0].action!=='click')throw Error('Expected recorded click');const selected={...captured.steps[0],action:'download' as const};const tested=await runtime.replay({owner,profile,scenario:{...makeHeader(91),sourceId:fixtureId(3),startUrl:origin+'/report',authenticatedSelector:'#ready',steps:[selected],parameters:{},expectedExport:{format:'raw',requiredColumns:[]}}},new AbortController().signal);expect(tested.bytes.toString()).toBe('Value\n92');}
    }
    // Acquisition-only replay and auth continuation must retain suspect bytes while reporting failure.
    exportHtml=true;const repository=createWorkbenchRepository({filename:path.join(root,'quarantine.sqlite'),artifactRoot:root}),store=createOkoWorkflowStore(repository),ownerKey=owner.installationId+'/'+owner.profilePersonId;
    try{for(const authContinuation of [false,true]){const intent=store.beginCapture(ownerKey,{schemaVersion:1,captureId:randomUUID(),operationId:randomUUID(),workflowId:fixtureId(90),sourceId:fixtureId(3),title:'Synthetic',origin:'repeat',createdAt:new Date().toISOString()}),capture={intent,sink:{stage:(binding:import('./workbench-capture-contracts').CaptureStaging)=>store.stageCapture(ownerKey,intent.captureId,binding),commit:async(download:import('./transport').Downloaded)=>store.commitCapture(ownerKey,intent.captureId,download)}};const login=authContinuation?await runtime.openLogin({owner,profile,startUrl:origin+'/report',authenticatedSelector:'#ready'},new AbortController().signal):null;
      await expect(runtime.replay({owner,profile,scenario:{...makeHeader(90),sourceId:fixtureId(3),startUrl:origin+'/report',authenticatedSelector:'#ready',steps:recording.steps,parameters:{field_period:'2026-10',field_group:'synthetic-group'},expectedExport:{format:'raw',requiredColumns:[]}},capture,...(login?{loginHandleId:login.handleId}:{})},new AbortController().signal)).rejects.toMatchObject({code:'format'});
      const receipt=store.captureReceipt(ownerKey,intent.captureId)!;expect(receipt.formatStatus).toBe('quarantined');const saved=store.getExport<{artifact:{base64:string}}>(ownerKey,receipt.exportId)!;expect(Buffer.from(saved.payload.artifact.base64,'base64').toString()).toBe('<html>Sign in</html>');
    }}finally{repository.close();}

  } finally { await runtime.closeOwned(owner); await Promise.all(contexts.map(context => context.close().catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);
it('reads recording status without ending it and privately retains an owner-bound sample after finish', async () => {
  const f = await fixture(true), input = { owner: f.owner, handleId: f.started.recordingId };
  expect(await f.runtime.readRecordingStatus(input)).toEqual({ state: 'recording', problem: null });
  expect(f.closed()).toBe(false);
  await expect(f.runtime.readRecordingDownload(input)).rejects.toMatchObject({ code: 'incomplete' });
  f.authenticate(); await f.emit({ action: 'click', locator: { kind: 'css', selector: '#export' } });
  const file = await f.download(Buffer.from('Value\n92')); await file.pending;
  expect(await f.runtime.readRecordingStatus(input)).toEqual({ state: 'completed', problem: null });
  await f.runtime.finish({ ...input, save: false });
  const sample = await f.runtime.readRecordingDownload(input); expect(Buffer.from(sample.bytes).toString()).toBe('Value\n92');
  sample.bytes[0] = 0;
  expect(Buffer.from((await f.runtime.readRecordingDownload(input)).bytes).toString()).toBe('Value\n92');
  await expect(f.runtime.readRecordingDownload({ ...input, owner: { ...f.owner, profilePersonId: fixtureId(99) } })).rejects.toMatchObject({ statusCode: 404 });
  expect((await createBrowserRuntime({ runtimeRoot: f.root }).readRecordingStatus(input)).state).toBe('interrupted');
});

it('keeps ordinary expand-filters click nonreplayable when a timer produces an unrelated file',async()=>{
 const f=await fixture(true),input={owner:f.owner,handleId:f.started.recordingId};f.authenticate();await f.emit({action:'click',locator:{kind:'css',selector:'#expand-filters'}});const file=await f.download(Buffer.from('Value\n92'));await file.pending;const recorded=await f.runtime.finish({...input,save:false});expect(recorded.hasDownload).toBe(true);expect(recorded.steps).toEqual([{action:'click',locator:{kind:'css',selector:'#expand-filters'}}]);expect((await f.runtime.readRecordingDownload(input)).bytes.toString()).toBe('Value\n92');
});

it('rejects a new report popup before an unrelated download can certify the recorded export click',async()=>{
 const f=await fixture(true),input={owner:f.owner,handleId:f.started.recordingId};f.authenticate();await f.emit({action:'click',locator:{kind:'css',selector:'#export'}});
 // The report contract now retains one tab. A second tab is rejected before
 // it can supply either a replay step or a supposedly completed artifact.
 (f.context() as unknown as EventEmitter).emit('page',new EventEmitter());
 await expect(f.runtime.waitForCompletion(input)).rejects.toMatchObject({code:'incomplete'});
 await expect(f.runtime.readRecordingDownload(input)).rejects.toMatchObject({code:'incomplete'});
 expect((await f.runtime.readRecordingStatus(input)).state).toBe('failed');
});

it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE)('correlates only the exact successful GET form submission including controls and submitter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-recorded-form-')); roots.push(root);
  const requests: Array<{ url: string; method: string }> = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/export')) { requests.push({ url: request.url, method: request.method! }); request.resume(); response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=report.csv' }).end('Value\n92'); return; }
    const kind = new URL(request.url!, 'http://fixture').searchParams.get('kind');
    response.setHeader('content-type', 'text/html');
    response.end('<div id="ready">Report</div><form action="/export?discard=old" method="' + (kind === 'post' ? 'post' : 'get') + '"><input name="period" value="October 2026"><input name="tag" value="a"><input name="tag" value="b"><input name="disabled" value="secret" disabled><input type="checkbox" name="checked" value="yes" checked><input type="checkbox" name="unchecked" value="no"><button id="export" name="format" value="csv" formaction="/export?ignored=old">Export</button></form>' + (kind === 'mismatch' ? '<script>document.querySelector("form").onsubmit=event=>{event.preventDefault();location.assign("/export?unrelated=1")}</script>' : ''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, contexts: BrowserContext[] = [];
  const profile = privateProfileSchema.parse({ allowedOrigins: [origin], timeoutMs: 5000, browser: { ...testBrowserSelection(), profileDirectory: 'own', headless: true } });
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { async launchPersistent(_profile, folder, options) { expect(options.ignoreHTTPSErrors).toBe(false); const context = await chromium.launchPersistentContext(folder, { ...options, headless: true, ...(process.env.UOR_SYNTHETIC_CI === '1' ? { chromiumSandbox: false } : {}) }); contexts.push(context); return context; } } });
  const owner = { installationId: fixtureId(1), profilePersonId: fixtureId(2) };
  try {
    for (const kind of ['get', 'mismatch', 'post']) {
      const handle = await runtime.startRecording({ owner, profile, startUrl: origin + '/report?kind=' + kind, authenticatedSelector: '#ready' }, new AbortController().signal);
      await contexts.at(-1)!.pages()[0].locator('#export').click();
      const recording = await runtime.waitForCompletion({ owner, handleId: handle.handleId });
      expect(recording.hasDownload).toBe(true);
      expect(recording.steps, kind).toEqual([{ action: kind === 'get' ? 'download' : 'click', locator: { kind: 'css', selector: '#export' } }]);
      if (kind === 'get') expect(requests.at(-1)).toEqual({ method: 'GET', url: '/export?period=October+2026&tag=a&tag=b&checked=yes&format=csv' });
      if (kind === 'post') expect(requests.at(-1)?.method).toBe('POST');
      await runtime.finish({ owner, handleId: handle.handleId, save: false });
    }
  } finally { await runtime.closeOwned(owner); await Promise.all(contexts.map(context => context.close().catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);

it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE).each([
  {
    name: 'preserves the empty query of a GET form without named successful controls',
    html: '<form action="/export?discard=old"><button id="export">Export</button></form>',
    url: '/export?', method: 'GET', action: 'download',
  },
  {
    name: 'normalizes textarea newlines before matching a GET download',
    html: '<form action="/export"><textarea name="filter">first\nsecond</textarea><button id="export">Export</button></form>',
    url: '/export?filter=first%0D%0Asecond', method: 'GET', action: 'download',
  },
  {
    name: 'normalizes CR, LF and CRLF in control names, string values and filenames',
    html: '<form action="/export"><input type="hidden" name="tag&#13;x&#10;y&#13;&#10;z" value="a&#13;b&#10;c&#13;&#10;d"><input type="file" id="upload" name="file"><button id="export">Export</button></form>',
    filename: 'report\ra\nb\r\nc.csv',
    url: '/export?tag%0D%0Ax%0D%0Ay%0D%0Az=a%0D%0Ab%0D%0Ac%0D%0Ad&file=report%0D%0Aa%0D%0Ab%0D%0Ac.csv', method: 'GET', action: 'download',
  },
  {
    name: 'records a GET form whose action property is shadowed by a successful control',
    html: '<form action="/export"><input type="hidden" name="action" value="export"><button id="export">Export</button></form>',
    url: '/export?action=export', method: 'GET', action: 'download',
  },
  {
    name: 'records a GET form whose method property is shadowed by a successful control',
    html: '<form action="/export" method="get"><input type="hidden" name="method" value="csv"><button id="export">Export</button></form>',
    url: '/export?method=csv', method: 'GET', action: 'download',
  },
  {
    name: 'uses the submitter GET method and action overrides with duplicate controls',
    html: '<form action="/unused" method="post"><input name="tag" value="a"><input name="tag" value="b"><button id="export" name="format" value="csv" formmethod="get" formaction="/export?discard=old">Export</button></form>',
    url: '/export?tag=a&tag=b&format=csv', method: 'GET', action: 'download',
  },
  {
    name: 'uses the document URL for a missing form action despite a different base URL',
    html: '<base href="/different/"><form><button id="export" name="format" value="csv">Export</button></form>',
    url: '/report?format=csv', method: 'GET', action: 'download',
  },
  {
    name: 'uses native defaults for an empty action and invalid method',
    html: '<base href="/different/"><form action="" method="invalid"><button id="export" name="format" value="csv">Export</button></form>',
    url: '/report?format=csv', method: 'GET', action: 'download',
  },
  {
    name: 'keeps a POST download nonreplayable when its method property is shadowed',
    html: '<form action="/export?post=1" method="post"><input type="hidden" name="method" value="get"><button id="export">Export</button></form>',
    url: '/export?post=1', method: 'POST', action: 'click',
  },
  {
    name: 'retains a manual capture when an invalid form action cannot prove replayability',
    html: '<form action="http://[invalid" onsubmit="event.preventDefault();location.assign(\'/export?manual=1\')"><button id="export">Export</button></form>',
    url: '/export?manual=1', method: 'GET', action: 'click',
  },
])('native form serialization: $name', async ({ html, url, method, action, filename }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-recorded-form-semantics-')); roots.push(root);
  const requests: Array<{ url: string; method: string }> = [];
  const server = createServer((request, response) => {
    if (request.url === '/report?initial=1') { response.setHeader('content-type', 'text/html'); response.end('<div id="ready">Report</div>' + html); return; }
    if (request.url?.startsWith('/export') || request.url?.startsWith('/report?')) {
      requests.push({ url: request.url, method: request.method! }); request.resume();
      response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=report.csv' }).end('Value\n92'); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, contexts: BrowserContext[] = [];
  const profile = privateProfileSchema.parse({ allowedOrigins: [origin], timeoutMs: 5000, browser: { ...testBrowserSelection(), profileDirectory: 'own', headless: true } });
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { async launchPersistent(_profile, folder, options) {
    expect(options.ignoreHTTPSErrors).toBe(false); expect(options.chromiumSandbox).toBe(true);
    const context = await chromium.launchPersistentContext(folder, { ...options, headless: true, ...(process.env.UOR_SYNTHETIC_CI === '1' ? { chromiumSandbox: false } : {}) }); contexts.push(context); return context;
  } } });
  const owner = { installationId: fixtureId(1), profilePersonId: fixtureId(2) };
  try {
    const handle = await runtime.startRecording({ owner, profile, startUrl: origin + '/report?initial=1', authenticatedSelector: '#ready' }, new AbortController().signal);
    const page = contexts[0].pages()[0];
    if (filename) await page.locator('#upload').setInputFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from('Value\n1') });
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export').click()]);
    expect(download.url()).toBe(origin + url);
    expect(requests).toEqual([{ method, url }]);
    const recording = await runtime.waitForCompletion({ owner, handleId: handle.handleId });
    expect(recording.hasDownload).toBe(true);
    expect(recording.steps).toEqual([{ action, locator: { kind: 'css', selector: '#export' } }]);
    expect((await runtime.readRecordingDownload({ owner, handleId: handle.handleId })).bytes.toString()).toBe('Value\n92');
    await runtime.finish({ owner, handleId: handle.handleId, save: false });
  } finally { await runtime.closeOwned(owner); await Promise.all(contexts.map(context => context.close().catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);

it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE)('replays an asynchronously prepared export link only after its concrete target is visible', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-prepared-export-')); roots.push(root);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/export')) { requests.push(request.url); response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=report.csv' }).end('Value\n92'); return; }
    response.setHeader('content-type', 'text/html'); response.end('<div id="ready">Report</div><button id="prepare" onclick="setTimeout(()=>{const link=document.querySelector(\'#export\');link.href=\'/export?ready=1\';link.hidden=false},200)">Prepare</button><a id="export" href="/export?placeholder=1" hidden>Export</a>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, contexts: BrowserContext[] = [];
  const profile = privateProfileSchema.parse({ allowedOrigins: [origin], timeoutMs: 1000, browser: { ...testBrowserSelection(), profileDirectory: 'own', headless: true } });
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { async launchPersistent(_profile, folder, options) { expect(options.ignoreHTTPSErrors).toBe(false); const context = await chromium.launchPersistentContext(folder, { ...options, headless: true, ...(process.env.UOR_SYNTHETIC_CI === '1' ? { chromiumSandbox: false } : {}) }); contexts.push(context); return context; } } });
  const owner = { installationId: fixtureId(1), profilePersonId: fixtureId(2) };
  try {
    const file = await runtime.replay({ owner, profile, scenario: { ...makeHeader(91), sourceId: fixtureId(3), startUrl: origin + '/report', authenticatedSelector: '#ready', steps: [{ action: 'click', locator: { kind: 'css', selector: '#prepare' } }, { action: 'download', locator: { kind: 'css', selector: '#export' } }], parameters: {}, expectedExport: { format: 'csv', requiredColumns: ['Value'] } } }, new AbortController().signal);
    expect(file.bytes.toString()).toBe('Value\n92'); expect(requests).toEqual(['/export?ready=1']);
  } finally { await runtime.closeOwned(owner); await Promise.all(contexts.map(context => context.close().catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 10000);
