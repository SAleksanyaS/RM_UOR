import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAcceptedGitRegistry } from './oko-registry';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('uor-oko-registry-')) throw Error('Unsafe fixture cleanup'); rmSync(root, { recursive: true, force: true }); } });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
it('reads the accepted remote commit, ignores working-tree role edits and refreshes revocations', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uor-oko-registry-')); roots.push(root);
  const remote = path.join(root, 'remote.git'), admin = path.join(root, 'admin'), checkout = path.join(root, 'checkout'); mkdirSync(admin);
  git(root, 'init', '--bare', remote); git(admin, 'init', '-b', 'main');
  const policy = (enabled: boolean) => ({ schemaVersion: 1, profiles: [{ hostname: 'synthetic-host', displayName: 'Synthetic curator', personId: '00000000-0000-4000-8000-000000000001', role: 'curator', enabled }], serviceSettings: {} });
  const save = (enabled: boolean) => { writeFileSync(path.join(admin, 'registry.json'), JSON.stringify(policy(enabled))); git(admin, 'add', 'registry.json'); git(admin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', enabled ? 'allow' : 'revoke'); };
  save(true); git(admin, 'remote', 'add', 'origin', remote); git(admin, 'push', '-u', 'origin', 'main'); git(root, 'clone', '-b', 'main', remote, checkout);
  writeFileSync(path.join(checkout, 'registry.json'), JSON.stringify({ fake: 'uncommitted grant' }));
  const registry = createAcceptedGitRegistry({ checkout, expectedRemote: remote, acceptedBranch: 'main', registryPath: 'registry.json' });
  const accepted = await registry.readAccepted(); expect(accepted.commit).toMatch(/^[a-f0-9]{40}$/); expect(accepted.value).toEqual(policy(true));
  save(false); git(admin, 'push', 'origin', 'main'); expect((await registry.readAccepted()).value).toEqual(policy(false));
  await expect(createAcceptedGitRegistry({ checkout, expectedRemote: 'https://different.invalid/registry.git', acceptedBranch: 'main', registryPath: 'registry.json' }).readAccepted()).rejects.toMatchObject({ kind: 'invalid' });
});

it('rejects unsafe refs and paths without invoking a shell', () => {
  const base = { checkout: path.resolve('synthetic'), expectedRemote: 'https://registry.example.invalid/policy.git', acceptedBranch: 'main', registryPath: 'registry.json' };
  for (const acceptedBranch of ['--upload-pack=malicious', '../main', 'main:other', 'main\nother']) expect(() => createAcceptedGitRegistry({ ...base, acceptedBranch })).toThrow();
  for (const registryPath of ['../secret', '/absolute', 'a:b', 'a\\b']) expect(() => createAcceptedGitRegistry({ ...base, registryPath })).toThrow();
});
