import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitCliProvider } from '../../src/features/publishing/git-cli-provider';
import { mergeObject } from '../../src/features/publishing/merge-object';

const exec = promisify(execFile);
const roots: string[] = [];
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
async function git(cwd: string, ...args: string[]) {
  return (await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'uor-git-тест ')); roots.push(root);
  const remote = join(root, 'remote.git'), seed = join(root, 'seed');
  await exec('git', ['init', '--bare', '--initial-branch=main', remote]);
  await exec('git', ['init', '--initial-branch=main', seed]);
  await mkdir(join(seed, 'catalog', 'goals'), { recursive: true });
  await writeFile(join(seed, 'catalog/goals/a.json'), json({ id: 'a', title: 'Goal A', weight: 1, nested: { target: 80, owner: 'one' }, revision: 'base' }));
  await writeFile(join(seed, 'catalog/goals/b.json'), json({ id: 'b', title: 'Goal B', weight: 1 }));
  await git(seed, 'add', 'catalog');
  await git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Initial synthetic data');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', 'origin', 'main');
  const config = { projectRoot: seed, runtimeRoot: join(root, 'runtime'), url: remote, publishedBranch: 'main', releaseBranch: 'release/current' };
  return { root, remote, seed, config };
}
const actor = { name: 'Demo curator', email: 'curator@localhost' };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('object merge', () => {
  it('combines independent object fields while preserving both authors', () => {
    expect(mergeObject({ weight: 1, owner: 'one' }, { weight: 2, owner: 'one' }, { weight: 1, owner: 'two' }))
      .toEqual({ weight: 2, owner: 'two' });
  });
  it('reports a competing edit of the same field without mutating drafts', () => {
    const base = { nested: { weight: 1 } }, local = { nested: { weight: 2 } }, remote = { nested: { weight: 3 } };
    expect(() => mergeObject(base, local, remote)).toThrow(/nested.weight/);
    expect(local.nested.weight).toBe(2);
    expect(remote.nested.weight).toBe(3);
  });
});

describe('Git publication with independent curator workspaces', () => {
  it('accepts a semantically identical existing object without creating a conflicting rewrite', async () => {
    const f = await fixture(), provider = new GitCliProvider(f.config);
    const main = await provider.readVersion('main');
    const result = await provider.pushChanges({ files: [{ path: 'catalog/goals/a.json', baseContent: null,
      content: '{"title":"Goal A","id":"a","weight":1,"nested":{"owner":"one","target":80},"revision":"base"}' }], actor,
      classification: 'demo', publicationMode: 'demo-only' });
    expect(result.remoteCommit).toBe(main.commit);
  }, 30000);

  it('preserves two concurrent independent goals in release without changing main or project working files', async () => {
    const f = await fixture();
    // Slow receives overlap two real pushes and exercise non-fast-forward retry.
    await writeFile(join(f.remote, 'hooks/pre-receive'), '#!/bin/sh\nsleep 1\nexit 0\n', { mode: 0o755 });
    const first = new GitCliProvider(f.config), second = new GitCliProvider(f.config);
    const baseA = await readFile(join(f.seed, 'catalog/goals/a.json'), 'utf8');
    const baseB = await readFile(join(f.seed, 'catalog/goals/b.json'), 'utf8');
    const beforeMain = await git(f.seed, 'rev-parse', 'HEAD');
    await Promise.all([
      first.pushChanges({ files: [{ path: 'catalog/goals/a.json', baseContent: baseA, content: json({ ...JSON.parse(baseA), weight: 3 }) }], actor,
        classification: 'demo', publicationMode: 'demo-only' }),
      second.pushChanges({ files: [{ path: 'catalog/goals/b.json', baseContent: baseB, content: json({ ...JSON.parse(baseB), title: 'Goal B updated' }) }], actor,
        classification: 'demo', publicationMode: 'demo-only' }),
    ]);
    const released = await first.readVersion('release/current');
    expect(JSON.parse(released.files['catalog/goals/a.json']).weight).toBe(3);
    expect(JSON.parse(released.files['catalog/goals/b.json']).title).toBe('Goal B updated');
    expect((await first.readVersion('main')).commit).toBe(beforeMain);
    expect(await readFile(join(f.seed, 'catalog/goals/a.json'), 'utf8')).toBe(baseA);
    expect(await git(f.seed, 'status', '--porcelain')).toBe('');
  }, 30000);

  it('three-way merges independent fields of one JSON object', async () => {
    const f = await fixture(), provider = new GitCliProvider(f.config);
    const baseContent = await readFile(join(f.seed, 'catalog/goals/a.json'), 'utf8');
    const base = JSON.parse(baseContent);
    await provider.pushChanges({ files: [{ path: 'catalog/goals/a.json', baseContent, content: json({ ...base, weight: 2, revision: 'first' }) }], actor, classification: 'demo', publicationMode: 'demo-only' });
    await provider.pushChanges({ files: [{ path: 'catalog/goals/a.json', baseContent, content: json({ ...base, nested: { ...base.nested, owner: 'two' }, revision: 'second' }) }], actor, classification: 'demo', publicationMode: 'demo-only' });
    expect(JSON.parse((await provider.readVersion('release/current')).files['catalog/goals/a.json']))
      .toMatchObject({ weight: 2, nested: { target: 80, owner: 'two' } });
  }, 30000);

  it('leaves an overlapping local draft intact and rejects conflicting fields', async () => {
    const f = await fixture(), provider = new GitCliProvider(f.config);
    const baseContent = await readFile(join(f.seed, 'catalog/goals/a.json'), 'utf8');
    const base = JSON.parse(baseContent);
    await provider.pushChanges({ files: [{ path: 'catalog/goals/a.json', baseContent, content: json({ ...base, weight: 2 }) }], actor, classification: 'demo', publicationMode: 'demo-only' });
    const local = { path: 'catalog/goals/a.json', baseContent, content: json({ ...base, weight: 3 }) };
    await expect(provider.pushChanges({ files: [local], actor, classification: 'demo', publicationMode: 'demo-only' })).rejects.toThrow(/weight/);
    expect(JSON.parse(local.content).weight).toBe(3);
    expect(JSON.parse((await provider.readVersion('release/current')).files[local.path]).weight).toBe(2);
  }, 30000);

  it('checks updates without applying code and reads only shared data directories', async () => {
    const f = await fixture(), provider = new GitCliProvider(f.config);
    await writeFile(join(f.seed, 'private.txt'), 'Not shared');
    await git(f.seed, 'add', 'private.txt');
    await git(f.seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Non-data file');
    await git(f.seed, 'push', 'origin', 'main');
    const version = await provider.readVersion('main');
    expect(version.files['private.txt']).toBeUndefined();
    expect(Object.keys(version.files)).toHaveLength(2);
    expect((await provider.checkUpdates('main', version.commit)).status).toBe('current');
    expect((await provider.checkUpdates('main', null)).status).toBe('available');
  }, 30000);
});
