import { Database, GitPullRequest, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDialog, useWorkspace } from '../../app/AppContext';
import { sourceDisplayName } from '../overview/overview-model';
import './update-dialog.css';

export function UpdateDialog({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  useDialog(onClose);
  const { state, mutate, notify } = useWorkspace();
  const automaticSources=state.catalog.sources.filter(source=>source.kind!=='manual'&&source.kind!=='demo'&&!(source.kind==='file'&&!source.collection&&!source.collectionConfigured));
  const [syncPublished, setSync] = useState(true),[sourceIds,setSources]=useState(automaticSources.map(source=>source.id));
  const [recalculate,setRecalculate]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [logins,setLogins]=useState<Record<string,string>>({}),[loginBusy,setLoginBusy]=useState<string|null>(null);
  const activeLogins=useRef(logins);activeLogins.current=logins;
  // Closing an unfinished handoff also closes its browser; no recording is requested.
  useEffect(()=>()=>{for(const recordingId of Object.values(activeLogins.current))void fetch('/api/connectors/login/finish',{method:'POST',headers:{'content-type':'application/json','x-uor-token':state.csrfToken},body:JSON.stringify({recordingId}),keepalive:true}).catch(()=>{});},[state.csrfToken]);
  async function loginSource(sourceId:string){setLoginBusy(sourceId);setError('');try{const recordingId=logins[sourceId];if(recordingId){await mutate('/api/connectors/login/finish',{recordingId});setLogins(current=>{const next={...current};delete next[sourceId];return next;});notify('Вход завершён. Теперь можно обновить данные.');}else{const result=await mutate(`/api/connectors/${encodeURIComponent(sourceId)}/login`,{}) as {recordingId?:unknown};if(typeof result.recordingId!=='string'||!result.recordingId)throw new Error('Не удалось открыть вход в источник. Повторите попытку.');setLogins(current=>({...current,[sourceId]:result.recordingId as string}));}}catch(failure){setError((failure as Error).message);}finally{setLoginBusy(null);}}
  async function run(){setBusy(true);setError('');try{await mutate('/api/update',{syncPublished,sourceIds,recalculate});notify('Обновление запущено. Этапы и время доступны в журнале.');onStarted();onClose();}catch(failure){setError((failure as Error).message);setBusy(false);}}
  const waitingLogin=Object.keys(logins).length>0;
  return <div className="modal-overlay" onClick={onClose}><div className="modal update-modal" role="dialog" aria-modal="true" aria-label="Выбрать обновление" onClick={event=>event.stopPropagation()}>
    <div className="modal-heading"><div><span className="eyebrow">ОБНОВЛЕНИЕ РАБОЧЕГО МЕСТА</span><h2>Что обновить?</h2></div><button className="icon-button" aria-label="Закрыть" onClick={onClose}><X size={20}/></button></div>
    <p className="muted">Общие данные УОР получаются первыми. Затем запускаются выбранные источники и перерасчёт.</p>
    <div className="update-presets"><button onClick={()=>{setSync(true);setSources(automaticSources.map(source=>source.id));setRecalculate(true);}}>Обновить всё</button><button onClick={()=>{setSync(true);setSources([]);setRecalculate(true);}}>Только данные УОР</button><button onClick={()=>{setSync(false);setSources(automaticSources.map(source=>source.id));setRecalculate(true);}}>Только источники</button></div>
    <label className="update-option"><input type="checkbox" checked={syncPublished} onChange={event=>setSync(event.target.checked)}/><span className="option-icon"><GitPullRequest size={20}/></span><span><strong>Данные кураторов УОР</strong><small>Цели, назначения, комментарии и опубликованные снимки из Git</small></span></label>
    <div className="update-source-heading"><Database size={16}/><strong>Источники данных</strong><span>{sourceIds.length} выбрано</span></div>
    <p className="text-hint">Ручные факты и файлы добавляет куратор. Здесь обновляются общие данные и настроенные автоматические источники.</p>
    <div className="update-source-list">{automaticSources.map(source=><div key={source.id}>
      <label className="update-option source-option"><input type="checkbox" checked={sourceIds.includes(source.id)} onChange={event=>setSources(current=>event.target.checked?[...current,source.id]:current.filter(id=>id!==source.id))}/><span><strong>{sourceDisplayName(source,state.catalog)}</strong><small>{source.collection||source.collectionConfigured?'Сбор под вашей учётной записью':'Нужна настройка получения'}</small></span><span className="inline-tag">{source.kind==='file'?'Файл':'Дашборд'}</span></label>
      {(source.interactiveLogin||source.collection?.adapter==='browser'||source.accessUrl)&&<div className="source-login-handoff">{(source.interactiveLogin||source.collection?.adapter==='browser')&&<button type="button" className="button secondary small" disabled={busy||!!loginBusy} onClick={()=>void loginSource(source.id)}>{loginBusy===source.id?'Подождите…':logins[source.id]?'Вход завершён':'Войти в источник'}</button>}{source.accessUrl&&<a className="button secondary small" href={source.accessUrl} target="_blank" rel="noopener noreferrer">Оформить доступ</a>}{logins[source.id]&&<p className="text-hint" role="status">В открывшемся браузере выполните обычный вход. Затем нажмите «Вход завершён». Действия входа не записываются.</p>}</div>}
    </div>)}</div>
    <label className="update-option"><input type="checkbox" checked={recalculate} onChange={event=>setRecalculate(event.target.checked)}/><span className="option-icon"><RefreshCw size={19}/></span><span><strong>Пересчитать статусы и прогресс</strong><small>По имеющимся данным и текущим целевым значениям</small></span></label>
    {waitingLogin&&<p className="text-hint">Завершите вход в источник перед запуском обновления.</p>}{error&&<div className="error-inline" role="alert">{error}</div>}
    <div className="modal-footer"><button className="button secondary" onClick={onClose}>Отмена</button><button className="button primary" disabled={busy||!!loginBusy||waitingLogin||(!syncPublished&&!sourceIds.length&&!recalculate)} onClick={()=>void run()}><RefreshCw size={16} className={busy?'spinning':''}/>{busy?'Запуск…':'Начать обновление'}</button></div>
  </div></div>;
}
