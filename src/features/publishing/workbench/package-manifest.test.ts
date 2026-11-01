import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPackageManifest, canonicalBytes, validatePackageFiles, createPackageArtifactStore } from './index';
import { packageRevisionSchema } from './contracts';

const roots:string[]=[];
afterEach(async () => { for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('uor-t22-')) throw Error('Unsafe test cleanup'); await rm(root,{recursive:true,force:true}); } });
const base = {schemaVersion:1 as const,packageId:'00000000-0000-4000-8000-000000000004',cycleId:'00000000-0000-4000-8000-000000000003',curatorPersonId:'00000000-0000-4000-8000-000000000011',revision:1,baseCommit:'a'.repeat(40),targetBranch:'main' as const,createdAt:'2026-10-29T10:00:00Z'};
const files = () => new Map([['published/я.json',Buffer.from('Яе́')],['published/a.json',Buffer.from('{"v":"92"}')]]);
const recordPath = 'records/core_goal_definition/00000000-0000-4000-8000-000000000004/1.json';
it('canonicalVectorSortsKeysAndFilesWithoutChangingText', () => {
  const manifest = buildPackageManifest({package:base,files:files()});
  const expected = '{"files":[{"bytes":10,"path":"published/a.json","sha256":"da31de9821a7e61b55641e08a4fa1b8f02923ba7c2f1fa23e07e44dcad0e632a"},{"bytes":6,"path":"published/я.json","sha256":"4520095690942c46cc21b6a9ff1a90905356c8668af4862a67b97678cae11fe1"}],"package":{"baseCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","createdAt":"2026-10-29T10:00:00Z","curatorPersonId":"00000000-0000-4000-8000-000000000011","cycleId":"00000000-0000-4000-8000-000000000003","packageId":"00000000-0000-4000-8000-000000000004","revision":1,"schemaVersion":1,"targetBranch":"main"}}';
  expect(Buffer.from(canonicalBytes({package:base,files:manifest.files})).toString('hex')).toBe(Buffer.from(expected).toString('hex'));
  expect(manifest.packageRevision.contentHash).toBe('sha256:c96189c4fb9f32ee5104733253ee4dd032537d2ed9000ad2b0f54c260a84ef1c');
  expect(manifest.files.map(f=>f.path)).toEqual(['published/a.json','published/я.json']);
  expect(() => canonicalBytes({value:undefined})).toThrow();
  expect(() => canonicalBytes({value:Infinity})).toThrow();
  expect(packageRevisionSchema.safeParse({...manifest.packageRevision,baseCommit:'main'}).success).toBe(false);
});
it.each(['../outside','/absolute','records\\private.json','records/A.json:stream','records/a./x','records//x','records/a?.json','manifest.json'])('rejects nonportable paths %s before hashing', bad => {
  expect(() => buildPackageManifest({package:base,files:new Map([[bad,new Uint8Array()]])})).toThrow();
});
it('rejects case and Unicode path aliases', () => {
  for (const names of [['records/A.json','records/a.json'],['records/é.json','records/é.json']]) expect(() => buildPackageManifest({package:base,files:new Map(names.map(name=>[name,new Uint8Array()]))})).toThrow();
});
it('rejects links and undeclared/private paths from the filesystem', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'uor-t22-')); roots.push(root);
  await mkdir(path.join(root,path.dirname(recordPath)),{recursive:true}); await writeFile(path.join(root,recordPath),'{}');
  await expect(validatePackageFiles({root,paths:[recordPath],publicationMode:'demo-only'})).resolves.toBeUndefined();
  await expect(validatePackageFiles({root,paths:['config/registry.json'],publicationMode:'internal'})).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
  const outside = path.join(root,'outside'); await mkdir(outside);
  await symlink(outside,path.join(root,'linked'),'junction');
  await expect(validatePackageFiles({root:path.join(root,'linked'),paths:[recordPath],publicationMode:'internal'})).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
});
it('persists revision bytes immutably and verifies manifest on readback', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'uor-t22-')); roots.push(root);
  const store = createPackageArtifactStore({artifactRoot:root});
  const data = new Map([[recordPath,Buffer.from('{"v":"92"}')]]);
  const manifest = buildPackageManifest({package:base,files:data}); const ref=manifest.packageRevision;
  await store.writeRevision(ref,data); await store.writeRevision(ref,data);
  const actual = await store.readRevision(ref);
  expect(Buffer.from(actual.get(recordPath)!)).toEqual(data.get(recordPath));
  const changed = new Map([[recordPath,Buffer.from('{"v":"93"}')]]);
  await expect(store.writeRevision(ref,changed)).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
  const manifestPath = path.join(root,ref.packageId,String(ref.revision),'manifest.json');
  expect(JSON.parse(await readFile(manifestPath,'utf8')).packageRevision).toEqual(ref);
  await writeFile(path.join(root,ref.packageId,String(ref.revision),recordPath),'corrupt');
  await expect(store.readRevision(ref)).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
});
it('rejects undeclared bytes and missing declared artifacts on readback', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'uor-t22-')); roots.push(root);
  const store = createPackageArtifactStore({artifactRoot:root}); const data = new Map([[recordPath,Buffer.from('{}')]]);
  const ref = buildPackageManifest({package:base,files:data}).packageRevision;
  await store.writeRevision(ref,data);
  const target = path.join(root,ref.packageId,String(ref.revision));
  await writeFile(path.join(target,'undeclared.json'),'private');
  await expect(store.readRevision(ref)).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
  await rm(path.join(target,'undeclared.json'));
  await rm(path.join(target,recordPath));
  await expect(store.readRevision(ref)).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
});
it('rejects new bytes beneath a linked package parent before writing a staging folder', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'uor-t22-')); roots.push(root);
  const external = await mkdtemp(path.join(tmpdir(),'uor-t22-')); roots.push(external);
  await symlink(external,path.join(root,base.packageId),'junction');
  const store = createPackageArtifactStore({artifactRoot:root}); const data = new Map([[recordPath,Buffer.from('{}')]]);
  const ref = buildPackageManifest({package:base,files:data}).packageRevision;
  await expect(store.writeRevision(ref,data)).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
  expect(await import('node:fs/promises').then(fs=>fs.readdir(external))).toEqual([]);
});
it('never creates a child directory beneath a linked store root', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'uor-t22-')); roots.push(root);
  const external = await mkdtemp(path.join(tmpdir(),'uor-t22-')); roots.push(external);
  await symlink(external,path.join(root,'alias'),'junction');
  const store = createPackageArtifactStore({artifactRoot:path.join(root,'alias','new-store')});
  const data = new Map([[recordPath,Buffer.from('{}')]]); const ref=buildPackageManifest({package:base,files:data}).packageRevision;
  await expect(store.writeRevision(ref,data)).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
  expect(await import('node:fs/promises').then(fs=>fs.readdir(external))).toEqual([]);
});
