import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalSessionStore } from './session';
import { registerWorkbenchRoutes, type WorkbenchHttpPort } from './routes';
import { WorkbenchHttpError, type ApiSuccess, type SessionView } from './protocol';
import { WorkbenchError } from '../../domain/workbench/errors';

const id = '11111111-1111-4111-8111-111111111111';
const clock = { now: () => '2026-10-28T09:00:00Z' };
const command = { commandId: id, name: 'source.capture', baseRevision: null, payload: { goalId: id } };
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function fixture() {
  const app = Fastify(); apps.push(app); await app.register(cookie);
  const sessions = createLocalSessionStore({ clock });
  app.decorate('workbenchTransport', { allowedOrigins: ['http://127.0.0.1:5173'], sessions });
  const session = async (r: { sessionId: string }): Promise<SessionView> => ({ role: 'viewer', displayName: null, personId: null, policyState: 'unavailable', checkedAt: null, allowedCommands: [], csrfToken: sessions.get(r.sessionId)!.csrfToken, defaultContext: null });
  const envelope = <T>(data: T, requestId: string): ApiSuccess<T> => ({ apiVersion: '1', requestId, data, meta: { generatedAt: clock.now(), publishedCommit: null, stateRevision: 'view:1', warnings: [] } });
  const commandSpy = vi.fn(async (input, r) => {
    if (input.name === 'unknown') throw new WorkbenchHttpError(404, 'COMMAND_NOT_FOUND', 'Unknown command');
    if (input.name === 'broken') throw new Error('secret password command line');
    if (input.name === 'limited') throw Object.assign(new Error('Temporarily unavailable'), { statusCode: 503, code: 'ACCESS_RECHECK_REQUIRED', retryable: true });
    if (input.name === 'provider-secret') throw Object.assign(new Error('secret password command line'), { statusCode: 403, code: 'SOURCE_FORBIDDEN', details: [{ path: '', code: 'DENIED', message: 'secret token', ref: null }] });
    if (input.name === 'domain-conflict') throw new WorkbenchError('REVISION_CONFLICT', { private: 'secret' });
    if (input.name === 'source.capture.async') return envelope({ jobId: id, status: 'queued', pollAfterMs: 1000 }, r.requestId);
    return envelope({ commandId: input.commandId, result: {}, changedRefs: [], editToken: null }, r.requestId);
  });
  const port: WorkbenchHttpPort = { upload: async () => { throw new WorkbenchHttpError(422, 'INVALID_FILE', 'No file fixture'); }, session, refreshSession: session, meta: async () => envelope(null, id).meta, command: commandSpy as WorkbenchHttpPort['command'], query: async (_name, _input, r) => envelope({}, r.requestId), job: async () => { throw Object.assign(new Error('Not found'), { statusCode: 404, code: 'JOB_NOT_FOUND' }); } };
  await registerWorkbenchRoutes(app, port); await app.ready();
  const get = () => app.inject({ method: 'GET', url: '/api/v1/session', headers: { host: '127.0.0.1' } });
  const initial = await get();
  const cookieHeader = String(initial.headers['set-cookie']).split(';')[0];
  const csrf = initial.json().data.csrfToken;
  const post = (payload: unknown, extra: Record<string, string> = {}, url = '/api/v1/commands') => app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { host: '127.0.0.1', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrf, ...extra } });
  return { app, sessions, get, initial, post, commandSpy, cookieHeader, csrf };
}
describe('workbench HTTP transport', () => {
  it('uses_exact_envelope_and_cookie', async () => {
    const f = await fixture();
    expect(f.initial.statusCode).toBe(200);
    expect(f.initial.headers['set-cookie']).toMatch(/HttpOnly.*SameSite=Strict/i);
    expect(f.initial.headers['cache-control']).toBe('no-store');
    expect(f.initial.json()).toMatchObject({ apiVersion: '1', data: { defaultContext: null } });
    expect(f.initial.headers['x-request-id']).toBe(f.initial.json().requestId);
    const response = await f.post(command);
    expect(response.statusCode).toBe(200); expect(response.json()).not.toHaveProperty('error');
    expect(f.commandSpy.mock.calls[0][1].sessionId).toBeDefined();
  });
  it('rejects_spoofed_session_origin_and_extra_keys', async () => {
    const f = await fixture();
    expect((await f.post({ ...command, role: 'chief' })).statusCode).toBe(422);
    expect((await f.post(command, { origin: 'https://other.invalid' })).statusCode).toBe(403);
    expect((await f.post(command, { 'x-csrf-token': '' })).statusCode).toBe(403);
    expect((await f.post(command, { 'x-csrf-token': '', 'x-uor-token': f.csrf })).statusCode).toBe(403);
    expect((await f.post(command, { cookie: '' })).statusCode).toBe(401);
    expect((await f.post(command, { host: 'remote.invalid' })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/v1/commands', payload: command, headers: { host: '127.0.0.1', cookie: f.cookieHeader, 'x-csrf-token': f.csrf } })).statusCode).toBe(403);
    expect(f.commandSpy).not.toHaveBeenCalled();
  });
  it('returns_safe_typed_problems_and_invalidates_process_sessions', async () => {
    const f = await fixture();
    const missing = await f.post({ ...command, name: 'unknown' });
    expect(missing.statusCode).toBe(404); expect(missing.json().error.code).toBe('COMMAND_NOT_FOUND');
    expect(missing.json()).not.toHaveProperty('data');
    const broken = await f.post({ ...command, name: 'broken' });
    expect(broken.statusCode).toBe(500); expect(broken.body).not.toContain('secret');
    expect(broken.json().error.operationId).toMatch(/^[0-9a-f-]{36}$/);
    const provider = await f.post({ ...command, name: 'provider-secret' });
    expect(provider.statusCode).toBe(403); expect(provider.json().error.code).toBe('SOURCE_FORBIDDEN');
    expect(provider.body).not.toContain('secret'); expect(provider.json().error.details).toEqual([]);
    const conflict = await f.post({ ...command, name: 'domain-conflict' });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe('REVISION_CONFLICT'); expect(conflict.body).not.toContain('secret');
    f.sessions.invalidateAll(); expect((await f.post(command)).statusCode).toBe(401);
  });
  it('checks_refresh_csrf_but_allows_read_query_without_csrf', async () => {
    const f = await fixture();
    expect((await f.post({}, { 'x-csrf-token': '' }, '/api/v1/session/refresh')).statusCode).toBe(403);
    const context = { scopePath: { ditId: id, clusterId: null, productId: null, teamId: null }, goalId: null, time: { kind: 'as_of', date: '2026-10-28' }, resultMode: 'current', snapshotId: null };
    expect((await f.post({ context, filter: {}, sort: [] }, { 'x-csrf-token': '' }, '/api/v1/queries/overview')).statusCode).toBe(200);
    expect((await f.app.inject({ method: 'POST', url: '/api/v1/commands', payload: '{broken', headers: { host: '127.0.0.1', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' } })).statusCode).toBe(400);
  });
  it('maps_async_acceptance_and_missing_routes_without_legacy_fallback', async () => {
    const f = await fixture();
    const accepted = await f.post({ ...command, name: 'source.capture.async' });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().data).toEqual({ jobId: id, status: 'queued', pollAfterMs: 1000 });
    const unavailable = await f.post({ ...command, name: 'limited' });
    expect(unavailable.statusCode).toBe(503); expect(unavailable.json().error.code).toBe('ACCESS_RECHECK_REQUIRED');
    expect(unavailable.json().error.retryable).toBe(true);
    const missing = await f.app.inject({ method: 'GET', url: '/api/v1/does-not-exist', headers: { host: 'localhost' } });
    expect(missing.statusCode).toBe(404); expect(missing.json().error.code).toBe('ROUTE_NOT_FOUND');
    const nonLoopback = await f.app.inject({ method: 'GET', url: '/api/v1/session', remoteAddress: '192.0.2.1', headers: { host: 'localhost' } });
    expect(nonLoopback.statusCode).toBe(403);
    const ipv6 = await f.app.inject({ method: 'GET', url: '/api/v1/session', remoteAddress: '::1', headers: { host: '[::1]:5173' } });
    expect(ipv6.statusCode).toBe(200);
    const a = f.sessions.issue(), b = f.sessions.issue();
    expect(a.id).not.toBe(b.id); expect(a.csrfToken).not.toBe(b.csrfToken);
    a.csrfToken = 'changed'; expect(f.sessions.get(a.id)!.csrfToken).not.toBe('changed');
  });
});
