import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';
import { createCommandRegistry, type CommandContext } from './command-registry';
import { commitCommandEffect } from './command-store';
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
