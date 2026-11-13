import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { validateBrowserConfig } from '../src/browser-connector.mjs';
import { openBrowserWorkspace } from '../src/browser-workspace.mjs';

const config = {
  name: 'Рабочий отчёт', url: 'https://reports.example.test/current',
  allowedOrigins: ['https://sso.example.test'], actions: [{ type: 'wait', selector: '#result' }],
  downloadSelector: '#download', readySelector: '#result', reportSelector: '#result-text'
};

function fakeRuntime(overrides = {}) {
  const open = new Set();
  return {
    async login({ id }) { open.add(id); },
    async close(id) { open.delete(id); },
    isOpen(id) { return open.has(id); },
    async collect() { return { filename: 'report.xlsx', bytes: Buffer.from('workbook') }; },
    async read() { return { title: 'Сводка', text: 'Готово 24 из 28' }; },
    ...overrides
  };
}

async function fixture(t, options = {}) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'rm-uor-browser-ws-'));
  t.after(async () => {
    const actual = await realpath(root);
    assert.equal(dirname(actual), parent);
    assert.ok(basename(actual).startsWith('rm-uor-browser-ws-'));
    await rm(actual, { recursive: true, force: true });
  });
  const args = {
    privateRoot: join(root, 'browser'), runtime: fakeRuntime(), validateConfig: validateBrowserConfig,
    importSource: async (fileName, bytes) => ({ sources: [{ name: fileName, id: createHash('sha256').update(bytes).digest('hex') }] }),
    ...options
  };
  const workspace = await openBrowserWorkspace(args);
  t.after(() => workspace.shutdown());
  return { workspace, args, root };
}

async function finished(workspace, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = workspace.getState().jobs.find(item => item.id === id);
    if (job && job.state !== 'running') return job;
    await delay(10);
  }
  assert.fail('Job did not finish');
}

test('persists only validated private connector settings and checks the reviewed revision', async t => {
  const { workspace, args, root } = await fixture(t);
  const first = (await workspace.execute('save', config)).connectors[0];
  assert.equal(first.revision, 1);
  assert.equal(first.curator, '');
  assert.deepEqual(first.allowedOrigins, ['https://reports.example.test', 'https://sso.example.test']);
  await assert.rejects(workspace.execute('save', { ...config, id: first.id, expectedRevision: 0 }), { code: 'CONFLICT' });
  await assert.rejects(workspace.execute('save', { ...config, password: 'secret' }), { code: 'INVALID_BROWSER_CONFIG' });
  await assert.rejects(workspace.execute('save', { ...config, url: 'https://reports.example.test/?token=secret' }), { code: 'INVALID_BROWSER_CONFIG' });
  const revised = await workspace.execute('save', { ...config, id: first.id, expectedRevision: 1, name: 'Отчёт 2' });
  assert.equal(revised.connectors[0].revision, 2);
  const restarted = await openBrowserWorkspace(args);
  assert.equal(restarted.getState().connectors[0].name, 'Отчёт 2');
  assert.equal(restarted.getState().connectors[0].revision, 2);
  await assert.rejects(readFile(join(root, 'workspace.json')), { code: 'ENOENT' });
  await restarted.shutdown();
});

test('curator names are optional and unique after case and space normalization', async t => {
  const { workspace, args } = await fixture(t);
  const first = (await workspace.execute('save', { ...config, curator: '  Анна   Петрова  ' })).connectors[0];
  assert.equal(first.curator, 'Анна Петрова');
  await assert.rejects(workspace.execute('save', { ...config, curator: 'анна\u00a0петрова' }), { code: 'CONFLICT' });
  await assert.rejects(workspace.execute('save', { ...config, curator: 'а'.repeat(121) }), { code: 'INVALID_BROWSER_CONFIG' });
  const revised = (await workspace.execute('save', { ...config, id: first.id, expectedRevision: 1 })).connectors[0];
  assert.equal(revised.curator, 'Анна Петрова');
  const reopened = await openBrowserWorkspace(args);
  assert.equal(reopened.getState().connectors[0].curator, 'Анна Петрова');
  await reopened.shutdown();
  await workspace.execute('save', { ...config, id: first.id, expectedRevision: 2, curator: '' });
  const reassigned = await workspace.execute('save', { ...config, curator: 'Анна Петрова' });
  assert.deepEqual(reassigned.connectors.map(connector => connector.curator), ['', 'Анна Петрова']);
});

test('accepts collection asynchronously and keeps the last successful file on a later failure', async t => {
  let complete;
  let imports = 0;
  let fail = false;
  const bytes = Buffer.from('spreadsheet');
  const sourceId = createHash('sha256').update(bytes).digest('hex');
  const runtime = fakeRuntime({
    async collect() {
      if (fail) throw new Error('raw process detail containing private location');
      return new Promise(resolve => { complete = () => resolve({ filename: 'report.xlsx', bytes }); });
    }
  });
  const { workspace, args } = await fixture(t, { runtime, importSource: async (file, contents) => {
    imports++;
    assert.equal(file, 'report.xlsx');
    assert.deepEqual(contents, bytes);
    return { sources: [{ name: file, id: sourceId }] };
  } });
  const [{ id }] = (await workspace.execute('save', config)).connectors;
  const first = (await workspace.execute('collect', { id })).jobs.at(-1);
  assert.equal(first.state, 'running');
  await assert.rejects(workspace.execute('read', { id }), { code: 'BROWSER_BUSY' });
  complete();
  const good = await finished(workspace, first.id);
  assert.equal(good.state, 'success');
  assert.equal(good.sourceId, sourceId);
  fail = true;
  const second = (await workspace.execute('collect', { id })).jobs.at(-1);
  const bad = await finished(workspace, second.id);
  assert.equal(bad.state, 'error');
  assert.doesNotMatch(bad.message, /raw process/u);
  assert.equal(imports, 1);
  const restarted = await openBrowserWorkspace(args);
  assert.deepEqual(restarted.getState().jobs.map(item => item.id), [first.id, second.id]);
  assert.equal(restarted.getState().jobs[0].sourceId, sourceId);
  await restarted.shutdown();
});

test('retains the previous report after cancellation and closes an open login on shutdown', async t => {
  let cancelNext = false;
  const runtime = fakeRuntime({
    async read(_config, { signal }) {
      if (cancelNext) return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return { title: 'Сводка', text: 'Готово 24 из 28' };
    }
  });
  const { workspace, args } = await fixture(t, { runtime });
  const [{ id }] = (await workspace.execute('save', config)).connectors;
  const read = (await workspace.execute('read', { id })).jobs.at(-1);
  assert.equal((await finished(workspace, read.id)).state, 'success');
  const [lastGood] = workspace.getState().reports;
  assert.equal(lastGood.text, 'Готово 24 из 28');
  cancelNext = true;
  const pending = (await workspace.execute('read', { id })).jobs.at(-1);
  const close = (await workspace.execute('close', { id })).jobs.at(-1);
  assert.equal((await finished(workspace, pending.id)).state, 'error');
  assert.equal((await finished(workspace, close.id)).state, 'success');
  assert.deepEqual(workspace.getState().reports, [lastGood]);
  const login = (await workspace.execute('login', { id })).jobs.at(-1);
  await finished(workspace, login.id);
  assert.deepEqual(workspace.getState().openProfiles, [id]);
  await assert.rejects(workspace.execute('save', { ...config, id, expectedRevision: 1 }), { code: 'BROWSER_BUSY' });
  await workspace.shutdown();
  assert.equal(runtime.isOpen(id), false);
  await assert.rejects(workspace.execute('login', { id }), { code: 'BROWSER_CLOSED' });
  const restarted = await openBrowserWorkspace(args);
  assert.deepEqual(restarted.getState().reports, [lastGood]);
  await restarted.shutdown();
});

test('refuses a private directory redirected by a junction or symlink', async t => {
  const { args, root } = await fixture(t);
  const target = join(root, 'different');
  const privateRoot = join(root, 'redirected');
  await mkdir(target);
  try {
    await symlink(target, privateRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    t.skip('The current Windows isolation does not allow creating a junction fixture.');
    return;
  }
  await assert.rejects(openBrowserWorkspace({ ...args, privateRoot }), { code: 'BROWSER_PRIVATE_DIRECTORY' });
});

test('refuses a private location obstructed by a file', async t => {
  const { args, root } = await fixture(t);
  const privateRoot = join(root, 'obstructed');
  await writeFile(privateRoot, 'occupied');
  await assert.rejects(openBrowserWorkspace({ ...args, privateRoot }), { code: 'BROWSER_PRIVATE_DIRECTORY' });
});

test('keeps a completed recording as a draft and blocks read while recording', async t => {
  const active = new Set();
  const actions = [{ type: 'click', selector: '#show-report' }];
  const runtime = fakeRuntime({
    isRecording(id) { return active.has(id); },
    async startRecording({ id }) { active.add(id); },
    async stopRecording(id) { active.delete(id); return { actions, downloadSelector: '#export-xlsx' }; },
  });
  const { workspace, args } = await fixture(t, { runtime });
  const [connector] = (await workspace.execute('save', config)).connectors;
  const { id } = connector;
  await assert.rejects(workspace.execute('record', { id }), { code: 'BROWSER_LOGIN_REQUIRED' });
  const login = (await workspace.execute('login', { id })).jobs.at(-1);
  await finished(workspace, login.id);
  const started = await workspace.execute('record', { id });
  assert.equal(started.recordings[0].active, true);
  await assert.rejects(workspace.execute('read', { id }), { code: 'BROWSER_BUSY' });
  const stopped = await workspace.execute('record-stop', { id });
  assert.deepEqual(stopped.recordings, [{ connectorId: id, actions, downloadSelector: '#export-xlsx', active: false }]);
  assert.deepEqual(stopped.connectors[0].actions, connector.actions);
  await workspace.shutdown();
  const reopened = await openBrowserWorkspace(args);
  t.after(() => reopened.shutdown());
  assert.deepEqual(reopened.getState().recordings, stopped.recordings);
});
