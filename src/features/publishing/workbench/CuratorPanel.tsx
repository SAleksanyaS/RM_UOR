import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useGlobalContext, useWorkbench } from '../../../app/workbench/context';
import { WorkbenchApiError, type WorkbenchClient } from '../../../app/workbench/api-client';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { CommandRequest, CommandResult, GlobalContext, JobSnapshot } from '../../../server/workbench/protocol';
import { packagePreviewResultSchema, packageStatusResultSchema, type PackagePreviewResult, type PackageStatusResult } from './contracts';
import { PublishOperation, type PublishControl } from './PublishOperation';
import { PackageDiff, packageEntityLabels, packageDraftLabels } from './PackageDiff';
import { Plus, RefreshCw, Send, CheckCircle2 } from 'lucide-react';
import { WorkbenchGoalSetupWizard } from '../../goal-setup/workbench/GoalSetupWizard';
import type { EntityRef } from '../../../domain/workbench/primitives';
import './publishing.css';

type PackageRead=WorkbenchReadModels['uor.package'];
type Queue=WorkbenchReadModels['uor.queue'];
const request=(context:GlobalContext,filter:Record<string,unknown>={},cursor:string|null=null)=>({context,filter,sort:[],page:{limit:50,cursor}});
const clients=new WeakMap<WorkbenchClient,number>();let serial=0;
function clientKey(client:WorkbenchClient){if(!clients.has(client))clients.set(client,++serial);return clients.get(client)!;}
const busyJob=(job:JobSnapshot|null)=>!!job&&['queued','running'].includes(job.status);
// The native terminal can remain in flight while the server reports waiting_user.
// Only observe it here; returning from authentication never dispatches a retry.
const observeJob=(job:JobSnapshot|null)=>busyJob(job)||!!job&&job.status==='waiting_user'&&job.stage==='git.auth'&&!job.retryAvailable&&job.nextAction===null;
const unfinished=(job:JobSnapshot|null)=>!!job&&['queued','running','waiting_user','retry_wait','interrupted'].includes(job.status);
const stateLabels={draft:'Черновик',validating:'Проверяется',preview_ready:'Проверен',publishing:'Публикуется',open_pr:'PR открыт',needs_rework:'Нужна доработка',merged:'Принят',declined:'Отклонён'};
export function WorkbenchCuratorPanel(){
 const {client,session}=useWorkbench();const {context}=useGlobalContext();
 if(!session||!context)return <p>Выберите область и период.</p>;
 if(!session.allowedCommands.includes('package.preview'))return <p>Панель УОР доступна при действующем допуске куратора.</p>;
 return <CuratorPanel key={JSON.stringify([clientKey(client),session.personId,context])} context={context}/>;
}
function CuratorPanel({context}:{context:GlobalContext}){
 const {client,session,loading:checking}=useWorkbench();
 const [items,setItems]=useState<Queue['items']>([]),[cursor,setCursor]=useState<string|null>(null),[selected,setSelected]=useState(''),[pkg,setPackage]=useState<PackageRead|null>(null);
 const [job,setJob]=useState<JobSnapshot|null>(null),[preview,setPreview]=useState<{value:PackagePreviewResult;draftRevision:number;serverNow:number;receivedAt:number}|null>(null),[status,setStatus]=useState<PackageStatusResult|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null),[readError,setReadError]=useState<unknown>(null),[unknown,setUnknown]=useState(false),[tick,setTick]=useState(0);
 const [zone,setZone]=useState('all'),[queueLoading,setQueueLoading]=useState(true);
 const [setup,setSetup]=useState<{goalRef?:EntityRef}|null>(null);
 const returnFocus=useRef<HTMLElement|null>(null);
 useLayoutEffect(()=>{if(!busy&&returnFocus.current){const element=returnFocus.current;returnFocus.current=null;if(element.isConnected&&document.activeElement===document.body)element.focus();}},[busy]);
 const live=useRef(false),locked=useRef(false),permission=useRef(false),pending=useRef<CommandRequest|null>(null),selectedRef=useRef(''),previewDraft=useRef(0),jobKind=useRef(new Map<string,string>());
 selectedRef.current=selected;permission.current=!checking&&!!session?.allowedCommands.includes('package.preview');
 const current=(id:string)=>live.current&&selectedRef.current===id;
 const readPackage=async(id:string)=>{const response=await client.query<PackageRead>('uor.package',request(context,{packageRef:{entityType:'publication_package',id}}));if(current(id)){setPackage(response.data);setItems(previous=>previous.map(item=>item.packageRef.id===id?response.data.summary:item));setReadError(null);}return response;};
 const loadQueue=async(next:string|null)=>{
  setQueueLoading(true);
  try{const response=await client.query<Queue>('uor.queue',request(context,{},next));if(!live.current)return;setItems(previous=>next?[...new Map([...previous,...response.data.items].map(item=>[item.packageRef.id,item])).values()]:response.data.items);setCursor(response.data.page.nextCursor);if(!selectedRef.current&&response.data.items[0])setSelected(response.data.items[0].packageRef.id);setReadError(null);}catch(failure){if(live.current)setReadError(failure);}finally{if(live.current)setQueueLoading(false);}
 };
 useEffect(()=>{live.current=true;void loadQueue(null);return()=>{live.current=false;};},[client]);
 useEffect(()=>{setPackage(null);setPreview(null);setStatus(null);setJob(null);setError(null);pending.current=null;setUnknown(false);if(selected)void readPackage(selected).then(response=>{if(current(selected))setJob(response.data.summary.activeJob??response.data.summary.delivery?.job??null);},failure=>{if(current(selected))setReadError(failure);});},[selected]);
 useEffect(()=>{if(!preview)return;const timer=setInterval(()=>setTick(value=>value+1),1000);return()=>clearInterval(timer);},[preview]);
 const applyJob=async(value:JobSnapshot,id:string,serverNow:string)=>{
  if(!current(id))return;setJob(value);
  if(value.error?.code==='PREVIEW_STALE')setPreview(null);
  if(value.status==='succeeded'){
   if(jobKind.current.get(value.commandId)==='package.preview'){const parsed=packagePreviewResultSchema.safeParse(value.result);if(parsed.success)setPreview({value:parsed.data,draftRevision:previewDraft.current,serverNow:Date.parse(serverNow),receivedAt:Date.now()});else setError(Error('Ответ проверки пакета не распознан'));}
   if(jobKind.current.get(value.commandId)==='package.refreshStatus'){const parsed=packageStatusResultSchema.safeParse(value.result);if(parsed.success)setStatus(parsed.data);}
  }
  if(!busyJob(value))await readPackage(id);
 };
 useEffect(()=>{
  if(!job||!observeJob(job)||!selected)return;let active=true,timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{try{const response=await client.job(job.jobId);if(!active||!current(selected))return;await applyJob(response.data,selected,response.meta.generatedAt);if(active&&observeJob(response.data))timer=setTimeout(poll,300);}catch(failure){if(active&&current(selected)){setReadError(failure);}}};void poll();return()=>{active=false;if(timer)clearTimeout(timer);};
 },[job?.jobId,job?.status,job?.stage,job?.retryAvailable,selected]);
 const execute=async(name:string,payload:Record<string,unknown>,baseRevision:string|null=null)=>{
  if(locked.current||!permission.current||!pkg)return;const id=selected;
  if(pending.current&&(pending.current.name!==name||JSON.stringify(pending.current.payload)!==JSON.stringify(payload))){setError(Error('Сначала проверьте результат предыдущего действия'));return;}
  returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
  locked.current=true;setBusy(true);setError(null);
  const command=pending.current??{commandId:crypto.randomUUID(),name,payload,baseRevision};pending.current=command;
  if(name==='package.preview')previewDraft.current=pkg.summary.revision;
  jobKind.current.set(command.commandId,name);
  let accepted=false;
  try{
   const response=await client.command<CommandResult>(command);if(!current(id))return;
   accepted=true;
   const jobId='jobId'in response.data?response.data.jobId:typeof payload.jobId==='string'?payload.jobId:null;
   if(jobId){const observed=await client.job(jobId);if(current(id))await applyJob(observed.data,id,observed.meta.generatedAt);}else await readPackage(id);
   if(current(id)){pending.current=null;setUnknown(false);}
  }catch(failure){if(current(id)){
   const rejected=!accepted&&failure instanceof WorkbenchApiError&&[403,404,409,422].includes(failure.status)&&!['COMMAND_INTERRUPTED','REMOTE_STATE_UNKNOWN'].includes(failure.problem.code);
   if(rejected)pending.current=null;if(failure instanceof WorkbenchApiError&&failure.problem.code==='PREVIEW_STALE')setPreview(null);setUnknown(!rejected);setError(failure);
  }}finally{if(current(id)){locked.current=false;setBusy(false);}}
 };
 const control=(name:PublishControl,jobId:string)=>void execute(name,{jobId});
 const refresh=async()=>{if(!selected||busy)return;setBusy(true);try{const response=await readPackage(selected);if(current(selected)){const known=response.data.summary.activeJob??job??response.data.summary.delivery?.job??null;if(known){const observed=await client.job(known.jobId);if(current(selected))await applyJob(observed.data,selected,observed.meta.generatedAt);}setReadError(null);}}catch(failure){if(live.current)setReadError(failure);}finally{if(live.current)setBusy(false);}};
 const expired=preview?preview.serverNow+(Date.now()-preview.receivedAt)>=Date.parse(preview.value.expiresAt):false;
 void tick;
 const exact=!!preview&&!!pkg&&preview.draftRevision===pkg.summary.revision&&preview.value.packageRevision.contentHash===pkg.summary.publication?.current?.contentHash;
 const terminalPackage=!!pkg?.summary.publication&&['merged','declined'].includes(pkg.summary.publication.state);
 const canSubmit=!!preview&&exact&&!expired&&!preview.value.errors.length&&!preview.value.changes.some(change=>change.conflict)&&!!session?.allowedCommands.includes('package.submit')&&!unfinished(job)&&!terminalPackage&&pkg?.summary.publication?.sent?.contentHash!==preview.value.packageRevision.contentHash;
 const disabled=busy||checking||unknown;
 const zones=[...new Map(items.flatMap(item=>item.zones??[]).map(scope=>[scope.id,scope])).values()];
 const zoneId=zone==='context'?context.scopePath.teamId??context.scopePath.productId??context.scopePath.clusterId??context.scopePath.ditId:zone;
 const visibleItems=items.filter(item=>zone==='all'||item.zones?.some(scope=>scope.id===zoneId));
 const selectedOutside=!!selected&&!visibleItems.some(item=>item.packageRef.id===selected);
 return <><div className="wb-curator-panel" inert={setup?true:undefined}>
  <div className="wb-page-toolbar"><div><h2>Собственные пакеты изменений</h2><p className="wb-status-note">Изменения накапливаются в одном пакете за цикл: важное событие или 1–2 раза в неделю. Сохранение комментария не создаёт PR.</p></div><div className="wb-toolbar-actions"><button disabled={disabled||unfinished(job)||terminalPackage||!session?.allowedCommands.includes('goal.draft.save')} onClick={()=>{setPreview(null);setSetup({});}}><Plus size={16} aria-hidden="true" />Создать цель</button></div></div>
  {session?.policyState==='offline_cached'&&<p role="status">Без связи: личные черновики доступны. Для отправки нужна свежая проверка допуска.</p>}
  {checking&&<p role="status">Проверяем доступ…</p>}
  {readError!==null&&<p role="alert">{workbenchErrorMessage(readError,'read')}</p>}
  {error!==null&&<div role="alert"><p>{workbenchErrorMessage(error)}</p>{error instanceof WorkbenchApiError&&<p>{error.problem.code}: {error.problem.message}</p>}</div>}
  {unknown&&<p>Результат запроса не подтверждён. Повторная проверка использует тот же идентификатор операции.</p>}
  {unknown&&pending.current&&<button disabled={busy||checking} onClick={()=>{const value=pending.current!;void execute(value.name,value.payload,value.baseRevision);}}>Проверить результат запроса</button>}
  <div className="wb-page-toolbar"><label className="wb-field"><span>Зона просмотра</span><select aria-label="Зона просмотра" value={zone} onChange={event=>setZone(event.target.value)}><option value="all">Все области</option><option value="context">Выбранная область</option>{zones.map(scope=><option key={scope.id} value={scope.id}>{scope.name??'Область без названия'}</option>)}</select></label></div><p className="wb-status-note">Фильтр меняет только просмотр. Проверяется и отправляется весь пакет.</p>
  <div className="wb-publishing-actions"><label className="wb-field"><span>Собственные пакеты</span><select aria-label="Собственные пакеты" value={selected} disabled={disabled||busyJob(job)} onChange={event=>setSelected(event.target.value)}><option value="">Выберите пакет</option>{selectedOutside&&<option value={selected}>Текущий пакет вне фильтра</option>}{visibleItems.map(item=><option value={item.packageRef.id} key={item.packageRef.id}>Пакет {items.indexOf(item)+1} · {item.publication?(stateLabels[item.publication.state]??`Неизвестное состояние: ${item.publication.state}`):'Черновик'}</option>)}</select></label>{cursor&&<button disabled={disabled} onClick={()=>void loadQueue(cursor)}>Показать ещё пакеты</button>}<button disabled={disabled||!selected} onClick={()=>void refresh()}><RefreshCw size={16} aria-hidden="true" />Обновить состояние пакета</button></div>
  {zone!=='all'&&!visibleItems.length&&<p>Среди загруженных пакетов нет явно связанных с этой областью. {cursor?'Загрузите следующую страницу.':''}</p>}
  {queueLoading&&!items.length&&<p role="status">Загружаем собственные пакеты…</p>}
  {!queueLoading&&!items.length&&!readError&&<p>Накопленных пакетов пока нет. Сохраните изменения в карточке цели или в исполнении.</p>}
  {pkg&&<><section className="wb-surface wb-package-summary"><header className="wb-section-header"><div><span className="wb-eyebrow">Личные изменения до принятия</span><h2>Накопленный пакет</h2></div><span className="wb-badge wb-badge-neutral">{pkg.summary.publication ? stateLabels[pkg.summary.publication.state] ?? `Неизвестное состояние: ${pkg.summary.publication.state}` : 'Черновик'}</span></header><div className="wb-package-counts"><span>Редакция черновика <strong>{pkg.summary.revision}</strong></span><span>Объектов <strong>{pkg.entries.length}</strong></span><span>Незавершённых <strong>{pkg.summary.incomplete}</strong></span></div>
   {pkg.summary.retainedDelivery&&<p role="status">В копии сохранена подготовка отправки: коммит {pkg.summary.retainedDelivery.preparedCommit.slice(0,12)}. Перед продолжением заново проверьте пакет и состояние PR. Сохранённая подготовка требует сверки с сервером; её наличие не подтверждает отправку.</p>}
   {selectedOutside&&<p>Открытый пакет сохранён на экране, но не входит в выбранный фильтр.</p>}
   <div className="wb-table-scroll" role="region" aria-label="Объекты пакета" tabIndex={0}><table className="wb-data-table"><thead><tr><th scope="col">Объект</th><th scope="col">Готовность</th><th scope="col">Действие</th></tr></thead><tbody>{pkg.entries.map(entry=><tr key={entry.draftId}><td><span className="wb-eyebrow">{packageEntityLabels[entry.entityRef.entityType]??`Неизвестный объект: ${entry.entityRef.entityType}`}</span><strong>{String(entry.definition.title??entry.definition.name??entry.definition.request??entry.definition.text??'Изменённый объект')}</strong>{entry.definition.description?<p className="wb-cell-note">{String(entry.definition.description)}</p>:null}</td><td><span className={'wb-badge wb-badge-'+(entry.complete?'success':'confirmation')}>{entry.complete?'Поля заполнены':'Требует заполнения'}</span>{entry.problems.length>0&&<ul>{entry.problems.map((problem,index)=><li key={index}>{problem.message}</li>)}</ul>}</td><td>{entry.entityRef.entityType==='core_goal_definition'&&<button disabled={disabled||unfinished(job)||terminalPackage} onClick={()=>{setPreview(null);setSetup({goalRef:entry.entityRef});}} aria-label={'Продолжить настройку: '+String(entry.definition.title??'Незавершённая цель')}>Продолжить настройку</button>}</td></tr>)}</tbody></table></div></section>
   <div className="wb-publishing-actions"><button className={!canSubmit ? "wb-primary-button" : undefined} disabled={disabled||unfinished(job)||terminalPackage} onClick={()=>void execute('package.preview',{packageId:selected},pkg.summary.editToken)}><CheckCircle2 size={16} aria-hidden="true" />Проверить пакет</button><button className={canSubmit ? "wb-primary-button" : undefined} disabled={disabled||!canSubmit} onClick={()=>void execute('package.submit',{packageId:selected,previewToken:preview!.value.previewToken})}><Send size={16} aria-hidden="true" />Отправить пакет в Bitbucket</button>{(pkg.summary.publication?.proposal||pkg.summary.delivery)&&<button disabled={disabled||busyJob(job)} onClick={()=>void execute('package.refreshStatus',{packageId:selected})}>Проверить состояние PR</button>}</div>
   {!preview && !terminalPackage && <p className="wb-status-note">Перед отправкой проверьте весь пакет. Проверка покажет точные изменения, конфликты и влияние на расчёты.</p>}
   {preview&&<section className="wb-package-preview" aria-label="Предварительный просмотр"><h2>Предварительный просмотр · редакция {preview.value.packageRevision.revision}</h2><p>Основание main: {preview.value.packageRevision.baseCommit.slice(0,12)} · действителен до {new Date(preview.value.expiresAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</p>{(!exact||expired)&&<p role="alert">Предварительный просмотр устарел. Проверьте пакет заново.</p>}{preview.value.errors.map((problem,index)=><p role="alert" key={index}>{problem.code}: {problem.message}</p>)}{preview.value.warnings.map((warning,index)=><p key={index}>{warning.code==='NEEDS_CALCULATION'?'Перед подтверждением результата нужен расчёт по актуальному основанию.':warning.message}</p>)}<PackageDiff changes={preview.value.changes} labels={packageDraftLabels(pkg.entries)}/></section>}
   <PublishOperation publication={pkg.summary.publication} delivery={pkg.summary.delivery} job={job} onControl={control} busy={disabled}/>
   {status?.comments.length?<section className="wb-surface wb-object-content" aria-label="Замечания к PR"><h3>Замечания к PR</h3>{status.comments.map(comment=><article key={comment.id}><p>{comment.authorDisplayName}: {comment.text}</p>{comment.requiresRework&&<p>Требует доработки</p>}</article>)}</section>:null}
  </>}
 </div>{setup&&<WorkbenchGoalSetupWizard goalRef={setup.goalRef} packageRef={selected?{entityType:'publication_package',id:selected}:undefined} onClose={()=>{setSetup(null);void loadQueue(null);if(selected)void readPackage(selected).catch(failure=>{if(live.current)setReadError(failure);});}}/>}</>;
}
