import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitCliProvider } from '../../src/features/publishing/git-cli-provider';

const exec = promisify(execFile), roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'uor-permission-')); roots.push(root);
  const remote = join(root, 'remote.git'), seed = join(root, 'seed');
  await exec('git', ['init', '--bare', '--initial-branch=main', remote]);
  await exec('git', ['init', '--initial-branch=main', seed]);
  await mkdir(join(seed, 'catalog'), { recursive: true });
  await writeFile(join(seed, 'catalog/demo.json'), '{"id":"demo","classification":"demo"}\n');
  const git = (...args: string[]) => exec('git', ['-C', seed, ...args]);
  await git('add', 'catalog');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Fixture');
  await git('remote', 'add', 'origin', remote); await git('push', 'origin', 'main');
  return { root, remote, provider: new GitCliProvider({ projectRoot: seed, runtimeRoot: join(root, 'runtime'), url: remote,
    publishedBranch: 'main', releaseBranch: 'release/current' }) };
}
const payload = { files: [{ path: 'catalog/goals/new.json', content: '{"id":"new","classification":"demo"}\n', baseContent: null }],
  actor: { name: 'Curator demo' }, classification: 'demo' as const, publicationMode: 'demo-only' as const };
const validationProvider = () => new GitCliProvider({ projectRoot: process.cwd(), runtimeRoot: join(tmpdir(), 'uor-validation-unused'),
  url: join(tmpdir(), 'uor-unused.git'), publishedBranch: 'main', releaseBranch: 'release/current' });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('publication boundaries', () => {
  it('reports rejected repository write instead of treating curator mode as Git permission', async () => {
    const f = await fixture();
    await writeFile(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\necho "permission denied: write prohibited" >&2\nexit 1\n', { mode: 0o755 });
    await expect(f.provider.pushChanges(payload)).rejects.toMatchObject({ code: 'publication_permission_denied' });
    expect((await f.provider.readVersion('main')).files['catalog/goals/new.json']).toBeUndefined();
  }, 30000);

  it('blocks corporate data in the public demo mode before publication', async () => {
    const provider = validationProvider();
    await expect(provider.pushChanges({ ...payload, classification: 'corporate' })).rejects.toThrow(/корпоратив/i);
    await expect(provider.pushChanges({ ...payload, files: [{ path: 'catalog/goals/new.json', content: '{"classification":"corporate"}' }] })).rejects.toThrow(/корпоратив/i);
  });

  it.each(['.runtime/secret.json', 'catalog/../secret.json', 'catalog/../../outside.json', '/catalog/a.json', 'catalog\\..\\secret.json', 'src/code.ts', 'catalog/.git/config'])
    ('rejects unsafe publication path %s', async (path) => {
      await expect(validationProvider().pushChanges({ ...payload, files: [{ path, content: '{}' }] })).rejects.toThrow(/путь|каталог/i);
    });

  it('new-object publication cannot silently overwrite a preexisting object', async () => {
    const f = await fixture();
    await expect(f.provider.pushChanges({ ...payload, files: [{ path: 'catalog/demo.json', baseContent: null, content: '{"id":"different"}' }] }))
      .rejects.toMatchObject({ code: 'publication_conflict' });
  }, 30000);

  it('reports unavailable update checks as diagnostics', async () => {
    const f = await fixture();
    const unavailable = new GitCliProvider({ projectRoot: f.root, runtimeRoot: join(f.root, 'offline-runtime'),
      url: join(f.root, 'nonexistent.git'), publishedBranch: 'main', releaseBranch: 'release/current' });
    expect(await unavailable.checkUpdates('main', null)).toMatchObject({ status: 'unavailable', remoteCommit: null });
  }, 30000);
});
