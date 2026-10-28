import type { z } from 'zod';
import type { ActorRef, Clock, EntityRef } from '../../domain/workbench/primitives';
import { actorRefSchema, uuidSchema } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../storage/workbench-repository';
import { canUseCapability } from '../../features/identity/workbench-access-policy';
import type { AccessPolicyService, Capability, OwnAccessProfile } from '../../features/identity/workbench-access-policy';
import { commandRequestSchema, commandResultSchema, fieldProblems, WorkbenchHttpError } from './protocol';
import type { CommandRequest, CommandResult, JobAccepted, Problem, RevisionToken } from './protocol';
import type { JobStore } from './jobs';
import { commandDigest, createCommandStore, validateCommandOutcome, withCommandExecution } from './command-store';

export type CommandContext = { requestId: string; commandId: string; installationId: string; actor: ActorRef; repository: WorkbenchRepository; clock: Clock; ownAccess: OwnAccessProfile };
export type CommandOutcome<R> = { result: R; changedRefs: EntityRef[]; editToken: RevisionToken | null };
export type CommandDescriptor<P, R> = { name: string; inputSchema: z.ZodType<P>; outputSchema: z.ZodType<R>; capability: Capability; effect: 'local' | 'sharedDraft' | 'external'; execution: 'sync' | 'async'; handler: (context: CommandContext, payload: P) => Promise<CommandOutcome<R>>; resourceKey?: (payload: P) => string; queuedRecovery?: 'restart-safe-local' };
type ErasedDescriptor = { capability: Capability; effect: CommandDescriptor<unknown, unknown>['effect']; execution: 'sync' | 'async'; input: z.ZodType; output: z.ZodType; run: (context: CommandContext, payload: unknown) => Promise<CommandOutcome<unknown>>; resourceKey: (payload: unknown) => string; queuedRecovery?: 'restart-safe-local' };
export type CommandRecoveryIdentity = { commandId: string; installationId: string; jobId: string; name: string };
export interface CommandRegistry { register<P, R>(descriptor: CommandDescriptor<P, R>): void; execute(request: CommandRequest, context: CommandContext): Promise<CommandResult | JobAccepted>; recoverPending(installationId: string, resolveContext: (identity: CommandRecoveryIdentity) => Promise<CommandContext>): Promise<void>; getCapability(name: string): Capability | null; listNames(): string[]; idle(): Promise<void> }

export function createCommandRegistry({ repository, jobs, accessPolicy, maxConcurrent = 2 }: { repository: WorkbenchRepository; jobs: JobStore; accessPolicy: AccessPolicyService; maxConcurrent?: number }): CommandRegistry {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw Error('Invalid concurrency');
  const store = createCommandStore(repository); const descriptors = new Map<string, ErasedDescriptor>();
  const inflight = new Map<string, { digest: string; promise: Promise<CommandResult | JobAccepted> }>();
  const queue: Array<{ resource: string; run: () => Promise<void> }> = []; const busy = new Set<string>(); let running = 0; const idleWaiters: Array<() => void> = [];
  const pump = () => { while (running < maxConcurrent) { const index = queue.findIndex(item => !busy.has(item.resource)); if (index < 0) { if (!queue.length && !running) while (idleWaiters.length) idleWaiters.pop()!(); return; } const item = queue.splice(index, 1)[0]; busy.add(item.resource); running++; void item.run().finally(() => { busy.delete(item.resource); running--; pump(); }); } };
  const schedule = (resource: string, run: () => Promise<void>): Promise<void> => new Promise((resolve, reject) => { queue.push({ resource, run: async () => { try { await run(); resolve(); } catch (error) { reject(error); } } }); queueMicrotask(pump); });
  jobs.setScheduler(schedule);
  const parseInput = <T>(schema: z.ZodType<T>, input: unknown): T => { const parsed = schema.safeParse(input); if (!parsed.success) throw new WorkbenchHttpError(422, 'VALIDATION_FAILED', 'Invalid command input', fieldProblems(parsed.error)); return parsed.data; };
  const authorize = async (name: string, descriptor: ErasedDescriptor) => { const access = await accessPolicy.assertCommandAllowed(name); if (!canUseCapability(access, descriptor.capability)) throw new WorkbenchHttpError(403, 'COMMAND_FORBIDDEN', 'Command is unavailable'); return access; };
  const response = (commandId: string, outcome: CommandOutcome<unknown>): CommandResult => commandResultSchema.parse({ commandId, ...outcome });
  const invoke = async (request: CommandRequest, context: CommandContext, descriptor: ErasedDescriptor) => {
    parseInput(descriptor.input, request.payload);
    const liveAccess = await authorize(request.name, descriptor);
    if (descriptor.effect === 'external') await accessPolicy.assertFreshPublishAllowed(jobs.findByCommand(request.commandId, context.installationId)?.jobId ?? request.commandId);
    const liveContext = { ...context, ownAccess: liveAccess, actor: { ...context.actor, profilePersonId: liveAccess.personId } };
    return withCommandExecution(liveContext, descriptor.output, async () => {
      const outcome = validateCommandOutcome(liveContext, await descriptor.run(liveContext, request.payload));
      const receipt = store.get(context.installationId, request.commandId)?.receipt_json;
      if (receipt) return JSON.parse(receipt) as CommandOutcome<unknown>;
      store.receipt(context.installationId, request.commandId, outcome); return outcome;
    });
  };
  const reconcileReceipt = (identity: CommandRecoveryIdentity): boolean => {
    const receipt = store.get(identity.installationId, identity.commandId)?.receipt_json;
    if (!receipt) return false;
    const outcome = response(identity.commandId, JSON.parse(receipt) as CommandOutcome<unknown>);
    repository.transaction(() => {
      const job = jobs.get(identity.jobId, identity.installationId);
      if (!job || ['succeeded', 'partial', 'failed', 'cancelled'].includes(job.status)) return;
      if (job.status !== 'running') jobs.update(identity.jobId, { status: 'running', stage: 'running', nextAction: null });
      jobs.complete(identity.jobId, outcome.result, []);
    });
    return true;
  };
  const runAccepted = async (identity: CommandRecoveryIdentity, action: () => Promise<CommandOutcome<unknown>>) => {
    try {
      if (reconcileReceipt(identity)) return;
      jobs.update(identity.jobId, { status: 'running', stage: 'running' });
      const outcome = await action(); jobs.complete(identity.jobId, outcome.result, []);
    } catch (error) {
      // A committed local outcome is authoritative even if the response/handler
      // continuation was lost. Never publish a false failure after its receipt.
      if (reconcileReceipt(identity)) return;
      const problem: Problem = { code: error instanceof WorkbenchHttpError ? error.code : 'OPERATION_FAILED', message: 'Operation did not complete', retryable: false, details: [], operationId: identity.jobId, provider: null };
      const job = jobs.get(identity.jobId, identity.installationId);
      if (job && !['succeeded', 'partial', 'failed', 'cancelled', 'waiting_user', 'retry_wait', 'interrupted'].includes(job.status)) jobs.fail(identity.jobId, problem);
      store.fail(identity.installationId, identity.commandId);
    }
  };
  let recoveryStarted = false;
  const registry: CommandRegistry = {
    register(descriptor) { if (!/^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9_-]+)+$/.test(descriptor.name) || descriptors.has(descriptor.name) || ['job.cancel', 'job.retry', 'job.openAuth'].includes(descriptor.name)) throw new WorkbenchHttpError(409, 'COMMAND_ALREADY_REGISTERED', 'Duplicate or invalid command'); if (descriptor.queuedRecovery && (descriptor.effect !== 'local' || descriptor.execution !== 'async')) throw new WorkbenchHttpError(422, 'INVALID_RECOVERY_POLICY', 'Only asynchronous local commands can opt into queued recovery'); descriptors.set(descriptor.name, { capability: descriptor.capability, effect: descriptor.effect, execution: descriptor.execution, input: descriptor.inputSchema, output: descriptor.outputSchema, run: (ctx, payload) => descriptor.handler(ctx, descriptor.inputSchema.parse(payload)), resourceKey: payload => descriptor.resourceKey ? descriptor.resourceKey(descriptor.inputSchema.parse(payload)) : descriptor.name, queuedRecovery: descriptor.queuedRecovery }); },
    getCapability(name) { return name.startsWith('job.') && ['job.cancel', 'job.retry', 'job.openAuth'].includes(name) ? 'personal.write' : descriptors.get(name)?.capability ?? null; },
    listNames() { return [...descriptors.keys(), 'job.cancel', 'job.retry', 'job.openAuth'].sort(); },
    idle() { return !queue.length && !running ? Promise.resolve() : new Promise<void>(resolve => { idleWaiters.push(resolve); }); },
    async recoverPending(installationId, resolveContext) {
      uuidSchema.parse(installationId);
      if (recoveryStarted) return;
      // Capture the durable pre-restart state before converting interrupted
      // work. Only never-started queued jobs are eligible for automatic replay.
      // The conversion and requeue decisions must commit together: another
      // crash during startup cannot turn safe queued work into lost work.
      const pending = repository.transaction(() => {
        const candidates = jobs.recoveryCandidates(installationId); jobs.recoverInterrupted(installationId);
        return candidates.flatMap(candidate => {
          const identity = { commandId: candidate.snapshot.commandId, installationId: candidate.installationId, jobId: candidate.snapshot.jobId, name: candidate.name };
          if (reconcileReceipt(identity)) return [];
          const descriptor = descriptors.get(candidate.name); const intent = store.get(identity.installationId, identity.commandId);
          const policy = intent?.recovery_json ? JSON.parse(intent.recovery_json) as { effect?: string; queuedRecovery?: string } : null;
          if (candidate.snapshot.status !== 'queued' || candidate.irreversible || candidate.hasCheckpoints || !candidate.resourceKey || descriptor?.effect !== 'local' || descriptor.execution !== 'async' || descriptor.queuedRecovery !== 'restart-safe-local' || policy?.effect !== 'local' || policy.queuedRecovery !== 'restart-safe-local' || !intent?.accepted_json) return [];
          const accepted = JSON.parse(intent.accepted_json) as JobAccepted;
          if (accepted.jobId !== identity.jobId) return [];
          jobs.update(identity.jobId, { status: 'queued', stage: 'queued' });
          return [{ identity, descriptor, intent, resource: candidate.resourceKey }];
        });
      });
      recoveryStarted = true;
      for (const { identity, descriptor, intent, resource } of pending) {
        void schedule(resource, () => runAccepted(identity, async () => {
          // Resolve at the actual queue slot, using only trusted SERVER state.
          // Neither an old actor nor an authorization profile is persisted.
          const context = await resolveContext(identity);
          if (context.repository !== repository || context.commandId !== identity.commandId || context.installationId !== identity.installationId || context.actor.installationId !== identity.installationId || !uuidSchema.safeParse(context.requestId).success || !actorRefSchema.safeParse(context.actor).success) throw new WorkbenchHttpError(409, 'COMMAND_CONTEXT_MISMATCH', 'Recovered command context mismatch');
          const request = parseInput(commandRequestSchema, JSON.parse(intent.request_json));
          if (request.commandId !== identity.commandId || request.name !== identity.name || commandDigest(request) !== intent.digest) throw new WorkbenchHttpError(409, 'COMMAND_CONTEXT_MISMATCH', 'Recovered command intent mismatch');
          return invoke(request, context, descriptor);
        })).catch(() => undefined);
      }
    },
    async execute(unvalidated, context) {
      const request = parseInput(commandRequestSchema, unvalidated);
      if (context.repository !== repository || context.commandId !== request.commandId) throw new WorkbenchHttpError(409, 'COMMAND_CONTEXT_MISMATCH', 'Command context mismatch');
      const control = ['job.cancel', 'job.retry', 'job.openAuth'].includes(request.name);
      const descriptor = descriptors.get(request.name); if (!descriptor && !control) throw new WorkbenchHttpError(404, 'COMMAND_NOT_FOUND', 'Command not registered');
      if (descriptor) parseInput(descriptor.input, request.payload);
      if (control && (Object.keys(request.payload).length !== 1 || typeof request.payload.jobId !== 'string')) throw new WorkbenchHttpError(422, 'INVALID_JOB_INPUT', 'Expected a job ID');
      const digest = commandDigest(request); const key = `${context.installationId}/${request.commandId}`; const pending = inflight.get(key);
      if (pending) { if (pending.digest !== digest) throw new WorkbenchHttpError(409, 'IDEMPOTENCY_CONFLICT', 'Command ID has different input'); return pending.promise; }
      const action = async (): Promise<CommandResult | JobAccepted> => {
        const access = descriptor ? await authorize(request.name, descriptor) : await accessPolicy.assertCommandAllowed(request.name);
        const ctx = { ...context, ownAccess: access, actor: { ...context.actor, profilePersonId: access.personId } };
        const intent = store.begin(request, context.installationId);
        if (intent.row.accepted_json) return JSON.parse(intent.row.accepted_json) as JobAccepted;
        if (intent.row.receipt_json) return response(request.commandId, JSON.parse(intent.row.receipt_json));
        if (!intent.created) throw new WorkbenchHttpError(409, 'COMMAND_INTERRUPTED', 'Previous command requires reconciliation');
        if (control) {
          const ids = Object.keys(request.payload); const jobId = request.payload.jobId;
          if (ids.length !== 1 || ids[0] !== 'jobId' || typeof jobId !== 'string') throw new WorkbenchHttpError(422, 'INVALID_JOB_INPUT', 'Expected a job ID');
          const originalName = jobs.name(jobId, ctx.installationId); if (!originalName) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found');
          const original = descriptors.get(originalName);
          if (request.name !== 'job.cancel') { if (!original) throw new WorkbenchHttpError(409, 'JOB_HANDLER_UNAVAILABLE', 'Handler unavailable after restart'); await authorize(originalName, original); if (original.effect === 'external') await accessPolicy.assertFreshPublishAllowed(jobId); }
          if (request.name === 'job.retry') { const accepted = await jobs.retry(jobId, ctx.installationId, async () => { if (!original) throw new WorkbenchHttpError(409, 'JOB_HANDLER_UNAVAILABLE', 'Handler unavailable'); await authorize(originalName, original); if (original.effect === 'external') await accessPolicy.assertFreshPublishAllowed(jobId); }); store.accept(ctx.installationId, request.commandId, accepted); return accepted; }
          if (request.name === 'job.cancel') await jobs.cancel(jobId, ctx.installationId); else await jobs.openAuth(jobId, ctx.installationId);
          const outcome: CommandOutcome<unknown> = { result: request.name === 'job.cancel' ? { jobId, cancelRequested: true } : { jobId, externalStepOpened: true }, changedRefs: [], editToken: null }; store.receipt(ctx.installationId, request.commandId, outcome); return response(request.commandId, outcome);
        }
        const desc = descriptor!;
        if (desc.execution === 'sync') {
          try { return response(request.commandId, await invoke(request, ctx, desc)); } catch (error) { store.fail(ctx.installationId, request.commandId); throw error; }
        }
        const resource = desc.resourceKey(request.payload);
        const accepted = repository.transaction(() => { const result = jobs.create(request.commandId, ctx.installationId, request.name); store.accept(ctx.installationId, request.commandId, result, { effect: desc.effect, queuedRecovery: desc.queuedRecovery ?? null }); jobs.setResourceKey(result.jobId, resource); return result; });
        void schedule(resource, () => runAccepted({ commandId: request.commandId, installationId: ctx.installationId, jobId: accepted.jobId, name: request.name }, () => invoke(request, ctx, desc))).catch(() => undefined); return accepted;
      };
      const promise = action(); inflight.set(key, { digest, promise }); try { return await promise; } finally { inflight.delete(key); }
    },
  };
  return registry;
}
