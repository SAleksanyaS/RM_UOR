import { randomUUID, createHash } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { CoreGoalDefinition, GoalAssignment, SourceDefinition, SourceFieldMapping, MethodVersion, Template, DirectoryEntity, DirectoryLink } from '../../domain/workbench/entities';
import type { Header } from '../../domain/workbench/primitives';
import { APP_VERSION } from '../../domain/app-version';
import { prepareCodeUpdateStartup } from '../../../scripts/code-update-runtime.mjs';
import { createAccessPolicyService, createUnavailableRegistryReadPort, type Capability } from '../../features/identity/workbench-access-policy';
import { createOwnPolicyCache } from '../../features/identity/workbench-policy-cache';
import { createAcceptedGitRegistry } from './oko-registry';
import { createLocalPreviewPolicy } from './oko-local-role';
import { createCommandStore } from './command-store';
import { createCommandRegistry, type CommandContext, type CommandRegistry, type CommandDescriptor } from './command-registry';
import { QueryRegistry } from './query-registry';
import { createJobStore } from './jobs';
import { createLocalSessionStore } from './session';
import { createFileStore, defaultFileLimits, assertPhysicalPath, type FileStore } from './files';
import { WorkbenchHttpError } from './protocol';
import { recoverWorkbenchCommands, type WorkbenchApplicationDeps } from './application';
import { createCodeUpdateRecovery } from './code-update-recovery';
import { createRuntimeStorage, prepareRuntimeStorage } from './runtime-storage';
import type { WorkbenchRuntimeOptions } from './runtime-contracts';
import { createPreferencesService } from '../../features/system/workbench-preferences';
import { registerPreferencesQueries } from '../../features/system/workbench-preferences-query';
import { createDraftStore } from '../../features/catalog/workbench-draft-store';
import { createDraftService } from '../../features/catalog/workbench-drafts';
import { registerDraftCommands } from '../../features/catalog/workbench-draft-commands';
import { createDirectoryStore } from '../../features/catalog/workbench-directory-store';
import { createEvidenceService } from '../../features/evidence/workbench-evidence';
import { createWorkbenchReadIndex } from '../../features/catalog/workbench-read-index';
import { registerConfigurationQueries } from '../../features/catalog/workbench-configuration-query';
import { registerConfigurationCommands } from '../../features/knowledge/workbench-fields';
import { registerPrivateCalculationPreviewQuery } from '../../features/evaluation/workbench/private-preview-query';
import { registerPrivateManualTipQuery } from '../../features/evaluation/workbench/private-manual-tip-query';
import { createSourceStore } from '../../features/connectors/workbench-source-store';
import { createImportStore } from '../../features/tabular-import/workbench-import-store';
import { createImportService, registerImportCommands } from '../../features/tabular-import/workbench-import';
import { createSourceService, registerSourceCommands } from '../../features/connectors/workbench-source-service';
import { enrichSourceRows } from '../../features/catalog/workbench-directory';
import { createBrowserRuntime } from '../../features/connectors/workbench-browser-runtime';
import { createBrowserProfileService } from '../../features/connectors/workbench-browser-profile';
import { createBrowserScenarioService } from '../../features/connectors/workbench-browser-scenarios';
import { createBrowserRecorderService } from '../../features/connectors/workbench-browser-recorder';
import { createBrowserLoginService, createBrowserSourceAdapter } from '../../features/connectors/workbench-browser-source';
import { registerBrowserCommands, registerBrowserQueries } from '../../features/connectors/workbench-browser-commands';
import { createSharedBrowserResultReader } from '../../features/connectors/workbench-browser-results';
import { parseWorkbenchTable } from '../../features/tabular-import/workbench-parser';
import { normalizeParsedWorkbenchTable } from '../../features/connectors/workbench-source-normalizer';
import { createOkoWorkflowService } from '../../features/connectors/workbench-workflow-service';
import { createOkoWorkflowModule } from '../../features/connectors/workbench-workflow-module';
import { createExecutionService, registerExecutionCommands } from '../../features/execution/workbench-execution';
import { createExecutionStore } from '../../features/execution/workbench-execution-store';
import { createNotificationRuntime } from '../../features/execution/workbench-notification-runtime';
import { createNotificationProvider, createExecutionNotificationSource } from '../../features/execution/workbench-notification-causes';
import { PublishingService } from '../../features/publishing/workbench/publishing-service';
import { registerPublishingCommands } from '../../features/publishing/workbench/register-commands';
import { createPackageArtifactStore } from '../../features/publishing/workbench/package-artifacts';
import { createGitStagingProvider } from '../../features/publishing/workbench/git-staging-provider';
import { readAppliedPublication } from '../../features/publishing/workbench/publication-apply';
import { MaintenanceService } from '../../features/workspace-maintenance/workbench/maintenance-service';
import { registerMaintenanceCommands } from '../../features/workspace-maintenance/workbench/register-commands';
import { registerMaintenanceQueries } from '../../features/workspace-maintenance/workbench/maintenance-query';
import type { ArchiveDependencies } from '../../features/workspace-maintenance/workbench/contracts';
import { CodeUpdateService } from '../../features/system/workbench/code-update-service';
import { createCodeUpdateLauncherPort } from '../../features/system/code-update';
import { RestoreService } from '../../features/workspace-maintenance/workbench/restore-service';
import { backupFile } from '../../features/workspace-maintenance/workbench/workspace-archive';
const port = z.number().int().min(1024).max(65535);
const siteSchema = z.object({ port: port.default(4174), clientPort: port.default(5173), allowedWorkspaceRoots: z.array(z.string()).min(1), roleMode: z.enum(['local-preview', 'registry']).default('local-preview'), mainRepositoryId: z.string().min(1).default('RM_UOR'), repositoryUrl: z.string().default(''), publishedBranch: z.string().default('main'), gitExecutable: z.string().optional(), registry: z.object({ checkout: z.string(), expectedRemote: z.string(), acceptedBranch: z.string().default('main'), registryPath: z.string().default('registry.json'), repositoryId: z.string() }).nullable().default(null) }).refine(v => v.port !== v.clientPort);
const unavailable = () => { throw new WorkbenchHttpError(503, 'INTEGRATION_NOT_READY', 'Trusted corporate provider is not configured'); };
const version = (type: string, value: Header) => ({ entityType: type, id: value.id, revision: value.revision });
/** Real production owners, no synthetic data or test-specific branch. */
export async function createWorkbenchRuntime(options: WorkbenchRuntimeOptions, internal?: {
    skipCodeRecovery?: boolean;
}) {
    const root = await realpath(options.projectRoot), codeRoot = await realpath(options.codeRoot ?? fileURLToPath(new URL('../../..', import.meta.url)));
    const raw = JSON.parse(await readFile(path.join(root, 'config/site.local.json'), 'utf8'));
    const config = siteSchema.parse(raw);
    const allowed = await Promise.all(config.allowedWorkspaceRoots.map(value => realpath(value)));
    if (!allowed.some(value => { const relative = path.relative(value, root); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }))
        throw Error('Workspace is outside configured allowed roots');
    await assertPhysicalPath(root, true);
    if (!internal?.skipCodeRecovery)
        await prepareCodeUpdateStartup(root, { restoreWorkspace: id => restoreCodeUpdateWorkspace(root, id, codeRoot) });
    const providers = options.providers ?? {}, clock = providers.clock ?? { now: () => new Date().toISOString() }, hostname = providers.hostname ?? osHostname;
    const prepared = await prepareRuntimeStorage(root, { localPreview: config.roleMode === 'local-preview' && !providers.accessPolicy, repositoryId: config.mainRepositoryId, applicationVersion: APP_VERSION, clock });
    let shutdown: () => Promise<void> = prepared.releaseLease;
    try {
        let commands: ReturnType<typeof createCommandRegistry>;
        const capabilityFor = (name: string): Capability => commands?.getCapability(name) ?? 'uor.prepare';
        const localPolicy = config.roleMode === 'local-preview' && !providers.accessPolicy ? createLocalPreviewPolicy({ directory: prepared.runtimeRoot, personId: prepared.personId, clock, capabilityFor }) : null;
        const accessPolicy = providers.accessPolicy?.({ installationId: prepared.installationId, capabilityFor, clock }) ?? localPolicy ?? createAccessPolicyService({ hostname, registry: config.registry ? createAcceptedGitRegistry(config.registry) : createUnavailableRegistryReadPort(), cache: createOwnPolicyCache({ directory: path.join(prepared.runtimeRoot, 'own-policy-cache') }), installationId: prepared.installationId, mainRepositoryId: config.mainRepositoryId, serviceRepositoryId: config.registry?.repositoryId ?? 'registry-not-configured', clock, capabilityFor });
        const own = await accessPolicy.resolveOwnAccess();
        const storage = createRuntimeStorage({ prepared, clock, personId: own.personId, localPreview: own.policyState === 'local_preview', repositoryId: config.mainRepositoryId, applicationVersion: APP_VERSION, candidate: options.candidate === true });
        shutdown = () => storage.close();
        const repository = storage.repository, installationId = prepared.installationId, jobs = createJobStore({ repository, clock });
        commands = createCommandRegistry({ repository, jobs, accessPolicy });
        const subjectFiles = createFileStore({ directory: () => path.join(storage.subjectRoot(), 'uploads'), limits: defaultFileLimits }), restoreFiles = createFileStore({ directory: path.join(prepared.runtimeRoot, 'maintenance', 'uploads'), limits: defaultFileLimits });
        const files: FileStore = { stage: input => (input.purpose === 'workspace-restore' ? restoreFiles : subjectFiles).stage(input), read: (id, install, purpose, person) => (purpose === 'workspace-restore' ? restoreFiles : subjectFiles).read(id, install, purpose, person) };
        const preferences = createPreferencesService({ repository, installationId, clock }), store = createDraftStore({ repository, artifactDirectory: () => path.join(storage.subjectRoot(), 'evidence') });
        const sources = createSourceStore({ repository, ownership: { installationId, personId: () => own.personId } });
        const evidence = createEvidenceService({ repository, store, files, clock });
        const drafts = createDraftService({ repository, store, clock, files, directory: createDirectoryStore({ repository }), evidence, sourceState: sources,
            directoryRefs: () => {
                const catalog = repository.readPublishedCatalog();
                const refs = (entityType: string) => catalog.filter(item => item.entityType === entityType).map(item => ({ entityType, id: item.value.id, revision: item.value.revision }));
                return { entityRefs: refs('directory_entity'), linkRefs: refs('directory_link') };
            },
            assignmentInventory: () => {
                const catalog = repository.readPublishedCatalog();
                return { assignments: catalog.filter(item => item.entityType === 'goal_assignment').map(item => item.value as GoalAssignment), templates: catalog.filter(item => item.entityType === 'template').map(item => item.value as Template) };
            },
        });
        registerDraftCommands(commands, drafts);
        registerConfigurationCommands(commands, { drafts, preferences });
        registerExecutionCommands(commands, createExecutionService({ repository, drafts, store: createExecutionStore({ repository }), clock }));
        const queries = new QueryRegistry();
        registerConfigurationQueries(queries, repository);
        registerPreferencesQueries(queries, preferences);
        registerPrivateCalculationPreviewQuery(queries, drafts);
        registerPrivateManualTipQuery(queries, drafts);
        const index = createWorkbenchReadIndex(repository);
        const artifacts = createPackageArtifactStore({ artifactRoot: () => path.join(storage.subjectRoot(), 'publishing') });
        const git = providers.git ?? (config.repositoryUrl && config.gitExecutable ? createGitStagingProvider({ projectRoot: codeRoot, runtimeRoot: prepared.runtimeRoot, repositoryId: config.mainRepositoryId, remoteUrl: config.repositoryUrl, gitExecutable: config.gitExecutable }) : { readMain: async () => unavailable() });
        const publishing = new PublishingService({ repository, clock, drafts, jobs, jobSink: jobs, accessPolicy, artifacts, git, bitbucket: providers.bitbucket, terminal: providers.terminal, evidence, publication: providers.classification ?? { mode: 'internal', classifyRecord: () => false } });
        registerPublishingCommands(commands, publishing);
        const runtime = Object.assign(createBrowserRuntime({ runtimeRoot: prepared.runtimeRoot, launcher: providers.browserLauncher }), providers.browserEvidence);
        const profiles = createBrowserProfileService({ repository, clock, runtimeRoot: prepared.runtimeRoot });
        const enricher = { enrich: () => { throw new WorkbenchHttpError(422, 'EXACT_ENRICHMENT_REQUIRED', 'Exact source and directory context is required'); }, enrichExact: enrichSourceRows };
        const scenarios = createBrowserScenarioService({ repository, drafts, runtime, profiles, parser: parseWorkbenchTable, enricher, clock, accessPolicy });
        const recorder = createBrowserRecorderService({ repository, drafts, accessPolicy, runtime, profiles, jobs, clock });
        const login = createBrowserLoginService({ repository, profiles, scenarios, runtime });
        registerBrowserCommands(commands, { profiles, scenarios, recorder, login });
        registerBrowserQueries(queries, { profiles, recorder, drafts });
        const browserAdapter = createBrowserSourceAdapter({ runtime, profiles, scenarios, clock });
        const sourceCommands: CommandRegistry = { ...commands, register<P, R>(descriptor: CommandDescriptor<P, R>) { commands.register({ ...descriptor, ...(descriptor.name === 'source.capture' ? { resourceKey: (payload: P) => { const goal = repository.readPublishedHead<CoreGoalDefinition>({ entityType: 'core_goal_definition', id: (payload as {
                            goalId: string;
                        }).goalId }); if (!goal)
                        throw new WorkbenchHttpError(409, 'SOURCE_INVALID_CONFIGURATION', 'Published goal is required'); return 'source:' + goal.sourceId; } } : {}), async handler(context, payload) { prepareSourceInvocation(context, payload as {
                    goalId?: string;
                }); return descriptor.handler(context, payload); } }); } };
        const sourceService = createSourceService({ repository, store: sources, adapters: new Map(providers.sourceAdapters), browserAdapter, normalizer: { normalize({ raw, mapping }) { const value = normalizeParsedWorkbenchTable({ mapping, table: { format: 'csv', sheet: null, dateSystem: null, columns: [...new Set(raw.rawRows.flatMap(row => Object.keys(row.cells)))], rows: raw.rawRows.map((row, i) => ({ cells: row.cells, coordinate: { sheet: null, row: i + 2 } })) } }); return { rows: value.canonicalRows, issues: value.issues }; } }, enricher, jobs, clock, recheckGuard: async (context) => { const fresh = await accessPolicy.assertCommandAllowed('source.capture'); if (fresh.personId !== context.ownAccess.personId)
                throw new WorkbenchHttpError(403, 'ACCESS_RECHECK_REQUIRED', 'Owner changed'); } });
        registerSourceCommands(sourceCommands, sourceService);
        const imports = createImportService({ repository, store: createImportStore({ repository }), sources, files, jobs, clock, recheckGuard: async (context) => { const fresh = await accessPolicy.assertCommandAllowed('import.apply'); if (fresh.personId !== context.ownAccess.personId)
                throw new WorkbenchHttpError(403, 'ACCESS_RECHECK_REQUIRED', 'Owner changed'); } });
        registerImportCommands(sourceCommands, imports);
        const workflow = createOkoWorkflowService({ repository, runtime, profiles, files, jobs, clock, setup: () => ({ hostname: hostname(), registryConfigured: config.registry !== null, message: localPolicy ? 'Временные локальные роли. Публикация недоступна.' : config.registry ? null : 'Реестр допуска не подключён.' }), recheckGuard: async (context) => { const fresh = await accessPolicy.assertCommandAllowed('oko.workflow.record.start'); if (fresh.personId !== context.ownAccess.personId)
                throw new WorkbenchHttpError(403, 'ACCESS_RECHECK_REQUIRED', 'Owner changed'); } });
        const notifications = createNotificationRuntime({ repository, clock, installationId, accessPolicy, commands, drafts, preferences: (id, personId) => ({ notificationPersonId: preferences.get(id, personId).notificationPersonId ?? null }), provider: providers.notifications ?? { async current(context, signal) { const settings = repository.readPublishedCatalog().filter(v => v.entityType === 'reminder_settings'); if (settings.length !== 1)
                    throw new WorkbenchHttpError(409, 'REMINDER_SETTINGS_UNAVAILABLE', 'Published reminder settings are required'); return createNotificationProvider({ repository, settingsRef: { entityType: 'reminder_settings', id: settings[0].value.id }, sources: [createExecutionNotificationSource({ repository })] }).current(context, signal); } } });
        const sessions = createLocalSessionStore({ clock });
        storage.admissionInvalidator(() => { sessions.invalidateAll(); sourceRevision = ''; });
        const archive: ArchiveDependencies = { repository, artifactRoot: path.join(prepared.runtimeRoot, 'maintenance'), files, clock, sessionId: context => context.sessionId ?? '', modules: new Map(), lifecycle: storage.lifecycle, workspace: storage.workspace };
        archive.modules = storage.initialize(archive, jobs, index.rebuild);
        const launcher = createCodeUpdateLauncherPort(root, config), codeUpdateRecovery = createCodeUpdateRecovery({ repository, jobs, installationId, accessPolicy, launcher });
        storage.background({ pause: async () => { await Promise.all([notifications.pause(), codeUpdateRecovery.pause()]); }, resume: () => { notifications.start(); codeUpdateRecovery.start(); } });
        const codeUpdate = new CodeUpdateService({ projectRoot: codeRoot, config, launcher, clock, jobs, jobSink: jobs });
        const maintenance = new MaintenanceService({ archive, jobs, jobSink: jobs, codeUpdate });
        const apply = maintenance.applyRestore.bind(maintenance);
        maintenance.applyRestore = (context, input) => storage.withCoordinator(context, () => apply(context, input));
        registerMaintenanceCommands(commands, maintenance);
        registerMaintenanceQueries(queries, maintenance, index);
        if (localPolicy)
            commands.register({ name: 'workbench.role.set', capability: 'personal.write', ownership: 'person', effect: 'local', execution: 'sync', inputSchema: z.strictObject({ role: z.enum(['viewer', 'curator']) }), outputSchema: z.strictObject({ role: z.enum(['viewer', 'curator']), mode: z.literal('local-preview') }), async handler(_context, input) { await localPolicy.setRole(input.role); return { result: { role: input.role, mode: 'local-preview' }, changedRefs: [], editToken: null }; } });
        commands.register({ name: 'code.update.check', capability: 'workspace.backup', ownership: 'person-if-present', effect: 'local', execution: 'async', inputSchema: z.strictObject({}), outputSchema: z.strictObject({ currentCommit: z.string(), targetCommit: z.string(), available: z.boolean(), launcherAvailable: z.boolean(), warnings: z.array(z.unknown()) }), async handler(context, input) { return { result: await maintenance.checkCodeUpdate(context, input), changedRefs: [], editToken: null }; } });
        commands.register({ name: 'code.update.apply', capability: 'workspace.backup', ownership: 'person-if-present', effect: 'local', execution: 'async', resourceKey: () => 'workspace-maintenance', inputSchema: z.strictObject({ expectedCommit: z.string().regex(/^[a-f0-9]{40,64}$/), targetCommit: z.string().regex(/^[a-f0-9]{40,64}$/) }), outputSchema: z.strictObject({ currentCommit: z.string(), targetCommit: z.string(), rolledBack: z.boolean(), recoveryRequired: z.boolean() }), async handler(context, input) { return { result: await maintenance.applyCodeUpdate(context, input), changedRefs: [], editToken: null }; } });
        let sourceRevision = '';
        const refreshSources = () => { const revision = repository.getStateRevision(); if (sourceRevision === revision)
            return; const catalog = repository.readPublishedCatalog(); const entities = catalog.filter(v => v.entityType === 'directory_entity').map(v => v.value as DirectoryEntity), links = catalog.filter(v => v.entityType === 'directory_link').map(v => v.value as DirectoryLink); for (const entry of catalog.filter(v => v.entityType === 'core_goal_definition')) {
            const goal = entry.value as CoreGoalDefinition;
            if (goal.mode !== 'numeric')
                continue;
            const source = repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: goal.sourceId });
            if (!source?.mappingRef)
                continue;
            const assignments = catalog.filter(v => v.entityType === 'goal_assignment' && (v.value as GoalAssignment).goalId === goal.id);
            const bindings = assignments.map(row => { const assignment = row.value as GoalAssignment; const template = assignment.methodBinding.kind === 'template' ? repository.readPublishedHead<Template>({ entityType: 'template', id: assignment.methodBinding.templateId }) : null; const methodRef = template?.methodRef ?? (assignment.methodBinding.kind === 'standalone' ? assignment.methodBinding.methodRef : null); if (!methodRef)
                throw new Error('Published method missing'); const method = repository.readVersion<MethodVersion>(methodRef)!; return { goalRef: version('core_goal_definition', goal), sourceRef: version('source_definition', source), mappingRef: source.mappingRef!, assignmentRef: version('goal_assignment', assignment), templateRef: template ? version('template', template) : null, methodRef, metricRefs: method.mode === 'numeric' ? method.rules.map(rule => rule.metricRef) : [], directoryEntityRefs: entities.map(v => version('directory_entity', v)), directoryLinkRefs: links.map(v => version('directory_link', v)), directoryRevision: createHash('sha256').update(JSON.stringify([...entities, ...links])).digest('hex') }; });
            sources.installPublished(bindings);
            sources.bindAdapter({ sourceId: source.id, adapterKey: source.browserScenarioRef ? 'browser' : source.kind, profileRef: null, revision: source.id + ':' + source.revision });
        } sourceRevision = repository.getStateRevision(); };
        function prepareSourceInvocation(context: CommandContext, payload: {
            goalId?: string;
        }) { refreshSources(); const selected = preferences.get(context.installationId, context.ownAccess.personId).context; if (payload.goalId && selected) {
            const saved = { ...selected, goalId: payload.goalId };
            const row = repository.sqlForModule('sources').get<{
                value_json: string;
            }>('SELECT value_json FROM wb_sources_contexts WHERE installation_id=? AND goal_id=?', [context.installationId, payload.goalId]);
            const prior = row ? JSON.parse(row.value_json).revision : null;
            const revision = createHash('sha256').update(JSON.stringify(saved)).digest('hex');
            if (prior !== revision)
                sources.saveAllowedContext({ installationId: context.installationId, goalId: payload.goalId, context: saved, revision }, prior, context.ownAccess.personId);
        } }
        const shared = createSharedBrowserResultReader({ sources });
        const deps: WorkbenchApplicationDeps = { repository, clock, hostname, installationId, accessPolicy, commands, queries, jobs, files, sessions, readState: { publishedCommit: () => readAppliedPublication(repository)?.commit ?? null }, modules: [createOkoWorkflowModule({ service: workflow, prefix: 'oko.workflow' })], maintenance, notifications, evidence, allowedOrigins: [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, `http://127.0.0.1:${config.clientPort}`, `http://localhost:${config.clientPort}`], queryPorts: { repository, index, drafts, publishing: publishing.readPort, sources, notifications: notifications.service, jobs, preferences }, browserRecordings: { screenshot: recorder.screenshot }, browserResults: { async read(context, id, kind) { const personal = workflow.hasResult(context, id), captured = sources.hasOwnCapture({ installationId: context.installationId, profilePersonId: context.ownAccess.personId }, id); if (personal && captured)
                    throw new WorkbenchHttpError(409, 'ARTIFACT_ID_COLLISION', 'Ambiguous owned artifact'); if (personal)
                    return workflow.readResult(context, id, kind); if (captured)
                    return shared.read(context, id, kind); throw new WorkbenchHttpError(404, 'RESULT_NOT_FOUND', 'Own result not found'); } } };
        let closed = false, activated = false, preparedUpdate = false;
        const requestReleases = new WeakMap<object, () => void>();
        const configure = async (app: FastifyInstance) => { app.addHook('onRequest', async (request) => { requestReleases.set(request, storage.admit()); }); app.addHook('onResponse', async (request) => { requestReleases.get(request)?.(); requestReleases.delete(request); }); app.addHook('onError', async (request) => { requestReleases.get(request)?.(); requestReleases.delete(request); }); app.addHook('onRequestAbort', async (request) => { requestReleases.get(request)?.(); requestReleases.delete(request); }); app.get('/api/health', async () => ({ status: 'ok', version: APP_VERSION })); };
        const activate = async (_app?: FastifyInstance) => { if (activated)
            return; await recoverWorkbenchCommands(deps); await codeUpdateRecovery.reconcile(); codeUpdateRecovery.start(); notifications.start(); storage.activate(); activated = true; };
        const close = async () => { if (closed)
            return; closed = true; storage.freeze(); await notifications.stop(); await codeUpdateRecovery.pause(); await workflow.shutdown(); if (!preparedUpdate)
            await commands.idle(); await storage.close(); };
        const systemContext = async (commandId: string = randomUUID()): Promise<CommandContext> => { const ownAccess = await accessPolicy.resolveOwnAccess(); return { repository, clock, installationId, commandId, requestId: randomUUID(), sessionId: 'code-update-system', ownAccess, actor: { hostname: hostname(), installationId, profilePersonId: ownAccess.personId } }; };
        return { deps, configure, activate, close, config, codeRoot, projectRoot: root, services: { drafts, sources, publishing, workflow, maintenance, preferences, files, archive },
            async prepareUpdate(jobId: string) { const job = jobs.get(jobId, installationId); if (!job || jobs.name(jobId, installationId) !== 'code.update.apply')
                throw new WorkbenchHttpError(409, 'JOB_NOT_FOUND', 'Exact update job is required'); await storage.withCoordinator({ installationId, commandId: job.commandId }, () => storage.lifecycle.quiesce(jobId)); const context = await systemContext(job.commandId); createCommandStore(repository).assertAccess(installationId, job.commandId, context.ownAccess.personId); const backup = await maintenance.createBackup(context, { label: 'Before code update', includeOriginals: true }); preparedUpdate = true; return { backupId: backup.backupId, sha256: backup.archiveSha256, bytes: backup.bytes }; },
            async releaseUpdate() { preparedUpdate = false; await storage.lifecycle.resume(); },
            async restoreCodeBackup(id: string, jobId: string) { storage.freeze(); const job = jobs.get(jobId, installationId); if (!job || jobs.name(jobId, installationId) !== 'code.update.apply')
                throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Exact code update coordinator is missing'); const context = await systemContext(job.commandId); createCommandStore(repository).assertAccess(installationId, job.commandId, context.ownAccess.personId); const file = await backupFile(context, id, archive); const chunks: Uint8Array[] = []; for await (const chunk of file.stream)
                chunks.push(chunk); const uploaded = await files.stage({ installationId, profilePersonId: context.ownAccess.personId, purpose: 'workspace-restore', name: 'return.zip', mediaType: 'application/zip', stream: (async function* () { yield Buffer.concat(chunks); })() }); const restorer = new RestoreService(archive); const preview = await restorer.previewRestore(context, { fileHandle: uploaded.fileHandle }); await storage.withCoordinator(context, () => restorer.applyRestore(context, { restoreToken: preview.restoreToken, confirmReplacement: true })); },
        };
    }
    catch (error) {
        await shutdown();
        throw error;
    }
}
export async function restoreCodeUpdateWorkspace(root: string, backupId: string, codeRoot?: string) {
    const directory = path.join(await realpath(root), '.runtime/code-update');
    await assertPhysicalPath(directory, true);
    const active = z.object({ id: z.string().uuid() }).parse(JSON.parse(await readFile(path.join(directory, 'active.json'), 'utf8'))), journalFile = path.join(directory, 'transactions', active.id, 'journal.json');
    await assertPhysicalPath(journalFile, false);
    const journal = z.object({ root: z.string(), phase: z.literal('rolling_back'), lifecycleOwner: z.literal('workbench'), requestId: z.string().uuid(), workspaceBackup: z.object({ backupId: z.string().uuid() }) }).parse(JSON.parse(await readFile(journalFile, 'utf8')));
    if (journal.root !== await realpath(root) || journal.workspaceBackup.backupId !== backupId)
        throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Workspace return is not bound to this native rollback');
    const instance = await createWorkbenchRuntime({ projectRoot: root, codeRoot, candidate: true }, { skipCodeRecovery: true });
    try {
        await instance.services.maintenance.recover();
        await instance.restoreCodeBackup(backupId, journal.requestId);
    }
    finally {
        await instance.close();
    }
}
