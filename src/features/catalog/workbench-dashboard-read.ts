import type { DashboardDef, EvaluationInput } from '../../domain/workbench/entities';
import type { EntityRef, VersionRef } from '../../domain/workbench/primitives';
import type { HistorySeries } from '../history/workbench-history-contracts';
import { selectEvaluationFacts } from '../evaluation/workbench/select-facts';
import { resolveDashboardMetric, type DashboardReferencePort } from '../knowledge/workbench-dashboards';
import type { DashboardBlockRead, DashboardIssue, ExecutionReadItem, GoalReadRow } from './workbench-read-models';

type Layout={w:3|6|12;h:1|2|3};
/** Materialize presentation data from verified read models and pure saved-basis
 * reads. Block settings never select another scope/date or start a calculation. */
export function buildDashboardBlocks(input:{definition:DashboardDef;goals:GoalReadRow[];execution:ExecutionReadItem[];issues:DashboardIssue[];resolver:DashboardReferencePort;unavailableReason:string|null;today:string;inputFor:(row:GoalReadRow)=>EvaluationInput|null;trendFor:(row:GoalReadRow,metricRef:VersionRef,granularity:'day'|'friday')=>HistorySeries}):DashboardBlockRead[] {
  const goalAttention=(row:GoalReadRow)=>row.needs_calculation || row.unavailableReason!==null || row.numericResult!==null && (row.numericResult.achievement!=='met' || row.numericResult.freshness!=='fresh' || !row.numericResult.complete) || row.goal.mode==='manual_status' && row.manualStatus?.to!=='completed';
  const workAttention=(item:ExecutionReadItem)=>item.kind==='decision'?item.value.answer===null:item.value.state!=='completed'&&item.value.state!=='cancelled'&&(item.value.risk!==null||item.value.blocker!==null||item.value.state==='paused'||item.value.dueOn!==null&&(item.value.dueOn<input.today||item.value.forecastOn!==null&&item.value.forecastOn>item.value.dueOn));
  return input.definition.blocks.map(block=>{
    const type=block.typeId.slice('uor.dashboard.'.length,-'.v1'.length);
    const settings=block.settings.value;const base={id:block.id,layout:settings.layout as Layout};
    if(type==='goal-table') {const config=settings as unknown as {columns:Extract<DashboardBlockRead,{type:'goal-table'}>['columns'];limit:number;attentionOnly:boolean};return {...base,type,columns:config.columns,items:input.goals.filter(row=>!config.attentionOnly||goalAttention(row)).slice(0,config.limit)};}
    if(type==='execution-table') {const config=settings as unknown as {columns:Extract<DashboardBlockRead,{type:'execution-table'}>['columns'];limit:number;attentionOnly:boolean;kind:'all'|'work'|'decision'};return {...base,type,columns:config.columns,items:input.execution.filter(item=>(config.kind==='all'||item.kind===config.kind)&&(!config.attentionOnly||workAttention(item))).slice(0,config.limit)};}
    if(type==='data-issues') {const config=settings as unknown as {kinds:DashboardIssue['kind'][];limit:number};return {...base,type,items:input.issues.filter(issue=>config.kinds.includes(issue.kind)).slice(0,config.limit)};}
    const config=settings as unknown as {assignmentRef:EntityRef;metricRef:VersionRef;showTrend?:boolean;granularity?:'day'|'friday'};
    const row=input.goals.find(goal=>goal.assignment.id===config.assignmentRef.id);
    const resolved=input.unavailableReason||!row?null:resolveDashboardMetric(config.assignmentRef,config.metricRef,input.resolver);
    const actual=row?.basisRef?input.inputFor(row):null;
    const selected=actual?selectEvaluationFacts(actual).metrics.find(metric=>metric.metricRef.id===(resolved?.metricRef??config.metricRef).id):null;
    const metric=actual?.metrics.find(metric=>metric.id===(resolved?.metricRef??config.metricRef).id);
    const unavailableReason=input.unavailableReason??(!row?'ASSIGNMENT_OUTSIDE_CONTEXT':!actual?row.unavailableReason??(row.needs_calculation?'NEEDS_CALCULATION':'HISTORICAL_EVALUATION_TIME_UNAVAILABLE'):selected?.value===null?'NO_DATA':null);
    return {...base,type:type as 'metric-card'|'metric-trend',assignmentRef:row?.ref??null,metricRef:resolved?.metricRef??config.metricRef,basisRef:row?.basisRef??null,value:selected?.value??null,unit:metric?.unit.code??null,trend:row&&actual&&(type==='metric-trend'||config.showTrend)?input.trendFor(row,resolved?.metricRef??config.metricRef,type==='metric-trend'?config.granularity!:'friday'):null,unavailableReason,freshness:row?.numericResult?.freshness??null,qualityFlags:row?.numericResult?.qualityFlags??[]};
  });
}
