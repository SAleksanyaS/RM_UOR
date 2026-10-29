import type { Clock } from '../../domain/workbench/primitives';
import { newUuid, uuidSchema } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../storage/workbench-repository';
import { jobSnapshotSchema, problemSchema, WorkbenchHttpError } from './protocol';
import type { JobAccepted, JobSnapshot, JobStatus, Problem } from './protocol';

export type JobPatch = Partial<Omit<JobSnapshot, 'jobId' | 'commandId'>>;
export type JobControl = { cancel?: () => Promise<void>; retry?: () => Promise<void>; openAuth?: () => Promise<void> };
export type JobRecoveryCandidate = { snapshot: JobSnapshot; installationId: string; name: string; resourceKey: string | null; irreversible: boolean; hasCheckpoints: boolean };
export interface JobSink { stage(jobId: string, stage: string, progress: JobSnapshot['progress']): void; checkpoint(jobId: string, value: Record<string, unknown>): void; complete(jobId: string, result: unknown, warnings: Problem[]): void; fail(jobId: string, error: Problem): void }
export interface JobStore extends JobSink {
  create(commandId: string, installationId: string, name: string): JobAccepted;
  get(jobId: string, installationId: string): JobSnapshot | null;
  findByCommand(commandId: string, installationId: string): JobSnapshot | null;
  update(jobId: string, patch: JobPatch): void;
  recoverInterrupted(installationId?: string): void;
  recoveryCandidates(installationId?: string): JobRecoveryCandidate[];
  registerStage(stage: string): void;
  registerControl(jobId: string, control: JobControl): void;
  markIrreversible(jobId: string): void;
  checkpoints(jobId: string, installationId: string): Record<string, unknown>[];
  cancel(jobId: string, installationId: string): Promise<void>;
  retry(jobId: string, installationId: string, beforeStart?: () => Promise<void>): Promise<JobAccepted>;
  openAuth(jobId: string, installationId: string): Promise<void>;
  name(jobId: string, installationId: string): string | null;
  setResourceKey(jobId: string, resourceKey: string): void;
  getResourceKey(jobId: string, installationId: string): string | null;
  setScheduler(schedule: (resource: string, run: () => Promise<void>) => Promise<void>): void;
}
const terminal = new Set<JobStatus>(['succeeded', 'partial', 'failed', 'cancelled']);
const transitions: Record<JobStatus, JobStatus[]> = { queued: ['running', 'cancelled', 'interrupted', 'failed'], running: ['waiting_user', 'retry_wait', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted'], waiting_user: ['queued', 'running', 'cancelled', 'interrupted', 'failed', 'retry_wait'], retry_wait: ['queued', 'running', 'cancelled', 'interrupted', 'failed'], interrupted: ['queued', 'running', 'cancelled', 'failed', 'waiting_user'], succeeded: [], partial: [], failed: [], cancelled: [] };
export function createJobStore({ repository, clock }: { repository: WorkbenchRepository; clock: Clock }): JobStore {
  const sql = repository.sqlForModule('jobs');
  sql.execMigration('v1', `CREATE TABLE wb_jobs_heads(job_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,command_id TEXT NOT NULL,name TEXT NOT NULL,snapshot_json TEXT NOT NULL,irreversible INTEGER NOT NULL DEFAULT 0,resource_key TEXT,UNIQUE(installation_id,command_id));
    CREATE TABLE wb_jobs_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
    CREATE TABLE wb_jobs_checkpoints(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,value_json TEXT NOT NULL)`);
  sql.execMigration('v2-checkpoint-lookup', 'CREATE INDEX wb_jobs_checkpoint_job ON wb_jobs_checkpoints(job_id)');
  const stages = new Set(['queued', 'running', 'interrupted', 'completed', 'failed', 'cancelled', 'git.auth']); const controls = new Map<string, JobControl>();
  let scheduler: ((resource: string, run: () => Promise<void>) => Promise<void>) | null = null;
  const raw = (id: string) => sql.get<{ installation_id: string; name: string; snapshot_json: string; irreversible: number; resource_key: string | null }>('SELECT installation_id,name,snapshot_json,irreversible,resource_key FROM wb_jobs_heads WHERE job_id=?', [id]);
  const owned = (id: string, installationId: string) => { const row = raw(id); if (!row || row.installation_id !== installationId) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found'); return { ...row, snapshot: jobSnapshotSchema.parse(JSON.parse(row.snapshot_json)) }; };
  const save = (snapshot: JobSnapshot) => { sql.run('UPDATE wb_jobs_heads SET snapshot_json=? WHERE job_id=?', [JSON.stringify(snapshot), snapshot.jobId]); sql.run('INSERT INTO wb_jobs_events(job_id,snapshot_json,recorded_at) VALUES(?,?,?)', [snapshot.jobId, JSON.stringify(snapshot), clock.now()]); };
  const store: JobStore = {
    create(commandId, installationId, name) {
      uuidSchema.parse(commandId); uuidSchema.parse(installationId);
      return repository.transaction(() => {
        const existing = store.findByCommand(commandId, installationId); if (existing) return { jobId: existing.jobId, status: 'queued', pollAfterMs: 1000 };
        const snapshot: JobSnapshot = { jobId: newUuid(), commandId, status: 'queued', stage: 'queued', progress: { completed: 0, total: null, unit: 'steps' }, cancelAvailable: false, retryAvailable: false, result: null, error: null, warnings: [], nextAction: null, startedAt: null, finishedAt: null };
        sql.run('INSERT INTO wb_jobs_heads(job_id,installation_id,command_id,name,snapshot_json) VALUES(?,?,?,?,?)', [snapshot.jobId, installationId, commandId, name, JSON.stringify(snapshot)]); save(snapshot); return { jobId: snapshot.jobId, status: 'queued', pollAfterMs: 1000 };
      });
    },
    get(jobId, installationId) { const row = raw(jobId); return row?.installation_id === installationId ? jobSnapshotSchema.parse(JSON.parse(row.snapshot_json)) : null; },
    findByCommand(commandId, installationId) { const row = sql.get<{ snapshot_json: string }>('SELECT snapshot_json FROM wb_jobs_heads WHERE installation_id=? AND command_id=?', [installationId, commandId]); return row ? jobSnapshotSchema.parse(JSON.parse(row.snapshot_json)) : null; },
    update(jobId, patch) { repository.transaction(() => {
      const row = raw(jobId); if (!row) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found'); const previous = jobSnapshotSchema.parse(JSON.parse(row.snapshot_json));
      const nextStatus = patch.status ?? previous.status;
      if (nextStatus !== previous.status && !transitions[previous.status].includes(nextStatus)) throw new WorkbenchHttpError(409, 'JOB_STATE_CONFLICT', 'Job cannot enter this state');
      if (terminal.has(previous.status)) throw new WorkbenchHttpError(409, 'JOB_FINISHED', 'Job has finished');
      if (patch.stage && !stages.has(patch.stage)) throw new WorkbenchHttpError(422, 'JOB_STAGE_UNREGISTERED', 'Stage is not registered');
      const next = jobSnapshotSchema.parse({ ...previous, ...patch, jobId: previous.jobId, commandId: previous.commandId, startedAt: previous.startedAt ?? (nextStatus === 'running' ? clock.now() : null), finishedAt: terminal.has(nextStatus) ? clock.now() : null, ...(terminal.has(nextStatus) ? { cancelAvailable: false, retryAvailable: false, nextAction: null } : {}) });
      if (JSON.stringify(previous) !== JSON.stringify(next)) save(next);
      if (terminal.has(next.status)) controls.delete(jobId);
    }); },
    registerStage(stage) { if (!/^[a-z][a-z0-9_.:-]*$/.test(stage)) throw new WorkbenchHttpError(422, 'INVALID_STAGE', 'Invalid stage'); stages.add(stage); },
    stage(jobId, stage, progress) { store.update(jobId, { stage, progress }); },
    checkpoint(jobId, value) { if (!raw(jobId)) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found'); sql.run('INSERT INTO wb_jobs_checkpoints(job_id,value_json) VALUES(?,?)', [jobId, JSON.stringify(value)]); },
    checkpoints(jobId, installationId) { owned(jobId, installationId); return sql.all<{ value_json: string }>('SELECT value_json FROM wb_jobs_checkpoints WHERE job_id=? ORDER BY sequence', [jobId]).map(row => JSON.parse(row.value_json)); },
    complete(jobId, result, warnings) { store.update(jobId, { status: warnings.length ? 'partial' : 'succeeded', stage: 'completed', result: result as Record<string, unknown>, error: null, warnings }); },
    fail(jobId, error) { store.update(jobId, { status: 'failed', stage: 'failed', result: null, error: problemSchema.parse(error) }); },
    recoverInterrupted(installationId) { const rows = sql.all<{ job_id: string; snapshot_json: string }>('SELECT job_id,snapshot_json FROM wb_jobs_heads' + (installationId === undefined ? '' : ' WHERE installation_id=?'), installationId === undefined ? [] : [uuidSchema.parse(installationId)]); repository.transaction(() => { for (const row of rows) { const job = jobSnapshotSchema.parse(JSON.parse(row.snapshot_json)); if (['queued', 'running', 'retry_wait'].includes(job.status)) store.update(row.job_id, { status: 'interrupted', stage: 'interrupted', result: null, error: null, retryAvailable: false, cancelAvailable: false, nextAction: null }); } }); },
    recoveryCandidates(installationId) {
      return sql.all<{ installation_id: string; name: string; resource_key: string | null; irreversible: number; snapshot_json: string; has_checkpoints: number }>(`SELECT installation_id,name,resource_key,irreversible,snapshot_json,EXISTS(SELECT 1 FROM wb_jobs_checkpoints c WHERE c.job_id=h.job_id) AS has_checkpoints FROM wb_jobs_heads h WHERE json_extract(snapshot_json,'$.status') NOT IN ('succeeded','partial','failed','cancelled')` + (installationId === undefined ? '' : ' AND installation_id=?'), installationId === undefined ? [] : [uuidSchema.parse(installationId)]).map(row => ({ snapshot: jobSnapshotSchema.parse(JSON.parse(row.snapshot_json)), installationId: row.installation_id, name: row.name, resourceKey: row.resource_key, irreversible: !!row.irreversible, hasCheckpoints: !!row.has_checkpoints }));
    },
    registerControl(jobId, control) { const row = raw(jobId); if (!row) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found'); const snapshot = jobSnapshotSchema.parse(JSON.parse(row.snapshot_json)); if (!terminal.has(snapshot.status)) { const merged = { ...controls.get(jobId), ...control }; controls.set(jobId, merged); store.update(jobId, { cancelAvailable: !!merged.cancel && !row.irreversible, retryAvailable: !!merged.retry }); } },
    markIrreversible(jobId) { repository.transaction(() => { if (!raw(jobId)) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found'); sql.run('UPDATE wb_jobs_heads SET irreversible=1 WHERE job_id=?', [jobId]); store.update(jobId, { cancelAvailable: false }); }); },
    async cancel(jobId, installationId) { const row = owned(jobId, installationId); const action = controls.get(jobId)?.cancel; if (row.irreversible || !row.snapshot.cancelAvailable || !action) throw new WorkbenchHttpError(409, 'CANCEL_NOT_AVAILABLE', 'Cancellation is unavailable'); await action(); store.update(jobId, { status: 'cancelled', stage: 'cancelled', result: null, error: null }); },
    async retry(jobId, installationId, beforeStart) {
      const row = owned(jobId, installationId); const action = controls.get(jobId)?.retry;
      if (!scheduler || !row.snapshot.retryAvailable || !action || !['interrupted', 'waiting_user', 'retry_wait'].includes(row.snapshot.status)) throw new WorkbenchHttpError(409, 'RETRY_NOT_AVAILABLE', 'Retry requires reconciliation');
      store.update(jobId, { status: 'queued', stage: 'queued', retryAvailable: false });
      void scheduler(row.resource_key ?? row.name, async () => {
        try { await beforeStart?.(); store.update(jobId, { status: 'running', stage: 'running' }); await action(); }
        catch (error) { const latest = store.get(jobId, installationId); if (latest && !terminal.has(latest.status) && !['waiting_user', 'retry_wait', 'interrupted'].includes(latest.status)) store.fail(jobId, { code: error instanceof WorkbenchHttpError ? error.code : 'RETRY_FAILED', message: 'Retry did not complete', retryable: false, details: [], operationId: jobId, provider: null }); }
      }).catch(() => undefined);
      return { jobId, status: 'queued', pollAfterMs: 1000 };
    },
    async openAuth(jobId, installationId) { const row = owned(jobId, installationId); const action = controls.get(jobId)?.openAuth; if (row.snapshot.status !== 'waiting_user' || !action) throw new WorkbenchHttpError(409, 'AUTH_NOT_AVAILABLE', 'Authentication action unavailable'); await action(); },
    name(jobId, installationId) { const row = raw(jobId); return row?.installation_id === installationId ? row.name : null; },
    setResourceKey(jobId, resourceKey) { if (!raw(jobId)) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found'); sql.run('UPDATE wb_jobs_heads SET resource_key=? WHERE job_id=?', [resourceKey, jobId]); },
    getResourceKey(jobId, installationId) { const row = raw(jobId); return row?.installation_id === installationId ? row.resource_key : null; },
    setScheduler(schedule) { scheduler = schedule; },
  };
  return store;
}
