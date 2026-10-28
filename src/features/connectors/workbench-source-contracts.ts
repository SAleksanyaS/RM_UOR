import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CanonicalSourceRow, SourceFieldMapping } from '../../domain/workbench/entities';
import { businessTimeSchema, entityRefSchema, scopeRefSchema, sha256Schema, utcInstantSchema, uuidSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { canonicalSourceRowSchema, fileArtifactRefSchema, rawSourceRowSchema, safeCountSchema } from '../../domain/workbench/schemas';
import { fieldProblemSchema, globalContextSchema, revisionTokenSchema } from '../../server/workbench/protocol';
import { stableJson } from '../../server/workbench/command-store';

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
