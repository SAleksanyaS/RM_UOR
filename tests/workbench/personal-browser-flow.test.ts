import { afterEach, expect, it } from 'vitest';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { chromeExecutable, createLocalBrowserRun, downloadedBytes } from './helpers/browser';
import { rawPersonalReport, startPersonalReport } from './helpers/personal-report';
import { fixtureId } from '../fixtures/workbench/factories';
import type { OkoWorkspaceView } from '../../src/features/connectors/workbench-workflow-contracts';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const dictionaryColumns = ['key', 'productId', 'productName', 'clusterId', 'clusterName', 'ditId', 'ditName', 'clusterLeaderId', 'clusterLeaderName', 'productLeaderId', 'productLeaderName'];
function dictionary(key: string, leader: string) { return Buffer.from(dictionaryColumns.join(';') + '\n' + [key, fixtureId(88001), 'Человеческий продукт', fixtureId(88002), 'Локальный кластер', fixtureId(88003), 'Локальный ДИТ', fixtureId(88004), 'Руководитель кластера', fixtureId(88005), leader].join(';') + '\n'); }

it('personal_record_download_correct_directory_enrich_download_and_restart_in_chrome', async () => {
  const executablePath = await chromeExecutable();
  const report = await startPersonalReport(); closes.push(report.close);
  const contexts = new Set<BrowserContext>(), launches: BrowserContext[] = [], waiters: Array<{ resolve(context: BrowserContext): void; reject(error: unknown): void }> = [];
  let launchFailure: unknown = null;
  closes.push(async () => { await Promise.all([...contexts].map(context => context.close())); });
  const f = await createLocalBrowserRun({ browserLauncher: { async launchPersistent(_profile, folder, options) {
    try {
      const context = await chromium.launchPersistentContext(folder, { ...options, executablePath, channel: undefined, headless: true }); contexts.add(context); launches.push(context);
      context.once('close', () => contexts.delete(context)); for (const waiter of waiters.splice(0)) waiter.resolve(context); return context;
    } catch (error) { launchFailure = error; for (const waiter of waiters.splice(0)) waiter.reject(error); throw error; }
  } } }); closes.push(f.close);
  const launched = (after: number) => launches.length > after ? Promise.resolve(launches[after]) : launchFailure ? Promise.reject(launchFailure) : new Promise<BrowserContext>((resolve, reject) => { const timer = setTimeout(() => reject(Error('Actual browser was not launched')), 20000); waiters.push({ resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } }); });
  const nativePage = (): Page => { const page = launches.at(-1)?.pages()[0]; if (!page) throw Error('No actual owned browser page'); return page; };
  const page = f.page;
  const failures: string[] = []; page.on('pageerror', error => failures.push(String(error)));
  try {
    await page.goto(f.origin + '/data');
    await page.getByRole('button', { name: 'Создать первый сценарий' }).click();
    await page.getByRole('heading', { name: 'Новый отчёт ОКО' }).waitFor();
    await page.getByLabel('Адрес отчёта', { exact: true }).fill(report.origin + '/report');
    await page.getByLabel('Установленный браузер', { exact: true }).selectOption('chrome');
    await page.getByRole('button', { name: 'Сохранить личный профиль', exact: true }).click();
    await page.getByText('Личный профиль настроен · изменить', { exact: true }).waitFor();
    let before = launches.length;
    await page.getByRole('button', { name: 'Открыть браузер для входа', exact: true }).click(); await launched(before);
    await nativePage().getByLabel('Пароль стенда', { exact: true }).fill('synthetic-secret-never-recorded');
    await nativePage().getByRole('button', { name: 'Войти в тестовый отчёт', exact: true }).click();
    await nativePage().locator('[data-testid="personal-ready"]').waitFor();
    await page.getByRole('button', { name: 'Завершить ручной вход', exact: true }).click();
    await page.getByRole('button', { name: 'Завершить ручной вход', exact: true }).waitFor({ state: 'hidden' });
    before = launches.length;
    await page.getByRole('button', { name: 'Выбрать элемент отчёта в браузере', exact: true }).click(); await launched(before);
    await nativePage().locator('[data-testid="personal-ready"]').click();
    await page.getByRole('button', { name: 'Выбрать другой элемент отчёта', exact: true }).waitFor();
    await page.getByText('Как читать файл CSV / XLSX', { exact: true }).click();
    await page.locator('#source-delimiter').selectOption(';');
    before = launches.length;
    await page.getByRole('button', { name: 'Начать запись действий', exact: true }).click(); await launched(before);
    await nativePage().getByLabel('Период', { exact: true }).fill('2026-09'); await nativePage().getByLabel('Период', { exact: true }).press('Tab');
    await nativePage().getByLabel('Период', { exact: true }).fill('2026-10'); await nativePage().getByLabel('Период', { exact: true }).press('Tab');
    await nativePage().getByLabel('Состав', { exact: true }).selectOption('all');
    let exportBefore = report.exportCount();
    await nativePage().getByRole('button', { name: 'Выгрузить CSV', exact: true }).click({ noWaitAfter: true });
    await report.waitForExport(exportBefore); report.release();
    await page.getByText('Запись завершена. Шаги и образец файла получены.', { exact: true }).waitFor();
    for (const input of await page.locator('input[id^="parameter-"]').all()) await input.fill((await input.getAttribute('id'))?.includes('scope') ? 'all' : '2026-10');
    await page.getByRole('group', { name: 'Уникальный ключ строки', exact: true }).getByLabel('RowId', { exact: true }).check();
    await page.getByLabel('Ключ продукта для справочника', { exact: true }).selectOption('ProductAlias');
    await page.getByLabel('Дата данных', { exact: true }).selectOption('Date');
    await page.getByLabel('Единица измерения — постоянная', { exact: true }).fill('руб');
    await page.getByRole('group', { name: 'Числовые значения', exact: true }).getByLabel('Столбец «value»', { exact: true }).selectOption('Amount');
    await page.getByRole('button', { name: 'Сохранить сопоставление и фильтры', exact: true }).click();
    await page.getByText('Сопоставление и значения фильтров сохранены. Можно проверить сценарий.', { exact: true }).waitFor();
    const workspace = () => f.request.query<OkoWorkspaceView>('oko.workflow.workspace');
    const upload = async (key: string, leader: string, map: boolean) => {
      await page.getByLabel('Файл справочника', { exact: true }).setInputFiles({ name: 'directory.csv', mimeType: 'text/csv', buffer: dictionary(key, leader) });
      await page.getByRole('button', { name: 'Прочитать столбцы справочника', exact: true }).click();
      const section = page.getByRole('region', { name: 'Обогащение из справочника', exact: true });
      if (map) for (const [label, column] of [ ['Ключ продукта в ОКО', 'key'], ['ID продукта (UUID)', 'productId'], ['Название продукта', 'productName'], ['ID кластера (UUID)', 'clusterId'], ['Название кластера', 'clusterName'], ['ID ДИТ (UUID)', 'ditId'], ['Название ДИТ', 'ditName'], ['ID руководителя кластера (UUID)', 'clusterLeaderId'], ['Руководитель кластера', 'clusterLeaderName'], ['ID руководителя продукта (UUID)', 'productLeaderId'], ['Руководитель продукта', 'productLeaderName'] ]) await section.getByLabel(label, { exact: true }).selectOption(column);
      await section.getByRole('button', { name: 'Применить справочник к предпросмотру', exact: true }).click();
      await page.getByText('Используется личный справочник для предпросмотра.', { exact: true }).waitFor();
    };
    const run = async (previousId: string | null) => {
      const old = report.exportCount(); await page.getByRole('button', { name: 'Проверить сценарий и получить данные', exact: true }).click();
      await report.waitForExport(old); report.release();
      await expect.poll(async () => { const id = (await workspace()).current?.result?.resultId; return typeof id === 'string' && id !== previousId; }, { timeout: 30000 }).toBe(true);
      await page.getByRole('link', { name: 'Скачать обогащённый CSV', exact: true }).waitFor();
      return (await workspace()).current!.result!;
    };
    await upload('UNMATCHED-ALIAS', 'Руководитель продукта', true);
    const unresolved = await run(null); expect(unresolved.unresolvedRows).toBe(2);
    expect(unresolved.issues.some(issue => issue.code === 'UNMAPPED_PRODUCT')).toBe(true);
    await page.getByRole('button', { name: 'Показать замечания', exact: true }).click();
    await page.getByText('Продукт не найден в справочнике. Проверьте ключ продукта в исходном файле и добавьте или исправьте его в справочнике.', { exact: true }).first().waitFor();
    await upload('ALIAS-A', 'Руководитель продукта', false);
    const enriched = await run(unresolved.resultId); expect(enriched.unresolvedRows).toBe(0);
    await page.getByRole('button', { name: 'Все столбцы', exact: true }).click();
    await page.getByRole('region', { name: 'Результат обогащения', exact: true }).getByText('Руководитель продукта', { exact: true }).first().waitFor();
    let event = page.waitForEvent('download'); await page.getByRole('link', { name: 'Скачать исходный файл', exact: true }).click(); const original = await downloadedBytes(await event);
    expect(original).toEqual(rawPersonalReport); expect(original.toString()).not.toContain('Руководитель');
    event = page.waitForEvent('download'); await page.getByRole('link', { name: 'Скачать обогащённый CSV', exact: true }).click(); const enrichedBytes = await downloadedBytes(await event);
    expect(enrichedBytes.toString()).toContain('Руководитель продукта'); expect(enrichedBytes.toString()).toContain('Человеческий продукт');
    expect(enrichedBytes.toString()).toContain('derived.directory.productName'); expect(enrichedBytes.toString()).toContain('9007199254740993.25');
    expect(enrichedBytes.toString()).toContain("'=row-1");
    for (const width of [320, 360, 1024]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: f.artifact('personal-result-' + width + '.png'), fullPage: true }); }
    await upload('ALIAS-A', 'Исправленный руководитель', false);
    const changed = await run(enriched.resultId); expect(changed.resultId).not.toBe(enriched.resultId);
    const oldLink = '/api/v1/browser/results/' + enriched.resultId + '/enriched';
    expect(Buffer.from(await (await f.request.response(oldLink)).arrayBuffer())).toEqual(enrichedBytes);
    expect(JSON.stringify((await workspace()).current!.recording.steps)).not.toContain('synthetic-secret');
    await page.getByRole('button', { name: 'Обслуживание рабочего места', exact: true }).click();
    const maintenance = page.getByRole('dialog', { name: 'Обслуживание рабочего места', exact: true });
    await maintenance.getByRole('button', { name: 'Создать копию', exact: true }).click();
    await maintenance.getByRole('heading', { name: 'Копия создана', exact: true }).waitFor();
    event = page.waitForEvent('download'); await maintenance.getByRole('link', { name: 'Скачать созданную копию', exact: true }).click();
    const archive = await downloadedBytes(await event); expect(archive.subarray(0, 2).toString()).toBe('PK');
    await maintenance.getByRole('button', { name: 'Закрыть обслуживание', exact: true }).click();
    await page.getByRole('button', { name: 'Новый сценарий', exact: true }).click();
    await page.getByLabel('Название отчёта', { exact: true }).fill('После копии');
    await page.getByRole('button', { name: 'Создать сценарий', exact: true }).click();
    await page.getByRole('heading', { name: 'После копии', exact: true }).waitFor();
    expect((await workspace()).workflows).toHaveLength(2);
    await page.getByRole('button', { name: 'Обслуживание рабочего места', exact: true }).click();
    await maintenance.getByLabel('Архив рабочего места', { exact: true }).setInputFiles({ name: 'workbench.zip', mimeType: 'application/zip', buffer: archive });
    await maintenance.getByRole('button', { name: 'Проверить архив', exact: true }).click();
    await maintenance.getByRole('heading', { name: 'Проверенный архив', exact: true }).waitFor();
    expect(await maintenance.getByRole('button', { name: 'Заменить данные', exact: true }).isDisabled()).toBe(true);
    await maintenance.getByLabel('Подтверждаю замену текущих данных архивом', { exact: true }).check();
    for (const width of [320, 360, 1024]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.screenshot({ path: f.artifact('personal-restore-' + width + '.png'), fullPage: true }); }
    await maintenance.getByRole('button', { name: 'Заменить данные', exact: true }).click();
    await maintenance.getByRole('heading', { name: 'Восстановление завершено', exact: true }).waitFor();
    expect(await maintenance.getByRole('link', { name: 'Скачать защитную копию', exact: true }).isVisible()).toBe(true);
    await maintenance.getByRole('button', { name: 'Закрыть обслуживание', exact: true }).click();
    await page.reload(); await page.getByRole('heading', { name: 'Новый отчёт ОКО' }).waitFor();
    await f.request.session(); expect((await workspace()).workflows).toHaveLength(1);
    expect(Buffer.from(await (await f.request.response(oldLink)).arrayBuffer())).toEqual(enrichedBytes);
    await page.goto('about:blank'); await f.restart(); await f.request.session(); await page.goto(f.origin + '/data');
    await page.getByRole('heading', { name: 'Новый отчёт ОКО' }).waitFor();
    expect(Buffer.from(await (await f.request.response(oldLink)).arrayBuffer())).toEqual(enrichedBytes);
    const originalAfter = Buffer.from(await (await f.request.response('/api/v1/browser/results/' + enriched.resultId + '/original')).arrayBuffer());
    expect(createHash('sha256').update(originalAfter).digest('hex')).toBe(createHash('sha256').update(rawPersonalReport).digest('hex'));
    expect(failures).toEqual([]);
  } catch (error) { await page.screenshot({ path: f.artifact('personal-failure.png'), fullPage: true }); throw Error(String(error) + '\n' + await page.locator('body').innerText()); }
}, 180000);
