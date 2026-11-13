import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { openWorkspace } from '../src/workspace.mjs';

const map = Buffer.from(`<script type="application/json" id="portal-data">${JSON.stringify({
  goals: [{ id: 'SW26.1', category: 'Практики', title: 'Модель зрелости', target: '80%', scopeType: 'global', status: 'active' }],
  leaders: { sample: { name: 'Кластер А', teams: ['Команда А'], assignments: [{ goalId: 'SW26.1', allProducts: true }] } }
})}</script>`);

const manual = {
  goalId: 'SW26.1', scopeId: 'dit', period: 'Q4 2026', asOf: '2026-11-03',
  value: 125, status: 'Есть риски', plan: 'Проверить охват', comment: 'После сверки', risk: 'Неполный источник',
  expectedRevision: null
};

async function fixture(t, git) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rm-uor-next-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const workspace = await openWorkspace({ dataDir, git });
  await workspace.importSource('карта.html', map);
  await workspace.execute('profile', { name: 'Тестовый куратор', remote: 'C:/test-shared.git', branch: 'main' });
  return { workspace, dataDir };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const selection = { goalIds: [manual.goalId] };
const shared = (revision, version = 0, goals = []) => ({ revision, version, history: [], goals });

test('saving a status persists locally without sending or changing original bytes', async t => {
  let writes = 0;
  const { workspace, dataDir } = await fixture(t, { publishShared() { writes++; } });
  await workspace.execute('status', manual);
  const restarted = await openWorkspace({ dataDir });
  const state = restarted.getState();
  assert.equal(writes, 0);
  assert.equal(state.goals[0].published.length, 0);
  assert.equal(state.goals[0].local[0].value, 125);
  assert.equal(state.goals[0].local[0].status, 'Есть риски');
  assert.equal(state.goals[0].local[0].asOf, '2026-11-03');
  assert.deepEqual((await restarted.readOriginal(state.sources[0].id)).bytes, map);
});

test('saves manual DIT statuses atomically by period and preserves a clear revision', async t => {
  const { workspace, dataDir } = await fixture(t);
  const goals = [
    { id: 'SW26.1', title: 'Модель зрелости', status: 'active' },
    { id: 'SW26.2', title: 'Плотность дефектов', status: 'active' },
    { id: 'SW26.3', title: 'Мониторинг', status: 'monitor' },
  ];
  const html = '<script type="application/json" id="portal-data">' + JSON.stringify({ goals, leaders: {} }) + '</script>';
  await workspace.importSource('две цели.html', Buffer.from(html));
  const period = 'Q4 2026';
  const batch = changes => workspace.execute('dit-status', { period, changes });
  const first = { goalId: 'SW26.1', status: 'Выполнено', expectedRevision: null };
  const second = { goalId: 'SW26.2', status: 'В плане', expectedRevision: null };
  const saved = await batch([first, second]);
  const [row, other] = saved.ditStatuses;
  assert.deepEqual(saved.ditStatuses.map(entry => [entry.goalId, entry.period, entry.status]), [
    ['SW26.1', period, 'Выполнено'], ['SW26.2', period, 'В плане'],
  ]);
  assert.ok(row.revision);
  assert.ok(saved.goals.every(goal => goal.local.length === 0 && goal.published.length === 0));
  await assert.rejects(batch([{ ...first, expectedRevision: row.revision, status: 'Под риском' }, second]), { code: 'CONFLICT' });
  assert.deepEqual(workspace.getState().ditStatuses, saved.ditStatuses);
  await assert.rejects(batch([{ goalId: 'SW26.3', status: 'В плане', expectedRevision: null }]), { code: 'INVALID' });
  await assert.rejects(batch([{ ...first, expectedRevision: row.revision }, { ...first, expectedRevision: row.revision }]), { code: 'INVALID' });
  await assert.rejects(workspace.execute('dit-status', { period: 'текущий', changes: [first] }), { code: 'INVALID' });
  const clear = await batch([{ ...first, expectedRevision: row.revision, status: '' }]);
  assert.notEqual(clear.ditStatuses[0].revision, row.revision);
  assert.equal(clear.ditStatuses[0].status, '');
  assert.deepEqual(clear.ditStatuses[1], other);
  const savedAgain = await batch([{ ...first, expectedRevision: clear.ditStatuses[0].revision, status: '' }]);
  assert.deepEqual(savedAgain.ditStatuses, clear.ditStatuses);
  await assert.rejects(batch([first]), { code: 'CONFLICT' });
  const yearly = await workspace.execute('dit-status', { period: 'Y26', changes: [first] });
  const reopened = await openWorkspace({ dataDir });
  assert.deepEqual(reopened.getState().ditStatuses, yearly.ditStatuses);
  await reopened.importSource('карта.html', map);
  assert.deepEqual(reopened.getState().ditStatuses, yearly.ditStatuses.filter(entry => entry.goalId === 'SW26.1'));
});

test('publishes exact reviewed DIT changes and a tombstone by period without creating goal results', async t => {
  let current = shared('initial');
  let sends = 0;
  const git = {
    async readShared() { return current; },
    async publishShared(_config, input) {
      sends++;
      assert.equal(input.expectedRevision, current.revision);
      assert.deepEqual(input.goals, []);
      assert.equal(input.ditStatuses.length, 1);
      const item = input.ditStatuses[0];
      assert.equal(item.period, 'Q4 2026');
      assert.deepEqual(Object.keys(item).sort(), ['goalId', 'period', 'revision', 'status']);
      current = { ...shared('publish' + sends, sends), ditStatuses: [item] };
      return current;
    }
  };
  const { workspace } = await fixture(t, git);
  const { workspace: reader } = await fixture(t, git);
  const request = { goalIds: [], ditPeriod: 'Q4 2026' };
  const row = { goalId: 'SW26.1', status: 'Под риском', expectedRevision: null };
  await workspace.execute('refresh');
  await workspace.execute('dit-status', { period: request.ditPeriod, changes: [row] });
  await workspace.execute('dit-status', { period: 'Y26', changes: [{ ...row, status: 'В плане' }] });
  const draft = workspace.getState().ditDrafts[0];
  const preview = await workspace.execute('publishpreview', request);
  assert.deepEqual(preview.goals, []);
  assert.deepEqual(preview.ditChanges.map(({ goalId, period, before, after }) =>
    [goalId, period, before, after.status]), [[row.goalId, request.ditPeriod, null, row.status]]);
  assert.equal(preview.ditChanges[0].after.revision, draft.revision);
  await workspace.execute('dit-status', { period: request.ditPeriod, changes: [{ ...row, status: 'Выполнено', expectedRevision: draft.revision }] });
  await assert.rejects(workspace.execute('publish', { ...request, token: preview.token }), { code: 'CONFLICT' });
  assert.equal(sends, 0);
  const finalPreview = await workspace.execute('publishpreview', request);
  await workspace.execute('publish', { ...request, token: finalPreview.token });
  assert.deepEqual(workspace.getState().ditDrafts.map(({ period }) => period), ['Y26']);
  await reader.execute('refresh');
  assert.equal(reader.getState().ditStatuses[0].status, 'Выполнено');
  assert.equal(reader.getState().ditDrafts.length, 0);

  await workspace.execute('dit-status', { period: request.ditPeriod, changes: [{
    ...row, expectedRevision: reader.getState().ditStatuses[0].revision, status: ''
  }] });
  const tombstone = await workspace.execute('publishpreview', request);
  assert.equal(tombstone.ditChanges[0].before.status, 'Выполнено');
  assert.equal(tombstone.ditChanges[0].after.status, '');
  await workspace.execute('publish', { ...request, token: tombstone.token });
  await reader.execute('refresh');
  assert.equal(reader.getState().ditStatuses[0].status, '');
  assert.equal(reader.getState().ditPublished[0].revision, tombstone.ditChanges[0].after.revision);
  assert.equal(sends, 2);
});

test('binds one-time Git credentials to the reviewed remote and keeps them out of local data', async t => {
  const remote = 'https://git.example.test/team/first.git';
  const nextRemote = 'https://git.example.test/team/other.git';
  const auth = { credentials: { username: 'fixture-user', password: 'fixture-secret' }, credentialRemote: remote };
  let current = shared('initial');
  let reads = 0;
  let sends = 0;
  const git = {
    async readShared(config, options) {
      reads++;
      assert.equal(config.remote, remote);
      assert.deepEqual(options, { credentials: auth.credentials });
      return current;
    },
    async publishShared(config, input) {
      sends++;
      assert.equal(config.remote, remote);
      assert.deepEqual(input.credentials, auth.credentials);
      assert.equal(input.goals.length, 1);
      assert.equal(input.ditStatuses.length, 1);
      current = { ...shared('mixed', 1, input.goals), ditStatuses: input.ditStatuses };
      return current;
    }
  };
  const { workspace, dataDir } = await fixture(t, git);
  await workspace.execute('profile', { remote, gitAuth: 'prompt' });
  await assert.rejects(workspace.execute('refresh'), { code: 'GIT_AUTH_REQUIRED' });
  assert.equal(reads, 0);
  await workspace.execute('refresh', auth);
  await workspace.execute('status', { ...manual, expectedRevision: 'initial' });
  await workspace.execute('dit-status', { period: manual.period, changes: [{
    goalId: manual.goalId, status: 'В плане', expectedRevision: null
  }] });
  const request = { goalIds: [manual.goalId], ditPeriod: manual.period, ...auth };
  const preview = await workspace.execute('publishpreview', request);
  assert.equal(preview.goals.length, 1);
  assert.equal(preview.ditChanges.length, 1);
  assert.doesNotMatch(JSON.stringify(preview), /fixture-(?:user|secret)/u);
  await workspace.execute('publish', { ...request, token: preview.token });
  assert.equal(sends, 1);
  assert.doesNotMatch(await readFile(join(dataDir, 'workspace.json'), 'utf8'), /fixture-(?:user|secret)/u);

  await workspace.execute('profile', { remote: nextRemote });
  await assert.rejects(workspace.execute('refresh', auth), { code: 'CONFLICT' });
  await assert.rejects(workspace.execute('publishpreview', request), { code: 'CONFLICT' });
  await assert.rejects(workspace.execute('publish', { ...request, token: preview.token }), { code: 'CONFLICT' });
  assert.equal(reads, 3);
  assert.equal(sends, 1);
});

test('keeps old local DIT statuses pending and prevents overwriting a newly fetched shared status', async t => {
  const { dataDir } = await fixture(t);
  const statePath = join(dataDir, 'workspace.json');
  const legacy = JSON.parse(await readFile(statePath, 'utf8'));
  const old = {
    goalId: manual.goalId, period: manual.period, status: 'В плане', revision: '11111111-1111-4111-8111-111111111111'
  };
  delete legacy.ditDrafts;
  legacy.ditStatuses = [old];
  await writeFile(statePath, JSON.stringify(legacy));
  const accepted = { ...old, status: 'Выполнено', revision: '22222222-2222-4222-8222-222222222222' };
  const git = { async readShared() { return { ...shared('head'), ditStatuses: [accepted] }; } };
  const workspace = await openWorkspace({ dataDir, git });
  assert.deepEqual(workspace.getState().ditDrafts, [old]);
  assert.deepEqual(workspace.getState().ditPublished, []);
  await workspace.execute('refresh');
  assert.deepEqual(workspace.getState().ditStatuses, [old]);
  const request = { goalIds: [], ditPeriod: manual.period };
  await assert.rejects(workspace.execute('publishpreview', request), { code: 'CONFLICT' });
  await workspace.execute('dit-status', { period: manual.period, changes: [{ ...old, expectedRevision: old.revision }] });
  const reviewed = await workspace.execute('publishpreview', request);
  assert.equal(reviewed.ditChanges[0].before.revision, accepted.revision);
  assert.equal(reviewed.ditChanges[0].after.status, old.status);
});

test('publishing sends selected result fields and preserves a draft on concurrent change', async t => {
  let actual = { revision: 'one', version: 0, history: [], goals: [] };
  let writes = 0;
  const git = {
    async readShared() { return actual; },
    async publishShared(_config, request) {
      writes++;
      assert.equal(request.expectedRevision, actual.revision);
      assert.equal(request.goals.length, 1);
      assert.deepEqual(Object.keys(request.goals[0]).sort(), ['id', 'results', 'title']);
      actual = { revision: 'two', version: 1, history: [], goals: request.goals };
      return actual;
    }
  };
  const { workspace } = await fixture(t, git);
  await workspace.execute('refresh');
  await workspace.execute('status', { ...manual, expectedRevision: 'one' });
  const first = await workspace.execute('publishpreview', selection);
  await workspace.execute('publish', { ...selection, token: first.token });
  assert.equal(workspace.getState().goals[0].published[0].value, 125);
  assert.equal(workspace.getState().goals[0].local.length, 0);
  await workspace.execute('status', { ...manual, value: 80, expectedRevision: 'two' });
  const second = await workspace.execute('publishpreview', selection);
  actual = {
    ...actual, revision: 'three', version: 2,
    goals: [{ ...actual.goals[0], results: [{ ...actual.goals[0].results[0], value: 100 }] }]
  };
  await assert.rejects(workspace.execute('publish', { ...selection, token: second.token }), { code: 'CONFLICT' });
  assert.equal(writes, 1);
  assert.equal(workspace.getState().goals[0].local[0].value, 80);
  assert.equal(workspace.getState().goals[0].published[0].value, 100);
  await assert.rejects(workspace.execute('status', { ...manual, value: 80, expectedRevision: 'two' }), { code: 'CONFLICT' });
});

test('a verified empty repository accepts only the exact local publication preview', async t => {
  let actual = shared(null);
  let reads = 0;
  let writes = 0;
  let nextRead;
  const { workspace } = await fixture(t, {
    async readShared() {
      reads++;
      if (!nextRead) return actual;
      const { started, reply } = nextRead;
      nextRead = undefined;
      started.resolve();
      return reply.promise;
    },
    async publishShared(config, request) {
      writes++;
      assert.equal(config.branch, 'main');
      assert.equal(request.expectedRevision, null);
      actual = shared('first', 1, request.goals);
      return actual;
    }
  });
  await workspace.execute('status', manual);
  await assert.rejects(workspace.execute('publishpreview', selection), { code: 'CONFLICT' });
  await workspace.execute('refresh');
  const preview = await workspace.execute('publishpreview', selection);
  assert.equal(reads, 1);
  assert.deepEqual(Object.keys(preview).sort(), ['author', 'branch', 'goals', 'remote', 'revision', 'token']);
  assert.equal(preview.revision, null);
  assert.equal(preview.remote, 'C:/test-shared.git');
  assert.equal(preview.author, 'Тестовый куратор');
  assert.equal(preview.goals[0].changes[0].before, null);
  assert.equal(preview.goals[0].changes[0].after.value, 125);
  await assert.rejects(workspace.execute('publish', selection), { code: 'CONFLICT' });
  await workspace.execute('status', { ...manual, value: 80 });
  await assert.rejects(workspace.execute('publish', { ...selection, token: preview.token }), { code: 'CONFLICT' });
  assert.equal(writes, 0);
  assert.equal(workspace.getState().goals[0].local[0].value, 80);
  const checked = await workspace.execute('publishpreview', selection);
  const started = deferred();
  const reply = deferred();
  nextRead = { started, reply };
  const send = assert.rejects(workspace.execute('publish', { ...selection, token: checked.token }), { code: 'CONFLICT' });
  await started.promise;
  await workspace.execute('status', { ...manual, value: 75 });
  reply.resolve(actual);
  await send;
  assert.equal(writes, 0);
  const fresh = await workspace.execute('publishpreview', selection);
  await workspace.execute('publish', { ...selection, token: fresh.token });
  assert.equal(writes, 1);
  assert.equal(workspace.getState().goals[0].published[0].value, 75);
});

test('a pending refresh coalesces and does not block local draft writes', async t => {
  const started = deferred();
  const reply = deferred();
  let reads = 0;
  const { workspace, dataDir } = await fixture(t, {
    readShared() { reads++; started.resolve(); return reply.promise; }
  });
  const first = workspace.execute('refresh');
  await started.promise;
  const second = workspace.execute('refresh');
  const save = workspace.execute('status', manual);
  const completed = await Promise.race([save.then(() => true), delay(1000, false)]);
  reply.resolve(shared(null));
  await Promise.all([first, second, save]);
  assert.equal(completed, true);
  assert.equal(reads, 1);
  assert.equal((await openWorkspace({ dataDir })).getState().goals[0].local[0].value, 125);
});

test('a late Git reply for a previous connection leaves the current cache intact', async t => {
  const started = deferred();
  const reply = deferred();
  const { workspace } = await fixture(t, {
    readShared(config) {
      if (config.remote === 'C:/test-shared.git') {
        started.resolve();
        return reply.promise;
      }
      return shared('new');
    }
  });
  const first = workspace.execute('refresh').then(() => null, error => error.code);
  await started.promise;
  const updated = workspace.execute('profile', { remote: 'C:/other-shared.git' });
  const completed = await Promise.race([updated.then(() => true), delay(1000, false)]);
  if (completed) await workspace.execute('refresh');
  reply.resolve(shared('old'));
  const result = await first;
  await updated;
  assert.equal(completed, true);
  assert.equal(result, 'CONFLICT');
  assert.equal(workspace.getState().shared.revision, 'new');
  assert.equal(workspace.getState().shared.error, null);
});

test('missing and rolled-back remote snapshots preserve the last good state and block release', async t => {
  let actual = shared('second', 2);
  let writes = 0;
  const { workspace, dataDir } = await fixture(t, {
    async readShared() { return actual; },
    async publishShared() { writes++; }
  });
  await workspace.execute('refresh');
  await workspace.execute('status', { ...manual, expectedRevision: 'second' });
  const preview = await workspace.execute('publishpreview', selection);
  for (const stale of [shared(null), shared('first', 1), shared('deleted')]) {
    actual = stale;
    await assert.rejects(workspace.execute('refresh'), { code: 'CONFLICT' });
    assert.equal(workspace.getState().shared.revision, 'second');
    assert.equal(workspace.getState().shared.version, 2);
    assert.ok(workspace.getState().shared.error);
    await assert.rejects(workspace.execute('publishpreview', selection), { code: 'CONFLICT' });
    await assert.rejects(workspace.execute('publish', { ...selection, token: preview.token }), { code: 'CONFLICT' });
  }
  assert.equal(writes, 0);
  const restarted = await openWorkspace({ dataDir });
  assert.equal(restarted.getState().shared.version, 2);
  assert.equal(restarted.getState().goals[0].local.length, 1);
});

test('validates dates and scope before saving', async t => {
  const { workspace } = await fixture(t, {});
  await assert.rejects(workspace.execute('status', { ...manual, asOf: '2026-02-31' }), /Дата/);
  await assert.rejects(workspace.execute('status', { ...manual, scopeId: 'unknown' }), /участник/i);
  assert.equal(workspace.getState().goals[0].local.length, 0);
});

test('goal edits persist as an overlay without changing the imported map', async t => {
  const { workspace, dataDir } = await fixture(t, {});
  await workspace.execute('goal', {
    goalId: 'SW26.1', title: 'Гигиенический минимум', target: '80%', description: 'Рабочее описание',
    method: 'Проверка применимых метрик', curators: ['Куратор']
  });
  const revisedMap = Buffer.concat([map, Buffer.from('\n')]);
  await workspace.importSource('карта (2).html', revisedMap);
  const restarted = await openWorkspace({ dataDir });
  const state = restarted.getState();
  assert.equal(state.goals[0].title, 'Гигиенический минимум');
  assert.equal(state.goals[0].method, 'Проверка применимых метрик');
  assert.deepEqual((await restarted.readOriginal(state.sources[0].id)).bytes, map);
});

const anotherMap = Buffer.from(`<script type="application/json" id="portal-data">${JSON.stringify({
  goals: [{ id: 'OTHER', title: 'Цель из другой карты' }], leaders: {}
})}</script>`);

test('a map upload replaces the active goals, including when reactivating an already uploaded original', async t => {
  const { workspace, dataDir } = await fixture(t, {});
  const original = workspace.getState().sources[0];
  await workspace.execute('goal', { goalId: 'SW26.1', title: 'Уточнённая модель зрелости', curators: [] });
  await workspace.execute('status', manual);
  await workspace.importSource('другая карта.html', anotherMap);
  assert.deepEqual(workspace.getState().goals.map(goal => goal.id), ['OTHER']);
  await assert.rejects(workspace.execute('status', manual), { code: 'NOT_FOUND' });

  await workspace.importSource('карта.html', map);
  const restarted = await openWorkspace({ dataDir });
  const result = restarted.getState();
  assert.equal(result.catalogSourceId, original.id);
  assert.deepEqual(result.goals.map(goal => goal.id), ['SW26.1']);
  assert.equal(result.goals[0].title, 'Уточнённая модель зрелости');
  assert.equal(result.goals[0].local[0].value, 125);
  assert.equal(result.sources.length, 2);
  assert.deepEqual((await restarted.readOriginal(original.id)).bytes, map);
});

test('an existing merged catalog uses only the most recent original map and shared results cannot add goals', async t => {
  const { workspace, dataDir } = await fixture(t, {});
  const previous = workspace.getState().goals[0];
  await workspace.importSource('другая карта.html', anotherMap);
  const statePath = join(dataDir, 'workspace.json');
  const legacy = JSON.parse(await readFile(statePath, 'utf8'));
  delete legacy.catalogSourceId;
  if (!legacy.catalog.some(goal => goal.id === previous.id)) legacy.catalog.unshift(previous);
  await writeFile(statePath, JSON.stringify(legacy));

  const restarted = await openWorkspace({ dataDir, git: { async readShared() {
    return { ...shared('remote', 1, [
      { id: 'OUTSIDE', title: 'Посторонняя цель', results: [] },
      { id: 'OTHER', title: 'Старое название', results: [] }
    ]), history: [{ version: 1, author: 'Куратор', publishedAt: '2026-11-03T10:00:00Z', goalIds: ['OUTSIDE', 'OTHER'] }] };
  } } });
  await restarted.execute('refresh');
  const current = restarted.getState();
  assert.deepEqual(current.goals.map(goal => goal.id), ['OTHER']);
  assert.equal(current.goals[0].title, 'Цель из другой карты');
  assert.deepEqual(current.shared.history[0].goalIds, ['OTHER']);
  const stored = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(stored.shared.history[0].goalIds, ['OUTSIDE', 'OTHER']);
  await assert.rejects(restarted.execute('goal', { goalId: 'OUTSIDE', title: 'Изменение', curators: [] }), { code: 'NOT_FOUND' });
});

test('changes the theme independently of the user profile and keeps it after restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rm-uor-theme-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const workspace = await openWorkspace({ dataDir });
  await workspace.execute('theme', { theme: 'dark' });
  assert.equal(workspace.getState().profile.name, '');
  assert.equal((await openWorkspace({ dataDir })).getState().profile.theme, 'dark');
  await assert.rejects(workspace.execute('theme', { theme: 'unknown' }), /тем/u);
  assert.equal(workspace.getState().profile.theme, 'dark');
});

test('stores an ordered visualization with versioned edits and an intentional empty dashboard', async t => {
  const { workspace, dataDir } = await fixture(t, {});
  const initial = workspace.getState().visualization;
  assert.deepEqual(initial, { revision: null, cards: null });
  const card = { id: 'risks', kind: 'bar', group: 'leader', period: 'Q4 2026', title: 'Риски', status: 'есть риски', leader: '' };
  await assert.rejects(workspace.execute('visualization', {
    expectedRevision: null, cards: [{ ...card, period: '' }]
  }), /Период/iu);
  const saved = (await workspace.execute('visualization', { expectedRevision: null, cards: [card] })).visualization;
  assert.deepEqual((await openWorkspace({ dataDir })).getState().visualization, saved);
  await assert.rejects(workspace.execute('visualization', { expectedRevision: null, cards: [] }), { code: 'CONFLICT' });
  const cleared = (await workspace.execute('visualization', { expectedRevision: saved.revision, cards: [] })).visualization;
  assert.deepEqual(cleared.cards, []);
  assert.notEqual(cleared.revision, saved.revision);
});
