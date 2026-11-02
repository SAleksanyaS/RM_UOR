import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Download } from 'playwright';
import { createBrowserIntegrationHarness } from './fixtures/workbench/browser-integration';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function bytes(download: Download) { const stream = await download.createReadStream(); if (!stream) throw Error('Actual browser download missing'); const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }

it('shared_wizard_records_tests_saves_and_reader_downloads_in_actual_edge_at_320_360_1024', async () => {
  const f = await createBrowserIntegrationHarness(); closes.push(f.close);
  const ui = await f.curator.openUi(), page = ui.page;
  await page.getByRole('button', { name: 'Выбрать признак открытого отчёта' }).waitFor();
  for (const width of [320, 360, 1024]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
  const markerLaunch = f.native.launchCount();
  await page.getByRole('button', { name: 'Выбрать признак открытого отчёта' }).click(); await f.native.waitForLaunch(markerLaunch);
  await f.native.login(); await f.native.page().locator('[data-testid="report-ready"]').click();
  await page.getByText('Признак отчёта: report-ready', { exact: true }).waitFor();
  const recordLaunch = f.native.launchCount(), preparedPage = f.native.page();
  await page.getByRole('button', { name: 'Открыть СберБраузер и записать действия' }).click();
  await page.getByText('Запись в отдельном окне браузера.', { exact: true }).waitFor();
  expect(f.native.launchCount()).toBe(recordLaunch); expect(f.native.page()).toBe(preparedPage);
  await f.native.page().getByLabel('Период', { exact: true }).fill('2026-09'); await f.native.page().getByLabel('Период', { exact: true }).press('Tab'); await f.native.page().getByLabel('Период', { exact: true }).fill('2026-10'); await f.native.page().getByLabel('Период', { exact: true }).press('Tab');
  await f.native.page().getByLabel('Состав', { exact: true }).selectOption('all');
  await f.native.page().getByRole('button', { name: 'Выгрузить CSV' }).click({ noWaitAfter: true }); await f.report.waitForEvent('export-requested'); f.report.release('download');
  await page.getByLabel('Значение фильтра «Период»', { exact: true }).fill('2026-10').catch(async error => { await page.screenshot({ path: '.runtime/validation/workbench/continuation/t47-ui-failure.png', fullPage: true }); throw Error(String(error) + '\n' + await page.locator('body').innerText()); }); await page.getByLabel('Значение фильтра «Состав»', { exact: true }).fill('all');
  await page.getByLabel('Обязательные столбцы', { exact: true }).fill('Key,Product,Leader,Amount,Date');
  await page.getByText('Снимки записанных действий', { exact: true }).click();
  await page.locator('img.wb-browser-screenshot').first().waitFor(); expect(await page.locator('img.wb-browser-screenshot').first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.getByRole('button', { name: 'Проверить сценарий', exact: true }).click(); await f.report.waitForEvent('export-requested'); f.report.release('download');
  await page.getByText('Принято для предпросмотра: 2000; отклонено: 0.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Сохранить сценарий в черновик', exact: true }).click(); await page.getByRole('link', { name: 'Перейти к пакету УОР', exact: true }).waitFor();
  for (const width of [320, 360, 1024]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: `.runtime/validation/workbench/continuation/t47-shared-wizard-${width}.png`, fullPage: true }); }
  await page.getByRole('link', { name: '3. Проверка', exact: true }).focus(); expect(await page.getByRole('link', { name: '3. Проверка', exact: true }).evaluate(el => el === document.activeElement)).toBe(true);
  expect(f.acceptedCaptures()).toHaveLength(0); await f.applyVerifiedSyntheticMain();
  const reader = f.reader(), readerUi = await reader.openUi(), readerPage = readerUi.page;
  const loginLaunch = f.native.launchCount();
  await readerPage.getByRole('button', { name: 'Открыть браузер для входа', exact: true }).click(); await f.native.waitForLaunch(loginLaunch);
  expect(await f.native.page().context().cookies()).toEqual([]); await f.native.login();
  await readerPage.getByRole('button', { name: 'Проверить вход', exact: true }).click(); await readerPage.getByText('Вход подтверждён по открытому отчёту.', { exact: true }).waitFor();
  await readerPage.getByRole('button', { name: 'Обновить данные', exact: true }).click(); await f.report.waitForEvent('export-requested');
  await readerPage.getByRole('button', { name: 'Обзор', exact: true }).click(); f.report.release('download'); await reader.commands.idle();
  expect(reader.sources.listOwnCaptures(reader.owner)[0].capture.acceptedRows).toBe(2000);
  await readerPage.getByRole('button', { name: 'Данные', exact: true }).click();
  const originalEvent = readerPage.waitForEvent('download'); await readerPage.getByRole('link', { name: 'Скачать исходную выгрузку', exact: true }).click(); const original = await bytes(await originalEvent);
  const enrichedEvent = readerPage.waitForEvent('download'); await readerPage.getByRole('link', { name: 'Скачать обогащённый CSV', exact: true }).click(); const enriched = await bytes(await enrichedEvent);
  expect(original.toString().trimEnd().split('\n')).toHaveLength(2001); expect(enriched.toString().split('\r\n')).toHaveLength(2001);
  expect('sha256:' + createHash('sha256').update(original).digest('hex')).toBe(reader.sources.listOwnCaptures(reader.owner)[0].capture.payloadHash);
  expect(f.count('attestation')).toBe(0); expect(f.externalWriteCalls()).toBe(0);
}, 120000);
