import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { hashBytes } from '../../publishing/workbench/package-manifest';
import { createSubjectLegacyArchiveOwner,prepareLegacySubjectRecords } from './subject-legacy-archive';
import type { WorkspaceArchiveRecord } from './contracts';
const cleanups:Array<()=>void>=[];afterEach(()=>cleanups.splice(0).forEach(f=>f()));
function fixture(personId=randomUUID()) {const root=mkdtempSync(path.join(tmpdir(),'uor-subject-legacy-')),repository=createWorkbenchRepository({filename:':memory:',artifactRoot:root}),installationId=randomUUID();cleanups.push(()=>{repository.close();if(path.basename(root).startsWith('uor-subject-legacy-'))rmSync(root,{recursive:true,force:true});});repository.sqlForModule('legacy_migration').execMigration('v1','CREATE TABLE wb_legacy_migration_records(key TEXT PRIMARY KEY,schema_id TEXT NOT NULL,payload TEXT NOT NULL)');const owner=createSubjectLegacyArchiveOwner(repository,{installationId,personId:()=>personId,localPreview:true,subjectRoot:()=>root});return{root,repository,installationId,personId,owner};}
it('retains inert migration files and exact person bindings and fails on missing evidence',async()=>{
 const a=fixture(),bytes=Buffer.from('synthetic original'),sha256=hashBytes(bytes),mappingHash='a'.repeat(64),records:WorkspaceArchiveRecord[]=[{moduleId:'legacy_migration',schemaId:'legacy.import',schemaVersion:1,key:sha256+'/'+mappingHash,value:{schemaVersion:1,sourceHash:'sha256:'+sha256,mappingHash,sourceFileSha256:sha256,attachmentHashes:[],mappings:[],counts:{input:0,accepted:0,problematic:0},basisVerified:false,requiresCuratorReview:true}}],files=[{path:'files/'+sha256,kind:'original' as const,bytesValue:new Uint8Array(bytes)}],portable=prepareLegacySubjectRecords({records,files},{installationId:a.installationId,personId:a.personId});
 const context={installationId:a.installationId,personId:a.personId,stagedRoot:a.root,files:new Map(files.map(f=>[f.path,f.bytesValue])),subjectPath:(namespace:'evidence'|'uploads'|'publishing'|'legacy',relative:string)=>path.join(a.root,namespace,relative)};
 a.owner.restoreRecords(a.repository,portable,context);expect(a.owner.exportRecords(a.repository)).toEqual([...portable].sort((a,b)=>a.schemaId.localeCompare(b.schemaId)||a.key.localeCompare(b.key)));expect(await a.owner.files(a.repository,portable)).toEqual(files);expect(()=>a.owner.authorize(portable,randomUUID(),a.installationId)).toThrow();
 const b=fixture(a.personId);b.owner.restoreRecords(b.repository,portable,{...context,installationId:b.installationId,stagedRoot:b.root,files:new Map(),originalsOmitted:true,subjectPath:(namespace,relative)=>path.join(b.root,namespace,relative)});expect(b.owner.exportRecords(b.repository)).toEqual(a.owner.exportRecords(a.repository));
 const evidence=portable.map(r=>r.schemaId==='legacy.file'?{...r,value:{...(r.value as object),kind:'evidence'}}:r),c=fixture(a.personId);expect(()=>c.owner.restoreRecords(c.repository,evidence,{...context,installationId:c.installationId,stagedRoot:c.root,files:new Map(),subjectPath:(namespace,relative)=>path.join(c.root,namespace,relative)})).toThrow();
});
