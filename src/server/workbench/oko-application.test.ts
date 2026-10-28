import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createOkoApplication } from './oko-application';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('starts a real empty installation without manufacturing curator access or business scope', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uor-oko-application-'));
  mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist', 'oko.html'), '<html><title>ОКО</title><div id="root"></div></html>');
  mkdirSync(path.join(root, 'config')); writeFileSync(path.join(root, 'config', 'oko.local.json'), JSON.stringify({ roleMode: 'registry' }));
  const instance = await createOkoApplication({ projectRoot: root });
  cleanup.push(async () => { await instance.close(); if (!path.basename(root).startsWith('uor-oko-application-')) throw Error('Unsafe fixture cleanup'); rmSync(root, { recursive: true, force: true }); });
  const session = await instance.app.inject({ method: 'GET', url: '/api/v1/session', headers: { host: 'localhost' } });
  expect(session.statusCode).toBe(200); expect(session.json().data).toMatchObject({ role: 'viewer', policyState: 'unavailable', defaultContext: null });
  expect(session.json().data.allowedCommands).not.toContain('source.browser.record.start');
  const cookie = String(session.headers['set-cookie']).split(';')[0];
  const workspace = await instance.app.inject({ method: 'POST', url: '/api/v1/queries/source.browser.workspace', headers: { host: 'localhost', origin: 'http://127.0.0.1:5175', cookie }, payload: { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } } });
  expect(workspace.statusCode).toBe(200); expect(workspace.json().data).toMatchObject({ workflows: [], current: null, setup: { registryConfigured: false } });
  expect((await instance.app.inject({ url: '/oko.html', headers: { host: 'localhost' } })).body).toContain('<title>ОКО</title>');
  expect((await instance.app.inject({ url: '/.runtime/workbench/installation.json', headers: { host: 'localhost' } })).statusCode).toBe(404);
});

it('offers an explicit temporary reader/editor switch without a registry or a publication grant', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uor-oko-application-'));
  const instance = await createOkoApplication({ projectRoot: root });
  cleanup.push(async () => { await instance.close(); if (!path.basename(root).startsWith('uor-oko-application-')) throw Error('Unsafe fixture cleanup'); rmSync(root, { recursive: true, force: true }); });
  const session = await instance.app.inject({ url: '/api/v1/session', headers: { host: 'localhost' } });
  expect(session.json().data).toMatchObject({ role: 'curator', policyState: 'local_preview' });
  expect(session.json().data.allowedCommands).toContain('source.browser.record.start');
  const headers = { host: 'localhost', origin: 'http://127.0.0.1:5175', cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().data.csrfToken };
  const switchRole = (role: string) => instance.app.inject({ method: 'POST', url: '/api/v1/commands', headers, payload: { commandId: crypto.randomUUID(), name: 'source.browser.role.set', baseRevision: null, payload: { role } } });
  expect((await switchRole('viewer')).statusCode).toBe(200);
  const viewer = await instance.app.inject({ url: '/api/v1/session', headers });
  expect(viewer.json().data).toMatchObject({ role: 'viewer', policyState: 'local_preview', personId: session.json().data.personId });
  expect(viewer.json().data.allowedCommands).not.toContain('source.browser.record.start');
  expect((await switchRole('chief')).statusCode).toBe(422);
  expect((await switchRole('curator')).statusCode).toBe(200);
});
