import { z } from 'zod';
import { recordedBrowserStepSchema } from '../../domain/workbench/browser-scenario';
import { uuidSchema } from '../../domain/workbench/primitives';
import { sourceParsingProfileSchema } from '../../domain/workbench/schemas/sources';
import { privateProfileSchema } from './private-profile-schema';

export const rawSourceMetadataSchema=z.strictObject({pageUrl:z.string().url().max(2000).refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&[...url.searchParams].every(([key,value])=>['pageId','attachmentId','version'].includes(key)&&/^[0-9]{1,20}$/.test(value));},'Use a public page URL without credentials or secret parameters').optional(),attachmentId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),version:z.number().int().positive().max(1000000).optional()});
export const okoParsingProfileSchema = sourceParsingProfileSchema;
export type OkoParsingProfile = z.infer<typeof okoParsingProfileSchema>;
const column = z.string().min(1).max(1000);
const strings = z.record(z.string(), z.string().max(2000));
export const okoMappingSchema = z.strictObject({ rowKeyColumns: z.array(column).min(1), productKeyColumn: column.nullable(), dimensionColumns: z.record(column, column), numberColumns: z.record(column, column), dateColumn: column.nullable(), unitColumn: column.nullable(), fixedUnitCode: column.nullable() });
export type OkoMapping = z.infer<typeof okoMappingSchema>;
export const okoDictionaryMappingSchema = z.strictObject({ key: column, productId: column, productName: column, clusterId: column, clusterName: column, ditId: column, ditName: column, clusterLeaderId: column, clusterLeaderName: column, productLeaderId: column, productLeaderName: column, teamId: column.nullable(), teamName: column.nullable() });
export type OkoDictionaryMapping = z.infer<typeof okoDictionaryMappingSchema>;
export const okoFieldProblemSchema = z.strictObject({ path: z.string(), code: z.string().min(1), message: z.string(), ref: z.strictObject({ entityType: z.string(), id: uuidSchema }).nullable() });
const rows = z.array(z.record(z.string(), z.string().nullable())).max(50);
/** A raw saved report file. Bytes live in the private export row, never in a shared entity. */
export const okoExportSchema = z.strictObject({ exportId: uuidSchema, workflowId: uuidSchema, title: z.string().max(200), fileName: z.string().min(1).max(255), mimeType: z.string().min(1).max(150), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: z.string(), sourceDate: z.string().nullable(), rowCount: z.number().int().nonnegative().nullable(), origin: z.enum(['record', 'repeat']), downloadUrl: z.string(),captureId:uuidSchema.optional(),sourceName:z.string().optional(),formatStatus:z.enum(['supported','unsupported','quarantined']).optional(),acquisitionState:z.literal('stored').optional(),processingState:z.enum(['unprocessed','parsed','failed']).optional(),deletedAt:z.string().nullable().optional() });
export type OkoExport = z.infer<typeof okoExportSchema>;
export const okoWorkflowViewSchema = z.strictObject({
  workflowId: uuidSchema, sourceId: uuidSchema, revision: z.string(), title: z.string(), sourceKind:z.enum(['oko','confluence']).optional(), sourceMetadata:rawSourceMetadataSchema.optional(), reportUrl: z.string(), marker: z.strictObject({ selector: column, label: column }).nullable(), parsingProfile: sourceParsingProfileSchema,
  profile: z.strictObject({ sourceId: uuidSchema, profileId: z.string().nullable(), profile: privateProfileSchema.nullable(), revision: z.string().nullable(), configured: z.boolean(), sessionState: z.enum(['closed', 'open', 'authentication_required', 'authenticated']) }),
  /** Computed from the owned live runtime; never persisted with the draft. */
  recordingPreparation: z.strictObject({ state: z.enum(['missing', 'login', 'ready']), expiresAt: z.string().nullable() }).optional(),
  recording: z.strictObject({ recordingId: uuidSchema.nullable(), state: z.enum(['idle', 'recording', 'completed', 'failed', 'interrupted']), steps: z.array(recordedBrowserStepSchema), parameterNames: z.array(z.string()), replayable:z.boolean().optional(),replayabilityProblem:z.string().nullable().optional(), problem: z.strictObject({ code: z.string(), message: z.string() }).nullable() }),
  columns: z.array(z.string()), sampleRows: rows, parameters: strings, mapping: okoMappingSchema.nullable(),
  dictionary: z.strictObject({ columns: z.array(z.string()), sampleRows: rows, mapping: okoDictionaryMappingSchema.nullable(), origin: z.enum(['none', 'local-preview', 'published']), issues: z.array(okoFieldProblemSchema) }),
  result: z.strictObject({ resultId: uuidSchema, rowCount: z.number().int().nonnegative(), unresolvedRows: z.number().int().nonnegative(), issues: z.array(okoFieldProblemSchema), previewRows: rows, originalDownload: z.string(), enrichedDownload: z.string().nullable(), capturedAt: z.string(), sourceDate: z.string().nullable(), exportId: uuidSchema.nullable().default(null) }).nullable(),
  exports: z.array(okoExportSchema).max(20).default([]), warnings: z.array(z.string()),
});
export type OkoWorkflowView = z.infer<typeof okoWorkflowViewSchema>;
export const okoExportsViewSchema = z.strictObject({ items: z.array(okoExportSchema), hiddenCount: z.number().int().nonnegative(),total:z.number().int().nonnegative().optional(),nextCursor:z.string().nullable().optional() });
export type OkoExportsView = z.infer<typeof okoExportsViewSchema>;
export const okoExportsQuerySchema = z.strictObject({ context: z.null(), filter: z.strictObject({ workflowId: uuidSchema.optional(), includeHidden: z.boolean().optional(),text:z.string().max(200).optional(),formatStatus:z.enum(['supported','unsupported','quarantined']).optional() }), sort: z.array(z.strictObject({field:z.enum(['capturedAt','fileName','bytes','title']),direction:z.enum(['asc','desc'])})).max(1), page: z.strictObject({ limit: z.number().int().min(1).max(200), cursor: z.string().nullable() }) });
export const okoExportIdSchema = z.strictObject({ exportId: uuidSchema });
export const okoWorkspaceViewSchema = z.strictObject({ workflows: z.array(z.strictObject({ workflowId: uuidSchema, title: z.string(), revision: z.string() })), current: okoWorkflowViewSchema.nullable(), setup: z.strictObject({ hostname: z.string(), registryConfigured: z.boolean(), message: z.string().nullable() }) });
export type OkoWorkspaceView = z.infer<typeof okoWorkspaceViewSchema>;
export const okoWorkspaceQuerySchema = z.strictObject({ context: z.null(), filter: z.strictObject({ workflowId: uuidSchema.optional() }), sort: z.array(z.never()).max(0), page: z.strictObject({ limit: z.number().int().min(1).max(200), cursor: z.string().nullable() }) });
export const okoWorkflowIdSchema = z.strictObject({ workflowId: uuidSchema });
export const okoWorkflowCasSchema = okoWorkflowIdSchema.extend({ expectedRevision: z.string().min(1) });
