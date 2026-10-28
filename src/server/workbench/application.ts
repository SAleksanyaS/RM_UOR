import type { Clock, UUIDv4 } from '../../domain/workbench/index';
import { newUuid } from '../../domain/workbench/primitives';
import { canUseCapability, type AccessPolicyService } from '../../features/identity/workbench-access-policy';
import { installHistoryIndex } from '../../features/history/workbench-history-index';
import type { WorkbenchRepository } from '../storage/workbench-repository';
import type { CommandRegistry } from './command-registry';
import type { JobStore } from './jobs';
import { filePurposeSchema, type FileStore } from './files';
import { validateModules, type PlatformModule } from './modules';
import type { QueryContext, QueryRegistry } from './query-registry';
import type { LocalRequest, WorkbenchHttpPort } from './routes';
import type { LocalSessionStore } from './session';
import { globalContextSchema, WorkbenchHttpError, type ApiSuccess, type GlobalContext, type Meta } from './protocol';

export type WorkbenchApplicationDeps = {
  hostname: () => string; repository: WorkbenchRepository; clock: Clock; accessPolicy: AccessPolicyService;
  commands: CommandRegistry; queries: QueryRegistry; jobs: JobStore; modules: PlatformModule[];
  sessions: LocalSessionStore; allowedOrigins: string[]; installationId: UUIDv4; files: FileStore;
  // T21/T22 bind these narrow reads when catalog/publication read models exist.
  readState?: { defaultContext(context: QueryContext): Promise<GlobalContext | null>; publishedCommit(): string | null };
};

/** Startup uses the current installation and hostname, without restoring a session or an old grant. */
export async function recoverWorkbenchCommands(deps: WorkbenchApplicationDeps): Promise<void> {
  await deps.commands.recoverPending(deps.installationId, async identity => {
    if (identity.installationId !== deps.installationId) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found');
    const hostname = deps.hostname();
    if (!hostname.trim()) throw new WorkbenchHttpError(503, 'HOSTNAME_UNAVAILABLE', 'Server hostname is unavailable');
    const ownAccess = await deps.accessPolicy.resolveOwnAccess();
    return {
      requestId: newUuid(), commandId: identity.commandId, installationId: deps.installationId,
      repository: deps.repository, clock: deps.clock, ownAccess,
      actor: { hostname, installationId: deps.installationId, profilePersonId: ownAccess.personId },
    };
  });
}

export function createWorkbenchApplication(deps: WorkbenchApplicationDeps): WorkbenchHttpPort {
  // Validate the entire import graph before installing projections or descriptors.
  validateModules(deps.modules);
  installHistoryIndex(deps.repository);
  for (const module of deps.modules) {
    for (const query of module.queries) deps.queries.register(query);
    for (const command of module.commands) deps.commands.register(command);
  }
  const assertSession = (request: LocalRequest) => { const session = deps.sessions.get(request.sessionId); if (!session) throw new WorkbenchHttpError(401, 'SESSION_REQUIRED', 'A local session is required'); return session; };
  const context = async (request: LocalRequest): Promise<QueryContext> => { assertSession(request); return { requestId: request.requestId, installationId: deps.installationId, repository: deps.repository, clock: deps.clock, ownAccess: await deps.accessPolicy.resolveOwnAccess() }; };
  const meta = async (request: LocalRequest): Promise<Meta> => { assertSession(request); return { generatedAt: deps.clock.now(), publishedCommit: deps.readState?.publishedCommit() ?? null, stateRevision: deps.repository.getStateRevision(), warnings: [] }; };
  const envelope = async <T>(data: T, request: LocalRequest): Promise<ApiSuccess<T>> => ({ apiVersion: '1', requestId: request.requestId, data, meta: await meta(request) });
  const session = async (request: LocalRequest) => {
    const local = assertSession(request); const ctx = await context(request); const own = ctx.ownAccess;
    const defaultContext = deps.readState ? await deps.readState.defaultContext(ctx) : null;
    return { ...own, allowedCommands: deps.commands.listNames().filter(name => { const capability = deps.commands.getCapability(name); return capability !== null && canUseCapability(own, capability); }), csrfToken: local.csrfToken, defaultContext: defaultContext === null ? null : globalContextSchema.parse(defaultContext) };
  };
  return {
    session, refreshSession: session, meta,
    async upload(input, request) {
      const ctx = await context(request);
      const purpose = filePurposeSchema.safeParse(input.purpose); if (!purpose.success) throw new WorkbenchHttpError(422, 'VALIDATION_FAILED', 'Invalid file purpose');
      if (!canUseCapability(ctx.ownAccess, purpose.data === 'workspace-restore' ? 'workspace.backup' : 'uor.prepare')) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'The current own profile does not permit this upload');
      return envelope(await deps.files.stage({ ...input, purpose: purpose.data, installationId: deps.installationId }), request);
    },
    async query(name, request, local) { const ctx = await context(local); return envelope(await deps.queries.execute(name, request, ctx), local); },
    async command(request, local) {
      const ctx = await context(local);
      const hostname = deps.hostname(); if (!hostname.trim()) throw new WorkbenchHttpError(503, 'HOSTNAME_UNAVAILABLE', 'Server hostname is unavailable');
      const actor = { hostname, installationId: deps.installationId, profilePersonId: ctx.ownAccess.personId };
      return envelope(await deps.commands.execute(request, { ...ctx, commandId: request.commandId, actor }), local);
    },
    async job(id, request) { assertSession(request); const job = deps.jobs.get(id, deps.installationId); if (!job) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found'); return envelope(job, request); },
  };
}
