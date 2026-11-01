import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CanonicalSourceRow, SourceFieldMapping, SourceDefinition, CoreGoalDefinition, GoalAssignment, MethodVersion, MetricDefinition } from '../../domain/workbench/entities';
import { businessTimeSchema, entityRefSchema, scopeRefSchema, sha256Schema, utcInstantSchema, uuidSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { canonicalSourceRowSchema, fileArtifactRefSchema, rawSourceRowSchema, safeCountSchema } from '../../domain/workbench/schemas';
import { fieldProblemSchema, globalContextSchema, revisionTokenSchema, WorkbenchHttpError } from '../../server/workbench/protocol';
import { stableJson } from '../../server/workbench/command-store';
import type { BrowserRuntimePort, BrowserOwner } from './workbench-browser-runtime';
import type { VersionRef, Sha256, UtcInstant } from '../../domain/workbench/primitives';

/** Server-only provider evidence, observed from report/export metadata or a verified probe.
 * Never accept this object from a command, scenario definition, or received row count.
 * Absence of a provider leaves export completeness unverified. Expected population is
 * resolved exclusively from publishedAssignment, not supplied by this evidence. */
export type BrowserExportBinding = { owner: BrowserOwner; sourceRef: VersionRef; mappingRef: VersionRef; scenarioHash: Sha256; payloadHash: Sha256 };
export type BrowserExportEvidence = BrowserExportBinding & { publishedAssignment: VersionRef; observedAt: UtcInstant; expiresAt: UtcInstant; selectionVerified: boolean; allPagesExported: boolean; reportedRows: number };
export type BrowserScenarioRuntimePort = BrowserRuntimePort & {
  inspectExport?(binding: BrowserExportBinding, signal: AbortSignal): Promise<BrowserExportEvidence | null>;
};

export const sourceIssueSchema = z.strictObject({ code: z.string().min(1), stage: z.string().min(1), retryable: z.boolean(), message: z.string().min(1), rowKeys: z.array(z.string().min(1)), refs: z.array(entityRefSchema) });
export type SourceIssue = z.infer<typeof sourceIssueSchema>;
const ref = (type: string) => versionRefSchema.refine(v => v.entityType === type);
/** Internal adapter input. profileRef never belongs to a browser/package DTO. */
export const captureRequestSchema = z.strictObject({ operationId: uuidSchema, goalRef: ref('core_goal_definition'), sourceRef: ref('source_definition'), mappingRef: ref('source_field_mapping'), businessTime: businessTimeSchema, context: globalContextSchema, configurationRevision: revisionTokenSchema, profileRef: z.string().min(1).nullable() });
export type CaptureRequest = z.infer<typeof captureRequestSchema>;
export const sourceCheckSchema = z.strictObject({ status: z.enum(['ready', 'auth_required', 'unavailable', 'unsupported', 'invalid_configuration']), issues: z.array(sourceIssueSchema) });
export type SourceCheck = z.infer<typeof sourceCheckSchema>;
export const rawBatchSchema = z.strictObject({ operationId: uuidSchema, sourceRef: ref('source_definition'), mappingRef: ref('source_field_mapping'), capturedAt: utcInstantSchema, sourceUpdatedAt: utcInstantSchema.nullable(), rawRows: z.array(rawSourceRowSchema).refine(v => new Set(v.map(r => r.rowKey)).size === v.length), artifact: fileArtifactRefSchema.nullable(), payloadHash: sha256Schema, coverage: z.strictObject({ complete: z.boolean(), expectedRows: safeCountSchema.nullable(), receivedRows: safeCountSchema, evidence: z.array(z.string().min(1)) }), issues: z.array(sourceIssueSchema) });
export type RawBatch = z.infer<typeof rawBatchSchema>;
export interface SourceAdapter { check(request: CaptureRequest): Promise<SourceCheck>; collect(request: CaptureRequest, signal: AbortSignal): Promise<RawBatch> }
export interface NormalizerPort { normalize(input: { raw: RawBatch; mapping: SourceFieldMapping }): { rows: CanonicalSourceRow[]; issues: SourceIssue[] } }
export const enrichedRowSchema = canonicalSourceRowSchema.extend({ scope: scopeRefSchema.nullable(), directoryEntityRefs: z.array(ref('directory_entity')) });
export type EnrichedRow = z.infer<typeof enrichedRowSchema>;
export const enrichmentResultSchema = z.strictObject({ rows: z.array(enrichedRowSchema), issues: z.array(fieldProblemSchema), directoryLinkRefs: z.array(ref('directory_link')) });
export type EnrichmentResult = z.infer<typeof enrichmentResultSchema>;
export interface EnricherPort { enrich(input: { rows: CanonicalSourceRow[]; directoryRevision: string }): EnrichmentResult }
export const captureInputSchema = z.strictObject({ goalId: uuidSchema });
export const captureResultSchema = z.strictObject({ captureRef: ref('capture'), acceptedRows: safeCountSchema, rejectedRows: safeCountSchema, duplicate: z.boolean() });
export type CaptureResult = z.infer<typeof captureResultSchema>;
/** Row-only payloads use deterministic UTF-8 canonical JSON; artifacts use verified bytes' hash. */
export const sourcePayloadHash = (rawRows: RawBatch['rawRows']): string => 'sha256:' + createHash('sha256').update(stableJson(rawRows)).digest('hex');

const configurationProblem = (code: string, message: string): never => { throw new WorkbenchHttpError(422, code, message); };
/** Shared pure source/method compatibility gate, used by capture and scenario previews. */
export function validateSourceConfiguration(binding: { source: SourceDefinition; goal: CoreGoalDefinition; assignment: GoalAssignment; mapping: SourceFieldMapping; method: MethodVersion; metrics: MetricDefinition[] }): void {
  if (binding.source.kind !== 'qlik' || binding.goal.mode !== 'numeric' || binding.method.mode !== 'numeric') return configurationProblem('SOURCE_UNSUPPORTED', 'Only the configured numeric automatic source can be captured');
  if (!binding.assignment.expectedPopulation?.length || !binding.mapping.fixedScope && !binding.mapping.productKeyField) return configurationProblem('SOURCE_INVALID_CONFIGURATION', 'Published population and scope mapping are required');
  if (new Set(binding.metrics.map(m => m.unit.code)).size !== 1) return configurationProblem('UNSUPPORTED_REDUCER', 'A canonical row cannot carry incompatible metric units');
  const canonicalFields = new Map<string, string>();
  for (const rule of binding.method.rules) {
    const fields = binding.mapping.metricFields.find(m => m.metricId === rule.metricRef.id)?.fields;
    const required = rule.reducer.kind === 'count' ? [] : rule.reducer.kind === 'ratio' ? [rule.reducer.numeratorField, rule.reducer.denominatorField] : [rule.reducer.valueField];
    if (!fields || required.some(field => !fields[field])) return configurationProblem('SOURCE_INVALID_CONFIGURATION', 'Every reducer field must be explicitly published in the metric mapping');
  }
  for (const entry of binding.mapping.metricFields) {
    if (!binding.metrics.some(m => m.id === entry.metricId)) return configurationProblem('SOURCE_INVALID_CONFIGURATION', 'Mapping contains a metric outside the published method');
    for (const [field, raw] of Object.entries(entry.fields)) { if (canonicalFields.has(field) && canonicalFields.get(field) !== raw) return configurationProblem('SOURCE_INVALID_CONFIGURATION', 'Flat canonical fields cannot represent conflicting raw columns'); canonicalFields.set(field, raw); }
  }
}
