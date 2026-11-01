import type { Clock, VersionRef } from '../../../domain/workbench/primitives';
import type { DirectoryEntity, DirectoryLink, ManualCorrection, SourceDefinition, SourceFieldMapping } from '../../../domain/workbench/entities';
import type { WorkbenchRepository } from '../../storage/workbench-repository';
import type { GlobalContext } from '../protocol';
import type { FileStore } from '../files';
import type { JobStore } from '../jobs';
import type { CommandRegistry } from '../command-registry';
import type { AccessPolicyService } from '../../../features/identity/workbench-access-policy';
import type { SourceStore } from '../../../features/connectors/workbench-source-store';
import { createImportStore } from '../../../features/tabular-import/workbench-import-store';
import { createImportService, registerImportCommands } from '../../../features/tabular-import/workbench-import';
import { createSourceService, registerSourceCommands } from '../../../features/connectors/workbench-source-service';
import { sourcePayloadHash, type SourceAdapter } from '../../../features/connectors/workbench-source-contracts';
import { normalizeParsedWorkbenchTable } from '../../../features/connectors/workbench-source-normalizer';
import { enrichSourceRows } from '../../../features/catalog/workbench-directory';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
import { WorkbenchHttpError } from '../protocol';

const captureModes = new WeakMap<WorkbenchRepository, { mode: 'ready' | 'failed' | 'waiting' }>();
export function setDataCaptureMode(repository: WorkbenchRepository, mode: 'ready' | 'failed' | 'waiting') {
  const control = captureModes.get(repository); if (!control) throw Error('Data capture fixture is not composed'); control.mode = mode;
}

const period = { kind: 'period' as const, startInclusive: '2026-10-01', endExclusive: '2026-11-01' };
const population = [101, 102, 103, 104].map(n => ({ kind: 'product' as const, id: fixtureId(n) }));
const ref = (entityType: string, value: { id: string; revision: number }): VersionRef => ({ entityType, id: value.id, revision: value.revision });

/** Synthetic data only. The HTTP harness composes the actual feature owners. */
export function seedDataScenario({ repository, clock }: { repository: WorkbenchRepository; clock: Clock; role: 'viewer' | 'curator' | 'chief' }) {
  const f = makeNumericFixture({ scope: { kind: 'dit', id: fixtureId(100) }, expectedPopulation: population, context: { businessTime: period, evaluatedAt: clock.now() } });
  f.goal.title = 'Импорт показателей';
  const graph = makeEntityGraph(f);
  graph.entries = graph.entries.filter(e => !['capture', 'observed_fact'].includes(e.entityType));
  const source = graph.entries.find(e => e.entityType === 'source_definition')!.value as SourceDefinition;
  source.kind = 'file'; source.publicLocator = null;
  const mapping = graph.entries.find(e => e.entityType === 'source_field_mapping')!.value as SourceFieldMapping;
  Object.assign(mapping, { rowKeyFields: ['ID'], dimensionFields: {}, productKeyField: 'ID', dateField: null, periodStartField: 'Start', periodEndField: 'End', metricFields: [{ metricId: f.metrics[0].id, fields: { demo_value: 'Value' } }], parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' } });
  const directory = graph.entries.filter(e => e.entityType === 'directory_entity').map(e => e.value as DirectoryEntity);
  directory.filter(e => e.kind === 'product').forEach((e, i) => { e.externalKeys = [{ sourceId: source.id, key: ['A', 'B', 'C', 'D'][i] }]; });
  const cluster: DirectoryEntity = { ...makeHeader(110, { publicationAnchorId: fixtureId(2) }), kind: 'cluster', name: 'Кластер импорта', externalKeys: [] };
  graph.entries.push({ entityType: 'directory_entity', value: cluster });
  const links: DirectoryLink[] = [
    { ...makeHeader(120, { publicationAnchorId: fixtureId(2) }), kind: 'dit_cluster', from: { entityType: 'directory_entity', id: fixtureId(100) }, to: { entityType: 'directory_entity', id: cluster.id } },
    ...population.map((s, i) => ({ ...makeHeader(121 + i, { publicationAnchorId: fixtureId(2) }), kind: 'cluster_product' as const, from: { entityType: 'directory_entity', id: cluster.id }, to: { entityType: 'directory_entity', id: s.id } })),
    ...[{ kind: 'cluster' as const, id: cluster.id }, ...population].map((scope, i) => ({ ...makeHeader(130 + i, { publicationAnchorId: fixtureId(2) }), kind: 'leader' as const, scope, personId: f.goal.primaryCuratorPersonId })),
  ];
  links.forEach(value => graph.entries.push({ entityType: 'directory_link', value }));
  seedGraph(repository, graph);
  const defaultContext: GlobalContext = { scopePath: { ditId: fixtureId(100), clusterId: null, productId: null, teamId: null }, goalId: f.goal.id, time: period, resultMode: 'current', snapshotId: null };
  return { refs: { goal: ref('core_goal_definition', f.goal), source: ref('source_definition', source), mapping: ref('source_field_mapping', mapping), method: ref('method_version', f.method), assignment: ref('goal_assignment', f.assignment), metric: ref('metric_definition', f.metrics[0]) }, defaultContext };
}

export function composeDataCommands({ repository, files, jobs, clock, sources, commands, accessPolicy }: { repository: WorkbenchRepository; files: FileStore; jobs: JobStore; clock: Clock; sources: SourceStore; commands: CommandRegistry; accessPolicy: AccessPolicyService }): void {
  const directory = [100, 101, 102, 103, 104, 110, 17].map(n => versionRef('directory_entity', n)).filter(r => repository.readVersion(r));
  sources.installPublished([{ goalRef: versionRef('core_goal_definition', 11), sourceRef: versionRef('source_definition', 12), mappingRef: versionRef('source_field_mapping', 13), assignmentRef: versionRef('goal_assignment', 15), templateRef: null, methodRef: versionRef('method_version', 14), metricRefs: [versionRef('metric_definition', 201)], directoryEntityRefs: directory, directoryLinkRefs: [120, 121, 122, 123, 124, 130, 131, 132, 133, 134].map(n => versionRef('directory_link', n)), directoryRevision: 'data-fixture-1' }]);
  sources.bindAdapter({ sourceId: fixtureId(12), adapterKey: 'synthetic-data-capture', profileRef: null, revision: 'fixture-1' });
  sources.saveAllowedContext({ installationId: fixtureId(1), goalId: fixtureId(11), revision: 'context-1', context: { scopePath: { ditId: fixtureId(100), clusterId: null, productId: null, teamId: null }, goalId: fixtureId(11), time: period, resultMode: 'current', snapshotId: null } }, null);
  registerImportCommands(commands, createImportService({ repository, store: createImportStore({ repository }), sources, files, jobs, clock, recheckGuard: async context => { await accessPolicy.assertCommandAllowed('import.apply'); if (context.ownAccess.personId === null) throw Error('Import needs a person'); } }));
  // Only this opt-in test application receives the synthetic adapter. The source
  // service, mapping normalizer, directory enrichment, facts and jobs are real.
  const control = { mode: 'ready' as 'ready' | 'failed' | 'waiting' }; captureModes.set(repository, control);
  const adapter: SourceAdapter = {
    async check(request) {
      if (control.mode === 'failed') return { status: 'unavailable', issues: [{ code: 'SYNTHETIC_SOURCE_UNAVAILABLE', stage: 'source.check', retryable: true, message: 'Synthetic source is unavailable', rowKeys: [], refs: [] }] };
      if (control.mode === 'waiting') {
        jobs.registerControl(request.operationId, { openAuth: async () => { control.mode = 'ready'; } });
        jobs.update(request.operationId, { status: 'waiting_user', nextAction: { commandName: 'job.openAuth', payload: { jobId: request.operationId }, route: null, label: 'Открыть личный вход', enabled: true, disabledReason: null } });
        throw new WorkbenchHttpError(422, 'SYNTHETIC_AUTH_REQUIRED', 'Synthetic manual action required');
      }
      return { status: 'ready', issues: [] };
    },
    async collect(request, signal) {
      signal.throwIfAborted();
      const rawRows = ['A', 'B', 'C', 'D'].map((key, index) => ({ rowKey: JSON.stringify([key]), cells: { ID: { kind: 'text' as const, original: key }, Value: { kind: 'number' as const, original: String(65 + index * 5) }, Start: { kind: 'text' as const, original: period.startInclusive }, End: { kind: 'text' as const, original: period.endExclusive } } }));
      return { operationId: request.operationId, sourceRef: request.sourceRef, mappingRef: request.mappingRef, capturedAt: clock.now(), sourceUpdatedAt: null, rawRows, artifact: null, payloadHash: sourcePayloadHash(rawRows), coverage: { complete: true, expectedRows: 4, receivedRows: 4, evidence: ['synthetic-data-fixture:four-product-inventory'] }, issues: [] };
    },
  };
  registerSourceCommands(commands, createSourceService({ repository, store: sources, adapters: new Map([['synthetic-data-capture', adapter]]), jobs, clock, recheckGuard: async () => { await accessPolicy.assertCommandAllowed('source.capture'); }, normalizer: { normalize({ raw, mapping }) {
    const result = normalizeParsedWorkbenchTable({ mapping, table: { format: 'csv', sheet: null, dateSystem: null, columns: ['ID', 'Value', 'Start', 'End'], rows: raw.rawRows.map((row, index) => ({ cells: row.cells, coordinate: { sheet: null, row: index + 2 } })) } });
    return { rows: result.canonicalRows, issues: result.issues };
  } }, enricher: { enrich({ rows }) {
    const binding = sources.resolveCapture({ installationId: fixtureId(1), goalId: fixtureId(11) });
    return enrichSourceRows({ capture: { sourceId: binding.source.id, mappingRef: binding.mappingRef, canonicalRows: rows, rawRows: rows.map(row => ({ rowKey: row.rowKey, cells: { ID: { kind: 'text', original: JSON.parse(row.rowKey)[0] as string } } })) }, mapping: binding.mapping, directoryEntities: binding.directoryEntities, directoryLinks: binding.directoryLinks });
  } } }));
}

export function dataScenarioFacts(repository: WorkbenchRepository) {
  return repository.readImportFactState({ sourceId: fixtureId(12), metricIds: [fixtureId(201)], scopes: population, businessTime: period, factKeys: [] }).facts;
}
export function seedDataManualCorrection(repository: WorkbenchRepository): ManualCorrection {
  const original = dataScenarioFacts(repository).find(fact => fact.scope.id === fixtureId(101));
  if (!original) throw Error('Import a source fact before its correction');
  const correction: ManualCorrection = { ...makeHeader(700, { publicationAnchorId: fixtureId(2) }), factKey: original.factKey, originalFactRefs: [ref('observed_fact', original)], replacement: '72', reason: 'Согласованная ручная поправка' };
  repository.append('manual_correction', correction, null);
  return correction;
}
