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
import type { BrowserResultArtifact, LocalRequest, WorkbenchHttpPort } from './routes';
import type { LocalSessionStore } from './session';
import type { EvidenceService } from '../../features/evidence/workbench-evidence';
import type { MaintenanceService } from '../../features/workspace-maintenance/workbench/maintenance-service';
import type { NotificationRuntime } from '../../features/execution/workbench-notification-runtime';
import { globalContextSchema, WorkbenchHttpError, type ApiSuccess, type GlobalContext, type Meta } from './protocol';
import { registerWorkbenchQueries } from '../../features/catalog/workbench-query-registration';
import type { WorkbenchReadPorts } from '../../features/catalog/workbench-read-models';
import { assertContextGraph } from '../../features/catalog/workbench-search';
import { moscowLocalDate } from '../../features/execution/workbench-reminders';
import { pageResultSchema } from './protocol';

export type WorkbenchApplicationDeps = {
  maintenance?:Pick<MaintenanceService,'getBackupFile'>&Partial<Pick<MaintenanceService,'recover'>>;
  notifications?: Pick<NotificationRuntime, 'start' | 'stop'>;
  evidence?: Pick<EvidenceService, 'readArtifactForContext'>;
  hostname: () => string; repository: WorkbenchRepository; clock: Clock; accessPolicy: AccessPolicyService;
  commands: CommandRegistry; queries: QueryRegistry; jobs: JobStore; modules: PlatformModule[];
  sessions: LocalSessionStore; allowedOrigins: string[]; installationId: UUIDv4; files: FileStore;
  // T21/T22 bind these narrow reads when catalog/publication read models exist.
  readState?: { defaultContext(context: QueryContext): Promise<GlobalContext | null>; publishedCommit(): string | null };
  queryPorts?:WorkbenchReadPorts;
  browserResults?: { read(context: QueryContext, resultId: UUIDv4, kind: 'original' | 'enriched'): Promise<BrowserResultArtifact> };
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
  if(deps.queryPorts) registerWorkbenchQueries(deps.queries,deps.queryPorts);
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
    let defaultContext = deps.readState ? await deps.readState.defaultContext(ctx) : null;
    if(!deps.readState && deps.queryPorts) {
      const saved=deps.queryPorts.preferences?.get(ctx.installationId).context;
      if(saved) {try {assertContextGraph(saved,deps.queryPorts.index);defaultContext=saved;}catch { /* An old preference cannot invent a valid current path. */ }}
      if(!defaultContext) {
        const dit=deps.queryPorts.index.list('directory_entity').find(entity=>entity.kind==='dit');
        if(dit) defaultContext={scopePath:{ditId:dit.id,clusterId:null,productId:null,teamId:null},goalId:null,time:{kind:'as_of',date:moscowLocalDate(ctx.clock.now())},resultMode:'current',snapshotId:null};
      }
    }
    return { ...own, allowedCommands: deps.commands.listNames().filter(name => { const capability = deps.commands.getCapability(name); return capability !== null && canUseCapability(own, capability); }), csrfToken: local.csrfToken, defaultContext: defaultContext === null ? null : globalContextSchema.parse(defaultContext) };
  };
  return {
    async backupFile(id,local){const ctx=await context(local);if(!deps.maintenance)throw new WorkbenchHttpError(404,'BACKUP_NOT_FOUND','Backup not found');return deps.maintenance.getBackupFile(ctx,id);},
    async artifact(artifactId, local) { const ctx = await context(local); if (!deps.evidence) throw new WorkbenchHttpError(404, 'ARTIFACT_NOT_FOUND', 'Evidence artifact not found'); return deps.evidence.readArtifactForContext(ctx, artifactId); },
    session, refreshSession: session, meta,
    async upload(input, request) {
      const ctx = await context(request);
      const purpose = filePurposeSchema.safeParse(input.purpose); if (!purpose.success) throw new WorkbenchHttpError(422, 'VALIDATION_FAILED', 'Invalid file purpose');
      if (!canUseCapability(ctx.ownAccess, purpose.data === 'workspace-restore' ? 'workspace.backup' : 'uor.prepare')) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'The current own profile does not permit this upload');
      return envelope(await deps.files.stage({ ...input, purpose: purpose.data, installationId: deps.installationId, profilePersonId: ctx.ownAccess.personId }), request);
    },
    async query(name, request, local) {
      const ctx = await context(local);const data=await deps.queries.execute(name,request,ctx);
      const response=await envelope(data,local);
      const page=pageResultSchema.safeParse(data && typeof data==='object' && 'page' in data?data.page:undefined);
      if(page.success) response.meta.page=page.data;
      return response;
    },
    async browserResult(resultId, kind, local) {
      const ctx = await context(local);
      if (!deps.browserResults) throw new WorkbenchHttpError(404, 'RESULT_NOT_FOUND', 'Result not found');
      return deps.browserResults.read(ctx, resultId, kind);
    },
    async command(request, local) {
      const ctx = await context(local);
      const hostname = deps.hostname(); if (!hostname.trim()) throw new WorkbenchHttpError(503, 'HOSTNAME_UNAVAILABLE', 'Server hostname is unavailable');
      const actor = { hostname, installationId: deps.installationId, profilePersonId: ctx.ownAccess.personId };
      return envelope(await deps.commands.execute(request, { ...ctx, commandId: request.commandId, actor }), local);
    },
    async reconcileCommand(id, request) {
      const ctx = await context(request);
      if (!deps.commands.reconcileCommand) throw new WorkbenchHttpError(404, 'COMMAND_NOT_FOUND', 'Own command not found');
      return envelope(deps.commands.reconcileCommand(id, ctx), request);
    },
    async job(id, request) { const ctx = await context(request); await deps.commands.assertJobAccess?.(id, ctx); const job = deps.jobs.get(id, deps.installationId); if (!job) throw new WorkbenchHttpError(404, 'JOB_NOT_FOUND', 'Job not found'); return envelope(job, request); },
  };
}
