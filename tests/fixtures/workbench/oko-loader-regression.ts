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

for (const mode of ['picker', 'recorder'] as const) test(`${mode} init script executes in real Edge with the production tsx loader`, { timeout: 20000 }, async () => {
  const temp = await realpath(tmpdir()), root = await mkdtemp(path.join(temp, 'uor-oko-loader-'));
  const server = createServer((request, response) => {
    if (request.url === '/export') { response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=report.csv' }).end('ID;Value\nr1;123456789012345.67'); return; }
    response.setHeader('content-type', 'text/html'); response.end('<main style="margin-top:100px"><h1 id="ready">Report</h1><label for="period">Period</label><input id="period"><a id="export" href="/export">Export</a></main>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`, errors: string[] = [];
  let managed: BrowserContext | undefined, launched!: () => void;
  const opening = new Promise<void>(resolve => { launched = resolve; });
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { launchPersistent: async (_profile, folder, options) => {
    managed = await chromium.launchPersistentContext(folder, { ...options, channel: 'msedge', headless: true });
    managed.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    managed.pages()[0].on('pageerror', error => errors.push(error.message)); launched(); return managed;
  } } });
  const owner = { installationId: '00000000-0000-4000-8000-000000000001', profilePersonId: null };
  const input = { owner, profile: privateProfileSchema.parse({ allowedOrigins: [origin], timeoutMs: 3000, browser: { channel: 'msedge', profileDirectory: 'own' } }), startUrl: origin + '/report', authenticatedSelector: '#ready' };
  const controller = new AbortController();
  try {
    if (mode === 'picker') {
      const selected = runtime.selectMarker(input, controller.signal); void selected.catch(() => {});
      await opening; const page = managed!.pages()[0]; await page.waitForURL(input.startUrl);
      assert.deepEqual(errors, [], 'Picker page scripts must not depend on Node transform helpers');
      await page.locator('[data-uor-marker-picker]').waitFor({ timeout: 3000 }); await page.locator('#ready').click();
      assert.deepEqual(await selected, { selector: '#ready', label: 'ready' });
    } else {
      const handle = await runtime.startRecording(input, controller.signal), page = managed!.pages()[0];
      assert.deepEqual(errors, [], 'Recorder page scripts must not depend on Node transform helpers');
      assert.equal(await page.evaluate(() => typeof (window as unknown as {__uorRecorderDrain: unknown}).__uorRecorderDrain), 'function');
      await page.getByLabel('Period').fill('October'); await page.getByLabel('Period').press('Tab'); await page.locator('#export').click();
      const result = await runtime.waitForCompletion({ owner, handleId: handle.handleId });
      assert.equal(result.hasDownload, true); assert.deepEqual(result.steps.map(step => step.action), ['fill', 'download']);
      assert.deepEqual(result.parameterNames, ['field_period']); assert.equal(JSON.stringify(result).includes('October'), false);
    }
  } finally {
    controller.abort(); await runtime.closeOwned(owner); await managed?.close().catch(() => {});
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('uor-oko-loader-')); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
