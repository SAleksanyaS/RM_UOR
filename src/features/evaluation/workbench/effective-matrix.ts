import {z} from 'zod';
import * as core from '../../../domain/workbench/schemas';
import {versionRefSchema,scopeRefSchema,exactNumberSchema} from '../../../domain/workbench/primitives';
import type {EvaluationInput} from '../../../domain/workbench/entities';
import {selectEvaluationFacts} from './select-facts';
import {testCondition} from './conditions';
const selectionSchema=z.strictObject({metricRef:versionRefSchema,applicable:z.boolean(),value:exactNumberSchema.nullable(),factRefs:z.array(versionRefSchema),correctionRefs:z.array(versionRefSchema),applicabilityRefs:z.array(versionRefSchema),missingPopulation:z.array(z.strictObject({metricId:z.string(),scope:scopeRefSchema})),freshness:z.enum(['fresh','stale','unknown']),qualityFlags:z.array(z.string())});
export const effectiveCellSchema=z.strictObject({scope:scopeRefSchema,metric:core.metricDefinitionSchema,rule:core.metricRuleSchema,selection:selectionSchema,state:z.enum(['met','not_met','missing','not_applicable']),facts:z.array(core.observedFactSchema),corrections:z.array(core.manualCorrectionSchema),applicability:z.array(core.applicabilitySchema)});
export const effectiveBasisSchema=z.strictObject({basis:core.evaluationBasisSchema,assignment:core.goalAssignmentSchema,goal:core.coreGoalDefinitionSchema,method:core.methodVersionSchema,metrics:z.array(core.metricDefinitionSchema),facts:z.array(core.observedFactSchema),captures:z.array(core.captureSchema),corrections:z.array(core.manualCorrectionSchema),applicability:z.array(core.applicabilitySchema),publicationAnchors:z.array(core.publicationAnchorSchema),selection:z.array(selectionSchema),cells:z.array(effectiveCellSchema)});
export type EffectiveCell=z.infer<typeof effectiveCellSchema>;
/** Expand the declared population, never the received fact list. Each assignment
 * keeps its own exact method and metric revisions; a cell is a scoped projection,
 * not a substitution for the assignment's aggregate score. */
export function effectiveCells(input:EvaluationInput):EffectiveCell[]{
 if(input.method.mode!=='numeric')return [];
 return (input.assignment.expectedPopulation??[]).flatMap(scope=>{
  const selected=selectEvaluationFacts({...input,assignment:{...input.assignment,expectedPopulation:[scope]}});
  return selected.metrics.map(selection=>{
   const metric=input.metrics.find(m=>m.id===selection.metricRef.id&&m.revision===selection.metricRef.revision)!;
   const rule=input.method.mode==='numeric'?input.method.rules.find(r=>r.metricRef.id===metric.id&&r.metricRef.revision===metric.revision)!:null!;
   const includes=(refs:typeof selection.factRefs,v:{id:string;revision:number})=>refs.some(r=>r.id===v.id&&r.revision===v.revision);
   return {scope,metric,rule,selection,state:!selection.applicable?'not_applicable' as const:selection.value===null?'missing' as const:testCondition(selection.value,rule.condition)?'met' as const:'not_met' as const,facts:input.facts.filter(v=>includes(selection.factRefs,v)),corrections:input.corrections.filter(v=>includes(selection.correctionRefs,v)),applicability:input.applicability.filter(v=>includes(selection.applicabilityRefs,v))};
  });
 });
}
export const effectiveStateNames={met:'Условие выполнено',not_met:'Ниже порога',missing:'Нет данных',not_applicable:'Не применимо'};
export const exactValue=(v:EffectiveCell['selection']['value'])=>v===null?'Нет данных':typeof v==='string'?v:v.denominator==='1'?v.numerator:v.numerator+'/'+v.denominator;
export const ruleLabel=(c:EffectiveCell['rule']['condition'])=>c.op==='range'?c.min+' … '+c.max:({gte:'≥',lte:'≤',eq:'='}[c.op])+' '+c.target;
export function cellProvenance(cell:EffectiveCell):string{return [...cell.facts.map(f=>`Исходное значение: ${exactValue(f.value)}; факт ${f.id}/${f.revision}; строки ${f.lineage.sourceRowKeys.join(', ')}; получение ${f.captureId}; сопоставление ${f.lineage.mappingRef.id}/${f.lineage.mappingRef.revision}`),...cell.corrections.map(c=>`Коррекция ${c.id}/${c.revision}: ${exactValue(c.replacement)}; ${c.reason}`),...cell.applicability.map(a=>`Применимость ${a.id}/${a.revision}: ${a.reason}`),...cell.selection.qualityFlags].join('; ')||'Нет исходного факта';}
