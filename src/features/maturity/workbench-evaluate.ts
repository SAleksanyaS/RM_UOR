import { compare } from '../../domain/workbench/exact-number';
import { maturityDefinitionSchema,maturityObservationSchema,reportedMaturityClaimSchema,type MaturityDefinition,type MaturityObservation,type ReportedMaturityClaim,type MaturityEvaluation } from './workbench-contracts';
/** Pure evaluation of a versioned expected matrix. Source availability never changes its denominator. */
export function evaluateMaturity(input:{definition:MaturityDefinition;observations:MaturityObservation[];reportedClaims:ReportedMaturityClaim[]}):MaturityEvaluation {
 const definition=maturityDefinitionSchema.parse(input.definition),observations=input.observations.map(o=>maturityObservationSchema.parse(o));
 if(new Set(definition.teamIds).size!==definition.teamIds.length||new Set(definition.metrics.map(m=>m.id)).size!==definition.metrics.length)throw Error('MATURITY_DEFINITION_DUPLICATE');
 const slots:MaturityEvaluation['slots']=[],qualityFlags:string[]=[];
 const buckets=new Map<string,MaturityObservation[]>();for(const o of observations){const k=o.teamId+'/'+o.metricId;buckets.set(k,[...(buckets.get(k)??[]),o]);if(!definition.teamIds.includes(o.teamId)||!definition.metrics.some(m=>m.id===o.metricId))qualityFlags.push('unexpected_observation');}
 for(const teamId of definition.teamIds)for(const metric of definition.metrics){
  const values=buckets.get(teamId+'/'+metric.id)??[],o=values[0];
  const state=values.length>1?'conflict':!o?'missing':compare(o.target,metric.target)!==0?'conflict':o.state==='numeric'?(compare(o.value!,metric.target)>=0?'met':'not_met'):o.state;
  slots.push({teamId,metricId:metric.id,state,value:o?.value??null,target:metric.target,source:o?.source??null,reason:state==='conflict'?'Противоречивые строки или порог':!o?'Отсутствует ожидаемая строка':state==='exception'||state==='no_event'?'Применимость требует утверждённого основания':state==='missing'?o.raw:null});
 }
 const count=(state:string)=>slots.filter(s=>s.state===state).length;
 let teamsMet=0,teamsNotMet=0,teamsIncomplete=0;
 for(const id of definition.teamIds){const s=slots.filter(o=>o.teamId===id);if(s.some(o=>o.state==='not_met'))teamsNotMet++;else if(s.every(o=>o.state==='met'))teamsMet++;else teamsIncomplete++;}
 const counts={expected:slots.length,numeric:count('met')+count('not_met'),met:count('met'),notMet:count('not_met'),exception:count('exception'),noEvent:count('no_event'),missing:count('missing'),conflict:count('conflict'),teamsMet,teamsNotMet,teamsIncomplete};
 if(counts.exception||counts.noEvent)qualityFlags.push('applicability_unapproved');if(counts.missing)qualityFlags.push('missing_expected_observation');if(counts.conflict)qualityFlags.push('conflicting_observation');
 const complete=counts.numeric===counts.expected&&counts.conflict===0;
 return {definition:structuredClone(definition),counts,slots,complete,canConfirm:false,achievement:counts.notMet?'not_met':complete?'met':'unknown',reportedClaims:input.reportedClaims.map(c=>reportedMaturityClaimSchema.parse(c)),qualityFlags:[...new Set(qualityFlags)]};
}
