import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createPackageArtifactStore } from '../../publishing/workbench/package-artifacts';
import { buildPackageManifest } from '../../publishing/workbench/package-manifest';
import { createPublishingArchiveOwner } from './subject-publishing-archive';
import type { ProductionArchiveEnvironment } from './production-archive-contracts';
const cleanup:Array<()=>void>=[];afterEach(()=>cleanup.splice(0).forEach(f=>f()));
function fixture(personId=randomUUID()){
 const root=mkdtempSync(path.join(tmpdir(),'uor-subject-publishing-')),repository=createWorkbenchRepository({filename:':memory:',artifactRoot:root}),installationId=randomUUID();cleanup.push(()=>{repository.close();if(path.basename(root).startsWith('uor-subject-publishing-'))rmSync(root,{recursive:true,force:true});});
 const environment:ProductionArchiveEnvironment={installationId,personId:()=>personId,localPreview:true,subjectRoot:()=>root};const owner=createPublishingArchiveOwner(repository,environment);return{root,repository,environment,owner,installationId,personId};
}
it('preserves prepared capsules and pending delivery/effects as inert portable history with exact reexport',async()=>{
 const a=fixture(),packageId=randomUUID(),cycleId=randomUUID(),jobId=randomUUID(),actor={hostname:'synthetic',installationId:a.installationId,profilePersonId:a.personId},files=new Map([['records/core_goal_definition/'+randomUUID()+'/1.json',Buffer.from('{"synthetic":true}')]]),manifest=buildPackageManifest({package:{schemaVersion:1,packageId,cycleId,curatorPersonId:a.personId,revision:1,baseCommit:'a'.repeat(40),targetBranch:'main',createdAt:'2026-10-28T10:00:00Z'},files});
 await createPackageArtifactStore({artifactRoot:path.join(a.root,'publishing')}).writeRevision(manifest.packageRevision,files);
 const sql=a.repository.sqlForModule('publishing'),value={schemaVersion:1,id:packageId,revision:1,recordedAt:'2026-10-28T10:00:00Z',actor,publicationAnchorId:null,cycleId,curatorPersonId:a.personId,state:'publishing',current:manifest.packageRevision,sent:null,draftRefs:[],proposal:null};
 sql.run('INSERT INTO wb_publishing_packages VALUES(?,?,?,?,?)',[packageId,a.installationId,a.personId,1,JSON.stringify(value)]);
 const prepared={packageRevision:manifest.packageRevision,checkout:'C:\\private\\old-checkout',branch:`uor/${a.personId}/${packageId}`,commit:'b'.repeat(40),expectedRemoteHead:null};
 sql.run('INSERT INTO wb_publishing_prepared VALUES(?,?,?,?,?)',[packageId,1,a.installationId,a.personId,JSON.stringify(prepared)]);sql.run('INSERT INTO wb_publishing_delivery_jobs VALUES(?,?,?,?,?)',[jobId,packageId,1,a.installationId,a.personId]);sql.run('INSERT INTO wb_publishing_effects VALUES(?,?,?,?,?,?,?,?,?,?)',[jobId,'PR.write',packageId,1,a.installationId,a.personId,'c'.repeat(64),'2026-10-28T11:00:00Z','unknown',null]);
 const records=a.owner.exportRecords(a.repository);expect(JSON.stringify(records)).not.toContain('old-checkout');const sources=await a.owner.files(a.repository,records);expect(sources).toHaveLength(1);
 const b=fixture(a.personId);b.owner.authorize(records,b.personId,b.installationId);b.owner.restoreRecords(b.repository,records,{installationId:b.installationId,personId:b.personId,stagedRoot:b.root,files:new Map(sources.map(f=>[f.path,f.bytesValue])),subjectPath:(namespace,relative)=>path.join(b.root,namespace,relative)});
 expect(b.owner.exportRecords(b.repository)).toEqual(records);expect(b.repository.sqlForModule('publishing').all('SELECT payload FROM wb_publishing_prepared')).toEqual([]);expect(b.repository.sqlForModule('publishing').get<{reconciliation_needed:number}>('SELECT reconciliation_needed FROM wb_publishing_portable_prepared')?.reconciliation_needed).toBe(1);expect(await b.owner.files(b.repository,records)).toEqual(sources);
 expect(()=>b.owner.authorize(records,randomUUID(),b.installationId)).toThrow();
 const c=fixture(a.personId);expect(()=>c.owner.restoreRecords(c.repository,records,{installationId:c.installationId,personId:c.personId,stagedRoot:c.root,files:new Map(),subjectPath:(namespace,relative)=>path.join(c.root,namespace,relative)})).toThrow();
});
it('package artifact readers follow the active subject root after rebind',async()=>{
 const a=fixture(),b=fixture(a.personId);let root=path.join(a.root,'publishing');const store=createPackageArtifactStore({artifactRoot:()=>root});
 const files=new Map([['records/synthetic/'+randomUUID()+'/1.json',Buffer.from('own')]]),manifest=buildPackageManifest({package:{schemaVersion:1,packageId:randomUUID(),cycleId:randomUUID(),curatorPersonId:a.personId,revision:1,baseCommit:'a'.repeat(40),targetBranch:'main',createdAt:'2026-10-28T10:00:00Z'},files});
 await store.writeRevision(manifest.packageRevision,files);root=path.join(b.root,'publishing');await expect(store.readRevision(manifest.packageRevision)).rejects.toThrow();await store.writeRevision(manifest.packageRevision,files);expect(await store.readRevision(manifest.packageRevision)).toEqual(files);
});
it.each([null,'2026-11-01T09:00:00.000Z'])('preserves local applied time %s without synthesizing it on restore',appliedAt=>{
 const a=fixture(),b=fixture(a.personId);a.repository.sqlForModule('publishing').run('INSERT INTO wb_publishing_applied(singleton,repository_id,commit_oid,applied_at) VALUES(1,?,?,?)',['synthetic','a'.repeat(40),appliedAt]);
 const records=a.owner.exportRecords(a.repository);expect(records.find(record=>record.schemaId==='publishing.applied')?.value).toEqual({repositoryId:'synthetic',commit:'a'.repeat(40),appliedAt});b.owner.restoreRecords(b.repository,records,{installationId:b.installationId,personId:b.personId,files:new Map(),stagedRoot:b.root,subjectPath:(namespace,relative)=>path.join(b.root,namespace,relative)});expect(b.owner.exportRecords(b.repository)).toEqual(records);
});
