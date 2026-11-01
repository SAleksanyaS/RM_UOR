import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRuntimeLease } from './runtime-lease';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse())
    await close(); });
it('one physical workspace admits one native owner and cannot steal a live or malformed lease', async () => {
    const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 't39-lease-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const release = await acquireRuntimeLease(root);
    cleanups.push(release);
    const file = path.join(root, '.runtime/workbench/runtime.lock'), bytes = await readFile(file);
    await expect(acquireRuntimeLease(root)).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' });
    expect(await readFile(file)).toEqual(bytes);
    await release();
    const next = await acquireRuntimeLease(root);
    await next();
    await writeFile(file, 'unrecognized owner');
    await expect(acquireRuntimeLease(root)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await readFile(file, 'utf8')).toBe('unrecognized owner');
});
