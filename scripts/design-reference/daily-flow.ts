import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium, type Download } from 'playwright';
import type { OkoWorkflowView, OkoWorkspaceView } from '../../src/features/connectors/workbench-workflow-contracts';

const finalOnly = process.argv.includes('--final');
const artifactPrefix = finalOnly ? 'final-daily-flow' : 'daily-flow';
const output = process.env.UOR_REFERENCE_OUTPUT ?? fileURLToPath(new URL('../../.runtime/design-reference/evidence/', import.meta.url));
const executablePath = process.env.UOR_TEST_BROWSER_EXECUTABLE;
if (!executablePath) throw Error('UOR_TEST_BROWSER_EXECUTABLE must identify an installed browser');
const details = JSON.parse(await readFile(path.join(output, 'runtime.json'), 'utf8'));
const origin: string = details.origin;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const checks: Array<{ name: string; status: 'passed' | 'failed'; details?: unknown; error?: string }> = [];
const browserErrors: string[] = [];
const personalCommands: Array<{ name: string; commandId: string }> = [];
const evidence: Record<string, unknown> = { origin, synthetic: true, mode: finalOnly ? 'final-daily-demonstration' : 'browser-verification', startedAt: new Date().toISOString(), checks, browserErrors, personalCommands };
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error => browserErrors.push(error.message));
page.on('request', request => {
  if (!request.url().endsWith('/api/v1/commands') || request.method() !== 'POST') return;
  const payload = request.postDataJSON();
  if (String(payload?.name).startsWith('oko.workflow.')) personalCommands.push({ name: payload.name, commandId: payload.commandId });
});
const cdp = await context.newCDPSession(page);
const frames: Array<{ file: string; at: number }> = [];
const writes: Promise<void>[] = [];
const framesRoot = path.join(output, artifactPrefix + '-frames');
await mkdir(framesRoot, { recursive: true });
let recording = false;
cdp.on('Page.screencastFrame', event => {
  const file = path.join(framesRoot, String(frames.length).padStart(5, '0') + '.jpg');
  frames.push({ file, at: event.metadata.timestamp ?? Date.now() / 1000 });
  writes.push(writeFile(file, Buffer.from(event.data, 'base64')));
  void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
});

async function check(name: string, action: () => Promise<unknown>) {
  try { const result = await action(); checks.push({ name, status: 'passed', details: result }); }
  catch (error) { checks.push({ name, status: 'failed', error: String(error) }); if (finalOnly) throw error; }
  console.log(JSON.stringify(checks.at(-1)));
}
async function until(condition: () => Promise<boolean>, label: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!await condition()) { if (Date.now() > deadline) throw Error(label); await pause(100); }
}
async function current(): Promise<OkoWorkflowView> {
  const sessionResponse = await context.request.get(origin + '/api/v1/session');
  assert.equal(sessionResponse.status(), 200);
  const session = (await sessionResponse.json()).data;
  assert.equal(session.policyState, 'local_preview');
  assert.equal(session.role, 'curator');
  const response = await context.request.post(origin + '/api/v1/queries/oko.workflow.workspace', {
    headers: { origin, 'x-csrf-token': session.csrfToken },
    data: { context: null, filter: { workflowId: details.personalWorkflowId }, sort: [], page: { limit: 50, cursor: null } },
  });
  assert.equal(response.status(), 200);
  const workspace = (await response.json()).data as OkoWorkspaceView;
  assert.ok(workspace.current?.result);
  return workspace.current;
}
function configuration(view: OkoWorkflowView) {
  return { workflowId: view.workflowId, title: view.title, reportUrl: view.reportUrl, profile: view.profile.profile, marker: view.marker, parsingProfile: view.parsingProfile, recording: view.recording, columns: view.columns, mapping: view.mapping, parameters: view.parameters, dictionary: view.dictionary };
}
async function downloadBytes(download: Download) {
  const stream = await download.createReadStream(); assert.ok(stream);
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  assert.equal(await download.failure(), null);
  return Buffer.concat(chunks);
}
async function verifyDownloads(phase: 'before' | 'after') {
  const results: Record<string, unknown> = {};
  for (const [kind, label] of [['original', 'Скачать исходный файл'], ['enriched', 'Скачать обогащённый CSV']] as const) {
    if (finalOnly) { await page.getByRole('link', { name: label, exact: true }).hover(); await pause(500); }
    const pending = page.waitForEvent('download');
    await page.getByRole('link', { name: label, exact: true }).click();
    const download = await pending, bytes = await downloadBytes(download);
    const expected = await readFile(path.join(output, 'personal-' + kind + '.csv'));
    await writeFile(path.join(output, finalOnly ? `final-daily-${kind}.csv` : `daily-${kind}-${phase}.csv`), bytes);
    assert.deepEqual(bytes, expected, kind + ' must match actual fixture evidence');
    results[kind] = { fileName: download.suggestedFilename(), bytes: bytes.length, sha256: hash(bytes), referenceSha256: hash(expected), equalBytes: true };
    if (finalOnly) await pause(500);
  }
  return results;
}
const personalTab = () => page.getByRole('tab', { name: 'Личные выгрузки ОКО', exact: true });
const goalsTab = () => page.getByRole('tab', { name: 'Данные целей', exact: true });

try {
  evidence.browser = browser.version();
  await page.goto(origin + (finalOnly ? '/data' + details.query + '#personal-oko' : '/overview' + details.query));
  await page.getByRole('heading', { name: finalOnly ? 'Данные' : 'Обзор', exact: true, level: 1 }).waitFor();
  if (finalOnly) await page.getByRole('link', { name: 'Скачать обогащённый CSV', exact: true }).waitFor();
  const welcome = page.getByRole('button', { name: 'Закрыть приветствие', exact: true });
  if (await welcome.count()) await welcome.click();
  await page.evaluate(() => document.fonts.ready);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: finalOnly ? 85 : 70, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 1 });
  recording = true;
  if (!finalOnly) {
    await page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('button', { name: 'Данные', exact: true }).click();
    await page.getByRole('heading', { name: 'Данные', exact: true, level: 1 }).waitFor();
    await personalTab().click();
  } else await pause(900);
  await page.getByRole('link', { name: 'Скачать обогащённый CSV', exact: true }).waitFor();
  await check('Data → personal tab and URL', async () => {
    assert.equal(new URL(page.url()).hash, '#personal-oko');
    assert.equal(await personalTab().getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#wb-personal-settings').isVisible(), false);
    return { url: page.url(), selectedWorkflow: await page.getByLabel('Сохранённый отчёт', { exact: true }).inputValue() };
  });
  const before = await current();
  evidence.before = { resultId: before.result!.resultId, revision: before.revision, rowCount: before.result!.rowCount, unresolvedRows: before.result!.unresolvedRows, configurationSha256: hash(JSON.stringify(configuration(before))) };
  async function inspectSettings() {
    await page.getByRole('button', { name: 'Настроить', exact: true }).click();
    await page.getByRole('heading', { name: 'Настройка личного сценария', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Адрес отчёта', { exact: true }).inputValue(), before.reportUrl);
    const expanded = await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).getAttribute('aria-expanded');
    assert.equal(expanded, 'true');
    await pause(finalOnly ? 800 : 400);
    await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click();
    assert.equal(await page.locator('#wb-personal-settings').isVisible(), false);
    return { savedReportMatched: true, configurationSha256: hash(JSON.stringify(configuration(await current()))) };
  }
  if (!finalOnly) {
    await check('Original and enriched downloads before replay', () => verifyDownloads('before'));
    await check('Settings open, saved report and close', inspectSettings);
  }

  await check('Daily replay creates a new actual result without setup', async () => {
    const commandCount = personalCommands.length;
    if (finalOnly) { await page.getByRole('button', { name: 'Получить данные', exact: true }).hover(); await pause(400); }
    await page.getByRole('button', { name: 'Получить данные', exact: true }).click();
    let after = before;
    await until(async () => { after = await current(); return after.result!.resultId !== before.result!.resultId; }, 'The actual stored result ID did not change', 45000);
    const result = after.result!;
    await until(async () => (await page.getByRole('link', { name: 'Скачать исходный файл', exact: true }).getAttribute('href')) === result.originalDownload, 'The UI did not show the new persisted result', 10000);
    assert.equal(result.rowCount, 8); assert.equal(result.unresolvedRows, 1);
    assert.deepEqual(configuration(after), configuration(before));
    assert.equal(await page.locator('#wb-personal-settings').isVisible(), false);
    const commands = personalCommands.slice(commandCount).map(item => item.name);
    assert.deepEqual(commands, ['oko.workflow.record.test']);
    const metrics = await page.locator('.wb-result-metrics > div').allTextContents();
    assert.match(metrics[0], /8/); assert.match(metrics[2], /1/);
    evidence.after = { resultId: result.resultId, revision: after.revision, rowCount: result.rowCount, unresolvedRows: result.unresolvedRows, configurationSha256: hash(JSON.stringify(configuration(after))) };
    return { ...evidence.after as object, sentCommands: commands, metrics };
  });
  if (finalOnly) await pause(1200);
  if (!finalOnly) {
    await check('Original and enriched downloads after replay', () => verifyDownloads('after'));
    await check('Previous result files remain readable and unchanged', async () => {
    const result: Record<string, unknown> = {};
    for (const [kind, url] of [['original', before.result!.originalDownload], ['enriched', before.result!.enrichedDownload]] as const) {
      const response = await context.request.get(origin + url);
      assert.equal(response.status(), 200);
      const bytes = await response.body(), expected = await readFile(path.join(output, 'personal-' + kind + '.csv'));
      assert.deepEqual(bytes, expected);
      assert.equal(response.headers()['x-content-sha256'], hash(bytes));
      result[kind] = { resultId: before.result!.resultId, sha256: hash(bytes), unchanged: true };
    }
    return result;
    });
  }
  await check('Result data and issue tabs', async () => {
    await page.getByRole('button', { name: 'Показать замечания', exact: true }).click();
    await page.locator('#wb-personal-issues-panel').waitFor({ state: 'visible' });
    const issueText = await page.locator('#wb-personal-issues-panel').innerText();
    assert.ok(issueText.includes('Что нужно уточнить'));
    const messages = await page.locator('#wb-personal-issues-panel li strong').allTextContents();
    if (finalOnly) {
      assert.ok(messages.length > 0 && messages.every(message => /[А-Яа-яЁё]/.test(message) && !/^[A-Z0-9_]+$/.test(message.trim())), 'Final demonstration requires a real human-readable issue explanation');
      assert.equal(issueText.includes('UNMAPPED_PRODUCT'), false, 'Raw technical code must remain inside the closed technical disclosure');
    }
    await pause(finalOnly ? 1500 : 500);
    await page.locator('#wb-personal-data-tab').click();
    assert.equal(await page.locator('#wb-personal-data-panel').isVisible(), true);
    return { issueText, messages };
  });

  if (finalOnly) {
    await check('Actual original and enriched downloads', () => verifyDownloads('after'));
    await check('Saved settings can be opened and closed', inspectSettings);
    await pause(500);
  }

  if (!finalOnly) {
  await check('Switch personal → goal data tab', async () => {
    await goalsTab().click();
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await goalsTab().getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#wb-data-personal').isVisible(), false);
    return { url: page.url() };
  });
  await check('Browser Back restores personal tab and hash', async () => {
    await page.goBack();
    await until(async () => new URL(page.url()).hash === '#personal-oko' && await personalTab().getAttribute('aria-selected') === 'true', 'Back did not restore #personal-oko; actual URL ' + page.url());
    return { url: page.url() };
  });
  await check('Browser Forward restores goal data tab', async () => {
    await page.goForward();
    await until(async () => new URL(page.url()).hash === '' && await goalsTab().getAttribute('aria-selected') === 'true', 'Forward did not restore goal data');
    return { url: page.url() };
  });
  await check('Direct #personal-oko URL restores personal tab', async () => {
    await page.goto(origin + '/data' + details.query + '#personal-oko');
    await page.getByRole('heading', { name: 'Данные', exact: true, level: 1 }).waitFor();
    await until(async () => new URL(page.url()).hash === '#personal-oko' && await personalTab().getAttribute('aria-selected') === 'true', 'Direct URL lost #personal-oko; actual URL ' + page.url());
    return { url: page.url() };
  });
  await check('Reload preserves the personal tab', async () => {
    await personalTab().click();
    await page.reload();
    await page.getByRole('heading', { name: 'Данные', exact: true, level: 1 }).waitFor();
    await until(async () => new URL(page.url()).hash === '#personal-oko' && await personalTab().getAttribute('aria-selected') === 'true', 'Reload lost #personal-oko; actual URL ' + page.url());
    return { url: page.url() };
  });
  }

  if (!finalOnly) await personalTab().click();
  await page.getByRole('link', { name: 'Скачать обогащённый CSV', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const finalWelcome = page.getByRole('button', { name: 'Закрыть приветствие', exact: true });
  if (await finalWelcome.count()) await finalWelcome.click();
  await page.screenshot({ path: path.join(output, artifactPrefix + '.png'), fullPage: true });
  await pause(700);
  await check('No browser runtime errors', async () => { assert.deepEqual(browserErrors, []); return { browserErrors }; });
} catch (error) {
  evidence.fatalError = String(error);
  await page.screenshot({ path: path.join(output, artifactPrefix + '-failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (recording) await cdp.send('Page.stopScreencast').catch(() => {});
  await Promise.all(writes);
  if (frames.length > 1) {
    const input = path.join(framesRoot, 'frames.txt');
    await writeFile(input, frames.map((frame, index) => `file '${frame.file}'\nduration ${Math.max(0.08, Math.min(finalOnly ? Infinity : 5, (frames[index + 1]?.at ?? frame.at + 0.7) - frame.at)).toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1)!.file}'\n`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.env.UOR_REFERENCE_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', input, '-vf', 'fps=12', '-c:v', 'libx264', '-crf', finalOnly ? '18' : '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(output, artifactPrefix + '.mp4')]);
        let errors = ''; child.stderr.on('data', bytes => { errors += String(bytes); });
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('ffmpeg ' + code + ': ' + errors)));
      });
      evidence.video = { file: artifactPrefix + '.mp4', realCdpFrames: frames.length };
    } catch (error) { evidence.videoError = String(error); }
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.passed = checks.filter(item => item.status === 'passed').length;
  evidence.failed = checks.filter(item => item.status === 'failed').length;
  await writeFile(path.join(output, artifactPrefix + '.json'), JSON.stringify(evidence, null, 2));
  await browser.close();
  // This script owns only its browser. The shared backend, report and Vite stay live.
}
console.log(JSON.stringify({ file: path.join(output, artifactPrefix + '.json'), passed: evidence.passed, failed: evidence.failed, fatalError: evidence.fatalError, video: evidence.video }));
if (evidence.fatalError || evidence.failed) process.exitCode = 1;
