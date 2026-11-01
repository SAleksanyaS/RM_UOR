import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const phase = process.argv[2];
assert.ok(phase === 'red' || phase === 'green', 'Usage: regression-flow.ts red|green');
const output = process.env.UOR_REFERENCE_OUTPUT ?? fileURLToPath(new URL('../../.runtime/design-reference/evidence/', import.meta.url));
const prefix = 'daily-regression-' + phase;
const info = JSON.parse(await readFile(path.join(output, 'runtime.json'), 'utf8'));
const executablePath = process.env.UOR_TEST_BROWSER_EXECUTABLE;
if (!executablePath) throw Error('UOR_TEST_BROWSER_EXECUTABLE must identify an installed browser');
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const checks: Array<Record<string, unknown>> = [];
const browserErrors: string[] = [], commands: string[] = [];
const report: Record<string, unknown> = { phase, synthetic: true, origin: info.origin, browser: browser.version(), startedAt: new Date().toISOString(), checks, browserErrors, commands };
page.on('pageerror', error => browserErrors.push(error.message));
page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/commands')) commands.push(request.postDataJSON()?.name); });
const personal = () => page.getByRole('tab', { name: 'Личные выгрузки ОКО', exact: true });
const goals = () => page.getByRole('tab', { name: 'Данные целей', exact: true });
const personalUrl = info.origin + '/data' + info.query + '#personal-oko';

async function state() {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    const opener = document.querySelector<HTMLButtonElement>('button[aria-label="Открыть меню"]');
    return { url: location.href, personalSelected: document.querySelector('#wb-data-personal-tab')?.getAttribute('aria-selected'), goalsSelected: document.querySelector('#wb-data-goals-tab')?.getAttribute('aria-selected'), personalHidden: (document.querySelector('#wb-data-personal') as HTMLElement | null)?.hidden, activeElement: { tag: active?.tagName, id: active?.id, ariaLabel: active?.getAttribute('aria-label'), text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null }, menuFocused: !!opener && active === opener, menuInert: !!opener?.closest('[inert]'), menuVisible: !!opener?.getClientRects().length, workspaceInert: (document.querySelector('.wb-workspace') as HTMLElement | null)?.inert };
  });
}
async function ready() {
  await page.waitForFunction(() => document.querySelector('#wb-main')?.getAttribute('aria-busy') === 'false');
  await page.waitForTimeout(200);
}
async function check(name: string, action: () => Promise<unknown>) {
  try { const details = await action(); checks.push({ name, status: 'passed', details, state: await state() }); }
  catch (error) {
    checks.push({ name, status: 'failed', error: String(error), state: await state() });
    await page.screenshot({ path: path.join(output, prefix + '-' + name + '.png'), fullPage: true });
  }
  console.log(JSON.stringify(checks.at(-1)));
}
async function assertPersonal() {
  await ready();
  assert.equal(new URL(page.url()).hash, '#personal-oko', 'The personal tab fragment must survive route restoration');
  assert.equal(await personal().getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#wb-data-personal').isVisible(), true);
}

try {
  await check('direct-url', async () => { await page.goto(personalUrl); await personal().waitFor(); await assertPersonal(); });
  await check('reload', async () => { await personal().click(); await page.reload(); await personal().waitFor(); await assertPersonal(); });
  await check('back', async () => { await personal().click(); await goals().click(); await page.goBack(); await assertPersonal(); });
  await check('forward', async () => {
    await page.goForward(); await ready();
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await goals().getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#wb-data-personal').isVisible(), false);
  });

  await check('mobile-maintenance-focus', async () => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(info.origin + '/overview' + info.query); await ready();
    const welcome = page.getByRole('button', { name: 'Закрыть приветствие', exact: true });
    if (await welcome.count()) await welcome.click();
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
    const navigation = page.getByRole('dialog', { name: 'Навигация рабочего места', exact: true });
    await navigation.waitFor();
    await navigation.getByRole('button', { name: 'Обслуживание рабочего места', exact: true }).click();
    const maintenance = page.getByRole('dialog', { name: 'Обслуживание рабочего места', exact: true });
    await maintenance.waitFor();
    const openState = await state();
    assert.equal(openState.workspaceInert, true, 'Background must really be inert while maintenance is open');
    await maintenance.getByRole('button', { name: 'Закрыть обслуживание', exact: true }).click();
    await maintenance.waitFor({ state: 'hidden' });
    await page.waitForTimeout(250);
    const closed = await state();
    assert.equal(closed.workspaceInert, false);
    assert.equal(closed.menuVisible, true);
    assert.equal(closed.menuInert, false);
    assert.equal(closed.menuFocused, true, 'Native document.activeElement must return to the visible menu opener');
    return { openState, closedState: closed };
  });

  await check('mobile-current-menu-heading-focus', async () => {
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
    const navigation = page.getByRole('dialog', { name: 'Навигация рабочего места', exact: true });
    await navigation.waitFor();
    await navigation.getByRole('button', { name: 'Обзор', exact: true }).click();
    await navigation.waitFor({ state: 'hidden' });
    await page.waitForTimeout(200);
    const heading = page.getByRole('heading', { name: 'Обзор', level: 1, exact: true });
    assert.equal(await heading.evaluate(element => document.activeElement === element), true, 'Selecting the current destination must focus its heading');
    assert.equal((await state()).workspaceInert, false);
  });

  await check('mobile-maintenance-escape-focus', async () => {
    await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
    const navigation = page.getByRole('dialog', { name: 'Навигация рабочего места', exact: true });
    await navigation.waitFor();
    await navigation.getByRole('button', { name: 'Обслуживание рабочего места', exact: true }).click();
    const maintenance = page.getByRole('dialog', { name: 'Обслуживание рабочего места', exact: true });
    await maintenance.waitFor();
    assert.equal((await state()).workspaceInert, true);
    await page.keyboard.press('Escape');
    await maintenance.waitFor({ state: 'hidden' });
    await page.waitForTimeout(200);
    const closed = await state();
    assert.equal(closed.workspaceInert, false);
    assert.equal(closed.menuInert, false);
    assert.equal(closed.menuFocused, true, 'Escape must return native focus to the visible menu opener');
  });

  await check('mobile-search-320-focus', async () => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByRole('button', { name: 'Открыть поиск', exact: true }).click();
    const input = page.getByRole('searchbox', { name: 'Поиск по рабочему месту', exact: true });
    await input.waitFor({ state: 'visible' });
    assert.equal(await input.evaluate(element => document.activeElement === element), true);
    const rectangle = await input.boundingBox();
    assert.ok(rectangle && rectangle.width > 0 && rectangle.x >= 0 && rectangle.x + rectangle.width <= 320, 'Actual CSS must keep the focused search input inside the 320px viewport');
    await page.keyboard.press('Escape');
    const opener = page.getByRole('button', { name: 'Открыть поиск', exact: true });
    await opener.waitFor({ state: 'visible' });
    assert.equal(await input.isVisible(), false);
    assert.equal(await opener.getAttribute('aria-expanded'), 'false');
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
    assert.equal(await opener.evaluate(element => !!element.closest('[inert]')), false);
    return { viewport: { width: 320, height: 900 }, visibleInputRectangle: rectangle };
  });

  // Bind every run to the current result displayed by this UI and read from the API.
  // No replay or direct data mutation is performed by this regression script.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(personalUrl); await personal().waitFor(); await ready();
  if (await personal().getAttribute('aria-selected') !== 'true') await personal().click();
  const download = page.getByRole('link', { name: 'Скачать исходный файл', exact: true });
  await download.waitFor();
  const resultIdFromUi = /\/results\/([^/]+)\/original$/.exec(await download.getAttribute('href') ?? '')?.[1];
  const session = (await (await context.request.get(info.origin + '/api/v1/session')).json()).data;
  const response = await context.request.post(info.origin + '/api/v1/queries/oko.workflow.workspace', { headers: { origin: info.origin, 'x-csrf-token': session.csrfToken }, data: { context: null, filter: { workflowId: info.personalWorkflowId }, sort: [], page: { limit: 50, cursor: null } } });
  assert.equal(response.status(), 200);
  const current = (await response.json()).data.current;
  assert.equal(resultIdFromUi, current.result.resultId);
  assert.equal(current.result.rowCount, 8); assert.equal(current.result.unresolvedRows, 1);
  assert.equal(commands.includes('oko.workflow.record.test'), false, 'Regression must not run another replay');
  report.currentResult = { workflowId: current.workflowId, resultIdFromUi, resultIdFromApi: current.result.resultId, revision: current.revision, rowCount: current.result.rowCount, unresolvedRows: current.result.unresolvedRows };
  const welcome = page.getByRole('button', { name: 'Закрыть приветствие', exact: true }); if (await welcome.count()) await welcome.click();
  await page.screenshot({ path: path.join(output, prefix + '.png'), fullPage: true });
} catch (error) { report.fatalError = String(error); }
finally {
  report.finishedAt = new Date().toISOString();
  report.passed = checks.filter(check => check.status === 'passed').length;
  report.failed = checks.filter(check => check.status === 'failed').length;
  await writeFile(path.join(output, prefix + '.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ phase, passed: report.passed, failed: report.failed, currentResult: report.currentResult, fatalError: report.fatalError }));
if (report.fatalError || report.failed || browserErrors.length) process.exitCode = 1;
