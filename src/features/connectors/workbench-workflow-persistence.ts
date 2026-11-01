import { z } from 'zod';
import { headerSchema, uuidSchema } from '../../domain/workbench/primitives';
import { directoryEntitySchema, directoryLinkSchema, rawCellSchema } from '../../domain/workbench/schemas';
import { fieldProblemSchema } from '../../server/workbench/protocol';
import { okoWorkflowViewSchema } from './workbench-workflow-contracts';

/** Full private recipe state. Browser connection configuration is a separate owner. */
export const parsedSourceTableSchema=z.strictObject({format:z.enum(['csv','xlsx']),sheet:z.string().nullable(),columns:z.array(z.string()),rows:z.array(z.strictObject({coordinate:z.strictObject({sheet:z.string().nullable(),row:z.number().int().positive()}),cells:z.record(z.string(),rawCellSchema)})),dateSystem:z.enum(['1900','1904']).nullable()});
const directory=z.strictObject({entities:z.array(directoryEntitySchema),links:z.array(directoryLinkSchema),issues:z.array(fieldProblemSchema)});
const fields={revision:z.string().min(1),sample:parsedSourceTableSchema.nullable(),dictionaryTable:parsedSourceTableSchema.nullable(),dictionaryRows:z.array(z.record(z.string(),z.string().nullable())),format:z.enum(['csv','xlsx']).nullable(),localMapping:z.strictObject({header:headerSchema,metricIds:z.record(z.string(),uuidSchema)}).optional(),dictionaryGraph:directory.optional(),previousDirectoryGraph:directory.optional()};
export const persistedOkoWorkflowSchema=z.strictObject({...fields,view:okoWorkflowViewSchema});
export const portableOkoWorkflowSchema=z.strictObject({...fields,view:okoWorkflowViewSchema.omit({profile:true})});
export const okoStoredArtifactSchema=z.strictObject({name:z.string().min(1).max(255),mimeType:z.string().min(1).max(150),base64:z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),hash:z.string().regex(/^[a-f0-9]{64}$/)});
export const okoStoredResultSchema=z.strictObject({original:okoStoredArtifactSchema,enriched:okoStoredArtifactSchema});
