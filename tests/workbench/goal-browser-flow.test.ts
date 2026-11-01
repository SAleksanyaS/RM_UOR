import { afterEach, expect, it } from 'vitest';
import { createFileImportBrowserRun, createGoalBrowserRun } from './helpers/goal-browser';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

it('new_goal_five_steps_private_mapping_native_record_test_and_exact_package_preview', async () => {
  const f = await createGoalBrowserRun(); closes.push(f.close);
  try {
    await f.createGoalThroughUI();
    const result = await f.recordTestAndSaveThroughUI();
    expect(result.acceptedPreviewRows).toBe(3);
    expect(result.rejectedPreviewRows).toBe(1);
    expect(result.complete).toBe(false);
    await f.previewPackageThroughUI();
  } catch (error) { await f.page.screenshot({ path: f.artifact('new-goal-failure.png'), fullPage: true }); throw Error(String(error) + '\n' + await f.page.locator('body').innerText()); }
}, 180000);

it('file_import_ui_selects_three_valid_rows_rejects_one_and_same_batch_has_no_duplicates', async () => {
  const f = await createFileImportBrowserRun(); closes.push(f.close);
  try { await f.importThroughUI(); }
  catch (error) { await f.page.screenshot({ path: f.artifact('file-import-failure.png'), fullPage: true }); throw Error(String(error) + '\n' + await f.page.locator('body').innerText()); }
}, 120000);
