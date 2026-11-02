import { z } from 'zod';
import { uuidSchema, utcInstantSchema } from '../../domain/workbench/primitives';
import { rawSourceMetadataSchema } from './workbench-workflow-contracts';
import type { Downloaded } from './transport';
const rawSha256Schema=z.string().regex(/^[a-f0-9]{64}$/);
export const captureIntentSchema=z.strictObject({schemaVersion:z.literal(1),captureId:uuidSchema,operationId:uuidSchema,workflowId:uuidSchema,sourceId:uuidSchema,title:z.string().max(200),origin:z.enum(['record','repeat']),sourceKind:z.enum(['oko','confluence']).optional(),sourceMetadata:rawSourceMetadataSchema.optional(),maxBytes:z.number().int().min(1).max(10*1024*1024).optional(),createdAt:utcInstantSchema});
export type CaptureIntent=z.infer<typeof captureIntentSchema>;
export const captureReceiptSchema=z.strictObject({schemaVersion:z.literal(1),captureId:uuidSchema,exportId:uuidSchema,workflowId:uuidSchema,operationId:uuidSchema,sha256:rawSha256Schema,bytes:z.number().int().min(1).max(10*1024*1024),capturedAt:utcInstantSchema,sourceName:z.string().min(1).max(255),mimeType:z.string().min(1).max(150),formatStatus:z.enum(['supported','unsupported','quarantined'])});
export type CaptureReceipt=z.infer<typeof captureReceiptSchema>;
export const captureArtifactSchema=z.strictObject({name:z.string().min(1).max(255),mimeType:z.string().min(1).max(150),base64:z.string().max(14*1024*1024),hash:rawSha256Schema,formatStatus:z.enum(['supported','unsupported','quarantined']).optional()});
export const captureExportPayloadSchema=z.strictObject({artifact:captureArtifactSchema,results:z.array(z.unknown()),captureReceipt:captureReceiptSchema.optional()});
export const persistedCaptureSchema=z.strictObject({owner:z.string().min(1),intent:captureIntentSchema,state:z.enum(['pending','secured','committed','interrupted']),receipt:captureReceiptSchema.nullable(),download:captureArtifactSchema.nullable()});
export const captureStagingSchema=z.strictObject({directory:z.string().min(1).max(4000),guid:uuidSchema,name:z.string().min(1).max(255)});
export type CaptureStaging=z.infer<typeof captureStagingSchema>;
export interface CaptureSink { read?():Downloaded|null;stage?(binding:CaptureStaging):void;commit(download:Downloaded):Promise<CaptureReceipt> }
export type BrowserCapture={intent:CaptureIntent;sink:CaptureSink};
/** Exact new archive inventory; raw bytes remain in SQLite payloads and become archive files via the owner codec. */
export const captureTableInventory=['wb_oko_workflow_captures','wb_oko_workflow_exports'] as const;
