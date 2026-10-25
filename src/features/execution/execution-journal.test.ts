import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {CatalogSnapshot,CuratorSession,KnowledgeEntity} from '../../domain/contracts';
import {createContext,type ApplicationContext} from '../../server/workspace/context';
import type {WorkPackage,ExecutionConfig} from './execution-contracts';
import {completePackage,checkRetention,getExecutionView,saveWorkPackage,saveExecutionConfig} from './execution-service';
import {readWorkPackage,readExecutionConfig,validateExecutionEntities} from './execution-schema';
import {buildBurndown} from './execution-model';
const roots:string[]=[],contexts:ApplicationContext[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const c of contexts.splice(0))c.db.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const actor:CuratorSession={id:'session',role:'curator',curatorId:'curator',name:'Куратор примера',createdAt:new Date().toISOString()};
const events=Array.from({length:300},(_,index)=>({id:`event-${index}`,at:new Date(Date.UTC(2025,0,1)+index*86400000).toISOString(),actor:'Куратор примера',completed:index%2===0,comment:'Проверено по документу',evidence:''}));
const work:WorkPackage={id:'work',revision:'r',goalId:'g',leaderId:null,title:'Этап',owner:'Владелец',dueDate:'2026-01-01',weight:2,effortHours:8,dependencies:[],baseline:{at:'2025-01-01T00:00:00Z',dueDate:'2026-01-01',weight:2,effortHours:8},events};
const config:ExecutionConfig={id:'config',revision:'r',goalId:'g',leaderId:null,capacityHours:null,capacityPeriod:'',criticalService:'',product:'',mandatoryRequirement:'',cadenceDays:7,nextCheckDate:'2026-10-25',checks:events.map(({completed:_,...event})=>({...event,result:'stable'}))};
function entity(value:WorkPackage|ExecutionConfig):KnowledgeEntity{return{id:value.id,revision:value.revision,type:'events'in value?'work_package':'execution_config',name:'Этап',goalIds:['g'],leaderId:null,body:JSON.stringify(value)};}
const catalog:CatalogSnapshot={schemaVersion:1,id:'journal-demo',name:'Журнал',classification:'demo',importedAt:'2026-10-25T00:00:00Z',goals:[{id:'g',title:'Цель',category:'process',scopeType:'global',target:'80%',metric:'Доля',status:'',summary:'',actions:[],links:[],ownerId:null,curatorId:null,officialTarget:80,internalTarget:null,unit:'%',direction:'increase',baseline:0,weight:1,priority:null,dueDate:null,revision:'r'}],leaders:[],assignments:[],sources:[],comments:[],entities:[entity(work),entity(config)]};
async function fixture(){const root=await mkdtemp(join(tmpdir(),'uor-journal-'));roots.push(root);const context=await createContext({projectRoot:root,initialCatalog:structuredClone(catalog),startupCheck:false});contexts.push(context);return context;}
it('rotates beyond the former 300-entry limit while preserving full burndown, retention, editing and restart history',async()=>{
 const context=await fixture(),first=await completePackage(context,actor,'work',{baseRevision:'r',completed:true,comment:'Этап завершён',evidence:''});
 await checkRetention(context,actor,'config',{baseRevision:'r',result:'regression',comment:'Нужно исправление',evidence:''});
 let current=await context.catalogs.readForSession(actor),raw=JSON.parse(current.entities.find(e=>e.id==='work')!.body!);
 expect(raw.events.length).toBeLessThanOrEqual(100);expect(raw.eventArchiveId).toMatch(/^execution-journal-/);
 expect(current.entities.filter(e=>e.type==='execution_journal').length).toBeGreaterThan(0);
 expect(readWorkPackage(current.entities.find(e=>e.id==='work')!,current).events).toHaveLength(301);
 expect(readExecutionConfig(current.entities.find(e=>e.id==='config')!,current).checks).toHaveLength(301);
 expect(buildBurndown([readWorkPackage(current.entities.find(e=>e.id==='work')!,current)]).points.some(p=>p.at===events[1].at)).toBe(true);
 const {events:_,baseline:__,revision:___,eventArchiveId:____,...fields}=first.record as WorkPackage;
 const edited=await saveWorkPackage(context,actor,{...fields,title:'Уточнённый этап',baseRevision:first.record.revision});
 await completePackage(context,actor,'work',{baseRevision:edited.record.revision,completed:false,comment:'Открыт повторно',evidence:''});
 const currentConfig=(await getExecutionView(context,actor)).configs[0],{checks:_____,revision:______,checkArchiveId:_______,...configFields}=currentConfig;
 await saveExecutionConfig(context,actor,{...configFields,criticalService:'Услуга',baseRevision:currentConfig.revision});
 current=await context.catalogs.readForSession(actor);expect(()=>validateExecutionEntities(current)).not.toThrow();
 expect(readWorkPackage(current.entities.find(e=>e.id==='work')!,current).events.map(e=>e.id).slice(0,300)).toEqual(events.map(e=>e.id));
 const oldRoot=context.paths.projectRoot;context.db.close();contexts.splice(contexts.indexOf(context),1);const reopened=await createContext({projectRoot:oldRoot,initialCatalog:catalog,startupCheck:false});contexts.push(reopened);
 const view=await getExecutionView(reopened,actor);expect(view.packages[0].events).toHaveLength(302);expect(view.configs[0].checks).toHaveLength(301);expect(reopened.db.counts().snapshots??0).toBe(0);expect(reopened.db.counts().attestations??0).toBe(0);
});
it('rejects missing or modified archive segments and does not leave archive drafts after a failed atomic save',async()=>{
 const context=await fixture();await completePackage(context,actor,'work',{baseRevision:'r',completed:true,comment:'Этап завершён',evidence:''});
 const current=await context.catalogs.readForSession(actor),archive=current.entities.find(e=>e.type==='execution_journal')!,missing=structuredClone(current);missing.entities=missing.entities.filter(e=>e.id!==archive.id);expect(()=>validateExecutionEntities(missing)).toThrow(/архив/i);
 const modified=structuredClone(current);modified.entities.find(e=>e.id===archive.id)!.body=archive.body!.replace('Проверено по документу','Подменено');expect(()=>validateExecutionEntities(modified)).toThrow(/изменён/);
 const second=await fixture(),original=second.catalogs.recordChange.bind(second.catalogs);vi.spyOn(second.catalogs,'recordChange').mockImplementation((...args)=>{original(...args);throw new Error('injected audit failure');});
 await expect(completePackage(second,actor,'work',{baseRevision:'r',completed:true,comment:'Этап завершён',evidence:''})).rejects.toThrow('injected audit failure');expect(second.db.list('drafts')).toEqual([]);expect((await second.catalogs.read()).entities).toEqual(catalog.entities);
});
