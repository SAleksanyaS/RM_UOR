import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { entityRefSchema } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../storage/workbench-repository';
import type { CommandContext, CommandOutcome } from './command-registry';
import { WorkbenchHttpError } from './protocol';
import type { CommandRequest, JobAccepted } from './protocol';

export type CommandRecoveryPolicy = { effect: 'local' | 'sharedDraft' | 'external'; queuedRecovery: 'restart-safe-local' | null };
type Intent = { digest: string; phase: string; request_json: string; accepted_json: string | null; receipt_json: string | null; recovery_json: string | null };
const execution = new AsyncLocalStorage<{ context: CommandContext; output: z.ZodType }>();
const outcomeSchema = z.strictObject({ result: z.record(z.string(), z.unknown()), changedRefs: z.array(entityRefSchema), editToken: z.string().min(1).nullable() });
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + stableJson(v)).join(',') + '}';
  const serialized = JSON.stringify(value); if (serialized === undefined) throw new WorkbenchHttpError(422, 'INVALID_COMMAND', 'Unsupported command value'); return serialized;
}
export const commandDigest = (request: CommandRequest): string => createHash('sha256').update(stableJson({ name: request.name, baseRevision: request.baseRevision, payload: request.payload })).digest('hex');
export function createCommandStore(repository: WorkbenchRepository) {
  const sql = repository.sqlForModule('commands');
  sql.execMigration('v1', `CREATE TABLE wb_commands_intents(installation_id TEXT NOT NULL,command_id TEXT NOT NULL,name TEXT NOT NULL,digest TEXT NOT NULL,request_json TEXT NOT NULL,phase TEXT NOT NULL,accepted_json TEXT,receipt_json TEXT,PRIMARY KEY(installation_id,command_id))`);
  sql.execMigration('v2-recovery-policy', 'ALTER TABLE wb_commands_intents ADD COLUMN recovery_json TEXT');
  const get = (installationId: string, commandId: string) => sql.get<Intent>('SELECT digest,phase,request_json,accepted_json,receipt_json,recovery_json FROM wb_commands_intents WHERE installation_id=? AND command_id=?', [installationId, commandId]);
  return {
    get,
    begin(request: CommandRequest, installationId: string): { row: Intent; created: boolean } {
      return repository.transaction(() => {
        const digest = commandDigest(request); const found = get(installationId, request.commandId);
        if (found) { if (found.digest !== digest) throw new WorkbenchHttpError(409, 'IDEMPOTENCY_CONFLICT', 'Command ID has different input'); return { row: found, created: false }; }
        sql.run('INSERT INTO wb_commands_intents(installation_id,command_id,name,digest,request_json,phase) VALUES(?,?,?,?,?,?)', [installationId, request.commandId, request.name, digest, stableJson(request), 'started']);
        return { row: get(installationId, request.commandId)!, created: true };
      });
    },
    accept(installationId: string, commandId: string, accepted: JobAccepted, recovery?: CommandRecoveryPolicy) { sql.run('UPDATE wb_commands_intents SET accepted_json=?,phase=?,recovery_json=? WHERE installation_id=? AND command_id=?', [JSON.stringify(accepted), 'accepted', recovery ? JSON.stringify(recovery) : null, installationId, commandId]); },
    receipt(installationId: string, commandId: string, outcome: CommandOutcome<unknown>) { outcomeSchema.parse(outcome); sql.run('UPDATE wb_commands_intents SET receipt_json=?,phase=? WHERE installation_id=? AND command_id=?', [JSON.stringify(outcome), 'completed', installationId, commandId]); },
    fail(installationId: string, commandId: string) { sql.run('UPDATE wb_commands_intents SET phase=? WHERE installation_id=? AND command_id=? AND receipt_json IS NULL', ['interrupted', installationId, commandId]); },
  };
}
export function withCommandExecution<T>(context: CommandContext, output: z.ZodType, action: () => T): T { return execution.run({ context, output }, action); }
export function validateCommandOutcome<R>(context: CommandContext, outcome: CommandOutcome<R>): CommandOutcome<R> {
  const lease = execution.getStore();
  if (!lease || lease.context.installationId !== context.installationId || lease.context.commandId !== context.commandId) throw new WorkbenchHttpError(409, 'COMMAND_CONTEXT_MISSING', 'Command is outside its execution context');
  const result = lease.output.parse(outcome.result); return outcomeSchema.parse({ ...outcome, result }) as CommandOutcome<R>;
}
export function commitCommandEffect<R>(context: CommandContext, action: () => CommandOutcome<R>): CommandOutcome<R> {
  const store = createCommandStore(context.repository);
  return context.repository.transaction(() => {
    const intent = store.get(context.installationId, context.commandId);
    if (!intent) throw new WorkbenchHttpError(409, 'COMMAND_INTENT_MISSING', 'Command must be registered before committing');
    if (intent.receipt_json) return JSON.parse(intent.receipt_json) as CommandOutcome<R>;
    const outcome = validateCommandOutcome(context, action());
    store.receipt(context.installationId, context.commandId, outcome); return outcome;
  });
}
