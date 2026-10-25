import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { safeArtifactPath } from '../../server/workspace/paths';
import { inspectCodeUpdate, readJsonFile } from '../../../scripts/code-update-runtime.mjs';
import {createBackup,type BackupInfo} from './backup-service';
interface Launcher {pid:number;token:string;root:string;heartbeat:number;updating?:boolean}
const ticketSchema=z.object({expectedCommit:z.string().regex(/^[a-f0-9]{40,64}$/),targetCommit:z.string().regex(/^[a-f0-9]{40,64}$/)}).strict();
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
