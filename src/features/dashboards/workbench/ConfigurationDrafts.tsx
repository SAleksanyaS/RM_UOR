import { useEffect,useState } from 'react';
import { useGlobalContext,useWorkbench,useWorkbenchQuery } from '../../../app/workbench/context';
import type { EntityRef } from '../../../domain/workbench/primitives';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import { QueryFeedback } from '../../overview/workbench/goal-view-utils';
import { configurationRequest } from './dashboard-ui';
type Entry=WorkbenchReadModels['uor.package']['entries'][number];
/** Canonical references from the current owner's public package reads only. */
export function ConfigurationDrafts({entityType,onSelect,objectType}:{entityType:'dashboard_def'|'custom_field_def';onSelect(reference:EntityRef):void;objectType?:string}){
 const {client,session}=useWorkbench();const {context}=useGlobalContext();const [cursor,setCursor]=useState<string|null>(null),[entries,setEntries]=useState<Entry[]>([]),[error,setError]=useState<unknown>(null),[loading,setLoading]=useState(false);
 const allowed=!!session?.allowedCommands.includes('draft.open');
 const queue=useWorkbenchQuery<WorkbenchReadModels['uor.queue']>('uor.queue',allowed&&context?configurationRequest(context,{},cursor):null);
 useEffect(()=>{if(!context||!queue.data)return;let active=true;setLoading(true);setError(null);void Promise.all(queue.data.items.filter(pkg=>!pkg.publication||!['merged','declined','publishing','validating'].includes(pkg.publication.state)).map(pkg=>client.query<WorkbenchReadModels['uor.package']>('uor.package',configurationRequest(context,{packageRef:pkg.packageRef})))).then(packages=>{if(active)setEntries(previous=>[...new Map([...(cursor?previous:[]),...packages.flatMap(pkg=>pkg.data.entries.filter(entry=>entry.entityRef.entityType===entityType&&(!objectType||!Array.isArray(entry.definition.entityTypes)||entry.definition.entityTypes.includes(objectType))))].map(entry=>[entry.draftId,entry])).values()]);},failure=>{if(active)setError(failure);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[client,queue.data,cursor,entityType,objectType]);
 if(!allowed)return null;
 return <section aria-label={entityType==='dashboard_def'?'Собственные черновики дашбордов':'Собственные черновики полей'}><QueryFeedback loading={queue.loading||loading} error={queue.error??error}/>{entries.map(entry=><p key={entry.draftId}><button onClick={()=>onSelect(entry.entityRef)}>{entityType==='dashboard_def'?'Продолжить дашборд: ':'Продолжить поле: '}{String(entry.definition.title??entry.definition.name??'Без названия')}</button>{!entry.complete&&' · Требует заполнения'}</p>)}{queue.data?.page.nextCursor&&<button disabled={loading||queue.loading} onClick={()=>setCursor(queue.data!.page.nextCursor)}>Ещё собственные настройки</button>}</section>;
}
