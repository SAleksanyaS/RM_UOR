import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { VersionRef } from '../../../domain/workbench/index';
import { canUseCapability, type AccessPolicyService, type OwnAccessProfile } from '../../../features/identity/workbench-access-policy';
import { installHistoryIndex } from '../../../features/history/workbench-history-index';
import { createWorkbenchRepository, type WorkbenchRepository } from '../../storage/workbench-repository';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
import { createWorkbenchApp } from '../app';
import { createCommandRegistry } from '../command-registry';
import { createJobStore } from '../jobs';
import { QueryRegistry } from '../query-registry';
import { WorkbenchHttpError, type GlobalContext } from '../protocol';
import { createLocalSessionStore } from '../session';

export type WorkbenchTestScenario = 'empty' | 'scope-split' | 'population-gap' | 'stale-fallback' | 'manual-goal' | 'partial-file' | 'publication-ready' | 'offline-draft';
export async function createWorkbenchTestApplication(options: { role: 'viewer' | 'curator' | 'chief'; scenario: WorkbenchTestScenario; clock?: string }): Promise<{ app: FastifyInstance; repository: WorkbenchRepository; refs: Record<string, VersionRef>; close(): Promise<void> }> {
  if (options.scenario !== 'empty' && options.scenario !== 'scope-split') throw new Error('Test scenario not implemented by its owning feature: ' + options.scenario);
  const root = mkdtempSync(path.join(tmpdir(), 'uor-workbench-test-'));
  const repository = createWorkbenchRepository({ filename: ':memory:', artifactRoot: root });
  const refs: Record<string, VersionRef> = {};
  const clock = { now: () => options.clock ?? '2026-10-28T09:00:00Z' };
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
    let defaultContext: GlobalContext | null = null;
    if (options.scenario === 'scope-split') {
      const population = [{ kind: 'product' as const, id: fixtureId(101) }, { kind: 'product' as const, id: fixtureId(102) }];
      const input = makeNumericFixture({ scope: { kind: 'dit', id: fixtureId(100) }, expectedPopulation: population, values: ['92'], targets: ['90'] });
      input.goal.title = 'Тестовая цель';
      const graph = makeEntityGraph(input);
      const header = makeHeader(103, { publicationAnchorId: input.goal.publicationAnchorId });
      graph.entries.push({ entityType: 'directory_entity', value: { ...header, kind: 'cluster', name: 'Кластер А', externalKeys: [] } });
      const clusterMethod = { ...input.method, id: fixtureId(114), rules: input.method.mode === 'numeric' ? input.method.rules.map(rule => ({ ...rule, condition: { op: 'gte' as const, target: '95' } })) : [] };
      // Independent published method and assignment; no child-rollup inference.
      graph.entries.push({ entityType: 'method_version', value: clusterMethod });
      graph.entries.push({ entityType: 'goal_assignment', value: { ...input.assignment, id: fixtureId(115), scope: { kind: 'cluster', id: fixtureId(103) }, methodBinding: { kind: 'standalone', methodRef: versionRef('method_version', 114) } } });
      seedGraph(repository, graph);
      Object.assign(refs, { goal: versionRef('core_goal_definition', 11), ditAssignment: versionRef('goal_assignment', 15), clusterAssignment: versionRef('goal_assignment', 115), productA: versionRef('directory_entity', 101), productB: versionRef('directory_entity', 102), source: versionRef('source_definition', 12), method: versionRef('method_version', 14) });
      defaultContext = { scopePath: { ditId: fixtureId(100), clusterId: null, productId: null, teamId: null }, goalId: null, time: { kind: 'as_of', date: clock.now().slice(0, 10) }, resultMode: 'current', snapshotId: null };
    }
    const own: OwnAccessProfile = { role: options.role, personId: options.role === 'viewer' ? null : fixtureId(17), displayName: options.role === 'viewer' ? null : 'Тестовый куратор', policyState: options.role === 'viewer' ? 'unavailable' : 'verified', checkedAt: options.role === 'viewer' ? null : clock.now() };
    let commands: ReturnType<typeof createCommandRegistry>;
    const accessPolicy: AccessPolicyService = {
      async resolveOwnAccess() { return { ...own }; },
      async assertCommandAllowed(name) { const capability = commands.getCapability(name); if (capability === null || !canUseCapability(own, capability)) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Command is not allowed'); return { ...own }; },
      async assertFreshPublishAllowed() { throw new WorkbenchHttpError(503, 'INTEGRATION_NOT_READY', 'Synthetic fixture has no external publishing port'); },
    };
    const jobs = createJobStore({ repository, clock }); commands = createCommandRegistry({ repository, jobs, accessPolicy });
    app = await createWorkbenchApp({ repository, clock, hostname: () => 'test-workbench-host', installationId: fixtureId(1), accessPolicy, commands, queries: new QueryRegistry(), jobs, modules: [], sessions: createLocalSessionStore({ clock }), allowedOrigins: ['http://127.0.0.1:5173'], readState: { defaultContext: async () => defaultContext, publishedCommit: () => options.scenario === 'scope-split' ? inputCommit : null } });
    return { app, repository, refs, close };
  } catch (error) { await close(); throw error; }
}
const inputCommit = 'b'.repeat(40);
