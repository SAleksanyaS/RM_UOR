import { z } from 'zod';
import type { CanonicalSourceRow, Capture, ObservedFact } from '../../domain/workbench/entities';
import type { Clock, Header, ScopeRef, VersionRef } from '../../domain/workbench/primitives';
import { newUuid } from '../../domain/workbench/primitives';
import { canonicalSourceRowSchema } from '../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext, CommandRegistry } from '../../server/workbench/command-registry';
import { commitCommandEffect, stableJson } from '../../server/workbench/command-store';
import type { JobStore } from '../../server/workbench/jobs';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { reduceRows } from '../evaluation/workbench/reducers';
import { captureInputSchema, captureRequestSchema, captureResultSchema, enrichmentResultSchema, rawBatchSchema, sourceCheckSchema, sourceIssueSchema, sourcePayloadHash, type CaptureResult, type EnricherPort, type NormalizerPort, type SourceAdapter, type SourceIssue } from './workbench-source-contracts';
import { sourceScopeReachable, type ResolvedCaptureBinding, type SourceStore } from './workbench-source-store';

export type SourceJobs = Pick<JobStore, 'findByCommand' | 'getResourceKey' | 'registerControl' | 'registerStage' | 'stage'>;
export interface SourceService { capture(context: CommandContext, input: { goalId: string }): Promise<CaptureResult>; sourceIdForGoal(goalId: string): string }
const problem = (code: string, message: string, status = 422): never => { throw new WorkbenchHttpError(status, code, message); };
const scopeKey = (scope: ScopeRef) => `${scope.kind}/${scope.id}`;
const issue = (code: string, rowKeys: string[], refs: VersionRef[] = []): SourceIssue => ({ code, stage: 'normalize', retryable: false, message: 'Source rows require a valid published mapping or value', rowKeys, refs: refs.map(({ entityType, id }) => ({ entityType, id })) });

function validateProfile(binding: ResolvedCaptureBinding): void {
  if (binding.source.kind !== 'qlik' || binding.goal.mode !== 'numeric' || binding.method.mode !== 'numeric') return problem('SOURCE_UNSUPPORTED', 'Only the configured numeric automatic source can be captured');
  if (!binding.assignment.expectedPopulation?.length || !binding.mapping.fixedScope && !binding.mapping.productKeyField) return problem('SOURCE_INVALID_CONFIGURATION', 'Published population and scope mapping are required');
  if (new Set(binding.metrics.map(m => m.unit.code)).size !== 1) return problem('UNSUPPORTED_REDUCER', 'A canonical row cannot carry incompatible metric units');
  const canonicalFields = new Map<string, string>();
  for (const rule of binding.method.rules) {
    const fields = binding.mapping.metricFields.find(m => m.metricId === rule.metricRef.id)?.fields;
    const required = rule.reducer.kind === 'count' ? [] : rule.reducer.kind === 'ratio' ? [rule.reducer.numeratorField, rule.reducer.denominatorField] : [rule.reducer.valueField];
    if (!fields || required.some(field => !fields[field])) return problem('SOURCE_INVALID_CONFIGURATION', 'Every reducer field must be explicitly published in the metric mapping');
  }
  for (const entry of binding.mapping.metricFields) {
    if (!binding.metrics.some(m => m.id === entry.metricId)) return problem('SOURCE_INVALID_CONFIGURATION', 'Mapping contains a metric outside the published method');
    for (const [field, raw] of Object.entries(entry.fields)) { if (canonicalFields.has(field) && canonicalFields.get(field) !== raw) return problem('SOURCE_INVALID_CONFIGURATION', 'Flat canonical fields cannot represent conflicting raw columns'); canonicalFields.set(field, raw); }
  }
}

export function createSourceService({ repository, store, adapters, normalizer, enricher, jobs, clock, recheckGuard }: { repository: WorkbenchRepository; store: SourceStore; adapters: Map<string, SourceAdapter>; normalizer: NormalizerPort; enricher: EnricherPort; jobs: SourceJobs; clock: Clock; recheckGuard: (context: CommandContext) => Promise<void> }): SourceService {
  for (const stage of ['source.check', 'source.collect', 'source.normalize', 'source.enrich', 'source.commit']) jobs.registerStage(stage);
  return {
    sourceIdForGoal: goalId => store.sourceIdForGoal(goalId),
    async capture(context, unvalidated) {
      const input = captureInputSchema.parse(unvalidated);
      if (context.repository !== repository || context.actor.installationId !== context.installationId) return problem('COMMAND_CONTEXT_MISMATCH', 'Source command context does not match this installation', 409);
      const job = jobs.findByCommand(context.commandId, context.installationId);
      if (!job) return problem('SOURCE_JOB_REQUIRED', 'Capture requires its owned accepted job', 409);
      const existing = store.findOperation(context.installationId, job.jobId, input.goalId); if (existing) return { ...existing, duplicate: true };
      if (job.status !== 'running') return problem('SOURCE_JOB_NOT_RUNNING', 'Capture job is not running', 409);
      const binding = store.resolveCapture({ installationId: context.installationId, goalId: input.goalId });
      if (store.sourceIdForGoal(input.goalId) !== binding.source.id || jobs.getResourceKey(job.jobId, context.installationId) !== 'source:' + binding.source.id) return problem('SOURCE_CONFIGURATION_CHANGED', 'Queued source identity has changed', 409);
      validateProfile(binding); const adapter = adapters.get(binding.adapterKey); if (!adapter) return problem('SOURCE_UNSUPPORTED', 'Configured adapter is unavailable');
      const request = captureRequestSchema.parse({ operationId: job.jobId, goalRef: binding.goalRef, sourceRef: binding.sourceRef, mappingRef: binding.mappingRef, businessTime: binding.businessTime, context: binding.context, configurationRevision: binding.configurationRevision, profileRef: binding.profileRef });
      const controller = new AbortController();
      jobs.registerControl(job.jobId, { cancel: async () => { controller.abort(); } });
      const checkAbort = () => { if (controller.signal.aborted) return problem('SOURCE_CANCELLED', 'Capture was cancelled', 409); };
      const stage = (name: string, completed: number) => { checkAbort(); jobs.stage(job.jobId, name, { completed, total: 5, unit: 'steps' }); };
      try {
        stage('source.check', 0); const checked = sourceCheckSchema.parse(await adapter.check(request)); checkAbort();
        if (checked.status !== 'ready') return problem(checked.issues[0]?.code ?? 'SOURCE_' + checked.status.toUpperCase(), checked.issues[0]?.message ?? 'Source is not ready');
        stage('source.collect', 1); const raw = rawBatchSchema.parse(await adapter.collect(request, controller.signal)); checkAbort();
        if (raw.operationId !== job.jobId || stableJson(raw.sourceRef) !== stableJson(binding.sourceRef) || stableJson(raw.mappingRef) !== stableJson(binding.mappingRef)) return problem('SOURCE_BATCH_MISMATCH', 'Adapter batch does not belong to this request');
        if (!raw.coverage.complete || !raw.coverage.evidence.length || raw.coverage.receivedRows !== raw.rawRows.length || raw.coverage.expectedRows !== null && raw.coverage.expectedRows !== raw.coverage.receivedRows) return problem('SOURCE_INCOMPLETE', 'Source full-coverage proof is incomplete');
        if (raw.artifact) { store.assertArtifact(context.installationId, raw.artifact); if (raw.payloadHash !== raw.artifact.hash) return problem('SOURCE_HASH_MISMATCH', 'Artifact payload hash does not match verified bytes'); }
        else if (raw.payloadHash !== sourcePayloadHash(raw.rawRows)) return problem('SOURCE_HASH_MISMATCH', 'Raw payload hash does not match original rows');
        stage('source.normalize', 2);
        const normalized = z.strictObject({ rows: z.array(canonicalSourceRowSchema), issues: z.array(sourceIssueSchema) }).parse(normalizer.normalize({ raw: structuredClone(raw), mapping: structuredClone(binding.mapping) })); checkAbort();
        const rowsByKey = new Map<string, CanonicalSourceRow>(); const rawByKey = new Map(raw.rawRows.map(r => [r.rowKey, r])); const issues: SourceIssue[] = [...checked.issues, ...raw.issues, ...normalized.issues];
        for (const row of normalized.rows) { if (!rawByKey.has(row.rowKey) || rowsByKey.has(row.rowKey)) return problem('SOURCE_ROW_MISMATCH', 'Normalization must preserve unique original row keys'); rowsByKey.set(row.rowKey, row); }
        for (const row of raw.rawRows) if (!rowsByKey.has(row.rowKey)) issues.push(issue('NORMALIZED_ROW_MISSING', [row.rowKey]));
        stage('source.enrich', 3); const enriched = enrichmentResultSchema.parse(enricher.enrich({ rows: structuredClone(normalized.rows), directoryRevision: binding.directoryRevision })); checkAbort();
        for (const field of enriched.issues) issues.push({ code: field.code, stage: 'enrich', retryable: false, message: field.message || 'Source enrichment is incomplete', rowKeys: [], refs: field.ref ? [field.ref] : [] });
        for (const ref of enriched.directoryLinkRefs) if (!binding.directoryLinkRefs.some(r => stableJson(r) === stableJson(ref))) return problem('SOURCE_DIRECTORY_MISMATCH', 'Enrichment references an unverified directory link');
        const enrichedKeys = new Set<string>(); const scopes = new Map<string, ScopeRef>();
        for (const row of enriched.rows) {
          const canonical = rowsByKey.get(row.rowKey); const { scope, directoryEntityRefs, ...sameRow } = row;
          if (!canonical || enrichedKeys.has(row.rowKey) || stableJson(canonical) !== stableJson(sameRow)) return problem('SOURCE_ROW_MISMATCH', 'Enrichment must preserve the same canonical rows'); enrichedKeys.add(row.rowKey);
          for (const ref of directoryEntityRefs) if (!binding.directoryEntityRefs.some(r => stableJson(r) === stableJson(ref))) return problem('SOURCE_DIRECTORY_MISMATCH', 'Enrichment references an unverified directory entity');
          const externalKey = binding.mapping.productKeyField ? rawByKey.get(row.rowKey)!.cells[binding.mapping.productKeyField]?.original ?? null : null;
          const matches = binding.mapping.fixedScope ? [binding.mapping.fixedScope] : binding.directoryEntities.filter(e => e.kind === 'product' && externalKey !== null && e.externalKeys.some(k => k.sourceId === binding.source.id && k.key === externalKey)).map(e => ({ kind: 'product' as const, id: e.id }));
          const expected = matches.length === 1 ? matches[0] : null;
          if (!expected || !scope || scopeKey(scope) !== scopeKey(expected) || !binding.assignment.expectedPopulation!.some(s => scopeKey(s) === scopeKey(scope)) || !sourceScopeReachable(binding.assignment.scope, scope, binding.directoryLinks)) { issues.push(issue('REQUIRED_SCOPE_UNRESOLVED', [row.rowKey], binding.directoryEntityRefs)); continue; }
          scopes.set(row.rowKey, scope);
        }
        for (const row of normalized.rows) if (!enrichedKeys.has(row.rowKey)) issues.push(issue('ENRICHED_ROW_MISSING', [row.rowKey]));
        const capturedAt = raw.capturedAt; const captureId = newUuid();
        const header = (): Header => ({ schemaVersion: 1, id: newUuid(), revision: 1, recordedAt: clock.now(), actor: context.actor, publicationAnchorId: null });
        const facts: ObservedFact[] = [];
        const rejectedKeys = new Set(raw.rawRows.filter(r => !scopes.has(r.rowKey)).map(r => r.rowKey));
        if (binding.method.mode !== 'numeric') return problem('SOURCE_UNSUPPORTED', 'Numeric method is required');
        for (const rule of binding.method.rules) {
          const metric = binding.metrics.find(m => m.id === rule.metricRef.id)!;
          const groups = new Map<string, { scope: ScopeRef; rows: CanonicalSourceRow[] }>();
          for (const row of normalized.rows) { const scope = scopes.get(row.rowKey); if (!scope) continue; const groupKey = stableJson({ scope, businessTime: row.businessTime }); const group = groups.get(groupKey) ?? { scope, rows: [] }; group.rows.push(row); groups.set(groupKey, group); }
          for (const { scope, rows } of groups.values()) {
            const reduced = reduceRows({ reducer: rule.reducer, rows, unitCode: metric.unit.code, assignmentRef: binding.assignmentRef, methodRef: binding.methodRef, metricRef: rule.metricRef });
            if (reduced.qualityFlags.length) { reduced.sourceRowKeys.forEach(k => rejectedKeys.add(k)); reduced.qualityFlags.forEach(code => issues.push(issue(code, reduced.sourceRowKeys, [rule.metricRef]))); }
            const relevantDimensions = new Map(rows.map(r => [stableJson(r.dimensions), r.dimensions]));
            // Current selector has a single fact per metric/scope/time. Distinct dimensional partitions need an explicit future selector contract.
            if (relevantDimensions.size > 1 && Object.keys(binding.mapping.dimensionFields).some(field => field !== Object.entries(binding.mapping.dimensionFields).find(([, rawField]) => rawField === binding.mapping.productKeyField)?.[0])) return problem('SOURCE_UNSUPPORTED_GRAIN', 'Distinct dimensional partitions cannot be selected by the current fact selector');
            const fact: ObservedFact = { ...header(), sourceId: binding.source.id, captureId, metricId: metric.id, scope, businessTime: rows[0].businessTime, sourceUpdatedAt: raw.sourceUpdatedAt, origin: rule.reducer.kind === 'source_provided_value' ? 'source_value' : 'reducer', state: reduced.value === null ? 'missing' : 'known', value: reduced.value, missingReason: reduced.value === null ? reduced.qualityFlags.join(',') || 'missing_reducer_component' : null, unitCode: metric.unit.code, factKey: stableJson({ sourceId: binding.source.id, metricId: metric.id, scope, businessTime: rows[0].businessTime, dimensions: relevantDimensions.size === 1 ? [...relevantDimensions.values()][0] : {} }), lineage: { captureId, sourceRowKeys: reduced.sourceRowKeys, mappingRef: binding.mappingRef, directoryLinkRefs: binding.directoryLinkRefs, inputFactRefs: [], reducerMethodRef: rule.reducer.kind === 'source_provided_value' ? null : binding.methodRef } };
            facts.push(fact);
          }
        }
        for (const expected of binding.assignment.expectedPopulation!) if (![...scopes.values()].some(s => scopeKey(s) === scopeKey(expected))) issues.push(issue('EXPECTED_SCOPE_MISSING', [], binding.metricRefs));
        const capture: Capture = { ...header(), id: captureId, sourceId: binding.source.id, operationId: job.jobId, obtainedVia: 'direct', capturedAt, sourceUpdatedAt: raw.sourceUpdatedAt, payloadHash: raw.payloadHash, rawArtifactId: raw.artifact?.artifactId ?? null, mappingRef: binding.mappingRef, result: issues.length || rejectedKeys.size || !facts.length ? 'partial' : 'accepted', acceptedRows: raw.rawRows.length - rejectedKeys.size, rejectedRows: rejectedKeys.size, rawRows: raw.rawRows, canonicalRows: normalized.rows };
        stage('source.commit', 4); await recheckGuard(context); checkAbort(); store.assertUnchanged(binding, context.installationId);
        return commitCommandEffect(context, () => { checkAbort(); const result = store.commitCapture({ installationId: context.installationId, binding, request, raw, capture, facts, issues }); return { result, changedRefs: [{ entityType: 'capture', id: result.captureRef.id }, ...facts.map(f => ({ entityType: 'observed_fact', id: f.id }))], editToken: null }; }).result;
      } catch (error) { if (controller.signal.aborted) return problem('SOURCE_CANCELLED', 'Capture was cancelled', 409); throw error; }
    },
  };
}
export function registerSourceCommands(registry: CommandRegistry, service: SourceService): void {
  registry.register({ name: 'source.capture', inputSchema: captureInputSchema, outputSchema: captureResultSchema, capability: 'capture.local', effect: 'local', execution: 'async', resourceKey: ({ goalId }) => 'source:' + service.sourceIdForGoal(goalId), handler: async (context, input) => { const result = await service.capture(context, input); return { result, changedRefs: [{ entityType: 'capture', id: result.captureRef.id }], editToken: null }; } });
}
