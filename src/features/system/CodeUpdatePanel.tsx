import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
interface Status{currentCommit?:string;targetCommit?:string;branch?:string;available?:boolean;launcherAvailable:boolean;canRequest:boolean;message:string;lastStatus?:{phase:string;message:string;at:string;requestId?:string}|null}
export function CodeUpdatePanel({csrfToken,role}:{csrfToken:string;role:'reader'|'curator'}){
 const[data,setData]=useState<Status|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const alive=useRef(true);
 const load=async()=>{const response=await fetch('/api/system/code-update');if(!response.ok)throw new Error('Не удалось проверить опубликованную версию программы');const result=await response.json() as Status;if(alive.current)setData(result);return result;};
 useEffect(()=>{alive.current=true;void load().catch(e=>setError(e.message));return()=>{alive.current=false;};},[]);
 const update=async()=>{
  if(!data?.currentCommit||!data.targetCommit)return;setBusy(true);setError('');
  try{
   const response=await fetch('/api/system/code-update',{method:'POST',headers:{'content-type':'application/json','x-uor-token':csrfToken},body:JSON.stringify({expectedCommit:data.currentCommit,targetCommit:data.targetCommit})}),result=await response.json();
   if(!response.ok)throw new Error(result.message??'Обновление не принято');setMessage(result.message);
   for(let attempt=0;attempt<120&&alive.current;attempt++){
    await new Promise(resolve=>setTimeout(resolve,1500));let status:Status;try{status=await load();}catch{continue;}
    const last=status.lastStatus;if(!last||last.requestId!==result.requestId)continue;setMessage(last.message);
    if(['failed','rolled_back','recovery_required','committed_unavailable'].includes(last.phase))throw new Error(last.message);
    if(last.phase==='completed'){window.location.reload();return;}
   }
   if(alive.current)setMessage('Перезапуск занимает больше времени. Проверьте локальную консоль запуска и обновите страницу после завершения.');
  }catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}
 }; return <section className="system-card code-update-panel"><h2><RefreshCw size={20}/>Версия программы</h2><p>Сначала программа подготавливает новую версию и зависимости, пока вы продолжаете работу. Затем проверяет запуск и перезапускается. Если запуск не удался, возвращается прежняя версия; личные данные и черновики сохраняются.</p>{data?<><p>{data.message}</p>{data.currentCommit&&<p className="form-note">Текущая версия {data.currentCommit.slice(0,10)} · опубликованная {data.targetCommit?.slice(0,10)??'не получена'} · ветка {data.branch}</p>}{data.lastStatus&&<p className={['failed','rolled_back','recovery_required','committed_unavailable'].includes(data.lastStatus.phase)?'error-inline':'form-note'}>Последнее обновление: {data.lastStatus.message} · {new Date(data.lastStatus.at).toLocaleString('ru-RU')}</p>}</>:<p>Проверяем версию программы…</p>}{error&&<p className="error-inline" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}<div className="code-update-actions"><button className="button secondary" disabled={busy} onClick={()=>{setBusy(true);setError('');void load().catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>Проверить версию</button>{<button className="button primary" disabled={busy||!data?.canRequest} onClick={()=>void update()}>{busy?'Обновляем и перезапускаем…':'Обновить программу и перезапустить'}</button>}</div>{!data?.launcherAvailable&&<p className="form-note">Для перезапуска из приложения используйте обычный запуск npm run dev. Изменённые исходники нужно сохранить перед обновлением.</p>}</section>;
}
