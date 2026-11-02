import { afterEach, expect, it } from 'vitest';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Native release builder is a packaged JavaScript boundary.
import * as releaseBuilder from '../scripts/package-prepared-linux.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// Independently derived from the seven literal fixture entries, not the verifier.
const fixtureDigest = '074286b6b32df366f8d1de950f2147ef654c269a17d1d19a32f8850711dd8953';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'uor-node-inventory-')); roots.push(root);
  for (const name of ['bin', 'lib', 'lib/tool']) { await mkdir(path.join(root, name)); await chmod(path.join(root, name), 0o755); }
  await writeFile(path.join(root, 'bin/node'), 'fixture node\n'); await chmod(path.join(root, 'bin/node'), 0o755);
  await writeFile(path.join(root, 'lib/tool/main.js'), 'export const answer = 42;\n'); await chmod(path.join(root, 'lib/tool/main.js'), 0o644);
  await writeFile(path.join(root, 'lib/tool/.npmrc'), ''); await chmod(path.join(root, 'lib/tool/.npmrc'), 0o644);
  await symlink('../lib/tool/main.js', path.join(root, 'bin/tool'));
  return root;
}
function verify(root: string) {
  expect(releaseBuilder.verifyPreparedRuntime).toBeTypeOf('function');
  return releaseBuilder.verifyPreparedRuntime(root, fixtureDigest) as Promise<{ sha256: string; entries: number; files: number; directories: number; symlinks: number; bytes: number }>;
}

it('accepts every exact entry including dotfiles, directories, executable mode and relative symlink', async () => {
  expect(await verify(await fixture())).toEqual({ sha256: fixtureDigest, entries: 7, files: 3, directories: 3, symlinks: 1, bytes: 39 });
});
it('rejects an added partial executable and preserves its bytes for investigation', async () => {
  const root = await fixture(), extra = path.join(root, 'bin/.node.partial');
  await writeFile(extra, 'fixture'); await chmod(extra, 0o700);
  await expect(verify(root)).rejects.toThrow('does not match');
  expect(await readFile(extra, 'utf8')).toBe('fixture');
});
it.each([
  ['same-length changed executable', async (root: string) => writeFile(path.join(root, 'bin/node'), 'changed node\n')],
  ['missing file', async (root: string) => unlink(path.join(root, 'lib/tool/.npmrc'))],
  ['changed executable mode', async (root: string) => chmod(path.join(root, 'bin/node'), 0o644)],
  ['changed directory mode', async (root: string) => chmod(path.join(root, 'lib/tool'), 0o700)],
  ['changed relative symlink', async (root: string) => { await unlink(path.join(root, 'bin/tool')); await symlink('../lib/tool/.npmrc', path.join(root, 'bin/tool')); }],
  ['file replaced by directory', async (root: string) => { await unlink(path.join(root, 'lib/tool/.npmrc')); await mkdir(path.join(root, 'lib/tool/.npmrc')); }],
] as const)('rejects %s', async (_label, change) => {
  const root = await fixture(); await change(root); await expect(verify(root)).rejects.toThrow('does not match');
});
it('rejects a linked runtime file without following or deleting it', async () => {
  const root = await fixture(); await link(path.join(root, 'bin/node'), path.join(root, 'bin/linked-node'));
  await expect(verify(root)).rejects.toThrow('hard-linked');
  expect(await readFile(path.join(root, 'bin/linked-node'), 'utf8')).toBe('fixture node\n');
});
it('rejects an escaping symlink without reading its target', async () => {
  const root = await fixture(); await unlink(path.join(root, 'bin/tool')); await symlink('../../../not-a-runtime-file', path.join(root, 'bin/tool'));
  await expect(verify(root)).rejects.toThrow('symlink');
});
