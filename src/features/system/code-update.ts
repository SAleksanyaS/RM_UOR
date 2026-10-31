import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { mkdir, writeFile, readFile, unlink, realpath, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { safeArtifactPath } from '../../server/workspace/paths';
import { inspectCodeUpdate, readJsonFile, CodeUpdateError, type CodeUpdateConfig, type CodeUpdateResult, type WorkspaceReturn } from '../../../scripts/code-update-runtime.mjs';
import type { CodeUpdateLauncherPort } from './workbench/code-update-service';
import {createBackup,type BackupInfo} from './backup-service';
interface Launcher {pid:number;token:string;root:string;heartbeat:number;updating?:boolean}
/** The new factory supplies this lifecycle without constructing a legacy ApplicationContext. */
export interface WorkbenchCodeUpdateLifecycle {
 quiesce():Promise<void>;
 resume():Promise<void>;
 backupWorkspace():Promise<WorkspaceReturn>;
 restoreWorkspace(backupId:string):Promise<void>;
 activate():Promise<void>;
}
export function createCodeUpdateLauncherPort(projectRoot:string,config:CodeUpdateConfig):CodeUpdateLauncherPort {
 const paths=async()=>{const root=await realpath(projectRoot);const directory=await safeArtifactPath(root,'.runtime/code-update');return{root,directory};};
 const runner=async()=>{const{root,directory}=await paths();const value=await readJsonFile<Launcher>(await safeArtifactPath(root,'.runtime/code-update/launcher.json'));if(!value||value.root!==root||!Number.isInteger(value.pid)||typeof value.token!=='string'||Date.now()-value.heartbeat>15000)return null;try{process.kill(value.pid,0);}catch{return null;}return{...value,directory};};
 return {
  available:async()=>!!await runner(),
  async request(ticket){
   let startedWrite=false;
   try{
    z.strictObject({id:z.string().uuid(),expectedCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),targetCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)}).parse(ticket);
    const current=await runner();if(!current)throw new CodeUpdateError('launcher_unavailable','Не найден штатный запуск рабочего места','not_dispatched');
    const file=path.join(current.directory,'request.json'),existing=await readJsonFile<{id:string;token:string;expectedCommit:string;targetCommit:string}>(file);
    if(existing?.id===ticket.id&&existing.token===current.token&&existing.expectedCommit===ticket.expectedCommit&&existing.targetCommit===ticket.targetCommit)return;
    const active=await readJsonFile<{phase:string}>(path.join(current.directory,'active.json'));
    if(existing||current.updating||active&&!['completed','failed','rolled_back'].includes(active.phase))throw new CodeUpdateError('update_busy','Обновление уже выполняется','not_dispatched');
    await mkdir(current.directory,{recursive:true});
    const value={schemaVersion:1,...ticket,token:current.token,requestedAt:new Date().toISOString(),repositoryUrl:config.repositoryUrl,branch:config.publishedBranch};
    startedWrite=true;
    try{await writeFile(file,JSON.stringify(value),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new CodeUpdateError('update_busy','Заявка на обновление уже ожидает запуска','not_dispatched');throw error;}
   }catch(error){
    if(error instanceof CodeUpdateError&&error.dispatchState)throw error;
    throw new CodeUpdateError(startedWrite?'launcher_request_unknown':'launcher_request_rejected',startedWrite?'Исход записи заявки не подтверждён; требуется сверка':'Заявка не записана; повторите проверку запуска',startedWrite?'unknown':'not_dispatched');
   }
  },
  async observe(requestId){
   const{root,directory}=await paths();
   // Durable matching transactions are authoritative; status is only the latest display projection.
   let entries:import('node:fs').Dirent[];try{entries=await readdir(await safeArtifactPath(root,'.runtime/code-update/transactions'),{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;entries=[];}
   let found:CodeUpdateResult|null=null,matched=false;
   for(const entry of entries){
    if(!entry.isDirectory()||!/^[-a-f0-9]{36}$/.test(entry.name))continue;
    const journal=await readJsonFile<{schemaVersion:number;root:string;requestId:string;phase:string;expectedCommit:string;targetCommit:string;branch:string;committed?:boolean}>(await safeArtifactPath(root,`.runtime/code-update/transactions/${entry.name}/journal.json`));
    if(journal?.requestId!==requestId)continue;
    if(matched)throw new CodeUpdateError('RECOVERY_REQUIRED','Найдены несовместимые результаты одного обновления');matched=true;
    if(![2,3].includes(journal.schemaVersion)||journal.root!==root||!ticketSchema.safeParse({expectedCommit:journal.expectedCommit,targetCommit:journal.targetCommit}).success)throw new CodeUpdateError('RECOVERY_REQUIRED','Результат обновления несовместим или повреждён');
    if(['recovery_required','committed_unavailable'].includes(journal.phase))throw new CodeUpdateError('RECOVERY_REQUIRED','Требуется восстановление рабочего места');
    if(journal.phase==='failed')throw new CodeUpdateError('update_failed','Обновление не завершилось');
    if(!['completed','rolled_back'].includes(journal.phase))continue;
    const rolledBack=journal.phase==='rolled_back';found={currentCommit:rolledBack?journal.expectedCommit:journal.targetCommit,targetCommit:journal.targetCommit,branch:journal.branch,available:rolledBack,rolledBack};
   }
   if(matched)return found;
   const status=await readJsonFile<{requestId:string;phase:string;code?:string;result?:CodeUpdateResult}>(path.join(directory,'status.json'));
   if(status?.requestId!==requestId)return null;
   if(['recovery_required','committed_unavailable'].includes(status.phase))throw new CodeUpdateError('RECOVERY_REQUIRED','Требуется восстановление рабочего места; принятые данные сохранены');
   if(status.phase==='failed')throw new CodeUpdateError(status.code??'update_failed','Обновление не завершилось; проверьте локальную диагностику');
   return ['completed','rolled_back'].includes(status.phase)&&status.result?status.result:null;
  },
 };
}
const ticketSchema=z.object({expectedCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),targetCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)}).strict();
async function launcher(context:ApplicationContext){const result=await readJsonFile<Launcher>(await safeArtifactPath(context.paths.runtimeRoot,'code-update/launcher.json'));if(!result||result.root!==context.paths.projectRoot||!Number.isInteger(result.pid)||Date.now()-result.heartbeat>15000)return null;try{process.kill(result.pid,0);}catch{return null;}return result;}
const preparedContexts=new WeakMap<ApplicationContext,{requestId:string;cancelled:boolean;pending:boolean;backup?:BackupInfo}>();
export async function prepareLocalCodeUpdate(context:ApplicationContext,requestId:string){
 const existing=preparedContexts.get(context);if(existing?.requestId===requestId&&!existing.pending&&existing.backup)return{ok:true,databaseBackup:existing.backup};
 if(context.maintenance)return{ok:false,retryable:false,message:'Выполняется обслуживание рабочего места'};
 if(context.operations.list().some(operation=>operation.status==='running'))return{ok:false,retryable:false,message:'Дождитесь завершения рабочих операций и повторите обновление'};
 if(context.activeRequests>0)return{ok:false,retryable:true,message:'Завершаем текущий запрос'};
 const state={requestId,cancelled:false,pending:true} as {requestId:string;cancelled:boolean;pending:boolean;backup?:BackupInfo};preparedContexts.set(context,state);context.maintenance=true;
 try{state.backup=await createBackup(context.db,context.paths.runtimeRoot,'before_migration');state.pending=false;if(state.cancelled){context.maintenance=false;preparedContexts.delete(context);return{ok:false,retryable:false,message:'Подготовка обновления отменена'};}return{ok:true,databaseBackup:state.backup};}
 catch(error){context.maintenance=false;preparedContexts.delete(context);return{ok:false,retryable:false,message:(error as Error).message};}
}
export function releaseLocalCodeUpdate(context:ApplicationContext,requestId:string){const state=preparedContexts.get(context);if(state?.requestId===requestId){state.cancelled=true;if(!state.pending){context.maintenance=false;preparedContexts.delete(context);}}return{ok:true};}
const activatedContexts=new WeakSet<ApplicationContext>();
export async function activateLocalCodeUpdate(context:ApplicationContext,requestId:string){if(activatedContexts.has(context))return{ok:true};if(process.env.UOR_UPDATE_BOOTSTRAP!=='1')return{ok:false,retryable:false,message:'Запуск не находится в режиме подготовки'};const active=await readJsonFile<{phase:string;requestId:string}>(path.join(context.paths.runtimeRoot,'code-update/active.json'));if(active?.phase!=='committed'||active.requestId!==requestId)return{ok:false,retryable:false,message:'Подтверждённая версия обновления не найдена'};activatedContexts.add(context);context.maintenance=false;return{ok:true};}
export function registerCodeUpdateRoutes(app:FastifyInstance,context:ApplicationContext){
 app.addHook('onListen',async()=>{process.send?.({type:'uor.child-ready',bootstrap:process.env.UOR_UPDATE_BOOTSTRAP==='1',blocked:context.maintenance});});
 if(typeof process.send==='function'){
  const listener=async(raw:unknown)=>{if(!raw||typeof raw!=='object')return;const message=raw as {type?:string;id?:string;requestId?:string;token?:string};if(!['uor.prepare-code-update','uor.release-code-update','uor.activate-code-update'].includes(message.type??''))return;const runner=await launcher(context);if(!runner||runner.pid!==process.ppid||message.token!==runner.token||!z.string().uuid().safeParse(message.id).success||!z.string().uuid().safeParse(message.requestId).success)return;
   const result=message.type==='uor.activate-code-update'?await activateLocalCodeUpdate(context,message.requestId!):message.type==='uor.release-code-update'?releaseLocalCodeUpdate(context,message.requestId!):await prepareLocalCodeUpdate(context,message.requestId!);process.send?.({type:'uor.update-prepared',id:message.id,...result});};
  process.on('message',listener);app.addHook('onClose',async()=>{process.off('message',listener);});
 }

  app.get('/api/system/code-update',async request=>{
    const session=context.roles.get(request.cookies.uor_session);if(!session)throw new ActionError('Откройте рабочее место',401);
    const directory=await safeArtifactPath(context.paths.runtimeRoot,'code-update'),runner=await launcher(context),lastStatus=await readJsonFile(path.join(directory,'status.json')),active=await readJsonFile<{phase:string}>(path.join(directory,'active.json'));const updating=runner?.updating||active&&!['completed','failed','rolled_back','committed','committed_unavailable'].includes(active.phase);
    try{const preview=await inspectCodeUpdate(context.paths.projectRoot,context.config,{fetchRemote:true});return{...preview,launcherAvailable:!!runner,canRequest:!!runner&&!updating&&preview.available,lastStatus,message:updating?'Подготовка обновления выполняется; рабочая программа остаётся доступной до перезапуска':!runner?'Для обновления из приложения запустите npm run dev в этой папке':preview.available?'Доступна опубликованная версия кода':'Установлена опубликованная версия кода'};}
    catch(error){return{launcherAvailable:!!runner,canRequest:false,lastStatus,message:(error as Error).message};}
  });
  app.post('/api/system/code-update',async request=>{
    const session=context.roles.get(request.cookies.uor_session);if(!session)throw new ActionError('Откройте рабочее место',401);const input=ticketSchema.parse(request.body),runner=await launcher(context);
    if(!runner)throw new ActionError('Автоматический перезапуск доступен при запуске npm run dev. Запустите приложение штатным способом',409);
    const active=await readJsonFile<{phase:string}>(path.join(context.paths.runtimeRoot,'code-update/active.json'));if(runner.updating||active&&!['completed','failed','rolled_back','committed','committed_unavailable'].includes(active.phase))throw new ActionError('Обновление уже выполняется',409);
    if(context.maintenance||context.activeRequests>1||context.operations.list().some(op=>op.status==='running'))throw new ActionError('Дождитесь завершения других операций',409);
    await inspectCodeUpdate(context.paths.projectRoot,context.config,{fetchRemote:true,...input});
    if(context.maintenance||context.operations.list().some(op=>op.status==='running'))throw new ActionError('Началась другая операция. Повторите обновление',409);
    const directory=await safeArtifactPath(context.paths.runtimeRoot,'code-update');await mkdir(directory,{recursive:true});const id=randomUUID(),ticket={schemaVersion:1,id,...input,token:runner.token,requestedAt:new Date().toISOString(),repositoryUrl:context.config.repositoryUrl,branch:context.config.publishedBranch};
    try{await writeFile(path.join(directory,'request.json'),JSON.stringify(ticket),{flag:'wx',mode:0o600});}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new ActionError('Заявка на обновление уже ожидает перезапуска',409);throw error;}
    context.catalogs.recordChange(session,'code_update_requested',id,'Обновление программы',{},input);
    return{accepted:true,requestId:id,message:'Обновление принято. Сначала подготовятся новая версия и зависимости; текущее приложение продолжит работать. После проверки оно перезапустится.'};
  });
}
