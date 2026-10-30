import { z } from 'zod';
import { entityRefSchema, versionRefSchema, moscowDateSchema } from '../../domain/workbench/primitives';
import { queryRequestSchema, sortSchema } from '../../server/workbench/protocol';
import { preferenceSortFields } from '../system/workbench-preferences';

const typed=(type:string)=>entityRefSchema.refine(ref=>ref.entityType===type);
const version=(type:string)=>versionRefSchema.refine(ref=>ref.entityType===type);
export const workbenchFilterSchemas={
  'context.options':z.strictObject({search:z.string().max(200).optional()}),
  overview:z.strictObject({kind:z.enum(['goal','work','decision','data']).nullable().optional()}),
  'goals.list':z.strictObject({}),'goals.detail':z.strictObject({}),
  'execution.list':z.strictObject({kind:z.enum(['all','work','decision']).nullable().optional()}),
  'execution.detail':z.strictObject({ref:entityRefSchema.refine(ref=>['work','decision'].includes(ref.entityType))}),
  'data.captures':z.strictObject({}),
  'data.rows':z.strictObject({captureRef:version('capture'),layer:z.enum(['raw','enriched']),issuesOnly:z.boolean().default(false)}),
  'data.lineage':z.union([z.strictObject({factRef:version('observed_fact')}),z.strictObject({resultRef:version('calculation_result')})]),
  'history.series':z.strictObject({metricRef:version('metric_definition'),granularity:z.enum(['day','friday']),fromInclusive:moscowDateSchema.optional(),toExclusive:moscowDateSchema.optional()}).refine(v=>(v.fromInclusive===undefined)===(v.toExclusive===undefined) && (!v.fromInclusive || v.fromInclusive<v.toExclusive!)),
  'snapshots.list':z.strictObject({}),
  'uor.queue':z.strictObject({}),'uor.package':z.strictObject({packageRef:typed('publication_package')}),
  search:z.strictObject({text:z.string().trim().min(1).max(200)}),
  'notifications.list':z.strictObject({unreadOnly:z.boolean().default(false)}),
  'dashboards.view':z.strictObject({ref:typed('dashboard_def')}),
  'forms.describe':z.strictObject({formKind:z.string().min(1),ref:entityRefSchema.optional(),packageRef:typed('publication_package').optional()}),
};
export function workbenchRequestSchema(name:keyof typeof workbenchFilterSchemas) {
  return queryRequestSchema.extend({filter:workbenchFilterSchemas[name] as z.ZodType<Record<string,unknown>>,sort:z.array(sortSchema).refine(sorts=>new Set(sorts.map(s=>s.field)).size===sorts.length && sorts.every(s=>(preferenceSortFields[name]??[]).includes(s.field)))});
}
