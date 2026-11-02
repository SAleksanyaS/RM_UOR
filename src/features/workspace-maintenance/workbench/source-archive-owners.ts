import { createHash } from 'node:crypto';
import { lstatSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { uuidSchema,versionRefSchema } from '../../../domain/workbench/primitives';
import { fileArtifactRefSchema,captureSchema,observedFactSchema,evidenceSchema } from '../../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createWorkspaceOwnership } from '../../../server/storage/workbench-ownership';
import { stableJson } from '../../../server/workbench/command-store';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { fileHandleViewSchema,readReferencedFileSync,hydrateReferencedFileSync,assertFileName } from '../../../server/workbench/files';
import { bindingSchema,savedSchema,createSourceStore } from '../../connectors/workbench-source-store';
import { captureRequestSchema,captureResultSchema,rawBatchSchema,sourceIssueSchema } from '../../connectors/workbench-source-contracts';
import { createImportStore,type ImportPreviewRecord } from '../../tabular-import/workbench-import-store';
import { portableImportPreviewSchema } from '../../tabular-import/workbench-import-persistence';
import { importApplyResultSchema } from '../../tabular-import/workbench-import';
import { createOkoWorkflowStore } from '../../connectors/workbench-workflow-store';
import { captureIntentSchema,captureReceiptSchema,captureExportPayloadSchema } from '../../connectors/workbench-capture-contracts';
import { persistedOkoWorkflowSchema,portableOkoWorkflowSchema,okoStoredResultSchema } from '../../connectors/workbench-workflow-persistence';
import { browserScenarioReceiptSchema,initializeBrowserScenarioStore } from '../../connectors/workbench-browser-scenarios';
import { initializeEvidenceStore } from '../../evidence/workbench-evidence';
import type { ProductionArchiveOwner,ProductionArchiveEnvironment,ProductionArchiveFileReference } from './production-archive-contracts';
import type { WorkspaceArchiveRecord,WorkspaceArchiveFileSource,WorkspaceArchiveRestoreContext,ValidatedWorkspaceArchive } from './contracts';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function invalid():never{throw new WorkbenchHttpError(422,'INVALID_ARCHIVE','Source archive metadata or referenced bytes are invalid');}
function denied():never{throw new WorkbenchHttpError(403,'ACCESS_DENIED','Complete subject inventory has unknown or foreign ownership');}
const sha=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().nonnegative().safe();
const ownerSchema=z.strictObject({personId:uuidSchema.nullable(),installationId:uuidSchema.nullable()}).refine(o=>o.personId===null?o.installationId!==null:o.installationId===null);
type Owner=z.infer<typeof ownerSchema>;
const ownerOf=(installationId:string,personId:string|null):Owner=>ownerSchema.parse({personId,installationId:personId===null?installationId:null});
const authorizeOwner=(o:Owner,personId:string|null,installationId:string)=>{if(o.personId===null || personId===null || o.personId!==personId || o.installationId!==null)denied();uuidSchema.parse(installationId);};
const fileRef=(sha256:string,bytes:number,kind:ProductionArchiveFileReference['kind']):ProductionArchiveFileReference=>({sha256,bytes,kind});
function bytesFor(context:WorkspaceArchiveRestoreContext|undefined,ref:ProductionArchiveFileReference):Uint8Array {
 if(!context)invalid();const bytes=context.files.get('files/'+ref.sha256);if(!bytes || bytes.byteLength!==ref.bytes || hash(bytes)!==ref.sha256)invalid();return bytes;
}
const omissionTables={sources:'wb_sources_original_omissions',imports:'wb_imports_original_omissions',oko_workflow:'wb_oko_workflow_original_omissions'} as const;
function omissions(repository:WorkbenchRepository,moduleId:keyof typeof omissionTables){
 const sql=repository.sqlForModule(moduleId),table=omissionTables[moduleId];
 return {read(key:string){return sql.get<{sha256:string;bytes:number}>('SELECT sha256,bytes FROM '+table+' WHERE file_key=?',[key]);},any(){return sql.get('SELECT file_key FROM '+table+' LIMIT 1')!==null;},
 assertCoverage(refs:ReadonlyMap<string,{sha256:string;bytes:number}>){for(const row of sql.all<{file_key:string;sha256:string;bytes:number}>('SELECT file_key,sha256,bytes FROM '+table)){const ref=refs.get(row.file_key);if(!ref||ref.sha256!==row.sha256||ref.bytes!==row.bytes)invalid();}},
 restore(key:string,ref:ProductionArchiveFileReference,context:WorkspaceArchiveRestoreContext|undefined):Uint8Array|null {
  if(context?.originalsOmitted&&ref.kind==='original'&&!context.files.has('files/'+ref.sha256)){sql.run('INSERT INTO '+table+' VALUES(?,?,?)',[key,ref.sha256,ref.bytes]);return null;}return bytesFor(context,ref);
 }};
}
function ownedBytes(filename:string,sha256:string,bytes:number):Uint8Array {
 let current=path.parse(path.resolve(filename)).root;const parts=path.resolve(filename).slice(current.length).split(path.sep).filter(Boolean);
 for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);const info=lstatSync(current);if(info.isSymbolicLink() || (i<parts.length-1?!info.isDirectory():!info.isFile()||info.nlink!==1||info.size!==bytes))invalid();}
 const result=readFileSync(filename);if(result.length!==bytes||hash(result)!==sha256)invalid();return result;
}
function hydrateEvidence(context:WorkspaceArchiveRestoreContext|undefined,id:string,ref:ProductionArchiveFileReference):void {
 uuidSchema.parse(id);const bytes=bytesFor(context,ref), filename=context!.subjectPath('evidence',id);mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
 try{writeFileSync(filename,bytes,{flag:'wx',mode:0o400});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;ownedBytes(filename,ref.sha256,ref.bytes);}
}
type Shape={schema:z.ZodType;key:(value:any)=>string;owner?:(value:any)=>Owner|null;refs?:(value:any)=>ProductionArchiveFileReference[]};
function makeOwner(moduleId:string,shapes:Record<string,Shape>,ports:Pick<ProductionArchiveOwner,'exportRecords'|'restoreRecords'|'files'|'validateArchive'>):ProductionArchiveOwner {
 const parse=(record:WorkspaceArchiveRecord)=>{const shape=shapes[record.schemaId];if(record.moduleId!==moduleId || record.schemaVersion!==1 || !shape)invalid();const value=shape.schema.parse(record.value);if(shape.key(value)!==record.key)invalid();return {shape,value};};
 return {moduleId,...ports,validate(record){parse(record);},isUserData:()=>true,
 validateArchive(archive){const selected=archive.records.filter(r=>r.moduleId===moduleId),seen=new Set<string>();for(const record of selected){const {shape,value}=parse(record),key=stableJson([record.schemaId,record.key]);if(seen.has(key))invalid();seen.add(key);for(const ref of shape.refs?.(value)??[]){const metadata=archive.manifest.files.find(f=>f.sha256===ref.sha256),bytes=archive.files.get('files/'+ref.sha256);if(!metadata||!bytes){if(ref.kind==='original'&&archive.manifest.exclusions.includes('originals')&&!metadata&&!bytes)continue;invalid();}if(metadata.bytes!==ref.bytes||bytes.byteLength!==ref.bytes||hash(bytes)!==ref.sha256)invalid();}}ports.validateArchive?.(archive);},
 fileReferences(records){return records.flatMap(record=>{const {shape,value}=parse(record);return shape.refs?.(value)??[];});},
 authorize(records,personId,installationId){for(const record of records){const {shape,value}=parse(record),owner=shape.owner?.(value);if(owner)authorizeOwner(owner,personId,installationId);}},
 };
}
const record=(moduleId:string,schemaId:string,key:string,value:unknown):WorkspaceArchiveRecord=>({moduleId,schemaId,schemaVersion:1,key,value});
const fileSource=(bytesValue:Uint8Array,kind:WorkspaceArchiveFileSource['kind']):WorkspaceArchiveFileSource=>({path:'files/'+hash(bytesValue),kind,bytesValue});

const portableEvidenceSchema=z.strictObject({request:captureRequestSchema.omit({profileRef:true}),raw:rawBatchSchema,issues:z.array(sourceIssueSchema),factRefs:z.array(versionRefSchema),result:captureResultSchema,contextKey:sha});
const sourceCapture=z.strictObject({owner:ownerSchema,operationId:uuidSchema,captureId:uuidSchema,evidence:portableEvidenceSchema});
const sourceContext=z.strictObject({owner:ownerSchema,value:savedSchema.omit({installationId:true})});
const sourceArtifact=z.strictObject({owner:ownerSchema,artifact:fileArtifactRefSchema});
const success=z.strictObject({owner:ownerSchema,goalId:uuidSchema,contextKey:sha,captureId:uuidSchema});
const attempt=success.extend({sourceId:uuidSchema});
const gitSchema=z.strictObject({goalId:uuidSchema,captureRef:versionRefSchema,factRefs:z.array(versionRefSchema),context:savedSchema.shape.context,coverage:rawBatchSchema.shape.coverage});

export function createSourceArchiveOwners(repository:WorkbenchRepository,environment:ProductionArchiveEnvironment):ProductionArchiveOwner[] {
 createSourceStore({repository});createImportStore({repository});createOkoWorkflowStore(repository);initializeEvidenceStore(repository);initializeBrowserScenarioStore(repository);
 const ownership=createWorkspaceOwnership(repository), sql=repository.sqlForModule('sources');
 if(environment.localPreview&&environment.personId()!==null)repository.transaction(()=>{
  const personId=environment.personId()!,installationId=environment.installationId;
  const adopt=(moduleId:string,key:string)=>{if(!ownership.read(moduleId,key))ownership.bind({moduleId,key,installationId,personId,provenance:'local-preview-adoption'});};
  const linked:Array<{captureId:string;goalId:string;contextKey:string;artifactId:string|null}>=[];
  for(const row of sql.all<{installation_id:string;capture_id:string;value_json:string}>('SELECT installation_id,capture_id,value_json FROM wb_sources_captures')){
   if(row.installation_id!==installationId)continue;const parsed=captureSchema.safeParse(repository.readVersion({entityType:'capture',id:row.capture_id,revision:1}));
   if(!parsed.success||parsed.data.actor.installationId!==installationId||parsed.data.actor.profilePersonId!==personId)continue;
   const raw=JSON.parse(row.value_json),request=captureRequestSchema.parse(raw.request),evidence=portableEvidenceSchema.parse({...raw,request:(({profileRef:_profile,...r})=>r)(request)});
   if(evidence.result.captureRef.id!==row.capture_id||request.operationId!==parsed.data.operationId||request.sourceRef.id!==parsed.data.sourceId||evidence.contextKey!==hash(Buffer.from(stableJson(request.context))))continue;
   if(evidence.raw.artifact){const artifact=sql.get<{metadata_json:string;bytes_value:Uint8Array}>('SELECT metadata_json,bytes_value FROM wb_sources_artifacts WHERE installation_id=? AND artifact_id=?',[installationId,evidence.raw.artifact.artifactId]);if(!artifact||stableJson(JSON.parse(artifact.metadata_json))!==stableJson(evidence.raw.artifact)||hash(artifact.bytes_value)!==evidence.raw.artifact.hash.slice(7)||artifact.bytes_value.length!==evidence.raw.artifact.bytes||parsed.data.rawArtifactId!==evidence.raw.artifact.artifactId)continue;}
   adopt('sources','capture:'+row.capture_id);if(evidence.raw.artifact)adopt('sources','artifact:'+evidence.raw.artifact.artifactId);
   linked.push({captureId:row.capture_id,goalId:request.goalRef.id,contextKey:evidence.contextKey,artifactId:evidence.raw.artifact?.artifactId??null});
  }
  for(const row of sql.all<{installation_id:string;goal_id:string;value_json:string}>('SELECT * FROM wb_sources_contexts')){if(row.installation_id!==installationId)continue;const saved=savedSchema.parse(JSON.parse(row.value_json));if(saved.installationId===installationId&&saved.goalId===row.goal_id&&linked.some(c=>c.goalId===row.goal_id&&c.contextKey===hash(Buffer.from(stableJson(saved.context)))))adopt('sources','context:'+row.goal_id);}
  const imports=repository.sqlForModule('imports');
  for(const group of imports.all<{installation_id:string;source_id:string;mapping_id:string;mapping_revision:number;group_key:string;members_json:string}>('SELECT * FROM wb_imports_groups')){
   if(group.installation_id!==installationId)continue;
   const candidates=imports.all<{installation_id:string;person_id:string;value_json:string}>('SELECT installation_id,person_id,value_json FROM wb_imports_previews WHERE installation_id=?',[installationId]).map(row=>({row,value:JSON.parse(row.value_json) as ImportPreviewRecord})).filter(({value})=>value.binding.source.id===group.source_id&&value.binding.mappingRef.id===group.mapping_id&&value.binding.mappingRef.revision===group.mapping_revision&&Object.hasOwn(value.groupMembership,group.group_key));
   if(!candidates.length||candidates.some(({row,value})=>row.person_id!==personId||value.personId!==personId||value.installationId!==installationId))continue;
   const members=z.array(z.string()).parse(JSON.parse(group.members_json)),known=new Set(candidates.flatMap(({value})=>value.groupMembership[group.group_key]));if(members.some(member=>!known.has(member)))continue;
   for(const {value} of candidates){const file=readReferencedFileSync(path.join(environment.subjectRoot(),'uploads'),value.file.fileHandle,installationId,personId);if(file.sha256!==value.file.sha256||file.bytes!==value.file.bytes)invalid();}
   adopt('imports',stableJson([group.source_id,group.mapping_id,group.mapping_revision,group.group_key]));
  }
 });
 const readOwner=(repo:WorkbenchRepository,moduleId:string,key:string,installationId:string):Owner=>{const bound=createWorkspaceOwnership(repo).read(moduleId,key);if(!bound||bound.installationId!==installationId)denied();return ownerOf(bound.installationId,bound.personId);};
 const bind=(repo:WorkbenchRepository,moduleId:string,key:string,owner:Owner,context:WorkspaceArchiveRestoreContext|undefined)=>{if(!context)invalid();authorizeOwner(owner,context.personId,context.installationId);createWorkspaceOwnership(repo).bind({moduleId,key,installationId:context.installationId,personId:owner.personId,provenance:'restore'});};
 const captureKey=(id:string)=>'capture:'+id,contextKey=(id:string)=>'context:'+id,artifactKey=(id:string)=>'artifact:'+id;
 const sourceShapes:Record<string,Shape>={
  binding:{schema:bindingSchema,key:v=>stableJson([v.goalRef.id,v.assignmentRef.id])},
  context:{schema:sourceContext,key:v=>v.value.goalId,owner:v=>v.owner},
  capture:{schema:sourceCapture,key:v=>v.captureId,owner:v=>v.owner},
  success:{schema:success,key:v=>stableJson([v.goalId,v.contextKey]),owner:v=>v.owner},
  attempt:{schema:attempt,key:v=>stableJson([v.goalId,v.contextKey,v.sourceId]),owner:v=>v.owner},
  git:{schema:gitSchema,key:v=>stableJson([v.goalId,hash(Buffer.from(stableJson(v.context)))])},
  artifact:{schema:sourceArtifact,key:v=>v.artifact.artifactId,owner:v=>v.owner,refs:v=>[fileRef(v.artifact.hash.slice(7),v.artifact.bytes,'original')]},
 };
 const sources=makeOwner('sources',sourceShapes,{
  exportRecords(repo){const s=repo.sqlForModule('sources'),out:WorkspaceArchiveRecord[]=[];
   for(const row of s.all<{value_json:string}>('SELECT value_json FROM wb_sources_bindings ORDER BY goal_id,assignment_id')){const value=bindingSchema.parse(JSON.parse(row.value_json));out.push(record('sources','binding',stableJson([value.goalRef.id,value.assignmentRef.id]),value));}
   for(const row of s.all<{installation_id:string;goal_id:string;value_json:string}>('SELECT * FROM wb_sources_contexts ORDER BY goal_id')){const {installationId,...value}=savedSchema.parse(JSON.parse(row.value_json));if(installationId!==row.installation_id||value.goalId!==row.goal_id)invalid();out.push(record('sources','context',row.goal_id,{owner:readOwner(repo,'sources',contextKey(row.goal_id),row.installation_id),value}));}
   for(const row of s.all<{installation_id:string;operation_id:string;capture_id:string;value_json:string}>('SELECT * FROM wb_sources_captures ORDER BY capture_id')){const raw=JSON.parse(row.value_json);const {profileRef:_profile,...request}=captureRequestSchema.parse(raw.request);const evidence=portableEvidenceSchema.parse({...raw,request});if(evidence.result.captureRef.id!==row.capture_id||evidence.request.operationId!==row.operation_id)invalid();out.push(record('sources','capture',row.capture_id,{owner:readOwner(repo,'sources',captureKey(row.capture_id),row.installation_id),operationId:row.operation_id,captureId:row.capture_id,evidence}));}
   for(const row of s.all<{installation_id:string;goal_id:string;context_key:string;capture_id:string}>('SELECT * FROM wb_sources_success ORDER BY goal_id,context_key'))out.push(record('sources','success',stableJson([row.goal_id,row.context_key]),{owner:readOwner(repo,'sources',captureKey(row.capture_id),row.installation_id),goalId:row.goal_id,contextKey:row.context_key,captureId:row.capture_id}));
   for(const row of s.all<{installation_id:string;goal_id:string;context_key:string;source_id:string;capture_id:string}>('SELECT * FROM wb_sources_attempts ORDER BY goal_id,context_key,source_id'))out.push(record('sources','attempt',stableJson([row.goal_id,row.context_key,row.source_id]),{owner:readOwner(repo,'sources',captureKey(row.capture_id),row.installation_id),goalId:row.goal_id,contextKey:row.context_key,sourceId:row.source_id,captureId:row.capture_id}));
   for(const row of s.all<{goal_id:string;context_key:string;value_json:string}>('SELECT * FROM wb_sources_git ORDER BY goal_id,context_key')){const value=gitSchema.parse(JSON.parse(row.value_json));if(row.goal_id!==value.goalId||row.context_key!==hash(Buffer.from(stableJson(value.context))))invalid();out.push(record('sources','git',stableJson([row.goal_id,row.context_key]),value));}
   for(const row of s.all<{installation_id:string;artifact_id:string;metadata_json:string;bytes_value:Uint8Array}>('SELECT * FROM wb_sources_artifacts ORDER BY artifact_id')){const artifact=fileArtifactRefSchema.parse(JSON.parse(row.metadata_json));const omitted=omissions(repo,'sources').read(artifact.artifactId);if(artifact.artifactId!==row.artifact_id||(omitted?omitted.sha256!==artifact.hash.slice(7)||omitted.bytes!==artifact.bytes||row.bytes_value.length!==0:artifact.bytes!==row.bytes_value.length||artifact.hash!=='sha256:'+hash(row.bytes_value)))invalid();out.push(record('sources','artifact',artifact.artifactId,{owner:readOwner(repo,'sources',artifactKey(artifact.artifactId),row.installation_id),artifact}));}
   for(const r of out)sources.validate(r);omissions(repo,'sources').assertCoverage(new Map(out.filter(r=>r.schemaId==='artifact').map(r=>{const v=sourceArtifact.parse(r.value);return [v.artifact.artifactId,{sha256:v.artifact.hash.slice(7),bytes:v.artifact.bytes}];})));if(new Set(out.map(r=>stableJson([r.schemaId,r.key]))).size!==out.length)invalid();return out;
  },
  restoreRecords(repo,records,context){const s=repo.sqlForModule('sources');for(const r of records){sources.validate(r);const v=r.value as any;switch(r.schemaId){
   case 'binding':s.run('INSERT INTO wb_sources_bindings VALUES(?,?,?)',[v.goalRef.id,v.assignmentRef.id,stableJson(v)]);break;
   case 'context':bind(repo,'sources',contextKey(v.value.goalId),v.owner,context);s.run('INSERT INTO wb_sources_contexts VALUES(?,?,?)',[context!.installationId,v.value.goalId,stableJson({...v.value,installationId:context!.installationId})]);break;
   case 'capture':{bind(repo,'sources',captureKey(v.captureId),v.owner,context);const capture=captureSchema.parse(repo.readVersion({entityType:'capture',id:v.captureId,revision:1}));if(capture.operationId!==v.operationId||capture.sourceId!==v.evidence.request.sourceRef.id||v.evidence.contextKey!==hash(Buffer.from(stableJson(v.evidence.request.context)))||stableJson(capture.rawRows)!==stableJson(v.evidence.raw.rawRows))invalid();for(const ref of v.evidence.factRefs){const fact=observedFactSchema.parse(repo.readVersion(ref));if(ref.entityType!=='observed_fact'||fact.sourceId!==capture.sourceId)invalid();}s.run('INSERT INTO wb_sources_captures VALUES(?,?,?,?)',[context!.installationId,v.operationId,v.captureId,stableJson({...v.evidence,request:{...v.evidence.request,profileRef:null}})]);break;}
   case 'success':case 'attempt':{bind(repo,'sources',captureKey(v.captureId),v.owner,context);if(!records.some(x=>x.schemaId==='capture'&&(x.value as any).captureId===v.captureId))invalid();if(r.schemaId==='success')s.run('INSERT INTO wb_sources_success VALUES(?,?,?,?)',[context!.installationId,v.goalId,v.contextKey,v.captureId]);else s.run('INSERT INTO wb_sources_attempts VALUES(?,?,?,?,?)',[context!.installationId,v.goalId,v.contextKey,v.sourceId,v.captureId]);break;}
   case 'git':if(!repo.readVersion(v.captureRef)||v.factRefs.some((ref:any)=>!repo.readVersion(ref)))invalid();s.run('INSERT INTO wb_sources_git VALUES(?,?,?)',[v.goalId,hash(Buffer.from(stableJson(v.context))),stableJson(v)]);break;
   case 'artifact':bind(repo,'sources',artifactKey(v.artifact.artifactId),v.owner,context);s.run('INSERT INTO wb_sources_artifacts VALUES(?,?,?,?)',[context!.installationId,v.artifact.artifactId,stableJson(v.artifact),omissions(repo,'sources').restore(v.artifact.artifactId,fileRef(v.artifact.hash.slice(7),v.artifact.bytes,'original'),context)??new Uint8Array()]);break;
  }}},
  async files(repo,records){const s=repo.sqlForModule('sources');return records.filter(r=>r.schemaId==='artifact'&&!omissions(repo,'sources').read(r.key)).map(r=>{sources.validate(r);const v=r.value as z.infer<typeof sourceArtifact>,binding=createWorkspaceOwnership(repo).read('sources',artifactKey(v.artifact.artifactId));if(!binding)denied();const row=s.get<{bytes_value:Uint8Array}>('SELECT bytes_value FROM wb_sources_artifacts WHERE installation_id=? AND artifact_id=?',[binding.installationId,v.artifact.artifactId]);if(!row||row.bytes_value.length!==v.artifact.bytes||hash(row.bytes_value)!==v.artifact.hash.slice(7))invalid();return fileSource(row.bytes_value,'original');});},
  validateArchive(archive){validateSourceClosure(archive);},
 });
 sources.omittedOriginals=repo=>omissions(repo,'sources').any();
 return [sources,createImportsOwner(repository,environment,readOwner),createEvidenceOwner(repository,environment),createBrowserOwner(repository),createWorkflowOwner(repository)];
}

function validateSourceClosure(archive:ValidatedWorkspaceArchive):void {
 const records=archive.records.filter(r=>r.moduleId==='sources');
 const captures=new Map(records.filter(r=>r.schemaId==='capture').map(r=>{const v=sourceCapture.parse(r.value);return [v.captureId,v];}));
 const artifacts=new Map(records.filter(r=>r.schemaId==='artifact').map(r=>{const v=sourceArtifact.parse(r.value);return [v.artifact.artifactId,v];}));
 const core=(ref:{entityType:string;id:string;revision:number})=>archive.records.find(r=>r.moduleId==='core'&&r.key===`${ref.entityType}/${ref.id}/${ref.revision}`)?.value;
 for(const v of captures.values()){
  const c=captureSchema.parse(core(v.evidence.result.captureRef));
  if(c.id!==v.captureId||c.operationId!==v.operationId||c.operationId!==v.evidence.request.operationId||c.sourceId!==v.evidence.request.sourceRef.id||stableJson(c.mappingRef)!==stableJson(v.evidence.request.mappingRef)||c.payloadHash!==v.evidence.raw.payloadHash||stableJson(c.rawRows)!==stableJson(v.evidence.raw.rawRows)||c.acceptedRows!==v.evidence.result.acceptedRows||c.rejectedRows!==v.evidence.result.rejectedRows||v.evidence.contextKey!==hash(Buffer.from(stableJson(v.evidence.request.context))))invalid();
  if(!core(v.evidence.request.goalRef)||!core(v.evidence.request.sourceRef)||!core(v.evidence.request.mappingRef))invalid();
  if(v.evidence.raw.artifact){const a=artifacts.get(v.evidence.raw.artifact.artifactId);if(!a||stableJson(a.owner)!==stableJson(v.owner)||stableJson(a.artifact)!==stableJson(v.evidence.raw.artifact)||c.rawArtifactId!==a.artifact.artifactId||c.payloadHash!==a.artifact.hash)invalid();}else if(c.rawArtifactId!==null)invalid();
  for(const ref of v.evidence.factRefs){const f=observedFactSchema.parse(core(ref));if(ref.entityType!=='observed_fact'||f.sourceId!==c.sourceId)invalid();}
 }
 for(const r of records){if(r.schemaId==='success'||r.schemaId==='attempt'){const v=r.schemaId==='success'?success.parse(r.value):attempt.parse(r.value),capture=captures.get(v.captureId);if(!capture||capture.evidence.request.goalRef.id!==v.goalId||capture.evidence.contextKey!==v.contextKey||stableJson(capture.owner)!==stableJson(v.owner)||r.schemaId==='success'&&captureSchema.parse(core(capture.evidence.result.captureRef)).result!=='accepted'||'sourceId'in v&&v.sourceId!==capture.evidence.request.sourceRef.id)invalid();}
  if(r.schemaId==='binding'){const v=bindingSchema.parse(r.value);for(const ref of [v.goalRef,v.sourceRef,v.mappingRef,v.assignmentRef,v.methodRef,...v.metricRefs,...v.directoryEntityRefs,...v.directoryLinkRefs,...(v.templateRef?[v.templateRef]:[])])if(!core(ref))invalid();}
 }
}

const importPreview=z.strictObject({value:portableImportPreviewSchema,selectionDigest:sha.nullable(),result:importApplyResultSchema.nullable()}).refine(v=>(v.selectionDigest===null)===(v.result===null));
const importGroup=z.strictObject({owner:ownerSchema,sourceId:uuidSchema,mappingId:uuidSchema,mappingRevision:z.number().int().positive(),groupKey:z.string().min(1),members:z.array(z.string())});
const upload=z.strictObject({owner:ownerSchema,file:fileHandleViewSchema,purpose:z.literal('goal-import')});
function createImportsOwner(repository:WorkbenchRepository,environment:ProductionArchiveEnvironment,readOwner:(repo:WorkbenchRepository,moduleId:string,key:string,installationId:string)=>Owner):ProductionArchiveOwner {
 const groupKey=(v:z.infer<typeof importGroup>)=>stableJson([v.sourceId,v.mappingId,v.mappingRevision,v.groupKey]);
 const owner=makeOwner('imports',{
  preview:{schema:importPreview,key:v=>v.value.view.previewToken,owner:v=>ownerOf('',v.value.personId)},
  group:{schema:importGroup,key:groupKey,owner:v=>v.owner},
  upload:{schema:upload,key:v=>v.file.fileHandle,owner:v=>v.owner,refs:v=>[fileRef(v.file.sha256,v.file.bytes,'original')]},
 },{
  exportRecords(repo){const s=repo.sqlForModule('imports'),out:WorkspaceArchiveRecord[]=[],uploads=new Map<string,z.infer<typeof upload>>();
   for(const row of s.all<{token:string;installation_id:string;person_id:string;goal_id:string;file_handle:string;configuration_revision:string;value_json:string;selection_digest:string|null;result_json:string|null}>('SELECT * FROM wb_imports_previews ORDER BY token')){
    const original=JSON.parse(row.value_json) as ImportPreviewRecord,{installationId,...stored}=original;
    const {profileRef:_profileRef,adapterKey:_adapterKey,...binding}=stored.binding;
    const value=portableImportPreviewSchema.parse({...stored,binding});
    if(installationId!==row.installation_id||value.personId!==row.person_id||value.goalId!==row.goal_id||value.file.fileHandle!==row.file_handle||value.binding.configurationRevision!==row.configuration_revision||value.view.previewToken!==row.token)invalid();
    const item=importPreview.parse({value,selectionDigest:row.selection_digest,result:row.result_json?JSON.parse(row.result_json):null});
    out.push(record('imports','preview',row.token,item));
    const metadata={owner:ownerOf(installationId,value.personId),file:value.file,purpose:'goal-import' as const},old=uploads.get(row.file_handle);if(old&&stableJson(old)!==stableJson(metadata))invalid();uploads.set(row.file_handle,metadata);
   }
   for(const row of s.all<{installation_id:string;source_id:string;mapping_id:string;mapping_revision:number;group_key:string;members_json:string}>('SELECT * FROM wb_imports_groups ORDER BY source_id,mapping_id,mapping_revision,group_key')){
    const key=stableJson([row.source_id,row.mapping_id,row.mapping_revision,row.group_key]);const value=importGroup.parse({owner:readOwner(repo,'imports',key,row.installation_id),sourceId:row.source_id,mappingId:row.mapping_id,mappingRevision:row.mapping_revision,groupKey:row.group_key,members:JSON.parse(row.members_json)});out.push(record('imports','group',key,value));
   }
   for(const [key,value] of uploads)out.push(record('imports','upload',key,value));for(const r of out)owner.validate(r);omissions(repo,'imports').assertCoverage(new Map([...uploads].map(([key,v])=>[key,{sha256:v.file.sha256,bytes:v.file.bytes}])));return out;
  },
  restoreRecords(repo,records,context){if(records.length&&!context)invalid();const s=repo.sqlForModule('imports');for(const r of records){owner.validate(r);switch(r.schemaId){
   case 'preview':{const v=importPreview.parse(r.value);authorizeOwner(ownerOf('',v.value.personId),context!.personId,context!.installationId);if(!records.some(x=>x.schemaId==='upload'&&x.key===v.value.file.fileHandle&&(x.value as z.infer<typeof upload>).owner.personId===v.value.personId))invalid();const value={...v.value,installationId:context!.installationId,binding:{...v.value.binding,adapterKey:'restored-history',profileRef:null}};s.run('INSERT INTO wb_imports_previews VALUES(?,?,?,?,?,?,?,?,?)',[v.value.view.previewToken,context!.installationId,v.value.personId,v.value.goalId,v.value.file.fileHandle,v.value.binding.configurationRevision,stableJson(value),v.selectionDigest,v.result?stableJson(v.result):null]);break;}
   case 'group':{const v=importGroup.parse(r.value);authorizeOwner(v.owner,context!.personId,context!.installationId);createWorkspaceOwnership(repo).bind({moduleId:'imports',key:groupKey(v),installationId:context!.installationId,personId:v.owner.personId,provenance:'restore'});s.run('INSERT INTO wb_imports_groups VALUES(?,?,?,?,?,?)',[context!.installationId,v.sourceId,v.mappingId,v.mappingRevision,v.groupKey,stableJson(v.members)]);break;}
   case 'upload':{const v=upload.parse(r.value);authorizeOwner(v.owner,context!.personId,context!.installationId);if(!records.some(x=>x.schemaId==='preview'&&(x.value as z.infer<typeof importPreview>).value.file.fileHandle===v.file.fileHandle))invalid();const original=omissions(repo,'imports').restore(v.file.fileHandle,fileRef(v.file.sha256,v.file.bytes,'original'),context);if(!original)break;hydrateReferencedFileSync(path.dirname(context!.subjectPath('uploads',v.file.fileHandle)),{...v.file,purpose:'goal-import',installationId:context!.installationId,profilePersonId:v.owner.personId,bytesValue:original});break;}
  }}},
  async files(repo,records){return records.filter(r=>r.schemaId==='upload'&&!omissions(repo,'imports').read(r.key)).map(r=>{owner.validate(r);const v=upload.parse(r.value),bytes=readReferencedFileSync(path.join(environment.subjectRoot(),'uploads'),v.file.fileHandle,environment.installationId,v.owner.personId);if(bytes.sha256!==v.file.sha256||bytes.bytes!==v.file.bytes)invalid();return fileSource(bytes.bytesValue,'original');});},
  validateArchive(archive){const records=archive.records.filter(r=>r.moduleId==='imports'),uploads=new Map(records.filter(r=>r.schemaId==='upload').map(r=>[r.key,upload.parse(r.value)])),previews=records.filter(r=>r.schemaId==='preview').map(r=>importPreview.parse(r.value));for(const p of previews){const file=uploads.get(p.value.file.fileHandle);if(!file||file.owner.personId!==p.value.personId||stableJson(file.file)!==stableJson(p.value.file)||p.value.capture.sourceId!==p.value.binding.source.id||p.value.goalId!==p.value.binding.goal.id)invalid();}for(const file of uploads.values())if(!previews.some(p=>p.value.file.fileHandle===file.file.fileHandle&&p.value.personId===file.owner.personId))invalid();for(const r of records.filter(r=>r.schemaId==='group')){const group=importGroup.parse(r.value);if(!previews.some(p=>p.value.personId===group.owner.personId&&p.value.binding.source.id===group.sourceId&&p.value.binding.mappingRef.id===group.mappingId&&p.value.binding.mappingRef.revision===group.mappingRevision&&Object.hasOwn(p.value.groupMembership,group.groupKey)))invalid();}},
 });owner.omittedOriginals=repo=>omissions(repo,'imports').any();return owner;
}

const evidenceMetadata=z.strictObject({artifactId:uuidSchema,evidenceId:uuidSchema,owner:z.strictObject({personId:uuidSchema.nullable(),installationId:z.null()}),name:z.string().min(1).max(255),mimeType:z.string().min(1).max(150),bytes:count,sha256:sha});
type EvidenceRow={artifact_id:string;evidence_id:string;installation_id:string;owner_person_id:string;name:string;mime_type:string;bytes:number;sha256:string};
function createEvidenceOwner(_repository:WorkbenchRepository,environment:ProductionArchiveEnvironment):ProductionArchiveOwner {
 const shapes:Record<string,Shape>={private:{schema:evidenceMetadata,key:v=>v.artifactId,owner:v=>v.owner,refs:v=>[fileRef(v.sha256,v.bytes,'evidence')]},published:{schema:evidenceMetadata,key:v=>v.artifactId,refs:v=>[fileRef(v.sha256,v.bytes,'evidence')]}};
 const matches=(value:unknown,v:z.infer<typeof evidenceMetadata>)=>{const e=evidenceSchema.safeParse(value);return e.success&&e.data.id===v.evidenceId&&e.data.kind==='file'&&e.data.file.artifactId===v.artifactId&&e.data.file.bytes===v.bytes&&e.data.file.hash==='sha256:'+v.sha256&&e.data.file.mimeType===v.mimeType;};
 const closure=(repo:WorkbenchRepository,kind:string,v:z.infer<typeof evidenceMetadata>,installationId:string)=>{
  if(kind==='published'){const e=repo.readPublishedEvidenceForArtifact(v.artifactId),anchor=e?.publicationAnchorId?repo.readPublicationAnchor({entityType:'publication_anchor',id:e.publicationAnchorId}):null;if(!matches(e,v)||anchor?.publicationState!=='confirmed')invalid();}
  else {const s=repo.sqlForModule('drafts');const rows=s.all<{header_json:string;definition_json:string}>('SELECT r.header_json,r.definition_json FROM wb_drafts_revisions r JOIN wb_drafts_entries e ON e.draft_id=r.draft_id JOIN wb_drafts_packages p ON p.package_id=e.package_id WHERE e.entity_type=? AND e.object_id=? AND p.installation_id=? AND p.owner_person_id=?',['evidence',v.evidenceId,installationId,v.owner.personId]);if(!rows.some(row=>matches({...JSON.parse(row.header_json),...JSON.parse(row.definition_json)},v)))invalid();}
 };
 const owner=makeOwner('evidence',shapes,{
  exportRecords(repo){const s=repo.sqlForModule('evidence'),out:WorkspaceArchiveRecord[]=[];for(const kind of ['private','published'] as const){const rows=kind==='private'?s.all<EvidenceRow>('SELECT * FROM wb_evidence_artifacts ORDER BY artifact_id'):s.all<EvidenceRow>('SELECT * FROM wb_evidence_published_artifacts ORDER BY artifact_id');for(const row of rows){const v=evidenceMetadata.parse({artifactId:row.artifact_id,evidenceId:row.evidence_id,owner:{personId:row.owner_person_id||null,installationId:null},name:row.name,mimeType:row.mime_type,bytes:row.bytes,sha256:row.sha256});assertFileName(v.name);closure(repo,kind,v,row.installation_id);out.push(record('evidence',kind,v.artifactId,v));}}return out;},
  restoreRecords(repo,records,context){if(records.length&&!context)invalid();const s=repo.sqlForModule('evidence');for(const r of records){owner.validate(r);const v=evidenceMetadata.parse(r.value);if(r.schemaId==='private')authorizeOwner(v.owner,context!.personId,context!.installationId);closure(repo,r.schemaId,v,context!.installationId);assertFileName(v.name);hydrateEvidence(context,v.artifactId,fileRef(v.sha256,v.bytes,'evidence'));const params=[v.artifactId,v.evidenceId,context!.installationId,v.owner.personId??'',v.name,v.mimeType,v.bytes,v.sha256];if(r.schemaId==='private')s.run('INSERT INTO wb_evidence_artifacts VALUES(?,?,?,?,?,?,?,?)',params);else s.run('INSERT INTO wb_evidence_published_artifacts VALUES(?,?,?,?,?,?,?,?)',params);}},
  async files(_repo,records){return records.map(r=>{owner.validate(r);const v=evidenceMetadata.parse(r.value);return fileSource(ownedBytes(path.join(environment.subjectRoot(),'evidence',v.artifactId),v.sha256,v.bytes),'evidence');});},
  validateArchive(archive){for(const r of archive.records.filter(r=>r.moduleId==='evidence')){const v=evidenceMetadata.parse(r.value);if(r.schemaId==='private'){const packages=new Set(archive.records.filter(p=>p.moduleId==='drafts'&&p.schemaId==='drafts.package'&&(p.value as {ownerPersonId:string}).ownerPersonId===v.owner.personId).map(p=>p.key)),drafts=new Set(archive.records.filter(e=>e.moduleId==='drafts'&&e.schemaId==='drafts.entry'&&packages.has((e.value as {packageId:string}).packageId)&&(e.value as {entityType:string;objectId:string}).entityType==='evidence'&&(e.value as {objectId:string}).objectId===v.evidenceId).map(e=>e.key));if(!archive.records.some(h=>h.moduleId==='drafts'&&h.schemaId==='drafts.revision'&&drafts.has((h.value as {draftId:string}).draftId)&&matches({...((h.value as any).header),...((h.value as any).definition)},v)))invalid();}else{const confirmed=new Set(archive.records.filter(a=>a.moduleId==='core'&&a.schemaId==='core.publication_anchor'&&(a.value as {publicationState:string}).publicationState==='confirmed').map(a=>(a.value as {id:string}).id));if(!archive.records.some(e=>e.moduleId==='core'&&e.schemaId==='core.evidence'&&confirmed.has((e.value as {publicationAnchorId:string}).publicationAnchorId)&&matches(e.value,v)))invalid();}}},
 });return owner;
}

const browserReceipt=z.strictObject({sequence:z.number().int().positive().safe(),owner:ownerSchema,commandId:uuidSchema,draftId:uuidSchema,receipt:browserScenarioReceiptSchema});
function createBrowserOwner(_repository:WorkbenchRepository):ProductionArchiveOwner {
 const owner=makeOwner('browser_scenarios',{receipt:{schema:browserReceipt,key:v=>String(v.sequence),owner:v=>v.owner}},{
  exportRecords(repo){return repo.sqlForModule('browser_scenarios').all<{sequence:number;installation_id:string;person_id:string;command_id:string;draft_id:string;receipt_json:string}>('SELECT * FROM wb_browser_scenarios_tests ORDER BY sequence').map(row=>{const v=browserReceipt.parse({sequence:row.sequence,owner:ownerOf(row.installation_id,row.person_id),commandId:row.command_id,draftId:row.draft_id,receipt:JSON.parse(row.receipt_json)});if(v.receipt.result.draftId!==v.draftId||v.receipt.result.inputHash!==v.receipt.inputHash)invalid();return record('browser_scenarios','receipt',String(v.sequence),v);});},
  restoreRecords(repo,records,context){if(records.length&&!context)invalid();const s=repo.sqlForModule('browser_scenarios');for(const r of records){owner.validate(r);const v=browserReceipt.parse(r.value);authorizeOwner(v.owner,context!.personId,context!.installationId);if(v.receipt.result.draftId!==v.draftId||v.receipt.result.inputHash!==v.receipt.inputHash)invalid();const entry=repo.sqlForModule('drafts').get<{draft_id:string}>('SELECT e.draft_id FROM wb_drafts_entries e JOIN wb_drafts_packages p ON p.package_id=e.package_id WHERE e.draft_id=? AND p.installation_id=? AND p.owner_person_id=?',[v.draftId,context!.installationId,v.owner.personId]);if(!entry)invalid();s.run('INSERT INTO wb_browser_scenarios_tests VALUES(?,?,?,?,?,?)',[v.sequence,context!.installationId,v.owner.personId,v.commandId,v.draftId,stableJson(v.receipt)]);}},
  async files(){return [];},
  validateArchive(archive){for(const r of archive.records.filter(r=>r.moduleId==='browser_scenarios')){const v=browserReceipt.parse(r.value),entry=archive.records.find(e=>e.moduleId==='drafts'&&e.schemaId==='drafts.entry'&&e.key===v.draftId);if(!entry||!archive.records.some(p=>p.moduleId==='drafts'&&p.schemaId==='drafts.package'&&p.key===(entry.value as {packageId:string}).packageId&&(p.value as {ownerPersonId:string}).ownerPersonId===v.owner.personId)||v.receipt.result.draftId!==v.draftId||v.receipt.inputHash!==v.receipt.result.inputHash||v.receipt.evidence&&v.receipt.evidence.owner.profilePersonId!==v.owner.personId)invalid();}},
 });return owner;
}

const workflowDraft=z.strictObject({owner:ownerSchema,id:uuidSchema,revision:z.string().min(1),value:portableOkoWorkflowSchema});
const portableArtifact=z.strictObject({name:z.string().min(1).max(255),mimeType:z.string().min(1).max(150),sha256:sha,bytes:count});
const workflowResult=z.strictObject({owner:ownerSchema,id:uuidSchema,original:portableArtifact,enriched:portableArtifact});
const exportMetaSchema=z.strictObject({id:uuidSchema,workflowId:uuidSchema,title:z.string().max(200),fileName:z.string().max(255),mimeType:z.string().max(150),bytes:count,sha256:sha,capturedAt:z.string().datetime(),sourceDate:z.string().nullable(),rowCount:count.nullable(),origin:z.string().min(1).max(40),deletedAt:z.string().datetime().nullable()});
const workflowExport=z.strictObject({owner:ownerSchema,meta:exportMetaSchema,artifact:portableArtifact,results:z.array(z.never()),captureReceipt:captureReceiptSchema.optional()});
const workflowCapture=z.strictObject({owner:ownerSchema,intent:captureIntentSchema,state:z.enum(['pending','committed','interrupted']),receipt:captureReceiptSchema.nullable()}).superRefine((v,ctx)=>{if((v.state==='committed')!==(v.receipt!==null))ctx.addIssue({code:'custom',message:'Capture state and receipt differ'});});
function createWorkflowOwner(_repository:WorkbenchRepository):ProductionArchiveOwner {
 const parseOwner=(input:string)=>{const parts=input.split('/');if(parts.length!==2)denied();return ownerOf(uuidSchema.parse(parts[0]),parts[1]==='unassigned'?null:uuidSchema.parse(parts[1]));};
 const artifact=(value:z.infer<typeof okoStoredResultSchema>['original'],omitted?:{sha256:string;bytes:number}|null)=>{assertFileName(value.name);if(omitted){if(value.base64!==''||value.hash!==omitted.sha256)invalid();return portableArtifact.parse({name:value.name,mimeType:value.mimeType,sha256:value.hash,bytes:omitted.bytes});}const bytes=Buffer.from(value.base64,'base64');if(bytes.toString('base64')!==value.base64||hash(bytes)!==value.hash)invalid();return portableArtifact.parse({name:value.name,mimeType:value.mimeType,sha256:value.hash,bytes:bytes.length});};
 const checkExport=(v:z.infer<typeof workflowExport>)=>{assertFileName(v.meta.fileName);assertFileName(v.artifact.name);if(v.meta.sha256!==v.artifact.sha256||v.meta.bytes!==v.artifact.bytes||v.meta.fileName!==v.artifact.name||v.meta.mimeType!==v.artifact.mimeType)invalid();if(v.captureReceipt&&(v.captureReceipt.exportId!==v.meta.id||v.captureReceipt.workflowId!==v.meta.workflowId||v.captureReceipt.sha256!==v.meta.sha256||v.captureReceipt.bytes!==v.meta.bytes||v.captureReceipt.mimeType!==v.meta.mimeType||v.captureReceipt.capturedAt!==v.meta.capturedAt))invalid();};
 const owner=makeOwner('oko_workflow',{
  draft:{schema:workflowDraft,key:v=>v.id,owner:v=>v.owner},
  result:{schema:workflowResult,key:v=>v.id,owner:v=>v.owner,refs:v=>[fileRef(v.original.sha256,v.original.bytes,'original'),fileRef(v.enriched.sha256,v.enriched.bytes,'module')]},
  export:{schema:workflowExport,key:v=>v.meta.id,owner:v=>v.owner,refs:v=>[fileRef(v.artifact.sha256,v.artifact.bytes,'original')]},
  capture:{schema:workflowCapture,key:v=>v.intent.captureId,owner:v=>v.owner},
 },{
  exportRecords(repo){const store=createOkoWorkflowStore(repo);store.recoverCaptures();const s=repo.sqlForModule('oko_workflow'),out:WorkspaceArchiveRecord[]=[];
   for(const row of s.all<{owner:string;id:string;revision:string;payload_json:string}>('SELECT * FROM wb_oko_workflow_drafts ORDER BY id')){const stored=persistedOkoWorkflowSchema.parse(JSON.parse(row.payload_json)),{profile:_profile,...view}=stored.view;const value=portableOkoWorkflowSchema.parse({...stored,view});if(row.id!==view.workflowId||row.revision!==value.revision||row.revision!==view.revision)invalid();out.push(record('oko_workflow','draft',row.id,{owner:parseOwner(row.owner),id:row.id,revision:row.revision,value}));}
   for(const row of s.all<{owner:string;id:string;payload_json:string}>('SELECT * FROM wb_oko_workflow_results ORDER BY id')){const result=okoStoredResultSchema.parse(JSON.parse(row.payload_json));out.push(record('oko_workflow','result',row.id,{owner:parseOwner(row.owner),id:row.id,original:artifact(result.original,omissions(repo,'oko_workflow').read(row.id)),enriched:artifact(result.enriched)}));}
   for(const row of s.all<{owner:string;id:string}>('SELECT owner,id FROM wb_oko_workflow_exports ORDER BY id')){const saved=store.getExport(row.owner,row.id)!;const payload=captureExportPayloadSchema.parse(saved.payload);const value=workflowExport.parse({owner:parseOwner(row.owner),meta:saved.meta,artifact:artifact(payload.artifact,omissions(repo,'oko_workflow').read('export:'+row.id)),results:payload.results,...(payload.captureReceipt?{captureReceipt:payload.captureReceipt}:{})});checkExport(value);out.push(record('oko_workflow','export',row.id,value));}
   for(const row of s.all<{owner:string;capture_id:string;operation_id:string;workflow_id:string;intent_json:string;receipt_json:string|null;download_json:string|null;state:string}>('SELECT owner,capture_id,operation_id,workflow_id,intent_json,receipt_json,download_json,state FROM wb_oko_workflow_captures ORDER BY capture_id')){const value=workflowCapture.parse({owner:parseOwner(row.owner),intent:JSON.parse(row.intent_json),state:row.state,receipt:row.receipt_json?JSON.parse(row.receipt_json):null});if(row.download_json!==null||value.intent.captureId!==row.capture_id||value.intent.operationId!==row.operation_id||value.intent.workflowId!==row.workflow_id)invalid();out.push(record('oko_workflow','capture',row.capture_id,value));}
   const refs=new Map<string,{sha256:string;bytes:number}>();for(const r of out){if(r.schemaId==='result'){const v=workflowResult.parse(r.value);refs.set(v.id,v.original);}if(r.schemaId==='export'){const v=workflowExport.parse(r.value);refs.set('export:'+v.meta.id,v.artifact);}}omissions(repo,'oko_workflow').assertCoverage(refs);if(new Set(out.map(r=>stableJson([r.schemaId,r.key]))).size!==out.length)invalid();return out;
  },
  restoreRecords(repo,records,context){if(records.length&&!context)invalid();const s=repo.sqlForModule('oko_workflow');repo.transaction(()=>{for(const r of records){owner.validate(r);const raw=(r.value as {owner:Owner});authorizeOwner(raw.owner,context!.personId,context!.installationId);const ownerKey=`${context!.installationId}/${raw.owner.personId}`;
   const hydrate=(a:z.infer<typeof portableArtifact>,kind:'original'|'module',key:string)=>{assertFileName(a.name);return {name:a.name,mimeType:a.mimeType,base64:Buffer.from(kind==='original'?omissions(repo,'oko_workflow').restore(key,fileRef(a.sha256,a.bytes,kind),context)??new Uint8Array():bytesFor(context,fileRef(a.sha256,a.bytes,kind))).toString('base64'),hash:a.sha256};};
   if(r.schemaId==='draft'){const v=workflowDraft.parse(r.value);if(v.id!==v.value.view.workflowId||v.revision!==v.value.revision||v.revision!==v.value.view.revision)invalid();const value={...v.value,view:{...v.value.view,profile:{sourceId:v.value.view.sourceId,profileId:null,profile:null,revision:null,configured:false,sessionState:'closed'}}};s.run('INSERT INTO wb_oko_workflow_drafts VALUES(?,?,?,?)',[ownerKey,v.id,v.revision,stableJson(value)]);}
   else if(r.schemaId==='result'){const v=workflowResult.parse(r.value);s.run('INSERT INTO wb_oko_workflow_results VALUES(?,?,?)',[ownerKey,v.id,stableJson({original:hydrate(v.original,'original',v.id),enriched:hydrate(v.enriched,'module',v.id)})]);}
   else if(r.schemaId==='export'){const v=workflowExport.parse(r.value);checkExport(v);const payload={artifact:hydrate(v.artifact,'original','export:'+v.meta.id),results:v.results,...(v.captureReceipt?{captureReceipt:v.captureReceipt}:{})};createOkoWorkflowStore(repo).putExport(ownerKey,v.meta,payload);}
   else if(r.schemaId==='capture'){const v=workflowCapture.parse(r.value);s.run('INSERT INTO wb_oko_workflow_captures(owner,capture_id,operation_id,workflow_id,intent_json,receipt_json,download_json,state,staging_json) VALUES(?,?,?,?,?,?,NULL,?,NULL)',[ownerKey,v.intent.captureId,v.intent.operationId,v.intent.workflowId,stableJson(v.intent),v.receipt?stableJson(v.receipt):null,v.state]);}
  }});},
  async files(repo,records){const s=repo.sqlForModule('oko_workflow'),out:WorkspaceArchiveFileSource[]=[];for(const r of records){owner.validate(r);if(r.schemaId==='result'){const v=workflowResult.parse(r.value),rows=s.all<{owner:string;payload_json:string}>('SELECT owner,payload_json FROM wb_oko_workflow_results WHERE id=?',[v.id]);if(rows.length!==1||parseOwner(rows[0].owner).personId!==v.owner.personId)invalid();const value=okoStoredResultSchema.parse(JSON.parse(rows[0].payload_json)),omitted=omissions(repo,'oko_workflow').read(v.id);if(stableJson(artifact(value.original,omitted))!==stableJson(v.original)||stableJson(artifact(value.enriched))!==stableJson(v.enriched))invalid();if(!omitted)out.push(fileSource(Buffer.from(value.original.base64,'base64'),'original'));out.push(fileSource(Buffer.from(value.enriched.base64,'base64'),'module'));}
   if(r.schemaId==='export'){const v=workflowExport.parse(r.value),rows=s.all<{owner:string;payload_json:string}>('SELECT owner,payload_json FROM wb_oko_workflow_exports WHERE id=?',[v.meta.id]);if(rows.length!==1||parseOwner(rows[0].owner).personId!==v.owner.personId)invalid();const value=captureExportPayloadSchema.parse(JSON.parse(rows[0].payload_json)),omitted=omissions(repo,'oko_workflow').read('export:'+v.meta.id);if(stableJson(artifact(value.artifact,omitted))!==stableJson(v.artifact))invalid();if(!omitted)out.push(fileSource(Buffer.from(value.artifact.base64,'base64'),'original'));}
  }return out;},
  validateArchive(archive){const records=archive.records.filter(r=>r.moduleId==='oko_workflow'),sameOwner=(a:Owner,b:Owner)=>stableJson(a)===stableJson(b);for(const r of records){
   if(r.schemaId==='draft'){const v=workflowDraft.parse(r.value),result=v.value.view.result;if(result&&(result.originalDownload!==`/api/v1/browser/results/${result.resultId}/original`||result.enrichedDownload!==`/api/v1/browser/results/${result.resultId}/enriched`||!records.some(row=>row.schemaId==='result'&&row.key===result.resultId&&sameOwner(workflowResult.parse(row.value).owner,v.owner))))invalid();if(v.value.captureId&&!records.some(row=>row.schemaId==='capture'&&row.key===v.value.captureId&&sameOwner(workflowCapture.parse(row.value).owner,v.owner)))invalid();}
   if(r.schemaId==='export'){const v=workflowExport.parse(r.value);checkExport(v);if(v.captureReceipt&&!records.some(row=>row.schemaId==='capture'&&row.key===v.captureReceipt!.captureId&&sameOwner(workflowCapture.parse(row.value).owner,v.owner)))invalid();}
   if(r.schemaId==='capture'){const v=workflowCapture.parse(r.value);if(v.receipt){if(v.receipt.captureId!==v.intent.captureId||v.receipt.operationId!==v.intent.operationId||v.receipt.workflowId!==v.intent.workflowId)invalid();const row=records.find(row=>row.schemaId==='export'&&row.key===v.receipt!.exportId);if(!row)invalid();const exported=workflowExport.parse(row.value);if(!sameOwner(exported.owner,v.owner)||stableJson(exported.captureReceipt)!==stableJson(v.receipt))invalid();}}
  }},
 });owner.omittedOriginals=repo=>omissions(repo,'oko_workflow').any();return owner;
}
