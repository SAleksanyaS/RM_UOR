import { afterEach, expect, it } from 'vitest';
import { createBrowserIntegrationHarness } from './fixtures/workbench/browser-integration';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

it('T46_review_native_profile_filter_retest_and_completed_recording_new_url_recovery', async () => {
  const f = await createBrowserIntegrationHarness(); closes.push(f.close);
  const { page } = await f.curator.openUi();
  const record = async (login = false) => {
    let launched = f.native.launchCount();
    await page.getByRole('button', { name: 'Выбрать признак открытого отчёта', exact: true }).click();
    await f.native.waitForLaunch(launched);
    if (login) await f.native.login();
    await f.native.page().locator('[data-testid="report-ready"]').click();
    await page.getByText('Признак отчёта: report-ready', { exact: true }).waitFor();
    launched = f.native.launchCount();
    await page.getByRole('button', { name: 'Открыть СберБраузер и записать действия', exact: true }).click();
    await f.native.waitForLaunch(launched);
    await f.native.page().getByLabel('Период', { exact: true }).fill('2026-09');
    await f.native.page().getByLabel('Период', { exact: true }).press('Tab');
    await f.native.page().getByLabel('Период', { exact: true }).fill('2026-10');
    await f.native.page().getByLabel('Период', { exact: true }).press('Tab');
    await f.native.page().getByLabel('Состав', { exact: true }).selectOption('all');
    await f.native.page().getByRole('button', { name: 'Выгрузить CSV' }).click({ noWaitAfter: true });
    await f.report.waitForEvent('export-requested'); f.report.release('download');
    await page.getByLabel('Значение фильтра «Период»', { exact: true }).fill('2026-10');
    await page.getByLabel('Значение фильтра «Состав»', { exact: true }).fill('all');
    await page.getByLabel('Обязательные столбцы', { exact: true }).fill('Key,Product,Leader,Amount,Date');
  };
  const testAndSave = async (complete: boolean) => {
    await page.getByRole('button', { name: 'Проверить сценарий', exact: true }).click();
    await f.report.waitForEvent('export-requested'); f.report.release('download');
    // The save button becomes enabled only when the current definition's job finishes.
    await page.getByRole('button', { name: 'Сохранить сценарий в черновик', exact: true }).click();
    await page.getByText(complete ? 'Сценарий сохранён в собственном черновике.' : 'Черновик сохранён с замечаниями. Проверьте пакет УОР.', { exact: true }).waitFor();
    await page.getByText('Принято для предпросмотра: 2000; отклонено: 0.', { exact: true }).waitFor();
  };
  await record(true); await testAndSave(true);
  const before = f.curator.draftStore.listOwnPackages(f.curator.owner.installationId, f.curator.owner.profilePersonId!);
  const profile = await f.curator.query('source.browser.own', { sourceRef: f.curator.sourceRef() });
  await f.curator.send('source.browser.profile.set', { sourceId: profile.sourceId, profileId: profile.profileId, profile: { ...profile.profile, timeoutMs: 11000 }, expectedRevision: profile.revision });
  await page.getByLabel('Значение фильтра «Период»', { exact: true }).fill('2026-11');
  await testAndSave(false); // The fixed metadata fixture certifies October only.
  await page.getByLabel('Значение фильтра «Период»', { exact: true }).fill('2026-10');
  await testAndSave(true);

  const nextUrl = f.report.origin + '/report?view=corrected';
  await page.getByLabel('Адрес отчёта', { exact: true }).fill(nextUrl);
  expect(await page.getByRole('button', { name: 'Отменить запись', exact: true }).count()).toBe(0);
  await record(); await testAndSave(false); // New URL is outside the frozen provider's certified binding.
  expect(await page.getByLabel('Адрес отчёта', { exact: true }).inputValue()).toBe(nextUrl);
  const after = f.curator.draftStore.listOwnPackages(f.curator.owner.installationId, f.curator.owner.profilePersonId!);
  expect(after.map(value => value.packageId)).toEqual(before.map(value => value.packageId));
  const scenario = after[0].entries.find(value => value.entityRef.entityType === 'browser_scenario')!;
  expect(scenario.definition).toMatchObject({ startUrl: nextUrl });
  expect(scenario.complete).toBe(false);
  expect(f.acceptedCaptures()).toHaveLength(0); expect(f.count('attestation')).toBe(0); expect(f.externalWriteCalls()).toBe(0);
}, 120000);
