import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';
import { createCommandRegistry, type CommandContext } from './command-registry';
import { commitCommandEffect, createCommandStore, withCommandExecution } from './command-store';
import { createJobStore } from './jobs';
import { WorkbenchHttpError } from './protocol';
import type { AccessPolicyService, OwnAccessProfile } from '../../features/identity/workbench-access-policy';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-command-'));
  const config = { filename: path.join(root, 'state.sqlite'), artifactRoot: path.join(root, 'artifacts') };
  const repository = createWorkbenchRepository(config); const clock = { now: () => '2026-10-28T04:20:00Z' };
  cleanup.push(() => { repository.close(); if (!path.basename(root).startsWith('uor-command-')) throw Error('Invalid test root'); rmSync(root, { recursive: true, force: true }); });
  const ownAccess: OwnAccessProfile = { role: 'curator', displayName: 'Demo', personId: fixtureId(9), policyState: 'verified', checkedAt: clock.now() };
  let fresh = 0; const policy: AccessPolicyService = { resolveOwnAccess: async () => ownAccess, assertCommandAllowed: async () => ownAccess, assertFreshPublishAllowed: async () => { fresh++; return ownAccess; } };
  const jobs = createJobStore({ repository, clock }); const registry = createCommandRegistry({ repository, jobs, accessPolicy: policy });
  const context: CommandContext = { repository, clock, ownAccess, requestId: fixtureId(2), commandId: fixtureId(3), installationId: fixtureId(1), actor: makeHeader(1).actor };
  return { config, registry, jobs, context, policy, fresh: () => fresh };
}
it('replays_same_command_and_conflicts_on_changed_payload including concurrent calls', async () => {
  const f = fixture(); let calls = 0;
  f.registry.register({ name: 'demo.local.save', inputSchema: z.strictObject({ value: z.string() }), outputSchema: z.strictObject({ value: z.string() }), capability: 'personal.write', effect: 'local', execution: 'sync', handler: async (ctx, payload) => { calls++; return commitCommandEffect(ctx, () => ({ result: payload, changedRefs: [], editToken: null })); } });
  const command = { commandId: f.context.commandId, name: 'demo.local.save', baseRevision: null, payload: { value: '1' } };
  const [one, two] = await Promise.all([f.registry.execute(command, f.context), f.registry.execute(command, f.context)]);
  expect(one).toEqual(two); expect(calls).toBe(1);
  await expect(f.registry.execute({ ...command, payload: { value: '2' } }, f.context)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
  const reopened = createWorkbenchRepository(f.config); try { const jobs = createJobStore({ repository: reopened, clock: f.context.clock }); const again = createCommandRegistry({ repository: reopened, jobs, accessPolicy: f.policy }); again.register({ name: command.name, inputSchema: z.strictObject({ value: z.string() }), outputSchema: z.strictObject({ value: z.string() }), capability: 'personal.write', effect: 'local', execution: 'sync', handler: async () => { throw Error('Must not execute'); } }); expect(await again.execute(command, { ...f.context, repository: reopened })).toEqual(one); } finally { reopened.close(); }
});
it('rolls back invalid output and replays an atomic receipt after a response failure', async () => {
  const f = fixture(); const sql = f.context.repository.sqlForModule('demo'); sql.execMigration('v1', 'CREATE TABLE wb_demo_values(id TEXT PRIMARY KEY)');
  f.registry.register({ name: 'demo.local.bad', inputSchema: z.strictObject({}), outputSchema: z.strictObject({ good: z.literal(true) }), capability: 'personal.write', effect: 'local', execution: 'sync', handler: async ctx => commitCommandEffect(ctx, () => { sql.run('INSERT INTO wb_demo_values(id) VALUES(?)', ['bad']); return { result: { good: false }, changedRefs: [], editToken: null }; }) });
  await expect(f.registry.execute({ commandId: f.context.commandId, name: 'demo.local.bad', baseRevision: null, payload: {} }, f.context)).rejects.toThrow(); expect(sql.all('SELECT * FROM wb_demo_values')).toEqual([]);
  let called = 0; f.registry.register({ name: 'demo.local.crash', inputSchema: z.strictObject({}), outputSchema: z.strictObject({ good: z.literal(true) }), capability: 'personal.write', effect: 'local', execution: 'sync', handler: async ctx => { called++; commitCommandEffect(ctx, () => ({ result: { good: true }, changedRefs: [], editToken: null })); throw Error('Response lost'); } });
  const request = { commandId: fixtureId(4), name: 'demo.local.crash', baseRevision: null, payload: {} };
  await expect(f.registry.execute(request, { ...f.context, commandId: request.commandId })).rejects.toThrow('Response lost');
  expect(await f.registry.execute(request, { ...f.context, commandId: request.commandId })).toMatchObject({ result: { good: true } }); expect(called).toBe(1);
});
it('queues once and executes a fresh external gate at the actual handler', async () => {
  const f = fixture(); let release!: () => void; const finished = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  f.registry.register({ name: 'package.submit', inputSchema: z.strictObject({}), outputSchema: z.strictObject({ accepted: z.literal(true) }), capability: 'package.submit', effect: 'external', execution: 'async', handler: async () => { calls++; release(); return { result: { accepted: true }, changedRefs: [], editToken: null }; } });
  const request = { commandId: f.context.commandId, name: 'package.submit', baseRevision: null, payload: {} };
  const a = await f.registry.execute(request, f.context); const b = await f.registry.execute(request, f.context); expect(a).toEqual(b); await finished; await f.registry.idle(); expect(calls).toBe(1); expect(f.fresh()).toBeGreaterThan(0);
});
it('preserves an owner-controlled waiting_user auth stage without a fake failure', async () => {
  const f = fixture();
  f.registry.register({ name: 'package.submit', inputSchema: z.strictObject({}), outputSchema: z.strictObject({ ok: z.boolean() }), capability: 'package.submit', effect: 'external', execution: 'async', handler: async ctx => {
    const job = f.jobs.findByCommand(ctx.commandId, ctx.installationId)!;
    f.jobs.update(job.jobId, { status: 'waiting_user', stage: 'git.auth', nextAction: { commandName: 'job.openAuth', payload: { jobId: job.jobId }, route: null, label: 'Open console', enabled: true, disabledReason: null } });
    throw new WorkbenchHttpError(409, 'GIT_AUTH_REQUIRED', 'Native console required');
  } });
  const accepted = await f.registry.execute({ commandId: f.context.commandId, name: 'package.submit', baseRevision: null, payload: {} }, f.context);
  await f.registry.idle(); if (!('jobId' in accepted)) throw Error('Job expected');
  expect(f.jobs.get(accepted.jobId, f.context.installationId)).toMatchObject({ status: 'waiting_user', result: null, error: null, nextAction: { commandName: 'job.openAuth' } });
});
it('serializes retry callbacks through the same resource queue', async () => {
  const f = fixture(); let release!: () => void; let started!: () => void; let retried = false;
  const entered = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  f.registry.register({ name: 'source.capture', inputSchema: z.strictObject({}), outputSchema: z.strictObject({ ok: z.boolean() }), capability: 'capture.local', effect: 'local', execution: 'async', resourceKey: () => 'source:demo', handler: async () => { started(); await gate; return { result: { ok: true }, changedRefs: [], editToken: null }; } });
  const retry = f.jobs.create(fixtureId(8), f.context.installationId, 'source.capture'); f.jobs.update(retry.jobId, { status: 'interrupted' }); f.jobs.setResourceKey(retry.jobId, 'source:demo');
  f.jobs.registerControl(retry.jobId, { retry: async () => { retried = true; f.jobs.complete(retry.jobId, { ok: true }, []); } });
  await f.registry.execute({ commandId: f.context.commandId, name: 'source.capture', baseRevision: null, payload: {} }, f.context); await entered;
  await f.registry.execute({ commandId: fixtureId(7), name: 'job.retry', baseRevision: null, payload: { jobId: retry.jobId } }, { ...f.context, commandId: fixtureId(7) });
  expect(retried).toBe(false); release(); await f.registry.idle(); expect(retried).toBe(true);
});
it('maps invalid command payload to 422 before durable intent', async () => {
  const f = fixture(); f.registry.register({ name: 'fieldMapping.draft.save', inputSchema: z.strictObject({ value: z.string() }), outputSchema: z.strictObject({}), capability: 'uor.prepare', effect: 'sharedDraft', execution: 'sync', handler: async () => ({ result: {}, changedRefs: [], editToken: null }) });
  const before = f.context.repository.getStateRevision();
  await expect(f.registry.execute({ commandId: f.context.commandId, name: 'fieldMapping.draft.save', baseRevision: null, payload: { value: 1 } }, f.context)).rejects.toMatchObject({ statusCode: 422 });
  expect(f.context.repository.getStateRevision()).toBe(before);
});

// These are real durable-intent/accept/commit crash boundaries. No handler or
// scheduler from the first process survives closing and reopening SQLite.
function restartFixture(rows: Array<{ seed: number; installationId?: string; name?: string; resource?: string; status?: 'running' | 'retry_wait'; receipt?: boolean; irreversible?: boolean; checkpoint?: boolean; acceptedEffect?: 'local' | 'external' | 'sharedDraft' | null; acceptedRecovery?: boolean }>, maxConcurrent = 2) {
  const f = fixture(); const store = createCommandStore(f.context.repository);
  const accepted = rows.map(row => {
    const installationId = row.installationId ?? f.context.installationId;
    const request = { commandId: fixtureId(row.seed), name: row.name ?? 'demo.recover', baseRevision: null, payload: { value: String(row.seed) } };
    store.begin(request, installationId);
    const job = f.jobs.create(request.commandId, installationId, request.name);
    store.accept(installationId, request.commandId, job, row.acceptedEffect === null ? undefined : { effect: row.acceptedEffect ?? 'local', queuedRecovery: row.acceptedRecovery === false ? null : 'restart-safe-local' }); f.jobs.setResourceKey(job.jobId, row.resource ?? 'source:durable');
    if (row.status) { f.jobs.update(job.jobId, { status: 'running' }); if (row.status === 'retry_wait') f.jobs.update(job.jobId, { status: 'retry_wait' }); }
    if (row.irreversible) f.jobs.markIrreversible(job.jobId);
    if (row.checkpoint) f.jobs.checkpoint(job.jobId, { stage: 'effect.intent', uncertain: true });
    if (row.receipt) {
      const ctx = { ...f.context, commandId: request.commandId, installationId, actor: { ...f.context.actor, installationId } };
      withCommandExecution(ctx, z.strictObject({ value: z.string() }), () => commitCommandEffect(ctx, () => ({ result: { value: 'durable receipt' }, changedRefs: [], editToken: null })));
    }
    return { request, job };
  });
  f.context.repository.close();
  const repository = createWorkbenchRepository(f.config); cleanup.push(() => repository.close());
  const jobs = createJobStore({ repository, clock: f.context.clock });
  const registry = createCommandRegistry({ repository, jobs, accessPolicy: f.policy, maxConcurrent });
  const resolveContext = async (identity: { commandId: string; installationId: string }) => ({ ...f.context, repository, commandId: identity.commandId, installationId: identity.installationId, actor: { hostname: 'server-after-restart', installationId: identity.installationId, profilePersonId: null } });
  return { ...f, repository, jobs, registry, accepted, resolveContext };
}
const recoveryInput = z.strictObject({ value: z.string() });

it('preserves every foreign recovery lifecycle and receipt until its owning installation starts', async () => {
  const foreignInstallation = fixtureId(2);
  const f = restartFixture([
    { seed: 801, installationId: foreignInstallation }, { seed: 802, installationId: foreignInstallation, receipt: true },
    { seed: 803, installationId: foreignInstallation, status: 'running', receipt: true }, { seed: 804, installationId: foreignInstallation, status: 'running' },
    { seed: 805, installationId: foreignInstallation, status: 'retry_wait' }, { seed: 806 },
  ]);
  const foreignBefore = f.accepted.slice(0, 5).map(({ job }) => f.jobs.get(job.jobId, foreignInstallation));
  let effects = 0;
  const descriptor = { name: 'demo.recover', inputSchema: recoveryInput, outputSchema: recoveryInput, capability: 'personal.write' as const, effect: 'local' as const, execution: 'async' as const, queuedRecovery: 'restart-safe-local' as const, handler: async (ctx: CommandContext, payload: { value: string }) => commitCommandEffect(ctx, () => { effects++; return { result: payload, changedRefs: [], editToken: null }; }) };
  f.registry.register(descriptor);
  await f.registry.recoverPending(fixtureId(1), f.resolveContext); await f.registry.idle();
  expect(effects).toBe(1);
  expect(f.accepted.slice(0, 5).map(({ job }) => f.jobs.get(job.jobId, foreignInstallation))).toEqual(foreignBefore);
  const ownerRegistry = createCommandRegistry({ repository: f.repository, jobs: f.jobs, accessPolicy: f.policy }); ownerRegistry.register(descriptor);
  await ownerRegistry.recoverPending(foreignInstallation, f.resolveContext); await ownerRegistry.idle();
  expect(effects).toBe(2);
  expect(f.accepted.slice(0, 3).map(({ job }) => f.jobs.get(job.jobId, foreignInstallation)?.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  expect(f.accepted.slice(3, 5).map(({ job }) => f.jobs.get(job.jobId, foreignInstallation)?.status)).toEqual(['interrupted', 'interrupted']);
});

it('rolls back startup interruption if recovery stops before committing the requeue decision', async () => {
  const f = restartFixture([{ seed: 701 }]);
  const interruptedStartup = createCommandRegistry({ repository: f.repository, accessPolicy: f.policy, jobs: { ...f.jobs, update(jobId, patch) { if (patch.status === 'queued') throw Error('Process stopped at requeue boundary'); f.jobs.update(jobId, patch); } } });
  interruptedStartup.register({ name: 'demo.recover', inputSchema: recoveryInput, outputSchema: recoveryInput, capability: 'personal.write', effect: 'local', execution: 'async', queuedRecovery: 'restart-safe-local', handler: async (_ctx, payload) => ({ result: payload, changedRefs: [], editToken: null }) });
  await expect(interruptedStartup.recoverPending(fixtureId(1), f.resolveContext)).rejects.toThrow('Process stopped at requeue boundary');
  f.repository.close();
  const repository = createWorkbenchRepository(f.config); cleanup.push(() => repository.close());
  const jobs = createJobStore({ repository, clock: f.context.clock });
  expect(jobs.get(f.accepted[0].job.jobId, f.context.installationId)).toMatchObject({ status: 'queued' });
});

it('persists actual queue acceptance policy so a later process can recover the original queued command', async () => {
  const f = fixture(); const parked = new Promise<never>(() => {});
  f.registry.register({ name: 'demo.recover', inputSchema: recoveryInput, outputSchema: recoveryInput, capability: 'personal.write', effect: 'local', execution: 'async', queuedRecovery: 'restart-safe-local', resourceKey: () => 'source:accepted', handler: async () => parked });
  const firstRequest = { commandId: fixtureId(601), name: 'demo.recover', baseRevision: null, payload: { value: 'running-before-crash' } };
  const nextRequest = { ...firstRequest, commandId: fixtureId(602), payload: { value: 'queued-before-crash' } };
  const first = await f.registry.execute(firstRequest, { ...f.context, commandId: firstRequest.commandId });
  const next = await f.registry.execute(nextRequest, { ...f.context, commandId: nextRequest.commandId });
  if (!('jobId' in first) || !('jobId' in next)) throw Error('Jobs expected');
  expect(f.jobs.get(first.jobId, f.context.installationId)?.status).toBe('running');
  expect(f.jobs.get(next.jobId, f.context.installationId)?.status).toBe('queued');
  // The old process is parked permanently; only the reopened connection runs.
  f.context.repository.close();
  const repository = createWorkbenchRepository(f.config); cleanup.push(() => repository.close());
  const jobs = createJobStore({ repository, clock: f.context.clock }); const registry = createCommandRegistry({ repository, jobs, accessPolicy: f.policy }); let effects = 0;
  registry.register({ name: 'demo.recover', inputSchema: recoveryInput, outputSchema: recoveryInput, capability: 'personal.write', effect: 'local', execution: 'async', queuedRecovery: 'restart-safe-local', handler: async (ctx, payload) => commitCommandEffect(ctx, () => { effects++; return { result: payload, changedRefs: [], editToken: null }; }) });
  await registry.recoverPending(fixtureId(1), async identity => ({ ...f.context, repository, commandId: identity.commandId })); await registry.idle();
  expect(effects).toBe(1);
  expect(jobs.get(first.jobId, f.context.installationId)).toMatchObject({ status: 'interrupted', result: null });
  expect(jobs.get(next.jobId, f.context.installationId)).toMatchObject({ status: 'succeeded', result: { value: 'queued-before-crash' } });
});

it('recovers eligible queued local commands with original identities through the bounded durable-resource queue', async () => {
  const f = restartFixture([{ seed: 101 }, { seed: 102 }, { seed: 103, resource: 'source:other' }]);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const started: CommandContext[] = []; const resolved: string[] = []; let active = 0; let maximum = 0;
  f.registry.register({ name: 'demo.recover', inputSchema: recoveryInput, outputSchema: recoveryInput, capability: 'personal.write', effect: 'local', execution: 'async', queuedRecovery: 'restart-safe-local', resourceKey: () => 'changed-after-restart', handler: async (ctx, payload) => { started.push(ctx); active++; maximum = Math.max(maximum, active); await gate; active--; return commitCommandEffect(ctx, () => ({ result: payload, changedRefs: [], editToken: null })); } });
  const resolver = async (identity: Parameters<typeof f.resolveContext>[0]) => { resolved.push(identity.commandId); return f.resolveContext(identity); };
  await f.registry.recoverPending(fixtureId(1), resolver);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(started.map(ctx => ctx.commandId)).toEqual([fixtureId(101), fixtureId(103)]);
  expect(resolved).toEqual([fixtureId(101), fixtureId(103)]);
  expect(maximum).toBe(2);
  // Access changes while the second same-resource command is queued.
  f.policy.assertCommandAllowed = async () => ({ ...f.context.ownAccess, personId: fixtureId(88) });
  release(); await f.registry.idle();
  expect(started[2]).toMatchObject({ commandId: fixtureId(102), installationId: fixtureId(1), actor: { hostname: 'server-after-restart', profilePersonId: fixtureId(88) } });
  for (const { request, job } of f.accepted) {
    expect(f.jobs.get(job.jobId, fixtureId(1))).toMatchObject({ commandId: request.commandId, status: 'succeeded', error: null, result: request.payload });
    expect(f.jobs.get(job.jobId, fixtureId(2))).toBeNull();
    expect(await f.registry.execute(request, { ...f.context, repository: f.repository, commandId: request.commandId })).toEqual(job);
  }
  await f.registry.recoverPending(fixtureId(1), resolver); await f.registry.idle(); expect(started).toHaveLength(3);
});

it('interrupts uncertain, ineligible and previously running work without replay while recovering every eligible queued job', async () => {
  const f = restartFixture([
    ...Array.from({ length: 61 }, (_, n) => ({ seed: 200 + n, resource: `source:${n}` })),
    { seed: 301, status: 'running' }, { seed: 302, status: 'retry_wait' },
    { seed: 303, name: 'demo.default' }, { seed: 304, name: 'demo.external' }, { seed: 305, name: 'demo.shared' },
    { seed: 306, irreversible: true }, { seed: 307, checkpoint: true },
    { seed: 308, acceptedEffect: 'external' }, { seed: 309, acceptedEffect: 'sharedDraft' }, { seed: 310, acceptedEffect: null }, { seed: 311, acceptedRecovery: false },
  ]);
  let calls = 0;
  for (const [name, effect] of [['demo.recover', 'local'], ['demo.default', 'local'], ['demo.external', 'external'], ['demo.shared', 'sharedDraft']] as const) {
    f.registry.register({ name, inputSchema: recoveryInput, outputSchema: recoveryInput, capability: 'personal.write', effect, execution: 'async', ...(name === 'demo.recover' ? { queuedRecovery: 'restart-safe-local' as const } : {}), handler: async (_ctx, payload) => { calls++; return { result: payload, changedRefs: [], editToken: null }; } });
  }
  await f.registry.recoverPending(fixtureId(1), f.resolveContext); await f.registry.idle();
  expect(calls).toBe(61);
  for (const { job } of f.accepted.slice(61)) expect(f.jobs.get(job.jobId, fixtureId(1))).toMatchObject({ status: 'interrupted', result: null, error: null, retryAvailable: false });
});

it('closes accepted jobs from atomic receipts after restart without reconstructing context or repeating effects', async () => {
  const f = restartFixture([{ seed: 401, receipt: true }, { seed: 402, status: 'running', receipt: true }, { seed: 403, status: 'retry_wait', receipt: true }]);
  // Receipt reconciliation also works without opting into queued replay.
  f.registry.register({ name: 'demo.recover', inputSchema: recoveryInput, outputSchema: recoveryInput, capability: 'personal.write', effect: 'local', execution: 'async', handler: async () => { throw Error('Must not replay committed effect'); } });
  await f.registry.recoverPending(fixtureId(1), async () => { throw Error('Receipt must precede reconstruction'); }); await f.registry.idle();
  for (const { job } of f.accepted) expect(f.jobs.get(job.jobId, fixtureId(1))).toMatchObject({ status: 'succeeded', result: { value: 'durable receipt' }, error: null });
});

it.each(['access', 'capability', 'context', 'schema'] as const)('stops recovered queued work on fresh %s failure before its effect', async failure => {
  const f = restartFixture([{ seed: 501 }]); let effects = 0;
  f.registry.register({ name: 'demo.recover', inputSchema: failure === 'schema' ? z.strictObject({ value: z.literal('new-schema') }) : recoveryInput, outputSchema: recoveryInput, capability: 'uor.prepare', effect: 'local', execution: 'async', queuedRecovery: 'restart-safe-local', handler: async (_ctx, payload) => { effects++; return { result: payload, changedRefs: [], editToken: null }; } });
  if (failure === 'access') f.policy.assertCommandAllowed = async () => { throw new WorkbenchHttpError(403, 'COMMAND_FORBIDDEN', 'Revoked'); };
  if (failure === 'capability') f.policy.assertCommandAllowed = async () => ({ ...f.context.ownAccess, role: 'viewer' });
  await f.registry.recoverPending(fixtureId(1), async identity => ({ ...await f.resolveContext(identity), ...(failure === 'context' ? { installationId: fixtureId(999) } : {}) })); await f.registry.idle();
  expect(effects).toBe(0);
  expect(f.jobs.get(f.accepted[0].job.jobId, fixtureId(1))).toMatchObject({ status: 'failed', result: null, error: { code: failure === 'context' ? 'COMMAND_CONTEXT_MISMATCH' : failure === 'schema' ? 'VALIDATION_FAILED' : 'COMMAND_FORBIDDEN', retryable: false } });
});

it('lets an atomic receipt win when an async handler loses its response after committing', async () => {
  const f = fixture(); let effects = 0;
  f.registry.register({ name: 'demo.responseLost', inputSchema: recoveryInput, outputSchema: recoveryInput, capability: 'personal.write', effect: 'local', execution: 'async', handler: async (ctx, payload) => { commitCommandEffect(ctx, () => { effects++; return { result: payload, changedRefs: [], editToken: null }; }); throw Error('Response lost after local commit'); } });
  const accepted = await f.registry.execute({ commandId: f.context.commandId, name: 'demo.responseLost', baseRevision: null, payload: { value: 'once' } }, f.context); await f.registry.idle();
  if (!('jobId' in accepted)) throw Error('Job expected');
  expect(f.jobs.get(accepted.jobId, f.context.installationId)).toMatchObject({ status: 'succeeded', result: { value: 'once' }, error: null }); expect(effects).toBe(1);
});
