import { commandDigest, createCommandStore } from './command-store';
import { commandRequestSchema, WorkbenchHttpError } from './protocol';
import type { WorkbenchRepository } from '../storage/workbench-repository';
import type { JobStore } from './jobs';
import type { AccessPolicyService } from '../../features/identity/workbench-access-policy';
import type { CodeUpdateLauncherPort } from '../../features/system/workbench/code-update-service';
import { CodeUpdateError } from '../../../scripts/code-update-runtime.mjs';
/** Reconciles only an existing accepted local update. It never dispatches or resumes external work. */
export function createCodeUpdateRecovery(options: {
    repository: WorkbenchRepository;
    jobs: JobStore;
    installationId: string;
    accessPolicy: AccessPolicyService;
    launcher: CodeUpdateLauncherPort;
}) {
    const { repository, jobs, installationId, accessPolicy, launcher } = options, store = createCommandStore(repository);
    let timer: ReturnType<typeof setInterval> | null = null, pending: Promise<void> | null = null;
    const reconcile = async () => {
        for (const candidate of jobs.recoveryCandidates(installationId).filter(row => row.name === 'code.update.apply')) {
            const own = await accessPolicy.resolveOwnAccess(), intent = store.get(installationId, candidate.snapshot.commandId);
            if (!intent || intent.owner_scope === 'person' && intent.owner_person_id !== own.personId)
                continue;
            store.assertAccess(installationId, candidate.snapshot.commandId, own.personId);
            if (!intent?.accepted_json)
                continue;
            const request = commandRequestSchema.parse(JSON.parse(intent.request_json));
            if (request.name !== 'code.update.apply' || request.commandId !== candidate.snapshot.commandId || commandDigest(request) !== intent.digest || JSON.parse(intent.accepted_json).jobId !== candidate.snapshot.jobId)
                throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Code update receipt does not match its accepted command');
            let observed;
            try {
                observed = await launcher.observe(candidate.snapshot.jobId);
            }
            catch (error) {
                if (!(error instanceof CodeUpdateError) || error.code === 'RECOVERY_REQUIRED')
                    throw error;
                const fresh = await accessPolicy.resolveOwnAccess();
                if (fresh.personId !== own.personId)
                    continue;
                store.assertAccess(installationId, request.commandId, fresh.personId);
                repository.transaction(() => { store.fail(installationId, request.commandId); jobs.fail(candidate.snapshot.jobId, { code: error.code, message: error.message, retryable: false, details: [], operationId: candidate.snapshot.jobId, provider: null }); });
                continue;
            }
            if (!observed)
                continue;
            const fresh = await accessPolicy.resolveOwnAccess();
            if (fresh.personId !== own.personId)
                continue;
            store.assertAccess(installationId, request.commandId, fresh.personId);
            if (observed.targetCommit !== request.payload.targetCommit || observed.currentCommit !== (observed.rolledBack ? request.payload.expectedCommit : request.payload.targetCommit))
                throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Code update terminal result does not match its commits');
            const result = { currentCommit: observed.currentCommit, targetCommit: observed.targetCommit, rolledBack: observed.rolledBack, recoveryRequired: observed.recoveryRequired === true };
            repository.transaction(() => { const latest = jobs.get(candidate.snapshot.jobId, installationId); if (!latest || ['succeeded', 'partial', 'failed', 'cancelled'].includes(latest.status))
                return; if (latest.status !== 'running')
                jobs.update(latest.jobId, { status: 'running', stage: 'running' }); store.receipt(installationId, request.commandId, { result, changedRefs: [], editToken: null }); jobs.complete(latest.jobId, result, []); });
        }
    };
    const tick = () => { if (!pending)
        pending = reconcile().finally(() => { pending = null; }); return pending; };
    return { reconcile: tick, start() { if (timer)
            return; timer = setInterval(() => { void tick().catch(error => { console.error('Code update reconciliation requires recovery:', error instanceof Error ? error.message : 'unknown failure'); }); }, 500); timer.unref(); }, async pause() { if (timer) {
            clearInterval(timer);
            timer = null;
        } await pending?.catch(() => { }); } };
}
