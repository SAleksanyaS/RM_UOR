import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { validateBrowserConfig } from '../src/browser-connector.mjs';
import { openBrowserWorkspace } from '../src/browser-workspace.mjs';

const firstWeek = '2026-10-12';
const secondWeek = '2026-10-19';
const config = { name: 'Отчёт', url: 'https://track.example.test/weekly', reportSelector: 'main' };

function page(range, achievements) {
  return { title: 'Отчёт', text: [range, 'Топ-3 достижения', ...achievements.map(value => `• ${value}`),
    'Топ-3 требует внимания', '• Проверить доступы', 'Топ-3 плана', '• Провести сверку',
    'Топ-3 инсайта', '• Согласовать единый формат'].join('\n') };
}

async function readReport(workspace, id) {
  const job = (await workspace.execute('read', { id })).jobs.at(-1);
  for (let attempt = 0; attempt < 100; attempt++) {
    const latest = workspace.getState().jobs.find(item => item.id === job.id);
    if (latest.state !== 'running') {
      assert.equal(latest.state, 'success', latest.message);
      return;
    }
    await delay(10);
  }
  assert.fail('Report read did not finish');
}

test('curator weeks survive later reads and a restart, with an empty card for a missing week', async t => {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'rm-uor-curator-weeks-'));
  t.after(async () => {
    const actual = await realpath(root);
    assert.equal(dirname(actual), parent);
    assert.ok(basename(actual).startsWith('rm-uor-curator-weeks-'));
    await rm(actual, { recursive: true, force: true });
  });
  let report;
  const args = { privateRoot: join(root, 'browser'), validateConfig: validateBrowserConfig,
    runtime: { isOpen: () => false, read: async () => report } };
  const workspace = await openBrowserWorkspace(args);
  const [anna] = (await workspace.execute('save', { ...config, curator: 'Анна' })).connectors;
  const [, boris] = (await workspace.execute('save', { ...config, curator: 'Борис', url: `${config.url}/b` })).connectors;

  report = page('10.10.2026 - 17.10.2026', ['Закрыли релиз', 'Проверили метрики', 'Обновили отчёт', 'Четвёртый пункт']);
  await readReport(workspace, anna.id);
  report = page('10.10.2026 - 17.10.2026', ['закрыли релиз', 'Завершили аудит']);
  await readReport(workspace, boris.id);
  report = page('17.10.2026 - 24.10.2026', ['Подготовили следующий отчёт']);
  await readReport(workspace, anna.id);
  report = { title: 'Отчёт', text: 'Страница без даты и структуры' };
  await readReport(workspace, anna.id);
  await workspace.shutdown();

  const restarted = await openBrowserWorkspace(args);
  t.after(() => restarted.shutdown());
  const archived = restarted.getCuratorWeek(firstWeek);
  assert.deepEqual(archived.weeks, [secondWeek, firstWeek]);
  assert.deepEqual(archived.curators[0].range, { start: '2026-10-10', end: '2026-10-17' });
  assert.deepEqual(archived.curators[0].sections.achievements, ['Закрыли релиз', 'Проверили метрики', 'Обновили отчёт']);
  assert.deepEqual(archived.curators[0].sections.plans, ['Провести сверку']);
  assert.deepEqual(archived.curators[0].sections.insights, ['Согласовать единый формат']);
  assert.deepEqual(archived.summary.achievements, [
    { text: 'Закрыли релиз', curator: 'Анна' }, { text: 'Проверили метрики', curator: 'Анна' },
    { text: 'Завершили аудит', curator: 'Борис' }
  ]);
  const recent = restarted.getCuratorWeek(secondWeek);
  assert.deepEqual(recent.curators[0].sections.achievements, ['Подготовили следующий отчёт']);
  assert.equal(recent.curators[1].sections, null);
  assert.deepEqual(restarted.getCuratorWeek('2026-10-26').summary.achievements, []);
  assert.throws(() => restarted.getCuratorWeek('2026-10-18'), { status: 400 });

  await restarted.execute('save', { ...config, id: anna.id, expectedRevision: anna.revision, curator: 'Вера' });
  assert.equal(restarted.getCuratorWeek(firstWeek).curators.find(card => card.name === 'Вера').sections, null);
});
