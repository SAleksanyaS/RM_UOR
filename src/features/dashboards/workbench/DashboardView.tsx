import { useEffect,useRef,useState } from 'react';
import { useGlobalContext,useWorkbench,useWorkbenchQuery } from '../../../app/workbench/context';
import { useUnsavedChanges } from '../../../app/workbench/use-unsaved-changes';
import type { EntityRef } from '../../../domain/workbench/primitives';
import type { CommandRequest,CommandResult } from '../../../server/workbench/protocol';
import type { PreferencesRead } from '../../system/workbench-preferences-query';
import type { ConfigurationOptions } from '../../catalog/workbench-configuration-query';
import type { DashboardBlockRead,ExecutionReadItem,GoalReadRow,WorkbenchReadModels } from '../../catalog/workbench-read-models';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import { ContextLink,displayExact,QueryFeedback } from '../../overview/workbench/goal-view-utils';
import { blockNames,columnLabels,configurationRequest } from './dashboard-ui';
import { executionOwner } from '../../execution/workbench/execution-ui';
import { ConfigurationDrafts } from './ConfigurationDrafts';
import { DashboardBuilder } from './DashboardBuilder';
import { CustomFieldsPanel } from './CustomFieldEditor';
import './dashboards.css';
export function DashboardView({reference}:{reference?:EntityRef}){
 const {context}=useGlobalContext();const {client,session}=useWorkbench();const [selected,setSelected]=useState(reference?.id??''),[cursor,setCursor]=useState<string|null>(null),[options,setOptions]=useState<ConfigurationOptions['items']>([]),[editing,setEditing]=useState<EntityRef|null|false>(false);
 const [builderDirty,setBuilderDirty]=useState(false);const leaveBuilder=useUnsavedChanges(builderDirty);
 const catalog=useWorkbenchQuery<ConfigurationOptions>('configuration.options',context?configurationRequest(context,{kind:'dashboard'},cursor):null);
 useEffect(()=>{if(catalog.data)setOptions(previous=>cursor?[...new Map([...previous,...catalog.data!.items].map(item=>[item.ref.id,item])).values()]:catalog.data!.items);},[catalog.data,cursor,client]);
 const dashboard=useWorkbenchQuery<WorkbenchReadModels['dashboards.view']>('dashboards.view',context&&selected?configurationRequest(context,{ref:{entityType:'dashboard_def',id:selected}}):null);
 const preparation=session?.allowedCommands.includes('dashboard.draft.save');
 return <section className="wb-dashboards" aria-label="Дашборды"><PersonalView key={executionOwner(client)+":"+session?.personId}/><h2>Общие дашборды</h2><QueryFeedback loading={catalog.loading} error={catalog.error}/><label>Дашборд<select aria-label="Дашборд" value={selected} onChange={event=>{const value=event.target.value;leaveBuilder(()=>{setSelected(value);setEditing(false);setBuilderDirty(false);});}}><option value="">Выберите опубликованный дашборд</option>{selected&&!options.some(item=>item.ref.id===selected)&&<option value={selected}>Выбранный дашборд</option>}{options.map(item=><option key={item.ref.id} value={item.ref.id}>{item.title}</option>)}</select></label>{catalog.data?.page.nextCursor&&<button disabled={catalog.loading} onClick={()=>setCursor(catalog.data!.page.nextCursor)}>Ещё дашборды</button>}{!catalog.loading&&catalog.data&&!options.length&&<p>Общие дашборды ещё не опубликованы. {preparation?'Создайте дашборд в своём пакете.':'Получите проверенное обновление из main.'}</p>}
 {preparation&&<div className="wb-dashboard-actions"><button onClick={()=>leaveBuilder(()=>{setEditing(null);setBuilderDirty(false);})}>Создать общий дашборд</button>{selected&&<button onClick={()=>leaveBuilder(()=>{setEditing({entityType:'dashboard_def',id:selected});setBuilderDirty(false);})}>Изменить общий дашборд</button>}</div>}{editing===false&&preparation&&<ConfigurationDrafts entityType="dashboard_def" onSelect={setEditing}/ >}{editing!==false&&<><button onClick={()=>leaveBuilder(()=>{setEditing(false);setBuilderDirty(false);})}>Закрыть конструктор</button><DashboardBuilder key={editing?.id??'new'} reference={editing} onDirtyChange={setBuilderDirty}/></>}
 <QueryFeedback loading={dashboard.loading} error={dashboard.error}/>{dashboard.data&&<><h2>{dashboard.data.definition.title}</h2>{dashboard.data.unavailableReason&&<p role="status">{reasonLabel(dashboard.data.unavailableReason)}</p>}{dashboard.data.definition.filters.map(filter=><ScopeFilter key={filter.schemaId} levels={filter.value.levels as string[]} showGoal={!!filter.value.showGoal}/>)}<div className="wb-dashboard-grid">{dashboard.data.blocks.map(block=><article key={block.id} className="wb-dashboard-block" style={{gridColumn:`span ${block.layout.w}`,minHeight:`${block.layout.h*5}rem`}} aria-label={blockNames[block.type]}><h3>{blockNames[block.type]}</h3><BlockRenderer block={block}/></article>)}</div>{!dashboard.data.blocks.length&&<p>В дашборде пока нет блоков.</p>}</>}
 {context?.goalId&&<CustomFieldsPanel key={context.goalId} objectRef={{entityType:'core_goal_definition',id:context.goalId}}/>}
 </section>;
}
function PersonalView(){
 const {client,preferences,refreshPreferences}=useWorkbench();
 const [theme,setTheme]=useState<PreferencesRead['values']['visual']['theme']>(preferences?.values.visual.theme??'system');
 const [density,setDensity]=useState<PreferencesRead['values']['visual']['density']>(preferences?.values.visual.density??'comfortable');
 const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[readError,setReadError]=useState<unknown>(null),[saved,setSaved]=useState(false),[unknown,setUnknown]=useState(false);
 const pending=useRef<CommandRequest|null>(null),live=useRef(true),dirty=useRef(false),locked=useRef(false);
 useUnsavedChanges(dirty.current);
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[client]);
 useEffect(()=>{if(preferences&&!dirty.current){setTheme(preferences.values.visual.theme);setDensity(preferences.values.visual.density);}},[preferences]);
 const readBack=async()=>{
  try{await refreshPreferences();if(live.current)setReadError(null);}
  catch(failure){if(live.current)setReadError(failure);}
 };
 const refreshDisplay=async()=>{
  if(locked.current)return;locked.current=true;setBusy(true);
  try{await readBack();}finally{if(live.current){setBusy(false);locked.current=false;}}
 };
 const save=async()=>{
  if(locked.current)return;locked.current=true;setBusy(true);setError(null);setReadError(null);setSaved(false);
  try{
   if(!pending.current){
    const read=await client.query<PreferencesRead>('preferences.get',{context:null,filter:{},sort:[],page:{limit:50,cursor:null}});
    if(!live.current)return;
    pending.current={commandId:crypto.randomUUID(),name:'preferences.set',baseRevision:read.data.editToken,payload:{values:{...read.data.values,visual:{theme,density}}}};
   }
   const response=await client.command<CommandResult>(pending.current);
   if('jobId'in response.data)throw Error('Ожидался ответ сохранения настроек');
   // A confirmed mutation receipt is authoritative. A subsequent read failure
   // must never turn it into an unknown mutation or offer to submit it again.
   pending.current=null;dirty.current=false;
   if(live.current){setUnknown(false);setSaved(true);}
   await readBack();
  }catch(failure){
   if(live.current){
    const definite=failure instanceof WorkbenchApiError&&[403,409,422].includes(failure.status);
    if(definite)pending.current=null;
    setUnknown(pending.current!==null&&!definite);setError(failure);
   }
  }finally{if(live.current){setBusy(false);locked.current=false;}}
 };
 return <section aria-label="Личный вид"><h2>Личный вид</h2><fieldset disabled={busy||unknown}><legend>Только на этом рабочем месте</legend><label>Тема<select aria-label="Тема" value={theme} onChange={event=>{dirty.current=true;setSaved(false);setTheme(event.target.value as typeof theme);}}><option value="system">Как в системе</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label><label>Плотность представления<select aria-label="Плотность представления" value={density} onChange={event=>{dirty.current=true;setSaved(false);setDensity(event.target.value as typeof density);}}><option value="comfortable">Обычная</option><option value="compact">Компактная</option></select></label></fieldset><button disabled={busy} onClick={()=>void save()}>{unknown?'Проверить сохранение личного вида':'Сохранить личный вид'}</button>{error!==null&&<p role="alert">{workbenchErrorMessage(error)}</p>}{saved&&<p role="status">Личный вид сохранён</p>}{readError!==null&&<div role="alert"><p>Личный вид сохранён; обновить отображение пока не удалось. Повторите чтение настроек.</p><button disabled={busy} onClick={()=>void refreshDisplay()}>Обновить отображение</button></div>}<p>Настройки вида не меняют общие данные и методику.</p></section>;
}
function ScopeFilter({levels,showGoal}:{levels:string[];showGoal:boolean}){
 const {context,setContext}=useGlobalContext();const [error,setError]=useState<unknown>(null);const options=useWorkbenchQuery<WorkbenchReadModels['context.options']>('context.options',context?configurationRequest(context):null);if(!context)return null;
 const change=(patch:Parameters<typeof setContext>[0])=>{setError(null);void setContext(patch).catch(setError);};
 const keys={cluster:'clusterId',product:'productId',team:'teamId'} as const;const titles={cluster:'Кластер',product:'Продукт',team:'Команда'};
 return <fieldset><legend>Общий контекст дашборда</legend><QueryFeedback loading={options.loading} error={options.error}/>{levels.map(level=>{if(!(level in keys))return null;const kind=level as keyof typeof keys,key=keys[kind],parent=kind==='cluster'?context.scopePath.ditId:kind==='product'?context.scopePath.clusterId:context.scopePath.productId;const linkKind=kind==='cluster'?'dit_cluster':kind==='product'?'cluster_product':'product_team';const entities=options.data?.entities.filter(entity=>entity.kind===kind&&options.data!.links.some(link=>link.kind===linkKind&&'from'in link&&link.from.id===parent&&link.to.id===entity.id))??[];return <label key={kind}>{titles[kind]}<select aria-label={titles[kind]} disabled={!parent} value={context.scopePath[key]??''} onChange={event=>change({scopePath:{[key]:event.target.value||null}})}><option value="">Все</option>{entities.map(entity=><option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label>;})}{showGoal&&<label>Цель<select aria-label="Цель" value={context.goalId??''} onChange={event=>change({goalId:event.target.value||null})}><option value="">Все цели</option>{options.data?.goals.map(goal=><option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>}{error!==null&&<p role="alert">{workbenchErrorMessage(error)}</p>}</fieldset>;
}
function reasonLabel(reason:string):string{return ({AGREED_SNAPSHOT_UNAVAILABLE:'Согласованный срез не опубликован',NO_DATA:'Нет данных',NEEDS_CALCULATION:'Требуется расчёт',ASSIGNMENT_OUTSIDE_CONTEXT:'Назначение вне выбранной области',HISTORICAL_EVALUATION_TIME_UNAVAILABLE:'Историческое время расчёта неизвестно'} as Record<string,string>)[reason]??reason;}
function BlockRenderer({block}:{block:DashboardBlockRead}){
 const {context}=useGlobalContext();const directory=useWorkbenchQuery<WorkbenchReadModels['context.options']>('context.options',context&&block.type==='execution-table'?configurationRequest(context):null);const names=Object.fromEntries((directory.data?.entities??[]).map(entity=>[entity.id,entity.name]));
 if(block.type==='goal-table')return <div className="wb-dashboard-table"><table><thead><tr>{block.columns.map(column=><th key={column}>{columnLabels[column]}</th>)}</tr></thead><tbody>{block.items.map(row=><tr key={row.ref.id}>{block.columns.map(column=><td key={column}>{column==='title'?<ContextLink path={'/goals/'+row.goal.id} label={row.goal.title}/>:goalCell(row,column,context?.resultMode??'current')}</td>)}</tr>)}</tbody></table>{!block.items.length&&<p>Целей в выбранном контексте нет.</p>}</div>;
 if(block.type==='execution-table')return <><QueryFeedback loading={directory.loading} error={directory.error}/><div className="wb-dashboard-table"><table><thead><tr>{block.columns.map(column=><th key={column}>{columnLabels[column]}</th>)}</tr></thead><tbody>{block.items.map(item=><tr key={item.ref.id}>{block.columns.map(column=><td key={column}>{column==='title'?<ContextLink path={'/execution?ref='+item.ref.entityType+'/'+item.ref.id} label={item.title}/>:executionCell(item,column,names)}</td>)}</tr>)}</tbody></table>{!block.items.length&&<p>Работ и решений в выбранном контексте нет.</p>}</div></>;
 if(block.type==='data-issues')return block.items.length?<ul>{block.items.map((issue,index)=><li key={index}>{reasonLabel(issue.message)} · {issue.code} <ContextLink path="/data" label="Проверить данные"/></li>)}</ul>:<p>Проблем данных в выбранном контексте не найдено.</p>;
 return <>{block.unavailableReason&&<p role="status">{reasonLabel(block.unavailableReason)}</p>}<p className="wb-dashboard-number">{displayExact(block.value)}{block.value!==null&&block.unit?' '+block.unit:''}</p><p>Редакция показателя: {block.metricRef.revision}</p>{block.freshness&&<p>{block.freshness==='fresh'?'Данные актуальны':block.freshness==='stale'?'Данные устарели':'Актуальность неизвестна'}</p>}{block.qualityFlags.map(flag=><p key={flag}>{flag}</p>)}{block.trend&&<TrendTable trend={block.trend}/>}</>;
}
function goalCell(row:GoalReadRow,column:string,mode:'current'|'agreed'){
 switch(column){case 'scope':return row.scopeName??'Имя области не сохранено';case 'owner':return row.leader?.name??'Не назначен';case 'requirement':return <ContextLink path={'/goals/'+row.goal.id+'#method'} label="Требование и методика"/>;case 'current':case 'agreed':return mode===column?row.goal.mode==='manual_status'?row.manualStatus?.to==='completed'?'Завершена':row.manualStatus?.to==='in_progress'?'В работе':'Не начата':displayExact(row.displayValue):column==='agreed'?'Выберите согласованный вид':'Выберите текущий вид';case 'freshness':return row.numericResult?.freshness==='fresh'?'Актуальны':row.numericResult?.freshness==='stale'?'Устарели':'Неизвестна';case 'coverage':return displayExact(row.numericResult?.coveragePercent);case 'confirmation':return row.attestation?'Подтверждено УОР':'Не подтверждено';case 'nextAction':return row.nextActions.find(action=>action.enabled)?.label??'Проверьте основания';default:return 'Не задано';}
}
function executionCell(item:ExecutionReadItem,column:string,names:Record<string,string>):string{
 if(column==='kind')return item.kind==='work'?'Работа':'Решение';if(column==='owner')return item.kind==='work'?item.value.responsibility.map(owner=>names[owner.personId]??'Имя недоступно').join(', '):names[item.value.requestedFromPersonId]??'Имя недоступно';if(column==='dueOn')return item.value.dueOn??'Не задан';if(item.kind==='decision')return column==='state'?item.value.answer===null?'Ожидает решения':'Ответ получен':column==='nextAction'?item.value.answer??item.value.request:'Не задано';switch(column){case 'state':return ({planned:'Запланирована',in_progress:'В работе',paused:'Приостановлена',completed:'Завершена',cancelled:'Отменена'})[item.value.state];case 'forecastOn':return item.value.forecastOn??'Не задан';case 'risk':return item.value.risk?.reason??item.value.blocker??'Не указан';case 'nextAction':return item.value.nextAction;default:return 'Не задано';}
}
function TrendTable({trend}:{trend:NonNullable<Extract<DashboardBlockRead,{type:'metric-card'}>['trend']>}){
 return <div className="wb-dashboard-table"><table><caption>Временной ряд · {trend.mode==='agreed'?'согласованный':'текущий'}</caption><thead><tr><th>Дата / период</th><th>Значение</th><th>Дата исходных данных</th><th>Примечание</th></tr></thead><tbody>{trend.points.map((point,index)=><tr key={index}><td>{'friday'in point?point.friday:'date'in point?point.date:point.businessTime.kind==='as_of'?point.businessTime.date:point.businessTime.kind==='period'?point.businessTime.startInclusive+' — '+point.businessTime.endExclusive+' (не включая)':'Неизвестно'}</td><td>{displayExact(point.value)}</td><td>{point.sourceCapturedAt??'Неизвестна'}</td><td>{'warning'in point?point.warning??'Новое наблюдение':'Исходное наблюдение'}</td></tr>)}</tbody></table>{!trend.points.length&&<p>В выбранном периоде наблюдений нет.</p>}{trend.nextCursor&&<p>Показана часть ряда. Откройте историю цели для продолжения.</p>}{trend.qualityFlags.map(flag=><p key={flag}>{flag}</p>)}</div>;
}
