import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { expect } from 'vitest';
import { chromeExecutable, createLocalBrowserRun } from './browser';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor } from '../../fixtures/workbench/factories';
import type { DirectoryEntity, DirectoryLink, SourceDefinition, SourceFieldMapping, WorkbenchEntity } from '../../../src/domain/workbench/entities';
import type { WorkbenchRepository } from '../../../src/server/storage/workbench-repository';
import type { WorkbenchReadModels } from '../../../src/features/catalog/workbench-read-models';
import type { BrowserScenarioTestResult } from '../../../src/features/connectors/workbench-browser-scenarios';
import type { PublicationGitPort } from '../../../src/features/publishing/workbench/git-port';
import type { PackagePreviewResult } from '../../../src/features/publishing/workbench/contracts';

export const goalReportBytes = Buffer.from('RowId;ProductAlias;Amount;Date\nrow-1;ALIAS-1;12.5;2026-10-28\nrow-2;ALIAS-2;24.5;2026-10-28\nrow-3;ALIAS-3;36.5;2026-10-28\nrow-4;UNKNOWN;bad-number;2026-10-28\n');
const ids = { dit: fixtureId(910001), cluster: fixtureId(910002), person: fixtureId(910003), products: [fixtureId(910011), fixtureId(910012), fixtureId(910013)] };

/** A separately served synthetic report. Export readiness is an HTTP event and explicit gate. */
async function startGoalReport() {
  let origin = '', exports = 0, closed = false;
  const gates: Array<() => void> = [], waiters: Array<{ after: number; resolve(): void }> = [];
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url ?? '/', origin);
    if (url.pathname === '/export') {
      exports++; for (let index = waiters.length - 1; index >= 0; index--) if (exports > waiters[index].after) waiters.splice(index, 1)[0].resolve();
      await new Promise<void>(resolve => gates.push(resolve));
      if (closed || response.destroyed) return;
      response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="goal-report.csv"', 'content-length': goalReportBytes.length }); response.end(goalReportBytes); return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><meta charset="utf-8"><main><h1 data-testid="goal-ready">Новый синтетический отчёт</h1><form action="/export"><label for="period">Период</label><input id="period" name="period" value="2026-10"><button id="export">Выгрузить CSV</button></form></main>');
  })().catch(() => response.destroy()); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  return { origin, count: () => exports, wait(after: number) { return exports > after ? Promise.resolve() : new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error('No actual goal export after count ' + after)), 20000); waiters.push({ after, resolve() { clearTimeout(timer); resolve(); } }); }); }, release() { const resolve = gates.shift(); if (!resolve) throw Error('No actual export waiting'); resolve(); }, async close() { closed = true; for (const resolve of gates.splice(0)) resolve(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); } };
}

/** Only published organization/catalog fixtures enter through this trusted repository port. */
function seedOrganization(repository: WorkbenchRepository) {
  const anchor = makePublicationAnchor({ id: fixtureId(910000), packageId: fixtureId(910000) });
  const header = (id: string) => ({ ...makeHeader(0), id, publicationAnchorId: anchor.id });
  const entities: DirectoryEntity[] = [
    { ...header(ids.dit), kind: 'dit', name: 'Синтетический ДИТ новой цели', externalKeys: [] },
    { ...header(ids.cluster), kind: 'cluster', name: 'Синтетический кластер', externalKeys: [] },
    { ...header(ids.person), kind: 'person', name: 'Синтетический куратор', externalKeys: [] },
    ...ids.products.map((id, index): DirectoryEntity => ({ ...header(id), kind: 'product', name: 'Синтетический продукт ' + (index + 1), externalKeys: [] })),
  ];
  const ref = (id: string) => ({ entityType: 'directory_entity', id });
  const links: DirectoryLink[] = [
    { ...header(fixtureId(910020)), kind: 'dit_cluster', from: ref(ids.dit), to: ref(ids.cluster) },
    { ...header(fixtureId(910021)), kind: 'leader', scope: { kind: 'cluster', id: ids.cluster }, personId: ids.person },
    ...ids.products.flatMap((id, index): DirectoryLink[] => [
      { ...header(fixtureId(910030 + index)), kind: 'cluster_product', from: ref(ids.cluster), to: ref(id) },
      { ...header(fixtureId(910040 + index)), kind: 'leader', scope: { kind: 'product', id }, personId: ids.person },
    ]),
  ];
  repository.transaction(() => { repository.appendPublicationAnchor(anchor, null); for (const entity of entities) repository.append('directory_entity', entity, null); for (const link of links) repository.append('directory_link', link, null); });
  return { entities, links, bindSource(sourceId: string) { repository.transaction(() => { ids.products.forEach((id, index) => { const old = repository.readPublishedHead<DirectoryEntity>(ref(id))!; const value = { ...old, revision: old.revision + 1, externalKeys: [{ sourceId, key: 'ALIAS-' + (index + 1) }] }; repository.append('directory_entity', value, old.revision); entities[entities.findIndex(entity => entity.id === id)] = value; }); }); } };
}

export async function responsiveProof(page: Page, artifact: (name: string) => string, prefix: string) {
  for (const width of [1024, 360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: artifact(prefix + '-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1024, height: 900 });
}

export async function createGoalBrowserRun() {
  const executablePath = await chromeExecutable();
  const report = await startGoalReport(), contexts = new Set<BrowserContext>(), launches: BrowserContext[] = [];
  const downloadDirectories = new Map<BrowserContext, string>();
  const launchWaiters: Array<{ after: number; resolve(context: BrowserContext): void; reject(error: unknown): void }> = [];
  let launchFailure: unknown = null;
  const mainFiles = new Map<string, Uint8Array>();
  const git: PublicationGitPort = { async readMain() { return { repositoryId: 'synthetic-goal-main', commit: 'a'.repeat(40), files: new Map(mainFiles) }; }, async prepare() { throw Error('New-goal preview must not publish'); }, async inspectRemote() { return null; }, async verifyPrepared() { throw Error('New-goal preview must not publish'); } };
  let f: Awaited<ReturnType<typeof createLocalBrowserRun>>;
  try { f = await createLocalBrowserRun({ git, classification: { mode: 'demo-only', classifyRecord: () => true }, browserLauncher: { async launchPersistent(_profile, folder, options) {
    try {
    const context = await chromium.launchPersistentContext(folder, { ...options, executablePath, channel: undefined, headless: true, chromiumSandbox: process.env.UOR_SYNTHETIC_CI !== '1' }); contexts.add(context); launches.push(context); context.once('close', () => contexts.delete(context));
    // Observe the actual engine directory: a retained context can rebind CDP
    // downloads while Playwright still reports its original launch directory.
    const originalSession = context.newCDPSession.bind(context);
    context.newCDPSession = async target => {
      const session = await originalSession(target), send = session.send.bind(session);
      session.send = (async (method: string, parameters?: { downloadPath?: string }) => {
        const result = await send(method as never, parameters as never);
        if (method === 'Browser.setDownloadBehavior' && typeof parameters?.downloadPath === 'string') downloadDirectories.set(context, parameters.downloadPath);
        return result;
      }) as typeof session.send;
      return session;
    };
    for (let index = launchWaiters.length - 1; index >= 0; index--) if (launches.length > launchWaiters[index].after) { const waiter = launchWaiters.splice(index, 1)[0]; waiter.resolve(launches[waiter.after]); } return context;
    } catch (error) { launchFailure = error; for (const waiter of launchWaiters.splice(0)) waiter.reject(error); throw error; }
  } } }); } catch (error) { await report.close(); throw error; }
  const organization = seedOrganization(f.runtime.deps.repository), page = f.page;
  const context = () => f.request.session().then(session => session.defaultContext!);
  const ownPackage = async () => { const ctx = await context(); const queue = await f.request.query<WorkbenchReadModels['uor.queue']>('uor.queue', {}, ctx); expect(queue.items).toHaveLength(1); return f.request.query<WorkbenchReadModels['uor.package']>('uor.package', { packageRef: queue.items[0].packageRef }, ctx); };
  const commands: Array<{ commandId: string; name: string; baseRevision: string | null; payload: any }> = [];
  page.on('request', request => { if (request.url().endsWith('/api/v1/commands') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  const launched = (after: number) => launches.length > after ? Promise.resolve(launches[after]) : launchFailure ? Promise.reject(launchFailure) : new Promise<BrowserContext>((resolve, reject) => { const timer = setTimeout(() => reject(Error('No actual goal browser launch after count ' + after)), 20000); launchWaiters.push({ after, resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } }); });
  const nativePage = () => { const value = launches.at(-1)?.pages()[0]; if (!value) throw Error('No actual native page'); return value; };
  const refreshMain = () => { mainFiles.clear(); for (const entry of f.runtime.deps.repository.readPublishedCatalog()) mainFiles.set(`records/${entry.entityType}/${entry.value.id}/${entry.value.revision}.json`, Buffer.from(JSON.stringify(entry.value))); };
  refreshMain();
  let result: BrowserScenarioTestResult | undefined;
  async function createGoalThroughUI() {
    await page.goto(f.origin + '/uor');
    const create = page.getByRole('button', { name: 'Создать цель', exact: true }); await create.waitFor(); await create.focus(); expect(await create.evaluate(element => element === document.activeElement)).toBe(true); await page.keyboard.press('Enter');
    const goal = page.getByRole('dialog', { name: 'Настройка цели', exact: true });
    await goal.getByLabel('Название цели').fill('Новая цель из полного браузерного пути');
    await goal.getByLabel('Описание цели').fill('Синтетический локальный предпросмотр без принятия фактов');
    await goal.getByLabel('Способ оценки').selectOption('numeric'); await goal.getByLabel('Режим измерения').selectOption('as_of');
    await goal.getByLabel('Штатный источник').selectOption('qlik'); await goal.getByLabel('Состояние цели').selectOption('active');
    await goal.getByLabel('Без со-кураторов').check(); await goal.getByLabel('Основной куратор').selectOption(ids.person);
    await goal.getByRole('button', { name: 'Далее', exact: true }).click(); await goal.getByLabel('Область назначения').selectOption(ids.dit); await goal.getByLabel('Официальный срок не задан').check();
    for (const index of [1, 2, 3]) await goal.getByRole('group', { name: 'Ожидаемый состав — укажите явно', exact: true }).getByLabel('Синтетический продукт ' + index, { exact: true }).check();
    await goal.getByRole('button', { name: 'Далее', exact: true }).click(); await goal.getByLabel('Самостоятельная методика').click(); await expect.poll(() => goal.getByLabel('Самостоятельная методика').isChecked()).toBe(true);
    await goal.getByRole('button', { name: 'Далее', exact: true }).click(); await goal.getByRole('button', { name: 'Добавить показатель', exact: true }).click();
    const metric = goal.getByRole('group', { name: 'Показатель 1', exact: true }); await metric.getByLabel('Название показателя').fill('Сумма источника'); await metric.getByLabel('Код единицы').fill('units'); await metric.getByLabel('Единица измерения').fill('Единицы'); await metric.getByLabel('Область значений').selectOption('nonnegative_decimal');
    await metric.getByRole('combobox', { name: /^Условие/ }).selectOption('gte'); await metric.getByLabel('Порог').fill('10'); await metric.getByLabel('Обязательное условие').check(); await metric.getByLabel('Вес').fill('100');
    await metric.getByLabel('Нормирование').selectOption('increase_ratio_v1'); await metric.getByLabel('Допустимая давность, часы').fill('168'); await metric.getByLabel('Период обновления, часы').fill('24'); await metric.getByLabel('Обработка строк').selectOption('source_provided_value'); await metric.getByLabel('Поле значения').fill('amount');
    await goal.getByLabel('Итоговая формула').selectOption('weighted_mean_v1'); await goal.getByRole('combobox', { name: /^Условие/ }).last().selectOption('gte'); await goal.getByLabel('Итоговый порог').fill('100');
    await goal.getByRole('button', { name: 'Далее', exact: true }).click(); await goal.getByRole('button', { name: 'Сохранить черновик', exact: true }).click(); await goal.getByText('Черновик сохранён', { exact: true }).waitFor();
    const before = await ownPackage(); expect(before.entries.find(entry => entry.entityRef.entityType === 'goal_assignment')!.complete).toBe(true);
    const source = before.entries.find(entry => entry.entityRef.entityType === 'source_definition')!;
    await responsiveProof(page, f.artifact, 'new-goal');
    await goal.getByRole('button', { name: 'Настроить источник', exact: true }).click();
    const sourceDialog = page.getByRole('dialog', { name: 'Настройка источника', exact: true }); await sourceDialog.getByLabel('Ссылка ОКО').fill(report.origin + '/report');
    await sourceDialog.getByLabel('Столбцы ключа строки (через запятую)').fill('RowId'); await sourceDialog.getByLabel('Столбец ключа продукта').fill('ProductAlias'); await sourceDialog.getByLabel('Столбец даты наблюдения').fill('Date'); await sourceDialog.getByLabel('Фиксированная единица').fill('units'); await sourceDialog.getByLabel('Столбец значения amount').fill('Amount');
    await sourceDialog.getByRole('button', { name: 'Оставить необязательные соответствия пустыми', exact: true }).click(); await sourceDialog.getByRole('button', { name: 'Сохранить черновик настройки', exact: true }).click(); await sourceDialog.getByRole('heading', { name: 'Сценарий ОКО', exact: true }).waitFor();
    // New source IDs are private. Their aliases belong to that same own package,
    // rather than forging a published source merely to satisfy fixture references.
    for (const [index, id] of ids.products.entries()) {
      const pkg = await ownPackage();
      const opened = await f.request.command('draft.open', { entityType: 'directory_entity', ref: { entityType: 'directory_entity', id }, packageId: pkg.summary.packageRef.id }, pkg.summary.editToken);
      const entity = organization.entities.find(value => value.id === id)!;
      await f.request.command('organization.draft.save', { draftId: opened.result.draftId, definition: { kind: entity.kind, name: entity.name, externalKeys: [{ sourceId: source.entityRef.id, key: 'ALIAS-' + (index + 1) }] } }, opened.editToken);
    }
    await sourceDialog.getByRole('button', { name: 'Закрыть настройку', exact: true }).click();
    await goal.getByRole('button', { name: 'Закрыть настройку', exact: true }).click();
    await page.getByRole('button', { name: 'Продолжить настройку: Новая цель из полного браузерного пути', exact: true }).click();
    await goal.getByRole('button', { name: 'Пример и влияние', exact: true }).click();
    await goal.getByRole('button', { name: 'Настроить источник', exact: true }).click();
    await sourceDialog.getByRole('button', { name: 'Сохранить черновик настройки', exact: true }).click();
    await sourceDialog.getByRole('heading', { name: 'Сценарий ОКО', exact: true }).waitFor();
  }
  async function recordTestAndSaveThroughUI() {
    const wizard = page.getByRole('region', { name: 'Мастер сценария ОКО', exact: true });
    await wizard.getByLabel('Путь к СберБраузеру').fill(executablePath); await wizard.getByRole('button', { name: 'Сохранить личный профиль', exact: true }).click(); await wizard.getByText('Личный профиль сохранён.', { exact: true }).waitFor({ state: 'attached' });
    let before = launches.length; await wizard.getByRole('button', { name: 'Выбрать признак открытого отчёта', exact: true }).click(); await launched(before); await nativePage().locator('[data-testid="goal-ready"]').click(); await wizard.getByText(/Признак отчёта:/).waitFor();
    const preparedPage = nativePage(); before = launches.length; await wizard.getByRole('button', { name: 'Открыть СберБраузер и записать действия', exact: true }).click();
    await wizard.getByText('Запись в отдельном окне браузера.', { exact: true }).waitFor(); expect(launches.length).toBe(before); expect(nativePage()).toBe(preparedPage);
    await nativePage().getByLabel('Период').fill('2026-09'); await nativePage().getByLabel('Период').press('Tab'); await nativePage().getByLabel('Период').fill('2026-10'); await nativePage().getByLabel('Период').press('Tab');
    const exportBefore = report.count(), downloadEvent = nativePage().waitForEvent('download'); await nativePage().getByRole('button', { name: 'Выгрузить CSV', exact: true }).click({ noWaitAfter: true }); await report.wait(exportBefore); report.release();
    const nativeDownload = await downloadEvent, reportedPath = await nativeDownload.path(), directory = downloadDirectories.get(preparedPage.context());
    expect(await nativeDownload.failure()).toBeNull(); expect(reportedPath).toBeTruthy(); expect(directory).toBeTruthy();
    const guid = path.basename(reportedPath!); expect(guid).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
    // Read only this completed native Download's exact GUID, never a latest file
    // or the fixture response body. The production recorder is not used to read it.
    const actualDownload = await readFile(path.join(directory!, guid)); expect(actualDownload).toEqual(goalReportBytes);
    await wizard.getByRole('heading', { name: 'Проверка шагов и фильтров', exact: true }).waitFor(); for (const input of await wizard.getByLabel(/Значение фильтра/).all()) await input.fill('2026-10'); await wizard.getByLabel('Обязательные столбцы').fill('RowId,ProductAlias,Amount,Date');
    const finishCommand = [...commands].reverse().find(command => command.name === 'source.browser.record.finish')!;
    expect(await f.request.reconcile(finishCommand.commandId)).toMatchObject({ status: 'completed', result: { hasDownload: true } });
    const beforeTest = await ownPackage(), assignment = beforeTest.entries.find(entry => entry.entityRef.entityType === 'goal_assignment')!;
    const testResponse = page.waitForResponse(async response => response.url().endsWith('/api/v1/commands') && response.request().postDataJSON()?.name === 'source.browser.record.test');
    const replayBefore = report.count(); await wizard.getByRole('button', { name: 'Проверить сценарий', exact: true }).click(); await report.wait(replayBefore); report.release(); await testResponse;
    await wizard.getByText('Принято для предпросмотра: 3; отклонено: 1.', { exact: true }).waitFor();
    const testCommand = [...commands].reverse().find(command => command.name === 'source.browser.record.test')!; expect(testCommand.payload.assignmentRef).toEqual(assignment.versionRef); expect(testCommand.baseRevision).toMatch(/^draft:/);
    const receipt = await f.request.reconcile(testCommand.commandId); if (receipt.status !== 'completed') throw Error('Browser test command not completed: ' + JSON.stringify(receipt)); result = receipt.result as BrowserScenarioTestResult;
    expect(result.problems.map(problem => problem.code)).toContain('EXPORT_COVERAGE_UNVERIFIED');
    await responsiveProof(page, f.artifact, 'new-goal-data'); await wizard.getByRole('button', { name: 'Сохранить сценарий в черновик', exact: true }).click(); await wizard.getByText(/Сценарий сохранён|Черновик сохранён с замечаниями/).waitFor();
    await writeFile(f.artifact('new-goal-native-proof.json'), JSON.stringify({ browser: f.browser.version(), nativeLaunches: launches.length, actualReportDownloads: report.count(), nativeDownloadGuid: guid, finishedCommandId: finishCommand.commandId, downloadedSha256: createHash('sha256').update(actualDownload).digest('hex'), assignmentRef: assignment.versionRef, testCommand, result, realBankRequests: 0 }, null, 2));
    return result;
  }
  async function previewPackageThroughUI() {
    await page.getByRole('dialog', { name: 'Настройка источника', exact: true }).getByRole('button', { name: 'Закрыть настройку', exact: true }).click();
    await page.getByRole('dialog', { name: 'Настройка цели', exact: true }).getByRole('button', { name: 'Закрыть настройку', exact: true }).click(); await page.getByRole('button', { name: 'Проверить пакет', exact: true }).click(); await page.getByRole('region', { name: 'Предварительный просмотр', exact: true }).waitFor();
    await responsiveProof(page, f.artifact, 'new-goal-package');
    const pkg = await ownPackage(); expect(pkg.entries.filter(entry => entry.entityRef.entityType === 'core_goal_definition')).toHaveLength(1); expect(pkg.entries.filter(entry => entry.entityRef.entityType === 'browser_scenario')).toHaveLength(1);
    const core = f.runtime.deps.repository.exportWorkspaceCore(); expect(core.filter(record => ['capture', 'observed_fact', 'attestation', 'agreed_snapshot'].includes(record.entityType))).toHaveLength(0); expect(f.errors).toEqual([]);
    const packageCommand = [...commands].reverse().find(command => command.name === 'package.preview')!; expect(packageCommand.baseRevision).toBe(pkg.summary.editToken);
    const receipt = await f.request.reconcile(packageCommand.commandId); expect(receipt.status).toBe('completed');
    const preview = receipt.result as PackagePreviewResult; expect(preview.errors.length).toBeGreaterThan(0); expect(preview.errors.map(problem => problem.code)).not.toContain('DIRECTORY_INVENTORY_REQUIRED'); expect(await page.getByRole('button', { name: 'Отправить пакет в Bitbucket', exact: true }).isEnabled()).toBe(false);
    await writeFile(f.artifact('new-goal-package-proof.json'), JSON.stringify({ packageCommand, summary: pkg.summary, preview, facts: 0, attestations: 0 }, null, 2));
  }
  return { ...f, createGoalThroughUI, recordTestAndSaveThroughUI, previewPackageThroughUI, async close() { await report.close(); await Promise.all([...contexts].map(context => context.close())); await f.close(); } };
}

/** Separate file mode acceptance: this fixture is an already published file goal. */
export async function createFileImportBrowserRun() {
  const f = await createLocalBrowserRun(), repository = f.runtime.deps.repository, page = f.page;
  try {
    const organization = seedOrganization(repository);
    const input = makeNumericFixture({ seedBase: 920000, scope: { kind: 'dit', id: ids.dit }, expectedPopulation: ids.products.map(id => ({ kind: 'product' as const, id })) });
    input.goal.title = 'Синтетическая файловая цель'; input.goal.primaryCuratorPersonId = ids.person;
    const graph = makeEntityGraph(input), source = graph.entries.find(entry => entry.entityType === 'source_definition')!.value as SourceDefinition;
    Object.assign(source, { kind: 'file', publicLocator: null });
    const mapping = graph.entries.find(entry => entry.entityType === 'source_field_mapping')!.value as SourceFieldMapping;
    Object.assign(mapping, { rowKeyFields: ['RowId'], dimensionFields: {}, productKeyField: 'ProductAlias', fixedScope: null, metricFields: [{ metricId: input.metrics[0].id, fields: { demo_value: 'Amount' } }], dateField: 'Date', fixedUnitCode: 'demo_unit', parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' } });
    repository.transaction(() => { for (const anchor of graph.anchors) repository.appendPublicationAnchor(anchor, null); for (const entry of graph.entries) if (!['directory_entity', 'capture', 'observed_fact'].includes(entry.entityType)) repository.append(entry.entityType, entry.value, null); });
    organization.bindSource(source.id);
    const commands: Array<{ commandId: string; name: string; payload: any }> = [];
    page.on('request', request => { if (request.url().endsWith('/api/v1/commands') && request.method() === 'POST') commands.push(request.postDataJSON()); });
    async function importThroughUI() { await f.request.session();
      await page.goto(f.origin + '/data#goal-data'); await page.getByRole('button', { name: input.goal.title, exact: true }).click();
      const upload = page.getByRole('region', { name: 'Загрузка файла', exact: true });
      const inspect = async () => { await upload.getByLabel('Файл данных', { exact: true }).setInputFiles({ name: 'goal-import.csv', mimeType: 'text/csv', buffer: goalReportBytes }); await upload.getByRole('button', { name: 'Проверить файл', exact: true }).click(); await page.getByRole('region', { name: 'Предпросмотр импорта', exact: true }).waitFor(); };
      await inspect();
      const preview = page.getByRole('region', { name: 'Предпросмотр импорта', exact: true });
      const boxes = preview.getByRole('checkbox'); expect(await boxes.count()).toBe(4); expect(await preview.locator('input[type=checkbox]:disabled').count()).toBe(1);
      expect(repository.exportWorkspaceCore().filter(record => record.entityType === 'observed_fact')).toHaveLength(0);
      const accept = preview.getByRole('button', { name: 'Принять выбранные строки', exact: true }); expect(await accept.isEnabled()).toBe(false);
      await preview.getByRole('button', { name: 'Выбрать корректные строки', exact: true }).click(); expect(await preview.locator('input[type=checkbox]:checked').count()).toBe(3);
      await responsiveProof(page, f.artifact, 'file-import-preview');
      await accept.click(); await preview.getByText('Принято: 3; не принято: 1', { exact: true }).waitFor();
      const core = repository.exportWorkspaceCore(), facts = core.filter(record => record.entityType === 'observed_fact'); expect(facts).toHaveLength(3); expect(core.filter(record => record.entityType === 'capture')).toHaveLength(1); expect(core.filter(record => ['attestation', 'agreed_snapshot'].includes(record.entityType))).toHaveLength(0);
      const apply = commands.find(command => command.name === 'import.apply')!; expect(apply.payload.acceptedRowIds).toHaveLength(3); expect(apply.payload.acceptedCorrectionIds).toEqual([]);
      const receipt = await f.request.reconcile(apply.commandId); if (receipt.status !== 'completed') throw Error('Import command not complete');
      const applied = receipt.result as { captureRef: { id: string } };
      // Partial imports retain their original bytes, but the shared download URL
      // intentionally serves accepted captures only. Check persistence directly.
      const originalUrl = '/api/v1/browser/results/' + applied.captureRef.id + '/original'; expect((await f.request.response(originalUrl)).status).toBe(404);
      const capture = f.runtime.services.sources.readCapture({ entityType: 'capture', id: applied.captureRef.id, revision: 1 }, f.runtime.deps.installationId)!;
      expect(capture.capture.result).toBe('partial'); expect(capture.capture.rawRows).toHaveLength(4);
      const artifactId = capture.artifact!.artifactId;
      const savedOriginal = () => Buffer.from(repository.sqlForModule('sources').get<{ bytes_value: Uint8Array }>('SELECT bytes_value FROM wb_sources_artifacts WHERE installation_id=? AND artifact_id=?', [f.runtime.deps.installationId, artifactId])!.bytes_value);
      const original = savedOriginal(); expect(original).toEqual(goalReportBytes); f.runtime.services.sources.assertArtifact(f.runtime.deps.installationId, capture.artifact!);
      await responsiveProof(page, f.artifact, 'file-import-applied');
      const retry = await f.request.settle(await f.request.command('import.apply', apply.payload)); expect(retry.result.captureRef.id).toBe(applied.captureRef.id);
      expect(repository.exportWorkspaceCore().filter(record => record.entityType === 'capture')).toHaveLength(1);
      await inspect(); await preview.getByRole('button', { name: 'Выбрать корректные строки', exact: true }).click(); await preview.getByRole('button', { name: 'Принять выбранные строки', exact: true }).click(); await preview.getByText('Принято: 3; не принято: 1', { exact: true }).waitFor();
      const repeated = repository.exportWorkspaceCore(); expect(repeated.filter(record => record.entityType === 'observed_fact')).toEqual(facts); expect(repeated.filter(record => record.entityType === 'capture')).toHaveLength(2); expect(savedOriginal()).toEqual(original); expect(f.errors).toEqual([]);
      for (const record of repeated.filter(record => record.entityType === 'capture')) {
        const stored = f.runtime.services.sources.readCapture({ entityType: 'capture', id: record.value.id, revision: 1 }, f.runtime.deps.installationId)!;
        f.runtime.services.sources.assertArtifact(f.runtime.deps.installationId, stored.artifact!);
        const bytes = repository.sqlForModule('sources').get<{ bytes_value: Uint8Array }>('SELECT bytes_value FROM wb_sources_artifacts WHERE installation_id=? AND artifact_id=?', [f.runtime.deps.installationId, stored.artifact!.artifactId])!.bytes_value;
        expect(Buffer.from(bytes)).toEqual(goalReportBytes);
      }
      await writeFile(f.artifact('file-import-proof.json'), JSON.stringify({ browser: f.browser.version(), goalId: input.goal.id, explicitSelection: apply.payload, captureRef: applied.captureRef, acceptedFacts: facts.length, rejectedRows: 1, retainedRawRows: capture.capture.rawRows.length, partialDownloadStatus: 404, originalSha256: createHash('sha256').update(original).digest('hex'), samePreviewRetryCaptureCount: 1, separateUploadCaptureCount: 2, repeatedFactVersions: repeated.filter(record => record.entityType === 'observed_fact').length, commands, realBankRequests: 0 }, null, 2));
    }
    return { ...f, importThroughUI };
  } catch (error) { await f.close(); throw error; }
}
