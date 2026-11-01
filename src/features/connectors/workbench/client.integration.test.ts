import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createWorkbenchApp } from '../../../server/workbench/app';
import { createCommandRegistry } from '../../../server/workbench/command-registry';
import { createJobStore } from '../../../server/workbench/jobs';
import { QueryRegistry } from '../../../server/workbench/query-registry';
import { createFileStore, defaultFileLimits } from '../../../server/workbench/files';
import { createLocalSessionStore } from '../../../server/workbench/session';
import { createBrowserProfileService } from '../workbench-browser-profile';
import { createOkoWorkflowService } from '../workbench-workflow-service';
import { createOkoWorkflowModule } from '../workbench-workflow-module';
import type { BrowserWorkflowRuntimePort } from '../workbench-browser-runtime';
import type { AccessPolicyService } from '../../identity/workbench-access-policy';
import { OkoClient } from './client';

it('client creates and reopens a real own workflow through actual v1 HTTP, SQLite and cookie/CSRF transport', async () => {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'uor-oko-client-'));
  const repository = createWorkbenchRepository({ filename: ':memory:', artifactRoot: root });
  const clock = { now: () => '2026-10-28T10:00:00Z' }, installationId = randomUUID();
  // Explicit synthetic policy exists only in this integration test; runtime paths and HTTP are real.
  const own = { role: 'curator' as const, personId: randomUUID(), displayName: 'Тестовый куратор', policyState: 'verified' as const, checkedAt: clock.now() };
  const accessPolicy: AccessPolicyService = { resolveOwnAccess: async () => own, assertCommandAllowed: async () => own, assertFreshPublishAllowed: async () => { throw new Error('No publishing in this test'); } };
  const jobs = createJobStore({ repository, clock }), commands = createCommandRegistry({ repository, jobs, accessPolicy });
  const files = createFileStore({ directory: path.join(root, 'files'), limits: defaultFileLimits });
  const profiles = createBrowserProfileService({ runtimeRoot: root, repository, clock });
  // No browser API is called by workflow creation; any accidental call fails rather than faking success.
  const service = createOkoWorkflowService({ repository, files, profiles, jobs, clock, runtime: {} as BrowserWorkflowRuntimePort });
  const app = await createWorkbenchApp({ repository, clock, hostname: () => 'test-host', installationId, accessPolicy, jobs, commands, files, queries: new QueryRegistry(), modules: [createOkoWorkflowModule({ service })], sessions: createLocalSessionStore({ clock }), allowedOrigins: ['http://127.0.0.1:5173'] });
  let cookie = '';
  const client = new OkoClient((async (url, init) => {
    const response = await app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url: String(url), headers: { host: '127.0.0.1:4174', origin: 'http://127.0.0.1:5173', ...Object.fromEntries(new Headers(init?.headers).entries()), ...(cookie ? { cookie } : {}) }, ...(init?.body ? { payload: String(init.body) } : {}), remoteAddress: '127.0.0.1' });
    const setCookie = response.headers['set-cookie']; if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  try {
    expect((await client.session()).allowedCommands).toContain('source.browser.workflow.open');
    expect((await client.workspace()).current).toBeNull();
    const opened = await client.command('source.browser.workflow.open', { title: 'Мой отчёт' });
    expect(opened).toMatchObject({ title: 'Мой отчёт', reportUrl: '', result: null });
    if ('jobId' in opened) throw Error('Unexpected asynchronous create');
    expect((await client.workspace(opened.workflowId)).current).toMatchObject({ workflowId: opened.workflowId, title: 'Мой отчёт' });
    await expect(client.command('source.browser.record.start', { workflowId: opened.workflowId, expectedRevision: 'stale', reportUrl: 'https://report.example', parsingProfile: opened.parsingProfile })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await client.workspace(opened.workflowId)).current?.revision).toBe(opened.revision);
  } finally { await app.close(); repository.close(); const target = path.resolve(root); if (!target.startsWith(path.resolve(realpathSync.native(tmpdir())) + path.sep) || !path.basename(target).startsWith('uor-oko-client-')) throw Error('Invalid test cleanup'); rmSync(target, { recursive: true, force: true }); }
});
