import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator } from 'playwright';

/** Uses only the explicitly synthetic production runtime prepared by completion-runtime.ts. */
const runtimeFile = process.env.UOR_COMPLETION_RUNTIME_JSON;
const readOnly = process.argv.includes('--read-only');
assert.ok(runtimeFile, 'UOR_COMPLETION_RUNTIME_JSON must identify the synthetic runtime metadata');
const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
assert.equal(runtime.synthetic, true, 'This driver must never run against a user workspace');
const origin = new URL(runtime.origin);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Only a loopback synthetic runtime is allowed');
assert.equal(origin.protocol, 'http:');
assert.ok(runtime.executablePath, 'Runtime metadata must identify the sandboxed native browser');
const output = process.env.UOR_COMPLETION_UI_OUTPUT ?? path.join(runtime.output, 'ui');
await mkdir(output, { recursive: true });

type Check = { name: string; status: 'passed' | 'failed' | 'unavailable'; details?: unknown; error?: string };
const checks: Check[] = [], images: Array<Record<string, unknown>> = [], browserErrors: string[] = [];
const commands: Array<{ name: string; commandId: string }> = [], dialogs: Array<Record<string, unknown>> = [];
const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(), runtimeFile, synthetic: true, readOnly,
  origin: origin.origin, sourceWorktree: runtime.sourceWorktree, codeRoot: runtime.codeRoot,
  sourceRevision: runtime.sourceRevision, syncedAt: runtime.syncedAt, checks, images, browserErrors, commands, dialogs,
};
const browser = await chromium.launch({ executablePath: runtime.executablePath, headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: 'light' });
const page = await context.newPage();
page.setDefaultTimeout(20000);
let dialogAction: 'accept' | 'dismiss' = 'dismiss';
let ownPackageId: string | null = null;
page.on('dialog', async dialog => {
  dialogs.push({ type: dialog.type(), message: dialog.message(), action: dialogAction });
  if (dialogAction === 'accept') await dialog.accept(); else await dialog.dismiss();
});
page.on('pageerror', error => browserErrors.push(error.message));
page.on('request', request => {
  if (request.method() !== 'POST' || !request.url().endsWith('/api/v1/commands')) return;
  const body = request.postDataJSON();
  commands.push({ name: String(body?.name), commandId: String(body?.commandId) });
});
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const url = (route: string) => origin.origin + route + (runtime.query ?? '');
const previewNextAction = 'Подготовить список ответственных и согласовать ближайший контрольный срок.';

async function check(name: string, action: () => Promise<unknown>) {
  try { checks.push({ name, status: 'passed', details: await action() }); }
  catch (error) { checks.push({ name, status: 'failed', error: String(error) }); }
  console.log(JSON.stringify(checks.at(-1)));
}
async function ready() {
  await page.locator('#wb-main[aria-busy="false"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const welcome = page.locator('.wb-welcome button');
  if (await welcome.isVisible()) await welcome.click();
}
async function open(route: string, heading: string) {
  await page.goto(url(route));
  await page.getByRole('heading', { name: heading, exact: true, level: 1 }).waitFor();
  await ready();
}
async function capture(name: string, full = true) {
  if (await page.locator('.wb-goals-table').count()) await page.waitForFunction(() => ![...document.querySelectorAll('.wb-goals-table [role="status"]')].some(element => element.textContent?.includes('Загружаем')));
  await page.evaluate(() => window.scrollTo(0, 0));
  const geometry = await page.evaluate(() => {
    const tiny: Array<{ text: string; size: number }> = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent?.trim();
      const element = walker.currentNode.parentElement;
      if (!text || !element || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || element.closest('[inert]') || ['SCRIPT', 'STYLE'].includes(element.tagName)) continue;
      const size = parseFloat(getComputedStyle(element).fontSize);
      if (size > 0 && size < 11.9) tiny.push({ text: text.slice(0, 100), size });
    }
    const tables = [...document.querySelectorAll<HTMLElement>('.wb-table-scroll')].filter(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !element.closest('[inert]')).map(element => ({ label: element.getAttribute('aria-label'), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    const content = document.querySelector<HTMLElement>('.wb-shell');
    const active = document.activeElement as HTMLElement | null;
    return {
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, devicePixelRatio,
      theme: content?.getAttribute('data-theme'), systemDark: matchMedia('(prefers-color-scheme: dark)').matches,
      background: content ? getComputedStyle(content).backgroundColor : null,
      foreground: content ? getComputedStyle(content).color : null,
      tiny, tables, focus: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 120),
    };
  });
  const file = name + '.png';
  await page.screenshot({ path: path.join(output, file), fullPage: false });
  if (full) await page.screenshot({ path: path.join(output, name + '-full.png'), fullPage: true });
  images.push({ file, fullFile: full ? name + '-full.png' : null, url: page.url(), ...geometry });
  assert.ok(geometry.scrollWidth <= geometry.width + 1, name + ': document has horizontal overflow');
  assert.equal(geometry.tiny.length, 0, name + ': visible text is below 12px: ' + JSON.stringify(geometry.tiny));
  return geometry;
}
async function changeTheme(theme: 'light' | 'dark' | 'system') {
  await open('/overview', 'Обзор');
  const disclosure = page.locator('.wb-dashboard-disclosure');
  if (!await disclosure.evaluate(element => (element as HTMLDetailsElement).open)) await disclosure.locator('summary').click();
  const control = page.getByRole('combobox', { name: 'Тема', exact: true });
  await control.waitFor();
  const previous = await control.inputValue();
  if (previous !== theme) {
    await control.selectOption(theme);
    await page.getByRole('button', { name: 'Сохранить личный вид', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Личный вид сохранён' }).waitFor();
  }
  await page.locator(`.wb-shell[data-theme="${theme}"]`).waitFor();
  return previous;
}
async function workEditor(): Promise<Locator> {
  const opener = page.getByRole('button', { name: /^Изменить работу:/ }).first();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: /^Работа:/ });
  await dialog.waitFor();
  const input = dialog.getByRole('textbox', { name: 'Название работы', exact: true });
  await page.waitForFunction(() => !!document.querySelector('.wb-execution-dialog input') || [...document.querySelectorAll<HTMLButtonElement>('.wb-execution-dialog button')].some(button => button.textContent === 'Повторить открытие черновика' && !button.disabled));
  if (!await input.isVisible()) {
    const packages = dialog.getByRole('combobox', { name: 'Пакет изменений', exact: true });
    const values = await packages.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
    const preferred = ownPackageId;
    await packages.selectOption(preferred && values.includes(preferred) ? preferred : values.find(value => value && value !== 'new') ?? 'new');
    await dialog.getByRole('button', { name: 'Повторить открытие черновика', exact: true }).click();
  }
  await input.waitFor();
  return opener;
}
async function dirtyEditor(prefix: string) {
  const opener = await workEditor();
  const dialog = page.getByRole('dialog', { name: /^Работа:/ });
  const input = dialog.getByRole('textbox', { name: 'Название работы', exact: true });
  const original = await input.inputValue();
  const changed = original + ' · несохранённая правка';
  await input.fill(changed);
  dialogAction = 'dismiss';
  const prior = dialogs.length;
  await dialog.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
  assert.equal(dialogs.length, prior + 1, 'The native discard confirmation must be shown');
  assert.equal(await input.inputValue(), changed, 'Refusing to leave must preserve the actual input');
  try {
    await capture(prefix + '-editor-dirty', false);
    await dialog.evaluate(element => element.scrollTo(0, element.scrollHeight));
    await page.screenshot({ path: path.join(output, prefix + '-editor-bottom.png') });
  } finally {
    dialogAction = 'accept';
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    dialogAction = 'dismiss';
    assert.equal(await opener.evaluate(element => document.activeElement === element), true, 'Editor returns focus to its real opener');
  }
  return { retainedInput: true, discardedOnEscape: true, returnedFocus: true };
}
async function preparePreviewChange() {
  await open('/execution', 'Работы и решения');
  await workEditor();
  const dialog = page.getByRole('dialog', { name: /^Работа:/ });
  const nextAction = dialog.getByRole('textbox', { name: 'Следующий шаг', exact: true });
  const before = await nextAction.inputValue();
  const proposed = previewNextAction;
  if (before !== proposed) {
    await nextAction.fill(proposed);
    await dialog.getByRole('button', { name: 'Сохранить поля работы', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Черновик сохранён' }).waitFor();
    assert.equal(await nextAction.inputValue(), proposed);
  }
  const prior = dialogs.length;
  await dialog.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(dialogs.length, prior, 'Verified save must clear the dirty guard');
  await open('/uor', 'Панель УОР');
  await page.getByRole('heading', { name: 'Накопленный пакет', exact: true }).waitFor();
  ownPackageId = await page.getByRole('combobox', { name: 'Собственные пакеты', exact: true }).inputValue();
  assert.ok(ownPackageId);
  return { packageId: ownPackageId, field: 'nextAction', before, proposed, synthetic: true, savedThroughProductionUi: before !== proposed };
}
async function previewPackage() {
  const selector = page.getByRole('combobox', { name: 'Собственные пакеты', exact: true });
  await selector.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('select[aria-label="Собственные пакеты"] option').length > 1);
  const preferred = ownPackageId;
  if (preferred && await selector.locator(`option[value="${preferred}"]`).count()) await selector.selectOption(preferred);
  await page.getByRole('heading', { name: 'Накопленный пакет', exact: true }).waitFor();
  const commandResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/commands') && response.request().postDataJSON()?.name === 'package.preview');
  await page.getByRole('button', { name: 'Проверить пакет', exact: true }).click();
  const response = await commandResponse;
  assert.equal(response.status(), 202);
  const command = await response.json();
  const jobId = command.data.jobId;
  assert.ok(jobId, 'The real preview command must return a persisted job');
  const deadline = Date.now() + 45000;
  let job: Record<string, any> | null = null;
  while (Date.now() < deadline) {
    const current = await context.request.get(origin.origin + '/api/v1/jobs/' + jobId);
    assert.equal(current.status(), 200);
    job = (await current.json()).data;
    if (job && !['queued', 'running'].includes(job.status)) break;
    await delay(150);
  }
  assert.ok(job && !['queued', 'running'].includes(job.status), 'Preview job did not finish within its bounded wait');
  if (job.status === 'succeeded') {
    await page.locator('.wb-package-preview').waitFor();
    assert.deepEqual(job.result?.errors, [], 'The real saved work change must produce an admissible preview');
    assert.ok(job.result?.changes?.some((change: { field: string; proposed: unknown }) => change.field === 'nextAction' && change.proposed === previewNextAction), 'Preview must contain the actual saved change, not an empty comparison');
    return { packageId: await selector.inputValue(), jobId, status: job.status, changes: job.result?.changes?.length, errors: job.result?.errors };
  }
  await page.getByRole('alert').filter({ hasText: job.error?.code ?? 'Операция' }).first().waitFor();
  return { packageId: await selector.inputValue(), jobId, status: job.status, error: job.error, unavailable: true };
}
async function maintenance(prefix: string) {
  const menu = page.getByRole('button', { name: 'Открыть меню', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Обслуживание рабочего места', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Обслуживание рабочего места', exact: true });
  await dialog.waitFor();
  try {
    await capture(prefix + '-maintenance', false);
    await page.locator('.wb-maintenance-backdrop').evaluate(element => element.scrollTo(0, element.scrollHeight));
    await page.screenshot({ path: path.join(output, prefix + '-maintenance-bottom.png') });
  } finally {
    await page.getByRole('button', { name: 'Закрыть обслуживание', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  assert.equal(commands.some(command => /backup\.(create|restore)|publication\.(apply|check)/.test(command.name)), false, 'Visual QA must not invoke maintenance mutations');
}
async function sharedData(prefix: string, includeSource = true) {
  await open('/goals/' + runtime.fixture.goalIds[0], 'Цели');
  await page.locator('.wb-goal-measure .wb-basis-fact').first().waitFor();
  const dataLink = page.getByRole('link', { name: 'Открыть источник и данные', exact: true }).first();
  if (readOnly) await page.goto(new URL((await dataLink.getAttribute('href'))!, origin).href);
  else await dataLink.click();
  await page.getByRole('heading', { name: 'Данные', exact: true, level: 1 }).waitFor();
  await ready();
  await page.getByRole('region', { name: 'Происхождение данных', exact: true }).getByRole('heading', { name: 'Факты', exact: true }).waitFor();
  await page.getByRole('button', { name: /^Открыть набор от / }).first().click();
  await page.getByRole('button', { name: 'Исходные строки', exact: true }).click();
  await page.getByRole('region', { name: 'Исходные строки', exact: true }).locator('tbody tr').first().waitFor();
  const raw = await capture(prefix + '-data-raw-lineage');
  await page.getByRole('button', { name: 'Обогащённые строки', exact: true }).click();
  await page.getByRole('region', { name: 'Обогащённые строки', exact: true }).locator('tbody tr').first().waitFor();
  await capture(prefix + '-data-enriched');
  if (!includeSource) return { raw, sourceOpened: false };
  const opener = page.getByRole('button', { name: 'Настроить источник', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Настройка источника', exact: true });
  await dialog.waitFor();
  const packages = dialog.getByRole('combobox', { name: 'Пакет УОР', exact: true });
  if (await packages.isVisible() && ownPackageId) await packages.selectOption(ownPackageId);
  const sheet = dialog.getByRole('textbox', { name: 'Лист XLSX', exact: true });
  await sheet.waitFor();
  await sheet.fill('Несохранённый лист');
  dialogAction = 'dismiss';
  const prior = dialogs.length;
  await dialog.getByRole('button', { name: 'Закрыть настройку', exact: true }).click();
  assert.equal(dialogs.length, prior + 1);
  assert.equal(await sheet.inputValue(), 'Несохранённый лист');
  try {
    await capture(prefix + '-source-dirty', false);
    await dialog.evaluate(element => element.scrollTo(0, element.scrollHeight));
    await page.screenshot({ path: path.join(output, prefix + '-source-bottom.png') });
  } finally {
    dialogAction = 'accept';
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    dialogAction = 'dismiss';
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
  }
  return { raw, sourceInputPreservedOnRefusal: true, returnedFocus: true };
}
async function mainReferenceScreens() {
  await page.setViewportSize({ width: 1366, height: 768 });
  await open('/overview', 'Обзор');
  await page.waitForFunction(() => ![...document.querySelectorAll('#wb-main [role="status"]')].some(element => element.textContent?.includes('Загружаем')));
  await capture('light-1366x768-overview');
  await open('/goals/' + runtime.fixture.goalIds[0], 'Цели');
  const measure = page.locator('.wb-goal-measure').first();
  await measure.locator('.wb-basis-fact').first().waitFor();
  const text = await measure.innerText();
  assert.ok(text.includes('87%'));
  assert.ok(text.includes('≥ 95%'));
  await capture('light-1366x768-goal87');
  return { text };
}

let originalTheme: string | null = null;
try {
  evidence.browser = browser.version();
  const session = (await (await context.request.get(origin.origin + '/api/v1/session')).json()).data;
  assert.equal(session.policyState, 'local_preview');
  if (readOnly) {
    for (const viewport of [{ width: 1366, height: 768 }, { width: 320, height: 900 }]) {
      await page.setViewportSize(viewport);
      const prefix = `readonly-${viewport.width}x${viewport.height}`;
      await check(prefix + ' goals', async () => { await open('/goals', 'Цели'); await page.locator('.wb-goals-table tbody tr').first().waitFor(); return capture(prefix + '-goals'); });
      await check(prefix + ' common data', () => sharedData(prefix, false));
    }
  } else {
    assert.equal(session.role, 'curator', 'Wait for the shared OKO flow to finish and leave the curator role');
    originalTheme = await changeTheme('light');
    await check('Final overview and ordinary goal reference', mainReferenceScreens);
    await check('Save one real synthetic draft change for package preview', preparePreviewChange);
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 1000 }, { width: 1024, height: 900 }, { width: 768, height: 900 }, { width: 360, height: 900 }, { width: 320, height: 900 }]) {
      await page.setViewportSize(viewport);
      const prefix = `light-${viewport.width}x${viewport.height}`;
      await check(prefix + ' goals', async () => { await open('/goals', 'Цели'); await page.locator('.wb-goals-table tbody tr').first().waitFor(); return capture(prefix + '-goals'); });
      await check(prefix + ' execution', async () => { await open('/execution', 'Работы и решения'); await page.getByRole('button', { name: /^Изменить работу:/ }).first().waitFor(); return capture(prefix + '-execution'); });
      if ([1366, 360, 320].includes(viewport.width)) await check(prefix + ' dirty editor', () => dirtyEditor(prefix));
      await check(prefix + ' uor preview', async () => { await open('/uor', 'Панель УОР'); const preview = await previewPackage(); const geometry = await capture(prefix + '-uor'); if (preview.unavailable) checks.push({ name: prefix + ' successful preview', status: 'unavailable', details: preview }); return { preview, geometry }; });
      if ([1366, 360, 320].includes(viewport.width)) await check(prefix + ' maintenance', () => maintenance(prefix));
      if ([1366, 320].includes(viewport.width)) await check(prefix + ' common data and source', () => sharedData(prefix));
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const goalCase of [
    { index: 4, name: 'range', expected: ['15 дней', '10–20 дней'] },
    { index: 5, name: 'fraction', expected: ['7 из 10', '≥ 8 из 10'] },
    { index: 6, name: 'measured-zero', expected: ['0 инцидентов', '≤ 5 инцидентов'] },
    { index: 2, name: 'missing-value', expected: ['Нет данных', '≥ 98%'] },
    { index: 7, name: 'not-applicable', expected: ['Не применимо'] },
  ]) await check('Exact goal card: ' + goalCase.name, async () => {
    const goalId = runtime.fixture.goalIds[goalCase.index];
    assert.ok(goalId, 'The shared fixture must include numeric edge cases');
    await open('/goals/' + goalId, 'Цели');
    const measure = page.locator('.wb-goal-measure').first();
    await measure.locator('.wb-basis-fact').first().waitFor();
    const text = await measure.innerText();
    for (const expected of goalCase.expected) assert.ok(text.includes(expected), goalCase.name + ': missing ' + expected + ' in ' + text);
    if (goalCase.name === 'measured-zero') assert.equal(text.includes('Нет данных'), false);
    if (goalCase.name === 'not-applicable') assert.equal(text.includes('Факт:'), false);
    return { text, geometry: await capture((readOnly ? 'readonly' : 'light') + '-1440x1000-goal-' + goalCase.name) };
  });
  if (!readOnly) {
  await page.setViewportSize({ width: 1366, height: 768 });
  await check('Saved dark theme', async () => { await changeTheme('dark'); await open('/execution', 'Работы и решения'); return capture('dark-1366x768-execution'); });
  await check('Dark editor', () => dirtyEditor('dark-1366x768'));
  await check('Dark UOR', async () => { await open('/uor', 'Панель УОР'); const preview = await previewPackage(); return { preview, geometry: await capture('dark-1366x768-uor') }; });
  await check('Dark maintenance', () => maintenance('dark-1366x768'));
  await check('Dark common data and source', () => sharedData('dark-1366x768'));
  await check('System theme follows actual media preference', async () => {
    await changeTheme('system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 320, height: 900 });
    await open('/goals', 'Цели');
    const dark = await capture('system-dark-320x900-goals');
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await capture('system-light-320x900-goals');
    assert.notEqual(dark.background, light.background, 'System preference must change the actual cascade');
    return { dark: dark.background, light: light.background };
  });
  await check('200 percent scale equivalent at laptop resolution', async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 683, height: 384, deviceScaleFactor: 2, mobile: false });
    try {
      await open('/goals', 'Цели');
      const geometry = await capture('scale2-1366x768-goals');
      return { method: '683 × 384 CSS px, DPR 2; equivalent reflow and physical scale, not a native browser shortcut zoom', geometry };
    } finally { await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.detach(); }
  });
  await check('Only declared local operations were invoked', async () => {
    const allowed = new Set(['preferences.set', 'draft.open', 'work.draft.save', 'package.preview']);
    assert.deepEqual(commands.filter(command => !allowed.has(command.name)), []);
    assert.deepEqual(browserErrors, []);
    return { commands: [...new Set(commands.map(command => command.name))], browserErrors: 0 };
  });
  } else await check('Read-only flow invoked no commands', async () => { assert.deepEqual(commands, []); assert.deepEqual(browserErrors, []); });
} catch (error) {
  checks.push({ name: 'Driver prerequisites', status: 'failed', error: String(error) });
} finally {
  if (originalTheme && ['light', 'dark', 'system'].includes(originalTheme)) {
    await check('Restore original personal theme', async () => { dialogAction = 'accept'; await page.keyboard.press('Escape'); await changeTheme(originalTheme as 'light' | 'dark' | 'system'); });
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.failed = checks.filter(check => check.status === 'failed').length;
  evidence.unavailable = checks.filter(check => check.status === 'unavailable').length;
  await writeFile(path.join(output, readOnly ? 'ui-flow-readonly.json' : 'ui-flow.json'), JSON.stringify(evidence, null, 2));
  await context.close();
  await browser.close();
}
console.log(JSON.stringify({ output, images: images.length, failed: evidence.failed, unavailable: evidence.unavailable }));
if (evidence.failed) process.exitCode = 1;
