import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp,rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach,expect,it } from 'vitest';
import { createFileStore,defaultFileLimits } from './files';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)){if(!path.basename(root).startsWith('uor-legacy-upload-'))throw Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}});
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'uor-legacy-upload-'));roots.push(root);const store=createFileStore({directory:path.join(root,'uploads'),limits:defaultFileLimits}),installationId=randomUUID();return{store,installationId,async stage(name:string,mediaType:string,bytes:Buffer,purpose:'goal-import'|'evidence'='goal-import'){return store.stage({installationId,name,mediaType,purpose,stream:(async function*(){yield bytes;})()});}};}
it('stages inert legacy JSON and bounded legacy ZIP for owner validation without accepting either as ordinary evidence',async()=>{
  const f=await fixture(),json=Buffer.from(JSON.stringify({schemaVersion:1,mappings:[]})),staged=await f.stage('mapping.json','application/json',json);
  expect(Buffer.from((await f.store.read(staged.fileHandle,f.installationId,'goal-import')).bytesValue)).toEqual(json);
  const zip=new JSZip();zip.file('manifest.json','{}');zip.file('records.json','[]');const bytes=await zip.generateAsync({type:'nodebuffer'});
  await expect(f.stage('legacy.zip','application/zip',bytes)).resolves.toHaveProperty('fileHandle');
  await expect(f.stage('mapping.json','application/json',json,'evidence')).rejects.toMatchObject({code:'INVALID_FILE'});
});
it('rejects executable, deeply nested JSON and unknown ZIP paths before storing an import handle',async()=>{
  const f=await fixture();
  for(const bytes of [Buffer.from('<script>bad</script>'),Buffer.from('{"__proto__":{}}'),Buffer.from('['.repeat(80)+'0'+']'.repeat(80))])await expect(f.stage('mapping.json','application/json',bytes)).rejects.toMatchObject({code:'INVALID_FILE'});
  const zip=new JSZip();zip.file('manifest.json','{}');zip.file('records.json','[]');zip.file('private-session.json','{}');await expect(f.stage('legacy.zip','application/zip',await zip.generateAsync({type:'nodebuffer'}))).rejects.toMatchObject({code:'INVALID_FILE'});
});
