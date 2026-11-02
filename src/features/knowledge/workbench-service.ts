import { createHash } from 'node:crypto';
import { parseWorkbenchTable } from '../tabular-import/workbench-parser';
import type { DirectoryEntity,DirectoryLink,MethodVersion } from '../../domain/workbench/entities';
import type { Header } from '../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { DraftService } from '../catalog/workbench-drafts';
import { businessDefinition } from '../catalog/workbench-drafts';
import { validateDirectoryChanges } from '../catalog/workbench-directory';
import type { CommandContext } from '../../server/workbench/command-registry';
import type { QueryContext } from '../../server/workbench/query-registry';
import { WorkbenchHttpError, type FieldProblem } from '../../server/workbench/protocol';
import { canUseCapability } from '../identity/workbench-access-policy';
import { stableJson } from '../../server/workbench/command-store';
import type { MaturityMaterialBundle } from '../maturity/workbench-contracts';
import { knowledgeImportInputSchema,knowledgeImportRowSchema,type KnowledgeImportRow,type KnowledgeImportInput,type KnowledgeList,type KnowledgeItem,type KnowledgePreview } from './workbench-contracts';

type ReadContext=Pick<QueryContext,'repository'|'installationId'|'ownAccess'|'clock'>;
export const knowledgeStableId=(key:string)=>{const hex=createHash('sha256').update('uor-knowledge:'+key).digest('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);};
export function materialDirectoryEntries(materials:MaturityMaterialBundle){
 const xlsx=materials.sources.find(s=>s.kind==='xlsx')!,pptx=materials.sources.find(s=>s.kind==='pptx')!;
 const metadata=(source: any,hash:string,code:string|null=null)=>({importVersion:materials.importVersion,sourceHash:hash,location:source.kind==='xlsx'?`${source.sheet}!${source.cell}`:`slide:${source.slide}/shape:${source.shapeId}`,externalCode:code});
 const entities: Array<{entityType:string;id:string;definition:Record<string,unknown>}>=[];const links:typeof entities=[];
 for(const o of materials.organizations){entities.push({entityType:'directory_entity',id:o.id,definition:{kind:o.kind,name:o.name,externalKeys:[],sourceMetadata:metadata(o.source,xlsx.sha256),lifecycle:'active',effectivePeriod:{startInclusive:materials.period,endExclusive:null}}});if(o.parentId)links.push({entityType:'directory_link',id:knowledgeStableId('parent:'+o.id),definition:{kind:o.kind==='tribe'?'block_tribe':'tribe_cluster',from:{entityType:'directory_entity',id:o.parentId},to:{entityType:'directory_entity',id:o.id}}});}
 for(const t of materials.teams){entities.push({entityType:'directory_entity',id:t.id,definition:{kind:'team',name:t.name,externalKeys:[],sourceMetadata:metadata(t.source,xlsx.sha256,t.code),lifecycle:'active',effectivePeriod:{startInclusive:materials.period,endExclusive:null}}});links.push({entityType:'directory_link',id:knowledgeStableId('parent:'+t.id),definition:{kind:'cluster_team',from:{entityType:'directory_entity',id:t.clusterId},to:{entityType:'directory_entity',id:t.id}}});}
 for(const l of materials.leaders){entities.push({entityType:'directory_entity',id:l.id,definition:{kind:'person',name:l.name,externalKeys:[],sourceMetadata:metadata(l.source,pptx.sha256),lifecycle:'active'}});for(const teamId of l.teamIds)links.push({entityType:'directory_link',id:knowledgeStableId('leader:'+teamId),definition:{kind:'leader',scope:{kind:'team',id:teamId},personId:l.id}});}
 return [...entities,...links];
}
export function maturitySeedEntries(materials:MaturityMaterialBundle,curatorPersonId:string|null){
 const entries=materialDirectoryEntries(materials),methodId=knowledgeStableId('maturity-method-v1'),templateId=knowledgeStableId('maturity-template-v1');
 for(const m of materials.metrics)entries.push({entityType:'metric_definition',id:m.id,definition:{name:m.name,unit:{code:'percent',label:'%'},domain:'nonnegative_decimal'}});
 const method:Omit<Extract<MethodVersion,{mode:'numeric'}>,keyof Header>={mode:'numeric',rules:materials.metrics.map((m,index)=>({metricRef:{entityType:'metric_definition',id:m.id,revision:1},mandatory:true,originalWeight:'1',condition:{op:'gte',target:m.target},normalization:{kind:'binary_condition_v1'},freshness:{maxAgeHours:'168',updateEveryHours:'168'},reducer:{kind:'source_provided_value',valueField:'metric_'+index}})),formula:{kind:'weighted_mean_v1',scoreCondition:{op:'gte',target:'100'}}};
 entries.push({entityType:'method_version',id:methodId,definition:method},{entityType:'template',id:templateId,definition:{name:'Модель зрелости — 5 обязательных метрик команды',methodRef:{entityType:'method_version',id:methodId,revision:1}}});
 if(curatorPersonId){
  if(!materials.leaders.some(l=>l.id===curatorPersonId))throw new WorkbenchHttpError(422,'CURATOR_SELECTION_REQUIRED','Выберите лицо из справочника для бизнес-ответственности');
  const goalId=knowledgeStableId('maturity-goal'),sourceId=knowledgeStableId('maturity-source'),mappingId=knowledgeStableId('maturity-mapping');
  for(const e of entries)if(e.entityType==='directory_entity'&&e.definition.kind==='team')e.definition.externalKeys=[{sourceId,key:(e.definition.sourceMetadata as any).externalCode}];
  entries.push({entityType:'core_goal_definition',id:goalId,definition:{title:'Модель зрелости ДИТ',description:'Пять обязательных метрик каждой команды. 80% — объявленный ориентир презентации, не подтверждение УОР. Исключения и отсутствие PR требуют отдельной утверждённой применимости.',mode:'numeric',measurementMode:'as_of',sourceId,primaryCuratorPersonId:curatorPersonId,coCuratorPersonIds:[],lifecycle:'active',archiveReason:null}},
   {entityType:'source_definition',id:sourceId,definition:{goalId,kind:'file',mappingRef:{entityType:'source_field_mapping',id:mappingId,revision:1},publicLocator:null}},
   {entityType:'source_field_mapping',id:mappingId,definition:{sourceId,rowKeyFields:['row'],dimensionFields:{teamCode:'teamCode'},productKeyField:null,teamKeyField:'teamCode',fixedScope:null,metricFields:materials.metrics.map((m,index)=>({metricId:m.id,fields:{['metric_'+index]:'metric_'+index}})),dateField:'date',periodStartField:null,periodEndField:null,unitField:null,fixedUnitCode:'percent',parsingProfile:{sheetName:'Sheet1',csvDelimiter:';',csvEncoding:'utf8',dateFormat:'iso',decimalSeparator:'.',groupSeparator:'none'}}});
  for(const t of materials.teams)entries.push({entityType:'goal_assignment',id:knowledgeStableId('assignment:'+t.id),definition:{goalId,scope:{kind:'team',id:t.id},methodBinding:{kind:'template',templateId},officialDueOn:null,expectedPopulation:[{kind:'team',id:t.id}]}});
 }
 return entries;
}
export function createKnowledgeService({repository,drafts,materials,materialsFor}:{repository:WorkbenchRepository;drafts:DraftService;materials:MaturityMaterialBundle;materialsFor?:(context:ReadContext)=>MaturityMaterialBundle}){
 const header=(id:string,bundle:MaturityMaterialBundle=materials):Header=>({schemaVersion:1,id,revision:1,recordedAt:bundle.period+'T00:00:00Z',actor:{hostname:'selected-material-import',installationId:bundle.id,profilePersonId:null},publicationAnchorId:null});
 const list=(context:ReadContext,{packageId=null,text='',kind='all',includeArchived=false}:{packageId?:string|null;text?:string;kind?:string;includeArchived?:boolean}={}):KnowledgeList=>{
  if(context.repository!==repository)throw new WorkbenchHttpError(409,'COMMAND_CONTEXT_MISMATCH','Контекст изменился');
  const materialsForOwner=materialsFor?.(context)??materials;
  const rows=new Map<string,{type:string;value:Header;origin:KnowledgeItem['origin']}>();
  for(const e of materialDirectoryEntries(materialsForOwner))rows.set(e.entityType+'/'+e.id,{type:e.entityType,value:{...header(e.id,materialsForOwner),...e.definition} as Header,origin:'selected_material'});
  for(const e of repository.readPublishedCatalog())if(['directory_entity','directory_link'].includes(e.entityType))rows.set(e.entityType+'/'+e.value.id,{type:e.entityType,value:e.value,origin:'published'});
  if(packageId&&(!context.ownAccess.personId||!canUseCapability(context.ownAccess,'uor.prepare')))throw new WorkbenchHttpError(403,'ACCESS_DENIED','Черновики доступны владельцу-куратору');
  const pkg=packageId?drafts.readOwnPackage(context,packageId):null;
  for(const e of pkg?.entries??[])if(['directory_entity','directory_link'].includes(e.entityRef.entityType)&&e.complete)rows.set(e.entityRef.entityType+'/'+e.entityRef.id,{type:e.entityRef.entityType,value:{...e.header,...e.definition} as Header,origin:'own_draft'});
  const entities=[...rows.values()].filter(e=>e.type==='directory_entity'),links=[...rows.values()].filter(e=>e.type==='directory_link').map(e=>e.value as DirectoryLink);
  const quality=validateDirectoryChanges({entities:entities.map(e=>e.value as DirectoryEntity),links});
  const items:KnowledgeItem[]=entities.map(e=>{const value=e.value as DirectoryEntity,parent=links.find(l=>l.kind!=='leader'&&l.kind!=='product_team'&&l.to.id===value.id);const leaders=links.filter(l=>l.kind==='leader'&&l.scope.id===value.id);return {value,origin:e.origin,ref:{entityType:'directory_entity',id:value.id,revision:value.revision},parentId:parent&&parent.kind!=='leader'?parent.from.id:null,leaderNames:leaders.map(l=>l.kind==='leader'?(rows.get('directory_entity/'+l.personId)?.value as DirectoryEntity)?.name??'Имя недоступно':''),quality:(value.kind==='cluster'||value.kind==='team')&&!leaders.length?['Не указана ответственность']:[]};});
  const filtered=items.filter(i=>(includeArchived||i.value.lifecycle!=='archived')&&(kind==='all'||i.value.kind===kind)&&(!text||(i.value.name+' '+(i.value.sourceMetadata?.externalCode??'')).toLocaleLowerCase('ru').includes(text.toLocaleLowerCase('ru'))));
  return {items:filtered,links,total:filtered.length,packageId:pkg?.packageId??null,editToken:pkg?`draft:${pkg.packageId}:${pkg.revision}`:null,quality,sourceLabel:'Выбранные материалы · 30 октября 2026 · изменения публикуются через пакет',nextCursor:null};
 };
 type DefinitionEntry = {entityType:string;id:string;definition:Record<string,unknown>};

 async function importRows(input:KnowledgeImportInput):Promise<KnowledgeImportRow[]> {
  const value=knowledgeImportInputSchema.parse(input);
  let raw:unknown[]=value.rows??[];
  if(value.csv!==undefined||value.xlsxBase64!==undefined){
   const isXlsx=value.xlsxBase64!==undefined;
   const bytes=isXlsx?Buffer.from(value.xlsxBase64!,'base64'):Buffer.from(value.csv!,'utf8');
   const table=await parseWorkbenchTable({bytes,name:isXlsx?'directory.xlsx':'directory.csv',parsingProfile:{sheetName:null,csvDelimiter:';',csvEncoding:'utf8',dateFormat:'iso',decimalSeparator:'.',groupSeparator:'none'}});
   raw=table.rows.map(row=>Object.fromEntries(Object.entries(row.cells).map(([key,cell])=>[key,cell.original])));
  }
  if(raw.length>200)throw new WorkbenchHttpError(422,'IMPORT_SIZE_LIMIT','До 200 строк');
  return raw.map(row=>knowledgeImportRowSchema.parse(Object.fromEntries(Object.entries(row as object).filter(([,value])=>value!==null&&value!==''))));
 }

 function parentLinkKind(kind:DirectoryEntity['kind'],parent:Pick<DirectoryEntity,'kind'>|undefined):Exclude<DirectoryLink['kind'],'leader'>|null {
  switch(kind){
   case 'tribe':return 'block_tribe';
   case 'cluster':return parent?.kind==='dit'?'dit_cluster':'tribe_cluster';
   case 'team':return 'cluster_team';
   case 'product':return 'cluster_product';
   default:return null;
  }
 }

 /** Preview and apply share this graph projection. An unchanged relationship retains its original ID. */
 function planRows(current:KnowledgeList,rows:KnowledgeImportRow[]){
  const entities=new Map(current.items.map(item=>[item.value.id,item.value]));
  const links=new Map(current.links.map(link=>[link.id,link]));
  const entries:DefinitionEntry[]=[];
  const diff:KnowledgePreview['diff']=[];
  const explicitProblems:FieldProblem[]=[];
  const incomingKinds=new Map(rows.map(row=>[row.id??knowledgeStableId('import:'+row.kind+':'+(row.code||row.name)),row.kind]));
  const importedHash=createHash('sha256').update(stableJson(rows)).digest('hex');
  const seenIds=new Set<string>();
  const problem=(code:string,id:string,message:string)=>explicitProblems.push({path:'/rows',code,message,ref:{entityType:'directory_entity',id}});
  for(const [index,row] of rows.entries()){
   const id=row.id??knowledgeStableId('import:'+row.kind+':'+(row.code||row.name));
   if(seenIds.has(id))problem('DUPLICATE_DIRECTORY_ENTITY',id,'Повтор объекта в импортируемых строках');
   seenIds.add(id);
   const existing=entities.get(id);
   const definition:Record<string,unknown>={
    ...(existing?businessDefinition(existing):{externalKeys:[]}),
    kind:row.kind,name:row.name,lifecycle:row.lifecycle??existing?.lifecycle??'active',
   };
   if(row.code&&row.code!==existing?.sourceMetadata?.externalCode){
    definition.sourceMetadata={importVersion:'knowledge-form-v1',sourceHash:importedHash,location:'import-row:'+(index+2),externalCode:row.code};
   }
   const value={...(existing??header(id)),...definition} as DirectoryEntity;
   entities.set(id,value);
   entries.push({entityType:'directory_entity',id,definition});
   const previousParents=current.links.filter((link):link is Exclude<DirectoryLink,{kind:'leader'}>=>link.kind!=='leader'&&link.kind!=='product_team'&&link.to.id===id);
   const before=previousParents.length===1?previousParents[0].from.id:null;
   let parentChanged=false;
   if(row.parentId){
    const parentKind=incomingKinds.get(row.parentId)??entities.get(row.parentId)?.kind;
    const kind=parentLinkKind(row.kind,parentKind?{kind:parentKind}:undefined);
    if(!kind)problem('PARENT_RELATIONSHIP_UNSUPPORTED',id,'Этот тип объекта не поддерживает выбранную родительскую связь');
    else if(previousParents.length>1)problem('MULTIPLE_PARENT_LINKS',id,'Сначала устраните неоднозначную родительскую связь');
    else {
     const previous=previousParents[0];
     const unchanged=previous&&previous.kind===kind&&previous.from.id===row.parentId;
     if(!unchanged){
      parentChanged=true;
      if(row.kind==='team'&&previous)problem('TEAM_CLUSTER_MOVE_UNSUPPORTED',id,'Перенос команды требует отдельного согласованного изменения состава');
      else {
       const linkId=previous?.id??knowledgeStableId('import-parent:'+id);
       const link={...(previous??header(linkId)),kind,from:{entityType:'directory_entity',id:row.parentId},to:{entityType:'directory_entity',id}} as Exclude<DirectoryLink,{kind:'leader'}>;
       links.set(linkId,link);
       entries.push({entityType:'directory_link',id:linkId,definition:businessDefinition(link)});
      }
     }
    }
   }
   const sameDefinition=existing&&stableJson(businessDefinition(existing))===stableJson(definition);
   diff.push({id,name:row.name,kind:row.kind,action:existing?(sameDefinition&&!parentChanged?'unchanged':'update'):'create',parentChange:parentChanged?{from:before,to:row.parentId}:null});
  }
  const baselineKeys=new Set(current.quality.map(problem=>JSON.stringify([problem.code,problem.ref])));
  const graphProblems=validateDirectoryChanges({entities:[...entities.values()],links:[...links.values()],previousLinks:current.links}).filter(problem=>!baselineKeys.has(JSON.stringify([problem.code,problem.ref])));
  const codes=new Map<string,string>();
  for(const entity of entities.values()){
   const code=entity.sourceMetadata?.externalCode;
   if(!code)continue;
   const key=entity.kind+'/'+code;
   const previous=codes.get(key);
   if(previous&&previous!==entity.id)problem('DUPLICATE_EXTERNAL_KEY',entity.id,'Повтор кода: '+code);
   codes.set(key,entity.id);
  }
  return {entries,diff,problems:[...graphProblems,...explicitProblems]};
 }

 async function preview(context:ReadContext,input:KnowledgeImportInput):Promise<KnowledgePreview> {
  const rows=await importRows(input);
  const current=list(context,{packageId:input.packageId,includeArchived:true});
  const plan=planRows(current,rows);
  const directoryRevision=createHash('sha256').update(stableJson({items:current.items,links:current.links})).digest('hex');
  const previewDigest=createHash('sha256').update(stableJson({rows,directoryRevision,packageId:input.packageId,editToken:current.editToken})).digest('hex');
  return {rows,diff:plan.diff,problems:plan.problems,previewDigest,stateRevision:repository.getStateRevision(),packageId:input.packageId};
 }

 function supplementEntries(context:CommandContext,input:{packageId:string|null;curatorPersonId:string|null}):DefinitionEntry[] {
  const definitions=new Map(repository.readPublishedCatalog().map(entry=>[entry.entityType+'/'+entry.value.id,businessDefinition(entry.value)]));
  if(input.packageId){
   for(const entry of drafts.readOwnPackage(context,input.packageId).entries){
    definitions.set(entry.entityRef.entityType+'/'+entry.entityRef.id,entry.definition);
   }
  }
  return maturitySeedEntries(materialsFor?.(context)??materials,input.curatorPersonId).map(seed=>{
   const existing=definitions.get(seed.entityType+'/'+seed.id);
   if(!existing)return seed;
   // Supplementation never restores pristine seed values over reviewed definitions.
   // Adding the selected material source requires only its proven exact team-code aliases.
   if(seed.entityType==='directory_entity'&&existing.kind==='team'){
    const required=(seed.definition.externalKeys??[]) as DirectoryEntity['externalKeys'];
    const aliases=[...((existing.externalKeys??[]) as DirectoryEntity['externalKeys'])];
    for(const key of required){
     if(!aliases.some(alias=>alias.sourceId===key.sourceId&&alias.key===key.key))aliases.push(key);
    }
    return {...seed,definition:required.length?{...existing,externalKeys:aliases}:existing};
   }
   return {...seed,definition:existing};
  });
 }

 return {
  list,preview,materials,
  prepare(context:CommandContext,input:{packageId:string|null;curatorPersonId:string|null}){
   return drafts.prepareDefinitions(context,{packageId:input.packageId,entries:supplementEntries(context,input)});
  },
  async apply(context:CommandContext,input:KnowledgeImportInput&{previewDigest:string}){
   if(!canUseCapability(context.ownAccess,'uor.prepare')||!context.ownAccess.personId)throw new WorkbenchHttpError(403,'ACCESS_DENIED','Изменения доступны куратору');
   const {previewDigest,...data}=input;
   const reviewed=await preview(context,data);
   if(reviewed.previewDigest!==previewDigest)throw new WorkbenchHttpError(409,'PREVIEW_STALE','Справочник изменился; повторите предпросмотр');
   if(reviewed.problems.length)throw new WorkbenchHttpError(422,'DIRECTORY_INVALID','Исправьте строки',reviewed.problems);
   const inventory=list(context,{packageId:data.packageId,includeArchived:true});
   const plan=planRows(inventory,reviewed.rows);
   return drafts.prepareDefinitions(context,{packageId:data.packageId,entries:plan.entries});
  },
 };
}
export type KnowledgeService=ReturnType<typeof createKnowledgeService>;
