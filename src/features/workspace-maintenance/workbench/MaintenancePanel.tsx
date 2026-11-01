import { useEffect,useRef,useState } from 'react';
import { useWorkbench } from '../../../app/workbench/context';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import type { CommandResult,JobSnapshot,OwnQueryRequest } from '../../../server/workbench/protocol';
import { backupCreateResultSchema,restoreApplyResultSchema,restorePreviewResultSchema,type RestorePreviewResult } from './contracts';
import { publicationCheckResultSchema,publicationApplyResultSchema,type PublicationCheckResult } from '../../publishing/workbench/contracts';
import type { BackupsRead } from './maintenance-query';
import { RestorePreview } from './RestorePreview';
import './maintenance.css';

type Operation={commandId:string;name:string;jobId:string|null};
const own:OwnQueryRequest={context:null,filter:{},sort:[],page:{limit:50,cursor:null}};
const terminal=new Set(['succeeded','partial','failed','cancelled','interrupted']);
const backupUrl=(id:string)=>'/api/v1/backups/'+encodeURIComponent(id)+'/file';
const errorText=(code:string,message:string)=>code==='PREVIEW_STALE'?'Данные изменились. Выполните новый предпросмотр перед заменой.':code==='RECOVERY_REQUIRED'?'Запись заблокирована: требуется безопасное восстановление. Перезапустите приложение для проверки журнала восстановления. Если блокировка сохраняется, передайте сопровождающему код RECOVERY_REQUIRED; защитная копия остаётся доступна.':message+' ('+code+')';

export function MaintenancePanel({onClose}:{onClose():void}) {
 const {client,session,loading}=useWorkbench();
 const [file,setFile]=useState<File|null>(null),[handle,setHandle]=useState<string|null>(null),[preview,setPreview]=useState<RestorePreviewResult|null>(null),[confirmed,setConfirmed]=useState(false),[partial,setPartial]=useState(false);
 const [operation,setOperation]=useState<Operation|null>(null),[job,setJob]=useState<JobSnapshot|null>(null),[check,setCheck]=useState<PublicationCheckResult|null>(null),[error,setError]=useState<string|null>(null),[recovery,setRecovery]=useState(false),[sending,setSending]=useState(false);
 const [backups,setBackups]=useState<BackupsRead|null>(null),[listError,setListError]=useState(false);
 const [pollRevision,setPollRevision]=useState(0),[pollError,setPollError]=useState(false),[readingJob,setReadingJob]=useState(false);
 const dialog=useRef<HTMLDivElement>(null),close=useRef<HTMLButtonElement>(null),alive=useRef(0),handled=useRef('');
 const storageKey='uor.maintenance.operation.'+(session?.personId??'installation');
 const active=!!operation&&(!job||!terminal.has(job.status));
 const blocked=loading||!session||sending||active||recovery;
 const allowed=(name:string)=>!!session?.allowedCommands.includes(name);
 const remember=(value:Operation)=>{setOperation(value);try{sessionStorage.setItem(storageKey,JSON.stringify(value));}catch{/* Current tab remains authoritative if storage is unavailable. */}};
 function fail(value:unknown){if(value instanceof WorkbenchApiError){setError(errorText(value.problem.code,value.problem.message));if(value.problem.code==='RECOVERY_REQUIRED')setRecovery(true);}else setError('Результат операции неизвестен. Проверьте сохранённую операцию; повторная замена не отправляется.');}
 async function list(cursor:string|null=null){const generation=alive.current;try{const response=await client.query<BackupsRead>('backups.list',{...own,page:{limit:50,cursor}});if(generation===alive.current){setBackups(previous=>cursor&&previous?{...response.data,items:[...previous.items,...response.data.items]}:response.data);setListError(false);}}catch{if(generation===alive.current)setListError(true);}}
 useEffect(()=>{close.current?.focus();},[]);
 useEffect(()=>{
  const generation=++alive.current;handled.current='';setOperation(null);setJob(null);setCheck(null);setError(null);setRecovery(false);setSending(false);setFile(null);setHandle(null);setPreview(null);setConfirmed(false);setBackups(null);setPollError(false);setReadingJob(false);
  if(session){try{const saved=JSON.parse(sessionStorage.getItem(storageKey)??'null') as Operation|null;if(saved&&/^[a-f0-9-]{36}$/.test(saved.commandId)&&['backup.create','backup.restore.preview','backup.restore.apply','publication.check','publication.apply'].includes(saved.name)&&(saved.jobId===null||/^[a-f0-9-]{36}$/.test(saved.jobId)))setOperation(saved);}catch{/* Malformed local hints never authorize a command. */}void list();}
  return()=>{if(alive.current===generation)alive.current++;};
 },[client,session?.personId,!!session]);
 useEffect(()=>{
  if(!operation?.jobId||!session)return;let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;const generation=alive.current;
  const poll=async()=>{setReadingJob(true);try{const response=await client.job(operation.jobId!);if(stopped||generation!==alive.current)return;if(response.data.commandId!==operation.commandId)throw Error('Operation identity mismatch');setPollError(false);setJob(response.data);if(!terminal.has(response.data.status))timer=setTimeout(()=>void poll(),1000);}catch{if(!stopped&&generation===alive.current)setPollError(true);}finally{if(!stopped&&generation===alive.current)setReadingJob(false);}};
  void poll();return()=>{stopped=true;clearTimeout(timer);};
 },[client,operation?.jobId,operation?.commandId,session,pollRevision]);
 useEffect(()=>{
  if(!job||!operation||!terminal.has(job.status)||handled.current===job.jobId)return;handled.current=job.jobId;
  if(job.status==='failed'){const code=job.error!.code;setError(errorText(code,job.error!.message));if(code==='PREVIEW_STALE'){setPreview(null);setConfirmed(false);setCheck(null);}if(code==='RECOVERY_REQUIRED')setRecovery(true);return;}
  if(!['succeeded','partial'].includes(job.status))return;
  try {
   if(operation.name==='backup.restore.preview'){setPreview(restorePreviewResultSchema.parse(job.result));setConfirmed(false);}
   if(operation.name==='publication.check')setCheck(publicationCheckResultSchema.parse(job.result));
   if(operation.name==='publication.apply'){publicationApplyResultSchema.parse(job.result);setCheck(null);}
   if(operation.name==='backup.restore.apply'){restoreApplyResultSchema.parse(job.result);setPreview(null);setConfirmed(false);}
   if(operation.name==='backup.create')backupCreateResultSchema.parse(job.result);
   if(['backup.create','backup.restore.apply'].includes(operation.name))void list();
  }catch{setError('Некорректный результат сервера. Успех операции не подтверждён.');}
 },[job,operation]);
 async function run(name:string,payload:Record<string,unknown>){
  if(blocked||!allowed(name))return;const generation=alive.current,id=crypto.randomUUID(),pending={commandId:id,name,jobId:null};setSending(true);setError(null);setPollError(false);setJob(null);handled.current='';remember(pending);
  try{const response=await client.command<CommandResult>({commandId:id,name,baseRevision:null,payload});if(generation!==alive.current)return;if(!('jobId'in response.data))throw Error('Expected asynchronous receipt');remember({...pending,jobId:response.data.jobId});}
  catch(failure){if(generation===alive.current){fail(failure);if(failure instanceof WorkbenchApiError&&failure.status<500&&failure.problem.code!=='INVALID_RESPONSE'){setOperation(null);sessionStorage.removeItem(storageKey);}}}
  finally{if(generation===alive.current)setSending(false);}
 }
 async function inspect(){if(blocked||!file||!allowed('backup.restore.preview'))return;const generation=alive.current;let fileHandle=handle;setError(null);setPreview(null);setConfirmed(false);if(!fileHandle){setSending(true);try{fileHandle=(await client.upload(file,'workspace-restore')).data.fileHandle;if(generation!==alive.current)return;setHandle(fileHandle);}catch(failure){if(generation===alive.current)fail(failure);return;}finally{if(generation===alive.current)setSending(false);}}if(generation===alive.current)await run('backup.restore.preview',{fileHandle});}
 async function reconcile(){if(!operation||sending)return;const generation=alive.current;setSending(true);try{const response=await client.reconcileCommand(operation.commandId);if(generation!==alive.current)return;if(response.data.name!==operation.name||!response.data.job){setError('Операция ещё не подтверждена. Повторная замена не отправляется; проверьте журнал восстановления.');return;}setError(null);remember({...operation,jobId:response.data.job.jobId});}catch(failure){if(generation===alive.current)fail(failure);}finally{if(generation===alive.current)setSending(false);}}
 const success=job&&['succeeded','partial'].includes(job.status);
 const restored=success&&operation?.name==='backup.restore.apply'?restoreApplyResultSchema.safeParse(job.result):null;
 const backup=success&&operation?.name==='backup.create'?backupCreateResultSchema.safeParse(job.result):null;
 const applied=success&&operation?.name==='publication.apply'?publicationApplyResultSchema.safeParse(job.result):null;
 return <div className="wb-maintenance-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="wb-maintenance-title" className="wb-maintenance" ref={dialog} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onClose();}if(event.key==='Tab'){const elements=[...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),summary')];const first=elements[0],last=elements.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
  <header><h2 id="wb-maintenance-title">Обслуживание рабочего места</h2><button ref={close} type="button" onClick={onClose}>Закрыть обслуживание</button></header>
  <p>Архив переносит данные. Вход, роль, cookies и настройки подключения не переносятся; после восстановления допуск проверяется заново.</p>
  {error&&<p role="alert">{error}</p>}
  {pollError&&<p role="alert">Не удалось прочитать состояние операции. Обновите состояние операции, чтобы проверить результат. Повторная команда не отправляется.</p>}
  {operation?.jobId&&<button type="button" disabled={readingJob||loading||!session} onClick={()=>setPollRevision(value=>value+1)}>Обновить состояние операции</button>}
  {operation&&!operation.jobId&&<button type="button" disabled={sending} onClick={()=>void reconcile()}>Проверить сохранённую операцию</button>}
  {operation&&<section aria-label="Сохранённая операция"><p>Операция: {operation.jobId??operation.commandId}</p>{!operation.jobId&&<p role="status">Ответ ещё не подтверждён. Не запускайте повторную замену.</p>}{job&&<><p role="status">{job.status==='queued'?'Операция в очереди':job.status==='running'?'Операция выполняется':job.status==='interrupted'?'Операция прервана. Сверьте журнал восстановления перед продолжением.':job.status==='cancelled'?'Операция отменена':'Состояние операции сохранено'}</p>{!terminal.has(job.status)&&<progress aria-label="Ход обслуживания" max={job.progress.total??1} value={job.progress.total===null?undefined:job.progress.completed}/ >}{job.warnings.map((warning,index)=><p key={index}>{warning.message}</p>)}{job.cancelAvailable&&<button type="button" onClick={()=>{void client.command({commandId:crypto.randomUUID(),name:'job.cancel',baseRevision:null,payload:{jobId:job.jobId}}).catch(fail);}}>Отменить операцию</button>}</>}</section>}
  {restored?.success&&<section role="status"><h3>Восстановление завершено</h3><p>Проверьте допуск и текущее рабочее место после восстановления.</p>{restored.data.rescue.status==='created'&&<a href={backupUrl(restored.data.rescue.backupId)}>Скачать защитную копию</a>}</section>}
  {backup?.success&&<section role="status"><h3>Копия создана</h3><a href={backupUrl(backup.data.backupId)}>Скачать созданную копию</a>{backup.data.omissions.includes('originals')&&<p>В архив не включены исходные файлы</p>}<p>Не включено: {backup.data.omissions.join(', ')}</p></section>}
  {applied?.success&&<section role="status"><h3>Проверенный main применён</h3><p>Коммит: {applied.data.appliedCommit}</p>{applied.data.anchors.length===0||applied.data.anchors.some(anchor=>anchor.mergedAt===null)?<p>Дата принятия в Bitbucket неизвестна</p>:null}{applied.data.warnings.map((warning,index)=><p key={index}>{warning.message}</p>)}</section>}
  <section className="wb-maintenance-card"><h3>Обновление общих данных</h3><p>Применение проверенного main сохраняет личные настройки и историю.</p><button type="button" disabled={blocked||!allowed('publication.check')} onClick={()=>void run('publication.check',{})}>Проверить обновление main</button>{check&&<><p>Текущий коммит: {check.currentCommit??'ещё не применён'}</p><p>Доступный коммит: {check.availableCommit??'нет'}</p>{check.warnings.map((warning,index)=><p key={index}>{warning.message}</p>)}{check.available&&check.availableCommit?<button type="button" disabled={blocked||!allowed('publication.apply')} onClick={()=>void run('publication.apply',{mainCommit:check.availableCommit})}>Применить проверенный main</button>:<p>Новых данных main нет</p>}</>}</section>
  <section className="wb-maintenance-card"><h3>Копия и перенос</h3><p>Обычная копия включает исходные файлы.</p><label><input type="checkbox" checked={partial} disabled={blocked} onChange={event=>setPartial(event.target.checked)}/> Создать неполную копию без исходных файлов</label>{partial&&<p role="status">Исходные файлы не войдут в архив. Такая копия неполная и не подходит для полного переноса.</p>}<button type="button" disabled={blocked||!allowed('backup.create')} onClick={()=>void run('backup.create',{label:null,includeOriginals:!partial})}>Создать копию</button></section>
  <section className="wb-maintenance-card"><h3>Восстановить из архива</h3><label>Архив рабочего места<input type="file" accept=".zip,application/zip" disabled={blocked} onChange={event=>{setFile(event.target.files?.[0]??null);setHandle(null);setPreview(null);setConfirmed(false);setError(null);}}/></label>{file&&<p>{file.name}</p>}<button type="button" disabled={blocked||!file||!allowed('backup.restore.preview')} onClick={()=>void inspect()}>Проверить архив</button>{preview&&<RestorePreview preview={preview} confirmed={confirmed} onConfirm={setConfirmed} disabled={blocked||!allowed('backup.restore.apply')} onApply={()=>void run('backup.restore.apply',{restoreToken:preview.restoreToken,confirmReplacement:true})}/>}</section>
  <section className="wb-maintenance-card"><h3>Сохранённые копии</h3>{listError&&<p role="alert">Не удалось получить список копий. <button type="button" onClick={()=>void list()}>Обновить список копий</button></p>}{backups?.items.length===0&&<p>Сохранённых копий нет</p>}<ul>{backups?.items.map(item=><li key={item.backupId}><a href={backupUrl(item.backupId)}>{item.rescue?'Защитная копия':'Копия'} · {new Date(item.createdAt).toLocaleString('ru-RU')}</a>{item.omissions.includes('originals')&&<span> · без исходных файлов</span>}</li>)}</ul>{backups?.page.hasMore&&<button type="button" onClick={()=>void list(backups.page.nextCursor)}>Показать ещё копии</button>}</section>
 </div></div>;
}
