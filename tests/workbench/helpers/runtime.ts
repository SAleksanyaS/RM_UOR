import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWorkbenchRuntime } from '../../../src/server/workbench/bootstrap';
import { createWorkbenchApp } from '../../../src/server/workbench/app';
import type { WorkbenchRuntimeProviders } from '../../../src/server/workbench/runtime-contracts';
import type { CommandReconciliation, JobSnapshot, SessionView } from '../../../src/server/workbench/protocol';

export const codeRoot = fileURLToPath(new URL('../../../', import.meta.url));
export async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
/** HTTP driver owns a separate cookie jar. No direct HTTP response substitution. */
export function createHttpDriver(origin: string) {
  const cookies = new Map<string, string>(); let csrf = '';
  async function response(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('origin', origin);
    if (cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => key + '=' + value).join('; '));
    if ((init.method ?? 'GET') !== 'GET') headers.set('x-csrf-token', csrf);
    const reply = await fetch(origin + url, { ...init, headers });
    for (const cookie of reply.headers.getSetCookie()) { const pair = cookie.split(';')[0], index = pair.indexOf('='); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
    return reply;
  }
  async function read<T>(url: string, init?: RequestInit): Promise<T> {
    const reply = await response(url, init), body = await reply.json();
    if (!reply.ok) throw Error(reply.status + ' ' + JSON.stringify(body));
    return body.data as T;
  }
  async function session() { const value = await read<SessionView>('/api/v1/session'); csrf = value.csrfToken; return value; }
  async function query<T = any>(name: string, filter: Record<string, unknown> = {}, context: unknown = null) {
    if (!csrf) await session();
    return read<T>('/api/v1/queries/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context, filter, sort: [], page: { limit: 50, cursor: null } }) });
  }
  async function command(name: string, payload: Record<string, unknown>, baseRevision: string | null = null, commandId = randomUUID()): Promise<any> {
    if (!csrf) await session();
    return read('/api/v1/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId, name, payload, baseRevision }) });
  }
  return { response, read, session, query, command,
    reconcile: (id: string) => read<CommandReconciliation>('/api/v1/commands/' + id),
    job: (id: string) => read<JobSnapshot>('/api/v1/jobs/' + id),
    async settle(accepted: any): Promise<any> {
      if (!accepted.jobId) return accepted;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const job = await read<JobSnapshot>('/api/v1/jobs/' + accepted.jobId);
        if (['succeeded', 'failed', 'cancelled', 'partial'].includes(job.status)) {
          if (job.status !== 'succeeded') throw Error('Job did not succeed: ' + JSON.stringify(job));
          return { ...accepted, result: job.result };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error('Actual runtime job timed out: ' + accepted.jobId);
    },
  };
}
/** Two callers get independent disk databases, installation IDs and API listeners. */
export async function createLocalRuntime(providers: WorkbenchRuntimeProviders = {}) {
  const evidenceRoot = await realpath(tmpdir());
  const root = await mkdtemp(path.join(evidenceRoot, 't40-runtime-'));
  const api = await freePort(), ui = await freePort();
  await mkdir(path.join(root, 'config'));
  await writeFile(path.join(root, 'config/site.local.json'), JSON.stringify({ port: api, clientPort: ui, autoOpen: false, allowedWorkspaceRoots: [root], roleMode: 'local-preview' }));
  let runtime: Awaited<ReturnType<typeof createWorkbenchRuntime>> | undefined;
  let app: Awaited<ReturnType<typeof createWorkbenchApp>> | undefined;
  let stopped = false;
  async function stop() { if (stopped) return; stopped = true; if (app) await app.close(); if (runtime) await runtime.close(); }
  async function start() {
    stopped = false; runtime = undefined; app = undefined;
    runtime = await createWorkbenchRuntime({ projectRoot: root, codeRoot, providers });
    app = await createWorkbenchApp(runtime.deps, { configure: runtime.configure, deferActivation: true });
    await runtime.activate();
    await app.listen({ host: '127.0.0.1', port: api });
    stopped = false;
  }
  async function close() {
    await stop();
    const target = await realpath(root);
    if (path.dirname(target) !== evidenceRoot || !path.basename(target).startsWith('t40-runtime-')) throw Error('Invalid owned T40 runtime cleanup');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  try {
    await start();
    const origin = 'http://127.0.0.1:' + api;
    return { root, api, ui, origin, get runtime() { return runtime!; }, get app() { return app!; }, request: createHttpDriver(origin), stop, close, async restart() { await stop(); await start(); } };
  } catch (error) { await close(); throw error; }
}
