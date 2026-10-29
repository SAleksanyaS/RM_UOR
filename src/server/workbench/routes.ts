import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import multipart from '@fastify/multipart';
import { Transform } from 'node:stream';
import { assertFileName, defaultFileLimits, fileHandleViewSchema, type FileHandleView, type FileStore } from './files';
import { withMultipartUpload } from './multipart-upload';
import { uuidSchema, type UUIDv4 } from '../../domain/workbench/index';
import type { LocalSessionStore } from './session';
import { anyQueryRequestSchema, apiSuccessSchema, commandReconciliationSchema, commandRequestSchema, commandResultSchema, fieldProblems, jobAcceptedSchema, jobSnapshotSchema, metaSchema, problemSchema, sessionViewSchema, WorkbenchHttpError, type ApiSuccess, type CommandReconciliation, type CommandRequest, type CommandResult, type JobAccepted, type JobSnapshot, type Meta, type Problem, type AnyQueryRequest, type SessionView } from './protocol';

export type LocalRequest = { requestId: UUIDv4; sessionId: UUIDv4 };
export type BrowserResultArtifact = { bytes: Uint8Array; name: string; mimeType: string; sha256: string };
export interface WorkbenchHttpPort {
  upload(input: Omit<Parameters<FileStore['stage']>[0], 'installationId'>, request: LocalRequest): Promise<ApiSuccess<FileHandleView>>;
  session(request: LocalRequest): Promise<SessionView>;
  refreshSession(request: LocalRequest): Promise<SessionView>;
  meta(request: LocalRequest): Promise<Meta>;
  query(name: string, input: AnyQueryRequest, request: LocalRequest): Promise<ApiSuccess<unknown>>;
  browserResult?(resultId: UUIDv4, kind: 'original' | 'enriched', request: LocalRequest): Promise<BrowserResultArtifact>;
  command(input: CommandRequest, request: LocalRequest): Promise<ApiSuccess<CommandResult | JobAccepted>>;
  reconcileCommand?(id: UUIDv4, request: LocalRequest): Promise<ApiSuccess<CommandReconciliation>>;
  job(id: UUIDv4, request: LocalRequest): Promise<ApiSuccess<JobSnapshot>>;
}
declare module 'fastify' {
  interface FastifyInstance { workbenchTransport: { allowedOrigins: readonly string[]; sessions: LocalSessionStore } }
}
const cookieName = 'uor-workbench-session';
const problemStatuses: Readonly<Record<string, number>> = {
  REVISION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, CURSOR_STALE: 409, PREVIEW_STALE: 409,
  REMOTE_STATE_UNKNOWN: 409, EFFECTIVE_TIME_UNVERIFIED: 409, RECOVERY_REQUIRED: 409,
  GIT_AUTH_REQUIRED: 409, PR_AUTH_REQUIRED: 409, REFERENCE_NOT_FOUND: 404, BROKEN_REFERENCE: 404,
  ACCESS_DENIED: 403, ACCESS_RECHECK_REQUIRED: 503, SCHEMA_UNSUPPORTED: 422,
  SOURCE_SCHEMA_CHANGED: 422, INTEGRITY_MISMATCH: 422, INVALID_CURSOR: 409,
  INVALID_HISTORY_QUERY: 422, INVALID_PAGE_LIMIT: 422, SNAPSHOT_REQUIRED: 422,
  HISTORICAL_BASIS_UNAVAILABLE: 409, REFERENCE_NOT_PUBLISHED: 409, BASIS_MISMATCH: 422,
};
const requestIds = new WeakMap<FastifyRequest, string>();
function loopback(address: string): boolean {
  return address === '::1' || address === '0:0:0:0:0:0:0:1' || /^127\./.test(address) && isIP(address) === 4 || address.startsWith('::ffff:') && loopback(address.slice(7));
}
function trustedHost(host: string | undefined): boolean {
  if (!host || /[\s/@\\?#]/.test(host)) return false;
  try { const url = new URL('http://' + host); const hostname = url.hostname.replace(/^\[|\]$/g, ''); return url.pathname === '/' && (hostname === 'localhost' || loopback(hostname)); } catch { return false; }
}
function csrfMatches(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WorkbenchHttpError(422, 'VALIDATION_FAILED', 'Request validation failed', fieldProblems(parsed.error));
  return parsed.data;
}
export async function registerWorkbenchRoutes(app: FastifyInstance, application: WorkbenchHttpPort): Promise<void> {
  if (!app.hasDecorator('workbenchTransport')) throw new Error('workbenchTransport decorator is required');
  const { sessions, allowedOrigins } = app.workbenchTransport;
  if (allowedOrigins.length === 0 || allowedOrigins.some(origin => { try { return new URL(origin).origin !== origin; } catch { return true; } })) throw new Error('Exact configured allowedOrigins are required');
  // Encapsulation preserves legacy hooks/errors until T39 switches the entry point.
  await app.register(async api => {
    await api.register(multipart, { limits: { files: 1, fields: 1, parts: 2, fileSize: defaultFileLimits.restoreBytes, fieldSize: 32, fieldNameSize: 20, headerPairs: 16 } });
    api.addHook('preParsing', async (request, _reply, payload) => {
      if (request.method !== 'POST' || request.routeOptions.url !== '/api/v1/files' || !request.isMultipart()) return payload;
      let received = 0;
      const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) { received += chunk.length; if (received > defaultFileLimits.restoreBytes + 65536) callback(new WorkbenchHttpError(413, 'FILE_TOO_LARGE', 'The upload exceeds the server size limit')); else callback(null, chunk); } });
      payload.on('error', error => bounded.destroy(error)); return payload.pipe(bounded);
    });
    api.addHook('onRequest', async (request, reply) => {
      const requestId = randomUUID(); requestIds.set(request, requestId);
      reply.header('x-request-id', requestId).header('cache-control', 'no-store');
      if (!trustedHost(request.headers.host) || !loopback(request.raw.socket.remoteAddress ?? '')) throw new WorkbenchHttpError(403, 'LOOPBACK_REQUIRED', 'Local loopback access is required');
      const origin = request.headers.origin;
      if ((request.method === 'POST' || origin !== undefined) && (typeof origin !== 'string' || !allowedOrigins.includes(origin))) throw new WorkbenchHttpError(403, 'ORIGIN_FORBIDDEN', 'Origin is not allowed');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new WorkbenchHttpError(403, 'ORIGIN_FORBIDDEN', 'Cross-site requests are not allowed');
    });
    api.setErrorHandler((error, request, reply) => {
      const requestId = requestIds.get(request) ?? randomUUID();
      const record = error as Error & { statusCode?: number; code?: string; details?: unknown; retryable?: boolean; operationId?: string; provider?: unknown; problem?: unknown };
      let status = record.statusCode && record.statusCode >= 400 && record.statusCode <= 599 ? record.statusCode : problemStatuses[record.code ?? ''] ?? 500;
      let problem: Problem;
      if (status === 500) problem = { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', retryable: false, details: [], operationId: randomUUID(), provider: null };
      else {
        const knownHttp = record.code?.startsWith('FST_ERR_');
        const trusted = error instanceof WorkbenchHttpError;
        const safeCode = record.code && /^[A-Z][A-Z0-9_]{0,100}$/.test(record.code) ? record.code : 'HTTP_ERROR';
        problem = { code: knownHttp ? (status === 400 ? 'INVALID_REQUEST' : 'HTTP_ERROR') : safeCode, message: trusted ? record.message : knownHttp ? 'Invalid HTTP request' : 'The operation could not be completed', retryable: trusted ? record.retryable ?? false : status === 503 || status === 429, details: trusted ? error.details : [], operationId: trusted ? error.operationId : null, provider: trusted ? error.provider : null };
        if (!problemSchema.safeParse(problem).success) { status = 500; problem = { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', retryable: false, details: [], operationId: randomUUID(), provider: null }; }
      }
      reply.code(status).header('x-request-id', requestId).header('cache-control', 'no-store').send({ apiVersion: '1', requestId, error: problem, meta: { generatedAt: new Date().toISOString() } });
    });
    const local = (request: FastifyRequest, mutate = false): LocalRequest => {
      const session = sessions.get(request.cookies[cookieName] ?? '');
      if (!session) throw new WorkbenchHttpError(401, 'SESSION_REQUIRED', 'A local session is required');
      if (mutate && !csrfMatches(request.headers['x-csrf-token'], session.csrfToken)) throw new WorkbenchHttpError(403, 'CSRF_INVALID', 'A valid CSRF token is required');
      return { requestId: requestIds.get(request)!, sessionId: session.id };
    };
    api.get('/session', async (request, reply) => {
      let session = sessions.get(request.cookies[cookieName] ?? '');
      if (!session) { session = sessions.issue(); reply.setCookie(cookieName, session.id, { httpOnly: true, sameSite: 'strict', path: '/api/v1' }); }
      const r = { requestId: requestIds.get(request)!, sessionId: session.id };
      const data = sessionViewSchema.parse(await application.session(r));
      return apiSuccessSchema(sessionViewSchema).parse({ apiVersion: '1', requestId: r.requestId, data: { ...data, csrfToken: session.csrfToken }, meta: metaSchema.parse(await application.meta(r)) });
    });
    api.post('/session/refresh', async request => {
      const r = local(request, true); input(z.strictObject({}), request.body);
      const data = sessionViewSchema.parse(await application.refreshSession(r));
      return apiSuccessSchema(sessionViewSchema).parse({ apiVersion: '1', requestId: r.requestId, data: { ...data, csrfToken: sessions.get(r.sessionId)!.csrfToken }, meta: metaSchema.parse(await application.meta(r)) });
    });
    api.post<{ Params: { queryName: string } }>('/queries/:queryName', async request => {
      const r = local(request); const result = await application.query(request.params.queryName, input(anyQueryRequestSchema, request.body), r);
      return apiSuccessSchema(z.unknown()).parse({ ...result, requestId: r.requestId });
    });
    api.post('/commands', async (request, reply) => {
      const r = local(request, true); const result = await application.command(input(commandRequestSchema, request.body), r);
      const response = apiSuccessSchema(z.union([commandResultSchema, jobAcceptedSchema])).parse({ ...result, requestId: r.requestId });
      if ('jobId' in response.data) reply.code(202);
      return response;
    });
    api.post('/files', async (request, reply) => {
      const r = local(request, true);
      const result = await withMultipartUpload(request, value => application.upload(value, r));
      reply.code(201); return apiSuccessSchema(fileHandleViewSchema).parse({ ...result, requestId: r.requestId });
    });
    api.get<{ Params: { jobId: string } }>('/jobs/:jobId', async request => {
      const r = local(request); const parsed = uuidSchema.safeParse(request.params.jobId);
      if (!parsed.success) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found');
      const result = await application.job(parsed.data, r);
      return apiSuccessSchema(jobSnapshotSchema).parse({ ...result, requestId: r.requestId });
    });
    api.get<{ Params: { commandId: string } }>('/commands/:commandId', async request => {
      const r = local(request), id = uuidSchema.safeParse(request.params.commandId);
      if (!id.success || !application.reconcileCommand) throw new WorkbenchHttpError(404, 'COMMAND_NOT_FOUND', 'Own command not found');
      const result = await application.reconcileCommand(id.data, r);
      return apiSuccessSchema(commandReconciliationSchema).parse({ ...result, requestId: r.requestId });
    });
    api.get<{ Params: { resultId: string; kind: string } }>('/browser/results/:resultId/:kind', async (request, reply) => {
      const r = local(request); const id = uuidSchema.safeParse(request.params.resultId);
      const kind = request.params.kind;
      if (!id.success || !['original', 'enriched'].includes(kind) || !application.browserResult) throw new WorkbenchHttpError(404, 'RESULT_NOT_FOUND', 'Result not found');
      const result = await application.browserResult(id.data, kind as 'original' | 'enriched', r);
      assertFileName(result.name);
      if (!(result.bytes instanceof Uint8Array) || result.bytes.length > defaultFileLimits.restoreBytes || !/^[a-f0-9]{64}$/.test(result.sha256) || createHash('sha256').update(result.bytes).digest('hex') !== result.sha256) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Result bytes failed integrity verification');
      if (!['text/csv', 'text/csv; charset=utf-8', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'].includes(result.mimeType)) throw new WorkbenchHttpError(422, 'INVALID_FILE', 'Unsupported result type');
      return reply.header('content-type', result.mimeType).header('content-length', result.bytes.length)
        .header('content-disposition', `attachment; filename="export.${kind === 'enriched' || /\.csv$/i.test(result.name) ? 'csv' : 'xlsx'}"; filename*=UTF-8''${encodeURIComponent(result.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`)
        .header('x-content-sha256', result.sha256).header('x-content-type-options', 'nosniff').send(Buffer.from(result.bytes));
    });
    api.setNotFoundHandler((_request, reply) => { throw new WorkbenchHttpError(404, 'ROUTE_NOT_FOUND', 'Route not found'); });
  }, { prefix: '/api/v1' });
}
