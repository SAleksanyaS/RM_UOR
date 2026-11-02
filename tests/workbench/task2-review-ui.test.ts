import { expect, it } from 'vitest';
import { createLocalRuntime, codeRoot } from './helpers/runtime';
import { createOkoWorkflowStore } from '../../src/features/connectors/workbench-workflow-store';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE)('renders real explicit/absent provenance and keeps arrow-focused destinations visible at narrow width', async () => {
  const f = await createLocalRuntime();
  let host: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const session = await f.request.session();
    const store = createOkoWorkflowStore(f.runtime.deps.repository);
    const owner = f.runtime.deps.installationId + '/' + session.personId;
    const metadata = { pageUrl: 'https://confluence.example.test/pages/viewpage.action?pageId=123', attachmentId: '456', version: 7 };
    const capture = { schemaVersion: 1 as const, captureId: randomUUID(), operationId: randomUUID(), workflowId: randomUUID(), sourceId: randomUUID(), title: 'Синтетическое вложение', origin: 'record' as const, sourceKind: 'confluence' as const, sourceMetadata: metadata, createdAt: f.runtime.deps.clock.now() };
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Проверенный лист').addRows([['Команда', 'Значение'], ['Тестовая команда', 12]]);
    store.beginCapture(owner, capture);
    store.commitCapture(owner, capture.captureId, { name: 'attachment.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: Buffer.from(await book.xlsx.writeBuffer()) });
    store.updateExportOutcome(owner, capture.captureId, { rowCount: 1, sourceDate: '2026-10-30' });
    const detail = await f.request.query('raw.files.detail', { id: capture.captureId });
    expect(detail.provenance.sourceMetadata).toEqual(metadata);
    expect(detail.provenance.sheet).toBe('Проверенный лист');
    expect(detail.sourceDate).toBe('2026-10-30');
    const absent = await f.request.command('raw.capture.manual', { title: 'Без метаданных', columns: ['A'], rows: [['1']] });
    const absentDetail = await f.request.query('raw.files.detail', { id: absent.result.id });
    expect(absentDetail.provenance.sourceMetadata).toBeNull();

    host = await createServer({ configFile: path.join(codeRoot, 'vite.config.ts'), root: codeRoot, cacheDir: path.join(f.root, '.runtime/vite-cache'), server: { host: '127.0.0.1', port: f.ui, strictPort: true, proxy: { '/api': f.origin } } });
    await host.listen();
    browser = await chromium.launch({ executablePath: process.env.UOR_TEST_BROWSER_EXECUTABLE!, headless: true, chromiumSandbox: process.env.UOR_SYNTHETIC_CI !== '1' });
    const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + f.ui + '/data?file=' + capture.captureId);
    await page.getByText('Происхождение и проверка целостности', { exact: true }).click();
    const provenance = page.locator('.wb-raw-provenance');
    const value = (label: string) => provenance.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
    expect(await value('Версия вложения').textContent()).toBe('7');
    expect(await value('Идентификатор вложения').textContent()).toBe('456');
    expect(await value('Лист таблицы').textContent()).toBe('Проверенный лист');
    expect(await value('Дата в источнике').textContent()).toBe('2026-10-30');
    expect(await value('Операция получения').textContent()).toBe(capture.operationId);
    expect(await provenance.getByRole('link').getAttribute('href')).toBe(metadata.pageUrl);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.UOR_UI_ARTIFACT_DIR) {
      await mkdir(process.env.UOR_UI_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.UOR_UI_ARTIFACT_DIR, 'provenance-expanded-320.png'), fullPage: true });
    }
    await page.goto('http://127.0.0.1:' + f.ui + '/data?file=' + absent.result.id);
    await page.getByText('Происхождение и проверка целостности', { exact: true }).click();
    expect(await value('Страница источника').textContent()).toBe('Не указана');
    expect(await value('Версия вложения').textContent()).toBe('Не указана');
    expect(await value('Дата в источнике').textContent()).toBe('Не указана');
    await page.getByRole('button', { name: 'Быстрый переход', exact: true }).click();
    const input = page.getByRole('searchbox', { name: 'Найти раздел' }); await input.focus();
    const focusChecks: unknown[] = [];
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press('ArrowDown');
      const check = await page.evaluate(() => {
        const focus = document.activeElement as HTMLElement, dialog = document.querySelector('.wb-quick-nav')!;
        const rect = focus.getBoundingClientRect(), bounds = dialog.getBoundingClientRect();
        return { label: focus.textContent, nativeButton: focus.tagName === 'BUTTON', top: rect.top, bottom: rect.bottom, visible: rect.top >= Math.max(0, bounds.top) && rect.bottom <= Math.min(innerHeight, bounds.bottom) };
      });
      expect(check.nativeButton).toBe(true); expect(check.visible).toBe(true); focusChecks.push(check);
    }
    expect(await page.locator(':focus').textContent()).toContain('Обновления и копии');
    await page.keyboard.press('Tab'); expect(await page.locator(':focus').getAttribute('aria-label')).toContain('избранное');
    if (process.env.UOR_UI_ARTIFACT_DIR) {
      await page.keyboard.press('Shift+Tab');
      await page.screenshot({ path: path.join(process.env.UOR_UI_ARTIFACT_DIR, 'quick-arrow-last-320.png'), fullPage: true });
      await writeFile(path.join(process.env.UOR_UI_ARTIFACT_DIR, 'review-metadata.json'), JSON.stringify({ browser: await browser.version(), node: process.version, chromiumSandbox: process.env.UOR_SYNTHETIC_CI !== '1', viewport: { width: 320, height: 900 }, focusChecks, errors }, null, 2));
    }
    await page.keyboard.press('Escape');
    expect(await page.locator(':focus').getAttribute('aria-label')).toBe('Быстрый переход');
    expect(errors).toEqual([]);
  } finally { await browser?.close(); await host?.close(); await f.close(); }
}, 90000);
