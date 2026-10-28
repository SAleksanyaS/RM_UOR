import { z } from 'zod';
import { businessTimeSchema, entityRefSchema, utcInstantSchema, uuidSchema } from '../../domain/workbench/index';

export const revisionTokenSchema = z.string().min(1);
export type RevisionToken = z.infer<typeof revisionTokenSchema>;
const objectSchema = z.record(z.string(), z.unknown());
export const globalContextSchema = z.strictObject({
  scopePath: z.strictObject({ ditId: uuidSchema, clusterId: uuidSchema.nullable(), productId: uuidSchema.nullable(), teamId: uuidSchema.nullable() }),
  goalId: uuidSchema.nullable(), time: z.union([businessTimeSchema.options[0], businessTimeSchema.options[1]]),
  resultMode: z.enum(['current', 'agreed']), snapshotId: uuidSchema.nullable(),
}).superRefine((v, ctx) => {
  if (v.scopePath.productId !== null && v.scopePath.clusterId === null) ctx.addIssue({ code: 'custom', path: ['scopePath', 'productId'], message: 'Product requires cluster' });
  if (v.scopePath.teamId !== null && v.scopePath.productId === null) ctx.addIssue({ code: 'custom', path: ['scopePath', 'teamId'], message: 'Team requires product' });
});
export type GlobalContext = z.infer<typeof globalContextSchema>;
export const fieldProblemSchema = z.strictObject({ path: z.string().regex(/^(?:\/(?:[^~]|~[01])*)*$/), code: z.string().min(1), message: z.string(), ref: entityRefSchema.nullable() });
export type FieldProblem = z.infer<typeof fieldProblemSchema>;
export const problemSchema = z.strictObject({ code: z.string().min(1), message: z.string().min(1), retryable: z.boolean(), details: z.array(fieldProblemSchema), operationId: uuidSchema.nullable(), provider: z.enum(['git', 'bitbucket']).nullable() });
export type Problem = z.infer<typeof problemSchema>;
export const pageRequestSchema = z.strictObject({ limit: z.number().int().min(1).max(200).default(50), cursor: z.string().min(1).nullable().default(null) });
export type PageRequest = z.infer<typeof pageRequestSchema>;
export const pageResultSchema = z.strictObject({ nextCursor: z.string().min(1).nullable(), hasMore: z.boolean() });
export type PageResult = z.infer<typeof pageResultSchema>;
export const sortSchema = z.strictObject({ field: z.string().min(1), direction: z.enum(['asc', 'desc']) });
export type Sort = z.infer<typeof sortSchema>;
export const queryRequestSchema = z.strictObject({ context: globalContextSchema, filter: objectSchema, sort: z.array(sortSchema), page: pageRequestSchema.default({ limit: 50, cursor: null }) });
export type QueryRequest = z.infer<typeof queryRequestSchema>;
export const commandRequestSchema = z.strictObject({ commandId: uuidSchema, name: z.string().min(1), baseRevision: revisionTokenSchema.nullable(), payload: objectSchema });
export type CommandRequest = z.infer<typeof commandRequestSchema>;
export const commandResultSchema = z.strictObject({ commandId: uuidSchema, result: objectSchema, changedRefs: z.array(entityRefSchema), editToken: revisionTokenSchema.nullable() });
export type CommandResult = z.infer<typeof commandResultSchema>;
export const metaSchema = z.strictObject({ generatedAt: utcInstantSchema, publishedCommit: z.string().min(1).nullable(), stateRevision: revisionTokenSchema, warnings: z.array(problemSchema), page: pageResultSchema.optional() });
export type Meta = z.infer<typeof metaSchema>;
export type ApiSuccess<T> = { apiVersion: '1'; requestId: string; data: T; meta: Meta };
export function apiSuccessSchema<T extends z.ZodType>(dataSchema: T) { return z.strictObject({ apiVersion: z.literal('1'), requestId: uuidSchema, data: dataSchema, meta: metaSchema }); }
export const apiErrorSchema = z.strictObject({ apiVersion: z.literal('1'), requestId: uuidSchema, error: problemSchema, meta: z.strictObject({ generatedAt: utcInstantSchema }) });
export type ApiError = z.infer<typeof apiErrorSchema>;
export const sessionViewSchema = z.strictObject({ role: z.enum(['viewer', 'curator', 'chief']), displayName: z.string().nullable(), personId: uuidSchema.nullable(), policyState: z.enum(['verified', 'offline_cached', 'unavailable', 'revoked', 'invalid']), checkedAt: utcInstantSchema.nullable(), allowedCommands: z.array(z.string().min(1)), csrfToken: z.string().min(1), defaultContext: globalContextSchema.nullable() });
export type SessionView = z.infer<typeof sessionViewSchema>;
export const nextActionSchema = z.strictObject({ commandName: z.string().min(1).nullable(), payload: objectSchema.nullable(), route: z.string().min(1).nullable(), label: z.string().min(1), enabled: z.boolean(), disabledReason: z.string().nullable() });
export type NextAction = z.infer<typeof nextActionSchema>;
export const jobAcceptedSchema = z.strictObject({ jobId: uuidSchema, status: z.enum(['queued', 'running']), pollAfterMs: z.literal(1000) });
export type JobAccepted = z.infer<typeof jobAcceptedSchema>;
export const jobStatusSchema = z.enum(['queued', 'running', 'waiting_user', 'retry_wait', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted']);
export type JobStatus = z.infer<typeof jobStatusSchema>;
export const jobSnapshotSchema = z.strictObject({
  jobId: uuidSchema, commandId: uuidSchema, status: jobStatusSchema, stage: z.string().min(1),
  progress: z.strictObject({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative().nullable(), unit: z.string().min(1) }),
  cancelAvailable: z.boolean(), retryAvailable: z.boolean(), result: objectSchema.nullable(), error: problemSchema.nullable(), warnings: z.array(problemSchema), nextAction: nextActionSchema.nullable(), startedAt: utcInstantSchema.nullable(), finishedAt: utcInstantSchema.nullable(),
}).superRefine((v, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.result !== null && v.error !== null) issue('error', 'Result and error are mutually exclusive');
  if (v.status === 'failed' && v.error === null) issue('error', 'Failed job requires error');
  if (v.status === 'partial' && (v.result === null || v.error !== null || v.warnings.length === 0)) issue('result', 'Partial job requires result and warnings without error');
  if (v.status === 'succeeded' && (v.result === null || v.error !== null)) issue('result', 'Succeeded job requires result without error');
  if (!['succeeded', 'partial', 'failed', 'cancelled'].includes(v.status) && (v.result !== null || v.error !== null)) issue('result', 'Unfinished job has no result or error; use warnings');
  if (v.progress.total !== null && v.progress.completed > v.progress.total) issue('progress', 'Completed exceeds total');
});
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;

/** Safe structured errors are explicit; unexpected Error messages never cross HTTP. */
export class WorkbenchHttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string, public readonly details: FieldProblem[] = [], public readonly retryable = false, public readonly operationId: string | null = null, public readonly provider: Problem['provider'] = null) { super(message); this.name = 'WorkbenchHttpError'; }
}
export function fieldProblems(error: z.ZodError): FieldProblem[] {
  return error.issues.map(issue => ({ path: issue.path.map(key => '/' + String(key).replace(/~/g, '~0').replace(/\//g, '~1')).join(''), code: issue.code, message: issue.message, ref: null }));
}
