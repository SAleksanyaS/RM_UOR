import { describe, expect, it } from 'vitest';
import { apiSuccessSchema, commandRequestSchema, globalContextSchema, jobSnapshotSchema, nextActionSchema, problemSchema, queryRequestSchema } from './protocol';

const id = '11111111-1111-4111-8111-111111111111';
const context = { scopePath: { ditId: id, clusterId: null, productId: null, teamId: null }, goalId: null, time: { kind: 'as_of', date: '2026-10-28' }, resultMode: 'current', snapshotId: null };
const problem = { code: 'FAILED', message: 'Failed', retryable: false, details: [], operationId: null, provider: null };
const job = { jobId: id, commandId: id, status: 'queued', stage: 'capture.queued', progress: { completed: 0, total: null, unit: 'rows' }, cancelAvailable: true, retryAvailable: false, result: null, error: null, warnings: [], nextAction: null, startedAt: null, finishedAt: null };

describe('workbench wire protocol', () => {
  it('validates_context_dates_and_job_invariants', () => {
    expect(globalContextSchema.safeParse(context).success).toBe(true);
    expect(globalContextSchema.safeParse({ ...context, scopePath: { ...context.scopePath, productId: id } }).success).toBe(false);
    expect(globalContextSchema.safeParse({ ...context, time: { kind: 'as_of', date: '2026-02-30' } }).success).toBe(false);
    expect(globalContextSchema.safeParse({ ...context, time: { kind: 'period', startInclusive: '2026-10-28', endExclusive: '2026-10-28' } }).success).toBe(false);
    expect(jobSnapshotSchema.safeParse(job).success).toBe(true);
    expect(jobSnapshotSchema.safeParse({ ...job, status: 'partial', result: {}, error: problem, warnings: [problem] }).success).toBe(false);
    expect(jobSnapshotSchema.safeParse({ ...job, status: 'failed' }).success).toBe(false);
    expect(jobSnapshotSchema.safeParse({ ...job, status: 'running', result: {} }).success).toBe(false);
    expect(jobSnapshotSchema.safeParse({ ...job, progress: { completed: -1, total: null, unit: 'rows' } }).success).toBe(false);
    for (const status of ['queued', 'running', 'waiting_user', 'retry_wait', 'interrupted', 'cancelled']) expect(jobSnapshotSchema.safeParse({ ...job, status }).success).toBe(true);
    expect(jobSnapshotSchema.safeParse({ ...job, status: 'succeeded', result: {} }).success).toBe(true);
    expect(jobSnapshotSchema.safeParse({ ...job, status: 'failed', error: problem }).success).toBe(true);
    expect(jobSnapshotSchema.safeParse({ ...job, status: 'partial', result: {}, warnings: [problem] }).success).toBe(true);
    expect(jobSnapshotSchema.safeParse({ ...job, progress: { completed: 5, total: 2, unit: 'rows' } }).success).toBe(false);
    expect(nextActionSchema.safeParse({ commandName: 'job.retry', payload: { jobId: id }, route: null, label: 'Retry', enabled: true, disabledReason: null }).success).toBe(true);
    expect(nextActionSchema.safeParse({ commandName: 'job.retry', payload: [], route: null, label: 'Retry', enabled: true, disabledReason: null }).success).toBe(false);
  });

  it('rejects_untrusted_envelope_keys_and_preserves_wire_defaults', () => {
    const request = { commandId: id, name: 'source.capture', baseRevision: null, payload: { goalId: id } };
    expect(commandRequestSchema.safeParse({ ...request, role: 'chief' }).success).toBe(false);
    expect(commandRequestSchema.safeParse({ ...request, payload: [] }).success).toBe(false);
    expect(queryRequestSchema.parse({ context, filter: {}, sort: [] }).page).toEqual({ limit: 50, cursor: null });
    expect(problemSchema.safeParse({ ...problem, stack: 'private' }).success).toBe(false);
    expect(apiSuccessSchema(problemSchema).safeParse({ apiVersion: '1', requestId: id, data: problem, error: problem, meta: { generatedAt: '2026-10-28T09:00:00Z', publishedCommit: null, stateRevision: 'view:1', warnings: [] } }).success).toBe(false);
  });
});
