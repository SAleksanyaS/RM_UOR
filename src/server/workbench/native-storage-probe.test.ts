import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { hasWorkbenchStorage } from '../../../scripts/code-update-runtime.mjs';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
it('native code update recognizes the active owned root and fails closed for a missing or escaped pointer', async () => {
    const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 't39-probe-'));
    roots.push(root);
    const directory = path.join(root, '.runtime/workbench');
    await mkdir(path.join(directory, 'subject/initial'), { recursive: true });
    const repository = createWorkbenchRepository({ filename: path.join(directory, 'subject/initial/workbench.sqlite'), artifactRoot: path.join(directory, 'subject/initial/files') });
    repository.close();
    await writeFile(path.join(directory, 'active.json'), JSON.stringify({ version: 1, active: 'initial' }));
    expect(await hasWorkbenchStorage(root)).toBe(true);
    for (const active of ['../../elsewhere', 'restore-00000000-0000-4000-8000-000000000000']) {
        await writeFile(path.join(directory, 'active.json'), JSON.stringify({ version: 1, active }));
        await expect(hasWorkbenchStorage(root)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    }
});
