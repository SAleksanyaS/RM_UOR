import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { safeArtifactPath } from '../../server/workspace/paths';
import type { ApplicationContext } from '../../server/workspace/context';
import type { Session } from '../../domain/contracts';
import { collectionSchema, ConnectorError, scenarioSchema } from './contracts';
import { readPrivateProfiles, savePrivateProfile } from './private-config';
import { collectConfiguredSource } from './service';
import { loadProfile } from './transport';
import { startRecording, finishRecording, stopAllRecordings } from './browser';
import { createConnectorScheduler } from './scheduler';
export { createConnectorScheduler } from './scheduler';
export function registerConnectorRoutes(app:FastifyInstance,context:ApplicationContext){
  const session=(request:FastifyRequest)=>{const result=context.roles.get(request.cookies.uor_session);if(!result)throw new ConnectorError('access_denied','Сначала откройте рабочее место');return result;};
  const scheduler=createConnectorScheduler(context);
  const beginBrowser=async(owner:Session,source:{collection?:{authProfileId:string}},url:string,observe:boolean,selector?:string)=>{
    if(!source.collection)throw new ConnectorError('configuration_required','Сначала настройте источник');
    const profile=await loadProfile(context.paths.runtimeRoot,source.collection.authProfileId),operation=await context.operations.start('check',observe?'Запись действий в браузере':'Ручной вход в источник'),controller=new AbortController();context.cancelled.set(operation.id,controller);context.db.set('operation-owners',operation.id,owner.id);
    try{const result=await startRecording(context.paths.runtimeRoot,owner.id,profile,url,observe,selector,()=>{void context.operations.finish(operation.id,{status:controller.signal.aborted?'cancelled':'completed',message:'Окно браузера закрыто. Получение фактов выполняется отдельной проверкой.'}).finally(()=>context.cancelled.delete(operation.id));});context.db.set('connector-recording-operations',result.recordingId,{operationId:operation.id,ownerSessionId:owner.id});const close=()=>{void finishRecording(context.paths.runtimeRoot,owner.id,result.recordingId,false).catch(()=>{});};controller.signal.addEventListener('abort',close,{once:true});if(controller.signal.aborted)close();return{...result,operationId:operation.id};}
    catch(error){context.cancelled.delete(operation.id);await context.operations.finish(operation.id,{status:'failed',message:(error as Error).message});throw error;}
  };
  app.addHook('preClose',async()=>{scheduler.stop();await stopAllRecordings();await scheduler.idle();});
  app.get('/api/connectors',async request=>{const owner=session(request);return {diagnostics:context.db.list<{sourceId:string;ownerSessionId:string}>('connector-diagnostics').filter(value=>value.ownerSessionId===owner.id),schedules:scheduler.list(owner),configFile:'.runtime/local-config/connectors.json'};});
  app.get('/api/connectors/profiles',async request=>{session(request);return readPrivateProfiles(context.paths.runtimeRoot);});
  app.post<{Params:{id:string}}>('/api/connectors/profiles/:id',async request=>{session(request);const input=z.object({profile:z.unknown(),expectedRevision:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict().parse(request.body);return savePrivateProfile(context.paths.runtimeRoot,request.params.id,input.profile,input.expectedRevision);});
  app.post<{Params:{id:string}}>('/api/connectors/:id/configure',async request=>{
    const owner=await context.roles.requireCurator(request.cookies.uor_session??''), config=collectionSchema.parse(request.body);
    const catalog=await context.catalogs.readForSession(owner);if(!catalog.sources.some(s=>s.id===request.params.id))throw new ConnectorError('configuration_required','Источник не найден');
    return context.catalogs.saveDraft(owner,{kind:'source',id:request.params.id,baseRevision:null,patch:{collection:config,mode:'local'}});
  });
  app.post<{Params:{id:string}}>('/api/connectors/:id/test',async request=>{
    const owner=session(request), controller=new AbortController(), operation=await context.operations.start('check','Проверка реального получения данных');context.cancelled.set(operation.id,controller);
    context.db.set('operation-owners',operation.id,owner.id);
    try{const result=await collectConfiguredSource(context,owner,request.params.id,controller.signal,stage=>{void context.operations.stage(operation.id,stage);});await context.operations.finish(operation.id,{status:'completed',message:result.duplicate?'Идентичный личный срез уже сохранён':'Реальная выгрузка проверена; личный срез сохранён'});return {operationId:operation.id,snapshotIds:result.snapshots.map(s=>s.id),duplicate:result.duplicate};}
    catch(e){await context.operations.finish(operation.id,{status:controller.signal.aborted?'cancelled':'failed',message:(e as Error).message});throw e;}finally{context.cancelled.delete(operation.id);}
  });
  app.post<{Params:{id:string}}>('/api/connectors/:id/record',async request=>{
    const owner=await context.roles.requireCurator(request.cookies.uor_session??''),source=(await context.catalogs.readForSession(owner)).sources.find(s=>s.id===request.params.id),input=z.object({startUrl:z.string().url().optional(),authenticatedSelector:z.string().max(1000).optional()}).parse(request.body??{});
    if(!source?.collection)throw new ConnectorError('configuration_required','Сначала сохраните профиль доступа источника');
    const startUrl=input.startUrl??source.url??source.collection.endpoint;
    if(!startUrl)throw new ConnectorError('configuration_required','Укажите URL начала записи');return beginBrowser(owner,source,startUrl,true,input.authenticatedSelector??source.collection.authenticatedSelector);
  });
  app.post('/api/connectors/recording/finish',async request=>{const owner=await context.roles.requireCurator(request.cookies.uor_session??''),input=z.object({recordingId:z.string().uuid(),save:z.boolean()}).parse(request.body);return finishRecording(context.paths.runtimeRoot,owner.id,input.recordingId,input.save);});
  app.post<{Params:{id:string}}>('/api/connectors/:id/login',async request=>{const owner=session(request),source=(await context.catalogs.readForSession(owner)).sources.find(s=>s.id===request.params.id);if(!source?.collection)throw new ConnectorError('configuration_required','Сначала настройте источник');const startUrl=source.collection.scenario?.startUrl??source.url;if(!startUrl)throw new ConnectorError('configuration_required','Не задан адрес ручного входа');return beginBrowser(owner,source,startUrl,false);});
  app.post('/api/connectors/login/finish',async request=>{const owner=session(request),input=z.object({recordingId:z.string().uuid()}).parse(request.body);return finishRecording(context.paths.runtimeRoot,owner.id,input.recordingId,false);});
  app.post<{Params:{id:string}}>('/api/connectors/:id/schedule',async request=>{const owner=session(request),input=z.object({intervalMinutes:z.number().int().min(1).max(43200).nullable()}).parse(request.body);if(input.intervalMinutes===null){scheduler.remove(owner,request.params.id);return {enabled:false};}return scheduler.register(owner,request.params.id,input.intervalMinutes*60000);});
  app.post('/api/connectors/scenario/validate',async request=>{await context.roles.requireCurator(request.cookies.uor_session??'');return scenarioSchema.parse(request.body);});
  app.get<{Params:{id:string;index:string}}>('/api/connectors/recordings/:id/screenshots/:index',async(request,reply)=>{const owner=session(request),id=z.string().uuid().parse(request.params.id),index=z.string().regex(/^[1-9][0-9]{0,2}$/).parse(request.params.index),manifestPath=await safeArtifactPath(context.paths.runtimeRoot,`connector-recordings/${id}/manifest.json`);let manifest:{ownerSessionId:string;files:string[]};try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch{throw new ConnectorError('access_denied','Личный снимок недоступен');}if(manifest.ownerSessionId!==owner.id||!manifest.files.includes(`${index}.png`))throw new ConnectorError('access_denied','Личный снимок принадлежит другой сессии');const file=await safeArtifactPath(context.paths.runtimeRoot,`connector-recordings/${id}/${index}.png`);return reply.type('image/png').header('cache-control','no-store').header('x-content-type-options','nosniff').send(createReadStream(file));});
}
