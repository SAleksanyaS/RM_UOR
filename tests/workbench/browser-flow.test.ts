import { afterEach, expect, it } from 'vitest';
import { createLocalBrowserRun } from './helpers/browser';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
it('ui_keyboard_mobile_empty_personal_path_and_real_chrome', async () => {
  const f = await createLocalBrowserRun(); closes.push(f.close);
  await f.page.goto(f.origin + '/data');
  await f.page.getByRole('button', { name: 'Создать первый сценарий' }).waitFor();
  for (const width of [320, 360, 1024]) {
    await f.page.setViewportSize({ width, height: 900 });
    expect(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await f.page.screenshot({ path: f.artifact('empty-data-' + width + '.png'), fullPage: true });
  }
  await f.page.getByRole('button', { name: 'Создать первый сценарий' }).focus();
  await f.page.keyboard.press('Enter');
  await f.page.getByRole('heading', { name: 'Новый отчёт ОКО' }).waitFor();
  expect((await f.request.session()).defaultContext).toBeNull();
  await f.page.getByLabel('Режим работы', { exact: true }).selectOption('viewer');
  await expect.poll(async () => (await f.request.session()).role).toBe('viewer');
  expect(await f.page.getByRole('button', { name: 'Новый сценарий' }).isEnabled()).toBe(true);
  const reader = await f.request.session();
  expect(reader.allowedCommands).toContain('oko.workflow.open');
  expect(reader.allowedCommands).not.toContain('source.browser.workflow.open');
  expect(reader.allowedCommands).not.toContain('package.submit');
  await f.page.getByLabel('Режим работы', { exact: true }).selectOption('curator');
  await f.page.getByRole('button', { name: 'Новый сценарий' }).waitFor();
  await f.page.goto(f.origin + '/oko.html');
  await f.page.waitForURL('**/data');
  await f.page.getByRole('heading', { name: 'Новый отчёт ОКО' }).waitFor();
}, 120000);
