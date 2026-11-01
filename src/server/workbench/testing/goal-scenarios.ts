import type { CalculationResult, EvaluationBasis, GoalAssignment, MethodVersion, SourceDefinition, SourceFieldMapping } from '../../../domain/workbench/entities';
import type { Clock, VersionRef } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../storage/workbench-repository';
import type { GlobalContext } from '../protocol';
import { resolveEvaluationInput } from '../../../features/evaluation/workbench/resolve-input';
import { prepareEvaluation } from '../../../features/evaluation/workbench/prepare-evaluation';
import { validateAgreedSnapshot } from '../../../features/evaluation/workbench/state-rules';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
import type { SourceStore } from '../../../features/connectors/workbench-source-store';
import { sourcePayloadHash } from '../../../features/connectors/workbench-source-contracts';

export type GoalScenario = 'scope-split' | 'population-gap' | 'stale-fallback' | 'manual-goal' | 'agreed-history';
/** These fixtures persist domain entities and use the real resolver/materializer. */
export function seedGoalScenario({ repository, sources, clock, role, scenario }: { repository: WorkbenchRepository; sources: SourceStore; clock: Clock; role: 'viewer' | 'curator' | 'chief'; scenario: GoalScenario }) {
  const dit = { kind: 'dit' as const, id: fixtureId(100) }, cluster = { kind: 'cluster' as const, id: fixtureId(103) };
  const products = [101, 102].map(n => ({ kind: 'product' as const, id: fixtureId(n) }));
  const population = scenario === 'population-gap' ? products : [dit];
  const input = makeNumericFixture({ scope: dit, expectedPopulation: population, values: scenario === 'population-gap' ? ['92', '96'] : ['92'], targets: scenario === 'population-gap' ? ['90', '90'] : ['90'] });
  input.goal.title = 'Тестовая цель'; input.metrics.forEach(metric => { metric.unit = { code: 'percent', label: '%' }; });
  input.captures[0].canonicalRows.forEach(row => { row.unitCode = 'percent'; }); input.facts.forEach(fact => { fact.unitCode = 'percent'; });
  if (scenario === 'population-gap') {
    if (input.method.mode === 'numeric') input.method.rules[1] = { ...input.method.rules[1], reducer: { kind: 'sum', valueField: 'demo_value' }, condition: { op: 'gte', target: '190' } };
    input.facts = input.facts.filter(fact => !(fact.metricId === input.metrics[0].id && fact.scope.id === products[1].id));
    const capture = input.captures[0]; capture.canonicalRows = capture.canonicalRows.filter(row => row.rowKey !== 'demo_0_1'); capture.rawRows = capture.rawRows.filter(row => row.rowKey !== 'demo_0_1'); capture.acceptedRows--;
  }
  input.resolution.publicationAnchors[0] = { ...input.resolution.publicationAnchors[0], timeVerification: 'unknown', mergedAt: null };
  if (scenario === 'scope-split') {
    const capture = input.captures[0], fact = input.facts[0];
    capture.canonicalRows.push({ ...capture.canonicalRows[0], rowKey: 'demo_0_1', numbers: { demo_value: '88' }, dimensions: { demo_metric_id: input.metrics[0].id, demo_scope_id: cluster.id } });
    capture.rawRows.push({ rowKey: 'demo_0_1', cells: { demo_value: { kind: 'number', original: '88' } } }); capture.acceptedRows++;
    input.facts.push({ ...fact, id: fixtureId(10002), scope: cluster, value: '88', factKey: 'cluster-observation', lineage: { ...fact.lineage, sourceRowKeys: ['demo_0_1'] } });
  }
  const graph = makeEntityGraph(input), header = (seed: number) => makeHeader(seed, { publicationAnchorId: input.goal.publicationAnchorId });
  if (!graph.entries.some(e => e.entityType === 'directory_entity' && e.value.id === cluster.id)) graph.entries.push({ entityType: 'directory_entity', value: { ...header(103), kind: 'cluster', name: 'Кластер А', externalKeys: [] } });
  for (const [i, scope] of products.entries()) if (!graph.entries.some(e => e.entityType === 'directory_entity' && e.value.id === scope.id)) graph.entries.push({ entityType: 'directory_entity', value: { ...header(101 + i), kind: 'product', name: `Продукт ${i ? 'B' : 'A'}`, externalKeys: [] } });
  for (const entry of graph.entries) if (entry.entityType === 'directory_entity') {
    const entity = entry.value as import('../../../domain/workbench/entities').DirectoryEntity;
    if (entity.id === dit.id) entity.name = 'ДИТ';
    if (entity.id === cluster.id) entity.name = 'Кластер А';
    if (entity.id === products[0].id) entity.name = 'Продукт A';
    if (entity.id === products[1].id) entity.name = 'Продукт B';
  }
  graph.entries.push({ entityType: 'directory_link', value: { ...header(104), kind: 'dit_cluster', from: { entityType: 'directory_entity', id: dit.id }, to: { entityType: 'directory_entity', id: cluster.id } } });
  products.forEach((scope, i) => graph.entries.push({ entityType: 'directory_link', value: { ...header(105 + i), kind: 'cluster_product', from: { entityType: 'directory_entity', id: cluster.id }, to: { entityType: 'directory_entity', id: scope.id } } }));
  graph.entries.push({ entityType: 'directory_link', value: { ...header(107), kind: 'leader', scope: dit, personId: input.goal.primaryCuratorPersonId } });
  if (scenario === 'scope-split') {
    if (input.method.mode !== 'numeric') throw Error('Numeric scope fixture required');
    const method: MethodVersion = { ...input.method, id: fixtureId(114), rules: input.method.rules.map(rule => ({ ...rule, condition: { op: 'gte', target: '95' } })) };
    graph.entries.push({ entityType: 'method_version', value: method });
    graph.entries.push({ entityType: 'goal_assignment', value: { ...input.assignment, id: fixtureId(115), scope: cluster, expectedPopulation: [cluster], methodBinding: { kind: 'standalone', methodRef: versionRef('method_version', 114) } } });
  }
  if (scenario === 'manual-goal') {
    input.goal.mode = 'manual_status'; input.assignment.expectedPopulation = null;
    const source = graph.entries.find(e => e.entityType === 'source_definition')!.value as SourceDefinition;
    Object.assign(source, { kind: 'manual_status', mappingRef: null, publicLocator: null });
    graph.entries = graph.entries.filter(e => !['capture', 'observed_fact', 'method_version'].includes(e.entityType));
    graph.entries.push({ entityType: 'method_version', value: { ...header(14), mode: 'manual_status' } });
  }
  (graph.entries.find(e => e.entityType === 'source_field_mapping')!.value as SourceFieldMapping).fixedUnitCode = 'percent';
  if (scenario === 'stale-fallback') graph.entries = graph.entries.filter(e => !['capture', 'observed_fact'].includes(e.entityType));
  seedGraph(repository, graph);
  const refs: Record<string, VersionRef> = { goal: versionRef('core_goal_definition', 11), ditAssignment: versionRef('goal_assignment', 15), assignment: versionRef('goal_assignment', 15), clusterAssignment: versionRef('goal_assignment', 115), productA: versionRef('directory_entity', 101), productB: versionRef('directory_entity', 102), source: versionRef('source_definition', 12), method: versionRef('method_version', 14), metric: versionRef('metric_definition', 201) };
  const defaultContext: GlobalContext = { scopePath: { ditId: dit.id, clusterId: null, productId: null, teamId: null }, goalId: null, time: { kind: 'as_of', date: clock.now().slice(0, 10) }, resultMode: 'current', snapshotId: null };
  const actor = { hostname: 'test-workbench-host', installationId: fixtureId(1), profilePersonId: role === 'viewer' ? null : fixtureId(17) };
  if (scenario === 'stale-fallback') {
    // A successful retained local capture, not a published capture relabelled by UI.
    sources.installPublished([{ goalRef: refs.goal, sourceRef: refs.source, mappingRef: versionRef('source_field_mapping', 13), assignmentRef: refs.ditAssignment, templateRef: null, methodRef: refs.method, metricRefs: [refs.metric], directoryEntityRefs: [100, 101, 102, 103, 17].map(n => versionRef('directory_entity', n)), directoryLinkRefs: [104, 105, 106, 107].map(n => versionRef('directory_link', n)), directoryRevision: 'goal-directory-1' }]);
    sources.bindAdapter({ sourceId: refs.source.id, adapterKey: 'synthetic-goal-source', profileRef: null, revision: 'adapter-1' });
    sources.saveAllowedContext({ installationId: fixtureId(1), goalId: refs.goal.id, revision: 'context-1', context: { ...defaultContext, goalId: refs.goal.id } }, null);
    const binding = sources.resolveCapture({ installationId: fixtureId(1), goalId: refs.goal.id });
    const capture = { ...input.captures[0], actor, publicationAnchorId: null, payloadHash: sourcePayloadHash(input.captures[0].rawRows) };
    const facts = input.facts.map(fact => ({ ...fact, actor, publicationAnchorId: null }));
    const request = { operationId: capture.operationId, goalRef: refs.goal, sourceRef: refs.source, mappingRef: capture.mappingRef, businessTime: defaultContext.time, context: binding.context, configurationRevision: binding.configurationRevision, profileRef: null };
    repository.transaction(() => sources.commitCapture({ installationId: fixtureId(1), binding, request, capture, facts, issues: [], raw: { operationId: capture.operationId, sourceRef: refs.source, mappingRef: capture.mappingRef, capturedAt: capture.capturedAt, sourceUpdatedAt: capture.sourceUpdatedAt, rawRows: capture.rawRows, artifact: null, payloadHash: capture.payloadHash, coverage: { complete: true, expectedRows: capture.acceptedRows, receivedRows: capture.acceptedRows, evidence: ['Synthetic complete retained capture'] }, issues: [] } }));
    if (sources.readFallback({ installationId: fixtureId(1), goalId: refs.goal.id }).obtainedVia !== 'local-cache') throw Error('Expected actual retained local source cache');
  }
  const materialize = (assignmentRef: VersionRef) => prepareEvaluation(resolveEvaluationInput({ assignmentRef, businessTime: defaultContext.time }, repository, clock, actor), repository);
  if (scenario !== 'manual-goal') {
    const saved = materialize(refs.ditAssignment); Object.assign(refs, { basis: saved.basisRef, result: saved.resultRef! });
    if (scenario === 'scope-split') materialize(refs.clusterAssignment);
    if (scenario === 'agreed-history') {
      const basis: EvaluationBasis = { ...repository.readVersion<EvaluationBasis>(saved.basisRef)!, id: fixtureId(600), publicationAnchorId: input.goal.publicationAnchorId };
      const basisRef = versionRef('evaluation_basis', 600);
      const result: CalculationResult = { ...repository.readVersion<CalculationResult>(saved.resultRef!)!, id: fixtureId(601), basisRef, publicationAnchorId: input.goal.publicationAnchorId };
      const { schemaVersion, id, revision, recordedAt, actor: resultActor, publicationAnchorId, ...numericResult } = result;
      const snapshot = { ...header(602), basisRef, numericResult, manualStatusRef: null, attestationRef: null };
      validateAgreedSnapshot({ snapshot, basis, result, manualStatus: null, attestation: null });
      repository.transaction(() => { repository.append('evaluation_basis', basis, null); repository.append('calculation_result', result, null); repository.append('agreed_snapshot', snapshot, null); });
      refs.snapshot = versionRef('agreed_snapshot', 602);
      repository.append('core_goal_definition', { ...input.goal, revision: 2, title: 'Сегодняшняя цель' }, 1);
      const assignment = repository.readVersion<GoalAssignment>(refs.ditAssignment)!;
      repository.append('goal_assignment', { ...assignment, revision: 2, officialDueOn: '2026-12-01' }, 1);
      repository.append('observed_fact', { ...input.facts[0], revision: 2, value: '40' }, 1);
      materialize(versionRef('goal_assignment', 15, 2));
    }
  }
  return { refs, defaultContext };
}
