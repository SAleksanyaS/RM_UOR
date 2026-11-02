import { randomUUID } from 'node:crypto';
import { lstat,mkdir,readFile,realpath,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backup,DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import { z } from 'zod';
import { uuidSchema,type Clock } from '../../domain/workbench/primitives';
import { createWorkbenchRepository,type WorkbenchRepository } from '../storage/workbench-repository';
import { createSubjectArchiveOwners } from '../../features/workspace-maintenance/workbench/subject-archive-owners';
import { createSourceArchiveOwners } from '../../features/workspace-maintenance/workbench/source-archive-owners';
import type { ProductionArchiveEnvironment,ProductionArchiveOwner } from '../../features/workspace-maintenance/workbench/production-archive-contracts';
import { archiveManifestSchema,archiveRecordSchema,type ValidatedWorkspaceArchive,type WorkspaceArchiveRecord,type WorkspaceArchiveFileSource,type WorkspaceArchiveRestoreContext } from '../../features/workspace-maintenance/workbench/contracts';
import { archiveHash,privateExclusions,workspaceRevision } from '../../features/workspace-maintenance/workbench/workspace-archive';
import { assertJsonSafety,loadPortableZip } from '../../features/workspace-maintenance/zip';
import { durableWrite,ensurePhysicalDirectory,readPrivate } from '../../features/workspace-maintenance/workbench/private-storage';
import { assertPhysicalPath } from './files';
import { WorkbenchHttpError } from './protocol';
import { createCommandStore } from './command-store';
import { createJobStore } from './jobs';
import { createWorkbenchReadIndex } from '../../features/catalog/workbench-read-index';

const identitySchema=z.strictObject({installationId:uuidSchema});
const unknown=():never=>{throw new WorkbenchHttpError(409,'WORKSPACE_LAYOUT_MIGRATION_REQUIRED','Existing Workbench layout is retained and requires a recognized, owned local-preview migration');};
const invalid=():never=>{throw new WorkbenchHttpError(422,'INTEGRITY_MISMATCH','Legacy layout adoption or its independent rescue did not verify');};
const denied=():never=>{throw new WorkbenchHttpError(403,'ACCESS_DENIED','Legacy layout adoption requires the exact trusted local-preview installation/person');};
const samePath=(a:string,b:string)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const databaseFiles=['workbench.sqlite','workbench.sqlite-wal','workbench.sqlite-shm'] as const;
type OriginalImage={name:typeof databaseFiles[number]|'installation.json';bytes:Buffer|null};

/** Exhaustive fixed owner tables plus explicitly excluded local configuration/operation tables.
 * The catalog is only checked against this set; catalog text never becomes SQL or an exporter. */
const knownTables=new Set([
 'sqlite_sequence','sqlite_stat1','sqlite_stat4',
 'wb_schema_migrations','wb_meta','wb_entity_versions','wb_entity_heads','wb_publication_anchors','wb_fact_index','wb_capture_index','wb_applicability_index','wb_correction_index','wb_evaluation_digest','wb_history_observations','wb_history_snapshots','wb_read_catalog',
 'wb_drafts_packages','wb_drafts_entries','wb_drafts_revisions','wb_drafts_derived','wb_drafts_evaluation_digest','wb_drafts_proofs','wb_drafts_frozen','wb_execution_completions',
 'wb_notifications_events','wb_notifications_subscriptions','wb_notifications_occurrences','wb_preferences_personal','wb_ownership_bindings',
 'wb_sources_bindings','wb_sources_adapters','wb_sources_contexts','wb_sources_captures','wb_sources_success','wb_sources_attempts','wb_sources_git','wb_sources_artifacts','wb_sources_original_omissions',
 'wb_imports_previews','wb_imports_groups','wb_imports_original_omissions','wb_evidence_artifacts','wb_evidence_published_artifacts','wb_browser_scenarios_tests','wb_oko_workflow_drafts','wb_oko_workflow_results','wb_oko_workflow_original_omissions','wb_oko_workflow_exports','wb_oko_workflow_captures',
 'wb_publishing_reservations','wb_publishing_packages','wb_publishing_tokens','wb_publishing_prepared','wb_publishing_delivery_jobs','wb_publishing_effects','wb_publishing_applied','wb_publishing_portable_prepared',
 'wb_legacy_migration_records','wb_legacy_migration_files','wb_legacy_migration_omissions','wb_commands_intents','wb_jobs_heads','wb_jobs_events','wb_jobs_checkpoints',
]);
const requiredPersonalTables=['wb_meta','wb_schema_migrations','wb_entity_versions','wb_entity_heads','wb_publication_anchors','wb_oko_workflow_drafts','wb_oko_workflow_results'];

async function optionalPhysicalFile(filename:string,maxBytes=1024**3):Promise<Buffer|null>{
 try{await assertPhysicalPath(filename,false);const stat=await lstat(filename);if(!stat.isFile()||stat.nlink!==1||stat.size>maxBytes)return invalid();const bytes=await readFile(filename);if(bytes.length!==stat.size)return invalid();return bytes;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
async function captureOriginals(runtimeRoot:string):Promise<OriginalImage[]>{return Promise.all([...databaseFiles,'installation.json' as const].map(async name=>({name,bytes:await optionalPhysicalFile(path.join(runtimeRoot,name),name==='installation.json'?32768:1024**3)})));}
function originalsEqual(a:OriginalImage[],b:OriginalImage[]):boolean{return a.length===b.length&&a.every((v,i)=>v.name===b[i].name&&(v.bytes===null?b[i].bytes===null:b[i].bytes!==null&&v.bytes.equals(b[i].bytes!)));}
function originalFingerprint(images:OriginalImage[]):string{return archiveHash(JSON.stringify(images.map(v=>({name:v.name,sha256:v.bytes?archiveHash(v.bytes):null,bytes:v.bytes?.length??null}))));}

export type LegacyRuntimeLayout={kind:'none'}|{kind:'personal';installationId:string};
/** Read only fixed paths. Unknown databases fail before creating an identity, pointer or directory. */
export async function inspectLegacyRuntimeLayout(runtimeRoot:string):Promise<LegacyRuntimeLayout>{
 const database=await optionalPhysicalFile(path.join(runtimeRoot,'workbench.sqlite'));
 if(!database){for(const name of databaseFiles.slice(1))if(await optionalPhysicalFile(path.join(runtimeRoot,name)))return unknown();return{kind:'none'};}
 const identity=await optionalPhysicalFile(path.join(runtimeRoot,'installation.json'),32768);if(!identity)return unknown();
 let value:unknown;try{value=JSON.parse(identity.toString('utf8'));}catch{return unknown();}const parsed=identitySchema.safeParse(value);if(!parsed.success)return unknown();return{kind:'personal',installationId:parsed.data.installationId};
}

export type LegacyLayoutAdoptionInput={runtimeRoot:string;managedRoot?:string;rescueRoot?:string;installationId:string;personId:string;repositoryId:string;clock:Clock;applicationVersion:string;localPreview:boolean};
export type LegacyLayoutAdoptionResult={newRoot:string;stateRevision:string;sourceFingerprint:string;rescue:{archivePath:string;archiveSha256:string;bytes:number;records:number;files:number}};
function ownersFor(repository:WorkbenchRepository,environment:ProductionArchiveEnvironment){const owners=[...createSubjectArchiveOwners(repository,environment),...createSourceArchiveOwners(repository,environment)];if(owners.length!==14||new Set(owners.map(o=>o.moduleId)).size!==14)return invalid();return owners;}
function trustedColumnInventory(filename:string,artifactRoot:string,input:LegacyLayoutAdoptionInput):Map<string,Map<string,string>>{
 const repository=createWorkbenchRepository({filename,artifactRoot});
 try{ownersFor(repository,{installationId:input.installationId,personId:()=>input.personId,localPreview:false,subjectRoot:()=>artifactRoot});createCommandStore(repository);createJobStore({repository,clock:input.clock});createWorkbenchReadIndex(repository);}finally{repository.close();}
 const database=new DatabaseSync(filename,{readOnly:true});
 try{const inventory=new Map<string,Map<string,string>>();for(const name of knownTables){const columns=database.prepare('SELECT name,type FROM pragma_table_info(?) ORDER BY cid').all(name) as Array<{name:string;type:string}>;if(columns.length)inventory.set(name,new Map(columns.map(c=>[c.name,c.type.toUpperCase()])));}inventory.set('sqlite_stat1',new Map([['tbl',''],['idx',''],['stat','']]));inventory.set('sqlite_stat4',new Map([['tbl',''],['idx',''],['neq',''],['nlt',''],['ndlt',''],['sample','']]));return inventory;}finally{database.close();}
}
function order(records:WorkspaceArchiveRecord[]){return records.sort((a,b)=>JSON.stringify([a.moduleId,a.schemaId,a.key]).localeCompare(JSON.stringify([b.moduleId,b.schemaId,b.key])));}
function validateInventory(owners:ProductionArchiveOwner[],archive:ValidatedWorkspaceArchive,personId:string,installationId:string){
 const byId=new Map(owners.map(o=>[o.moduleId,o])),keys=new Set<string>(),refs=new Map<string,number>();assertJsonSafety(archive.records);
 for(const record of archive.records){archiveRecordSchema.parse(record);const key=JSON.stringify([record.moduleId,record.schemaId,record.key]);if(keys.has(key))invalid();keys.add(key);const owner=byId.get(record.moduleId)??invalid();owner.validate(record);}
 for(const owner of owners){const records=archive.records.filter(r=>r.moduleId===owner.moduleId);owner.authorize(records,personId,installationId);owner.validateArchive?.(archive);for(const ref of owner.fileReferences(records)){const key='files/'+ref.sha256,old=refs.get(key);if(old!==undefined&&old!==ref.bytes)invalid();refs.set(key,ref.bytes);const bytes=archive.files.get(key);if(!bytes){if(ref.kind==='original'&&archive.manifest.exclusions.includes('originals'))continue;return invalid();}if(bytes.length!==ref.bytes||archiveHash(bytes)!==ref.sha256)invalid();}}
 for(const file of archive.manifest.files){const bytes=archive.files.get(file.path);if(refs.get(file.path)!==file.bytes||!bytes||file.path!=='files/'+file.sha256||bytes.length!==file.bytes||archiveHash(bytes)!==file.sha256)invalid();}
 if(archive.files.size!==archive.manifest.files.length)invalid();
}
async function collect(repository:WorkbenchRepository,owners:ProductionArchiveOwner[],input:LegacyLayoutAdoptionInput):Promise<{archive:ValidatedWorkspaceArchive;sources:WorkspaceArchiveFileSource[];revision:string}>{
 const records=order(repository.transaction(()=>owners.flatMap(owner=>owner.exportRecords(repository))));
 const sourcesByHash=new Map<string,WorkspaceArchiveFileSource>(),priority={original:0,module:1,evidence:2};
 for(const owner of owners)for(const file of await owner.files(repository,records.filter(r=>r.moduleId===owner.moduleId))){const sha256=archiveHash(file.bytesValue);if(file.path!=='files/'+sha256)invalid();const prior=sourcesByHash.get(file.path);if(prior&&!Buffer.from(prior.bytesValue).equals(Buffer.from(file.bytesValue)))invalid();if(!prior||priority[file.kind]>priority[prior.kind])sourcesByHash.set(file.path,{...file,bytesValue:new Uint8Array(file.bytesValue)});}
 const sources=[...sourcesByHash.values()].sort((a,b)=>a.path.localeCompare(b.path)),omitted=owners.some(owner=>owner.omittedOriginals?.(repository)===true);
 const manifest=archiveManifestSchema.parse({format:'uor-workspace-v1',version:1,applicationVersion:input.applicationVersion,storageSchemaVersion:1,createdAt:input.clock.now(),actor:{hostname:'layout-adoption',installationId:input.installationId,profilePersonId:input.personId},recordsSha256:archiveHash(JSON.stringify(records)),files:sources.map(f=>({path:f.path,kind:f.kind,sha256:archiveHash(f.bytesValue),bytes:f.bytesValue.length})),exclusions:[...privateExclusions,'local-operations',...(omitted?['originals']:[])]});
 const archive={manifest,records,files:new Map(sources.map(f=>[f.path,f.bytesValue]))};validateInventory(owners,archive,input.personId,input.installationId);return{archive,sources,revision:workspaceRevision(input.repositoryId,records,manifest.files)};
}
async function readRescue(bytes:Buffer,owners:ProductionArchiveOwner[],input:LegacyLayoutAdoptionInput):Promise<ValidatedWorkspaceArchive>{
 const zip=await loadPortableZip(bytes),manifest=archiveManifestSchema.parse(JSON.parse(await zip.file('manifest.json')!.async('text'))),raw=await zip.file('records.json')!.async('uint8array');if(archiveHash(raw)!==manifest.recordsSha256)invalid();
 const records=z.array(archiveRecordSchema).max(1000000).parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw))),files=new Map<string,Uint8Array>(),expected=new Set(['manifest.json','records.json','files/']);
 for(const descriptor of manifest.files){if(files.has(descriptor.path)||!zip.file(descriptor.path))invalid();files.set(descriptor.path,await zip.file(descriptor.path)!.async('uint8array'));expected.add(descriptor.path);}for(const name of Object.keys(zip.files))if(!expected.has(name))invalid();const archive={manifest,records,files};validateInventory(owners,archive,input.personId,input.installationId);return archive;
}
function contextFor(newRoot:string,input:LegacyLayoutAdoptionInput,archive:ValidatedWorkspaceArchive):WorkspaceArchiveRestoreContext{return Object.freeze({installationId:input.installationId,personId:input.personId,stagedRoot:newRoot,originalsOmitted:archive.manifest.exclusions.includes('originals'),files:archive.files,subjectPath(namespace:'evidence'|'uploads'|'publishing'|'legacy',relative:string){if(!['evidence','uploads','publishing','legacy'].includes(namespace)||!relative||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(relative)||/[\x00-\x1f:]/.test(relative))return invalid();const target=path.resolve(newRoot,namespace,relative),prefix=path.resolve(newRoot,namespace)+path.sep;if(!target.startsWith(prefix))return invalid();return target;}});}

/** A reversible, typed clone. The caller alone may subsequently write identity/pointer state.
 * Original DB/WAL/SHM are copied by their fixed names before SQLite touches a copy. This avoids
 * readonly SQLite creating or updating original WAL sidecars. Both source fingerprints must agree. */
export async function adoptLegacyRuntimeLayout(input:LegacyLayoutAdoptionInput):Promise<LegacyLayoutAdoptionResult>{
 const layout=await inspectLegacyRuntimeLayout(input.runtimeRoot);if(layout.kind!=='personal')return unknown();
 uuidSchema.parse(input.installationId);uuidSchema.parse(input.personId);if(!input.localPreview||layout.installationId!==input.installationId||input.personId!==input.installationId)return denied();if(!input.repositoryId.trim())return invalid();
 const runtimeRoot=path.resolve(input.runtimeRoot),managedRoot=path.join(runtimeRoot,'subject'),rescueRoot=path.join(runtimeRoot,'maintenance','layout-rescue');if(input.managedRoot&&!samePath(input.managedRoot,managedRoot)||input.rescueRoot&&!samePath(input.rescueRoot,rescueRoot))return invalid();
 const before=await captureOriginals(runtimeRoot);if(!before[0].bytes||!before[3].bytes)return unknown();if(identitySchema.parse(JSON.parse(before[3].bytes.toString('utf8'))).installationId!==input.installationId)return denied();
 const operationId=randomUUID(),temporaryRoot=await realpath(tmpdir()),workingRoot=path.join(temporaryRoot,'uor-layout-adoption-work-'+operationId);await mkdir(workingRoot,{mode:0o700});
 let clone:WorkbenchRepository|null=null,target:WorkbenchRepository|null=null;
 try{
  for(const image of before.filter(v=>v.name!=='installation.json'&&v.bytes!==null))await writeFile(path.join(workingRoot,image.name),image.bytes!,{flag:'wx',mode:0o600});
  if(!originalsEqual(before,await captureOriginals(runtimeRoot)))return invalid();
  const expectedColumns=trustedColumnInventory(path.join(workingRoot,'reference.sqlite'),path.join(workingRoot,'reference-artifacts'),input);
  const copied=new DatabaseSync(path.join(workingRoot,'workbench.sqlite'),{readOnly:true});
  const cloneFilename=path.join(workingRoot,'owned-clone.sqlite');
  try{const catalog=copied.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','view','trigger')").all() as Array<{name:string;type:string}>;const tables=new Set(catalog.map(t=>t.name));if(catalog.some(t=>t.type!=='table'||!knownTables.has(t.name))||requiredPersonalTables.some(name=>!tables.has(name)))return unknown();for(const table of catalog){const expected=expectedColumns.get(table.name)??unknown(),columns=copied.prepare('SELECT name,type FROM pragma_table_info(?) ORDER BY cid').all(table.name) as Array<{name:string;type:string}>;if(columns.some(c=>expected.get(c.name)!==c.type.toUpperCase()))return unknown();}await backup(copied,cloneFilename);}finally{copied.close();}
  clone=createWorkbenchRepository({filename:cloneFilename,artifactRoot:path.join(workingRoot,'artifacts')});
  const environment:ProductionArchiveEnvironment={installationId:input.installationId,personId:()=>input.personId,localPreview:true,subjectRoot:()=>runtimeRoot},owners=ownersFor(clone,environment),snapshot=await collect(clone,owners,input);
  const zip=new JSZip();zip.file('manifest.json',JSON.stringify(snapshot.archive.manifest));zip.file('records.json',JSON.stringify(snapshot.archive.records));for(const file of snapshot.sources)zip.file(file.path,file.bytesValue);const bytes=await zip.generateAsync({type:'nodebuffer',compression:'STORE',platform:'DOS'}),archiveSha256=archiveHash(bytes),rescueName=operationId+'.zip';
  await ensurePhysicalDirectory(rescueRoot);await durableWrite(rescueRoot,rescueName,bytes);const saved=await readPrivate(rescueRoot,rescueName);if(saved.length!==bytes.length||archiveHash(saved)!==archiveSha256)return invalid();const verified=await readRescue(saved,owners,input);
  await durableWrite(rescueRoot,operationId+'.json',JSON.stringify({version:1,archiveSha256,bytes:saved.length,repositoryId:input.repositoryId,installationId:input.installationId,personId:input.personId,sourceFingerprint:originalFingerprint(before),stateRevision:snapshot.revision,createdAt:input.clock.now()}));
  await ensurePhysicalDirectory(managedRoot);const newRoot=path.join(managedRoot,'restore-'+operationId);await mkdir(newRoot,{mode:0o700});target=createWorkbenchRepository({filename:path.join(newRoot,'workbench.sqlite'),artifactRoot:path.join(newRoot,'files')});const targetOwners=ownersFor(target,{...environment,localPreview:false,subjectRoot:()=>newRoot}),context=contextFor(newRoot,input,verified);
  target.transaction(()=>{for(const owner of targetOwners)owner.restoreRecords(target!,verified.records.filter(r=>r.moduleId===owner.moduleId),context);});
  const actual=await collect(target,targetOwners,input);if(actual.revision!==snapshot.revision||JSON.stringify(actual.archive.records)!==JSON.stringify(verified.records))return invalid();
  if(!originalsEqual(before,await captureOriginals(runtimeRoot)))return invalid();target.close();target=null;
  return{newRoot,stateRevision:snapshot.revision,sourceFingerprint:originalFingerprint(before),rescue:{archivePath:path.join(rescueRoot,rescueName),archiveSha256,bytes:saved.length,records:verified.records.length,files:verified.manifest.files.length}};
 }finally{
  target?.close();clone?.close();
  if(path.dirname(workingRoot)!==temporaryRoot||path.basename(workingRoot)!=='uor-layout-adoption-work-'+operationId)return invalid();await assertPhysicalPath(workingRoot,true);await rm(workingRoot,{recursive:true,force:true});
 }
}
