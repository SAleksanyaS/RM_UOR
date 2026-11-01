import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbenchRuntime } from './bootstrap';
import { prepareRuntimeStorage } from './runtime-storage';
import { startProductionEntry } from './testing/production-entry';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse()) await action(); });
async function fixture() {
    const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 't39-startup-fix-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, 'config/site.local.json'), JSON.stringify({ allowedWorkspaceRoots: [root] }));
    return root;
}
it('refuses a missing active database without recreating it or changing retained identity/history', async () => {
    const root = await fixture(), runtime = await createWorkbenchRuntime({ projectRoot: root });
    const database = path.join(await runtime.services.archive.workspace!.activeRoot(), 'workbench.sqlite');
    await runtime.close();
    const bytes = await readFile(database), metadata = path.join(root, '.runtime/workbench');
    const pointer = await readFile(path.join(metadata, 'active.json')), identity = await readFile(path.join(metadata, 'identity.json'));
    await rename(database, database + '.retained');
    await expect(startProductionEntry({ root, codeRoot: process.cwd() })).rejects.toThrow('managed active database is missing or invalid');
    await expect(createWorkbenchRuntime({ projectRoot: root }).then(async unexpected => { await unexpected.close(); })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(readFile(database)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(database + '.retained')).toEqual(bytes);
    expect(await readFile(path.join(metadata, 'active.json'))).toEqual(pointer);
    expect(await readFile(path.join(metadata, 'identity.json'))).toEqual(identity);
});
it.each(['identity-only', 'corrupted-database'] as const)('preserves %s state and refuses a replacement history', async fault => {
    const root = await fixture(), runtime = await createWorkbenchRuntime({ projectRoot: root });
    const database = path.join(await runtime.services.archive.workspace!.activeRoot(), 'workbench.sqlite');
    await runtime.close();
    const metadata = path.join(root, '.runtime/workbench'), identity = await readFile(path.join(metadata, 'identity.json'));
    await rename(database, database + '.retained');
    if (fault === 'identity-only') await rename(path.join(metadata, 'active.json'), path.join(metadata, 'active.retained.json'));
    else await writeFile(database, 'synthetic corrupt database');
    await expect(createWorkbenchRuntime({ projectRoot: root }).then(async unexpected => { await unexpected.close(); })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await readFile(path.join(metadata, 'identity.json'))).toEqual(identity);
    if (fault === 'identity-only') {
        await expect(readFile(database)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(path.join(metadata, 'active.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } else expect(await readFile(database, 'utf8')).toBe('synthetic corrupt database');
});
it.each(['after-database', 'after-identity'] as const)('publishes the initial pointer only after a real database exists and refuses interruption %s', async interruption => {
    const root = await fixture(), options = { localPreview: true, repositoryId: 'synthetic', applicationVersion: '0.5.0', clock: { now: () => '2026-11-01T10:00:00Z' } };
    const prepared = await prepareRuntimeStorage(root, options); await prepared.releaseLease();
    const database = path.join(prepared.activeRoot, 'workbench.sqlite'), bytes = await readFile(database);
    expect(bytes.subarray(0, 15).toString()).toBe('SQLite format 3');
    if (interruption === 'after-database') await rename(path.join(prepared.runtimeRoot, 'identity.json'), path.join(prepared.runtimeRoot, 'identity.retained.json'));
    await rename(path.join(prepared.runtimeRoot, 'active.json'), path.join(prepared.runtimeRoot, 'active.retained.json'));
    await expect(prepareRuntimeStorage(root, options)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await readFile(database)).toEqual(bytes);
    await expect(readFile(path.join(prepared.runtimeRoot, 'active.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
