import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { afterEach, expect, it } from 'vitest';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { createWorkbenchApp } from './app';
import { createCommandRegistry } from './command-registry';
import { createJobStore } from './jobs';
import { QueryRegistry } from './query-registry';
import { createLocalSessionStore } from './session';
import { createFileStore, defaultFileLimits } from './files';
import type { AccessPolicyService, OwnAccessProfile } from '../../features/identity/workbench-access-policy';

const installationId = '11111111-1111-4111-8111-111111111111';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(role: OwnAccessProfile['role'] = 'curator') {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-upload-')), directory = path.join(root, 'private');
  const repository = createWorkbenchRepository({ filename: ':memory:', artifactRoot: root });
  const clock = { now: () => '2026-10-28T09:00:00Z' }; const own: OwnAccessProfile = { role, displayName: null, personId: null, policyState: 'verified', checkedAt: clock.now() };
  const accessPolicy: AccessPolicyService = { resolveOwnAccess: async () => own, assertCommandAllowed: async () => own, assertFreshPublishAllowed: async () => own };
  const jobs = createJobStore({ repository, clock }), commands = createCommandRegistry({ repository, jobs, accessPolicy }), files = createFileStore({ directory, limits: defaultFileLimits });
  const app = await createWorkbenchApp({ hostname: () => 'synthetic-host', installationId, repository, clock, accessPolicy, commands, jobs, queries: new QueryRegistry(), modules: [], files, sessions: createLocalSessionStore({ clock }), allowedOrigins: ['http://localhost:5173'] });
  cleanups.push(async () => { await app.close(); repository.close(); if (!path.basename(root).startsWith('wb-upload-')) throw Error('Unsafe cleanup'); await rm(root, { recursive: true, force: true }); });
  const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { host: 'localhost' } });
  const headers = { host: 'localhost', origin: 'http://localhost:5173', cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().data.csrfToken, 'content-type': 'multipart/form-data; boundary=synthetic-boundary' };
  return { app, files, directory, headers, post: (payload: Buffer, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...headers, ...extra }, payload }), stored: async () => readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; }) };
}
const field = (name: string, value: string) => Buffer.from('--synthetic-boundary\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n');
const file = (bytes: Uint8Array = Buffer.from('product,value\ndemo,92.00\n'), name = 'input.csv', mime = 'text/csv') => Buffer.concat([Buffer.from('--synthetic-boundary\r\nContent-Disposition: form-data; name="file"; filename="' + name + '"\r\nContent-Type: ' + mime + '\r\n\r\n'), bytes, Buffer.from('\r\n')]);
const body = (parts: Buffer[]) => Buffer.concat([...parts, Buffer.from('--synthetic-boundary--\r\n')]);
it('streams_either_field_order_and_returns_exact_201_envelope_and_owned_handle', async () => {
  const f = await fixture();
  for (const parts of [[field('purpose', 'goal-import'), file()], [file(), field('purpose', 'goal-import')]]) {
    const response = await f.post(body(parts)); expect(response.statusCode).toBe(201);
    const result = response.json(); expect(Object.keys(result).sort()).toEqual(['apiVersion', 'data', 'meta', 'requestId']);
    expect(Object.keys(result.data).sort()).toEqual(['bytes', 'fileHandle', 'mediaType', 'name', 'sha256']);
    expect(result.data).toMatchObject({ bytes: 25, mediaType: 'text/csv', name: 'input.csv' });
    expect(Buffer.from((await f.files.read(result.data.fileHandle, installationId, 'goal-import', null)).bytesValue).toString()).toBe('product,value\ndemo,92.00\n');
    expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['x-request-id']).toBe(result.requestId);
    expect((await f.app.inject({ method: 'GET', url: '/api/v1/files/' + result.data.fileHandle, headers: { host: 'localhost' } })).statusCode).toBe(404);
  }
});
it('rejects_json_client_path_and_malformed_duplicate_extra_parts_without_finalizing', async () => {
  const f = await fixture();
  expect((await f.post(Buffer.from(JSON.stringify({ path: 'C:\\private\\input.xlsx', purpose: 'goal-import' })), { 'content-type': 'application/json' })).statusCode).toBe(422);
  for (const payload of [body([file()]), body([field('purpose', 'goal-import')]), body([field('purpose', 'goal-import'), file(), field('extra', 'x')]), body([field('purpose', 'goal-import'), file(), file()]), body([field('purpose', 'goal-import'), file(), field('purpose', 'evidence')]), body([file(), field('purpose', 'goal-import')]).subarray(0, -15)]) {
    expect((await f.post(payload)).statusCode).toBe(422); expect(await f.stored()).toEqual([]);
  }
});
it('enforces_session_csrf_origin_loopback_and_role_purpose_guards', async () => {
  const f = await fixture('viewer'); const payload = body([field('purpose', 'goal-import'), file()]);
  for (const [extra, status] of [[{ cookie: '' }, 401], [{ 'x-csrf-token': '' }, 403], [{ origin: 'https://other.invalid' }, 403], [{ host: 'remote.invalid' }, 403]] as Array<[Record<string, string>, number]>) expect((await f.post(payload, extra)).statusCode).toBe(status);
  expect((await f.post(payload)).statusCode).toBe(403);
  expect((await f.post(body([field('purpose', 'evidence'), file()]))).statusCode).toBe(403); expect(await f.stored()).toEqual([]);
  const zip = new JSZip(); zip.file('manifest.json', '{}'); zip.file('records.json', '[]');
  const response = await f.post(body([file(await zip.generateAsync({ type: 'nodebuffer' }), 'backup.zip', 'application/zip'), field('purpose', 'workspace-restore')]));
  expect(response.statusCode).toBe(201); expect((await f.files.read(response.json().data.fileHandle, installationId, 'workspace-restore', null)).purpose).toBe('workspace-restore');
});
it('accepts_32MiB_evidence_over_real_transport_and_rejects_goal_profile_overflow', async () => {
  const f = await fixture();
  expect((await f.post(body([file(Buffer.alloc(32 * 1024 ** 2, 97), 'proof.txt', 'text/plain'), field('purpose', 'evidence')]))).statusCode).toBe(201);
  const response = await f.post(body([file(Buffer.alloc(10 * 1024 ** 2 + 1, 97)), field('purpose', 'goal-import')])); expect(response.statusCode).toBe(413); expect(await f.stored()).toHaveLength(1);
});
it('rejects_multipart_client_paths_and_spoofed_content_without_final_handle', async () => {
  const f = await fixture();
  for (const part of [file(Buffer.from('a,b\n1,2'), 'C:\\private\\input.csv'), file(Buffer.from('MZ\0exe'), 'input.csv'), file(Buffer.from('not a PNG'), 'proof.png', 'image/png')]) {
    expect((await f.post(body([field('purpose', 'evidence'), part]))).statusCode).toBe(422); expect(await f.stored()).toEqual([]);
  }
});
it('does_not_finalize_a_handle_when_the_incoming_http_stream_fails', async () => {
  const f = await fixture();
  async function* broken() { yield field('purpose', 'goal-import'); yield file(); throw Error('synthetic transport interruption'); }
  await f.app.inject({ method: 'POST', url: '/api/v1/files', headers: f.headers, payload: Readable.from(broken()) }).catch(() => undefined);
  expect(await f.stored()).toEqual([]);
});
