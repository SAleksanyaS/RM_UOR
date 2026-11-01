import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertPhysicalPath } from './files';
import { WorkbenchHttpError } from './protocol';
const ownerSchema = z.strictObject({ version: z.literal(1), root: z.string(), pid: z.number().int().positive(), token: z.string().uuid() });
const busy = () => new WorkbenchHttpError(409, 'WORKSPACE_BUSY', 'Another process owns this workspace');
const recovery = () => new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'The workspace process lease cannot be verified');
function alive(pid: number) { try {
    process.kill(pid, 0);
    return true;
}
catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
} }
/** Cross-process counterpart of the in-process maintenance gate. Never steals a live owner. */
export async function acquireRuntimeLease(inputRoot: string): Promise<() => Promise<void>> {
    const root = await realpath(inputRoot);
    await assertPhysicalPath(root, true);
    for (const directory of [path.join(root, '.runtime'), path.join(root, '.runtime/workbench')]) {
        await mkdir(directory, { recursive: true });
        await assertPhysicalPath(directory, true);
    }
    const file = path.join(root, '.runtime/workbench/runtime.lock'), value = JSON.stringify({ version: 1, root, pid: process.pid, token: randomUUID() });
    const create = async () => { const handle = await open(file, 'wx', 0o600); try {
        await handle.writeFile(value);
        await handle.sync();
    }
    finally {
        await handle.close();
    } };
    try {
        await create();
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
            throw error;
        await assertPhysicalPath(file, false);
        const prior = await readFile(file, 'utf8');
        let owner: z.infer<typeof ownerSchema>;
        try {
            owner = ownerSchema.parse(JSON.parse(prior));
        }
        catch {
            throw recovery();
        }
        if (owner.root !== root)
            throw recovery();
        if (alive(owner.pid))
            throw busy();
        const recoveryFile = path.join(root, '.runtime/workbench/runtime-recovery.lock');
        let guard;
        try {
            guard = await open(recoveryFile, 'wx', 0o600);
        }
        catch {
            throw recovery();
        }
        try {
            await guard.writeFile(value);
            await guard.sync();
            await assertPhysicalPath(file, false);
            if (await readFile(file, 'utf8') !== prior || alive(owner.pid))
                throw busy();
            await unlink(file);
            await create();
        }
        finally {
            await guard.close();
            await unlink(recoveryFile);
        }
    }
    let released = false;
    return async () => { if (released)
        return; await assertPhysicalPath(file, false); if (await readFile(file, 'utf8') !== value)
        throw recovery(); await unlink(file); released = true; };
}
