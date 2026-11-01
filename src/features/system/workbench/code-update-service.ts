import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Clock, UUIDv4 } from '../../../domain/workbench/primitives';
import type { CommandContext } from '../../../server/workbench/command-registry';
import type { JobStore, JobSink } from '../../../server/workbench/jobs';
import { WorkbenchHttpError, type Problem } from '../../../server/workbench/protocol';
import { gitOidSchema } from '../../publishing/workbench/contracts';
import { CodeUpdateError, inspectCodeUpdate, type CodeUpdateConfig, type CodeUpdateResult } from '../../../../scripts/code-update-runtime.mjs';

type GitOid = string;
export type CodeUpdateInput = { expectedCommit: GitOid; targetCommit: GitOid };
export type CodeUpdateCheckInput = Record<string, never>;
export type CodeUpdateCheckResult = { currentCommit: GitOid; targetCommit: GitOid; available: boolean; launcherAvailable: boolean; warnings: Problem[] };
export type CodeUpdateApplyResult = { currentCommit: GitOid; targetCommit: GitOid; rolledBack: boolean; recoveryRequired: boolean };
export interface CodeUpdateLauncherPort {
  available(): Promise<boolean>;
  request(ticket: { id: UUIDv4; expectedCommit: GitOid; targetCommit: GitOid }): Promise<void>;
  observe(requestId: UUIDv4): Promise<CodeUpdateResult | null>;
}
export type CodeUpdateDependencies = { projectRoot: string; config: CodeUpdateConfig; launcher: CodeUpdateLauncherPort; clock: Clock; jobs: JobStore; jobSink: JobSink };
const inputSchema = z.strictObject({ expectedCommit: gitOidSchema, targetCommit: gitOidSchema });
const resultSchema = z.strictObject({ currentCommit: gitOidSchema, targetCommit: gitOidSchema, rolledBack: z.boolean(), recoveryRequired: z.boolean() });

/** Internal maintenance lifecycle. The frozen command API owns authorization and job registration. */
export class CodeUpdateService {
  constructor(private readonly deps: CodeUpdateDependencies) { deps.jobs.registerStage('code.update'); }
  async check(_context: CommandContext, input: CodeUpdateCheckInput): Promise<CodeUpdateCheckResult> {
    z.strictObject({}).parse(input);
    const preview = await inspectCodeUpdate(this.deps.projectRoot, this.deps.config, { fetchRemote: true });
    return { currentCommit: preview.currentCommit, targetCommit: preview.targetCommit, available: preview.available, launcherAvailable: await this.deps.launcher.available(), warnings: [] };
  }
  async apply(context: CommandContext, input: CodeUpdateInput): Promise<CodeUpdateApplyResult> {
    input = inputSchema.parse(input);
    const { jobs, jobSink, launcher } = this.deps;
    const job = jobs.findByCommand(context.commandId, context.installationId);
    if (!job) throw new WorkbenchHttpError(409, 'JOB_NOT_FOUND', 'Code update requires a registered own job');
    const prior = jobs.checkpoints(job.jobId, context.installationId).filter(value => value.kind === 'code-update-request').at(-1);
    if (prior && (prior.expectedCommit !== input.expectedCommit || prior.targetCommit !== input.targetCommit)) throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Code update job belongs to another preview');
    if (job.result) return resultSchema.parse(job.result);
    const finish = (observed: CodeUpdateResult) => {
      if (observed.targetCommit !== input.targetCommit) throw new WorkbenchHttpError(409, 'INTEGRITY_MISMATCH', 'Launcher result belongs to another target');
      const result = resultSchema.parse({ currentCommit: observed.currentCommit, targetCommit: observed.targetCommit, rolledBack: observed.rolledBack, recoveryRequired: observed.recoveryRequired === true });
      jobSink.complete(job.jobId, result, []);
      return result;
    };
    const existing = await launcher.observe(job.jobId);
    if (existing) return finish(existing);
    if (!prior || prior.dispatchState === 'not_dispatched') {
      if (!await launcher.available()) throw new WorkbenchHttpError(409, 'LAUNCHER_UNAVAILABLE', 'Start the workspace with its launcher');
      await inspectCodeUpdate(this.deps.projectRoot, this.deps.config, { fetchRemote: true, ...input });
      const checkpoint = (dispatchState: 'intent' | 'not_dispatched' | 'potentially_dispatched') => jobSink.checkpoint(job.jobId, { kind: 'code-update-request', requestId: job.jobId, ...input, requestedAt: this.deps.clock.now(), dispatchState });
      // Intent alone is ambiguous after a crash. Only the adapter's proven prewrite rejection permits redispatch.
      checkpoint('intent');
      try { await launcher.request({ id: job.jobId, ...input }); }
      catch (error) {
        checkpoint(error instanceof CodeUpdateError && error.dispatchState === 'not_dispatched' ? 'not_dispatched' : 'potentially_dispatched');
        throw error;
      }
      checkpoint('potentially_dispatched');
    }
    jobSink.stage(job.jobId, 'code.update', { completed: 0, total: null, unit: 'steps' });
    for (let attempt = 0; attempt < 2400; attempt++) {
      const observed = await launcher.observe(job.jobId);
      if (observed) return finish(observed);
      await delay(250);
    }
    throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Launcher outcome is not confirmed; reconcile before another update', [], false, job.jobId);
  }
}
