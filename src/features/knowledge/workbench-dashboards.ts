import { z } from 'zod';
import type { DashboardDef, EvaluationBasis, GoalAssignment, MethodVersion, RegisteredPayload, Template } from '../../domain/workbench/entities';
import type { EntityRef, Header, VersionRef } from '../../domain/workbench/primitives';
import { entityRefSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { dashboardDefSchema } from '../../domain/workbench/schemas/extensions';
import type { SchemaDescriptor } from '../../server/workbench/modules';
import { fieldProblems, WorkbenchHttpError } from '../../server/workbench/protocol';
import { partialSchema } from '../catalog/workbench-drafts';

export const goalColumns = ['title','scope','owner','requirement','current','agreed','freshness','coverage','confirmation','nextAction'] as const;
export const executionColumns = ['title','kind','owner','state','dueOn','forecastOn','risk','nextAction'] as const;
const unique = (items: readonly unknown[]) => new Set(items).size === items.length;
const layout = z.strictObject({ w:z.union([z.literal(3),z.literal(6),z.literal(12)]), h:z.union([z.literal(1),z.literal(2),z.literal(3)]) });
const limit = z.number().int().min(1).max(200);
const assignmentRef = entityRefSchema.refine(r => r.entityType === 'goal_assignment');
const metricRef = versionRefSchema.refine(r => r.entityType === 'metric_definition');
const columns = <T extends readonly [string,...string[]]>(values:T) => z.array(z.enum(values)).min(1).refine(v => unique(v) && v.includes('title'));
const catalog = {
  'metric-card': z.strictObject({ layout,assignmentRef,metricRef,showTrend:z.boolean() }),
  'goal-table': z.strictObject({ layout,columns:columns(goalColumns),limit,attentionOnly:z.boolean() }),
  'metric-trend': z.strictObject({ layout,assignmentRef,metricRef,granularity:z.enum(['day','friday']) }),
  'execution-table': z.strictObject({ layout,kind:z.enum(['all','work','decision']),columns:columns(executionColumns),limit,attentionOnly:z.boolean() }),
  'data-issues': z.strictObject({ layout,kinds:z.array(z.enum(['stale','incomplete','missing','unmapped','error'])).min(1).refine(unique),limit }),
  'scope-filter': z.strictObject({ levels:z.array(z.enum(['cluster','product','team'])).min(1).refine(v => unique(v) && v.every((level,index) => level === ['cluster','product','team'][index])),showGoal:z.boolean() }),
};
export const dashboardSchemaDescriptors: SchemaDescriptor[] = Object.entries(catalog).map(([type,inputSchema]) => ({schemaId:`uor.dashboard.${type}.v1`,schemaVersion:1,ownerModuleId:'uor',inputSchema}));
const fail = (code:string):never => { throw new WorkbenchHttpError(422,code,code); };
export interface DashboardReferencePort { read(ref:EntityRef|VersionRef):Header|null; agreedBasis?:EvaluationBasis }
function required<T extends Header>(ref: EntityRef|VersionRef, resolver:DashboardReferencePort):T {
  const value = resolver.read(ref);
  if (!value || value.id !== ref.id || 'revision' in ref && value.revision !== ref.revision) return fail('DASHBOARD_REFERENCE_INVALID');
  return value as T;
}
/** An agreed result always follows its saved method, even after current settings change. */
export function resolveDashboardMetric(assignment:EntityRef, metric:VersionRef, resolver:DashboardReferencePort):{assignmentRef:VersionRef;metricRef:VersionRef;methodRef:VersionRef} {
  if (assignment.entityType !== 'goal_assignment' || metric.entityType !== 'metric_definition') return fail('DASHBOARD_REFERENCE_INVALID');
  const basis = resolver.agreedBasis;
  if (basis && (basis.assignmentRef.entityType !== assignment.entityType || basis.assignmentRef.id !== assignment.id)) return fail('DASHBOARD_ASSIGNMENT_MISMATCH');
  const value = required<GoalAssignment>(basis?.assignmentRef ?? assignment,resolver);
  const binding = value.methodBinding;
  const methodRef = basis?.methodRef ?? (binding.kind === 'standalone' ? binding.methodRef : required<Template>({entityType:'template',id:binding.templateId},resolver).methodRef);
  const method = required<MethodVersion>(methodRef,resolver);
  if (method.mode !== 'numeric') return fail('DASHBOARD_METRIC_MISMATCH');
  const rule = method.rules.find(r => r.metricRef.id === metric.id && r.metricRef.entityType === metric.entityType && (basis || r.metricRef.revision === metric.revision));
  if (!rule) return fail('DASHBOARD_METRIC_MISMATCH');
  required(rule.metricRef,resolver);
  return {assignmentRef:{...assignment,revision:value.revision},metricRef:rule.metricRef,methodRef};
}
function descriptor(payload:RegisteredPayload,filter:boolean) {
  const result = dashboardSchemaDescriptors.find(s => s.schemaId === payload.schemaId && s.schemaVersion === payload.schemaVersion);
  if (!result) return fail('SCHEMA_UNSUPPORTED');
  if ((payload.schemaId === 'uor.dashboard.scope-filter.v1') !== filter) return fail('DASHBOARD_SCHEMA_LOCATION');
  return result;
}
/** Used by partial draft saves: missing fields remain form problems, invalid present values fail. */
export function validateDashboardSettings(input:Pick<DashboardDef,'blocks'|'filters'>, partial = false) {
  const problems = [];
  const filters = input.filters ?? [];
  if (!unique(filters.map(f => f.schemaId).filter(Boolean))) return fail('DASHBOARD_FILTER_DUPLICATE');
  const payloads = [...(input.blocks ?? []).map((b,index) => { if (b.typeId && b.settings?.schemaId && b.typeId !== b.settings.schemaId) return fail('DASHBOARD_SCHEMA_MISMATCH'); return {payload:b.settings,filter:false,path:`/blocks/${index}/settings/value`}; }),...filters.map((payload,index) => ({payload,filter:true,path:`/filters/${index}/value`}))];
  for (const {payload,filter,path} of payloads) {
    if (partial) {
      if (!payload) continue;
      if (payload.schemaId && !dashboardSchemaDescriptors.some(s => s.schemaId === payload.schemaId) || payload.schemaVersion !== undefined && payload.schemaVersion !== 1) return fail('SCHEMA_UNSUPPORTED');
      if (!payload.schemaId || payload.schemaVersion === undefined || !payload.value) continue;
    }
    const schema = descriptor(payload,filter).inputSchema;
    const located = (error:z.ZodError) => fieldProblems(error).map(problem => ({...problem,path:path+problem.path}));
    const present = (partial ? partialSchema(schema) : schema).safeParse(payload.value);
    if (!present.success) throw new WorkbenchHttpError(422,'VALIDATION_FAILED','Invalid dashboard settings',located(present.error));
    const full = schema.safeParse(payload.value);
    if (!full.success) {
      // Missing enum/union members have different Zod codes. Inspect the input
      // path itself rather than depending on human-readable validator messages.
      const absent = (keys:PropertyKey[]) => keys.reduce<unknown>((value,key) => value !== null && typeof value === 'object' && Object.hasOwn(value,key) ? (value as Record<PropertyKey,unknown>)[key] : undefined,payload.value) === undefined;
      const missing = full.error.issues.every(issue => absent(issue.path));
      if (!partial || !missing) throw new WorkbenchHttpError(422,'VALIDATION_FAILED','Invalid dashboard settings',located(full.error));
      problems.push(...located(full.error));
    }
  }
  return problems;
}
export function validateDashboard(input:DashboardDef,resolver:DashboardReferencePort):void {
  const value = dashboardDefSchema.parse(input);
  validateDashboardSettings(value);
  for (const block of value.blocks) if (['uor.dashboard.metric-card.v1','uor.dashboard.metric-trend.v1'].includes(block.typeId)) {
    const settings = block.settings.value as {assignmentRef:EntityRef;metricRef:VersionRef};
    resolveDashboardMetric(settings.assignmentRef,settings.metricRef,resolver);
  }
}
