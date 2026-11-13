import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

const sharedPath = 'data/rm-uor.json';
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const maxBytes = 8 * 1024 * 1024;
const gitOptions = [
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=always',
  '-c', 'protocol.https.allow=always',
];

// Git supplies the advertised remote object ID to pre-push. Compare it
// before sending so a rewind or deletion cannot pass a stale preview.
const prePush = [
  '#!/bin/sh',
  'read -r local_ref local_oid remote_ref remote_oid || exit 1',
  'if [ "$remote_ref" != "$RM_UOR_REMOTE_REF" ] || [ "$remote_oid" != "$RM_UOR_EXPECTED_HEAD" ]; then',
  '  echo "RM_UOR_CONFLICT" >&2',
  '  exit 1',
  'fi',
  'if read -r more; then exit 1; fi',
  'exit 0',
  '',
].join('\n');

function problem(code, message) {
  return Object.assign(new Error(message), { code });
}

function git(args, { gitExecutable = 'git', repo, input, extraEnv = {}, hooksDir, manualAuth = false } = {}) {
  const env = { ...process.env, LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
    delete env[name];
  }
  if (manualAuth) {
    for (const name of Object.keys(env)) {
      if (/^(GIT_TRACE|GCM_TRACE|GIT_CONFIG(?:$|_(COUNT|KEY_|VALUE_|PARAMETERS))|GIT_CURL_VERBOSE$|CURL_TRACE|GIT_SSL_NO_VERIFY$|SSLKEYLOGFILE$|GIT_EXEC_PATH$)/i.test(name)) {
        delete env[name];
      }
    }
    Object.assign(env, { GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' });
  }
  const options = [...gitOptions];
  if (repo) options.push(`--git-dir=${repo}`);
  if (hooksDir) options.push('-c', `core.hooksPath=${hooksDir}`);
  return new Promise((resolve, reject) => {
    const child = execFile(gitExecutable, [...options, ...args], {
      encoding: 'utf8', env: { ...env, ...extraEnv }, maxBuffer: maxBytes, timeout: 120_000, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) reject({ code: error.code, diagnostic: stderr, stdout });
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function executablePath(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
      || !/^git(?:\.exe)?$/i.test(basename(value))) {
    throw problem('INVALID_CONFIG', 'Укажите абсолютный путь к git.exe или оставьте поле пустым.');
  }
  return value;
}

export async function checkGitExecutable({ gitExecutable } = {}) {
  gitExecutable = executablePath(gitExecutable);
  try {
    const version = (await git(['--version'], { gitExecutable })).trim();
    if (!/^git version [\d.]+[^\r\n]*$/.test(version)) throw new Error('Unexpected Git version');
    return version;
  } catch {
    throw problem('GIT_UNAVAILABLE', 'Git не запускается. Установите Git или укажите путь к git.exe.');
  }
}

export function validateSharedConfig(config) {
  const { remote, branch = 'main', cacheDir, gitExecutable } = config ?? {};
  let validRemote = false;
  if (typeof remote === 'string' && !/[\x00-\x1f\x7f]/.test(remote)) {
    if (isAbsolute(remote) && !remote.startsWith('\\\\') && !remote.startsWith('//')) validRemote = true;
    else {
      try {
        const url = new URL(remote);
        validRemote = remote.startsWith('https://') && !/[\\\s]/.test(remote) && Boolean(url.hostname)
          && !url.username && !url.password && !url.search && !url.hash;
      } catch {}
    }
  }
  if (!validRemote || typeof cacheDir !== 'string' || !isAbsolute(cacheDir)
      || typeof branch !== 'string' || branch.startsWith('-') || !/^[A-Za-z0-9_./-]+$/.test(branch)
      || branch.includes('..') || branch.endsWith('.') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw problem('INVALID_CONFIG', 'Укажите адрес HTTPS без учётных данных или абсолютный путь к Git и корректную ветку.');
  }
  return { remote, ref: `refs/heads/${branch}`, cacheDir, gitExecutable: executablePath(gitExecutable) };
}

async function checkedConfig(config) {
  const checked = validateSharedConfig(config);
  try {
    await git(['check-ref-format', checked.ref], checked);
  } catch (error) {
    await checkGitExecutable(checked);
    throw problem('INVALID_CONFIG', 'Имя ветки Git указано неверно.');
  }
  return checked;
}

function checkedCredentials(remote, credentials) {
  if (credentials == null) return null;
  const { username, password } = credentials;
  if (!remote.startsWith('https://') || typeof username !== 'string' || !username.trim()
      || /[:\x00-\x1f\x7f]/.test(username) || username.length > 256
      || typeof password !== 'string' || !password.length || password.length > 4096
      || /[\x00-\x1f\x7f]/.test(password)) {
    throw problem('INVALID_CREDENTIALS', 'Для разового входа укажите HTTPS, имя пользователя без двоеточия и пароль или токен.');
  }
  // Git config receives the header only through this operation's child environment.
  // The empty generic header list clears inherited extra headers before adding ours.
  return `Authorization: Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function authenticatedGit(config, args, { repo, auth, push = false } = {}) {
  const options = { gitExecutable: config.gitExecutable, repo };
  if (!auth) return git(args, options);

  // Cover both directions without contacting any endpoint. This rejects a
  // destination rewrite even when the alternate repository has the same head.
  let rewrites;
  try {
    rewrites = await git(['config', '--null', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'],
      { ...options, manualAuth: true });
  } catch (error) {
    if (error.code !== 1 || error.diagnostic) {
      throw problem('GIT_DESTINATION_CHANGED', 'Не удалось проверить адрес Git для разового входа.');
    }
    rewrites = '';
  }
  const matched = rewrites.split('\0').filter(Boolean).some(entry => {
    const boundary = entry.indexOf('\n');
    return boundary !== -1 && config.remote.startsWith(entry.slice(boundary + 1));
  });
  if (matched) throw problem('GIT_DESTINATION_CHANGED', 'Локальные настройки перенаправляют Git-адрес. Используйте прямой HTTPS-адрес для разового входа.');

  const scoped = `http.${config.remote}`;
  const configEntries = [
    ['http.extraHeader', ''],
    [`${scoped}.extraHeader`, auth],
  ];
  const extraEnv = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CONFIG_COUNT: String(configEntries.length) };
  configEntries.forEach(([key, value], index) => {
    extraEnv[`GIT_CONFIG_KEY_${index}`] = key;
    extraEnv[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const transport = [
    '-c', 'protocol.file.allow=never',
    '-c', 'credential.helper=',
    '-c', 'credential.interactive=false',
    '-c', 'core.askPass=',
    '-c', 'http.followRedirects=false',
    '-c', `${scoped}.followRedirects=false`,
    '-c', 'http.sslVerify=true',
    '-c', `${scoped}.sslVerify=true`,
  ];
  try {
    return await git([...transport, ...args], { ...options, extraEnv, manualAuth: true });
  } catch (error) {
    if (push && /\[rejected\].*stale info/i.test(error.stdout || '')) throw conflict();
    if (/authentication failed|terminal prompts disabled|unable to get (?:password|username)|\b(?:401|403)\b|access denied/i.test(error.diagnostic || '')) {
      throw problem('GIT_AUTH_FAILED', 'Git отклонил разовый вход или действие. Проверьте учётные данные и права на репозиторий.');
    }
    throw problem(push ? 'PUBLISH_FAILED' : 'SHARED_UNAVAILABLE',
      push ? 'Git не принял выпуск. Проверьте права на запись и состояние подключения.'
        : 'Общая версия недоступна. Проверьте адрес HTTPS и подключение Git.');
  }
}

async function remoteHead(config, auth) {
  const { remote, ref } = config;
  try {
    const result = (await authenticatedGit(config, ['ls-remote', '--refs', '--', remote, ref], { auth })).trim();
    if (!result) return null;
    const [revision, found] = result.split('\t');
    if (!sha.test(revision) || found !== ref) throw new Error('Unexpected Git response');
    return revision;
  } catch (error) {
    if (error instanceof Error && error.code) throw error;
    throw problem('SHARED_UNAVAILABLE', 'Общая версия недоступна. Проверьте адрес репозитория, подключение и вход Git.');
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

async function openRepo(config, revision) {
  const { cacheDir } = config;
  const algorithm = revision?.length === 64 ? 'sha256' : 'sha1';
  const repo = join(cacheDir, `shared-${algorithm}.git`);
  if (await exists(join(repo, 'HEAD'))) return repo;
  await mkdir(cacheDir, { recursive: true });
  const temporary = await mkdtemp(join(cacheDir, 'init-'));
  try {
    await git(['init', '--bare', '--template=', `--object-format=${algorithm}`, temporary], config);
    try {
      await rename(temporary, repo);
    } catch (error) {
      if (!await exists(join(repo, 'HEAD'))) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return repo;
}

function validGoals(goals) {
  return Array.isArray(goals) && goals.every(goal => goal && typeof goal.id === 'string' && goal.id.trim().length > 0)
    && new Set(goals.map(goal => goal.id)).size === goals.length;
}

const ditStatusKey = row => JSON.stringify([row.goalId, row.period]);

function validDitStatuses(rows) {
  return Array.isArray(rows) && rows.every(row => row && typeof row.goalId === 'string' && row.goalId.trim()
    && typeof row.period === 'string' && row.period.trim() && typeof row.status === 'string'
    && typeof row.revision === 'string' && uuid.test(row.revision))
    && new Set(rows.map(ditStatusKey)).size === rows.length;
}

async function snapshot(config, repo, revision, auth) {
  const { remote } = config;
  const local = { repo, gitExecutable: config.gitExecutable };
  const empty = { revision, version: 0, goals: [], history: [] };
  if (!revision) return empty;
  try {
    await authenticatedGit(config, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', remote, revision], { repo, auth });
  } catch (error) {
    if (error instanceof Error && error.code) throw error;
    throw problem('SHARED_UNAVAILABLE', 'Не удалось получить выбранную версию из Git.');
  }
  try {
    const tree = await git(['ls-tree', '-z', '--full-tree', revision, '--', sharedPath], local);
    if (!tree) return empty;
    if (!/^100(?:644|755) blob /.test(tree)) throw new Error('Expected a data file');
    const data = JSON.parse(await git(['cat-file', 'blob', `${revision}:${sharedPath}`], local));
    if (!Number.isSafeInteger(data.version) || data.version < 1 || !validGoals(data.goals) || !Array.isArray(data.history)
        || ('ditStatuses' in data && !validDitStatuses(data.ditStatuses))) {
      throw new Error('Invalid shared snapshot');
    }
    return { revision, version: data.version, goals: data.goals, history: data.history,
      ...('ditStatuses' in data ? { ditStatuses: data.ditStatuses } : {}) };
  } catch {
    throw problem('INVALID_SHARED_DATA', 'Файл общей версии повреждён или имеет неподдерживаемый формат.');
  }
}

export async function readShared(input, { credentials } = {}) {
  const config = await checkedConfig(input);
  const auth = checkedCredentials(config.remote, credentials);
  const revision = await remoteHead(config, auth);
  const repo = await openRepo(config, revision).catch(() => {
    throw problem('SHARED_UNAVAILABLE', 'Не удалось подготовить локальное хранилище общей версии.');
  });
  return snapshot(config, repo, revision, auth);
}

function conflict() {
  return problem('CONFLICT', 'Общая версия изменилась. Обновите её и проверьте черновик перед отправкой.');
}

export async function publishShared(input, { expectedRevision, goals = [], ditStatuses = [], author, credentials } = {}) {
  if ((expectedRevision !== null && (typeof expectedRevision !== 'string' || !sha.test(expectedRevision)))
      || !validGoals(goals) || !validDitStatuses(ditStatuses) || (!goals.length && !ditStatuses.length)
      || typeof author !== 'string' || !author.trim()
      || /[\x00-\x1f\x7f<>]/.test(author)) {
    throw problem('INVALID_PUBLICATION', 'Для выпуска нужны актуальная версия, выбранные цели и имя автора.');
  }
  const config = await checkedConfig(input);
  const auth = checkedCredentials(config.remote, credentials);
  const revision = await remoteHead(config, auth);
  if (revision !== expectedRevision) throw conflict();
  const repo = await openRepo(config, revision).catch(() => {
    throw problem('SHARED_UNAVAILABLE', 'Не удалось подготовить локальное хранилище общей версии.');
  });
  const current = await snapshot(config, repo, revision, auth);
  const merged = new Map(current.goals.map(goal => [goal.id, goal]));
  for (const goal of goals) merged.set(goal.id, goal);
  const mergedStatuses = new Map((current.ditStatuses ?? []).map(row => [ditStatusKey(row), row]));
  for (const row of ditStatuses) mergedStatuses.set(ditStatusKey(row), row);
  const version = current.version + 1;
  const publishedAt = new Date().toISOString();
  const goalIds = [...new Set([...goals.map(goal => goal.id), ...ditStatuses.map(row => row.goalId)])];
  const history = [...current.history, { version, author, publishedAt, goalIds }];
  const next = { version, goals: [...merged.values()], history };
  if (current.ditStatuses || ditStatuses.length) next.ditStatuses = [...mergedStatuses.values()];
  const bytes = JSON.stringify(next, null, 2) + '\n';
  if (!Number.isSafeInteger(version) || Buffer.byteLength(bytes) >= maxBytes) {
    throw problem('INVALID_PUBLICATION', 'Общая версия превышает поддерживаемый размер.');
  }
  const temporary = await mkdtemp(join(config.cacheDir, 'publish-')).catch(() => {
    throw problem('PUBLISH_FAILED', 'Не удалось подготовить локальные файлы выпуска.');
  });
  try {
    const gitExecutable = config.gitExecutable;
    const commit = await prepareCommit({ repo, temporary, bytes, revision, author, version, gitExecutable });
    try {
      const args = ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no'];
      const destination = ['--', config.remote, `${commit}:${config.ref}`];
      if (auth) {
        // The new commit is a child of revision. The exact lease guards that
        // same parent without running a hook in the credential environment.
        await authenticatedGit(config, [...args, '--no-verify', `--force-with-lease=${config.ref}:${revision ?? ''}`, ...destination],
          { repo, auth, push: true });
      } else {
        await writeFile(join(temporary, 'pre-push'), prePush, { mode: 0o700 });
        await git([...args, ...destination], {
          repo, gitExecutable, hooksDir: temporary, extraEnv: {
            RM_UOR_REMOTE_REF: config.ref,
            RM_UOR_EXPECTED_HEAD: revision ?? '0'.repeat(commit.length),
          },
        });
      }
    } catch (error) {
      if (error instanceof Error && ['GIT_AUTH_FAILED', 'GIT_DESTINATION_CHANGED', 'CONFLICT'].includes(error.code)) throw error;
      const now = await remoteHead(config, auth).catch(() => undefined);
      if (now === commit) return { revision: commit, ...next };
      if (error.diagnostic?.includes('RM_UOR_CONFLICT') || (now !== undefined && now !== revision)) throw conflict();
      throw problem('PUBLISH_FAILED', 'Git не принял выпуск. Проверьте права на запись и состояние подключения.');
    }
    return { revision: commit, ...next };
  } catch (error) {
    if (error instanceof Error && ['CONFLICT', 'PUBLISH_FAILED', 'GIT_AUTH_FAILED', 'GIT_DESTINATION_CHANGED'].includes(error.code)) throw error;
    throw problem('PUBLISH_FAILED', 'Не удалось подготовить выпуск в Git.');
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareCommit({ repo, temporary, bytes, revision, author, version, gitExecutable }) {
  const local = { repo, gitExecutable };
  const index = { ...local, extraEnv: { GIT_INDEX_FILE: join(temporary, 'index') } };
  await git(['read-tree', revision ?? '--empty'], index);
  const blob = (await git(['hash-object', '-w', '--stdin'], { ...local, input: bytes })).trim();
  await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${sharedPath}`], index);
  const tree = (await git(['write-tree'], index)).trim();
  const identity = { name: author, email: 'rm-uor@localhost' };
  const args = ['commit-tree', tree, '-m', `RM UOR shared snapshot ${version}`];
  if (revision) args.push('-p', revision);
  const extraEnv = {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  };
  return (await git(args, { ...local, extraEnv })).trim();
}
