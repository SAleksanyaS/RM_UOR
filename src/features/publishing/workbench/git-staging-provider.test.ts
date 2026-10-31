import path from 'node:path';
import { mkdir, writeFile, readFile, symlink, readdir, rename, unlink, rmdir } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { gitStagingFixture, stagingCleanups } from '../../../../tests/fixtures/workbench/git-staging';
import { createGitStagingProvider } from './index';
import { buildPackageManifest } from './package-manifest';
import type { PublicationGitPort } from './git-port';
import type { VerifiedMain } from './contracts';

afterEach(async()=>{for(const cleanup of stagingCleanups.splice(0).reverse()) await cleanup();});
it('reads an earlier merge tree only after proving it belongs to the freshly accepted main ancestry', async () => {
  const f = await gitStagingFixture(), provider = createGitStagingProvider(f.options) as PublicationGitPort & { readAcceptedMainAt(commit: string): Promise<VerifiedMain> };
  const prepared = await provider.prepare(f.makePackage());
  await f.git(prepared.checkout, ['push', 'origin', prepared.branch]);
  await f.git(f.projectRoot, ['fetch', 'origin', prepared.branch]); await f.git(f.projectRoot, ['merge', '--ff-only', 'FETCH_HEAD']); await f.git(f.projectRoot, ['push', 'origin', 'main']);
  await writeFile(path.join(f.projectRoot, 'README.md'), 'Later main after actual package merge');
  await f.git(f.projectRoot, ['add', '--', 'README.md']); await f.git(f.projectRoot, ['commit', '-m', 'descendant main']); await f.git(f.projectRoot, ['push', 'origin', 'main']);
  const current = await provider.readMain(), proof = await provider.readAcceptedMainAt(prepared.commit);
  expect(current.commit).not.toBe(prepared.commit); expect(proof.commit).toBe(prepared.commit); expect(proof.repositoryId).toBe(f.options.repositoryId); expect(proof.files).toEqual(current.files);
  const foreign = await f.git(f.projectRoot, ['commit-tree', await f.git(f.projectRoot, ['rev-parse', prepared.commit + '^{tree}']), '-m', 'same tree on unrelated branch']);
  await f.git(f.projectRoot, ['push', 'origin', foreign + ':refs/heads/unrelated']);
  // Make the unrelated object genuinely available in the private reader. A
  // missing object would not prove that the ancestry check rejects its branch.
  const repositories = path.join(f.runtimeRoot, 'workbench-git');
  const privateRoot = path.join(repositories, (await readdir(repositories))[0]);
  const reader = path.join(privateRoot, (await readdir(privateRoot)).find(name => name.startsWith('reader-'))!);
  await f.git(reader, ['fetch', 'origin', 'refs/heads/unrelated:refs/remotes/origin/unrelated']);
  expect(await f.git(reader, ['cat-file', '-t', foreign])).toBe('commit');
  await expect(provider.readAcceptedMainAt(foreign)).rejects.toThrow();
  await expect(provider.readAcceptedMainAt('HEAD')).rejects.toThrow();
}, 60000);
it('prepares independent curator branches, stages exact manifest paths and preserves the running checkout',async()=>{
  const f=await gitStagingFixture();const provider=createGitStagingProvider(f.options);
  await writeFile(path.join(f.projectRoot,'README.md'),'Unsaved human text');await mkdir(path.join(f.projectRoot,'.runtime'));await writeFile(path.join(f.projectRoot,'.runtime','registry.local.json'),'synthetic-private');
  const a=f.makePackage(),b=f.makePackage(290101);const completed=await Promise.allSettled([provider.prepare(a),provider.prepare(b)]);
  for(const result of completed) if(result.status==='rejected') {console.info('SYNTHETIC_GIT_ERRORS',await f.errors());throw result.reason;}
  const [first,second]=completed.map(result=>(result as PromiseFulfilledResult<Awaited<ReturnType<typeof provider.prepare>>>).value);
  expect(first.branch).toBe(`uor/${a.manifest.packageRevision.curatorPersonId}/${a.manifest.packageRevision.packageId}`);expect(second.branch).not.toBe(first.branch);
  expect(first.checkout.startsWith(f.runtimeRoot+path.sep)).toBe(true);expect(await f.git(f.projectRoot,['rev-parse','HEAD'])).toBe(f.baseCommit);expect(await readFile(path.join(f.projectRoot,'README.md'),'utf8')).toBe('Unsaved human text');
  expect(await provider.inspectRemote(first.branch)).toBeNull();
  const changed=(await f.git(first.checkout,['diff','--name-only',f.baseCommit,first.commit])).split(/\r?\n/);
  const prefix=`published/workbench/packages/${first.packageRevision.packageId}/1/`;
  expect(changed.sort()).toEqual([prefix+'manifest.json',...a.manifest.files.map(file=>prefix+file.path)].sort());
  const commands=await f.argv();expect(commands.some(args=>args.includes('add')&&args.includes('--')&&args.some(arg=>arg.startsWith(prefix)))).toBe(true);
  expect(commands.flat().some(arg=>['--force','--no-verify','reset','clean','rebase'].includes(arg)||arg==='uor-empty-hooks')).toBe(false);
  expect(await f.git(first.checkout,['config','--get','core.hooksPath'])).toBe(path.resolve(f.projectRoot,await f.git(f.projectRoot,['rev-parse','--git-path','hooks'])));
  await expect(provider.verifyPrepared(first)).resolves.toBeUndefined();expect(await provider.prepare(a)).toEqual(first);
},30000);
it('reads verified main capsule bytes while excluding running code/private files',async()=>{
  const f=await gitStagingFixture();const provider=createGitStagingProvider(f.options);expect((await provider.readMain()).files.size).toBe(0);
  const prepared=await provider.prepare(f.makePackage());
  // This push/merge is confined to the owned temporary bare fixture.
  await f.git(prepared.checkout,['push','origin',prepared.branch]);await f.git(f.projectRoot,['fetch','origin',prepared.branch]);await f.git(f.projectRoot,['merge','--ff-only','FETCH_HEAD']);await f.git(f.projectRoot,['push','origin','main']);
  const main=await provider.readMain();expect(main.repositoryId).toBe(f.options.repositoryId);expect(main.commit).toBe(prepared.commit);
  expect([...main.files.keys()].every(name=>name.startsWith('published/workbench/packages/'))).toBe(true);expect([...main.files.keys()].some(name=>name.endsWith('/manifest.json'))).toBe(true);
},30000);
it('rejects changed main or prepared bytes without losing the saved commit',async()=>{
  const f=await gitStagingFixture();const provider=createGitStagingProvider(f.options);const input=f.makePackage();const prepared=await provider.prepare(input);
  const file=path.join(prepared.checkout,'published','workbench','packages',prepared.packageRevision.packageId,'1',input.manifest.files[0].path);
  await writeFile(file,'corrupt');await expect(provider.verifyPrepared(prepared)).rejects.toMatchObject({code:'PREVIEW_STALE'});expect(await f.git(prepared.checkout,['rev-parse','HEAD'])).toBe(prepared.commit);
  await writeFile(file,input.files.get(input.manifest.files[0].path)!);
  await writeFile(path.join(f.projectRoot,'README.md'),'New main');await f.git(f.projectRoot,['add','--','README.md']);await f.git(f.projectRoot,['commit','-m','main moved']);await f.git(f.projectRoot,['push','origin','main']);
  await expect(provider.verifyPrepared(prepared)).rejects.toMatchObject({code:'PREVIEW_STALE'});await expect(provider.prepare(input)).rejects.toMatchObject({code:'PREVIEW_STALE'});
  expect(await f.git(prepared.checkout,['rev-parse','HEAD'])).toBe(prepared.commit);
},30000);
it('extends only an observed own branch and rejects a changed remote head without force',async()=>{
  const f=await gitStagingFixture();const provider=createGitStagingProvider(f.options);const first=await provider.prepare(f.makePackage());await f.git(first.checkout,['push','origin',first.branch]);
  const second=await provider.prepare({...f.makePackage(290001,2),expectedRemoteHead:first.commit});
  expect(await f.git(second.checkout,['rev-parse',second.commit+'^'])).toBe(first.commit);
  await writeFile(path.join(first.checkout,'other.txt'),'Remote actor');await f.git(first.checkout,['add','--','other.txt']);await f.git(first.checkout,['commit','-m','remote moved']);await f.git(first.checkout,['push','origin',first.branch]);
  const remote=await provider.inspectRemote(first.branch);expect(remote).not.toBe(first.commit);await expect(provider.verifyPrepared(second)).rejects.toMatchObject({code:'PREVIEW_STALE'});
  expect(await provider.inspectRemote(first.branch)).toBe(remote);
},30000);
it('rejects option-like refs, credential URLs and undeclared/private package paths',async()=>{
  const f=await gitStagingFixture();const provider=createGitStagingProvider(f.options);
  for(const branch of ['main','--upload-pack=whoami','uor/a/b;echo bad','uor/../main']) await expect(provider.inspectRemote(branch)).rejects.toMatchObject({code:'GIT_CONFIGURATION_INVALID'});
  expect(()=>createGitStagingProvider({...f.options,remoteUrl:'https://user:secret@example.org/repo.git'})).toThrow('GIT_CONFIGURATION_INVALID');
  const original=f.makePackage();const files=new Map(original.files);files.set('config/registry.json',Buffer.from('synthetic-private'));
  const {contentHash:_hash,...base}=original.manifest.packageRevision;const manifest=buildPackageManifest({package:base,files});
  await expect(provider.prepare({manifest,files,expectedRemoteHead:null})).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
});
it('rejects a linked private root before creating children',async()=>{
  const f=await gitStagingFixture();const external=path.join(f.root,'external');await mkdir(external);await symlink(external,f.runtimeRoot,'junction');
  const provider=createGitStagingProvider(f.options);await expect(provider.prepare(f.makePackage())).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});expect(await readdir(external)).toEqual([]);
});
it('preserves the actual running checkout corporate commit hook instead of installing empty hooks',async()=>{
  const f=await gitStagingFixture();const hooks=path.resolve(f.projectRoot,await f.git(f.projectRoot,['rev-parse','--git-path','hooks']));const marker=path.join(f.root,'hook-ran.txt').replaceAll('\\','/');
  const quoted="'"+marker.replaceAll("'","'\\''")+"'";
  await writeFile(path.join(hooks,'pre-commit'),'#!/bin/sh\nprintf hooked >> '+quoted+'\n',{mode:0o755});
  const provider=createGitStagingProvider(f.options);await provider.prepare(f.makePackage());expect(await readFile(marker,'utf8')).toBe('hooked');
},30000);
it('rejects simultaneous different contents for the same immutable package revision',async()=>{
  const f=await gitStagingFixture();const provider=createGitStagingProvider(f.options);const first=f.makePackage();
  const files=new Map(first.files);files.set(first.manifest.files[0].path,Buffer.from('{"changed":true}'));const {contentHash:_hash,...base}=first.manifest.packageRevision;
  const second={manifest:buildPackageManifest({package:base,files}),files,expectedRemoteHead:null};
  const results=await Promise.allSettled([provider.prepare(first),provider.prepare(second)]);
  expect(results[0].status).toBe('fulfilled');expect(results[1]).toMatchObject({status:'rejected',reason:{code:'INTEGRITY_MISMATCH'}});
},30000);
it('checks the executable and exact project worktree root before fetching',async()=>{
  const f=await gitStagingFixture();const child=path.join(f.projectRoot,'nested');await mkdir(child);
  await expect(createGitStagingProvider({...f.options,projectRoot:child}).readMain()).rejects.toMatchObject({code:'GIT_CONFIGURATION_INVALID'});
  await expect(createGitStagingProvider({...f.options,gitExecutable:process.execPath}).readMain()).rejects.toMatchObject({code:'GIT_CONFIGURATION_INVALID'});
});
it('refuses an unrelated own remote branch without force, reset or automatic rebase',async()=>{
  const f=await gitStagingFixture();const input=f.makePackage();const branch=`uor/${input.manifest.packageRevision.curatorPersonId}/${input.manifest.packageRevision.packageId}`;
  const tree=await f.git(f.projectRoot,['rev-parse','HEAD^{tree}']);const unrelated=await f.git(f.projectRoot,['commit-tree',tree,'-m','synthetic unrelated history']);
  await f.git(f.projectRoot,['push','origin',unrelated+':refs/heads/'+branch]);
  const provider=createGitStagingProvider(f.options);await expect(provider.prepare({...input,expectedRemoteHead:unrelated})).rejects.toMatchObject({code:'PREVIEW_STALE'});
  expect(await provider.inspectRemote(branch)).toBe(unrelated);expect(await f.git(f.projectRoot,['rev-parse','HEAD'])).toBe(f.baseCommit);
},30000);
it('keeps option-like author attribution literal and never changes the global configuration',async()=>{
  const f=await gitStagingFixture();await f.git(f.projectRoot,['config','--local','--','user.name','--global']);
  const before=await readFile(process.env.GIT_CONFIG_GLOBAL!,'utf8');
  const prepared=await createGitStagingProvider(f.options).prepare(f.makePackage());
  expect(await f.git(prepared.checkout,['show','-s','--format=%an','HEAD'])).toBe('--global');expect(await readFile(process.env.GIT_CONFIG_GLOBAL!,'utf8')).toBe(before);
},30000);
it('isolates inherited Git repository variables from the running checkout',async()=>{
  const f=await gitStagingFixture();const before=await readFile(path.join(f.projectRoot,'.git','config'),'utf8');
  const beforeIndex=await readFile(path.join(f.projectRoot,'.git','index'));
  const previous=new Map(['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_COMMON_DIR'].map(key=>[key,process.env[key]]));
  let prepared;
  try {
    process.env.GIT_DIR=path.join(f.projectRoot,'.git');process.env.GIT_WORK_TREE=f.projectRoot;
    process.env.GIT_INDEX_FILE=path.join(f.projectRoot,'.git','index');process.env.GIT_OBJECT_DIRECTORY=path.join(f.projectRoot,'.git','objects');process.env.GIT_COMMON_DIR=path.join(f.projectRoot,'.git');
    prepared=await createGitStagingProvider(f.options).prepare(f.makePackage());
  } finally {for(const [key,value] of previous) if(value===undefined) delete process.env[key];else process.env[key]=value;}
  expect(prepared.checkout).not.toBe(f.projectRoot);expect(await f.git(f.projectRoot,['rev-parse','HEAD'])).toBe(f.baseCommit);
  expect(await readFile(path.join(f.projectRoot,'.git','config'),'utf8')).toBe(before);
  expect(await readFile(path.join(f.projectRoot,'.git','index'))).toEqual(beforeIndex);
},30000);
it('rejects unrelated changes inherited from an otherwise descendant proposal branch',async()=>{
  const f=await gitStagingFixture();const input=f.makePackage();const branch=`uor/${input.manifest.packageRevision.curatorPersonId}/${input.manifest.packageRevision.packageId}`;
  await mkdir(path.join(f.projectRoot,'config'));await writeFile(path.join(f.projectRoot,'config','private.local.json'),'synthetic-private');
  await f.git(f.projectRoot,['add','--','config/private.local.json']);await f.git(f.projectRoot,['commit','-m','unrelated source configuration']);
  const unrelated=await f.git(f.projectRoot,['rev-parse','HEAD']);await f.git(f.projectRoot,['push','origin',unrelated+':refs/heads/'+branch]);
  const provider=createGitStagingProvider(f.options);
  await expect(provider.prepare({...input,expectedRemoteHead:unrelated})).rejects.toMatchObject({code:'PREVIEW_STALE'});
  expect(await provider.inspectRemote(branch)).toBe(unrelated);expect(await f.git(f.projectRoot,['rev-parse','HEAD'])).toBe(unrelated);
},30000);
it('runs a configured home-relative corporate hook in the private checkout',async()=>{
  const f=await gitStagingFixture();const home=path.join(f.root,'synthetic home'),hooks=path.join(home,'corporate-hooks'),marker=path.join(f.root,'home-hook-ran.txt').replaceAll('\\','/');
  await mkdir(hooks,{recursive:true});await writeFile(path.join(hooks,'pre-commit'),'#!/bin/sh\nprintf hooked >> '+"'"+marker.replaceAll("'","'\\''")+"'"+'\n',{mode:0o755});
  await f.git(f.projectRoot,['config','core.hooksPath','~/corporate-hooks']);const previous=process.env.HOME;
  try {process.env.HOME=home;await createGitStagingProvider(f.options).prepare(f.makePackage());}
  finally {if(previous===undefined) delete process.env.HOME;else process.env.HOME=previous;}
  expect(await readFile(marker,'utf8')).toBe('hooked');
},30000);
it('reuses the committed candidate after final network verification fails',async()=>{
  const f=await gitStagingFixture();const hooks=path.resolve(f.projectRoot,await f.git(f.projectRoot,['rev-parse','--git-path','hooks']));
  const away=path.join(f.root,'remote-offline.git');const quoted=(value:string)=>"'"+value.replaceAll('\\','/').replaceAll("'","'\\''")+"'";
  const hook=path.join(hooks,'post-commit');await writeFile(hook,'#!/bin/sh\nmv '+quoted(f.remoteUrl)+' '+quoted(away)+'\n',{mode:0o755});
  const input=f.makePackage(),provider=createGitStagingProvider(f.options);
  await expect(provider.prepare(input)).rejects.toMatchObject({code:'GIT_PROVIDER_FAILED'});
  await rename(away,f.remoteUrl);await unlink(hook);
  const proposalRoot=path.join(f.runtimeRoot,'workbench-git');const repositoryRoot=path.join(proposalRoot,(await readdir(proposalRoot))[0]);
  const revisionRoot=path.join(repositoryRoot,'proposals',input.manifest.packageRevision.packageId,'1');
  const checkouts=(await readdir(revisionRoot)).filter(name=>name.startsWith('checkout-'));expect(checkouts).toHaveLength(1);
  const checkout=path.join(revisionRoot,checkouts[0]),commit=await f.git(checkout,['rev-parse','HEAD']);
  const prepared=await createGitStagingProvider(f.options).prepare(input);
  expect(prepared.checkout).toBe(checkout);expect(prepared.commit).toBe(commit);
  expect((await readdir(revisionRoot)).filter(name=>name.startsWith('checkout-'))).toEqual(checkouts);
  await expect(provider.verifyPrepared(prepared)).resolves.toBeUndefined();
  // Model a crash after commit, before the atomic descriptor becomes durable.
  await unlink(path.join(revisionRoot,'prepared','descriptor.json'));await rmdir(path.join(revisionRoot,'prepared'));
  const recovered=await createGitStagingProvider(f.options).prepare(input);
  expect(recovered).toEqual(prepared);expect((await readdir(revisionRoot)).filter(name=>name.startsWith('checkout-'))).toEqual(checkouts);
},30000);
