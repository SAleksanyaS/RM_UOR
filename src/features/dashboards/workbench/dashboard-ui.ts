import type { DashboardDef } from '../../../domain/workbench/entities';
export const blockNames={'metric-card':'Карточка показателя','goal-table':'Список целей','metric-trend':'Временной ряд','execution-table':'Работы и решения','data-issues':'Проблемы данных','goal-comparison':'Сравнение назначений','goal-matrix':'Матрица команд и показателей'} as const;
export type BlockKind=keyof typeof blockNames;
export type DashboardDefinition=Pick<DashboardDef,'title'|'blocks'|'filters'>;
export const columnLabels:Record<string,string>={title:'Название',scope:'Область',owner:'Ответственный',requirement:'Требование',current:'Текущий результат',agreed:'Согласованный результат',freshness:'Актуальность',coverage:'Полнота',confirmation:'Подтверждение',nextAction:'Следующий шаг',kind:'Вид',state:'Состояние',dueOn:'Плановый срок',forecastOn:'Прогноз',risk:'Риск'};
export const goalColumns=['title','scope','owner','requirement','current','agreed','freshness','coverage','confirmation','nextAction'];
export const executionColumns=['title','kind','owner','state','dueOn','forecastOn','risk','nextAction'];
export const issueNames={stale:'Устаревшие',incomplete:'Неполные',missing:'Нет данных',unmapped:'Не сопоставлены',error:'Ошибки'};
export const configurationRequest=(context:import('../../../server/workbench/protocol').GlobalContext,filter:Record<string,unknown>={},cursor:string|null=null)=>({context,filter,sort:[],page:{limit:100,cursor}});
export function newBlock(kind:BlockKind):DashboardDef['blocks'][number]{
 const typeId=`uor.dashboard.${kind}.v1`,layout={w:6,h:2};
 const value:Record<string,unknown>=kind==='goal-comparison'||kind==='goal-matrix'?{layout,limit:20,attentionOnly:false}:kind==='goal-table'?{layout,columns:['title','current','nextAction'],limit:20,attentionOnly:false}:kind==='execution-table'?{layout,kind:'all',columns:['title','state','dueOn'],limit:20,attentionOnly:false}:kind==='data-issues'?{layout,kinds:['stale','incomplete','missing','unmapped','error'],limit:20}:kind==='metric-card'?{layout,showTrend:false}:{layout,granularity:'friday'};
 return {id:crypto.randomUUID(),typeId,settings:{schemaId:typeId,schemaVersion:1,value}};
}
export const blockKind=(block:DashboardDef['blocks'][number])=>block.typeId.slice('uor.dashboard.'.length,-'.v1'.length) as BlockKind;

export function dashboardPreset(kind:'management'|'quality'):DashboardDefinition{return {title:kind==='management'?'Управленческий обзор':'Качество данных',blocks:(kind==='management'?['goal-comparison','goal-matrix','execution-table','data-issues'] as const:['goal-table','data-issues'] as const).map(newBlock),filters:[{schemaId:'uor.dashboard.scope-filter.v1',schemaVersion:1,value:{levels:['cluster','product','team'],showGoal:true}}]};}
