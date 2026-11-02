import { afterEach, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { createOkoWorkflowStore } from './workbench-workflow-store';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const intent=()=>({schemaVersion:1 as const,captureId:randomUUID(),operationId:randomUUID(),workflowId:randomUUID(),sourceId:randomUUID(),title:'Synthetic',origin:'record' as const,createdAt:'2026-11-02T00:00:00Z'});
const bytes=Buffer.from('a;b\r\n1;2'),download={bytes,name:'source.csv',contentType:'text/csv'};
function fixture(){const root=mkdtempSync(path.join(tmpdir(),'uor-capture-'));roots.push(root);const filename=path.join(root,'db.sqlite');const repository=createWorkbenchRepository({filename,artifactRoot:root});return{root,filename,repository,store:createOkoWorkflowStore(repository)};}
it('commits raw and receipt before finish, survives abrupt child exit and owner-scoped reopen',()=>{
 const f=fixture(),owner=randomUUID()+'/'+randomUUID(),capture=intent();f.repository.close();
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {createWorkbenchRepository} from './src/server/storage/workbench-repository.ts';import {createOkoWorkflowStore} from './src/features/connectors/workbench-workflow-store.ts';const r=createWorkbenchRepository(${JSON.stringify({filename:f.filename,artifactRoot:f.root})});const s=createOkoWorkflowStore(r);const i=${JSON.stringify(capture)};s.beginCapture(${JSON.stringify(owner)},i);s.commitCapture(${JSON.stringify(owner)},i.captureId,{bytes:Buffer.from('a;b\\r\\n1;2'),name:'source.csv',contentType:'text/csv'});process.exit(73);`],{cwd:process.cwd(),encoding:'utf8'});
 expect(child.status,child.stderr).toBe(73);
 const r=createWorkbenchRepository({filename:f.filename,artifactRoot:f.root});try{const s=createOkoWorkflowStore(r),receipt=s.captureReceipt(owner,capture.captureId)!;expect(receipt.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));expect(s.listExports(owner)).toHaveLength(1);expect(s.captureReceipt(randomUUID(),capture.captureId)).toBeNull();expect(s.getExport(owner,receipt.exportId)).not.toBeNull();}finally{r.close();}
});
it('same operation uses one intent and receipt, rejects conflicting bytes, keeps raw through parse failure/cancel',()=>{
 const f=fixture();try{const owner=randomUUID(),capture=intent();const first=f.store.beginCapture(owner,capture);expect(f.store.beginCapture(owner,{...capture,captureId:randomUUID()}).captureId).toBe(first.captureId);const receipt=f.store.commitCapture(owner,first.captureId,download);expect(f.store.commitCapture(owner,first.captureId,download)).toEqual(receipt);expect(()=>f.store.commitCapture(owner,first.captureId,{...download,bytes:Buffer.from('changed')})).toThrow(/CAPTURE_CONFLICT/);expect(()=>f.store.commitCapture('foreign',first.captureId,download)).toThrow(/CAPTURE_NOT_FOUND/);f.store.interruptCaptures(owner);expect(f.store.captureReceipt(owner,first.captureId)).toEqual(receipt);expect(f.store.listExports(owner)).toHaveLength(1);}finally{f.repository.close();}
});

it('recovers bytes secured before catalog commit and preserves original metadata on restart',()=>{
 const f=fixture(),capture=intent(),owner=randomUUID();f.store.beginCapture(owner,capture);f.store.secureCapture(owner,capture.captureId,download);f.repository.close();const r=createWorkbenchRepository({filename:f.filename,artifactRoot:f.root});try{const s=createOkoWorkflowStore(r);expect(s.captureReceipt(owner,capture.captureId)).toMatchObject({sourceName:'source.csv',bytes:bytes.length});expect(s.listExports(owner)).toHaveLength(1);}finally{r.close();}
});

it('reconciles an exact completed engine GUID after crash before capture callback and ignores partial bytes',async()=>{
 const {mkdirSync,writeFileSync}=await import('node:fs');const f=fixture(),owner=randomUUID(),capture=intent(),guid=randomUUID(),directory=path.join(f.root,capture.captureId);mkdirSync(directory);f.store.beginCapture(owner,capture);f.store.stageCapture(owner,capture.captureId,{directory,guid,name:'source.csv'});writeFileSync(path.join(directory,guid+'.crdownload'),bytes);f.repository.close();
 let r=createWorkbenchRepository({filename:f.filename,artifactRoot:f.root});let s=createOkoWorkflowStore(r);expect(s.captureReceipt(owner,capture.captureId)).toBeNull();r.close();const {renameSync}=await import('node:fs');renameSync(path.join(directory,guid+'.crdownload'),path.join(directory,guid));r=createWorkbenchRepository({filename:f.filename,artifactRoot:f.root});try{s=createOkoWorkflowStore(r);expect(s.captureReceipt(owner,capture.captureId)).toMatchObject({sourceName:'source.csv',bytes:bytes.length});expect(s.listExports(owner)).toHaveLength(1);}finally{r.close();}
});

it('cleans only its own committed staging files after verified durable receipt',async()=>{
 const fs=await import('node:fs'),f=fixture(),owner=randomUUID(),capture=intent(),guid=randomUUID(),directory=path.join(f.root,capture.captureId);fs.mkdirSync(directory);f.store.beginCapture(owner,capture);f.store.stageCapture(owner,capture.captureId,{directory,guid,name:'source.csv'});fs.writeFileSync(path.join(directory,guid),bytes);fs.writeFileSync(path.join(directory,'unrelated.txt'),'keep');f.store.recoverCaptures();expect(fs.existsSync(path.join(directory,guid))).toBe(false);expect(fs.readFileSync(path.join(directory,'unrelated.txt'),'utf8')).toBe('keep');f.repository.close();
});

it('restarts after real child exit at engine final rename before sink callback or finish',()=>{
 const f=fixture(),capture=intent(),owner=randomUUID(),guid=randomUUID(),directory=path.join(f.root,capture.captureId);f.repository.close();
 const script=`import {createWorkbenchRepository} from './src/server/storage/workbench-repository.ts';import {createOkoWorkflowStore} from './src/features/connectors/workbench-workflow-store.ts';import {mkdirSync,writeFileSync,renameSync} from 'node:fs';import path from 'node:path';const r=createWorkbenchRepository(${JSON.stringify({filename:f.filename,artifactRoot:f.root})}),s=createOkoWorkflowStore(r),i=${JSON.stringify(capture)},directory=${JSON.stringify(directory)},guid=${JSON.stringify(guid)};s.beginCapture(${JSON.stringify(owner)},i);mkdirSync(directory);s.stageCapture(${JSON.stringify(owner)},i.captureId,{directory,guid,name:'source.csv'});writeFileSync(path.join(directory,guid+'.crdownload'),Buffer.from('a;b\\r\\n1;2'));renameSync(path.join(directory,guid+'.crdownload'),path.join(directory,guid));process.exit(74);`;
 const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8'});expect(child.status,child.stderr).toBe(74);const r=createWorkbenchRepository({filename:f.filename,artifactRoot:f.root});try{const s=createOkoWorkflowStore(r);expect(s.captureReceipt(owner,capture.captureId)).toMatchObject({sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});expect(s.listExports(owner)).toHaveLength(1);}finally{r.close();}
});
