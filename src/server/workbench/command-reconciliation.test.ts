import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { createCommandRegistry } from './command-registry';
import { createJobStore } from './jobs';
import { createWorkbenchApp } from './app';
import { createLocalSessionStore } from './session';
import { createFileStore, defaultFileLimits } from './files';
import { QueryRegistry } from './query-registry';
import type { OwnAccessProfile } from '../../features/identity/workbench-access-policy';
import { createCommandStore } from './command-store';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-command-reconcile-')), installationId = randomUUID(), personId = randomUUID();
  const repository = createWorkbenchRepository({ filename: path.join(root, 'private.sqlite'), artifactRoot: root }), clock = { now: () => '2026-10-28T10:00:00Z' };
  let own: OwnAccessProfile = { role: 'curator', personId, displayName: null, policyState: 'local_preview', checkedAt: clock.now() }, effects = 0;
  const accessPolicy = { resolveOwnAccess: async () => own, assertCommandAllowed: async () => own, assertFreshPublishAllowed: async () => { throw Error('No publish'); } };
  const jobs = createJobStore({ repository, clock }), commands = createCommandRegistry({ repository, jobs, accessPolicy });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const app = await createWorkbenchApp({ repository, clock, hostname: () => 'TEST-HOST', installationId, accessPolicy, jobs, commands, files: createFileStore({ directory: path.join(root, 'uploads'), limits: defaultFileLimits }), queries: new QueryRegistry(), sessions: createLocalSessionStore({ clock }), allowedOrigins: ['http://localhost:5175'], modules: [{ id: 'private-notes', version: '1.0.0', platformContractVersion: 1, dependsOn: [], owns: { entityTypes: [], namespaces: ['private-notes'] }, schemas: [], queries: [], hooks: {}, commands: [
    { name: 'notes.own.save', ownership: 'person', capability: 'personal.write', effect: 'local', execution: 'sync', inputSchema: z.strictObject({ text: z.string() }), outputSchema: z.strictObject({ count: z.number() }), handler: async () => ({ result: { count: ++effects }, changedRefs: [], editToken: null }) },
    { name: 'notes.own.wait', ownership: 'person', capability: 'personal.write', effect: 'local', execution: 'async', inputSchema: z.strictObject({}), outputSchema: z.strictObject({ count: z.number() }), handler: async () => { await gate; return { result: { count: ++effects }, changedRefs: [], editToken: null }; } },
    { name: 'notes.installation.save', capability: 'personal.write', effect: 'local', execution: 'sync', inputSchema: z.strictObject({}), outputSchema: z.strictObject({ count: z.number() }), handler: async () => ({ result: { count: ++effects }, changedRefs: [], editToken: null }) },
  ] }] });
  cleanup.push(async () => { release(); await commands.idle(); await app.close(); repository.close(); if (!path.basename(root).startsWith('uor-command-reconcile-')) throw Error('Unsafe test root'); rmSync(root, { recursive: true, force: true }); });
  const session = await app.inject({ url: '/api/v1/session', headers: { host: 'localhost' } });
  const headers = { host: 'localhost', origin: 'http://localhost:5175', cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().data.csrfToken };
  const send = (commandId: string, name = 'notes.own.save', payload: Record<string, unknown> = { text: 'private-filter-value' }) => app.inject({ method: 'POST', url: '/api/v1/commands', headers, payload: { commandId, name, baseRevision: null, payload } });
  const read = (commandId: string) => app.inject({ url: '/api/v1/commands/' + commandId, headers });
  return { app, headers, send, read, release, commands, jobs, repository, installationId, personId, person: (id: string) => { own = { ...own, personId: id }; }, effects: () => effects };
}
it('recovers only the own completed receipt without returning submitted parameters or repeating the effect', async () => {
  const f = await fixture(), id = randomUUID(); await f.send(id);
  const response = await f.read(id);
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toEqual({ commandId: id, name: 'notes.own.save', status: 'completed', job: null, result: { count: 1 } });
  expect(response.body).not.toContain('private-filter-value'); expect(f.effects()).toBe(1);
  await f.send(id); expect(f.effects()).toBe(1);
  f.person(randomUUID()); expect((await f.read(id)).statusCode).toBe(404);
  expect((await f.app.inject({ url: '/api/v1/commands/' + id, headers: { host: 'localhost' } })).statusCode).toBe(401);
});
it('recovers the original accepted job and distinguishes absence from an inaccessible installation command', async () => {
  const f = await fixture(), id = randomUUID(); const accepted = (await f.send(id, 'notes.own.wait', {})).json().data;
  expect((await f.read(id)).json().data).toEqual({ commandId: id, name: 'notes.own.wait', status: 'accepted', job: accepted, result: null });
  f.release(); await f.commands.idle(); expect((await f.read(id)).json().data).toMatchObject({ status: 'completed', result: { count: 1 } });
  const missing = randomUUID(); expect((await f.read(missing)).json().data).toEqual({ commandId: missing, name: null, status: 'not_found', job: null, result: null });
  const shared = randomUUID(); await f.send(shared, 'notes.installation.save', {}); expect((await f.read(shared)).statusCode).toBe(404);
});
it('resumes only an opted-in local auth-waiting command through the original validated execution and receipt', async () => {
  const f = await fixture(); let attempts = 0;
  const descriptor = { name: 'notes.own.resume', ownership: 'person' as const, manualAuthRecovery: true as const, capability: 'personal.write' as const, effect: 'local' as const, execution: 'async' as const, inputSchema: z.strictObject({}), outputSchema: z.strictObject({ attempts: z.number() }), handler: async (context: import('./command-registry').CommandContext) => {
    attempts++;
    if (attempts === 1) { const job = f.jobs.findByCommand(context.commandId, context.installationId)!; f.jobs.update(job.jobId, { status: 'waiting_user', retryAvailable: true }); throw Error('Manual auth required'); }
    return { result: { attempts }, changedRefs: [], editToken: null };
  } };
  f.commands.register(descriptor);
  const id = randomUUID(), accepted = (await f.send(id, descriptor.name, {})).json().data;
  await f.commands.idle();
  expect((await f.app.inject({ url: '/api/v1/jobs/' + accepted.jobId, headers: f.headers })).json().data.status).toBe('waiting_user');
  const retry = await f.send(randomUUID(), 'job.retry', { jobId: accepted.jobId });
  expect(retry.statusCode, retry.body).toBe(202); await f.commands.idle();
  expect((await f.read(id)).json().data).toMatchObject({ status: 'completed', result: { attempts: 2 } });
  await f.send(id, descriptor.name, {}); expect(attempts).toBe(2);
  expect(() => f.commands.register({ ...descriptor, name: 'notes.external.resume', effect: 'external' })).toThrow();
});
it('marks a pre-restart unfinished synchronous intent interrupted without blindly repeating its possible effect', async () => {
  const f = await fixture(), id = randomUUID();
  createCommandStore(f.repository).begin({ commandId: id, name: 'notes.own.save', baseRevision: null, payload: { text: 'private' } }, f.installationId, { scope: 'person', personId: f.personId });
  expect((await f.read(id)).json().data).toEqual({ commandId: id, name: 'notes.own.save', status: 'interrupted', job: null, result: null });
  expect(f.effects()).toBe(0);
});
