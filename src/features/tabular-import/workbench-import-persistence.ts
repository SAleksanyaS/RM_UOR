import { z } from 'zod';
import { businessTimeSchema,uuidSchema } from '../../domain/workbench/primitives';
import { coreGoalDefinitionSchema,sourceDefinitionSchema,sourceFieldMappingSchema,goalAssignmentSchema,methodVersionSchema,metricDefinitionSchema,directoryEntitySchema,directoryLinkSchema,captureSchema,rawSourceRowSchema,canonicalSourceRowSchema } from '../../domain/workbench/schemas';
import { globalContextSchema,revisionTokenSchema } from '../../server/workbench/protocol';
import { fileHandleViewSchema } from '../../server/workbench/file-view';
import { bindingSchema } from '../connectors/workbench-source-store';
import { importPreviewResultSchema } from './workbench-import';

/** Connection selector/profile are intentionally absent from inert historical binding. */
export const portableResolvedCaptureBindingSchema=bindingSchema.extend({goal:coreGoalDefinitionSchema,source:sourceDefinitionSchema,mapping:sourceFieldMappingSchema,assignment:goalAssignmentSchema,method:methodVersionSchema,metrics:z.array(metricDefinitionSchema),directoryEntities:z.array(directoryEntitySchema),directoryLinks:z.array(directoryLinkSchema),context:globalContextSchema,businessTime:businessTimeSchema,configurationRevision:revisionTokenSchema});
export const portableImportPreviewSchema=z.strictObject({personId:uuidSchema,goalId:uuidSchema,file:fileHandleViewSchema,binding:portableResolvedCaptureBindingSchema,basisDigest:z.string().regex(/^[a-f0-9]{64}$/),view:importPreviewResultSchema,capture:captureSchema,rawRows:z.array(rawSourceRowSchema),canonicalRows:z.array(canonicalSourceRowSchema),unchangedRowIds:z.array(uuidSchema),selectedRowKeys:z.record(z.string(),z.array(z.string())),groupMembership:z.record(z.string(),z.array(z.string())),validGroupKeys:z.array(z.string())});
