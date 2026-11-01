import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createWorkbenchRepository } from '../../../src/server/storage/workbench-repository';
import { createCommandRegistry } from '../../../src/server/workbench/command-registry';
import { createJobStore } from '../../../src/server/workbench/jobs';
import { QueryRegistry } from '../../../src/server/workbench/query-registry';
import { createLocalSessionStore } from '../../../src/server/workbench/session';
import { createFileStore, defaultFileLimits } from '../../../src/server/workbench/files';
import { createWorkbenchApp } from '../../../src/server/workbench/app';
import { createLocalPreviewPolicy } from '../../../src/server/workbench/oko-local-role';
import { createBrowserProfileService } from '../../../src/features/connectors/workbench-browser-profile';
import { createOkoWorkflowService } from '../../../src/features/connectors/workbench-workflow-service';
import { createOkoWorkflowModule } from '../../../src/features/connectors/workbench-workflow-module';
import { createPreferencesService } from '../../../src/features/system/workbench-preferences';
import { registerPreferencesQueries } from '../../../src/features/system/workbench-preferences-query';
import type { BrowserWorkflowRuntimePort } from '../../../src/features/connectors/workbench-browser-runtime';

export async function createPersonalRuntime(prefix: 'source.browser' | 'oko.workflow' = 'oko.workflow') {
  const temp = await realpath(tmpdir()), root = await mkdtemp(path.join(temp, 'uor-personal-prefix-'));
  const repository = createWorkbenchRepository({ filename: path.join(root, 'subject.sqlite'), artifactRoot: path.join(root, 'files') });
  const clock = { now: () => '2026-11-01T09:00:00.000Z' }, installationId = randomUUID(), personId = randomUUID();
  const jobs = createJobStore({ repository, clock });
  let commands!: ReturnType<typeof createCommandRegistry>;
  const policy = createLocalPreviewPolicy({ directory: root, personId, clock, capabilityFor: name => commands.getCapability(name)! });
  commands = createCommandRegistry({ repository, jobs, accessPolicy: policy });
  commands.register({ name: 'workbench.role.set', capability: 'personal.write', effect: 'local', execution: 'sync', ownership: 'person', inputSchema: z.strictObject({ role: z.enum(['viewer', 'curator']) }), outputSchema: z.strictObject({ role: z.enum(['viewer', 'curator']), mode: z.literal('local-preview') }), handler: async (_context, input) => { await policy.setRole(input.role); return { result: { role: input.role, mode: 'local-preview' as const }, changedRefs: [], editToken: null }; } });
  const files = createFileStore({ directory: path.join(root, 'uploads'), limits: defaultFileLimits });
  // No browser action is used by these namespace/empty-workspace tests.
  const runtime = {} as BrowserWorkflowRuntimePort;
  const profiles = createBrowserProfileService({ runtimeRoot: root, repository, clock });
  const service = createOkoWorkflowService({ repository, files, profiles, jobs, clock, runtime });
  const preferences = createPreferencesService({ repository, installationId, clock });
  const queries = new QueryRegistry(); registerPreferencesQueries(queries, preferences);
  const app = await createWorkbenchApp({ repository, clock, installationId, hostname: () => 'synthetic-prefix-host', accessPolicy: policy, commands, jobs, files, queries, modules: [createOkoWorkflowModule({ service, prefix })], sessions: createLocalSessionStore({ clock }), allowedOrigins: ['http://127.0.0.1:5173'] });
  const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [], cookies = new Map<string, string>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://127.0.0.1:5173');
    if (url.origin !== 'http://127.0.0.1:5173') throw Error('External fixture request rejected');
    const headers = new Headers(init?.headers); headers.set('origin', url.origin);
    if (cookies.size) headers.set('cookie', [...cookies].map(([name, value]) => name + '=' + value).join('; '));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
    requests.push({ url: url.pathname, body });
    const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: url.pathname + url.search, headers: Object.fromEntries(headers), ...(typeof init?.body === 'string' ? { payload: init.body } : {}) });
    for (const cookie of response.cookies) cookies.set(cookie.name, cookie.value);
    const resultHeaders = new Headers(); for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) resultHeaders.set(name, Array.isArray(value) ? value.join(',') : String(value));
    return new Response(new Uint8Array(response.rawPayload), { status: response.statusCode, headers: resultHeaders });
  };
  let closed = false;
  return { app, repository, commands, installationId, personId, requests, fetcher, async close() { if (closed) return; closed = true; await app.close(); repository.close(); const target = path.resolve(root); if (path.dirname(target) !== path.resolve(temp) || !path.basename(target).startsWith('uor-personal-prefix-')) throw Error('Unsafe fixture cleanup'); await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}
