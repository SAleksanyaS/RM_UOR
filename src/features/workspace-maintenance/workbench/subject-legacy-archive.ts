import { mkdirSync,readFileSync,writeFileSync,lstatSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { uuidSchema } from '../../../domain/workbench/primitives';
import { createWorkspaceOwnership } from '../../../server/storage/workbench-ownership';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { createLegacyMigrationArchiveCodec,legacyImportSchema } from '../../migration/workbench/contracts';
import { hashBytes } from '../../publishing/workbench/package-manifest';
import type { ProductionArchiveEnvironment,ProductionArchiveOwner } from './production-archive-contracts';
import type { WorkspaceArchiveFileSource,WorkspaceArchiveRecord } from './contracts';
const fail=():never=>{throw new WorkbenchHttpError(422,'LEGACY_ARCHIVE_INVALID','Legacy subject closure or file integrity is invalid');};
const denied=():never=>{throw new WorkbenchHttpError(403,'ACCESS_DENIED','Legacy history requires its trusted person owner');};
const accessSchema=z.strictObject({recordKey:z.string().min(1),personId:uuidSchema});
const fileSchema=z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative().safe(),kind:z.enum(['evidence','original','module']),personId:uuidSchema});
/** Called only by the trusted migration adapter, with its authenticated immutable request context. */
export function prepareLegacySubjectRecords(input:{records:readonly WorkspaceArchiveRecord[];files:readonly WorkspaceArchiveFileSource[]},context:{installationId:string;personId:string|null}):WorkspaceArchiveRecord[]{
 if(!context.personId)return denied();uuidSchema.parse(context.installationId);const personId=uuidSchema.parse(context.personId),base=createLegacyMigrationArchiveCodec();
 const records=input.records.map(r=>{base.validate(r);return structuredClone(r);});
 return[...records,...records.map(r=>({moduleId:'legacy_migration',schemaId:'legacy.ownership',schemaVersion:1,key:r.key,value:{recordKey:r.key,personId}})),...input.files.map(f=>{const sha256=hashBytes(f.bytesValue);if(f.path!=='files/'+sha256)fail();return{moduleId:'legacy_migration',schemaId:'legacy.file',schemaVersion:1,key:sha256,value:{sha256,bytes:f.bytesValue.length,kind:f.kind,personId}};})];
}
export function createSubjectLegacyArchiveOwner(repository:WorkbenchRepository,env:ProductionArchiveEnvironment):ProductionArchiveOwner{
 const sql=repository.sqlForModule('legacy_migration');sql.execMigration('portable-files-001','CREATE TABLE wb_legacy_migration_files(sha256 TEXT PRIMARY KEY,bytes INTEGER NOT NULL,kind TEXT NOT NULL,person_id TEXT NOT NULL)');
 sql.execMigration('portable-omissions-001','CREATE TABLE wb_legacy_migration_omissions(sha256 TEXT PRIMARY KEY)');
 const base=createLegacyMigrationArchiveCodec();
 const validate=(r:WorkspaceArchiveRecord)=>{if(r.moduleId!=='legacy_migration'||r.schemaVersion!==1)fail();if(r.schemaId==='legacy.ownership'){if(accessSchema.parse(r.value).recordKey!==r.key)fail();}else if(r.schemaId==='legacy.file'){if(fileSchema.parse(r.value).sha256!==r.key)fail();}else base.validate(r);};
 const closure=(records:readonly WorkspaceArchiveRecord[])=>{
  records.forEach(validate);const own=new Map<string,string>();for(const r of records.filter(r=>r.schemaId==='legacy.ownership')){if(own.has(r.key))fail();own.set(r.key,accessSchema.parse(r.value).personId);}
  const business=records.filter(r=>!['legacy.ownership','legacy.file'].includes(r.schemaId));if(business.length!==own.size||business.some(r=>!own.has(r.key)))denied();
  const required=new Set<string>();for(const r of business.filter(r=>r.schemaId==='legacy.import')){const v=legacyImportSchema.parse(r.value);required.add(v.sourceFileSha256);v.attachmentHashes.forEach(h=>required.add(h));}
  const supplied=new Set(records.filter(r=>r.schemaId==='legacy.file').map(r=>r.key));if(required.size!==supplied.size||[...required].some(h=>!supplied.has(h)))fail();return own;
 };
 return{moduleId:'legacy_migration',validate,isUserData:()=>true,
 exportRecords(r){const records=base.exportRecords(r),ledger=createWorkspaceOwnership(r);const ownership=records.map(record=>{const binding=ledger.read('legacy_migration',record.key)??denied();if(!binding.personId)denied();return{moduleId:'legacy_migration',schemaId:'legacy.ownership',schemaVersion:1,key:record.key,value:{recordKey:record.key,personId:binding.personId}};});const files=r.sqlForModule('legacy_migration').all<any>('SELECT sha256,bytes,kind,person_id FROM wb_legacy_migration_files ORDER BY sha256').map(v=>({moduleId:'legacy_migration',schemaId:'legacy.file',schemaVersion:1,key:v.sha256,value:{sha256:v.sha256,bytes:v.bytes,kind:v.kind,personId:v.person_id}}));const all=[...records,...ownership,...files].sort((a,b)=>a.schemaId.localeCompare(b.schemaId)||a.key.localeCompare(b.key));closure(all);return all;},
 restoreRecords(r,records,c){const bindings=closure(records);if(records.length&&!c)return fail();base.restoreRecords(r,records.filter(v=>!['legacy.ownership','legacy.file'].includes(v.schemaId)));for(const[key,personId]of bindings)createWorkspaceOwnership(r).bind({moduleId:'legacy_migration',key,installationId:c!.installationId,personId,provenance:'restore'});for(const record of records.filter(v=>v.schemaId==='legacy.file')){const v=fileSchema.parse(record.value);r.sqlForModule('legacy_migration').run('INSERT INTO wb_legacy_migration_files VALUES(?,?,?,?)',[v.sha256,v.bytes,v.kind,v.personId]);const bytes=c!.files.get('files/'+v.sha256);if(!bytes){if(v.kind==='original'&&c!.originalsOmitted){r.sqlForModule('legacy_migration').run('INSERT INTO wb_legacy_migration_omissions VALUES(?)',[v.sha256]);continue;}return fail();}if(bytes.length!==v.bytes||hashBytes(bytes)!==v.sha256)return fail();const target=c!.subjectPath('legacy',v.sha256);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});}},
 authorize(records,personId){closure(records);for(const r of records.filter(v=>['legacy.ownership','legacy.file'].includes(v.schemaId)))if(!personId||(r.value as any).personId!==personId)denied();},
 fileReferences:records=>records.filter(r=>r.schemaId==='legacy.file').map(r=>{const{personId:_person,...f}=fileSchema.parse(r.value);return f;}),
 files:async(r,records)=>records.filter(record=>record.schemaId==='legacy.file').flatMap(record=>{const v=fileSchema.parse(record.value);if(v.kind==='original'&&r.sqlForModule('legacy_migration').get('SELECT sha256 FROM wb_legacy_migration_omissions WHERE sha256=?',[v.sha256]))return[];const filename=path.join(env.subjectRoot(),'legacy',v.sha256);let current=path.parse(path.resolve(filename)).root;for(const part of path.resolve(filename).slice(current.length).split(path.sep)){current=path.join(current,part);const stat=lstatSync(current);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)fail();}const stat=lstatSync(filename);if(!stat.isFile()||stat.size!==v.bytes)fail();const bytes=readFileSync(filename);if(hashBytes(bytes)!==v.sha256)fail();return[{path:'files/'+v.sha256,kind:v.kind,bytesValue:new Uint8Array(bytes)}];}),
 omittedOriginals:r=>!!r.sqlForModule('legacy_migration').get('SELECT sha256 FROM wb_legacy_migration_omissions LIMIT 1'),
 validateArchive(archive){closure(archive.records.filter(r=>r.moduleId==='legacy_migration'));},
 };
}
