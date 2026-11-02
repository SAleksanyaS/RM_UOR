import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createOkoWorkflowStore } from '../../connectors/workbench-workflow-store';
import { createSourceArchiveOwners } from './source-archive-owners';
import type { ValidatedWorkspaceArchive,WorkspaceArchiveRecord,WorkspaceArchiveFileSource } from './contracts';

const cleanup: Array<()=>void> = [];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
function fixture(installationId=randomUUID(),personId=randomUUID()) {
 const root=mkdtempSync(path.join(tmpdir(),'uor-source-archive-'));
 const repository=createWorkbenchRepository({filename:':memory:',artifactRoot:root});
 cleanup.push(()=>{repository.close();rmSync(root,{recursive:true,force:true});});
 const environment={installationId,personId:()=>personId,localPreview:false,subjectRoot:()=>root};
 const owners=createSourceArchiveOwners(repository,environment);
 return {root,repository,environment,owners,installationId,personId};
}
function archiveFor(records:WorkspaceArchiveRecord[],files:WorkspaceArchiveFileSource[],originals=false):ValidatedWorkspaceArchive {return {records,files:new Map(files.map(f=>[f.path,f.bytesValue])),manifest:{format:'uor-workspace-v1',version:1,applicationVersion:'0.5.0',storageSchemaVersion:1,createdAt:'2026-11-01T00:00:00Z',actor:{hostname:'synthetic',installationId:randomUUID(),profilePersonId:randomUUID()},recordsSha256:'a'.repeat(64),files:files.map(f=>({path:f.path,sha256:f.path.slice(6),bytes:f.bytesValue.length,kind:f.kind})),exclusions:originals?['originals']:[]}};}
it('registers every source owner and preserves every private result across installation transfer',async()=>{
 const a=fixture(), store=createOkoWorkflowStore(a.repository), owner=`${a.installationId}/${a.personId}`;
 const artifact=(text:string)=>({name:'original.csv',mimeType:'text/csv',base64:Buffer.from(text).toString('base64'),hash:createHash('sha256').update(text).digest('hex')});
 const ids=[randomUUID(),randomUUID()];
 ids.forEach((id,i)=>store.putResult(owner,id,{original:artifact('raw'+i),enriched:artifact('enriched'+i)}));
 expect(a.owners.map(o=>o.moduleId)).toEqual(['sources','imports','evidence','browser_scenarios','oko_workflow']);
 const codec=a.owners.find(o=>o.moduleId==='oko_workflow')!, records=codec.exportRecords(a.repository);
 expect(records).toHaveLength(2);expect(JSON.stringify(records)).not.toContain('base64');
 const files=await codec.files(a.repository,records), fileMap=new Map(files.map(f=>[f.path,f.bytesValue]));
 expect(files).toHaveLength(4);
 codec.validateArchive!(archiveFor(records,files));expect(()=>codec.validateArchive!(archiveFor(records,files.slice(1)))).toThrow();const corrupt=archiveFor(records,files);corrupt.files=new Map(corrupt.files);(corrupt.files as Map<string,Uint8Array>).set(files[0].path,Buffer.from('corrupt'));expect(()=>codec.validateArchive!(corrupt)).toThrow();
 const b=fixture(randomUUID(),a.personId), restored=b.owners.find(o=>o.moduleId==='oko_workflow')!;
 restored.authorize(records,a.personId,b.installationId);
 restored.restoreRecords(b.repository,records,{installationId:b.installationId,personId:b.personId,files:fileMap,stagedRoot:b.root,subjectPath:(ns,relative)=>path.join(b.root,ns,relative)});
 expect(restored.exportRecords(b.repository)).toEqual(records);
 for(const id of ids)expect(createOkoWorkflowStore(b.repository).getResult(`${b.installationId}/${b.personId}`,id)).toEqual(store.getResult(owner,id));
 expect(()=>restored.authorize(records,randomUUID(),b.installationId)).toThrow();
 const c=fixture(randomUUID(),a.personId);
 expect(()=>c.owners.find(o=>o.moduleId==='oko_workflow')!.restoreRecords(c.repository,records,{installationId:c.installationId,personId:c.personId,files:new Map(),stagedRoot:c.root,subjectPath:(ns,relative)=>path.join(c.root,ns,relative)})).toThrow();
});
it('retains canonical original descriptors only when a trusted partial-archive flag declares omission',async()=>{
 const a=fixture(),store=createOkoWorkflowStore(a.repository),owner=`${a.installationId}/${a.personId}`,id=randomUUID();const artifact=(text:string)=>({name:'data.csv',mimeType:'text/csv',base64:Buffer.from(text).toString('base64'),hash:createHash('sha256').update(text).digest('hex')});store.putResult(owner,id,{original:artifact('raw'),enriched:artifact('enriched')});
 const codec=a.owners.find(o=>o.moduleId==='oko_workflow')!,records=codec.exportRecords(a.repository),files=await codec.files(a.repository,records),b=fixture(randomUUID(),a.personId),target=b.owners.find(o=>o.moduleId==='oko_workflow')!;
 target.restoreRecords(b.repository,records,{installationId:b.installationId,personId:b.personId,originalsOmitted:true,files:new Map(files.filter(f=>f.kind!=='original').map(f=>[f.path,f.bytesValue])),stagedRoot:b.root,subjectPath:(ns,relative)=>path.join(b.root,ns,relative)});
 expect(target.exportRecords(b.repository)).toEqual(records);expect((await target.files(b.repository,records)).map(f=>f.kind)).toEqual(['module']);expect(target.omittedOriginals!(b.repository)).toBe(true);
});
it('includes hidden and raw-only exports plus capture receipts, restores exact bytes without private staging',async()=>{
 const a=fixture(),store=createOkoWorkflowStore(a.repository),own=`${a.installationId}/${a.personId}`,id=randomUUID(),bytes=Buffer.from('x;y\r\n1;2');
 store.beginCapture(own,{schemaVersion:1,captureId:id,operationId:randomUUID(),workflowId:randomUUID(),sourceId:randomUUID(),title:'Raw only',origin:'record',createdAt:'2026-11-01T00:00:00Z'});store.commitCapture(own,id,{bytes,name:'raw.tsv',contentType:'text/tab-separated-values'});store.markExportDeleted(own,id,'2026-11-01T01:00:00Z');
 const codec=a.owners.find(o=>o.moduleId==='oko_workflow')!,records=codec.exportRecords(a.repository),files=await codec.files(a.repository,records);
 expect(records.map(r=>r.schemaId)).toEqual(['export','capture']);expect(JSON.stringify(records)).not.toMatch(/staging_json|base64|profilePath/);expect(files).toHaveLength(1);codec.validateArchive!(archiveFor(records,files));
 const b=fixture(randomUUID(),a.personId),target=b.owners.find(o=>o.moduleId==='oko_workflow')!;
 target.restoreRecords(b.repository,records,{installationId:b.installationId,personId:b.personId,files:new Map(files.map(f=>[f.path,f.bytesValue])),stagedRoot:b.root,subjectPath:(ns,relative)=>path.join(b.root,ns,relative)});
 expect(target.exportRecords(b.repository)).toEqual(records);const restored=createOkoWorkflowStore(b.repository);expect(restored.listExports(`${b.installationId}/${b.personId}`,{includeHidden:true})).toHaveLength(1);expect(restored.captureReceipt(`${b.installationId}/${b.personId}`,id)).toEqual(store.captureReceipt(own,id));expect((await target.files(b.repository,records))[0].bytesValue).toEqual(bytes);
 const broken=structuredClone(records);(broken.find(r=>r.schemaId==='capture')!.value as any).receipt.exportId=randomUUID();expect(()=>target.validateArchive!(archiveFor(broken,files))).toThrow();
});
