import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandContext } from '../../../src/server/workbench/command-registry';
import { createCommandRegistry } from '../../../src/server/workbench/command-registry';
import { createWorkbenchRepository } from '../../../src/server/storage/workbench-repository';
import { createJobStore } from '../../../src/server/workbench/jobs';
import { createFileStore, defaultFileLimits } from '../../../src/server/workbench/files';
import { createDirectoryStore } from '../../../src/features/catalog/workbench-directory-store';
import { createDraftStore } from '../../../src/features/catalog/workbench-draft-store';
import { createDraftService } from '../../../src/features/catalog/workbench-drafts';
import { registerDraftCommands } from '../../../src/features/catalog/workbench-draft-commands';
import { createEvidenceService } from '../../../src/features/evidence/workbench-evidence';
import { prepareEvaluation } from '../../../src/features/evaluation/workbench/prepare-evaluation';
import { fixtureId, makeEntityGraph, makeNumericFixture } from './factories';
import { seedGraph } from './repository';
import { installHistoryIndex } from '../../../src/features/history/workbench-history-index';

export const draftCleanups: Array<() => Promise<void> | void> = [];
export const business = (value: object) => Object.fromEntries(Object.entries(value).filter(([key]) => !['schemaVersion','id','revision','recordedAt','actor','publicationAnchorId'].includes(key)));
export function draftFixture(options:{history?:boolean;input?:ReturnType<typeof makeNumericFixture>}={}) {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-t17-'));
  const config = { filename: path.join(root, 'data.sqlite'), artifactRoot: path.join(root, 'core-artifacts') };
  const repository = createWorkbenchRepository(config);
  if(options.history) installHistoryIndex(repository);
  const input = options.input??makeNumericFixture({ values: ['92'], targets: ['90'] }); seedGraph(repository, makeEntityGraph(input));
  let now = input.context.evaluatedAt;
  const clock = { now: () => now };
  const context: CommandContext = { repository, clock, requestId: fixtureId(801), commandId: fixtureId(802), installationId: fixtureId(1), ownAccess: { role: 'curator', displayName: 'Synthetic curator', personId: fixtureId(17), policyState: 'local_preview', checkedAt: clock.now() }, actor: { hostname: 'demo-host', installationId: fixtureId(1), profilePersonId: fixtureId(17) } };
  const policy = { async resolveOwnAccess() { return context.ownAccess; }, async assertCommandAllowed() { return context.ownAccess; }, async assertFreshPublishAllowed() { return context.ownAccess; } };
  const jobs = createJobStore({ repository, clock }); const registry = createCommandRegistry({ repository, jobs, accessPolicy: policy });
  const files = createFileStore({ directory: path.join(root, 'uploads'), limits: defaultFileLimits });
  const store = createDraftStore({ repository, artifactDirectory: path.join(root, 'evidence') });
  const evidence = createEvidenceService({ repository, store, files, clock });
  let incompleteAttempt = false;
  let directoryRefs: { entityRefs: { entityType: string; id: string; revision: number }[]; linkRefs: { entityType: string; id: string; revision: number }[] } | null = null;
  let assignmentInventory: { assignments: any[]; templates: any[] } | null = null;
  const sourceState = { readLatestAttempt: () => incompleteAttempt ? { complete: false } : null };
  const service = createDraftService({ repository, store, clock, files, prepareEvaluation, directory: createDirectoryStore({ repository }), evidence, sourceState, directoryRefs: () => directoryRefs, assignmentInventory: () => assignmentInventory });
  registerDraftCommands(registry, service);
  const counts = new Map<string, number>(); repository.registerProjection('t17-test-count', type => { counts.set(type, (counts.get(type) ?? 0) + 1); });
  let serial = 100000, token: string | null = null, packageId: string | null = null;
  const execute = async (name: string, payload: Record<string, unknown>, options: { baseRevision?: string | null; commandId?: string } = {}) => {
    const commandId = options.commandId ?? fixtureId(serial++);
    const result = await registry.execute({ commandId, name, baseRevision: options.baseRevision === undefined ? token : options.baseRevision, payload }, { ...context, commandId });
    if (!('result' in result)) throw Error('Expected synchronous command');
    if (result.editToken !== null) token = result.editToken;
    return result;
  };
  const open = async (entityType: string, ref: { entityType: string; id: string } | null = null) => {
    const outcome = await execute('draft.open', { entityType, ref, packageId });
    const result = outcome.result as { draftId: string; objectId: string; entityRef: { entityType: string; id: string }; editToken: string };
    packageId = store.getEntry(result.draftId)!.packageId; return result;
  };
  draftCleanups.push(async () => { await registry.idle(); repository.close(); if (!path.basename(root).startsWith('uor-t17-')) throw Error('Unsafe test cleanup'); rmSync(root, { recursive: true, force: true }); });
  return { root, config, input, repository, context, policy, clock, jobs, registry, files, store, evidence, service, open, execute,
    packageId: () => packageId!, token: () => token, count: (type: string) => counts.get(type) ?? 0,
    setNow: (value: string) => { now = value; }, setIncompleteAttempt: (value: boolean) => { incompleteAttempt = value; },
    setInventories: (refs: NonNullable<typeof directoryRefs>, assignments: any[], templates: any[]) => { directoryRefs = refs; assignmentInventory = { assignments, templates }; },
    prepare: async () => (await execute('calculation.prepare', { assignmentRef: { entityType: 'goal_assignment', id: input.assignment.id, revision: input.assignment.revision }, businessTime: input.context.businessTime })).result as { basisRef: { entityType: string; id: string; revision: number }; resultRef: { entityType: string; id: string; revision: number } },
  };
}
