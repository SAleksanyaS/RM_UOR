import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DomainChangeEvent, UpdateInfo } from '../../domain/contracts';
import { canonicalJson, mergeObject, MergeConflictError, refreshObjectRevision } from './merge-object';
import { semanticDiff } from './semantic-diff';

const execute = promisify(execFile);
export interface RepositoryVersion { commit: string; files: Record<string, string> }
export interface PublishChanges {
  files: { path: string; content: string; baseContent?: string | null }[];
  actor: { name: string; email?: string }; classification: 'demo' | 'corporate'; publicationMode: 'demo-only' | 'internal';
  expectedCommit?: string;
}
export interface PublishResult { remoteCommit: string; branch: string; appliedObjectIds: string[] }
export interface GitCliProviderOptions {
  projectRoot: string; runtimeRoot: string; url: string; publishedBranch: string; releaseBranch: string; credentialHelper?: string;
}
export class PublicationConflictError extends Error {
  readonly code = 'publication_conflict';
  constructor(public readonly path: string, public readonly fields: string[] = ['$']) {
    super(`Конфликт публикации ${path}: ${fields.join(', ')}. Локальный черновик сохранён; согласуйте изменения.`);
    this.name = 'PublicationConflictError';
  }
}
export class PublicationPermissionError extends Error {
  readonly code = 'publication_permission_denied';
  constructor(detail: string) {
    super(`Репозиторий отклонил запись. Проверьте персональные права Git и правила ветки. ${detail}`);
    this.name = 'PublicationPermissionError';
  }
}
export class PublicationPreviewStaleError extends Error {
  readonly statusCode = 409;
  constructor() { super('Готовящийся выпуск изменился после предпросмотра. Обновите состав и повторите отправку; локальные черновики сохранены.'); this.name = 'PublicationPreviewStaleError'; }
}
class GitCommandError extends Error {
  constructor(public readonly output: string, public readonly exitCode: number | string | undefined) { super(output); }
}
const redact = (value: string) => value.replace(/(https?:\/\/)[^\s/@]+@/g, '$1[учётные данные]@').slice(0, 2000);
const validBranch = (branch: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
  && !branch.includes('..') && !branch.includes('//') && !branch.includes('@{') && !branch.endsWith('/') && !branch.endsWith('.')
  && !branch.split('/').some((part) => part.endsWith('.lock') || part.startsWith('.'));

export function assertPublicationPath(path: string): void {
  const parts = path.split('/');
  if (!['catalog', 'published', 'changes'].includes(parts[0]) || parts.length < 2
    || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || /[\\\x00-\x1f:]/.test(part))
    || /(^|\/)(secrets?|credentials?|browser-profiles?|node_modules)(\/|$)/i.test(path)
    || !/\.(json|md|txt)$/i.test(path))
    throw new Error(`Недопустимый путь публикации: ${path}. Разрешены текстовые данные каталогов catalog, published, changes.`);
}
function rejectSensitivePayload(value: unknown, mode: PublishChanges['publicationMode']): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (mode === 'demo-only' && key === 'classification' && child === 'corporate')
      throw new Error('Корпоративные данные нельзя публиковать в публичный демонстрационный репозиторий.');
    if (/^(password|accessToken|refreshToken|privateKey|credential|curatorCode|certificatePem)$/i.test(key))
      throw new Error(`Секретное поле ${key} не допускается в общую публикацию.`);
    rejectSensitivePayload(child, mode);
  }
}
export function mergeContent(path: string, base: string | null | undefined, local: string, remote: string | null): string {
  const equivalent = (left: string | null | undefined, right: string | null | undefined) => {
    if (left === right) return true;
    if (left == null || right == null || !path.endsWith('.json')) return false;
    try { return canonicalJson(JSON.parse(left)) === canonicalJson(JSON.parse(right)); } catch { return false; }
  };
  if (equivalent(remote, local)) return remote!;
  if (base == null) { if (remote === null) return local; throw new PublicationConflictError(path); }
  if (remote === null) throw new PublicationConflictError(path, ['$deleted']);
  if (equivalent(local, base)) return remote;
  if (equivalent(remote, base)) return local;
  try {
    const previous = JSON.parse(base), proposed = JSON.parse(local), latest = JSON.parse(remote);
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    if (path.startsWith('catalog/') && object(previous) && object(proposed) && object(latest)
      && typeof previous.revision === 'string' && typeof proposed.revision === 'string' && typeof latest.revision === 'string') {
      // An optimistic concurrency token is metadata. Independent business fields
      // still merge; the resulting combined object receives a fresh revision.
      delete previous.revision; delete proposed.revision; delete latest.revision;
      return JSON.stringify(refreshObjectRevision(mergeObject(previous, proposed, latest), randomUUID()), null, 2) + '\n';
    }
    return JSON.stringify(mergeObject(previous, proposed, latest), null, 2) + '\n';
  } catch (error) {
    if (error instanceof MergeConflictError) throw new PublicationConflictError(path, error.fields);
    if (error instanceof PublicationConflictError) throw error;
    throw new PublicationConflictError(path, ['$content']);
  }
}

/** A private checkout isolates data publication from the running application. */
export class GitCliProvider {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly workspace: string;
  private readonly options: GitCliProviderOptions;
  private initialized = false;
  constructor(options: GitCliProviderOptions) {
    if (!validBranch(options.publishedBranch) || !validBranch(options.releaseBranch)) throw new Error('Недопустимое имя ветки Git.');
    if (options.publishedBranch === options.releaseBranch) throw new Error('Ветка выпуска должна отличаться от опубликованной ветки.');
    if (!options.url || options.url.startsWith('-') || /[\x00-\x1f]/.test(options.url)) throw new Error('Недопустимый адрес репозитория.');
    this.options = { ...options };
    this.workspace = resolve(options.runtimeRoot, 'git-workspaces', randomUUID());
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
  private async git(args: string[], allowedExitCodes: number[] = []): Promise<string> {
    const config = this.options.credentialHelper ? ['-c', `credential.helper=${this.options.credentialHelper}`] : [];
    try {
      const result = await execute('git', [...config, '-C', this.workspace, ...args], {
        encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      });
      return result.stdout;
    } catch (error) {
      const failed = error as { stderr?: string; stdout?: string; message?: string; code?: number | string };
      if (typeof failed.code === 'number' && allowedExitCodes.includes(failed.code)) return failed.stdout ?? '';
      throw new GitCommandError(redact([failed.stderr, failed.stdout, failed.message].filter(Boolean).join('\n')), failed.code);
    }
  }
  private async initialize() {
    if (this.initialized) return;
    await mkdir(this.workspace, { recursive: true });
    await this.git(['init', '--initial-branch=uor-local']);
    await this.git(['config', 'core.symlinks', 'false']);
    await mkdir(join(this.workspace, '.git', 'uor-empty-hooks'), { recursive: true });
    await this.git(['config', 'core.hooksPath', join(this.workspace, '.git', 'uor-empty-hooks')]);
    await this.git(['remote', 'add', 'origin', this.options.url]);
    this.initialized = true;
  }
  private async fetchBranch(branch: string): Promise<string | null> {
    if (!validBranch(branch)) throw new Error('Недопустимое имя ветки Git.');
    await this.initialize();
    const found = await this.git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    if (!found.trim()) return null;
    await this.git(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    return (await this.git(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])).trim();
  }
  private async versionAt(commit: string): Promise<RepositoryVersion> {
    const paths = (await this.git(['ls-tree', '-r', '-z', '--name-only', commit, '--', 'catalog', 'published', 'changes']))
      .split('\0').filter(Boolean);
    const files: Record<string, string> = {};
    for (const path of paths) {
      try { assertPublicationPath(path); } catch { continue; }
      files[path] = await this.git(['show', `${commit}:${path}`]);
    }
    return { commit, files };
  }
  private async readVersionUnlocked(branch: string): Promise<RepositoryVersion> {
    const commit = await this.fetchBranch(branch);
    if (!commit) throw new Error(`В репозитории нет ветки ${branch}.`);
    return this.versionAt(commit);
  }
  readVersion(branch: string): Promise<RepositoryVersion> { return this.exclusive(() => this.readVersionUnlocked(branch)); }

  checkUpdates(branch: string, knownCommit: string | null): Promise<UpdateInfo> {
    return this.exclusive(async () => {
      const checkedAt = new Date().toISOString();
      try {
        if (knownCommit && !/^[a-f0-9]{40,64}$/i.test(knownCommit)) throw new Error('Недопустимый идентификатор локальной версии.');
        const version = await this.readVersionUnlocked(branch);
        let previous: RepositoryVersion = { commit: knownCommit ?? '', files: {} };
        if (knownCommit) { try { previous = await this.versionAt(knownCommit); } catch { /* Known version may predate this clone. */ } }
        const metadata = (await this.git(['log', '-1', '--format=%an%n%aI', version.commit])).trim().split('\n');
        const generated = semanticDiff(previous, version, metadata[0] || 'Git', metadata[1] || checkedAt);
        const changes: DomainChangeEvent[] = [];
        for (const [path, content] of Object.entries(version.files)) {
          if (!path.startsWith('changes/') || previous.files[path] === content) continue;
          try {
            const event = JSON.parse(content) as DomainChangeEvent;
            if (typeof event.id === 'string' && typeof event.objectId === 'string' && Array.isArray(event.fields)) changes.push(event);
          } catch { /* A direct Git edit is still visible via structured file diff. */ }
        }
        changes.push(...generated.filter((event) => !changes.some((logged) => logged.objectId === event.objectId)));
        const available = version.commit !== knownCommit;
        return { status: available ? 'available' : 'current', checkedAt, currentCommit: knownCommit,
          remoteCommit: version.commit, message: available ? `В ветке ${branch} доступна новая версия.` : 'У вас актуальная опубликованная версия.', changes };
      } catch (error) {
        return { status: 'unavailable', checkedAt, currentCommit: knownCommit, remoteCommit: null,
          message: `Не удалось проверить обновления: ${redact(error instanceof Error ? error.message : String(error))}`, changes: [] };
      }
    });
  }

  pushChanges(input: PublishChanges): Promise<PublishResult> {
    return this.exclusive(async () => {
      if (input.classification === 'corporate' && input.publicationMode === 'demo-only')
        throw new Error('Корпоративные данные нельзя публиковать в публичный демонстрационный репозиторий.');
      if (!input.files.length) throw new Error('Не выбраны изменения для публикации.');
      if (input.expectedCommit !== undefined && !/^[a-f0-9]{40,64}$/i.test(input.expectedCommit)) throw new Error('Некорректная проверенная версия выпуска');
      if (!input.actor.name.trim() || /[\x00-\x1f]/.test(input.actor.name + (input.actor.email ?? ''))) throw new Error('Некорректный автор публикации.');
      const paths = new Set<string>();
      for (const file of input.files) {
        assertPublicationPath(file.path);
        if (paths.has(file.path)) throw new Error(`Путь ${file.path} указан несколько раз.`);
        paths.add(file.path);
        if (file.path.endsWith('.json')) {
          let payload: unknown;
          try { payload = JSON.parse(file.content); } catch { throw new Error(`Некорректный JSON: ${file.path}`); }
          rejectSensitivePayload(payload, input.publicationMode);
        }
      }
      const appliedObjectIds = [...new Set(input.files.map((file) => {
        try { const value = JSON.parse(file.content); return typeof value.id === 'string' ? value.id : file.path; } catch { return file.path; }
      }))];
      for (let attempt = 0; attempt < 3; attempt++) {
        const baseCommit = await this.fetchBranch(this.options.releaseBranch) ?? await this.fetchBranch(this.options.publishedBranch);
        if (!baseCommit) throw new Error('Не найдена опубликованная основа для релизной ветки.');
        if (input.expectedCommit !== undefined && baseCommit !== input.expectedCommit) throw new PublicationPreviewStaleError();
        const version = await this.versionAt(baseCommit);
        await this.git(['checkout', '--detach', '--force', baseCommit]);
        await this.git(['clean', '-fd']);
        for (const file of input.files) {
          const merged = mergeContent(file.path, file.baseContent, file.content, version.files[file.path] ?? null);
          const destination = resolve(this.workspace, file.path);
          if (!destination.startsWith(this.workspace + sep)) throw new Error('Путь вышел за пределы рабочей области.');
          for (let parent = dirname(destination); parent !== this.workspace; parent = dirname(parent)) {
            try { if ((await lstat(parent)).isSymbolicLink()) throw new Error('Символические ссылки в публикации запрещены.'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, merged, 'utf8');
        }
        await this.git(['add', '--', ...paths]);
        const changes = await this.git(['diff', '--cached', '--name-only']);
        if (!changes.trim()) return { remoteCommit: baseCommit, branch: this.options.releaseBranch, appliedObjectIds };
        await this.git(['-c', `user.name=${input.actor.name}`, '-c', `user.email=${input.actor.email ?? 'uor-local@localhost'}`,
          'commit', '-m', `uor: publish ${input.files.length} shared objects`]);
        const remoteCommit = (await this.git(['rev-parse', 'HEAD'])).trim();
        try {
          await this.git(['push', '--porcelain', 'origin', `HEAD:refs/heads/${this.options.releaseBranch}`]);
          return { remoteCommit, branch: this.options.releaseBranch, appliedObjectIds };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/non-fast-forward|fetch first|cannot lock ref|failed to update ref/i.test(message)) {
            if (input.expectedCommit !== undefined) throw new PublicationPreviewStaleError();
            if (attempt < 2) continue;
            throw new Error('Другие кураторы продолжают отправлять изменения. Три автоматические попытки исчерпаны; черновик сохранён, повторите публикацию.');
          }
          if (/permission denied|access denied|not allowed|prohibited|403|pre-receive hook declined|remote rejected/i.test(message))
            throw new PublicationPermissionError(redact(message));
          throw error;
        }
      }
      throw new Error('Не удалось отправить изменения; локальный черновик сохранён.');
    });
  }
}
