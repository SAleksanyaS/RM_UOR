import { z } from 'zod';
import type { Decision, DirectoryEntity, DirectoryLink, Work } from '../../domain/workbench/entities';
import type { ScopeRef } from '../../domain/workbench/primitives';
import { entityRefSchema } from '../../domain/workbench/primitives';
import { globalContextSchema, pageResultSchema, queryRequestSchema, WorkbenchHttpError, type GlobalContext, type QueryRequest } from '../../server/workbench/protocol';
import type { QueryContext } from '../../server/workbench/query-registry';
import type { WorkbenchReadIndex } from './workbench-read-index';

export const searchHitSchema=z.strictObject({ref:entityRefSchema,name:z.string(),type:z.string(),context:globalContextSchema,route:z.string().min(1)});
export const searchReadModelSchema=z.strictObject({items:z.array(searchHitSchema),page:pageResultSchema});
export type SearchHit=z.infer<typeof searchHitSchema>;
export type SearchReadModel=z.infer<typeof searchReadModelSchema>;
export const searchRequestSchema=queryRequestSchema.extend({filter:z.strictObject({text:z.string().trim().min(1).max(200)}),sort:z.array(z.strictObject({field:z.enum(['title','kind']),direction:z.enum(['asc','desc'])})).refine(v=>new Set(v.map(s=>s.field)).size===v.length)});
const fail=(code:string,status=422):never=>{throw new WorkbenchHttpError(status,code,code);};
/** Derive the real target path, never reuse the caller's cluster for a hit in
 * another branch. Missing/ambiguous hierarchy stays unavailable. */
export function createDirectoryScopeContextResolver(entities:DirectoryEntity[],links:DirectoryLink[],base:GlobalContext):(scope:ScopeRef)=>GlobalContext|null {
  const byId=new Map(entities.map(entity=>[entity.id,entity]));
  const parents=new Map<string,string|null>();
  for(const link of links) if(link.kind!=='leader') {const key=link.kind+'/'+link.to.id;parents.set(key,parents.has(key)?null:link.from.id);}
  const parent=(child:string,kind:string)=>parents.get(kind+'/'+child)??null;
  return scope=>{
    if(byId.get(scope.id)?.kind!==scope.kind)return null;
    let ditId:string|null=null,clusterId:string|null=null,productId:string|null=null,teamId:string|null=null;
    let rootKind:'dit'|'block'|'tribe'='dit';
    if(scope.kind==='dit')ditId=scope.id;
    else if(scope.kind==='cluster')clusterId=scope.id;
    else if(scope.kind==='product'){productId=scope.id;clusterId=parent(productId,'cluster_product');}
    else {teamId=scope.id;productId=parent(teamId,'product_team');clusterId=productId?parent(productId,'cluster_product'):parent(teamId,'cluster_team');if(productId&&parent(teamId,'cluster_team')&&parent(teamId,'cluster_team')!==clusterId)return null;}
    if(clusterId){
      const dit=parent(clusterId,'dit_cluster'),tribe=parent(clusterId,'tribe_cluster');
      if(dit&&tribe)return null;
      if(dit)ditId=dit;
      else if(tribe&&byId.get(tribe)?.kind==='tribe'){
        const block=parent(tribe,'block_tribe');
        if(base.scopePath.rootKind==='tribe'&&base.scopePath.ditId===tribe){ditId=tribe;rootKind='tribe';}
        else if(block){ditId=block;rootKind='block';}else{ditId=tribe;rootKind='tribe';}
      }
    }
    if(!ditId||byId.get(ditId)?.kind!==rootKind)return null;
    if(teamId&&!productId&&rootKind==='dit')return null; // original DIT/product path remains strict
    for(const [id,kind]of [[clusterId,'cluster'],[productId,'product'],[teamId,'team']])if(id&&byId.get(id)?.kind!==kind)return null;
    const scopePath:GlobalContext['scopePath']={ditId,clusterId,productId,teamId};
    if(rootKind!=='dit')scopePath.rootKind=rootKind;else if(base.scopePath.rootKind==='dit')scopePath.rootKind='dit';
    return {...base,scopePath,resultMode:'current',snapshotId:null};
  };
}
export function createScopeContextResolver(index:WorkbenchReadIndex,base:GlobalContext):(scope:ScopeRef)=>GlobalContext|null {
 return createDirectoryScopeContextResolver(index.list('directory_entity'),index.list('directory_link'),base);
}
export function rootDirectoryEntities(index:WorkbenchReadIndex):DirectoryEntity[]{return index.list('directory_entity').filter(e=>e.kind==='dit'||e.kind==='block'||e.kind==='tribe');}
export function navigationRootContext(rootId:string,index:WorkbenchReadIndex,base:GlobalContext):GlobalContext|null {
 const root=rootDirectoryEntities(index).find(e=>e.id===rootId);if(!root)return null;
 const scopePath:GlobalContext['scopePath']={ditId:root.id,clusterId:null,productId:null,teamId:null};if(root.kind!=='dit')scopePath.rootKind=root.kind as 'block'|'tribe';else if(base.scopePath.rootKind==='dit')scopePath.rootKind='dit';
 return {...base,scopePath,resultMode:'current',snapshotId:null};
}
export function contextForScope(scope:ScopeRef,index:WorkbenchReadIndex,base:GlobalContext):GlobalContext|null {return createScopeContextResolver(index,base)(scope);}
export function assertDirectoryContextGraph(context:GlobalContext,entities:DirectoryEntity[],links:DirectoryLink[]):void {
 const path=context.scopePath,rootKind=path.rootKind??'dit';
 if(entities.find(e=>e.id===path.ditId)?.kind!==rootKind)fail('CONTEXT_PATH_INVALID',404);
 if(!path.teamId&&!path.productId&&!path.clusterId)return;
 const selected=path.teamId?{kind:'team' as const,id:path.teamId}:path.productId?{kind:'product' as const,id:path.productId}:{kind:'cluster' as const,id:path.clusterId!};
 const actual=createDirectoryScopeContextResolver(entities,links,context)(selected);
 if(!actual||(['ditId','clusterId','productId','teamId']as const).some(key=>actual.scopePath[key]!==path[key])||(actual.scopePath.rootKind??'dit')!==rootKind)fail('CONTEXT_PATH_INVALID',404);
}
export function assertContextGraph(context:GlobalContext,index:WorkbenchReadIndex):void {
 assertDirectoryContextGraph(context,index.list('directory_entity'),index.list('directory_link'));
 if(context.goalId&&!index.read({entityType:'core_goal_definition',id:context.goalId}))fail('REFERENCE_NOT_FOUND',404);
}
export async function searchWorkbench(input:QueryRequest,context:QueryContext,index:WorkbenchReadIndex):Promise<SearchReadModel> {
  const parsed=searchRequestSchema.safeParse(input); if(!parsed.success) return fail('VALIDATION_FAILED'); const request=parsed.data;
  assertContextGraph(request.context,index);
  const assignments=index.list('goal_assignment'); const works=index.list('work'); const links=index.list('directory_link');
  const resolveScope=createScopeContextResolver(index,request.context);
  const assignmentByGoal=new Map<string,typeof assignments[number]>();
  for(const assignment of [...assignments].sort((a,b)=>a.id.localeCompare(b.id))) if(!assignmentByGoal.has(assignment.goalId)) assignmentByGoal.set(assignment.goalId,assignment);
  const workById=new Map(works.map(work=>[work.id,work]));
  const items:SearchHit[]=[];
  for(const hit of index.search(request.filter.text)) {
    let scope:ScopeRef|undefined; let goalId:string|null=null; let route='/overview';
    if(hit.entityType==='core_goal_definition') {
      scope=assignmentByGoal.get(hit.value.id)?.scope;
      goalId=hit.value.id; route='/goals/'+hit.value.id;
    } else if(hit.entityType==='directory_entity') {
      const directory=hit.value as DirectoryEntity;
      if(directory.kind==='person') {
        const leader=links.find(l=>l.kind==='leader' && l.personId===directory.id);
        if(leader?.kind==='leader') scope=leader.scope;
      }
      else scope={kind:directory.kind,id:directory.id} as ScopeRef;
      route='/goals';
    } else {
      const work=hit.entityType==='work'?hit.value as Work:workById.get((hit.value as Decision).workId);
      scope=work?.responsibility[0]?.scope; goalId=work?.goalIds[0]??null; route='/execution?ref='+hit.entityType+'/'+hit.value.id;
    }
    const rootHit=hit.entityType==='directory_entity'&&['block','tribe'].includes((hit.value as DirectoryEntity).kind)?navigationRootContext(hit.value.id,index,request.context):null;
    const target=rootHit??(scope?resolveScope(scope):hit.entityType==='core_goal_definition'?{...request.context,scopePath:{...request.context.scopePath,clusterId:null,productId:null,teamId:null},resultMode:'current' as const,snapshotId:null}:null); if(!target) continue;
    items.push({ref:{entityType:hit.entityType,id:hit.value.id},name:hit.name,type:hit.entityType,context:{...target,goalId},route});
  }
  items.sort((a,b)=>{
    for(const sort of request.sort) {const left=sort.field==='title'?a.name:a.type,right=sort.field==='title'?b.name:b.type;const diff=left<right?-1:left>right?1:0;if(diff) return sort.direction==='asc'?diff:-diff;}
    return a.name.localeCompare(b.name,'ru') || a.type.localeCompare(b.type) || a.ref.id.localeCompare(b.ref.id);
  });
  return index.page(items,request.page,{name:'search',context:request.context,filter:request.filter,sort:request.sort},context);
}
