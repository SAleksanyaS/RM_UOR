import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const goal = (id, title = id) => ({ id, title, results: [] });
const dit = (goalId, period, status, revision) => ({ goalId, period, status, revision });
const installedGit = () => {
  const [command, name] = process.platform === 'win32' ? ['where.exe', 'git.exe'] : ['which', 'git'];
  return realpathSync(execFileSync(command, [name], { encoding: 'utf8' }).split(/\r?\n/)[0]);
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rm-uor-share-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const remote = join(directory, 'shared remote.git');
  git('init', '--bare', '--initial-branch=main', remote);
  return { directory, remote, config: { remote, cacheDir: join(directory, 'writer cache') } };
}

test('publishes only selected goals and shares them through a second installation', async t => {
  const { readShared, publishShared } = await import('../src/shared-git.mjs');
  const { directory, remote, config } = await fixture(t);
  const reader = { remote, cacheDir: join(directory, 'reader cache') };
  assert.deepEqual(await readShared(reader), { revision: null, version: 0, goals: [], history: [] });

  const first = await publishShared(config, { expectedRevision: null, goals: [goal('one'), goal('two')], author: 'Куратор' });
  assert.equal(first.version, 1);
  assert.match(first.revision, /^[a-f0-9]{40}$/);
  assert.deepEqual(await readShared(reader), first);
  assert.deepEqual(first.history.map(entry => ({ ...entry, publishedAt: null })), [
    { version: 1, author: 'Куратор', goalIds: ['one', 'two'], publishedAt: null },
  ]);
  assert.ok(Number.isFinite(Date.parse(first.history[0].publishedAt)));

  const second = await publishShared(config, { expectedRevision: first.revision, goals: [goal('one', 'Обновлена')], author: 'Куратор' });
  assert.equal(second.version, 2);
  assert.deepEqual(second.goals, [goal('one', 'Обновлена'), goal('two')]);
  assert.equal(git(`--git-dir=${remote}`, 'rev-parse', `${second.revision}^`), first.revision);
  assert.deepEqual(await readShared(reader), second);
  await assert.rejects(
    publishShared(config, { expectedRevision: first.revision, goals: [goal('lost')], author: 'Куратор' }),
    { code: 'CONFLICT' },
  );
  assert.deepEqual(await readShared(reader), second);
});

test('preserves other files on main and commits only the shared snapshot', async t => {
  const { readShared, publishShared } = await import('../src/shared-git.mjs');
  const { directory, remote, config } = await fixture(t);
  const seed = join(directory, 'seed checkout');
  git('clone', remote, seed);
  await writeFile(join(seed, 'README.md'), 'Keep this file\n');
  git('-C', seed, 'add', 'README.md');
  git('-C', seed, '-c', 'user.name=Test Author', '-c', 'user.email=test@localhost', 'commit', '-m', 'Seed');
  git('-C', seed, 'push', 'origin', 'main');

  const before = await readShared(config);
  assert.equal(before.version, 0);
  const next = await publishShared(config, { expectedRevision: before.revision, goals: [goal('one')], author: 'Куратор' });
  assert.equal(git(`--git-dir=${remote}`, 'show', `${next.revision}:README.md`), 'Keep this file');
  assert.equal(git(`--git-dir=${remote}`, 'diff-tree', '--no-commit-id', '--name-only', '-r', next.revision), 'data/rm-uor.json');
});

test('only one installation can publish from the same remote revision', async t => {
  const { readShared, publishShared } = await import('../src/shared-git.mjs');
  const { directory, remote, config } = await fixture(t);
  const secondConfig = { remote, cacheDir: join(directory, 'writer two') };
  const results = await Promise.allSettled([
    publishShared(config, { expectedRevision: null, goals: [goal('one')], author: 'First' }),
    publishShared(secondConfig, { expectedRevision: null, goals: [goal('two')], author: 'Second' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'CONFLICT');
  const actual = await readShared(config);
  assert.equal(actual.version, 1);
  assert.equal(actual.goals.length, 1);
});

test('rejects a push when its advertised head has moved backwards', async t => {
  const { publishShared } = await import('../src/shared-git.mjs');
  const { directory, remote, config } = await fixture(t);
  const first = await publishShared(config, { expectedRevision: null, goals: [goal('one')], author: 'First' });
  const behind = join(directory, 'behind.git');
  git('clone', '--bare', remote, behind);
  const second = await publishShared(config, { expectedRevision: first.revision, goals: [goal('two')], author: 'Second' });

  // Separate local read and push destinations to deterministically reproduce
  // a rewind between checking the expected revision and advertising the push.
  const gitConfig = join(directory, 'push-settings');
  git('config', '--file', gitConfig, `url.${behind}.pushInsteadOf`, remote);
  const previousConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  try {
    await assert.rejects(
      publishShared(config, { expectedRevision: second.revision, goals: [goal('three')], author: 'Third' }),
      { code: 'CONFLICT' },
    );
    assert.equal(git(`--git-dir=${behind}`, 'rev-parse', 'refs/heads/main'), first.revision);
  } finally {
    if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousConfig;
  }
});

test('rejects malformed Git settings before contacting the remote', async t => {
  const { readShared } = await import('../src/shared-git.mjs');
  const { config } = await fixture(t);
  for (const remote of ['https://secret@example.invalid/data.git', 'ext::echo secret', '../remote']) {
    await assert.rejects(readShared({ ...config, remote }), { code: 'INVALID_CONFIG' });
  }
  await assert.rejects(readShared({ ...config, branch: 'main..unsafe' }), { code: 'INVALID_CONFIG' });
});

test('publishes DIT statuses by goal and period while retaining blank tombstones', async t => {
  const { readShared, publishShared } = await import('../src/shared-git.mjs');
  const { config } = await fixture(t);
  const one = dit('one', 'Q4', 'Есть риски', '8e5d0445-4df4-495b-ad09-e997d1fcf359');
  const year = dit('one', 'Y', 'В плане', '7de445b0-a543-4c6a-a9ee-318b3b5fdd20');
  const two = dit('two', 'Q4', 'Выполнено', 'a93e0230-d71f-46a8-82f7-bf47a9d21cc0');
  const first = await publishShared(config, { expectedRevision: null, ditStatuses: [one, year, two], author: 'First' });
  assert.deepEqual(first.ditStatuses, [one, year, two]);
  assert.deepEqual(first.history[0].goalIds, ['one', 'two']);
  assert.deepEqual(first.goals, []);
  const tombstone = { ...one, status: '', revision: '878f975d-c986-4c55-bafc-c4c67c560ff1' };
  const second = await publishShared(config, { expectedRevision: first.revision, goals: [goal('three')], ditStatuses: [tombstone], author: 'Second' });
  assert.deepEqual(second.ditStatuses, [tombstone, year, two]);
  assert.deepEqual(second.history[1].goalIds, ['three', 'one']);
  assert.deepEqual(await readShared(config), second);
  await assert.rejects(
    publishShared(config, { expectedRevision: second.revision, ditStatuses: [one, tombstone], author: 'Duplicate' }),
    { code: 'INVALID_PUBLICATION' },
  );
});

test('checks configured portable Git and gives a diagnostic when it is missing', async t => {
  const { checkGitExecutable, readShared } = await import('../src/shared-git.mjs');
  const { directory, config } = await fixture(t);
  const installed = installedGit();
  assert.match(await checkGitExecutable({ gitExecutable: installed }), /^git version /);
  assert.equal((await readShared({ ...config, gitExecutable: installed })).version, 0);
  const missing = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
  await assert.rejects(checkGitExecutable({ gitExecutable: missing }), { code: 'GIT_UNAVAILABLE' });
  await assert.rejects(readShared({ ...config, gitExecutable: missing }), { code: 'GIT_UNAVAILABLE' });
  await assert.rejects(checkGitExecutable({ gitExecutable: 'git' }), { code: 'INVALID_CONFIG' });
});

test('passes credentials to a loopback HTTPS Git request without following a redirect', async t => {
  const { readShared } = await import('../src/shared-git.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'rm-uor-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const openssl = process.platform === 'win32' ? join(dirname(dirname(installedGit())), 'usr', 'bin', 'openssl.exe') : 'openssl';
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  try {
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('A local OpenSSL executable is needed to generate a temporary TLS certificate');
    return;
  }

  const requests = [];
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url.startsWith('/redirect.git/')) {
      response.writeHead(302, { location: '/wrong.git/info/refs' }).end();
    } else {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="test"' }).end(request.headers.authorization);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `https://127.0.0.1:${server.address().port}`;
  const gitConfig = join(directory, 'test-config');
  await writeFile(gitConfig, '[http]\n\tsslBackend = openssl\n');
  const overrides = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_SSL_CAINFO: cert,
    GIT_TRACE_CURL: join(directory, 'curl-trace'),
    GIT_TRACE_REDACT: '0',
    GIT_TRACE2_EVENT: join(directory, 'event-trace'),
  };
  const previous = new Map(Object.keys(overrides).map(name => [name, process.env[name]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const credentials = { username: 'test-user', password: 'fake-password' };
  const authorization = `Basic ${Buffer.from('test-user:fake-password').toString('base64')}`;
  const cacheDir = join(directory, 'cache');
  await assert.rejects(readShared({ remote: `${base}/secure.git`, cacheDir }, { credentials }), error => {
    assert.equal(error.code, 'GIT_AUTH_FAILED', `Loopback received ${requests.length} request(s)`);
    assert.ok(!JSON.stringify(error).includes(authorization));
    assert.ok(!error.message.includes(credentials.password));
    return true;
  });
  await assert.rejects(readShared({ remote: `${base}/redirect.git`, cacheDir }, { credentials }), { code: 'SHARED_UNAVAILABLE' });
  assert.deepEqual(requests, [
    { url: '/secure.git/info/refs?service=git-upload-pack', authorization },
    { url: '/redirect.git/info/refs?service=git-upload-pack', authorization },
  ]);
  await assert.rejects(readFile(overrides.GIT_TRACE_CURL), { code: 'ENOENT' });
  const eventTrace = await readFile(overrides.GIT_TRACE2_EVENT, 'utf8').catch(() => '');
  assert.ok(!eventTrace.includes(authorization));
  assert.ok(!eventTrace.includes(credentials.password));
});

test('manual Git credentials require HTTPS and reject configured destination rewrites', async t => {
  const { readShared, publishShared } = await import('../src/shared-git.mjs');
  const { directory, config } = await fixture(t);
  const credentials = { username: 'synthetic-user', password: 'synthetic-password' };
  await assert.rejects(readShared(config, { credentials }), { code: 'INVALID_CREDENTIALS' });
  const remote = 'https://git.example.invalid/scm/project/data.git';
  const gitConfig = join(directory, 'manual-auth-config');
  const previousConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  try {
    for (const rule of ['insteadOf', 'pushInsteadOf']) {
      git('config', '--file', gitConfig, `url.https://other.example.invalid/.${rule}`, 'https://git.example.invalid/');
      const options = { ...config, remote };
      await assert.rejects(readShared(options, { credentials }), { code: 'GIT_DESTINATION_CHANGED' });
      await assert.rejects(publishShared(options, {
        expectedRevision: null, goals: [goal('one')], author: 'First', credentials,
      }), { code: 'GIT_DESTINATION_CHANGED' });
      git('config', '--file', gitConfig, '--unset', `url.https://other.example.invalid/.${rule}`);
    }
  } finally {
    if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousConfig;
  }
});
