import type { z } from 'zod';
import type { ActorRef, Clock, EntityRef } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../storage/workbench-repository';
import { canUseCapability } from '../../features/identity/workbench-access-policy';
import type { AccessPolicyService, Capability, OwnAccessProfile } from '../../features/identity/workbench-access-policy';
import { commandRequestSchema, commandResultSchema, fieldProblems, WorkbenchHttpError } from './protocol';
import type { CommandRequest, CommandResult, JobAccepted, Problem, RevisionToken } from './protocol';
import type { JobStore } from './jobs';
import { commandDigest, createCommandStore, validateCommandOutcome, withCommandExecution } from './command-store';

export type CommandContext = { requestId: string; commandId: string; installationId: string; actor: ActorRef; repository: WorkbenchRepository; clock: Clock; ownAccess: OwnAccessProfile };
export type CommandOutcome<R> = { result: R; changedRefs: EntityRef[]; editToken: RevisionToken | null };
export type CommandDescriptor<P, R> = { name: string; inputSchema: z.ZodType<P>; outputSchema: z.ZodType<R>; capability: Capability; effect: 'local' | 'sharedDraft' | 'external'; execution: 'sync' | 'async'; handler: (context: CommandContext, payload: P) => Promise<CommandOutcome<R>>; resourceKey?: (payload: P) => string };
type ErasedDescriptor = { capability: Capability; effect: CommandDescriptor<unknown, unknown>['effect']; execution: 'sync' | 'async'; input: z.ZodType; output: z.ZodType; run: (context: CommandContext, payload: unknown) => Promise<CommandOutcome<unknown>>; resourceKey: (payload: unknown) => string };
export interface CommandRegistry { register<P, R>(descriptor: CommandDescriptor<P, R>): void; execute(request: CommandRequest, context: CommandContext): Promise<CommandResult | JobAccepted>; getCapability(name: string): Capability | null; listNames(): string[]; idle(): Promise<void> }

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
  const registry: CommandRegistry = {
    register(descriptor) { if (!/^[a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9_-]+)+$/.test(descriptor.name) || descriptors.has(descriptor.name) || ['job.cancel', 'job.retry', 'job.openAuth'].includes(descriptor.name)) throw new WorkbenchHttpError(409, 'COMMAND_ALREADY_REGISTERED', 'Duplicate or invalid command'); descriptors.set(descriptor.name, { capability: descriptor.capability, effect: descriptor.effect, execution: descriptor.execution, input: descriptor.inputSchema, output: descriptor.outputSchema, run: (ctx, payload) => descriptor.handler(ctx, descriptor.inputSchema.parse(payload)), resourceKey: payload => descriptor.resourceKey ? descriptor.resourceKey(descriptor.inputSchema.parse(payload)) : descriptor.name }); },
    getCapability(name) { return name.startsWith('job.') && ['job.cancel', 'job.retry', 'job.openAuth'].includes(name) ? 'personal.write' : descriptors.get(name)?.capability ?? null; },
    listNames() { return [...descriptors.keys(), 'job.cancel', 'job.retry', 'job.openAuth'].sort(); },
    idle() { return !queue.length && !running ? Promise.resolve() : new Promise<void>(resolve => { idleWaiters.push(resolve); }); },
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
        const invoke = async () => {
          const liveAccess = await authorize(request.name, desc);
          if (desc.effect === 'external') await accessPolicy.assertFreshPublishAllowed(jobs.findByCommand(request.commandId, ctx.installationId)?.jobId ?? request.commandId);
          const liveContext = { ...ctx, ownAccess: liveAccess, actor: { ...ctx.actor, profilePersonId: liveAccess.personId } };
          return withCommandExecution(liveContext, desc.output, async () => {
            const outcome = validateCommandOutcome(liveContext, await desc.run(liveContext, request.payload));
            const receipt = store.get(ctx.installationId, request.commandId)?.receipt_json;
            if (receipt) return JSON.parse(receipt) as CommandOutcome<unknown>;
            store.receipt(ctx.installationId, request.commandId, outcome); return outcome;
          });
        };
        if (desc.execution === 'sync') {
          try { return response(request.commandId, await invoke()); } catch (error) { store.fail(ctx.installationId, request.commandId); throw error; }
        }
        const accepted = repository.transaction(() => { const result = jobs.create(request.commandId, ctx.installationId, request.name); store.accept(ctx.installationId, request.commandId, result); jobs.setResourceKey(result.jobId, desc.resourceKey(request.payload)); return result; });
        void schedule(desc.resourceKey(request.payload), async () => {
          try { jobs.update(accepted.jobId, { status: 'running', stage: 'running' }); const outcome = await invoke(); jobs.complete(accepted.jobId, outcome.result, []); }
          catch (error) { const problem: Problem = { code: error instanceof WorkbenchHttpError ? error.code : 'OPERATION_FAILED', message: 'Operation did not complete', retryable: false, details: [], operationId: accepted.jobId, provider: null }; const job = jobs.get(accepted.jobId, ctx.installationId); if (job && !['succeeded', 'partial', 'failed', 'cancelled', 'waiting_user', 'retry_wait', 'interrupted'].includes(job.status)) jobs.fail(accepted.jobId, problem); store.fail(ctx.installationId, request.commandId); }
        }).catch(() => undefined); return accepted;
      };
      const promise = action(); inflight.set(key, { digest, promise }); try { return await promise; } finally { inflight.delete(key); }
    },
  };
  return registry;
}
