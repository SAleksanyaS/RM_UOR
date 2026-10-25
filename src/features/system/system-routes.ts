import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, statfs, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import type { ApplicationContext } from '../../server/workspace/context';
import { APP_VERSION, STORAGE_SCHEMA_VERSION } from '../../domain/app-version';
import { ActionError } from '../identity/role-service';
import { createBackup, listBackups, restoreBackup, pruneBackups } from './backup-service';
const execute=promisify(execFile);
const policySchema=z.object({keepCopies:z.number().int().min(2).max(1000),intervalHours:z.number().int().min(1).max(720),automatic:z.boolean()}).strict();
export const defaultBackupPolicy={keepCopies:10,intervalHours:24,automatic:false};
export async function withMaintenance<T>(context:ApplicationContext,action:()=>Promise<T>):Promise<T>{
  if(context.maintenance||context.activeRequests>1||context.operations.list().some(op=>op.status==='running'))throw new ActionError('Дождитесь завершения других операций и повторите обслуживание.',409);
  context.maintenance=true;try{return await action();}finally{context.maintenance=context.maintenanceRecoveryRequired;}
}
export function registerSystemRoutes(app:FastifyInstance,context:ApplicationContext){
  const curator=(request:{cookies:Record<string,string|undefined>})=>context.roles.requireCurator(request.cookies.uor_session??'');
  app.get('/api/system',async request=>{
    const session=context.roles.get(request.cookies.uor_session),isCurator=session?.role==='curator';
    let git={ok:false,message:'Git не найден. Установите по инструкции'};
    try{const result=await execute('git',['--version'],{windowsHide:true,timeout:5000});git={ok:true,message:result.stdout.trim()};}catch{}
    let writable=false;try{await access(context.paths.runtimeRoot,constants.R_OK|constants.W_OK);writable=true;}catch{}
    const [disk,dbInfo]=await Promise.all([statfs(context.paths.runtimeRoot),stat(context.paths.databasePath)]);
    return{applicationVersion:APP_VERSION,storageVersion:context.db.get('settings','storageSchemaVersion')??1,platform:process.platform,architecture:process.arch,node:process.version,
      git,writable,allowedFolder:context.paths.projectRoot,databaseBytes:dbInfo.size,availableDiskBytes:disk.bavail*disk.bsize,
      counts:isCurator?context.db.counts():{},backups:isCurator?await listBackups(context.paths.runtimeRoot):[],backupPolicy:context.db.get('settings','backupPolicy')??defaultBackupPolicy,
      instructions:'Запускайте npm run dev из разрешённой папки. Штатное обновление программы само подготовит зависимости и перезапустит приложение. При ручном обновлении выполните npm ci и перезапуск. Настройки корпоративного браузера и сертификатов находятся в разделе источников.'};
  });
  app.post('/api/system/backups',async request=>{await curator(request);return withMaintenance(context,async()=>({backup:await createBackup(context.db,context.paths.runtimeRoot)}));});
  app.post('/api/system/backups/restore',async request=>{
    const session=await curator(request),input=z.object({id:z.string().min(1).max(50),confirmation:z.literal('ВОССТАНОВИТЬ')}).strict().parse(request.body);
    return withMaintenance(context,async()=>{
      let restoredInstallationId=context.installationId;
      const result=await restoreBackup(context.db,context.paths.runtimeRoot,input.id,{afterRestore:result=>{
        const storedId=context.db.get<unknown>('settings','installationId');
        if(storedId!==null&&(typeof storedId!=='string'||!storedId||storedId.length>200))throw new Error('В копии повреждена идентификация локальной установки');
        restoredInstallationId=storedId as string|null??context.installationId;
        context.db.transaction(()=>{
          context.db.set('settings','installationId',restoredInstallationId);
          context.catalogs.recordChange(session,'local_backup_restored',input.id,'Восстановление локального рабочего места',{},{...result});
        });
      }});
      // Cached identity changes only after the complete restore (including audit) succeeded.
      context.installationId=restoredInstallationId;
      return{...result,reloginRequired:!context.roles.get(request.cookies.uor_session),message:'Данные восстановлены. Предыдущее состояние сохранено отдельной копией. При необходимости войдите заново.'};});
  });
  app.post('/api/system/backups/policy',async request=>{await curator(request);const policy=policySchema.parse(request.body);context.db.set('settings','backupPolicy',policy);return{policy};});
  app.post('/api/system/backups/prune',async request=>{await curator(request);const input=z.object({keepCopies:z.number().int().min(2).max(1000)}).strict().parse(request.body);return withMaintenance(context,()=>pruneBackups(context.paths.runtimeRoot,input.keepCopies));});
  app.post('/api/system/preferences',async request=>{
    const session=context.roles.get(request.cookies.uor_session);if(!session)throw new ActionError('Откройте рабочее место заново',401);
    const input=z.object({key:z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),value:z.unknown()}).strict().parse(request.body);
    if(JSON.stringify(input.value).length>32000)throw new ActionError('Слишком большой набор настроек');
    const profile=session.curatorId??'local-reader';context.db.set('preferences',`${profile}:${input.key}`,input.value);return{saved:true};
  });
  app.get('/api/system/preferences',async request=>{const session=context.roles.get(request.cookies.uor_session);if(!session)return{};return context.db.get('preferences',`${session.curatorId??'local-reader'}:workspace`)??{};});
  let backupRunning=false,closing=false,backupTask:Promise<void>|null=null;
  const timer=setInterval(()=>{
    if(closing||backupTask)return;
    backupTask=(async()=>{
      const policy=policySchema.safeParse(context.db.get('settings','backupPolicy')??defaultBackupPolicy);
      if(!policy.success||!policy.data.automatic||backupRunning||context.maintenance||context.activeRequests||context.operations.list().some(op=>op.status==='running'))return;
      const copies=await listBackups(context.paths.runtimeRoot);
      if(closing||context.activeRequests||context.maintenance||(copies[0]&&Date.now()-Date.parse(copies[0].at)<policy.data.intervalHours*3600000))return;
      backupRunning=true;
      try{await withMaintenance(context,async()=>{
        await createBackup(context.db,context.paths.runtimeRoot);
        const result=await pruneBackups(context.paths.runtimeRoot,policy.data.keepCopies);
        if(result.invalid.length)context.db.set('system-diagnostics','backup',{at:new Date().toISOString(),message:`Повреждённые копии не учитываются при очистке: ${result.invalid.map(item=>item.id).join(', ')}`,invalid:result.invalid});
      });}finally{backupRunning=false;}
    })().catch(error=>{context.db.set('system-diagnostics','backup',{at:new Date().toISOString(),message:(error as Error).message});}).finally(()=>{backupTask=null;});
  },60000);
  timer.unref();
  app.addHook('preClose',async()=>{closing=true;clearInterval(timer);await backupTask;});
}
