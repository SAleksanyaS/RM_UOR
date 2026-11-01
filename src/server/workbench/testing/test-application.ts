import { composeBrowserFixture, type BrowserFixtureOptions, type BrowserTesting } from './browser-scenarios';
import { createFileStore, defaultFileLimits } from '../files';
import { registerConfigurationQueries } from '../../../features/catalog/workbench-configuration-query';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { VersionRef } from '../../../domain/workbench/index';
import { canUseCapability, type AccessPolicyService, type OwnAccessProfile } from '../../../features/identity/workbench-access-policy';
import { installHistoryIndex } from '../../../features/history/workbench-history-index';
import { createWorkbenchRepository, type WorkbenchRepository } from '../../storage/workbench-repository';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
import { seedGoalScenario, type GoalScenario } from './goal-scenarios';
import { composeDataCommands, seedDataScenario } from './data-scenarios';
import { registerPrivateManualTipQuery } from '../../../features/evaluation/workbench/private-manual-tip-query';
import { registerPrivateCalculationPreviewQuery } from '../../../features/evaluation/workbench/private-preview-query';
import { registerDraftCommands } from '../../../features/catalog/workbench-draft-commands';
import { createWorkbenchApp } from '../app';
import { createCommandRegistry } from '../command-registry';
import { createJobStore } from '../jobs';
import { QueryRegistry } from '../query-registry';
import { WorkbenchHttpError, type GlobalContext } from '../protocol';
import { createLocalSessionStore } from '../session';
import { createPreferencesService } from '../../../features/system/workbench-preferences';
import { registerPreferencesQueries } from '../../../features/system/workbench-preferences-query';
import { createDraftStore } from '../../../features/catalog/workbench-draft-store';
import { createDraftService } from '../../../features/catalog/workbench-drafts';
import { createDirectoryStore } from '../../../features/catalog/workbench-directory-store';
import { createEvidenceService } from '../../../features/evidence/workbench-evidence';
import { registerConfigurationCommands } from '../../../features/knowledge/workbench-fields';
import { createWorkbenchReadIndex } from '../../../features/catalog/workbench-read-index';
import { createSourceStore } from '../../../features/connectors/workbench-source-store';
import { createNotificationService, registerNotificationCommands } from '../../../features/execution/workbench-notifications';
import { composeGoalSetupPreview } from './goal-setup-scenarios';
import { composePublishingScenario, seedPublishingOrganization, type PublishingTesting } from './publishing-scenarios';
import { createExecutionService, registerExecutionCommands } from '../../../features/execution/workbench-execution';
import { createExecutionStore } from '../../../features/execution/workbench-execution-store';

export type WorkbenchTestScenario = 'empty' | GoalScenario | 'partial-file' | 'publication-ready' | 'offline-draft' | 'organization-only';
export async function createWorkbenchTestApplication(options: { role: 'viewer' | 'curator' | 'chief'; scenario: WorkbenchTestScenario; clock?: string; clientOrigin?: string; browserFixture?: BrowserFixtureOptions }): Promise<{ app: FastifyInstance; repository: WorkbenchRepository; refs: Record<string, VersionRef>; publishingTesting?: PublishingTesting; browserTesting?: BrowserTesting; close(): Promise<void> }> {

  const root = mkdtempSync(path.join(tmpdir(), 'uor-workbench-test-'));
  const repository = createWorkbenchRepository({ filename: ':memory:', artifactRoot: root });
  const refs: Record<string, VersionRef> = {};
  const clock = { now: () => options.clock ?? (options.scenario === 'stale-fallback' ? '2026-11-06T09:00:00Z' : '2026-10-28T09:00:00Z') };
  let app: FastifyInstance | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    if (app) await app.close(); repository.close();
    const resolved = path.resolve(root), allowed = path.resolve(tmpdir());
    if (!resolved.startsWith(allowed + path.sep) || !path.basename(resolved).startsWith('uor-workbench-test-')) throw new Error('Invalid test cleanup root');
    rmSync(resolved, { recursive: true, force: true });
  };
  try {
    installHistoryIndex(repository);
    const sources = createSourceStore({ repository });
    let defaultContext: GlobalContext | null = null;
    if (options.scenario !== 'empty') {
      const seeded = options.scenario === 'organization-only' ? seedPublishingOrganization({repository,clock}) : options.scenario === 'partial-file' ? seedDataScenario({ repository, clock, role: options.role }) : seedGoalScenario({ repository, sources, clock, role: options.role, scenario: options.scenario === 'publication-ready' || options.scenario === 'offline-draft' ? 'scope-split' : options.scenario });
      Object.assign(refs, seeded.refs); defaultContext = seeded.defaultContext;
    }
    const own: OwnAccessProfile = { role: options.role, personId: options.role === 'viewer' ? null : fixtureId(17), displayName: options.role === 'viewer' ? null : 'Тестовый куратор', policyState: options.role === 'viewer' ? 'unavailable' : options.scenario === 'offline-draft' ? 'offline_cached' : 'verified', checkedAt: options.role === 'viewer' ? null : clock.now() };
    let commands: ReturnType<typeof createCommandRegistry>;
    const accessPolicy: AccessPolicyService = {
      async resolveOwnAccess() { return { ...own }; },
      async assertCommandAllowed(name) { const capability = commands.getCapability(name); if (capability === null || !canUseCapability(own, capability)) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Command is not allowed'); return { ...own }; },
      async assertFreshPublishAllowed() { throw new WorkbenchHttpError(503, 'INTEGRATION_NOT_READY', 'Synthetic fixture has no external publishing port'); },
    };
    const jobs = createJobStore({ repository, clock }); commands = createCommandRegistry({ repository, jobs, accessPolicy });
    const installationId = fixtureId(1);
    const files = createFileStore({ directory: path.join(root, 'private-files'), limits: defaultFileLimits });
    const preferences = createPreferencesService({ repository, installationId, clock });
    const store = createDraftStore({ repository, artifactDirectory: path.join(root, 'draft-artifacts') });
    const evidence = createEvidenceService({ repository, store, files, clock });
    const drafts = createDraftService({ repository, store, clock, files, directory: createDirectoryStore({ repository }), evidence, sourceState: sources });
    registerDraftCommands(commands, drafts);
    const publicationFixture = options.scenario === 'publication-ready' || options.scenario === 'offline-draft' ? await composePublishingScenario({ repository, clock, drafts, accessPolicy, jobs, commands, root, own }) : null;
    const publishing = publicationFixture?.service ?? composeGoalSetupPreview({ repository, clock, drafts, accessPolicy, jobs, commands, root });
    registerExecutionCommands(commands, createExecutionService({ repository, drafts, store: createExecutionStore({ repository }), clock }));
    registerConfigurationCommands(commands, { drafts, preferences });
    if (options.scenario === 'partial-file') composeDataCommands({ repository, files, jobs, clock, sources, commands, accessPolicy });
    const queries = new QueryRegistry(); registerConfigurationQueries(queries, repository); registerPreferencesQueries(queries, preferences); registerPrivateCalculationPreviewQuery(queries, drafts); registerPrivateManualTipQuery(queries, drafts);
    const browserTesting = options.browserFixture ? await composeBrowserFixture({ options: options.browserFixture, root, repository, drafts, commands, queries, clock, jobs, accessPolicy, own, refs, sources, context: defaultContext }) : undefined;
    const notifications = createNotificationService({ repository, provider: { async current() { throw Error('Test read must not poll'); } }, preferences: id => ({ notificationPersonId: preferences.get(id).notificationPersonId ?? null }) });
    registerNotificationCommands(commands, notifications);
    app = await createWorkbenchApp({ files, repository, clock, hostname: () => 'test-workbench-host', installationId, accessPolicy, commands, queries, jobs, modules: [], sessions: createLocalSessionStore({ clock }), allowedOrigins: [options.clientOrigin ?? 'http://127.0.0.1:5173'], queryPorts: { repository, index: createWorkbenchReadIndex(repository), drafts, publishing: publishing.readPort, sources, notifications, jobs, preferences }, readState: { defaultContext: async () => preferences.get(installationId).context ?? defaultContext, publishedCommit: () => options.scenario !== 'empty' ? inputCommit : null } });
    return { app, repository, refs, publishingTesting: publicationFixture?.testing, browserTesting, close };
  } catch (error) { await close(); throw error; }
}
const inputCommit = 'b'.repeat(40);
