import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { okoWorkflowViewSchema, type OkoDictionaryMapping, type OkoWorkflowView, type OkoWorkspaceView } from '../../src/features/connectors/workbench-workflow-contracts';
import type { createWorkbenchRuntime } from '../../src/server/workbench/bootstrap';
import type { WorkbenchRuntimeProviders } from '../../src/server/workbench/runtime-contracts';
import type { createHttpDriver } from '../../tests/workbench/helpers/runtime';

type Runtime = Awaited<ReturnType<typeof createWorkbenchRuntime>>;
type Request = ReturnType<typeof createHttpDriver>;
type DownloadedReference = { fileName: string; mimeType: string; bytes: Buffer; url: string; sha256: string };

export type PersonalReferenceResult = {
  workflowId: string;
  resultId: string;
  rowCount: number;
  unresolvedRows: number;
  view: OkoWorkflowView;
  original: DownloadedReference;
  enriched: DownloadedReference;
  evidence: { nativeBrowserLaunches: number; reportDownloads: number };
};

const sourceRows = [
  ['P01', 'Платежи организаций', '1280,50', '30.10.2026'],
  ['P02', 'Переводы физлиц', '945,20', '30.10.2026'],
  ['P03', 'Расчётные счета', '612,75', '30.10.2026'],
  ['P04', 'Зарплатные проекты', '438,00', '30.10.2026'],
  ['P05', 'Эквайринг', '756,40', '30.10.2026'],
  ['P06', 'Дистанционное обслуживание', '1104,10', '30.10.2026'],
  ['P07', 'Документарные операции', '209,35', '30.10.2026'],
  ['P08', 'Новый продукт — проверить справочник', '84,60', '30.10.2026'],
];
const sourceBytes = Buffer.from('\ufeff' + [['Код продукта', 'Продукт', 'Объём', 'Дата'], ...sourceRows].map(row => row.join(';')).join('\r\n'));
const originalFileName = 'oko-operations-2026-10-30.csv';
const dictionaryFields = ['key', 'productId', 'productName', 'clusterId', 'clusterName', 'ditId', 'ditName', 'clusterLeaderId', 'clusterLeaderName', 'productLeaderId', 'productLeaderName'] as const;
const syntheticId = (number: number) => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
const productLeaders = ['Ирина Волкова', 'Алексей Орлов', 'Мария Лебедева', 'Дмитрий Соколов', 'Елена Морозова', 'Сергей Белов', 'Анна Крылова', 'Николай Зайцев'];
const dictionaryFile = (complete: boolean) => Buffer.from('\ufeff' + [dictionaryFields.join(';'), ...sourceRows.slice(0, complete ? 8 : 7).map((row, index) => {
  const corporate = index < 4;
  return [row[0], syntheticId(100 + index), row[1], syntheticId(corporate ? 200 : 201), corporate ? 'Корпоративные сервисы' : 'Клиентские сервисы', syntheticId(300), 'ДИТ операций · учебный пример', syntheticId(corporate ? 400 : 401), corporate ? 'Ольга Миронова' : 'Павел Громов', syntheticId(500 + index), productLeaders[index]].join(';');
})].join('\r\n'));
const dictionaryBytes = dictionaryFile(false);

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Test-only external report and native browser launcher for the design reference.
 * All people, products and values are synthetic. No API response, workflow service,
 * parser, result or persistence is substituted. The runtime remains production.
 * Keep this environment alive until screenshots/replays are finished, then close it.
 */
export async function createPersonalReferenceEnvironment(executablePath: string) {
  await access(executablePath);
  const contexts: BrowserContext[] = [];
  let reportDownloads = 0;
  let closed = false;
  let preparing = false;
  let exportMode: 'normal' | 'schema-error' | 'hold' | 'empty' = 'normal';
  let loginGeneration = 0;
  const heldDownloads = new Set<ServerResponse>();
  const report = createServer((request, response) => {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (request.url === '/sign-in') { response.writeHead(302, { location: '/report', 'set-cookie': `synthetic-login=${loginGeneration}; Path=/; HttpOnly; SameSite=Lax` }).end(); return; }
    if (request.url === '/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Синтетический ручной вход</title><body style="margin:100px 40px;font:18px sans-serif"><h1>Вход в учебный источник</h1><p>Локальный тест ручного шага. Пароли, OTP и сертификаты не используются.</p><a id="synthetic-login" href="/sign-in">Завершить тестовый вход</a></body></html>'); return;
    }
    if (loginGeneration && !(request.headers.cookie ?? '').split(';').some(value => value.trim() === `synthetic-login=${loginGeneration}`)) { response.writeHead(302, { location: '/login' }).end(); return; }
    if (request.url === '/export') {
      reportDownloads++;
      const bytes = exportMode === 'schema-error' ? Buffer.from('Other;Format\r\nchanged;source') : exportMode === 'empty' ? Buffer.from('\ufeffКод продукта;Продукт;Объём;Дата\r\n') : sourceBytes;
      response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${originalFileName}"`, 'content-length': bytes.length, 'cache-control': 'no-store' });
      if (exportMode === 'hold') { heldDownloads.add(response); response.once('close', () => heldDownloads.delete(response)); response.write(bytes.subarray(0, Math.floor(bytes.length / 2))); }
      else response.end(bytes);
      return;
    }
    if (request.url !== '/report') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Учебная выгрузка ОКО</title><body style="margin:120px 40px;font:18px sans-serif"><main><h1 id="report-ready">Операционные показатели</h1><p>Синтетический отчёт для проверки интерфейса. Данные на 30 октября 2026 года.</p><a id="export" href="/export" download>Скачать CSV</a></main></body></html>');
  });
  await new Promise<void>((resolve, reject) => { report.once('error', reject); report.listen(0, '127.0.0.1', resolve); });
  const reportOrigin = `http://127.0.0.1:${(report.address() as { port: number }).port}`;
  const reportUrl = reportOrigin + '/report';
  const providers: WorkbenchRuntimeProviders = {
    browserLauncher: {
      async launchPersistent(_profile, folder, options) {
        assert.equal(closed, false, 'Personal reference environment is closed');
        assert.equal(options.chromiumSandbox, true, 'The real personal browser must keep the production sandbox');
        // Preserve production network/download controls. Only use the installed
        // executable and headless display for this automated native fixture.
        const context = await chromium.launchPersistentContext(folder, { ...options, executablePath, channel: undefined, headless: true });
        contexts.push(context);
        return context;
      },
    },
  };

  async function nextManagedPage(index: number): Promise<Page> {
    const deadline = Date.now() + 20000;
    while (!contexts[index]) {
      if (Date.now() > deadline) throw Error('Actual managed report browser did not open');
      await delay(30);
    }
    const page = contexts[index].pages()[0] ?? await contexts[index].newPage();
    return page;
  }
  async function nextManaged(index: number): Promise<Page> {
    const page = await nextManagedPage(index);
    await page.waitForURL(reportUrl, { timeout: 20000 });
    await page.locator('#report-ready').waitFor({ state: 'visible', timeout: 20000 });
    return page;
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.all(contexts.map(context => context.close().catch(() => {})));
    for (const response of heldDownloads) response.destroy(); heldDownloads.clear();
    report.closeAllConnections();
    await new Promise<void>((resolve, reject) => report.close(error => error ? reject(error) : resolve()));
  }

  async function prepare({ runtime, request }: { runtime: Runtime; request: Request }): Promise<PersonalReferenceResult> {
    assert.equal(closed, false, 'Personal reference environment is closed');
    assert.equal(preparing, false, 'Prepare the personal reference only once per environment');
    assert.equal(runtime.config.roleMode, 'local-preview', 'The synthetic reference must use an isolated local-preview runtime');
    assert.notEqual(runtime.projectRoot, runtime.codeRoot, 'Do not seed the code workspace runtime');
    preparing = true;
    const initialSession = await request.session();
    assert.equal(initialSession.policyState, 'local_preview', 'Do not seed an accepted bank identity');
    if (initialSession.role !== 'curator') await request.command('workbench.role.set', { role: 'curator' });
    const session = await request.session();
    assert.ok(session.allowedCommands.includes('oko.workflow.record.test'), 'Personal replay requires its actual curator capability');

    function workflow(value: unknown): OkoWorkflowView {
      let current = value;
      for (let depth = 0; depth < 4; depth++) {
        const parsed = okoWorkflowViewSchema.safeParse(current);
        if (parsed.success) return parsed.data;
        if (!current || typeof current !== 'object' || !('result' in current)) break;
        current = current.result;
      }
      return okoWorkflowViewSchema.parse(current);
    }
    async function command(name: string, payload: Record<string, unknown>): Promise<OkoWorkflowView> {
      return workflow(await request.settle(await request.command('oko.workflow.' + name, payload)));
    }
    async function download(url: string): Promise<DownloadedReference> {
      const response = await request.response(url);
      assert.equal(response.status, 200, 'Download must be served by the actual owned-result route');
      const bytes = Buffer.from(await response.arrayBuffer());
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(response.headers.get('x-content-sha256'), sha256, 'Download integrity metadata must match actual bytes');
      const disposition = response.headers.get('content-disposition') ?? '';
      const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      assert.ok(encodedName, 'Actual download filename is required');
      return { fileName: decodeURIComponent(encodedName), mimeType: response.headers.get('content-type') ?? '', bytes, url, sha256 };
    }

    let view = await command('open', { title: 'Еженедельная выгрузка ОКО' });
    view = await command('profile.set', { workflowId: view.workflowId, expectedRevision: view.revision, reportUrl,
      profile: { allowedOrigins: [reportOrigin], maxBytes: 100000, timeoutMs: 20000, retries: 0, browser: { executablePath, profileDirectory: 'design_reference_personal', headless: false } } });

    const pickerIndex = contexts.length;
    const marker = await request.command('oko.workflow.marker.select', { workflowId: view.workflowId, reportUrl });
    const picker = await nextManaged(pickerIndex);
    await picker.locator('#report-ready').click();
    view = workflow(await request.settle(marker));

    const parsingProfile = { ...view.parsingProfile, csvDelimiter: ';' as const, csvEncoding: 'utf8' as const, dateFormat: 'dd.mm.yyyy' as const, decimalSeparator: ',' as const, groupSeparator: 'none' as const };
    const recordingIndex = contexts.length;
    view = await command('record.start', { workflowId: view.workflowId, expectedRevision: view.revision, reportUrl, parsingProfile });
    const recording = await nextManaged(recordingIndex);
    await recording.locator('#export').click();
    const recordingDeadline = Date.now() + 25000;
    while (view.recording.state !== 'completed') {
      if (view.recording.state === 'failed' || view.recording.state === 'interrupted') throw Error('Actual recording failed: ' + JSON.stringify(view.recording.problem));
      if (Date.now() > recordingDeadline) throw Error('Actual recorder did not finish its download');
      await delay(50);
      const workspace = await request.query<OkoWorkspaceView>('oko.workflow.workspace', { workflowId: view.workflowId });
      assert.ok(workspace.current);
      view = workspace.current;
    }
    assert.ok(view.recording.recordingId);
    view = await command('record.finish', { workflowId: view.workflowId, recordingId: view.recording.recordingId });
    assert.deepEqual(view.columns, ['Код продукта', 'Продукт', 'Объём', 'Дата']);
    assert.deepEqual(view.recording.parameterNames, []);
    view = await command('mapping.save', { workflowId: view.workflowId, expectedRevision: view.revision, parsingProfile, parameters: {},
      mapping: { rowKeyColumns: ['Код продукта'], productKeyColumn: 'Код продукта', dimensionColumns: { product: 'Продукт' }, numberColumns: { value: 'Объём' }, dateColumn: 'Дата', unitColumn: null, fixedUnitCode: 'операции' } });

    const uploadBody = new FormData();
    uploadBody.append('purpose', 'oko-directory');
    uploadBody.append('file', new Blob([new Uint8Array(dictionaryBytes)], { type: 'text/csv' }), 'synthetic-personal-directory.csv');
    const upload = await request.read<{ fileHandle: string }>('/api/v1/files', { method: 'POST', body: uploadBody });
    assert.ok(upload.fileHandle);
    view = await command('directory.preview', { workflowId: view.workflowId, fileHandle: upload.fileHandle, parsingProfile });
    const dictionaryMapping = { ...Object.fromEntries(dictionaryFields.map(field => [field, field])), teamId: null, teamName: null } as OkoDictionaryMapping;
    view = await command('directory.apply', { workflowId: view.workflowId, expectedRevision: view.revision, mapping: dictionaryMapping });
    assert.deepEqual(view.dictionary.issues, [], 'Synthetic dictionary must form a valid graph');

    // A separate actual replay, not the sample recorded above, creates the result.
    view = await command('record.test', { workflowId: view.workflowId, expectedRevision: view.revision });
    const workspace = await request.query<OkoWorkspaceView>('oko.workflow.workspace', { workflowId: view.workflowId });
    assert.ok(workspace.current?.result, 'Completed result must be visible through the real query');
    view = workspace.current;
    const result = view.result!;
    assert.equal(result.rowCount, sourceRows.length);
    assert.equal(result.unresolvedRows, 1);
    assert.equal(result.sourceDate, '2026-10-30');
    const [original, enriched] = await Promise.all([download(result.originalDownload), download(result.enrichedDownload)]);
    assert.deepEqual(original.bytes, sourceBytes, 'Original bytes must remain exactly as downloaded');
    assert.equal(original.fileName, originalFileName);
    assert.ok(enriched.bytes.toString('utf8').includes('Ирина Волкова'));
    assert.ok(enriched.bytes.toString('utf8').includes('1280.5'));
    assert.ok(reportDownloads >= 2, 'Recording and replay must each download from the actual report');
    return { workflowId: view.workflowId, resultId: result.resultId, rowCount: result.rowCount, unresolvedRows: result.unresolvedRows, view, original, enriched, evidence: { nativeBrowserLaunches: contexts.length, reportDownloads } };
  }

  return { providers, prepare, close, hooks: {
    reportUrl, reportOrigin, sourceBytes: Buffer.from(sourceBytes), dictionaryBytes: Buffer.from(dictionaryBytes), correctedDictionaryBytes: dictionaryFile(true), dictionaryFields, originalFileName,
    nextManagedPage, nextManaged,
    counts: () => ({ nativeBrowserLaunches: contexts.length, reportDownloads, pendingDownloads: heldDownloads.size }),
    setExportMode(mode: typeof exportMode) { exportMode = mode; },
    requireManualLogin() { loginGeneration++; },
    clearManualLogin() { loginGeneration = 0; },
  } };
}
