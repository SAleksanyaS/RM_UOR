import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { safeArtifactPath } from '../../server/workspace/paths';
import { inspectCodeUpdate, readJsonFile } from '../../../scripts/code-update-runtime.mjs';
interface Launcher {pid:number;token:string;root:string;heartbeat:number}
const ticketSchema=z.object({expectedCommit:z.string().regex(/^[a-f0-9]{40,64}$/),targetCommit:z.string().regex(/^[a-f0-9]{40,64}$/)}).strict();
async function launcher(context:ApplicationContext){const result=await readJsonFile<Launcher>(await safeArtifactPath(context.paths.runtimeRoot,'code-update/launcher.json'));if(!result||result.root!==context.paths.projectRoot||!Number.isInteger(result.pid)||Date.now()-result.heartbeat>15000)return null;try{process.kill(result.pid,0);}catch{return null;}return result;}
export function registerCodeUpdateRoutes(app:FastifyInstance,context:ApplicationContext){
  app.get('/api/system/code-update',async request=>{
    const session=context.roles.get(request.cookies.uor_session);if(!session)throw new ActionError('Откройте рабочее место',401);
    const directory=await safeArtifactPath(context.paths.runtimeRoot,'code-update'),runner=await launcher(context),lastStatus=await readJsonFile(path.join(directory,'status.json'));
    try{const preview=await inspectCodeUpdate(context.paths.projectRoot,context.config,{fetchRemote:true});return{...preview,launcherAvailable:!!runner,canRequest:!!runner&&preview.available,lastStatus,message:!runner?'Для обновления из приложения запустите npm run dev в этой папке':preview.available?'Доступна опубликованная версия кода':'Установлена опубликованная версия кода'};}
    catch(error){return{launcherAvailable:!!runner,canRequest:false,lastStatus,message:(error as Error).message};}
  });
  app.post('/api/system/code-update',async request=>{
    const session=context.roles.get(request.cookies.uor_session);if(!session)throw new ActionError('Откройте рабочее место',401);const input=ticketSchema.parse(request.body),runner=await launcher(context);
    if(!runner)throw new ActionError('Автоматический перезапуск доступен при запуске npm run dev. Запустите приложение штатным способом',409);
    if(context.maintenance||context.activeRequests>1||context.operations.list().some(op=>op.status==='running'))throw new ActionError('Дождитесь завершения других операций',409);
    await inspectCodeUpdate(context.paths.projectRoot,context.config,{fetchRemote:true,...input});
    if(context.maintenance||context.operations.list().some(op=>op.status==='running'))throw new ActionError('Началась другая операция. Повторите обновление',409);
    const directory=await safeArtifactPath(context.paths.runtimeRoot,'code-update');await mkdir(directory,{recursive:true});const id=randomUUID(),ticket={schemaVersion:1,id,...input,token:runner.token,requestedAt:new Date().toISOString(),repositoryUrl:context.config.repositoryUrl,branch:context.config.publishedBranch};
    context.maintenance=true;
    try{await writeFile(path.join(directory,'request.json'),JSON.stringify(ticket),{flag:'wx',mode:0o600});}
    catch(error){context.maintenance=false;if((error as NodeJS.ErrnoException).code==='EEXIST')throw new ActionError('Заявка на обновление уже ожидает перезапуска',409);throw error;}
    context.catalogs.recordChange(session,'code_update_requested',id,'Обновление программы',{},input);
    return{accepted:true,requestId:id,message:'Обновление принято. Приложение завершит операции, обновит код и зависимости, затем перезапустится. Подождите и обновите страницу.'};
  });
}
