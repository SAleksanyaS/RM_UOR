import { useEffect, useState } from 'react';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import { routeUrl } from '../../../app/workbench/route-state';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import type { SearchReadModel } from '../../catalog/workbench-search';
import type { GlobalContext } from '../../../server/workbench/protocol';
import './search.css';
const labels:Record<string,string>={core_goal_definition:'Цель',directory_entity:'Область или лидер',work:'Работа',decision:'Решение'};
export function GlobalSearch(){
 const {context}=useGlobalContext();const [text,setText]=useState(''),[submitted,setSubmitted]=useState(''),[attempt,setAttempt]=useState(0);
 return <div className="wb-search"><form role="search" onSubmit={event=>{event.preventDefault();setSubmitted(text.trim());setAttempt(value=>value+1);}}><label>Поиск по рабочему месту<input type="search" maxLength={200} value={text} onChange={event=>setText(event.target.value)}/></label><button type="submit" disabled={!text.trim()}>Найти</button>{submitted&&<button type="button" onClick={()=>{setSubmitted('');setText('');}}>Закрыть результаты поиска</button>}</form>{context&&submitted&&<SearchResults key={JSON.stringify([context,submitted,attempt])} context={context} text={submitted} onRetry={()=>setAttempt(value=>value+1)} onOpen={()=>setSubmitted('')}/>}</div>;
}
function SearchResults({context,text,onRetry,onOpen}:{context:GlobalContext;text:string;onRetry():void;onOpen():void}){
 const [cursor,setCursor]=useState<string|null>(null),[items,setItems]=useState<SearchReadModel['items']>([]);
 const read=useWorkbenchQuery<SearchReadModel>('search',{context,filter:{text},sort:[],page:{limit:30,cursor}});
 useEffect(()=>{if(read.data)setItems(previous=>cursor?[...new Map([...previous,...read.data!.items].map(hit=>[hit.ref.entityType+'/'+hit.ref.id,hit])).values()]:read.data!.items);},[read.data,cursor]);
 return <section aria-label="Результаты общего поиска" aria-busy={read.loading}><p>Цели, продукты, лидеры, работы и решения, включая архивные цели.</p>{read.loading&&<p role="status">Ищем…</p>}{read.error!==null&&<p role="alert">{workbenchErrorMessage(read.error,'read')} <button onClick={onRetry}>Повторить поиск</button></p>}{!read.loading&&!read.error&&read.data&&!items.length&&<p>Совпадений нет</p>}<ul>{items.map(hit=><li key={hit.ref.entityType+'/'+hit.ref.id}><a href={routeUrl(hit.route,hit.context)} onClick={event=>{if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();window.history.pushState(null,'',routeUrl(hit.route,hit.context));window.dispatchEvent(new PopStateEvent('popstate'));onOpen();}}}>{hit.name} · {labels[hit.type]??hit.type}</a></li>)}</ul>{read.data?.page.nextCursor&&<button type="button" disabled={read.loading} onClick={()=>setCursor(read.data!.page.nextCursor)}>Ещё результаты</button>}</section>;
}
