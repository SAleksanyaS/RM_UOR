import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Download, type Locator, type Page } from 'playwright';
import type { createHttpDriver } from '../../tests/workbench/helpers/runtime';
import type { createPersonalReferenceEnvironment } from './personal-fixture';
import type { OkoWorkflowView, OkoWorkspaceView } from '../../src/features/connectors/workbench-workflow-contracts';

export type CompletionOkoFlowResult = { workflowId: string; resultId: string; checks: number; video: string | null };
type Request = ReturnType<typeof createHttpDriver>;
type Environment = Awaited<ReturnType<typeof createPersonalReferenceEnvironment>>;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
async function until(test: () => Promise<boolean>, label: string, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (!await test()) { if (Date.now() >= deadline) throw Error(label); await pause(75); }
}
async function downloadBytes(download: Download) {
  const stream = await download.createReadStream(); assert.ok(stream);
  const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part));
  assert.equal(await download.failure(), null); return Buffer.concat(parts);
}
function configuration(value: OkoWorkflowView) {
  return { reportUrl: value.reportUrl, profile: value.profile.profile, marker: value.marker, recording: value.recording, mapping: value.mapping, parameters: value.parameters, parsingProfile: value.parsingProfile, dictionary: value.dictionary };
}

/** Real UI actions and production HTTP/SQLite. Only the external localhost report is synthetic. */
export async function runCompletionOkoFlow({ origin, query, output, executablePath, request, environment }: {
  origin: string; query: string; output: string; executablePath: string; request: Request; environment: Environment;
}): Promise<CompletionOkoFlowResult> {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const runOutput = path.join(output, 'oko-' + new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(runOutput, { recursive: true });
  const framesRoot = path.join(runOutput, 'frames'); await mkdir(framesRoot);
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const cdp = await context.newCDPSession(page);
  const frames: Array<{ file: string; at: number }> = [], writes: Promise<void>[] = [];
  const browserErrors: string[] = [], dialogs: string[] = [];
  const commands: Array<{ name: string; commandId: string }> = [];
  const checks: Array<{ name: string; status: 'passed' | 'failed'; details?: unknown; error?: string }> = [];
  let workflowId = '', finalResultId = '', video: string | null = null, fatal: unknown;
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  page.on('request', event => {
    if (event.method() !== 'POST' || !event.url().endsWith('/api/v1/commands')) return;
    const value = event.postDataJSON(); commands.push({ name: String(value.name), commandId: String(value.commandId) });
  });
  cdp.on('Page.screencastFrame', event => {
    const file = path.join(framesRoot, String(frames.length).padStart(6, '0') + '.jpg');
    frames.push({ file, at: event.metadata.timestamp ?? Date.now() / 1000 });
    writes.push(writeFile(file, Buffer.from(event.data, 'base64')));
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  async function capture(name: string, target: Page = page) {
    await target.screenshot({ path: path.join(runOutput, name + '.png'), fullPage: true });
  }
  async function step(name: string, action: () => Promise<unknown>) {
    console.log('OKO_STEP ' + name);
    try { const details = await action(); checks.push({ name, status: 'passed', details }); }
    catch (error) { checks.push({ name, status: 'failed', error: String(error) }); await capture('failed-' + name.replace(/[^a-zA-Z0-9_-]/g, '-')).catch(() => {}); throw error; }
  }
  async function current() {
    const workspace = await request.query<OkoWorkspaceView>('oko.workflow.workspace', workflowId ? { workflowId } : {});
    assert.ok(workspace.current, 'Actual own workspace must contain the UI-selected scenario'); return workspace.current;
  }
  async function clickCommand(button: Locator, name: string) {
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url().endsWith('/api/v1/commands') && value.request().postDataJSON()?.name === name);
    await button.click(); const value = await response;
    assert.ok([200, 202].includes(value.status()), name + ': ' + await value.text());
    return (await value.json()).data;
  }
  const dailyButton = () => page.getByRole('button', { name: 'Получить данные', exact: true });
  async function newResult(before: string | null) {
    let value = await current();
    await until(async () => { value = await current(); return !!value.result && value.result.resultId !== before; }, 'A real new result was not stored');
    await until(async () => (await page.getByRole('link', { name: 'Скачать исходный файл', exact: true }).getAttribute('href')) === value.result!.originalDownload, 'The UI did not show the accepted result');
    await until(() => dailyButton().isEnabled(), 'Daily action did not become available');
    return value;
  }
  async function settings(open: boolean) {
    if (await page.locator('#wb-personal-settings').isVisible() === open) return;
    await page.getByRole('button', { name: open ? 'Настроить' : 'Закрыть настройки', exact: true }).click();
  }
  async function applyDirectory(bytes: Buffer, name: string) {
    await settings(true);
    await page.getByLabel('Файл справочника', { exact: true }).setInputFiles({ name, mimeType: 'text/csv', buffer: bytes });
    await clickCommand(page.getByRole('button', { name: 'Прочитать столбцы справочника', exact: true }), 'oko.workflow.directory.preview');
    await page.getByLabel('Ключ продукта в ОКО', { exact: true }).waitFor();
    const labels = ['Ключ продукта в ОКО', 'ID продукта (UUID)', 'Название продукта', 'ID кластера (UUID)', 'Название кластера', 'ID ДИТ (UUID)', 'Название ДИТ', 'ID руководителя кластера (UUID)', 'Руководитель кластера', 'ID руководителя продукта (UUID)', 'Руководитель продукта'];
    for (let index = 0; index < labels.length; index++) await page.getByLabel(labels[index], { exact: true }).selectOption(environment.hooks.dictionaryFields[index]);
    await clickCommand(page.getByRole('button', { name: 'Применить справочник к предпросмотру', exact: true }), 'oko.workflow.directory.apply');
    await until(async () => !!(await current()).dictionary.mapping, 'Directory mapping was not saved');
    assert.deepEqual((await current()).dictionary.issues, []);
  }
  async function verifyDownloads(prefix: string, expectedLeader: string) {
    const result: Record<string, unknown> = {};
    for (const [kind, label] of [['original', 'Скачать исходный файл'], ['enriched', 'Скачать обогащённый CSV']] as const) {
      const downloading = page.waitForEvent('download'); await page.getByRole('link', { name: label, exact: true }).click();
      const download = await downloading, bytes = await downloadBytes(download);
      if (kind === 'original') assert.deepEqual(bytes, environment.hooks.sourceBytes);
      else { assert.ok(bytes.toString('utf8').includes(expectedLeader)); assert.ok(bytes.toString('utf8').includes('1280.5')); }
      await writeFile(path.join(runOutput, prefix + '-' + kind + '.csv'), bytes);
      result[kind] = { file: download.suggestedFilename(), bytes: bytes.length, sha256: hash(bytes) };
    }
    return result;
  }

  try {
    await page.goto(origin + '/data' + query + '#personal-oko');
    await page.getByRole('heading', { name: 'Данные', exact: true, level: 1 }).waitFor();
    const welcome = page.getByRole('button', { name: 'Закрыть приветствие' }); if (await welcome.count()) await welcome.click();
    await page.evaluate(() => document.fonts.ready);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 2 });
    await step('reader-first-setup', async () => {
      await page.getByLabel('Режим работы', { exact: true }).selectOption('viewer');
      await until(async () => (await request.session()).role === 'viewer', 'Local reader role was not applied');
      const first = page.getByRole('button', { name: 'Создать первый сценарий', exact: true });
      if (await first.count()) { await capture('01-empty-reader'); await clickCommand(first, 'oko.workflow.open'); }
      else { await page.getByRole('button', { name: 'Новый сценарий', exact: true }).click(); await page.getByLabel('Название отчёта', { exact: true }).fill('ОКО · сквозная проверка'); await clickCommand(page.getByRole('button', { name: 'Создать сценарий', exact: true }), 'oko.workflow.open'); }
      await page.getByLabel('Адрес отчёта', { exact: true }).waitFor();
      workflowId = await page.getByLabel('Сохранённый отчёт', { exact: true }).inputValue(); assert.ok(workflowId);
      await page.getByLabel('Адрес отчёта', { exact: true }).fill(environment.hooks.reportUrl);
      await page.getByLabel('Установленный браузер', { exact: true }).selectOption('chrome');
      await page.getByLabel('Имя личного профиля', { exact: true }).fill('completion_oko');
      await clickCommand(page.getByRole('button', { name: 'Сохранить личный профиль', exact: true }), 'oko.workflow.profile.set');
      await until(async () => (await current()).profile.configured, 'Personal profile was not saved');
      await capture('02-saved-profile-reader');
      assert.equal((await request.session()).role, 'viewer');
      return { workflowId, personId: (await request.session()).personId, reportUrl: environment.hooks.reportUrl };
    });
    await step('native-marker-and-recording', async () => {
      let index = environment.hooks.counts().nativeBrowserLaunches;
      const accepted = await clickCommand(page.getByRole('button', { name: 'Выбрать элемент отчёта в браузере', exact: true }), 'oko.workflow.marker.select');
      const picker = await environment.hooks.nextManaged(index); await capture('03-native-marker', picker);
      await picker.locator('#report-ready').click(); await request.settle(accepted);
      await until(async () => !!(await current()).marker, 'The actual picker did not persist its marker');
      await page.getByText('Как читать файл CSV / XLSX', { exact: true }).click();
      await page.locator('#source-delimiter').selectOption(';');
      await page.locator('#source-date').selectOption('dd.mm.yyyy'); await page.locator('#source-decimal').selectOption(',');
      index = environment.hooks.counts().nativeBrowserLaunches;
      await clickCommand(page.getByRole('button', { name: 'Начать запись действий', exact: true }), 'oko.workflow.record.start');
      const recording = await environment.hooks.nextManaged(index); await capture('04-native-recording', recording);
      await settings(false); await capture('05-recording-settings-collapsed');
      await recording.locator('#export').click();
      await until(async () => { const value = await current(); return value.recording.state === 'completed' && value.columns.length === 4 && value.recording.steps.length > 0; }, 'Automatic record.finish did not accept the real completed download');
      assert.equal(await page.locator('#wb-personal-settings').isVisible(), false);
      const value = await current(); assert.deepEqual(value.columns, ['Код продукта', 'Продукт', 'Объём', 'Дата']);
      assert.equal(commands.filter(command => command.name === 'oko.workflow.record.finish').length, 1);
      return { recordingId: value.recording.recordingId, steps: value.recording.steps, native: environment.hooks.counts() };
    });
    await step('mapping-and-first-directory', async () => {
      await settings(true);
      await page.getByLabel('Код продукта', { exact: true }).check();
      await page.getByLabel('Ключ продукта для справочника', { exact: true }).selectOption('Код продукта');
      await page.getByLabel('Дата данных', { exact: true }).selectOption('Дата');
      await page.getByLabel('Столбец «value»', { exact: true }).selectOption('Объём');
      await page.getByLabel('Единица измерения — постоянная', { exact: true }).fill('операции');
      await clickCommand(page.getByRole('button', { name: 'Сохранить сопоставление и фильтры', exact: true }), 'oko.workflow.mapping.save');
      await applyDirectory(environment.hooks.dictionaryBytes, 'synthetic-directory-incomplete.csv');
      await capture('06-saved-mapping-directory'); await settings(false);
      await clickCommand(dailyButton(), 'oko.workflow.record.test');
      const value = await newResult(null); assert.equal(value.result!.rowCount, 8); assert.equal(value.result!.unresolvedRows, 1);
      assert.ok(value.result!.issues.some(issue => issue.code === 'UNMAPPED_PRODUCT'));
      await capture('07-real-result-one-unmapped');
      await page.getByRole('tab', { name: /Замечания/ }).click(); await capture('08-readable-unmapped-product');
      return { resultId: value.result!.resultId, rowCount: value.result!.rowCount, unresolvedRows: value.result!.unresolvedRows };
    });
    const originalResult = (await current()).result!;
    await step('correct-directory-and-download-real-files', async () => {
      await page.getByRole('button', { name: 'Открыть сопоставление и справочник', exact: true }).click();
      await applyDirectory(environment.hooks.correctedDictionaryBytes, 'synthetic-directory-corrected.csv');
      await settings(false); await clickCommand(dailyButton(), 'oko.workflow.record.test');
      const value = await newResult(originalResult.resultId); assert.equal(value.result!.rowCount, 8); assert.equal(value.result!.unresolvedRows, 0);
      assert.ok(value.result!.previewRows.some(row => Object.values(row).includes('Николай Зайцев')));
      await capture('09-real-result-corrected');
      const previous = await request.response(originalResult.enrichedDownload); assert.equal(previous.status, 200);
      const previousBytes = Buffer.from(await previous.arrayBuffer()); assert.equal(previousBytes.includes(Buffer.from('Николай Зайцев')), false, 'Old enriched bytes must not change after directory correction');
      return { resultId: value.result!.resultId, rowCount: value.result!.rowCount, unresolvedRows: value.result!.unresolvedRows, previousSha256: hash(previousBytes), downloads: await verifyDownloads('corrected', 'Николай Зайцев') };
    });
    await step('daily-repeat-without-setup', async () => {
      const before = await current(), recipeHash = hash(JSON.stringify(configuration(before))), count = commands.length;
      assert.equal(await page.locator('#wb-personal-settings').isVisible(), false);
      await clickCommand(dailyButton(), 'oko.workflow.record.test'); const after = await newResult(before.result!.resultId);
      assert.equal(hash(JSON.stringify(configuration(after))), recipeHash);
      assert.deepEqual(commands.slice(count).map(command => command.name), ['oko.workflow.record.test']);
      await capture('10-daily-repeat');
      return { beforeResult: before.result!.resultId, afterResult: after.result!.resultId, recipeHash, downloads: await verifyDownloads('daily', 'Николай Зайцев') };
    });
    await step('manual-authentication-same-owned-job', async () => {
      environment.hooks.requireManualLogin(); const before = (await current()).result!.resultId;
      const accepted = await clickCommand(dailyButton(), 'oko.workflow.record.test');
      await page.getByRole('button', { name: 'Войти в ОКО', exact: true }).waitFor(); await capture('11-manual-auth-required');
      const index = environment.hooks.counts().nativeBrowserLaunches;
      await clickCommand(page.getByRole('button', { name: 'Войти в ОКО', exact: true }), 'job.openAuth');
      const login = await environment.hooks.nextManagedPage(index); await login.locator('#synthetic-login').waitFor(); await capture('12-real-native-manual-login', login);
      await login.locator('#synthetic-login').click(); await login.locator('#report-ready').waitFor();
      await clickCommand(page.getByRole('button', { name: 'Вход выполнен — продолжить', exact: true }), 'job.retry');
      const value = await newResult(before), job = await request.job(accepted.jobId); assert.equal(job.status, 'succeeded');
      await capture('13-manual-auth-recovered');
      // Other fault cases are independent source behaviours. The auth case above
      // uses a session-only cookie and the production native continuation.
      environment.hooks.clearManualLogin();
      return { sameJobId: accepted.jobId, originalCommandId: job.commandId, resultId: value.result!.resultId, authentication: 'session-only native context, no cookie persistence or transfer' };
    });
    await step('source-failure-retains-previous-result', async () => {
      const before = (await current()).result!; environment.hooks.setExportMode('schema-error');
      const accepted = await clickCommand(dailyButton(), 'oko.workflow.record.test');
      await page.getByText('Получение остановлено', { exact: true }).waitFor();
      const job = await request.job(accepted.jobId); assert.equal(job.status, 'failed'); assert.equal((await current()).result!.resultId, before.resultId);
      await capture('14-real-source-schema-failure'); environment.hooks.setExportMode('normal');
      return { code: job.error?.code, preservedResult: before.resultId };
    });
    await step('cancel-incomplete-native-download', async () => {
      const before = (await current()).result!.resultId; environment.hooks.setExportMode('hold');
      const accepted = await clickCommand(dailyButton(), 'oko.workflow.record.test');
      await until(async () => environment.hooks.counts().pendingDownloads > 0, 'Synthetic source did not hold a real partial download');
      await page.getByRole('button', { name: 'Отменить получение', exact: true }).waitFor(); await capture('15-real-download-in-progress');
      await clickCommand(page.getByRole('button', { name: 'Отменить получение', exact: true }), 'job.cancel');
      await page.getByText('Операция отменена', { exact: true }).waitFor();
      await until(async () => environment.hooks.counts().pendingDownloads === 0, 'Cancelled source response was left open');
      assert.equal((await request.job(accepted.jobId)).status, 'cancelled'); assert.equal((await current()).result!.resultId, before);
      await capture('16-cancelled-previous-result-retained'); environment.hooks.setExportMode('normal');
      return { jobId: accepted.jobId, preservedResult: before, native: environment.hooks.counts() };
    });
    await step('real-empty-export', async () => {
      environment.hooks.setExportMode('empty'); const before = (await current()).result!.resultId;
      const accepted = await clickCommand(dailyButton(), 'oko.workflow.record.test');
      await until(async () => ['succeeded', 'failed'].includes((await request.job(accepted.jobId)).status), 'Empty export job did not finish');
      const job = await request.job(accepted.jobId), value = await current();
      if (job.status === 'succeeded') { assert.notEqual(value.result!.resultId, before); assert.equal(value.result!.rowCount, 0); await page.getByText('В файле нет строк данных', { exact: true }).waitFor(); }
      else { assert.equal(value.result!.resultId, before); await page.getByText('Получение остановлено', { exact: true }).waitFor(); }
      await capture('17-actual-empty-export-outcome'); environment.hooks.setExportMode('normal');
      return { status: job.status, code: job.error?.code ?? null, rowCount: value.result?.rowCount, resultId: value.result?.resultId };
    });
    await step('lost-real-response-reconciles-without-second-replay', async () => {
      const before = (await current()).result!.resultId, count = commands.filter(command => command.name === 'oko.workflow.record.test').length; let dropped = false;
      await page.route('**/api/v1/commands', async route => {
        if (!dropped && route.request().postDataJSON()?.name === 'oko.workflow.record.test') { dropped = true; await route.fetch(); await route.abort('connectionreset'); }
        else await route.continue();
      });
      await dailyButton().click();
      await page.getByRole('button', { name: 'Проверить сохранённое состояние', exact: true }).waitFor(); await capture('18-actual-response-loss');
      await page.unroute('**/api/v1/commands');
      await page.getByRole('button', { name: 'Проверить сохранённое состояние', exact: true }).click();
      const value = await newResult(before); assert.equal(value.result!.rowCount, 8); assert.equal(value.result!.unresolvedRows, 0);
      assert.equal(commands.filter(command => command.name === 'oko.workflow.record.test').length - count, 1);
      await capture('19-original-command-recovered'); return { wireFault: 'Actual command response discarded after route.fetch, no DTO substituted', resultId: value.result!.resultId, newReplayCommands: 1 };
    });
    await step('final-daily-ready-and-role-restored', async () => {
      assert.equal((await request.session()).role, 'viewer');
      await page.getByLabel('Режим работы', { exact: true }).selectOption('curator');
      await until(async () => (await request.session()).role === 'curator', 'Editor mode was not restored for the other UI capture');
      await settings(false); await capture('20-final-daily-ready');
      finalResultId = (await current()).result!.resultId; assert.deepEqual(browserErrors, []); assert.deepEqual(dialogs, []);
      return { finalResultId, role: 'curator', native: environment.hooks.counts() };
    });
  } catch (error) { fatal = error; }
  finally {
    environment.hooks.setExportMode('normal');
    environment.hooks.clearManualLogin();
    await cdp.send('Page.stopScreencast').catch(() => {}); await Promise.all(writes);
    if (frames.length > 1) {
      const input = path.join(framesRoot, 'frames.txt');
      await writeFile(input, frames.map((frame, index) => `file '${frame.file}'\nduration ${Math.max(0.06, Math.min(3, (frames[index + 1]?.at ?? frame.at + 0.8) - frame.at)).toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1)!.file}'\n`);
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.env.UOR_REFERENCE_FFMPEG ?? '/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', input, '-vf', 'fps=12', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(runOutput, 'completion-oko.mp4')]);
          let text = ''; child.stderr.on('data', chunk => { text += String(chunk); }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('Video encoder: ' + text)));
        }); video = path.join(runOutput, 'completion-oko.mp4');
      } catch (error) { fatal ??= error; }
    }
    await writeFile(path.join(runOutput, 'completion-oko.json'), JSON.stringify({ synthetic: true, origin, workflowId, finalResultId, browser: browser.version(), node: process.version, sandbox: true, checks, browserErrors, dialogs, commands, native: environment.hooks.counts(), video, realCdpFrames: frames.length, fatalError: fatal ? String(fatal) : null }, null, 2));
    await writeFile(path.join(output, 'oko-latest.json'), JSON.stringify({ runOutput, workflowId, finalResultId, video, passed: checks.filter(check => check.status === 'passed').length, failed: checks.filter(check => check.status === 'failed').length, fatalError: fatal ? String(fatal) : null }, null, 2));
    await context.close(); await browser.close();
  }
  if (fatal) throw fatal;
  return { workflowId, resultId: finalResultId, checks: checks.length, video };
}
