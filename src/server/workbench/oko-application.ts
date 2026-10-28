import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidSchema } from '../../domain/workbench/primitives';
import { createAccessPolicyService, createUnavailableRegistryReadPort, canUseCapability } from '../../features/identity/workbench-access-policy';
import { createOwnPolicyCache } from '../../features/identity/workbench-policy-cache';
import { createBrowserRuntime } from '../../features/connectors/workbench-browser-runtime';
import type { BrowserLauncherPort } from '../../features/connectors/browser';
import { createBrowserProfileService } from '../../features/connectors/workbench-browser-profile';
import { createOkoWorkflowService } from '../../features/connectors/workbench-workflow-service';
import { createOkoWorkflowModule } from '../../features/connectors/workbench-workflow-module';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { safeArtifactPath } from '../workspace/paths';
import { createWorkbenchApp } from './app';
import { createCommandRegistry } from './command-registry';
import { createJobStore } from './jobs';
import { QueryRegistry } from './query-registry';
import { createLocalSessionStore } from './session';
import { createFileStore, defaultFileLimits } from './files';
import { WorkbenchHttpError } from './protocol';
import { createAcceptedGitRegistry } from './oko-registry';
import { loadOkoConfiguration } from './oko-config';
import { createLocalPreviewPolicy } from './oko-local-role';
import type { PlatformModule } from './modules';

async function staticEntry(app: FastifyInstance, root: string) {
  const dist = path.join(root, 'dist');
  const serve = async (name: string, reply: import('fastify').FastifyReply) => {
    try {
      const file = await safeArtifactPath(dist, name), bytes = await readFile(file);
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'application/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      return reply.header('content-type', type).header('x-content-type-options', 'nosniff').header('cache-control', 'no-store').send(bytes);
    } catch { return reply.code(404).send('Файл интерфейса не найден. Выполните npm run build.'); }
  };
  const local = (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, done: () => void) => {
    const host = request.headers.host ?? '';
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) { void reply.code(403).send('Local host required'); return; } done();
  };
  app.get('/', { preHandler: local }, async (_request, reply) => reply.redirect('/oko.html'));
  app.get('/oko.html', { preHandler: local }, async (_request, reply) => serve('oko.html', reply));
  app.get<{ Params: { '*': string } }>('/assets/*', { preHandler: local }, async (request, reply) => {
    const name = request.params['*']; if (!/^[A-Za-z0-9_.-]+\.(?:js|css|png|svg|woff2?|ttf|ico)$/.test(name)) return reply.code(404).send('Not found');
    return serve('assets/' + name, reply);
  });
}

/** Real isolated UI composition. No demo policy, catalog, scenario, source facts or legacy startup. */
export async function createOkoApplication({ projectRoot, browserLauncher }: { projectRoot: string; browserLauncher?: BrowserLauncherPort }) {
  const root = await realpath(projectRoot), config = await loadOkoConfiguration(root);
  try {
    const site = JSON.parse(await readFile(path.join(root, 'config/site.local.json'), 'utf8')) as { allowedWorkspaceRoots?: string[] };
    if (site.allowedWorkspaceRoots) {
      const roots = await Promise.all(site.allowedWorkspaceRoots.map(value => realpath(value)));
      if (!roots.some(allowed => { const rel = path.relative(allowed, root); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); })) throw Error('Workspace is outside configured allowed roots');
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const directory of ['.runtime', '.runtime/workbench']) {
    const full = path.join(root, directory); await mkdir(full, { recursive: true }); if ((await lstat(full)).isSymbolicLink()) throw Error('Runtime cannot be a junction or symlink');
  }
  const runtimeRoot = await safeArtifactPath(root, '.runtime/workbench');
  const identityPath = await safeArtifactPath(runtimeRoot, 'installation.json');
  let installationId: string;
  try { installationId = uuidSchema.parse(JSON.parse(await readFile(identityPath, 'utf8')).installationId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; installationId = randomUUID(); await writeFile(identityPath, JSON.stringify({ installationId }), { flag: 'wx', mode: 0o600 }); }
  const clock = { now: () => new Date().toISOString() }, repository = createWorkbenchRepository({ filename: path.join(runtimeRoot, 'workbench.sqlite'), artifactRoot: path.join(runtimeRoot, 'artifacts') });
  let commands: ReturnType<typeof createCommandRegistry>;
  const capabilityFor = (name: string) => commands?.getCapability(name) ?? 'uor.prepare';
  const localPolicy = config.roleMode === 'local-preview' ? await createLocalPreviewPolicy({ directory: runtimeRoot, personId: installationId, clock, capabilityFor }) : null;
  const accessPolicy = localPolicy ?? createAccessPolicyService({ hostname, registry: config.registry ? createAcceptedGitRegistry(config.registry) : createUnavailableRegistryReadPort(), cache: createOwnPolicyCache({ directory: path.join(runtimeRoot, 'own-policy-cache') }), installationId, mainRepositoryId: config.mainRepositoryId, serviceRepositoryId: config.registry?.repositoryId ?? 'registry-not-configured', clock, capabilityFor });
  const jobs = createJobStore({ repository, clock }); commands = createCommandRegistry({ repository, jobs, accessPolicy });
  const runtime = createBrowserRuntime({ runtimeRoot, launcher: browserLauncher }), profiles = createBrowserProfileService({ runtimeRoot, repository, clock });
  const files = createFileStore({ directory: path.join(runtimeRoot, 'uploads'), limits: defaultFileLimits });
  const workflow = createOkoWorkflowService({ repository, runtime, profiles, files, jobs, clock,
    setup: () => ({ hostname: hostname(), registryConfigured: config.roleMode === 'registry' && config.registry !== null, message: localPolicy ? 'Временный режим: переключайтесь между читателем и редактором в правом верхнем углу.' : config.registry ? null : 'Реестр допуска не подключён. Инструкция: docs/OKO_WORKFLOW.md. Для временного переключения ролей выберите roleMode: local-preview в config/oko.local.json.' }),
    recheckGuard: async context => { const own = await accessPolicy.resolveOwnAccess(); if (!canUseCapability(own, 'uor.prepare') || own.personId !== context.ownAccess.personId) throw new WorkbenchHttpError(403, 'ACCESS_RECHECK_REQUIRED', 'Допуск изменился во время операции. Результат не сохранён.'); },
  });
  const roleModule: PlatformModule[] = localPolicy ? [{ id: 'oko-local-access', version: '1.0.0', platformContractVersion: 1, dependsOn: [], owns: { entityTypes: [], namespaces: ['oko-local-access'] }, schemas: [], hooks: {}, queries: [], commands: [{ name: 'source.browser.role.set', ownership: 'person', capability: 'personal.write', effect: 'local', execution: 'sync', inputSchema: z.strictObject({ role: z.enum(['viewer', 'curator']) }), outputSchema: z.strictObject({ role: z.enum(['viewer', 'curator']), mode: z.literal('local-preview') }), handler: async (_context, input) => { await localPolicy.setRole(input.role); return { result: { role: input.role, mode: 'local-preview' as const }, changedRefs: [], editToken: null }; } }] }] : [];
  let closed = false;
  const app = await createWorkbenchApp({ repository, clock, hostname, accessPolicy, commands, jobs, queries: new QueryRegistry(), files, sessions: createLocalSessionStore({ clock }), modules: [createOkoWorkflowModule({ service: workflow }), ...roleModule], installationId,
    allowedOrigins: [`http://127.0.0.1:${config.clientPort}`, `http://localhost:${config.clientPort}`, `http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`],
    browserResults: { read: workflow.readResult },
  }, { configure: app => staticEntry(app, root) });
  const close = async () => {
    if (closed) return; closed = true;
    for (const candidate of jobs.recoveryCandidates(installationId)) if (!['succeeded', 'partial', 'failed', 'cancelled'].includes(candidate.snapshot.status)) await jobs.cancel(candidate.snapshot.jobId, installationId).catch(() => {});
    if ('shutdown' in workflow && typeof workflow.shutdown === 'function') await workflow.shutdown();
    await commands.idle(); await app.close(); repository.close();
  };
  return { app, repository, workflow, runtime, installationId, config, close };
}
