import type { ApplicationContext } from '../../server/workspace/context';
import type { Session } from '../../domain/contracts';
import { collectionSchema, ConnectorError } from './contracts';
import { collectConfiguredSource } from './service';
interface Schedule { id:string;sessionId:string;sourceId:string;profileId:string;intervalMs:number;nextAt:number;lastAt?:string;lastStatus?:string }
export function createConnectorScheduler(context:ApplicationContext, options:{tickMs?:number;now?:()=>number}={}) {
  const now=options.now??Date.now, active=new Map<string,AbortController>();let stopped=false,ticking=false;
  const register=async(session:Session,sourceId:string,intervalMs:number)=>{
    if(!Number.isInteger(intervalMs)||intervalMs<60000||intervalMs>30*86400000)throw new ConnectorError('configuration_required','Интервал расписания: от минуты до 30 суток');
    const source=(await context.catalogs.readForSession(session)).sources.find(s=>s.id===sourceId), config=collectionSchema.safeParse(source?.collection);
    if(!config.success)throw new ConnectorError('configuration_required','Сначала настройте реальный сбор источника');
    const schedule:Schedule={id:`${session.id}:${sourceId}`,sessionId:session.id,sourceId,profileId:config.data.authProfileId,intervalMs,nextAt:now()+intervalMs};context.db.set('connector-schedules',schedule.id,schedule);return schedule;
  };
  const remove=(session:Session,sourceId:string)=>{const id=`${session.id}:${sourceId}`;context.db.remove('connector-schedules',id);active.get(id)?.abort();};
  const tick=async()=>{
    if(stopped || ticking || ('maintenance' in context && context.maintenance))return;
    ticking=true;
    try{
    for(const schedule of context.db.list<Schedule>('connector-schedules')){
      if(stopped || ('maintenance' in context && context.maintenance) || schedule.nextAt>now()||active.has(schedule.id))continue;
      const session=context.roles.get(schedule.sessionId);if(!session){context.db.remove('connector-schedules',schedule.id);continue;}
      const source=(await context.catalogs.readForSession(session)).sources.find(s=>s.id===schedule.sourceId);
      if(stopped || ('maintenance' in context && context.maintenance))break;
      if(source?.collection?.authProfileId!==schedule.profileId){context.db.remove('connector-schedules',schedule.id);continue;}
      const controller=new AbortController();active.set(schedule.id,controller);
      const operation=await context.operations.start('update','Личный сбор по расписанию');context.cancelled.set(operation.id,controller);
      context.db.set('operation-owners',operation.id,session.id);
      context.db.set('connector-schedules',schedule.id,{...schedule,nextAt:now()+schedule.intervalMs,lastAt:new Date(now()).toISOString(),lastStatus:'running'});
      void collectConfiguredSource(context,session,schedule.sourceId,controller.signal,stage=>{void context.operations.stage(operation.id,stage);}).then(()=> 'accepted',error=>error.code??'network').then(async status=>{
        await context.operations.finish(operation.id,{status:status==='accepted'?'completed':controller.signal.aborted?'cancelled':'failed',message:status==='accepted'?'Личные факты получены по расписанию':`Сбор по расписанию: ${status}`});
        const current=context.db.get<Schedule>('connector-schedules',schedule.id);if(current&&!stopped)context.db.set('connector-schedules',schedule.id,{...current,lastStatus:status});
      }).finally(()=>{active.delete(schedule.id);context.cancelled.delete(operation.id);});
    }
    }finally{ticking=false;}
  };
  const timer=setInterval(()=>{void tick().catch(()=>{});},options.tickMs??15000);timer.unref();
  return {register,remove,tick,list:(session:Session)=>context.db.list<Schedule>('connector-schedules').filter(s=>s.sessionId===session.id),stop:()=>{stopped=true;clearInterval(timer);for(const controller of active.values())controller.abort();},idle:async()=>{while(active.size||ticking)await new Promise(resolve=>setTimeout(resolve,10));}};
}
