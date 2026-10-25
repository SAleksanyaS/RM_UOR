import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { exportCleanDistribution } from '../../../scripts/clean-distribution.mjs';
import { setupWorkspace } from '../../../scripts/workspace-bootstrap.mjs';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function git(root: string, ...args: string[]) { return (await execute('git', ['-C', root, ...args], { windowsHide: true })).stdout.trim(); }
async function put(root: string, relative: string, text: string) { const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'uor-clean-test-')); roots.push(root);
  await git(root, 'init', '--initial-branch=main'); await git(root, 'config', 'user.name', 'Synthetic Test'); await git(root, 'config', 'user.email', 'synthetic@example.invalid');
  await put(root, 'package.json', '{"name":"uor-dit-operations","version":"0.4.0","private":true}');
  await put(root, 'package-lock.json', '{"lockfileVersion":3}');
  await put(root, 'README.md', '# Synthetic current product');
  await put(root, 'GIGACODE.md', '# Current corporate agent front door');
  await put(root, '.gitignore', '.runtime/\nnode_modules/\n');
  await put(root, '.nvmrc', '22.16.0\n');
  await put(root, '.node-version', '22.16.0\n');
  await put(root, 'src/main.ts', 'export const synthetic = 1;');
  await put(root, 'docs/MASTER_SPEC.md', '# Current specification');
  await put(root, 'docs/VALIDATION.md', '# Current runtime validation');
  await put(root, 'docs/ARCHIVE.md', '# Historical archive reference only');
  await put(root, 'docs/agents/START_HERE.md', '# Current agent instructions');
  await put(root, 'config/site.example.json', '{"publicationMode":"demo-only"}');
  await put(root, 'config/curators.example.json', '[{"name":"Имя Фамилия куратора","code":"REPLACE_WITH_PRIVATE_PASSWORD"}]');
  await put(root, 'catalog/demo.json', '{"classification":"demo"}');
  await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Synthetic baseline');
  return root;
}

describe('clean distribution from the accepted code revision', () => {
  it('exports only allowed committed code and current docs with independently verifiable hashes', async () => {
    // A switch to the working tree, or a broad archive copy, would leak these files.
    const root = await repository();
    for (const [name, value] of Object.entries({ '.runtime/database.sqlite': 'synthetic-private-database', '.env': 'SYNTHETIC_TOKEN=private',
      'config/site.local.json': '{"private":true}', 'config/curators.json': 'synthetic-registry', 'catalog/catalog.json': '{"classification":"corporate"}',
      'node_modules/dependency/index.js': 'synthetic-dependency', 'docs/superpowers/specs/2026-10-25-old.md': 'synthetic-old-plan',
      'docs/verification/old.md': 'synthetic-old-evidence', 'src/client.key': 'synthetic-private-key', 'src/settings.local.json': 'synthetic-local-secret', 'private-input.json': 'synthetic-password-input' })) await put(root, name, value);
    await git(root, 'add', '-f', '.'); await git(root, 'commit', '-m', 'Synthetic excluded paths');
    await put(root, 'src/untracked.ts', 'synthetic-unaccepted-code');
    const expectedCommit = await git(root, 'rev-parse', 'HEAD'), beforeStatus = await git(root, 'status', '--porcelain=v1');
    const result = await exportCleanDistribution({ projectRoot: root });
    const zip = await JSZip.loadAsync(await readFile(result.path));
    const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
    expect(names).toEqual(expect.arrayContaining(['src/main.ts', 'package.json', '.nvmrc', '.node-version', 'catalog/catalog.json', 'GIGACODE.md', 'docs/MASTER_SPEC.md', 'docs/VALIDATION.md', 'docs/ARCHIVE.md', 'docs/agents/START_HERE.md', 'DISTRIBUTION_MANIFEST.json', 'TRANSFER_README.md']));
    expect((await zip.file('.nvmrc')!.async('text')).trim()).toBe('22.16.0');
    expect((await zip.file('.node-version')!.async('text')).trim()).toBe('22.16.0');
    expect(names).not.toEqual(expect.arrayContaining(['src/untracked.ts']));
    expect(names.some(name => /(?:^|\/)(?:\.git|\.runtime|node_modules|\.env)(?:\/|$)|\.local\.|client\.key|superpowers|verification|private-input/.test(name))).toBe(false);
    expect(JSON.parse(await zip.file('catalog/catalog.json')!.async('text'))).toMatchObject({ id: 'uor-blank-v1', goals: [], leaders: [], assignments: [], sources: [], entities: [] });
    const manifest = JSON.parse(await zip.file('DISTRIBUTION_MANIFEST.json')!.async('text'));
    expect(manifest).toMatchObject({ format: 'uor-clean-distribution-v1', commit: expectedCommit, applicationVersion: '0.4.0', includesLocalAccounts: false, generatedBaseline: true });
    expect(result.commit).toBe(expectedCommit); expect(result.privateAccountsPath).toBeUndefined(); expect(result.files).toBe(names.length);
    expect(new Set(manifest.files.map((file: { path: string }) => file.path))).toEqual(new Set(names.filter(name => name !== 'DISTRIBUTION_MANIFEST.json')));
    for (const file of manifest.files) { const bytes = await zip.file(file.path)!.async('nodebuffer'); expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256); expect(bytes.length).toBe(file.bytes); }
    expect(await zip.file('src/main.ts')!.async('text')).toBe('export const synthetic = 1;');
    expect(await git(root, 'status', '--porcelain=v1')).toBe(beforeStatus);
  });

  it('refuses both staged and unstaged tracked changes before creating output', async () => {
    const root = await repository(), output = path.join(root, '.runtime/exports/rejected.zip');
    await put(root, 'src/main.ts', 'export const changed = true;');
    await expect(exportCleanDistribution({ projectRoot: root, outputPath: output })).rejects.toThrow(/незакоммич|отслеживаем/i);
    await git(root, 'add', 'src/main.ts');
    await expect(exportCleanDistribution({ projectRoot: root, outputPath: output })).rejects.toThrow(/незакоммич|отслеживаем/i);
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'src/main.ts'), 'utf8')).toBe('export const changed = true;');
  });

  it('refuses escaping, protected, existing and symlink output paths without overwriting anything', async () => {
    const root = await repository(), output = path.join(root, '.runtime/exports/existing.zip'); await put(root, '.runtime/exports/existing.zip', 'existing-output');
    for (const outputPath of ['../escaped.zip', '.git/export.zip', 'src/export.zip', '.runtime/local-config/export.zip', 'delivery/code:secret.zip', output])
      await expect(exportCleanDistribution({ projectRoot: root, outputPath })).rejects.toThrow();
    expect(await readFile(output, 'utf8')).toBe('existing-output');
    const external = await mkdtemp(path.join(tmpdir(), 'uor-clean-outside-')); roots.push(external);
    await symlink(external, path.join(root, 'linked-export'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(exportCleanDistribution({ projectRoot: root, outputPath: 'linked-export/escaped.zip' })).rejects.toThrow(/ссыл|symbol|path/i);
    await expect(stat(path.join(external, 'escaped.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exports a validated hash registry only to a separately marked private ZIP when explicitly selected', async () => {
    const root = await repository(), registry = [{ id: 'synthetic-curator', name: 'Синтетический куратор', salt: 'a'.repeat(48), hash: 'b'.repeat(128) }];
    await put(root, '.runtime/local-config/curators.json', JSON.stringify(registry));
    await put(root, '.runtime/local-config/provision-input.json', '{"code":"synthetic-plaintext-never-export"}');
    await put(root, '.runtime/browser-profiles/profile/cookies.json', 'synthetic-cookies');
    const result = await exportCleanDistribution({ projectRoot: root, includeLocalAccounts: true });
    expect(result.privateAccountsPath).toMatch(/private-local-accounts\.zip$/);
    const publicZip = await JSZip.loadAsync(await readFile(result.path)), privateZip = await JSZip.loadAsync(await readFile(result.privateAccountsPath!));
    expect(Object.keys(publicZip.files).some(name => /(?:^|\/)curators\.json$|local-config|private-local-accounts/.test(name))).toBe(false);
    expect(await publicZip.file('config/curators.example.json')!.async('text')).toContain('REPLACE_WITH_PRIVATE_PASSWORD');
    const privateNames = Object.keys(privateZip.files).filter(name => !privateZip.files[name].dir).sort();
    expect(privateNames).toEqual(['PRIVATE_MANIFEST.json', 'PRIVATE_README.md', 'local-config/curators.json']);
    expect(JSON.parse(await privateZip.file('local-config/curators.json')!.async('text'))).toEqual(registry);
    const manifest = JSON.parse(await privateZip.file('PRIVATE_MANIFEST.json')!.async('text'));
    expect(manifest).toMatchObject({ format: 'uor-private-local-accounts-v1', private: true, commit: result.commit });
    expect(await privateZip.file('PRIVATE_README.md')!.async('text')).toMatch(/приват|PRIVATE/i);
    expect((await Promise.all(Object.values(privateZip.files).filter(file => !file.dir).map(file => file.async('text')))).join('')).not.toMatch(/synthetic-plaintext-never-export|synthetic-cookies/);
  });

  it('does not require accounts for a public export and rejects missing or malformed selected registries without partial ZIPs', async () => {
    const root = await repository();
    await expect(exportCleanDistribution({ projectRoot: root, outputPath: 'delivery/public.zip' })).resolves.toHaveProperty('path');
    await expect(exportCleanDistribution({ projectRoot: root, outputPath: 'delivery/missing.zip', includeLocalAccounts: true })).rejects.toThrow(/реестр|учёт|account/i);
    await expect(stat(path.join(root, 'delivery/missing.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
    await put(root, '.runtime/local-config/curators.json', JSON.stringify([{ id: 'x', name: 'Synthetic', salt: 'salt', hash: 'b'.repeat(128), code: 'never-export' }]));
    await expect(exportCleanDistribution({ projectRoot: root, outputPath: 'delivery/invalid.zip', includeLocalAccounts: true })).rejects.toThrow(/реестр|учёт|account/i);
    await expect(stat(path.join(root, 'delivery/invalid.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ships the public account placeholder needed to prepare an empty installation from the exported files', async () => {
    const root = await repository(), result = await exportCleanDistribution({ projectRoot: root });
    const extracted = await mkdtemp(path.join(tmpdir(), 'uor-clean-install-')); roots.push(extracted);
    const zip = await JSZip.loadAsync(await readFile(result.path));
    for (const entry of Object.values(zip.files).filter(item => !item.dir)) {
      const filename = path.join(extracted, entry.name); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, await entry.async('nodebuffer'));
    }
    await expect(setupWorkspace({ projectRoot: extracted, mode: 'empty' })).resolves.toMatchObject({ mode: 'empty', publicationMode: 'demo-only' });
    expect(JSON.parse(await readFile(path.join(extracted, '.runtime/imports/catalog.json'), 'utf8')).goals).toEqual([]);
    expect(JSON.parse(await readFile(path.join(extracted, '.runtime/local-config/curators.input.json'), 'utf8'))).toEqual([{ name: 'Имя Фамилия куратора', code: 'REPLACE_WITH_PRIVATE_PASSWORD' }]);
    await expect(stat(path.join(extracted, '.runtime/local-config/curators.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects real credentials substituted into the tracked public placeholder', async () => {
    const root = await repository(); await put(root, 'config/curators.example.json', '[{"name":"Synthetic","code":"not-a-placeholder"}]');
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Synthetic unsafe placeholder');
    await expect(exportCleanDistribution({ projectRoot: root, outputPath: 'delivery/rejected.zip' })).rejects.toThrow(/пример|placeholder/i);
    await expect(stat(path.join(root, 'delivery/rejected.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('includes only the exact empty baseline catalog and refuses symlinks in deliverable source code', async () => {
    const root = await repository(), blank = { schemaVersion: 1, id: 'uor-blank-v1', name: 'Рабочая повестка ДИТ', classification: 'corporate', importedAt: '2026-10-25T00:00:00.000Z', goals: [], leaders: [], assignments: [], sources: [], comments: [], entities: [], directions: [] };
    await put(root, 'catalog/catalog.json', JSON.stringify(blank)); await git(root, 'add', '.'); await git(root, 'commit', '-m', 'Synthetic empty baseline');
    const result = await exportCleanDistribution({ projectRoot: root }), zip = await JSZip.loadAsync(await readFile(result.path));
    expect(JSON.parse(await zip.file('catalog/catalog.json')!.async('text'))).toEqual(blank);
    expect(JSON.parse(await zip.file('DISTRIBUTION_MANIFEST.json')!.async('text')).generatedBaseline).toBe(false);
    // core.symlinks=false permits a real Git symlink blob test on Windows without privileged link creation.
    await git(root, 'config', 'core.symlinks', 'false'); await put(root, 'src/link.ts', '../outside-private');
    const object = await git(root, 'hash-object', '-w', 'src/link.ts');
    await git(root, 'update-index', '--add', '--cacheinfo', `120000,${object},src/link.ts`); await git(root, 'commit', '-m', 'Synthetic unsupported source symlink');
    await expect(exportCleanDistribution({ projectRoot: root, outputPath: 'delivery/symlink.zip' })).rejects.toThrow(/ссыл/i);
  });

  it('preserves an existing adjacent private ZIP and writes no partial public archive', async () => {
    const root = await repository(); await put(root, '.runtime/local-config/curators.json', JSON.stringify([{ id: 'x', name: 'Synthetic', salt: 'salt', hash: 'b'.repeat(128) }]));
    await put(root, 'delivery/code.private-local-accounts.zip', 'existing-private-output');
    await expect(exportCleanDistribution({ projectRoot: root, outputPath: 'delivery/code.zip', includeLocalAccounts: true })).rejects.toThrow(/существ/i);
    await expect(stat(path.join(root, 'delivery/code.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'delivery/code.private-local-accounts.zip'), 'utf8')).toBe('existing-private-output');
  });
});
