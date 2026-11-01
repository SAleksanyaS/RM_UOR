import { mkdir, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { createLocalRuntime } from '../../tests/workbench/helpers/runtime';
import { seedGoalReference } from './goal-fixture';
import { createPersonalReferenceEnvironment } from './personal-fixture';
import type { OkoWorkspaceView } from '../../src/features/connectors/workbench-workflow-contracts';

/** Explicit synthetic fixture: never accepts an existing user's data root. */
const codeRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.env.UOR_REFERENCE_OUTPUT ?? path.join(codeRoot, '.runtime/design-reference/evidence'));
const baselineRoot = await realpath(process.env.UOR_REFERENCE_BASELINE ?? codeRoot);
const executable = process.env.UOR_TEST_BROWSER_EXECUTABLE;
if (!executable) throw Error('UOR_TEST_BROWSER_EXECUTABLE must identify an installed browser');
await mkdir(output, { recursive: true });
const external = await createPersonalReferenceEnvironment(executable);
let local: Awaited<ReturnType<typeof createLocalRuntime>> | undefined;
let host: ViteDevServer | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let closed = false;
async function close() {
  if (closed) return; closed = true;
  await browser?.close(); await host?.close(); await local?.close(); await external.close();
}
process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });
try {
  local = await createLocalRuntime({ ...external.providers, clock: { now: () => '2026-11-01T09:00:00Z' } });
  const fixture = seedGoalReference(local.runtime.deps.repository);
  const personal = await external.prepare({ runtime: local.runtime, request: local.request });
  const session = await local.request.session();
  const context = { ...session.defaultContext!, scopePath: { ditId: fixture.ditId, clusterId: null, productId: null, teamId: null }, time: { kind: 'as_of', date: '2026-11-01' }, goalId: null, resultMode: 'current', snapshotId: null };
  const goals = await local.request.query<any>('goals.list', {}, context);
  for (const row of goals.items) await local.request.command('calculation.prepare', { assignmentRef: row.ref, businessTime: context.time });
  const origin = 'http://127.0.0.1:' + local.ui;
  async function useUi(root: string) {
    await host?.close();
    host = await createServer({ root, clearScreen: false, configFile: path.join(root, 'vite.config.ts'), cacheDir: path.join(local!.root, '.runtime/reference-vite-' + path.basename(root)), server: { host: '127.0.0.1', port: local!.ui, strictPort: true, proxy: { '/api': local!.origin } } });
    await host.listen();
  }
  browser = await chromium.launch({ executablePath: executable, headless: true });
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await browserContext.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
  const query = '?dit=' + fixture.ditId + '&at=2026-11-01&mode=current';
  const captured: Array<{ phase: string; route: string; width: number; height: number; overflow: boolean; file: string }> = [];
  async function capture(phase: 'before' | 'after') {
    await useUi(phase === 'before' ? baselineRoot : codeRoot);
    const sizes = phase === 'before' ? [[1440,1000],[1366,768]] : [[1440,1000],[1366,768],[1024,900],[768,1024],[360,900],[320,900]];
    for (const route of ['overview', 'data', 'goal']) {
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height });
        await page.goto(origin + (route === 'goal' ? '/goals/' + fixture.goalIds[0] : '/' + route) + query);
        await page.getByRole('heading', { name: route === 'goal' ? 'Цели' : route === 'data' ? 'Данные' : 'Обзор', level: 1 }).waitFor();
        if (route === 'data') {
          await page.getByRole('tab', { name: 'Личные выгрузки ОКО', exact: true }).click();
          await page.getByRole('link', { name: 'Скачать обогащённый CSV', exact: true }).first().waitFor();
        } else await page.getByText('Обращения решены в срок', { exact: false }).first().waitFor();
        const welcome = page.getByRole('button', { name: 'Закрыть приветствие' });
        if (await welcome.count()) await welcome.click();
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(output, `${phase}-${route}-${width}x${height}.png`), fullPage: false });
        await page.screenshot({ path: path.join(output, `${phase}-${route}-${width}x${height}-full.png`), fullPage: true });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        const snapshot = { phase, route, width, height, overflow, file: `${phase}-${route}-${width}x${height}.png` };
        const previous = captured.findIndex(item => item.phase === phase && item.route === route && item.width === width && item.height === height);
        if (previous < 0) captured.push(snapshot); else captured[previous] = snapshot;
      }
    }
    if (phase === 'after') {
      await page.setViewportSize({ width: 360, height: 900 });
      await page.goto(origin + '/overview' + query);
      await page.getByRole('button', { name: 'Открыть меню' }).click();
      await page.getByRole('dialog', { name: 'Навигация рабочего места' }).waitFor();
      await page.screenshot({ path: path.join(output, 'after-navigation-360x900.png') });
      await page.keyboard.press('Escape');
      if (await page.getByRole('dialog', { name: 'Навигация рабочего места' }).count()) throw Error('Drawer did not close');
    }
    const saved = await local!.request.query<OkoWorkspaceView>('oko.workflow.workspace', { workflowId: personal.workflowId });
    if (!saved.current?.result) throw Error('The captured personal result is missing');
    await writeFile(path.join(output, 'reference-evidence.json'), JSON.stringify({ sourceBase: 'ac299a5508dba60df7d4f5b8152fb7aaf4655223', synthetic: true, node: process.version, browser: browser!.version(), origin, fixture, personal: { workflowId: personal.workflowId, initialResultId: personal.resultId, resultId: saved.current.result.resultId, rowCount: saved.current.result.rowCount, unresolvedRows: saved.current.result.unresolvedRows, originalSha256: personal.original.sha256, enrichedSha256: personal.enriched.sha256, fixturePreparation: personal.evidence }, captured, browserErrors: errors }, null, 2));
    console.log(JSON.stringify({ phase, captured: captured.filter(item => item.phase === phase).length, errors, overflow: captured.filter(item => item.phase === phase && item.overflow), origin }));
  }
  await writeFile(path.join(output, 'runtime.json'), JSON.stringify({ origin, apiOrigin: local.origin, fixture, query, personalWorkflowId: personal.workflowId }, null, 2));
  await writeFile(path.join(output, 'personal-original.csv'), personal.original.bytes);
  await writeFile(path.join(output, 'personal-enriched.csv'), personal.enriched.bytes);
  await capture('before');
  console.log('REFERENCE_READY: send after to capture current worktree; quit to close owned runtime.');
  const commands = createInterface({ input: process.stdin });
  for await (const command of commands) {
    if (command.trim() === 'after') await capture('after');
    if (command.trim() === 'quit') break;
  }
} finally { await close(); }
