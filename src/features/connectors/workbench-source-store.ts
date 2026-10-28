import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Capture, CoreGoalDefinition, DirectoryEntity, DirectoryLink, FileArtifactRef, GoalAssignment, MethodVersion, MetricDefinition, ObservedFact, SourceDefinition, SourceFieldMapping, Template } from '../../domain/workbench/entities';
import type { BusinessTime, Header, ScopeRef, UUIDv4, VersionRef } from '../../domain/workbench/primitives';
import { uuidSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { fileArtifactRefSchema } from '../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { globalContextSchema, revisionTokenSchema, WorkbenchHttpError, type GlobalContext, type RevisionToken } from '../../server/workbench/protocol';
import { stableJson } from '../../server/workbench/command-store';
import { captureResultSchema, rawBatchSchema, sourceIssueSchema, type CaptureRequest, type CaptureResult, type RawBatch, type SourceIssue } from './workbench-source-contracts';

export type PublishedSourceBinding = { goalRef: VersionRef; sourceRef: VersionRef; mappingRef: VersionRef; assignmentRef: VersionRef; templateRef: VersionRef | null; methodRef: VersionRef; metricRefs: VersionRef[]; directoryEntityRefs: VersionRef[]; directoryLinkRefs: VersionRef[]; directoryRevision: RevisionToken };
export type SavedCaptureContext = { installationId: UUIDv4; goalId: UUIDv4; context: GlobalContext; revision: RevisionToken };
export type ResolvedCaptureBinding = PublishedSourceBinding & { goal: CoreGoalDefinition; source: SourceDefinition; mapping: SourceFieldMapping; assignment: GoalAssignment; method: MethodVersion; metrics: MetricDefinition[]; directoryEntities: DirectoryEntity[]; directoryLinks: DirectoryLink[]; context: GlobalContext; businessTime: GlobalContext['time']; configurationRevision: RevisionToken; adapterKey: string; profileRef: string | null };
type CaptureEvidence = { request: CaptureRequest; raw: RawBatch; issues: SourceIssue[]; factRefs: VersionRef[]; result: CaptureResult; contextKey: string };
export type SourceCaptureView = { capture: Capture; facts: ObservedFact[]; issues: SourceIssue[]; coverage: RawBatch['coverage']; artifact: FileArtifactRef | null };
export type SourceLatestAttempt = { operationId: string; captureRef: VersionRef; sourceId: string; result: Capture['result']; complete: boolean; acceptedRows: number; rejectedRows: number; capturedAt: string; sourceUpdatedAt: string | null; coverage: RawBatch['coverage']; issues: SourceIssue[] };
/** T17/T21 consumption gate: combine latestAttempt.complete/issues with current calculation completeness before enabling confirmation or claiming current completeness. Retained facts/coverage alone do not prove that the latest ingestion was complete. T14 exposes this evidence; future confirmation/read-model wiring is not implemented here. */
export type SourceFallback = { obtainedVia: 'local-cache' | 'git' | 'no-data'; sourceId: string; captureRef: VersionRef | null; businessTimes: BusinessTime[]; sourceDate: string | null; sourceUpdatedAt: string | null; capturedAt: string | null; coverage: RawBatch['coverage'] | null; facts: ObservedFact[]; latestAttempt: SourceLatestAttempt | null; warnings: SourceIssue[] };
export interface SourceStore {
  installPublished(bindings: PublishedSourceBinding[]): void;
  bindAdapter(input: { sourceId: string; adapterKey: string; profileRef: string | null; revision: string }): void;
  saveAllowedContext(input: SavedCaptureContext, expectedRevision: string | null): void;
  sourceIdForGoal(goalId: string): string;
  resolveCapture(input: { installationId: string; goalId: string }): ResolvedCaptureBinding;
  assertUnchanged(binding: ResolvedCaptureBinding, installationId: string): void;
  findOperation(installationId: string, operationId: string, goalId?: string): CaptureResult | null;
  commitCapture(input: { installationId: string; binding: ResolvedCaptureBinding; request: CaptureRequest; raw: RawBatch; capture: Capture; facts: ObservedFact[]; issues: SourceIssue[] }): CaptureResult;
  readCapture(ref: VersionRef, installationId: string): SourceCaptureView | null;
  /** Read-only current owner+goal+saved-context+source evidence, including partial captures with no facts. */
  readLatestAttempt(input: { installationId: string; goalId: string }): SourceLatestAttempt | null;
  readFallback(input: { installationId: string; goalId: string }): SourceFallback;
  installVerifiedGit(input: { goalId: string; captureRef: VersionRef; factRefs: VersionRef[]; context: GlobalContext; coverage: RawBatch['coverage'] }): void;
  saveArtifact(input: { installationId: string; artifactId: string; mimeType: string; bytesValue: Uint8Array }): FileArtifactRef;
  assertArtifact(installationId: string, artifact: FileArtifactRef): void;
}
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const toRef = (entityType: string, value: Header): VersionRef => ({ entityType, id: value.id, revision: value.revision });
const fail = (code = 'SOURCE_INVALID_CONFIGURATION'): never => { throw new WorkbenchHttpError(409, code, 'Source configuration is unavailable or has changed'); };
const key = (scope: ScopeRef) => `${scope.kind}/${scope.id}`;
const bindingSchema = z.strictObject({ goalRef: versionRefSchema, sourceRef: versionRefSchema, mappingRef: versionRefSchema, assignmentRef: versionRefSchema, templateRef: versionRefSchema.nullable(), methodRef: versionRefSchema, metricRefs: z.array(versionRefSchema), directoryEntityRefs: z.array(versionRefSchema), directoryLinkRefs: z.array(versionRefSchema), directoryRevision: revisionTokenSchema });
const savedSchema = z.strictObject({ installationId: uuidSchema, goalId: uuidSchema, context: globalContextSchema, revision: revisionTokenSchema });
const edges = { dit_cluster: ['dit', 'cluster'], cluster_product: ['cluster', 'product'], cluster_team: ['cluster', 'team'], product_team: ['product', 'team'] } as const;
export function sourceScopeReachable(from: ScopeRef, to: ScopeRef, links: DirectoryLink[]): boolean {
  const pending = [key(from)], seen = new Set<string>();
  while (pending.length) { const current = pending.pop()!; if (current === key(to)) return true; if (seen.has(current)) continue; seen.add(current); for (const link of links) if (link.kind !== 'leader') { const [parent, child] = edges[link.kind]; if (current === `${parent}/${link.from.id}`) pending.push(`${child}/${link.to.id}`); } }
  return false;
}
export function createSourceStore({ repository }: { repository: WorkbenchRepository }): SourceStore {
  const sql = repository.sqlForModule('sources');
  sql.execMigration('v1', `CREATE TABLE wb_sources_bindings(goal_id TEXT NOT NULL,assignment_id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(goal_id,assignment_id));
    CREATE TABLE wb_sources_adapters(source_id TEXT PRIMARY KEY,value_json TEXT NOT NULL);
    CREATE TABLE wb_sources_contexts(installation_id TEXT NOT NULL,goal_id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(installation_id,goal_id));
    CREATE TABLE wb_sources_captures(installation_id TEXT NOT NULL,operation_id TEXT NOT NULL,capture_id TEXT NOT NULL UNIQUE,value_json TEXT NOT NULL,PRIMARY KEY(installation_id,operation_id));
    CREATE TABLE wb_sources_success(installation_id TEXT NOT NULL,goal_id TEXT NOT NULL,context_key TEXT NOT NULL,capture_id TEXT NOT NULL,PRIMARY KEY(installation_id,goal_id,context_key));
    CREATE TABLE wb_sources_git(goal_id TEXT NOT NULL,context_key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(goal_id,context_key));
    CREATE TABLE wb_sources_artifacts(installation_id TEXT NOT NULL,artifact_id TEXT NOT NULL,metadata_json TEXT NOT NULL,bytes_value BLOB NOT NULL,PRIMARY KEY(installation_id,artifact_id));`);
  sql.execMigration('v2-latest-attempt', `CREATE TABLE wb_sources_attempts(installation_id TEXT NOT NULL,goal_id TEXT NOT NULL,context_key TEXT NOT NULL,source_id TEXT NOT NULL,capture_id TEXT NOT NULL,PRIMARY KEY(installation_id,goal_id,context_key,source_id));
    INSERT OR REPLACE INTO wb_sources_attempts SELECT installation_id,json_extract(value_json,'$.request.goalRef.id'),json_extract(value_json,'$.contextKey'),json_extract(value_json,'$.request.sourceRef.id'),capture_id FROM wb_sources_captures ORDER BY rowid;`);
  const published = <T extends Header>(value: T | null): T => {
    if (!value || !value.publicationAnchorId) return fail();
    const anchor = repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId });
    if (!anchor || anchor.publicationState !== 'confirmed') return fail();
    return value;
  };
  const exact = <T extends Header>(ref: VersionRef, type: string): T => { if (ref.entityType !== type) return fail(); return published(repository.readVersion<T>(ref)); };
  const head = <T extends Header>(ref: VersionRef, type: string): T => { if (ref.entityType !== type) return fail(); return published(repository.readPublishedHead<T>({ entityType: type, id: ref.id })); };
  const inventory = (goalId: string) => sql.all<{ value_json: string }>('SELECT value_json FROM wb_sources_bindings WHERE goal_id=? ORDER BY assignment_id', [uuidSchema.parse(goalId)]).map(v => bindingSchema.parse(JSON.parse(v.value_json)));
  const contextKey = (context: GlobalContext) => digest(context);
  const loadConfiguration = (binding: PublishedSourceBinding, current: boolean) => {
    const read = current ? head : exact;
    const goal = read<CoreGoalDefinition>(binding.goalRef, 'core_goal_definition');
    const source = read<SourceDefinition>(binding.sourceRef, 'source_definition');
    if (goal.sourceId !== source.id || source.goalId !== goal.id || !source.mappingRef || source.mappingRef.entityType !== 'source_field_mapping' || goal.lifecycle !== 'active') return fail();
    const mapping = exact<SourceFieldMapping>(source.mappingRef, 'source_field_mapping'); if (mapping.sourceId !== source.id) return fail();
    const assignment = read<GoalAssignment>(binding.assignmentRef, 'goal_assignment'); if (assignment.goalId !== goal.id) return fail();
    const template = assignment.methodBinding.kind === 'template' ? published(repository.readPublishedHead<Template>({ entityType: 'template', id: assignment.methodBinding.templateId })) : null;
    const methodRef = template?.methodRef ?? (assignment.methodBinding.kind === 'standalone' ? assignment.methodBinding.methodRef : null); if (!methodRef) return fail();
    const method = exact<MethodVersion>(methodRef, 'method_version'); if (goal.mode !== method.mode) return fail();
    const metrics = method.mode === 'numeric' ? method.rules.map(rule => exact<MetricDefinition>(rule.metricRef, 'metric_definition')) : [];
    const directoryEntities = binding.directoryEntityRefs.map(r => read<DirectoryEntity>(r, 'directory_entity'));
    const directoryLinks = binding.directoryLinkRefs.map(r => read<DirectoryLink>(r, 'directory_link'));
    if (new Set(directoryEntities.map(e => e.id)).size !== directoryEntities.length || new Set(directoryLinks.map(e => e.id)).size !== directoryLinks.length) return fail();
    for (const link of directoryLinks) if (link.kind !== 'leader') { const [a, b] = edges[link.kind]; if (!directoryEntities.some(e => e.id === link.from.id && e.kind === a) || !directoryEntities.some(e => e.id === link.to.id && e.kind === b)) return fail(); }
    return { goal, source, mapping, assignment, method, metrics, directoryEntities, directoryLinks, goalRef: toRef('core_goal_definition', goal), sourceRef: toRef('source_definition', source), mappingRef: toRef('source_field_mapping', mapping), assignmentRef: toRef('goal_assignment', assignment), methodRef: toRef('method_version', method), templateRef: template ? toRef('template', template) : null, metricRefs: metrics.map(m => toRef('metric_definition', m)), directoryEntityRefs: directoryEntities.map(e => toRef('directory_entity', e)), directoryLinkRefs: directoryLinks.map(l => toRef('directory_link', l)), directoryRevision: binding.directoryRevision };
  };
  const assertContext = (context: GlobalContext, cfg: ReturnType<typeof loadConfiguration>) => {
    if (context.resultMode !== 'current' || context.snapshotId !== null || context.goalId !== null && context.goalId !== cfg.goal.id || context.time.kind !== cfg.goal.measurementMode) return fail();
    const path = context.scopePath;
    const scopes: ScopeRef[] = [{ kind: 'dit', id: path.ditId }, ...(path.clusterId ? [{ kind: 'cluster' as const, id: path.clusterId }] : []), ...(path.productId ? [{ kind: 'product' as const, id: path.productId }] : []), ...(path.teamId ? [{ kind: 'team' as const, id: path.teamId }] : [])];
    for (const scope of scopes) if (!cfg.directoryEntities.some(e => e.kind === scope.kind && e.id === scope.id)) return fail();
    for (let i = 1; i < scopes.length; i++) if (!sourceScopeReachable(scopes[i - 1], scopes[i], cfg.directoryLinks)) return fail();
    if (key(scopes.at(-1)!) !== key(cfg.assignment.scope)) return false;
    for (const scope of cfg.assignment.expectedPopulation ?? []) if (!cfg.directoryEntities.some(e => e.kind === scope.kind && e.id === scope.id) || !sourceScopeReachable(cfg.assignment.scope, scope, cfg.directoryLinks)) return fail();
    return true;
  };
  const resolve = (installationId: string, goalId: string, savedOverride?: SavedCaptureContext): ResolvedCaptureBinding => {
    uuidSchema.parse(installationId); uuidSchema.parse(goalId);
    const row = sql.get<{ value_json: string }>('SELECT value_json FROM wb_sources_contexts WHERE installation_id=? AND goal_id=?', [installationId, goalId]);
    const saved = savedOverride ?? (row ? savedSchema.parse(JSON.parse(row.value_json)) : fail('SOURCE_CONTEXT_REQUIRED'));
    const choices = inventory(goalId).map(b => loadConfiguration(b, true)).filter(cfg => assertContext(saved.context, cfg));
    if (choices.length !== 1) return fail(); const cfg = choices[0];
    const adapterRow = sql.get<{ value_json: string }>('SELECT value_json FROM wb_sources_adapters WHERE source_id=?', [cfg.source.id]); if (!adapterRow) return fail();
    const adapter = z.strictObject({ sourceId: uuidSchema, adapterKey: z.string().min(1), profileRef: z.string().min(1).nullable(), revision: revisionTokenSchema }).parse(JSON.parse(adapterRow.value_json));
    const anchors = [...new Set([cfg.goal, cfg.source, cfg.mapping, cfg.assignment, cfg.method, ...cfg.metrics, ...cfg.directoryEntities, ...cfg.directoryLinks, ...(cfg.templateRef ? [exact<Template>(cfg.templateRef, 'template')] : [])].map(e => e.publicationAnchorId!))].sort().map(id => repository.readPublicationAnchor({ entityType: 'publication_anchor', id }));
    return { ...cfg, context: saved.context, businessTime: saved.context.time, adapterKey: adapter.adapterKey, profileRef: adapter.profileRef, configurationRevision: digest({ cfg, anchors, saved, adapter }) };
  };
  const evidenceFor = (ref: VersionRef, installationId: string): CaptureEvidence | null => { if (ref.entityType !== 'capture' || ref.revision !== 1) return null; const row = sql.get<{ value_json: string }>('SELECT value_json FROM wb_sources_captures WHERE installation_id=? AND capture_id=?', [installationId, ref.id]); return row ? JSON.parse(row.value_json) : null; };
  const latestAttemptFor = (installationId: string, binding: ResolvedCaptureBinding): SourceLatestAttempt | null => {
    const row = sql.get<{ capture_id: string }>('SELECT capture_id FROM wb_sources_attempts WHERE installation_id=? AND goal_id=? AND context_key=? AND source_id=?', [installationId, binding.goal.id, contextKey(binding.context), binding.source.id]);
    if (!row) return null;
    const captureRef = { entityType: 'capture', id: row.capture_id, revision: 1 }; const evidence = evidenceFor(captureRef, installationId); const capture = repository.readVersion<Capture>(captureRef);
    if (!evidence || !capture || capture.sourceId !== binding.source.id) return null;
    return { operationId: capture.operationId, captureRef, sourceId: capture.sourceId, result: capture.result, complete: capture.result === 'accepted' && capture.rejectedRows === 0 && evidence.issues.length === 0, acceptedRows: capture.acceptedRows, rejectedRows: capture.rejectedRows, capturedAt: capture.capturedAt, sourceUpdatedAt: capture.sourceUpdatedAt, coverage: evidence.raw.coverage, issues: evidence.issues };
  };
  const store: SourceStore = {
    installPublished(bindings) {
      const parsed = bindings.map(b => bindingSchema.parse(b));
      for (const b of parsed) { const cfg = loadConfiguration(b, false); if (stableJson(cfg.mappingRef) !== stableJson(b.mappingRef) || stableJson(cfg.methodRef) !== stableJson(b.methodRef) || stableJson(cfg.templateRef) !== stableJson(b.templateRef) || stableJson(cfg.metricRefs) !== stableJson(b.metricRefs)) return fail(); }
      repository.transaction(() => { for (const goalId of new Set(parsed.map(b => b.goalRef.id))) sql.run('DELETE FROM wb_sources_bindings WHERE goal_id=?', [goalId]); for (const b of parsed) sql.run('INSERT INTO wb_sources_bindings VALUES(?,?,?)', [b.goalRef.id, b.assignmentRef.id, stableJson(b)]); });
    },
    bindAdapter(input) { const value = z.strictObject({ sourceId: uuidSchema, adapterKey: z.string().min(1), profileRef: z.string().min(1).nullable(), revision: revisionTokenSchema }).parse(input); sql.run('INSERT OR REPLACE INTO wb_sources_adapters VALUES(?,?)', [value.sourceId, stableJson(value)]); },
    saveAllowedContext(input, expectedRevision) {
      const value = savedSchema.parse(input); resolve(value.installationId, value.goalId, value);
      repository.transaction(() => { const old = sql.get<{ value_json: string }>('SELECT value_json FROM wb_sources_contexts WHERE installation_id=? AND goal_id=?', [value.installationId, value.goalId]); const revision = old ? savedSchema.parse(JSON.parse(old.value_json)).revision : null; if (revision !== expectedRevision) return fail('SOURCE_CONTEXT_CONFLICT'); if (revision === value.revision && stableJson(JSON.parse(old!.value_json)) !== stableJson(value)) return fail('SOURCE_CONTEXT_CONFLICT'); sql.run('INSERT OR REPLACE INTO wb_sources_contexts VALUES(?,?,?)', [value.installationId, value.goalId, stableJson(value)]); });
    },
    sourceIdForGoal(goalId) { const bindings = inventory(goalId); const sources = new Set(bindings.map(b => b.sourceRef.id)); if (sources.size !== 1) return fail(); return [...sources][0]; },
    resolveCapture({ installationId, goalId }) { return resolve(installationId, goalId); },
    assertUnchanged(binding, installationId) { let current: ResolvedCaptureBinding; try { current = resolve(installationId, binding.goal.id); } catch { return fail('SOURCE_CONFIGURATION_CHANGED'); } if (current.configurationRevision !== binding.configurationRevision) return fail('SOURCE_CONFIGURATION_CHANGED'); },
    findOperation(installationId, operationId, goalId) { const row = sql.get<{ value_json: string }>('SELECT value_json FROM wb_sources_captures WHERE installation_id=? AND operation_id=?', [uuidSchema.parse(installationId), uuidSchema.parse(operationId)]); if (!row) return null; const evidence: CaptureEvidence = JSON.parse(row.value_json); if (goalId !== undefined && evidence.request.goalRef.id !== uuidSchema.parse(goalId)) return fail('IDEMPOTENCY_CONFLICT'); return captureResultSchema.parse(evidence.result); },
    commitCapture({ installationId, binding, request, raw, capture, facts, issues }) {
      // Caller wraps this entire method in commitCommandEffect, including the durable receipt.
      store.assertUnchanged(binding, installationId);
      const existing = store.findOperation(installationId, request.operationId, binding.goal.id); if (existing) return { ...existing, duplicate: true };
      if (raw.artifact) store.assertArtifact(installationId, raw.artifact);
      const captureRef = repository.append('capture', capture, null); const factRefs = facts.map(f => repository.append('observed_fact', f, null));
      const result = captureResultSchema.parse({ captureRef, acceptedRows: capture.acceptedRows, rejectedRows: capture.rejectedRows, duplicate: false });
      const evidence: CaptureEvidence = { request, raw: rawBatchSchema.parse(raw), issues: z.array(sourceIssueSchema).parse(issues), factRefs, result, contextKey: contextKey(binding.context) };
      sql.run('INSERT INTO wb_sources_captures VALUES(?,?,?,?)', [installationId, request.operationId, capture.id, stableJson(evidence)]);
      sql.run('INSERT OR REPLACE INTO wb_sources_attempts VALUES(?,?,?,?,?)', [installationId, binding.goal.id, evidence.contextKey, binding.source.id, capture.id]);
      if (capture.result === 'accepted') sql.run('INSERT OR REPLACE INTO wb_sources_success VALUES(?,?,?,?)', [installationId, binding.goal.id, evidence.contextKey, capture.id]);
      return result;
    },
    readCapture(ref, installationId) { const evidence = evidenceFor(ref, installationId); if (!evidence) return null; const capture = repository.readVersion<Capture>(ref); if (!capture) return null; return { capture, facts: evidence.factRefs.map(r => repository.readVersion<ObservedFact>(r) ?? fail()), issues: evidence.issues, coverage: evidence.raw.coverage, artifact: evidence.raw.artifact }; },
    readLatestAttempt({ installationId, goalId }) { return latestAttemptFor(installationId, resolve(installationId, goalId)); },
    readFallback({ installationId, goalId }) {
      const binding = resolve(installationId, goalId); const context = contextKey(binding.context);
      const applicable = (candidate: Capture) => candidate.sourceId === binding.source.id && candidate.result === 'accepted' && (binding.source.kind === 'qlik' ? candidate.obtainedVia === 'direct' : binding.source.kind === 'file' ? candidate.obtainedVia === 'file_import' : false);
      const row = sql.get<{ capture_id: string }>('SELECT capture_id FROM wb_sources_success WHERE installation_id=? AND goal_id=? AND context_key=?', [installationId, goalId, context]);
      let via: SourceFallback['obtainedVia'] = 'no-data', capture: Capture | null = null, facts: ObservedFact[] = [], coverage: RawBatch['coverage'] | null = null, captureRef: VersionRef | null = null;
      if (row) { const localRef = { entityType: 'capture', id: row.capture_id, revision: 1 }; const view = store.readCapture(localRef, installationId); if (view && applicable(view.capture)) { ({ capture, facts, coverage } = view); captureRef = localRef; via = 'local-cache'; } }
      if (!capture) { const gitRow = sql.get<{ value_json: string }>('SELECT value_json FROM wb_sources_git WHERE goal_id=? AND context_key=?', [goalId, context]); if (gitRow) { const git = JSON.parse(gitRow.value_json); const candidate = exact<Capture>(git.captureRef, 'capture'); if (applicable(candidate)) { captureRef = git.captureRef; capture = candidate; facts = git.factRefs.map((r: VersionRef) => exact<ObservedFact>(r, 'observed_fact')); coverage = git.coverage; via = 'git'; } } }
      const times = [...new Map(facts.map(f => [stableJson(f.businessTime), f.businessTime])).values()];
      const latestAttempt = latestAttemptFor(installationId, binding);
      const warnings: SourceIssue[] = latestAttempt && !latestAttempt.complete ? [{ code: 'LATEST_SOURCE_ATTEMPT_INCOMPLETE', stage: 'read', retryable: false, message: 'The latest ingestion is incomplete; retained data does not prove current completeness', rowKeys: [], refs: [{ entityType: 'capture', id: latestAttempt.captureRef.id }] }, ...latestAttempt.issues] : [];
      return { obtainedVia: via, sourceId: binding.source.id, captureRef, businessTimes: times, sourceDate: times.length === 1 && times[0].kind === 'as_of' ? times[0].date : null, sourceUpdatedAt: capture?.sourceUpdatedAt ?? null, capturedAt: capture?.capturedAt ?? null, coverage, facts, latestAttempt, warnings };
    },
    installVerifiedGit(input) { const capture = exact<Capture>(input.captureRef, 'capture'); const cfg = inventory(input.goalId).map(b => loadConfiguration(b, true)); if (!cfg.length || cfg.some(b => b.source.id !== capture.sourceId)) return fail(); const coverage = rawBatchSchema.shape.coverage.parse(input.coverage); if (!coverage.complete || !coverage.evidence.length || coverage.receivedRows !== capture.rawRows.length || coverage.expectedRows !== null && coverage.expectedRows !== coverage.receivedRows || capture.result !== 'accepted') return fail(); for (const ref of input.factRefs) { const fact = exact<ObservedFact>(ref, 'observed_fact'); if (fact.captureId !== capture.id) return fail(); } const context = globalContextSchema.parse(input.context); if (!cfg.some(c => assertContext(context, c))) return fail(); sql.run('INSERT OR REPLACE INTO wb_sources_git VALUES(?,?,?)', [input.goalId, contextKey(context), stableJson(input)]); },
    saveArtifact({ installationId, artifactId, mimeType, bytesValue }) { uuidSchema.parse(installationId); uuidSchema.parse(artifactId); const artifact = fileArtifactRefSchema.parse({ artifactId, mimeType, bytes: bytesValue.byteLength, hash: 'sha256:' + createHash('sha256').update(bytesValue).digest('hex') }); const old = sql.get<{ metadata_json: string; bytes_value: Uint8Array }>('SELECT metadata_json,bytes_value FROM wb_sources_artifacts WHERE installation_id=? AND artifact_id=?', [installationId, artifactId]); if (old) { if (old.metadata_json !== stableJson(artifact) || !Buffer.from(old.bytes_value).equals(Buffer.from(bytesValue))) return fail('SOURCE_ARTIFACT_CONFLICT'); return artifact; } sql.run('INSERT INTO wb_sources_artifacts VALUES(?,?,?,?)', [installationId, artifactId, stableJson(artifact), bytesValue]); return artifact; },
    assertArtifact(installationId, artifact) { fileArtifactRefSchema.parse(artifact); const row = sql.get<{ metadata_json: string; bytes_value: Uint8Array }>('SELECT metadata_json,bytes_value FROM wb_sources_artifacts WHERE installation_id=? AND artifact_id=?', [installationId, artifact.artifactId]); if (!row || row.metadata_json !== stableJson(artifact) || row.bytes_value.byteLength !== artifact.bytes || 'sha256:' + createHash('sha256').update(row.bytes_value).digest('hex') !== artifact.hash) return fail('SOURCE_ARTIFACT_INVALID'); },
  };
  return store;
}
