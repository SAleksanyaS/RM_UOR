import { inspectCodeUpdate, type CodeUpdateConfig } from '../../../../scripts/code-update-runtime.mjs';
export type UpdateCandidate = {
    channel: 'code';
    expectedCommit: string;
    targetCommit: string;
    available: boolean;
    launcherAvailable: boolean;
};
export interface UpdateProvider {
    check(signal?: AbortSignal): Promise<UpdateCandidate>;
}
/** Native Git owns origin/ref/exact-head/ancestry/dirty validation. This adapter never activates or publishes. */
export function createNativeUpdateProvider(options: {
    projectRoot: string;
    config: CodeUpdateConfig;
    launcherAvailable: () => Promise<boolean>;
}): UpdateProvider {
    let checking: Promise<UpdateCandidate> | null = null;
    return { async check(signal) { signal?.throwIfAborted(); if (!checking)
            checking = (async () => { const p = await inspectCodeUpdate(options.projectRoot, options.config, { fetchRemote: true }); return { channel: 'code' as const, expectedCommit: p.currentCommit, targetCommit: p.targetCommit, available: p.available, launcherAvailable: await options.launcherAvailable() }; })().finally(() => { checking = null; }); const value = await checking; signal?.throwIfAborted(); return value; } };
}
