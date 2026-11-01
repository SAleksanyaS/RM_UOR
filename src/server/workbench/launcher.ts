import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { createWorkbenchRuntime } from './bootstrap';
import { readJsonFile } from '../../../scripts/code-update-runtime.mjs';
import { assertPhysicalPath } from './files';
const messageSchema = z.object({ type: z.enum(['uor.prepare-code-update', 'uor.release-code-update', 'uor.activate-code-update']), id: z.string().uuid(), requestId: z.string().uuid(), token: z.string().min(1) });
/** IPC is private to the authenticated live launcher. No HTTP maintenance bypass. */
export function attachWorkbenchLauncher(runtime: Awaited<ReturnType<typeof createWorkbenchRuntime>>, app: FastifyInstance, candidate: boolean) {
    let prepared: {
        requestId: string;
        promise: ReturnType<typeof runtime.prepareUpdate>;
    } | null = null;
    let activated = false;
    const listener = async (raw: unknown) => {
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success)
            return;
        const message = parsed.data, directory = path.join(runtime.projectRoot, '.runtime', 'code-update');
        try {
            await assertPhysicalPath(directory, true);
            const marker = await readJsonFile<{
                root: string;
                pid: number;
                token: string;
            }>(path.join(directory, 'launcher.json'));
            if (!marker || marker.root !== runtime.projectRoot || marker.pid !== process.ppid || marker.token !== message.token || marker.token !== process.env.UOR_UPDATE_LAUNCHER_TOKEN)
                return;
            if (message.type === 'uor.activate-code-update') {
                if (!candidate)
                    throw Error('This is not a closed candidate');
                const active = await readJsonFile<{
                    phase: string;
                    requestId: string;
                }>(path.join(directory, 'active.json'));
                if (active?.phase !== 'committed' || active.requestId !== message.requestId)
                    throw Error('The durable commitpoint does not match this activation');
                if (!activated) {
                    await runtime.activate(app);
                    activated = true;
                }
                process.send?.({ type: 'uor.update-prepared', id: message.id, ok: true });
            }
            else if (message.type === 'uor.release-code-update') {
                if (prepared?.requestId === message.requestId) {
                    await prepared.promise.catch(() => { });
                    prepared = null;
                    await runtime.releaseUpdate();
                }
                process.send?.({ type: 'uor.update-prepared', id: message.id, ok: true });
            }
            else {
                if (prepared && prepared.requestId !== message.requestId)
                    throw Error('A different update owns maintenance');
                prepared ??= { requestId: message.requestId, promise: runtime.prepareUpdate(message.requestId) };
                try {
                    const workspaceBackup = await prepared.promise;
                    process.send?.({ type: 'uor.update-prepared', id: message.id, ok: true, workspaceBackup });
                }
                catch (error) {
                    prepared = null;
                    await runtime.releaseUpdate();
                    throw error;
                }
            }
        }
        catch (error) {
            process.send?.({ type: 'uor.update-prepared', id: message.id, ok: false, retryable: false, message: error instanceof Error ? error.message : 'Update preparation failed' });
        }
    };
    process.on('message', listener);
    return () => process.off('message', listener);
}
