import type { Decimal, EvaluationContext, Header, ScopeRef, UUIDv4, VersionRef } from '../../../src/domain/workbench/primitives';
import type { CanonicalSourceRow, DirectoryEntity, EvaluationInput, SourceDefinition, SourceFieldMapping, WorkbenchEntity, WorkbenchEntityType } from '../../../src/domain/workbench/entities';
import type { PublicationAnchor } from '../../../src/domain/workbench/publication';

export function fixtureId(seed: number): UUIDv4 {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffffffff) throw new Error('Fixture seed out of range');
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}
export function makeHeader(seed: number, overrides: Partial<Header> = {}): Header {
  return { schemaVersion: 1, id: fixtureId(seed), revision: 1, recordedAt: '2026-10-23T10:00:00Z', actor: { hostname: 'demo-host', installationId: fixtureId(1), profilePersonId: null }, publicationAnchorId: null, ...overrides };
}
export function versionRef(entityType: string, seed: number, revision = 1): VersionRef { return { entityType, id: fixtureId(seed), revision }; }
export function makeSourceRow(rowKey: string, numbers: Record<string, Decimal | null>): CanonicalSourceRow {
  return { rowKey, numbers, dimensions: {}, businessTime: { kind: 'as_of', date: '2026-10-23' }, unitCode: 'demo_unit' };
}
export function makePublicationAnchor(overrides: Partial<PublicationAnchor> = {}): PublicationAnchor {
  return { schemaVersion: 1, id: fixtureId(2), packageId: fixtureId(3), revision: 1, contentHash: `sha256:${'a'.repeat(64)}`, repositoryId: 'demo-repository', targetBranch: 'main', pullRequestId: 'demo-pr-1', proposalCommit: 'a'.repeat(40), mainCommit: 'b'.repeat(40), publicationState: 'confirmed', timeVerification: 'verified', mergedAt: '2026-10-23T08:00:00Z', verifiedAt: '2026-10-23T08:01:00Z', reason: null, ...overrides };
}
type NumericFixtureOptions = { seedBase?: number; scope?: ScopeRef; values?: Array<Decimal | null>; weights?: Decimal[]; mandatory?: boolean[]; targets?: Decimal[]; scoreTarget?: Decimal; expectedPopulation?: ScopeRef[]; observedPopulation?: ScopeRef[]; context?: EvaluationContext };

export function makeNumericFixture(options: NumericFixtureOptions = {}): EvaluationInput {
  const base = options.seedBase ?? 0;
  const id = (seed: number) => fixtureId(base + seed);
  const ref = (entityType: string, seed: number) => versionRef(entityType, base + seed);
  const header = (seed: number): Header => makeHeader(base + seed, { actor: { hostname: 'demo-host', installationId: id(1), profilePersonId: null }, publicationAnchorId: id(2) });
  const values = options.values ?? ['100'];
  const weights = options.weights ?? values.map(() => '100');
  const targets = options.targets ?? values.map(() => '100');
  const mandatory = options.mandatory ?? values.map(() => false);
  if (!values.length || [weights, targets, mandatory].some(v => v.length !== values.length)) throw new Error('Fixture metric lengths disagree');
  const scope = options.scope ?? { kind: 'product' as const, id: id(101) };
  const expectedPopulation = options.expectedPopulation ?? [scope];
  const observedPopulation = options.observedPopulation ?? expectedPopulation;
  const context = options.context ?? { evaluatedAt: '2026-10-23T12:00:00Z', businessTime: { kind: 'as_of' as const, date: '2026-10-23' } };
  const metrics = values.map((_, index) => ({ ...header(201 + index), name: `demo_metric_${index}`, unit: { code: 'demo_unit', label: 'Demo unit' }, domain: 'nonnegative_decimal' as const }));
  const method: EvaluationInput['method'] = { ...header(14), mode: 'numeric', rules: metrics.map((metric, index) => ({ metricRef: { entityType: 'metric_definition', id: metric.id, revision: metric.revision }, mandatory: mandatory[index], originalWeight: weights[index], condition: { op: 'gte', target: targets[index] }, normalization: { kind: 'increase_ratio_v1' }, freshness: { maxAgeHours: '168', updateEveryHours: '24' }, reducer: { kind: 'source_provided_value', valueField: 'demo_value' } })), formula: { kind: 'weighted_mean_v1', scoreCondition: { op: 'gte', target: options.scoreTarget ?? '100' } } };
  const canonicalRows = metrics.flatMap((metric, mi) => observedPopulation.map((member, pi) => ({ ...makeSourceRow(`demo_${mi}_${pi}`, { demo_value: values[mi] }), dimensions: { demo_metric_id: metric.id, demo_scope_id: member.id }, businessTime: context.businessTime })));
  const capture: EvaluationInput['captures'][number] = { ...header(301), sourceId: id(12), operationId: id(302), obtainedVia: 'direct', capturedAt: '2026-10-23T09:00:00Z', sourceUpdatedAt: '2026-10-23T09:00:00Z', payloadHash: `sha256:${'c'.repeat(64)}`, rawArtifactId: null, mappingRef: ref('source_field_mapping', 13), result: 'accepted', acceptedRows: canonicalRows.length, rejectedRows: 0, rawRows: canonicalRows.map(row => ({ rowKey: row.rowKey, cells: { demo_value: { kind: row.numbers.demo_value === null ? 'blank' : 'number', original: row.numbers.demo_value } } })), canonicalRows };
  const facts = metrics.flatMap((metric, mi) => observedPopulation.map((member, pi) => ({ ...header(10001 + mi * observedPopulation.length + pi), sourceId: id(12), captureId: capture.id, metricId: metric.id, scope: member, businessTime: context.businessTime, sourceUpdatedAt: capture.sourceUpdatedAt, origin: 'source_value' as const, state: values[mi] === null ? 'missing' as const : 'known' as const, value: values[mi], missingReason: values[mi] === null ? 'demo missing value' : null, unitCode: 'demo_unit', factKey: JSON.stringify([id(12), metric.id, member.kind, member.id, context.businessTime]), lineage: { captureId: capture.id, sourceRowKeys: [`demo_${mi}_${pi}`], mappingRef: capture.mappingRef, directoryLinkRefs: [], inputFactRefs: [], reducerMethodRef: null } })));
  return {
    assignment: { ...header(15), goalId: id(11), scope, methodBinding: { kind: 'standalone', methodRef: ref('method_version', 14) }, officialDueOn: null, expectedPopulation },
    goal: { ...header(11), title: 'demo_goal', description: '', mode: 'numeric', measurementMode: context.businessTime.kind, sourceId: id(12), primaryCuratorPersonId: id(17), coCuratorPersonIds: [], lifecycle: 'active', archiveReason: null },
    method, metrics, captures: [capture], facts, applicability: [], corrections: [], context,
    resolution: { basisRef: ref('evaluation_basis', 16), templateRef: null, directoryLinkRefs: [], publicationAnchors: [makePublicationAnchor({ id: id(2), packageId: id(3) })], actor: header(1).actor },
  };
}

export function makeEntityGraph(input: EvaluationInput = makeNumericFixture()): { anchors: PublicationAnchor[]; entries: Array<{ entityType: WorkbenchEntityType; value: WorkbenchEntity }>; input: EvaluationInput } {
  const entries: Array<{ entityType: WorkbenchEntityType; value: WorkbenchEntity }> = [];
  const add = (entityType: WorkbenchEntityType, value: WorkbenchEntity) => { entries.push({ entityType, value }); };
  const header = (id: UUIDv4): Header => ({ ...input.goal, id, revision: 1, schemaVersion: 1 });
  // Select only Header fields; spreading a goal into another strict entity would leak fields.
  const cleanHeader = (id: UUIDv4): Header => { const h = header(id); return { schemaVersion: h.schemaVersion, id, revision: h.revision, actor: h.actor, recordedAt: h.recordedAt, publicationAnchorId: h.publicationAnchorId }; };
  const members = new Map<string, ScopeRef>();
  [input.assignment.scope, ...(input.assignment.expectedPopulation ?? []), ...input.facts.map(f => f.scope)].forEach(scope => members.set(scope.id, scope));
  for (const scope of members.values()) {
    const entity: DirectoryEntity = { ...cleanHeader(scope.id), kind: scope.kind, name: `demo_${scope.kind}_${scope.id.slice(-4)}`, externalKeys: [] };
    add('directory_entity', entity);
  }
  for (const personId of [input.goal.primaryCuratorPersonId, ...input.goal.coCuratorPersonIds]) add('directory_entity', { ...cleanHeader(personId), kind: 'person', name: 'demo_curator', externalKeys: [] });
  const mappingRef = input.captures[0]?.mappingRef;
  if (!mappingRef) throw new Error('Graph fixture needs a capture/mapping reference');
  const source: SourceDefinition = { ...cleanHeader(input.goal.sourceId), goalId: input.goal.id, kind: 'qlik', mappingRef, publicLocator: 'https://example.org/demo-report' };
  const mapping: SourceFieldMapping = { ...cleanHeader(mappingRef.id), revision: mappingRef.revision, sourceId: source.id, rowKeyFields: ['demo_row_key'], dimensionFields: { demo_scope_id: 'demo_scope_id', demo_metric_id: 'demo_metric_id' }, productKeyField: 'demo_scope_id', fixedScope: null, metricFields: input.metrics.map(metric => ({ metricId: metric.id, fields: { demo_value: 'demo_value' } })), dateField: 'demo_date', periodStartField: null, periodEndField: null, unitField: null, fixedUnitCode: 'demo_unit' };
  add('source_definition', source); add('source_field_mapping', mapping);
  input.metrics.forEach(v => add('metric_definition', v));
  add('method_version', input.method); add('core_goal_definition', input.goal); add('goal_assignment', input.assignment);
  if (input.assignment.methodBinding.kind === 'template') add('template', { ...cleanHeader(input.assignment.methodBinding.templateId), name: 'demo_template', methodRef: { entityType: 'method_version', id: input.method.id, revision: input.method.revision } });
  input.captures.forEach(v => add('capture', v)); input.facts.forEach(v => add('observed_fact', v)); input.applicability.forEach(v => add('applicability', v)); input.corrections.forEach(v => add('manual_correction', v));
  return { anchors: input.resolution.publicationAnchors, entries, input };
}
