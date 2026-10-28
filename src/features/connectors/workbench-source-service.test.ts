import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { createJobStore } from '../../server/workbench/jobs';
import { createCommandStore, withCommandExecution } from '../../server/workbench/command-store';
import { createCommandRegistry, type CommandContext } from '../../server/workbench/command-registry';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { installHistoryIndex } from '../history/workbench-history-index';
import { resolveEvaluationInput } from '../evaluation/workbench/resolve-input';
import { selectEvaluationFacts } from '../evaluation/workbench/select-facts';
import type { Capture, DirectoryEntity, DirectoryLink } from '../../domain/workbench/entities';
import { captureResultSchema, captureRequestSchema, rawBatchSchema, sourcePayloadHash, type SourceAdapter, type NormalizerPort, type EnricherPort } from './workbench-source-contracts';
import { createSourceStore } from './workbench-source-store';
import { createSourceService, registerSourceCommands } from './workbench-source-service';
import { createSyntheticDemoSource, syntheticDemoNormalizer } from './workbench-demo-source';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-source-'));
  const config = { filename: path.join(root, 'db.sqlite'), artifactRoot: path.join(root, 'artifacts') };
  const repository = createWorkbenchRepository(config); installHistoryIndex(repository);
  cleanups.push(() => { repository.close(); if (!path.basename(root).startsWith('uor-source-')) throw Error('Invalid root'); rmSync(root, { recursive: true, force: true }); });
  const input = makeNumericFixture({ scope: { kind: 'dit', id: fixtureId(100) }, expectedPopulation: [{ kind: 'product', id: fixtureId(101) }, { kind: 'product', id: fixtureId(102) }] });
  const graph = makeEntityGraph(input); graph.entries = graph.entries.filter(e => !['capture', 'observed_fact'].includes(e.entityType));
  const directory = graph.entries.filter(e => e.entityType === 'directory_entity').map(e => e.value as DirectoryEntity);
  const cluster: DirectoryEntity = { ...makeHeader(103, { publicationAnchorId: fixtureId(2) }), kind: 'cluster', name: 'Synthetic cluster', externalKeys: [] };
  directory.push(cluster); graph.entries.push({ entityType: 'directory_entity', value: cluster });
  for (const entity of directory.filter(e => e.kind === 'product')) entity.externalKeys = [{ sourceId: input.goal.sourceId, key: entity.id === fixtureId(101) ? 'demo-product-a' : 'demo-product-b' }];
  const links: DirectoryLink[] = [
    { ...makeHeader(110, { publicationAnchorId: fixtureId(2) }), kind: 'dit_cluster', from: { entityType: 'directory_entity', id: fixtureId(100) }, to: { entityType: 'directory_entity', id: cluster.id } },
    ...[101, 102].map((id, i) => ({ ...makeHeader(111 + i, { publicationAnchorId: fixtureId(2) }), kind: 'cluster_product' as const, from: { entityType: 'directory_entity', id: cluster.id }, to: { entityType: 'directory_entity', id: fixtureId(id) } })),
  ];
  links.forEach(value => graph.entries.push({ entityType: 'directory_link', value })); seedGraph(repository, graph);
  const ref = (entityType: string, value: { id: string; revision: number }) => ({ entityType, id: value.id, revision: value.revision });
  const binding = { goalRef: ref('core_goal_definition', input.goal), sourceRef: ref('source_definition', graph.entries.find(e => e.entityType === 'source_definition')!.value), mappingRef: input.captures[0].mappingRef, assignmentRef: ref('goal_assignment', input.assignment), templateRef: null, methodRef: ref('method_version', input.method), metricRefs: input.metrics.map(m => ref('metric_definition', m)), directoryEntityRefs: directory.map(d => ref('directory_entity', d)), directoryLinkRefs: links.map(d => ref('directory_link', d)), directoryRevision: 'demo-directory-1' };
  const store = createSourceStore({ repository }); store.installPublished([binding]); store.bindAdapter({ sourceId: input.goal.sourceId, adapterKey: 'synthetic-demo', profileRef: null, revision: 'demo-1' });
  const saved = { installationId: fixtureId(1), goalId: input.goal.id, revision: 'selection-1', context: { scopePath: { ditId: fixtureId(100), clusterId: null, productId: null, teamId: null }, goalId: input.goal.id, time: { kind: 'as_of' as const, date: '2026-10-27' }, resultMode: 'current' as const, snapshotId: null } };
  store.saveAllowedContext(saved, null);
  const clock = { now: () => '2026-10-28T07:00:00Z' }; const jobs = createJobStore({ repository, clock });
  const ownAccess = { role: 'viewer' as const, displayName: null, personId: null, policyState: 'verified' as const, checkedAt: clock.now() };
  const context: CommandContext = { repository, clock, ownAccess, actor: makeHeader(1).actor, installationId: fixtureId(1), requestId: fixtureId(400), commandId: fixtureId(401) };
  const adapter = createSyntheticDemoSource({ clock });
  const adapters = new Map<string, SourceAdapter>([['synthetic-demo', adapter]]);
  const normalizer: NormalizerPort = { normalize: v => syntheticDemoNormalizer.normalize(v) };
  const enricher: EnricherPort = { enrich: ({ rows }) => ({ rows: rows.map(row => ({ ...row, scope: directory.find(d => d.externalKeys.some(k => k.sourceId === input.goal.sourceId && k.key === row.dimensions.demo_scope_id)) ? { kind: 'product' as const, id: directory.find(d => d.externalKeys.some(k => k.sourceId === input.goal.sourceId && k.key === row.dimensions.demo_scope_id))!.id } : null, directoryEntityRefs: [] })), issues: [], directoryLinkRefs: links.map(d => ref('directory_link', d)) }) };
  let guard: () => Promise<void> = async () => {};
  const service = createSourceService({ repository, store, adapters, normalizer, enricher, jobs, clock, recheckGuard: async () => guard() });
  const appendedTypes: string[] = []; repository.registerProjection('test-source-observer', type => { appendedTypes.push(type); });
  let command = 500;
  const begin = () => { const ctx = { ...context, commandId: fixtureId(command++) }; createCommandStore(repository).begin({ commandId: ctx.commandId, name: 'source.capture', payload: { goalId: input.goal.id }, baseRevision: null }, ctx.installationId); const job = jobs.create(ctx.commandId, ctx.installationId, 'source.capture'); jobs.setResourceKey(job.jobId, 'source:' + store.sourceIdForGoal(input.goal.id)); jobs.update(job.jobId, { status: 'running' }); return { ctx, job }; };
  const execute = (ctx: CommandContext) => withCommandExecution(ctx, captureResultSchema, () => service.capture(ctx, { goalId: input.goal.id }));
  const capture = () => execute(begin().ctx);
  const fallback = () => store.readFallback({ installationId: context.installationId, goalId: input.goal.id });
  return { root, config, repository, input, graph, binding, store, saved, context, clock, jobs, adapter, adapters, normalizer, enricher, service, begin, execute, capture, fallback, appendedTypes, setGuard: (next: typeof guard) => { guard = next; } };
}

it('viewer_capture_preserves_raw_and_does_not_confirm', async () => {
  const f = fixture(); const result = await f.capture(); expect(result).toMatchObject({ acceptedRows: 2, rejectedRows: 0, duplicate: false });
  const capture = f.repository.readVersion<Capture>(result.captureRef)!;
  expect(capture.operationId).not.toBe(f.context.commandId); expect(capture.rawRows[0].cells.demo_value.original).toBe('92.00'); expect(capture.canonicalRows[0].numbers.demo_value).toBe('92');
  const evidence = f.store.readCapture(result.captureRef, f.context.installationId)!; expect(evidence.facts).toHaveLength(2); expect(evidence.facts[0]).toMatchObject({ value: '92', origin: 'source_value', publicationAnchorId: null });
  expect(evidence.facts[0].lineage.sourceRowKeys).toEqual(['demo-a']);
  expect(f.repository.sqlForModule('history').all('SELECT id FROM wb_history_observations')).toHaveLength(2);
  expect(f.fallback()).toMatchObject({ obtainedVia: 'local-cache', sourceDate: '2026-10-27' });
  expect(f.repository.getHead({ entityType: 'attestation', id: result.captureRef.id })).toBeNull();
  expect(f.appendedTypes).toEqual(['capture', 'observed_fact', 'observed_fact']);
});
it('failed_collection_coverage_cancel_and_guard_keep_last_success', async () => {
  const f = fixture(); const first = await f.capture(); const original = f.adapter.collect;
  f.adapter.collect = async () => { throw new WorkbenchHttpError(422, 'SOURCE_SCHEMA_CHANGED', 'Synthetic change'); };
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_CHANGED' });
  f.adapter.collect = async (r, s) => ({ ...await original(r, s), coverage: { complete: false, expectedRows: 3, receivedRows: 2, evidence: ['truncated'] } });
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_INCOMPLETE' });
  f.adapter.collect = original;
  f.setGuard(async () => { throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Revoked'); }); await expect(f.capture()).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  f.setGuard(async () => {});
  const run = f.begin(); f.adapter.collect = async (r, s) => { await f.jobs.cancel(run.job.jobId, run.ctx.installationId); s.throwIfAborted(); return original(r, s); };
  await expect(f.execute(run.ctx)).rejects.toMatchObject({ code: 'SOURCE_CANCELLED' });
  expect(f.fallback().captureRef).toEqual(first.captureRef);
});
it('revalidates_saved_context_and_atomic_receipt_rolls_back_projection_failure', async () => {
  const f = fixture(); const first = await f.capture(); const collect = f.adapter.collect;
  f.adapter.collect = async (r, s) => { f.store.saveAllowedContext({ ...f.saved, revision: 'selection-2' }, f.saved.revision); return collect(r, s); };
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_CONFIGURATION_CHANGED' }); expect(f.fallback().captureRef).toEqual(first.captureRef);
  f.adapter.collect = collect; const run = f.begin();
  f.repository.registerProjection('test-failure', type => { if (type === 'observed_fact') throw Error('projection failure'); });
  await expect(f.execute(run.ctx)).rejects.toThrow('projection failure');
  expect(createCommandStore(f.repository).get(run.ctx.installationId, run.ctx.commandId)?.receipt_json).toBeNull();
  expect(f.store.findOperation(run.ctx.installationId, run.job.jobId)).toBeNull(); expect(f.fallback().captureRef).toEqual(first.captureRef);
});
it('deduplicates_operation_with_receipt_after_restart_and_new_operation_same_value_is_new_capture', async () => {
  const f = fixture(); const run = f.begin(); const one = await f.execute(run.ctx); const two = await f.execute(run.ctx); expect(two.captureRef).toEqual(one.captureRef); expect(two.duplicate).toBe(true);
  expect(JSON.parse(createCommandStore(f.repository).get(run.ctx.installationId, run.ctx.commandId)!.receipt_json!).result.captureRef).toEqual(one.captureRef);
  const freshStore = createSourceStore({ repository: f.repository }); expect(freshStore.findOperation(run.ctx.installationId, run.job.jobId)?.captureRef).toEqual(one.captureRef);
  expect(freshStore.readCapture(one.captureRef, fixtureId(999))).toBeNull();
  const next = await f.capture(); expect(next.captureRef.id).not.toBe(one.captureRef.id); expect(f.fallback().sourceDate).toBe('2026-10-27');
  await expect(withCommandExecution(run.ctx, captureResultSchema, () => f.service.capture(run.ctx, { goalId: fixtureId(999) }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
it('requires_published_configuration_saved_context_and_qlik_kind', async () => {
  const f = fixture(); f.store.bindAdapter({ sourceId: f.input.goal.sourceId, adapterKey: 'missing', profileRef: null, revision: '2' }); await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  const source = f.repository.readVersion<any>(f.binding.sourceRef)!; f.repository.append('source_definition', { ...source, revision: 2, kind: 'file' }, 1);
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNSUPPORTED' });
  expect(() => f.store.resolveCapture({ installationId: fixtureId(999), goalId: f.input.goal.id })).toThrowError(expect.objectContaining({ code: 'SOURCE_CONTEXT_REQUIRED' }));
});
it('missing_mapping_remains_diagnostic_partial_and_unknown_date_stays_unknown', async () => {
  const f = fixture(); const normal = f.normalizer.normalize;
  f.normalizer.normalize = v => { const out = normal(v); out.rows[0].numbers.demo_value = null; out.rows.forEach(r => { r.businessTime = { kind: 'unknown' }; }); return out; };
  const result = await f.capture(); const data = f.store.readCapture(result.captureRef, f.context.installationId)!;
  expect(data.capture.result).toBe('partial'); expect(data.facts[0]).toMatchObject({ state: 'missing', value: null, businessTime: { kind: 'unknown' } }); expect(data.issues.length).toBeGreaterThan(0); expect(f.fallback().obtainedVia).toBe('no-data');
});
it('registers_real_async_viewer_command_and_strict_payload', async () => {
  const f = fixture(); const policy = { resolveOwnAccess: async () => f.context.ownAccess, assertCommandAllowed: async () => f.context.ownAccess, assertFreshPublishAllowed: async () => f.context.ownAccess };
  const registry = createCommandRegistry({ repository: f.repository, jobs: f.jobs, accessPolicy: policy }); registerSourceCommands(registry, f.service);
  expect(registry.getCapability('source.capture')).toBe('capture.local');
  await expect(registry.execute({ commandId: f.context.commandId, name: 'source.capture', baseRevision: null, payload: { goalId: f.input.goal.id, context: f.saved.context } }, f.context)).rejects.toMatchObject({ statusCode: 422 });
  const accepted = await registry.execute({ commandId: f.context.commandId, name: 'source.capture', baseRevision: null, payload: { goalId: f.input.goal.id } }, f.context); await registry.idle();
  expect(f.jobs.get((accepted as { jobId: string }).jobId, f.context.installationId)).toMatchObject({ status: 'succeeded', result: { acceptedRows: 2 } });
});

it('persists_immutable_raw_coverage_issues_and_verified_artifacts_across_repository_reopen', async () => {
  const f = fixture(); const bytes = new TextEncoder().encode('synthetic private raw bytes');
  const artifact = f.store.saveArtifact({ installationId: f.context.installationId, artifactId: fixtureId(800), mimeType: 'text/csv', bytesValue: bytes });
  expect(() => f.store.assertArtifact(fixtureId(999), artifact)).toThrowError(expect.objectContaining({ code: 'SOURCE_ARTIFACT_INVALID' }));
  expect(() => f.store.saveArtifact({ installationId: f.context.installationId, artifactId: artifact.artifactId, mimeType: 'text/csv', bytesValue: new Uint8Array([0]) })).toThrowError(expect.objectContaining({ code: 'SOURCE_ARTIFACT_CONFLICT' }));
  const collect = f.adapter.collect; f.adapter.collect = async (r, s) => ({ ...await collect(r, s), artifact, payloadHash: artifact.hash });
  const run = f.begin(); const result = await f.execute(run.ctx); const raw = f.store.readCapture(result.captureRef, f.context.installationId)!;
  raw.capture.rawRows[0].cells.demo_value.original = 'mutated'; expect(f.store.readCapture(result.captureRef, f.context.installationId)!.capture.rawRows[0].cells.demo_value.original).toBe('92.00');
  f.repository.close(); const reopened = createWorkbenchRepository(f.config); cleanups.push(() => reopened.close()); const store = createSourceStore({ repository: reopened });
  expect(store.findOperation(run.ctx.installationId, run.job.jobId)).toEqual(result); expect(store.readCapture(result.captureRef, f.context.installationId)?.coverage.evidence).toEqual(['synthetic-demo:complete-two-product-inventory']);
  expect(store.readLatestAttempt({ installationId: f.context.installationId, goalId: f.input.goal.id })).toMatchObject({ complete: true, captureRef: result.captureRef });
  expect(store.readFallback({ installationId: f.context.installationId, goalId: f.input.goal.id })).toMatchObject({ obtainedVia: 'local-cache', sourceDate: '2026-10-27' });
  expect(() => store.assertArtifact(f.context.installationId, artifact)).not.toThrow();
  expect(JSON.parse(createCommandStore(reopened).get(run.ctx.installationId, run.ctx.commandId)!.receipt_json!).result.captureRef).toEqual(result.captureRef);
});
it('uses_verified_git_without_writes_preserves_original_dates_and_never_uses_file_for_qlik', async () => {
  const f = fixture(); const legacy = f.input.captures[0]; const capture = { ...legacy, id: fixtureId(850), acceptedRows: 2 };
  const facts = f.input.facts.map((fact, i) => ({ ...fact, id: fixtureId(851 + i), captureId: capture.id, businessTime: { kind: 'as_of' as const, date: '2026-10-21' }, lineage: { ...fact.lineage, captureId: capture.id } }));
  f.repository.transaction(() => { f.repository.append('capture', capture, null); facts.forEach(fact => f.repository.append('observed_fact', fact, null)); });
  f.store.installVerifiedGit({ goalId: f.input.goal.id, captureRef: { entityType: 'capture', id: capture.id, revision: 1 }, factRefs: facts.map(fact => ({ entityType: 'observed_fact', id: fact.id, revision: 1 })), context: f.saved.context, coverage: { complete: true, expectedRows: 2, receivedRows: 2, evidence: ['verified-manifest-coverage'] } });
  const before = f.repository.getStateRevision(); expect(f.fallback()).toMatchObject({ obtainedVia: 'git', sourceDate: '2026-10-21', capturedAt: legacy.capturedAt }); expect(f.repository.getStateRevision()).toBe(before);
  await f.capture(); expect(f.fallback().obtainedVia).toBe('local-cache');
  const unknown = f.normalizer.normalize; f.normalizer.normalize = v => { const out = unknown(v); out.rows.forEach(r => { r.businessTime = { kind: 'unknown' }; }); return out; };
  await f.capture(); expect(f.fallback()).toMatchObject({ obtainedVia: 'local-cache', sourceDate: null, businessTimes: [{ kind: 'unknown' }] });
  const fileCapture = { ...capture, id: fixtureId(860), obtainedVia: 'file_import' as const }; f.repository.append('capture', fileCapture, null);
  f.store.installVerifiedGit({ goalId: f.input.goal.id, captureRef: { entityType: 'capture', id: fileCapture.id, revision: 1 }, factRefs: [], context: f.saved.context, coverage: { complete: true, expectedRows: 2, receivedRows: 2, evidence: ['verified'] } });
  // A separate installation with the same allowed selection has no local cache and cannot use the file delivery.
  f.store.saveAllowedContext({ ...f.saved, installationId: fixtureId(888) }, null);
  expect(f.store.readFallback({ installationId: fixtureId(888), goalId: f.input.goal.id })).toMatchObject({ obtainedVia: 'no-data', captureRef: null });
});
it('rejects_exact_batch_corruption_and_enricher_invented_or_multiplied_rows', async () => {
  const f = fixture(); const collect = f.adapter.collect;
  for (const modify of [
    (r: any) => { r.payloadHash = `sha256:${'0'.repeat(64)}`; },
    (r: any) => { r.operationId = fixtureId(777); },
    (r: any) => { r.coverage.expectedRows = 3; },
    (r: any) => { r.coverage.evidence = []; },
  ]) { f.adapter.collect = async (r, s) => { const raw = await collect(r, s); modify(raw); return raw; }; await expect(f.capture()).rejects.toMatchObject({ statusCode: 422 }); }
  f.adapter.collect = collect; const enrich = f.enricher.enrich;
  f.enricher.enrich = v => { const out = enrich(v); out.rows.push(out.rows[0]); return out; }; await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_ROW_MISMATCH' });
  f.enricher.enrich = v => { const out = enrich(v); out.rows[0].scope = { kind: 'product', id: fixtureId(999) }; return out; };
  const result = await f.capture(); const evidence = f.store.readCapture(result.captureRef, f.context.installationId)!; expect(evidence.capture).toMatchObject({ result: 'partial', acceptedRows: 1, rejectedRows: 1 }); expect(evidence.issues.some(i => i.code === 'REQUIRED_SCOPE_UNRESOLVED')).toBe(true); expect(f.fallback().obtainedVia).toBe('no-data');
});
it('uses_exact_decimal_and_shared_reducers_without_per_row_competing_facts', async () => {
  const f = fixture(); const method = f.repository.readVersion<any>(f.binding.methodRef)!;
  f.repository.append('method_version', { ...method, revision: 2, rules: [{ ...method.rules[0], reducer: { kind: 'sum', valueField: 'demo_value' } }] }, 1);
  const assignment = f.repository.readVersion<any>(f.binding.assignmentRef)!;
  f.repository.append('goal_assignment', { ...assignment, revision: 2, methodBinding: { kind: 'standalone', methodRef: { ...f.binding.methodRef, revision: 2 } } }, 1);
  const collect = f.adapter.collect; f.adapter.collect = async (r, s) => { const raw = await collect(r, s); raw.rawRows[0].cells.demo_value.original = '900719925474099312345.50'; raw.rawRows[1].cells.demo_value.original = '0.50'; raw.rawRows[1].cells.demo_scope_id.original = 'demo-product-a'; raw.payloadHash = sourcePayloadHash(raw.rawRows); return raw; };
  const result = await f.capture(); const evidence = f.store.readCapture(result.captureRef, f.context.installationId)!;
  expect(evidence.facts).toHaveLength(1); expect(evidence.facts[0]).toMatchObject({ origin: 'reducer', value: { numerator: '900719925474099312346', denominator: '1' }, lineage: { sourceRowKeys: ['demo-a', 'demo-b'], reducerMethodRef: { ...f.binding.methodRef, revision: 2 } } });
  expect(evidence.capture.result).toBe('partial'); // Published expected product B remains explicitly missing.
});
it('rejects_flat_field_collisions_and_multi_unit_profiles_and_accepts_same_unit_multi_metric_rows', async () => {
  const f = fixture(); const metric2 = { ...f.input.metrics[0], id: fixtureId(900), name: 'Synthetic metric two' }; f.repository.append('metric_definition', metric2, null);
  const method = f.repository.readVersion<any>(f.binding.methodRef)!; const method2 = { ...method, revision: 2, rules: [...method.rules, { ...method.rules[0], metricRef: { entityType: 'metric_definition', id: metric2.id, revision: 1 }, reducer: { kind: 'source_provided_value', valueField: 'second' } }] }; f.repository.append('method_version', method2, 1);
  const assignment = f.repository.readVersion<any>(f.binding.assignmentRef)!; f.repository.append('goal_assignment', { ...assignment, revision: 2, methodBinding: { kind: 'standalone', methodRef: { ...f.binding.methodRef, revision: 2 } } }, 1);
  const mapping = f.repository.readVersion<any>(f.binding.mappingRef)!; f.repository.append('source_field_mapping', { ...mapping, revision: 2, metricFields: [...mapping.metricFields, { metricId: metric2.id, fields: { second: 'demo_value' } }] }, 1);
  const source = f.repository.readVersion<any>(f.binding.sourceRef)!; f.repository.append('source_definition', { ...source, revision: 2, mappingRef: { ...f.binding.mappingRef, revision: 2 } }, 1);
  const result = await f.capture(); const view = f.store.readCapture(result.captureRef, f.context.installationId)!; expect(view.capture.canonicalRows).toHaveLength(2); expect(view.facts).toHaveLength(4); expect(view.facts.every(fact => fact.value === '92')).toBe(true);
  f.repository.append('source_field_mapping', { ...mapping, revision: 3, metricFields: [...mapping.metricFields, { metricId: metric2.id, fields: { demo_value: 'other', second: 'demo_value' } }] }, 2);
  f.repository.append('source_definition', { ...source, revision: 3, mappingRef: { ...f.binding.mappingRef, revision: 3 } }, 2);
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_INVALID_CONFIGURATION' });
  f.repository.append('metric_definition', { ...metric2, revision: 2, unit: { code: 'incompatible-unit', label: 'Other' } }, 1);
  f.repository.append('method_version', { ...method2, revision: 3, rules: [method2.rules[0], { ...method2.rules[1], metricRef: { entityType: 'metric_definition', id: metric2.id, revision: 2 } }] }, 2);
  f.repository.append('goal_assignment', { ...assignment, revision: 3, methodBinding: { kind: 'standalone', methodRef: { ...f.binding.methodRef, revision: 3 } } }, 2);
  await expect(f.capture()).rejects.toMatchObject({ code: 'UNSUPPORTED_REDUCER' });
});

it('rejects_source_identity_changed_while_queued_before_collection', async () => {
  const f = fixture(); let release!: () => void; const parked = new Promise<void>(resolve => { release = resolve; });
  const policy = { resolveOwnAccess: async () => f.context.ownAccess, assertCommandAllowed: async () => f.context.ownAccess, assertFreshPublishAllowed: async () => f.context.ownAccess };
  const registry = createCommandRegistry({ repository: f.repository, jobs: f.jobs, accessPolicy: policy });
  registry.register({ name: 'demo.park', inputSchema: z.strictObject({}), outputSchema: z.strictObject({ done: z.boolean() }), capability: 'personal.write', effect: 'local', execution: 'async', resourceKey: () => 'source:' + f.input.goal.sourceId, handler: async () => { await parked; return { result: { done: true }, changedRefs: [], editToken: null }; } });
  registerSourceCommands(registry, f.service);
  const blockContext = { ...f.context, commandId: fixtureId(950) }; await registry.execute({ commandId: blockContext.commandId, name: 'demo.park', baseRevision: null, payload: {} }, blockContext);
  let collections = 0; const collect = f.adapter.collect; f.adapter.collect = async (r, s) => { collections++; return collect(r, s); };
  const accepted = await registry.execute({ commandId: f.context.commandId, name: 'source.capture', baseRevision: null, payload: { goalId: f.input.goal.id } }, f.context);
  const source = f.repository.readVersion<any>(f.binding.sourceRef)!; const mapping = f.repository.readVersion<any>(f.binding.mappingRef)!;
  const sourceRef = { entityType: 'source_definition', id: fixtureId(960), revision: 1 }; const mappingRef = { entityType: 'source_field_mapping', id: fixtureId(961), revision: 1 };
  f.repository.transaction(() => { f.repository.append('source_definition', { ...source, id: sourceRef.id, mappingRef }, null); f.repository.append('source_field_mapping', { ...mapping, id: mappingRef.id, sourceId: sourceRef.id }, null); f.repository.append('core_goal_definition', { ...f.input.goal, revision: 2, sourceId: sourceRef.id }, 1); });
  f.store.installPublished([{ ...f.binding, goalRef: { ...f.binding.goalRef, revision: 2 }, sourceRef, mappingRef }]);
  f.store.bindAdapter({ sourceId: sourceRef.id, adapterKey: 'synthetic-demo', profileRef: null, revision: 'replacement-source' });
  release(); await registry.idle();
  expect(f.jobs.get((accepted as { jobId: string }).jobId, f.context.installationId)).toMatchObject({ status: 'failed', error: { code: 'SOURCE_CONFIGURATION_CHANGED' } }); expect(collections).toBe(0);
});

it('directory_and_adapter_revisions_and_late_cancel_abort_before_atomic_commit', async () => {
  const f = fixture(); const first = await f.capture(); const collect = f.adapter.collect;
  f.adapter.collect = async (r, s) => { const entity = f.repository.readVersion<DirectoryEntity>(f.binding.directoryEntityRefs[0])!; f.repository.append('directory_entity', { ...entity, revision: entity.revision + 1, name: 'Published directory changed' }, entity.revision); return collect(r, s); };
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_CONFIGURATION_CHANGED' });
  f.adapter.collect = async (r, s) => { f.store.bindAdapter({ sourceId: f.input.goal.sourceId, adapterKey: 'synthetic-demo', profileRef: null, revision: 'changed-during-collect' }); return collect(r, s); };
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_CONFIGURATION_CHANGED' });
  f.adapter.collect = collect; const run = f.begin(); f.setGuard(async () => { await f.jobs.cancel(run.job.jobId, run.ctx.installationId); });
  await expect(f.execute(run.ctx)).rejects.toMatchObject({ code: 'SOURCE_CANCELLED' }); expect(f.fallback().captureRef).toEqual(first.captureRef);
});
it('strict_source_dtos_and_explicit_adapter_readiness_do_not_create_facts', async () => {
  const f = fixture(); const binding = f.store.resolveCapture({ installationId: f.context.installationId, goalId: f.input.goal.id });
  const request = { operationId: fixtureId(990), goalRef: binding.goalRef, sourceRef: binding.sourceRef, mappingRef: binding.mappingRef, businessTime: binding.businessTime, context: binding.context, configurationRevision: binding.configurationRevision, profileRef: null };
  expect(captureRequestSchema.safeParse({ ...request, password: 'forbidden' }).success).toBe(false);
  const raw = await f.adapter.collect(request, new AbortController().signal); expect(rawBatchSchema.safeParse({ ...raw, clientPath: 'C:/private.xlsx' }).success).toBe(false);
  for (const status of ['auth_required', 'unavailable', 'unsupported', 'invalid_configuration'] as const) { f.adapter.check = async () => ({ status, issues: [] }); await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_' + status.toUpperCase() }); }
  expect(f.appendedTypes).toEqual([]);
  const noSelection = { ...f.context, installationId: fixtureId(994), actor: { ...f.context.actor, installationId: fixtureId(994) } };
  await expect(f.service.capture(noSelection, { goalId: f.input.goal.id })).rejects.toMatchObject({ code: 'SOURCE_JOB_REQUIRED' });
});

it('exposes_latest_partial_attempt_beside_retained_complete_data_for_required_T17_T21_gate', async () => {
  const f = fixture(); const method = f.repository.readVersion<any>(f.binding.methodRef)!;
  const saved = { ...f.saved, revision: 'current-day', context: { ...f.saved.context, time: { kind: 'as_of' as const, date: '2026-10-28' } } }; f.store.saveAllowedContext(saved, f.saved.revision);
  f.repository.append('method_version', { ...method, revision: 2, rules: [{ ...method.rules[0], reducer: { kind: 'sum', valueField: 'demo_value' } }] }, 1);
  const assignment = f.repository.readVersion<any>(f.binding.assignmentRef)!; const assignmentRef = { ...f.binding.assignmentRef, revision: 2 };
  f.repository.append('goal_assignment', { ...assignment, revision: 2, methodBinding: { kind: 'standalone', methodRef: { ...f.binding.methodRef, revision: 2 } } }, 1);
  const complete = await f.capture(); const enrich = f.enricher.enrich;
  f.clock.now = () => '2026-10-28T08:00:00Z';
  f.enricher.enrich = input => { const result = enrich(input); result.rows[1].scope = null; return result; };
  const partial = await f.capture();
  const calculationInput = resolveEvaluationInput({ assignmentRef, businessTime: saved.context.time }, f.repository, f.clock, f.context.actor);
  // The existing pure selector intentionally retains valid historical B; future consumers must ALSO read the current ingestion gate.
  expect(selectEvaluationFacts(calculationInput)).toMatchObject({ complete: true, qualityFlags: [], metrics: [expect.objectContaining({ value: { numerator: '184', denominator: '1' } })] });
  const before = f.repository.getStateRevision(); const view = f.fallback();
  expect(view).toMatchObject({ captureRef: complete.captureRef, coverage: { complete: true }, latestAttempt: { captureRef: partial.captureRef, complete: false, acceptedRows: 1, rejectedRows: 1 }, warnings: expect.arrayContaining([expect.objectContaining({ code: 'LATEST_SOURCE_ATTEMPT_INCOMPLETE' })]) });
  expect(view.latestAttempt!.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['REQUIRED_SCOPE_UNRESOLVED', 'EXPECTED_SCOPE_MISSING'])); expect(f.repository.getStateRevision()).toBe(before);
  f.clock.now = () => '2026-10-28T09:00:00Z'; f.enricher.enrich = input => { const result = enrich(input); result.rows.forEach(row => { row.scope = null; }); return result; };
  const empty = await f.capture(); expect(f.store.readCapture(empty.captureRef, f.context.installationId)?.facts).toEqual([]);
  const reloaded = createSourceStore({ repository: f.repository }); expect(reloaded.readLatestAttempt({ installationId: f.context.installationId, goalId: f.input.goal.id })).toMatchObject({ captureRef: empty.captureRef, complete: false, acceptedRows: 0, rejectedRows: 2 });
  f.store.saveAllowedContext({ ...saved, installationId: fixtureId(997) }, null); expect(f.store.readLatestAttempt({ installationId: fixtureId(997), goalId: f.input.goal.id })).toBeNull();
  f.store.saveAllowedContext({ ...saved, revision: 'other-context', context: { ...saved.context, time: { kind: 'as_of', date: '2026-10-26' } } }, saved.revision); expect(f.store.readLatestAttempt({ installationId: f.context.installationId, goalId: f.input.goal.id })).toBeNull();
  f.store.saveAllowedContext({ ...saved, revision: 'restored-context' }, 'other-context');
  f.clock.now = () => '2026-10-28T10:00:00Z'; f.enricher.enrich = enrich; const corrected = await f.capture();
  expect(f.fallback()).toMatchObject({ captureRef: corrected.captureRef, latestAttempt: { complete: true, captureRef: corrected.captureRef }, warnings: [] });
  expect(f.store.readCapture(complete.captureRef, f.context.installationId)?.capture.result).toBe('accepted'); expect(f.store.readCapture(partial.captureRef, f.context.installationId)?.capture.result).toBe('partial');
});

it('inapplicable_old_source_local_pointer_continues_to_valid_replacement_source_git_without_writes', async () => {
  const f = fixture(); const local = await f.capture(); const original = f.store.readCapture(local.captureRef, f.context.installationId)!;
  const source = f.repository.readVersion<any>(f.binding.sourceRef)!; const mapping = f.repository.readVersion<any>(f.binding.mappingRef)!;
  const sourceRef = { entityType: 'source_definition', id: fixtureId(970), revision: 1 }; const mappingRef = { entityType: 'source_field_mapping', id: fixtureId(971), revision: 1 };
  f.repository.transaction(() => { f.repository.append('source_definition', { ...source, id: sourceRef.id, mappingRef }, null); f.repository.append('source_field_mapping', { ...mapping, id: mappingRef.id, sourceId: sourceRef.id }, null); f.repository.append('core_goal_definition', { ...f.input.goal, revision: 2, sourceId: sourceRef.id }, 1); });
  f.store.installPublished([{ ...f.binding, goalRef: { ...f.binding.goalRef, revision: 2 }, sourceRef, mappingRef }]); f.store.bindAdapter({ sourceId: sourceRef.id, adapterKey: 'synthetic-demo', profileRef: null, revision: 'replacement' });
  const capture: Capture = { ...original.capture, id: fixtureId(972), operationId: fixtureId(973), sourceId: sourceRef.id, mappingRef, publicationAnchorId: fixtureId(2), capturedAt: '2026-10-26T08:00:00Z' };
  const facts = original.facts.map((fact, i) => ({ ...fact, id: fixtureId(974 + i), sourceId: sourceRef.id, captureId: capture.id, publicationAnchorId: fixtureId(2), businessTime: { kind: 'as_of' as const, date: '2026-10-25' }, lineage: { ...fact.lineage, captureId: capture.id, mappingRef } }));
  f.repository.transaction(() => { f.repository.append('capture', capture, null); facts.forEach(fact => f.repository.append('observed_fact', fact, null)); });
  const captureRef = { entityType: 'capture', id: capture.id, revision: 1 };
  f.store.installVerifiedGit({ goalId: f.input.goal.id, captureRef, factRefs: facts.map(fact => ({ entityType: 'observed_fact', id: fact.id, revision: 1 })), context: f.saved.context, coverage: { complete: true, expectedRows: 2, receivedRows: 2, evidence: ['replacement-verified-main'] } });
  const before = f.repository.getStateRevision(); expect(f.fallback()).toMatchObject({ obtainedVia: 'git', sourceId: sourceRef.id, captureRef, sourceDate: '2026-10-25', capturedAt: '2026-10-26T08:00:00Z' }); expect(f.repository.getStateRevision()).toBe(before);
});
