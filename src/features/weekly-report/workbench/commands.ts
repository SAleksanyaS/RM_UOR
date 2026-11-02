import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {CommandRegistry} from '../../../server/workbench/command-registry';
import {uuidSchema} from '../../../domain/workbench/primitives';
import {gigaBindingSchema} from '../../connectors/gigachat-browser-contracts';
import {selectionSchema,promptSchema,contentSchema,actionInputSchema,weekSchema} from './contracts';
import type {WeeklyService} from './service';
export function registerWeeklyCommands(registry:CommandRegistry,s:WeeklyService){
 const output=z.strictObject({id:uuidSchema,revision:z.number().int(),state:z.enum(['prepared','sending','unknown','received','reviewed']).optional()});
 const local=<I>(name:string,inputSchema:z.ZodType<I>,action:(c:any,i:I)=>Promise<any>,external=false)=>registry.register({name,inputSchema,outputSchema:output,capability:'uor.prepare',ownership:'person',effect:external?'external':'local',execution:external?'async':'sync',...(external?{explicitRecovery:'reconcile-on-user-retry' as const}:{}),resourceKey:()=> 'weekly:browser',handler:action});
 local('weekly.action.createWork',z.strictObject({id:uuidSchema}),async(c,input)=>{
  const action=s.actionForWork(c,input.id);if(action.workDraft)return s.linkWorkDraft(c,{id:action.id,workDraft:action.workDraft});
  const commandId=(step:string)=>{const h=createHash('sha256').update(action.id+':'+step).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
  const invoke=async(step:string,name:string,payload:Record<string,unknown>,baseRevision:string|null)=>{const id=commandId(step);const outcome=await registry.execute({commandId:id,name,payload,baseRevision},{...c,commandId:id});if(!('result' in outcome))throw Error('Execution draft requires synchronous commands');return outcome;};
  const opened=await invoke('work-open','draft.open',{entityType:'work',ref:null,packageId:null},null);const draft=opened.result as {draftId:string;objectId:string};
  const scope=c.repository.readPublishedHead({entityType:'directory_entity',id:action.teamId}) as {kind:string};
  const saved=await invoke('work-save:'+action.revision,'work.draft.save',{draftId:draft.draftId,definition:{title:action.text,goalIds:[action.goalId],responsibility:[{scope:{kind:scope.kind,id:action.teamId},personId:action.ownerPersonId}],state:'planned',dueOn:action.dueOn,forecastOn:null,nextAction:action.nextAction,reason:null,resultDescription:null,evidenceIds:[],risk:action.kind==='risk'?{reason:action.text,helpNeeded:action.nextAction}:null,blocker:null}},opened.editToken);
  const packageId=saved.editToken!.split(':')[1];return s.linkWorkDraft(c,{id:action.id,workDraft:{packageId,draftId:draft.draftId,workId:draft.objectId}});
 });
 local('weekly.prepare',z.strictObject({selection:selectionSchema,prompt:promptSchema.optional()}),s.prepare);local('weekly.review',z.strictObject({id:uuidSchema,content:contentSchema,acknowledgedWarnings:z.array(z.string())}),s.review);local('weekly.send',z.strictObject({id:uuidSchema,approvedEvidenceHash:z.string().regex(/^[a-f0-9]{64}$/),approvedBindingHash:z.string().min(1)}),s.send,true);local('weekly.reconcile',z.strictObject({id:uuidSchema}),s.reconcile);local('weekly.action.save',actionInputSchema,s.saveAction);local('weekly.action.carry',z.strictObject({id:uuidSchema,weekStart:weekSchema}),s.carry);
 const bind=<I,O>(name:string,inputSchema:z.ZodType<I>,outputSchema:z.ZodType<O>,action:(c:any,i:I)=>Promise<O>)=>registry.register({name,inputSchema,outputSchema,capability:'uor.prepare',ownership:'person',effect:'local',execution:'sync',async handler(c,i){return {result:await action(c,i),changedRefs:[],editToken:null};}});
 bind('weekly.browser.configure',z.strictObject({binding:gigaBindingSchema,expectedRevision:z.string().nullable()}),z.strictObject({revision:z.string()}),s.configure);bind('weekly.browser.open',z.strictObject({id:uuidSchema.optional()}),z.strictObject({opened:z.literal(true)}),s.open);bind('weekly.browser.close',z.strictObject({}),z.strictObject({closed:z.literal(true)}),s.close);
}
