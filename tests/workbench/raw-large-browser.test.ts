import { expect, it } from 'vitest';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalRuntime, codeRoot } from './helpers/runtime';

it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE)('100,000 raw CSV rows retain their bytes while the real UI renders 50, searches all rows and sorts on the server', async () => {
  const f = await createLocalRuntime();
  let host: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const csv = Buffer.from('Row,Team,Value,Date,Status\r\n' + Array.from({ length: 100000 }, (_, i) => `${i},Team ${i % 58},${(i * 17) % 1000},2026-10-30,${i % 7 === 0 ? 'attention' : 'ready'}`).join('\r\n') + '\r\n');
    const access = await f.runtime.deps.accessPolicy.resolveOwnAccess();
    const upload = await f.runtime.services.files.stage({ installationId: f.runtime.deps.installationId, profilePersonId: access.personId, purpose: 'raw-file', name: '100000-rows.csv', mediaType: 'text/csv', stream: (async function* () { yield csv; })() });
    const saved = await f.request.command('raw.capture.import', { fileHandle: upload.fileHandle, sourceKind: 'local_file' });
    await f.restart();
    await f.request.session();
    host = await createServer({ configFile: path.join(codeRoot, 'vite.config.ts'), root: codeRoot, cacheDir: path.join(f.root, '.runtime/vite-cache'), server: { host: '127.0.0.1', port: f.ui, strictPort: true, proxy: { '/api': f.origin } } });
    await host.listen();
    browser = await chromium.launch({ executablePath: process.env.UOR_TEST_BROWSER_EXECUTABLE, headless: true, chromiumSandbox: process.env.UOR_SYNTHETIC_CI !== '1' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${f.ui}/data?file=${saved.result.id}`);
    await page.getByText('Показано 50 из 100000 строк', { exact: true }).waitFor();
    const table = page.getByRole('table', { name: 'Строки исходного файла', exact: true });
    expect(await table.locator('tbody tr').count()).toBe(50);
    await page.getByLabel('Поиск по строкам', { exact: true }).fill('99999');
    await page.getByText('Показано 1 из 1 строк', { exact: true }).waitFor();
    expect(await table.locator('tbody tr').count()).toBe(1);
    expect(await table.locator('tbody').textContent()).toContain('99999');
    await page.getByLabel('Поиск по строкам', { exact: true }).fill('');
    await page.getByText('Показано 50 из 100000 строк', { exact: true }).waitFor();
    const sorted = page.waitForResponse(response => response.url().endsWith('/queries/raw.files.rows') && response.request().postDataJSON()?.filter?.sortColumn === 'Value');
    await table.getByRole('button', { name: 'Value', exact: true }).click();
    const sortData = (await (await sorted).json()).data;
    expect(sortData.page.total).toBe(100000);
    expect(sortData.rows).toHaveLength(50);
    expect(sortData.rows[0].values.Value).toBe('0');
    await page.getByRole('button', { name: 'Следующие строки', exact: true }).click();
    await page.getByRole('button', { name: 'Первые строки', exact: true }).waitFor();
    expect(await table.locator('tbody tr').count()).toBe(50);
    const original = await f.request.response(`/api/v1/raw-files/${saved.result.id}/download`);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(csv);
    expect(f.runtime.deps.repository.exportWorkspaceCore().some(record => record.entityType === 'observed_fact')).toBe(false);
    const overflows: Record<string, boolean> = {};
    for (const width of [1440, 1024, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      overflows[String(width)] = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflows[String(width)]).toBe(false);
      if (process.env.UOR_UI_ARTIFACT_DIR) {
        await mkdir(process.env.UOR_UI_ARTIFACT_DIR, { recursive: true });
        await table.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(process.env.UOR_UI_ARTIFACT_DIR, `raw-100k-${width}.png`) });
      }
    }
    expect(errors).toEqual([]);
    if (process.env.UOR_UI_ARTIFACT_DIR) await writeFile(path.join(process.env.UOR_UI_ARTIFACT_DIR, 'raw-100k-browser.json'), JSON.stringify({ browser: browser.version(), syntheticOnly: true, rows: 100000, renderedRows: 50, searchFindsLastRow: true, sorting: 'server', afterRestart: true, noFactsCreated: true, fixtureSha256: createHash('sha256').update(csv).digest('hex'), overflows, pageErrors: errors }, null, 2) + '\n');
  } finally {
    await browser?.close();
    await host?.close();
    await f.close();
  }
}, 90000);
