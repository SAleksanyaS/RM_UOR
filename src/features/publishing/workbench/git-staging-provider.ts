import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, writeFile, open, rename, unlink, rmdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { gitOidSchema, packageManifestSchema, packageRevisionSchema, type PackageManifest, type VerifiedMain } from './contracts';
import { assertPhysicalPackagePath, readPhysicalPackageFile, canonicalBytes, buildPackageManifest, hashBytes, integrity, validatePortablePaths } from './package-manifest';
import type { PreparedProposal, PublicationGitPort } from './git-port';

const execute=promisify(execFile);
const bad=(code='GIT_CONFIGURATION_INVALID',status=422):never=>{throw new WorkbenchHttpError(status,code,code);};
const stale=():never=>bad('PREVIEW_STALE',409);
const branchPattern=/^uor\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const preparedSchema=z.strictObject({packageRevision:packageRevisionSchema,checkout:z.string().min(1),branch:z.string().regex(branchPattern),commit:gitOidSchema,expectedRemoteHead:gitOidSchema.nullable()});
export type GitStagingOptions={projectRoot:string;runtimeRoot:string;repositoryId:string;remoteUrl:string;gitExecutable:string};
function assertRemote(value:string):void {
  if(!value || value.startsWith('-') || /[\x00-\x20\x7f`$|;<>"]/.test(value) && !path.isAbsolute(value)) return bad();
  if(path.isAbsolute(value)) {if(/[\x00-\x1f\x7f]/.test(value)) return bad();return;}
  try {
    const url=new URL(value);
    if(!['https:','ssh:'].includes(url.protocol) || url.password || url.protocol==='https:'&&url.username || url.search || url.hash || !url.hostname || !url.pathname || url.pathname==='/') return bad();
    return;
  } catch(error) {if(error instanceof WorkbenchHttpError) throw error;}
  if(!/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(value)) return bad();
}
function allowedRelative(name:string):void {
  validatePortablePaths([name]);
  if(!/^records\/[a-z][a-z0-9_]*\/[a-f0-9-]{36}\/[1-9][0-9]*\.json$/.test(name) && !/^artifacts\/[a-f0-9]{64}$/.test(name)) return integrity();
}
function allowedPublished(name:string):void {
  const match=/^published\/workbench\/packages\/[a-f0-9-]{36}\/[1-9][0-9]*\/(.+)$/.exec(name);if(!match) return integrity();
  if(match[1]!=='manifest.json') allowedRelative(match[1]);
}
const same=(left:unknown,right:unknown)=>hashBytes(canonicalBytes(left))===hashBytes(canonicalBytes(right));

/** Read/fetch and prepare only. External push/auth/PR gates belong to T25/T24. */
export function createGitStagingProvider(input:GitStagingOptions):PublicationGitPort {
  if(!input || !path.isAbsolute(input.projectRoot) || !path.isAbsolute(input.runtimeRoot) || !path.isAbsolute(input.gitExecutable) || !input.repositoryId.trim() || /[\x00-\x1f\x7f]/.test(input.repositoryId)) return bad();
  assertRemote(input.remoteUrl);
  const options={...input,projectRoot:path.resolve(input.projectRoot),runtimeRoot:path.resolve(input.runtimeRoot)};
  if(options.runtimeRoot===options.projectRoot || options.runtimeRoot===path.join(options.projectRoot,'.git') || options.runtimeRoot.startsWith(path.join(options.projectRoot,'.git')+path.sep)) return bad();
  const root=path.join(options.runtimeRoot,'workbench-git',hashBytes(Buffer.from(options.repositoryId)).slice(0,20));
  let cachePromise:Promise<string>|null=null;let readQueue=Promise.resolve();const preparing=new Map<string,{binding:string;work:Promise<PreparedProposal>}>();
  async function initializeRoot() {
    await assertPhysicalPackagePath(options.projectRoot);await assertPhysicalPackagePath(options.runtimeRoot,true);
    const executable=await realpath(options.gitExecutable);if(!(await lstat(executable)).isFile()) return bad();
    if(!/^git version [0-9]/.test(await text(options.projectRoot,['--version'],true))) return bad();
    const project=await text(options.projectRoot,['rev-parse','--show-toplevel'],true,[128]);
    if(!project || path.resolve(project).toLowerCase()!==options.projectRoot.toLowerCase()) return bad();
    await mkdir(root,{recursive:true});await assertPhysicalPackagePath(root);
    return executable;
  }
  async function invoke(cwd:string,args:string[],readOnly=false,allowed:number[]=[]):Promise<{bytes:Buffer;exitCode:number}> {
    await assertPhysicalPackagePath(cwd);
    const env:NodeJS.ProcessEnv=readOnly?{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}:{...process.env};
    for(const key of Object.keys(env)) if(['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_CEILING_DIRECTORIES','GIT_DISCOVERY_ACROSS_FILESYSTEM','GIT_SHALLOW_FILE','GIT_REPLACE_REF_BASE','GIT_QUARANTINE_PATH','GIT_PREFIX','GIT_IMPLICIT_WORK_TREE','GIT_CONFIG'].includes(key.toUpperCase())) delete env[key];
    try {const result=await execute(options.gitExecutable,args,{cwd,shell:false,windowsHide:true,env,encoding:'buffer',timeout:30000,maxBuffer:40*1024*1024});return {bytes:result.stdout,exitCode:0};}
    catch(error) {
      const failure=error as {code?:number|string;stdout?:Buffer};
      if(typeof failure.code==='number'&&allowed.includes(failure.code)) return {bytes:failure.stdout??Buffer.alloc(0),exitCode:failure.code};
      return bad('GIT_PROVIDER_FAILED',503);
    }
  }
  const text=async(cwd:string,args:string[],readOnly=false,allowed:number[]=[])=>new TextDecoder('utf-8',{fatal:true}).decode((await invoke(cwd,args,readOnly,allowed)).bytes).trim();
  const origin=async(cwd:string)=>{if(await text(cwd,['remote','get-url','origin'],true)!==options.remoteUrl) return bad();};
  async function cache():Promise<string> {
    if(!cachePromise) cachePromise=(async()=>{
      await initializeRoot();const cwd=path.join(root,'reader-'+randomUUID());await mkdir(cwd);await assertPhysicalPackagePath(cwd);
      await text(cwd,['-c','core.longpaths=true','init','--initial-branch=uor-reader']);await text(cwd,['config','core.longpaths','true']);await text(cwd,['remote','add','origin',options.remoteUrl]);return cwd;
    })();
    return cachePromise;
  }
  async function remote(cwd:string,branch:string):Promise<string|null> {
    await origin(cwd);const value=await text(cwd,['ls-remote','--heads','origin','refs/heads/'+branch],true);
    if(!value) return null;const lines=value.split(/\r?\n/);if(lines.length!==1) return bad();const [oid,name]=lines[0].split(/\s+/);
    if(name!=='refs/heads/'+branch || !gitOidSchema.safeParse(oid).success) return bad();return oid;
  }
  async function commit(cwd:string,oid:string):Promise<void> {
    gitOidSchema.parse(oid);if(await text(cwd,['cat-file','-t',oid],true)!=='commit' || await text(cwd,['rev-parse','--verify',oid+'^{commit}'],true)!==oid) return integrity();
  }
  async function tree(cwd:string,oid:string):Promise<Map<string,Uint8Array>> {
    await commit(cwd,oid);const listing=(await invoke(cwd,['ls-tree','-rz',oid,'--','published/workbench/packages'],true)).bytes;
    const names=new TextDecoder('utf-8',{fatal:true}).decode(listing).split('\0').filter(Boolean);const files=new Map<string,Uint8Array>();
    for(const entry of names) {
      const match=/^100644 blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(entry);if(!match) return integrity();const name=match[2];allowedPublished(name);if(files.has(name)) return integrity();
      const bytes=(await invoke(cwd,['show',oid+':'+name],true)).bytes;if(bytes.byteLength>32*1024*1024) return integrity();files.set(name,bytes);
    }
    validatePortablePaths([...files.keys()]);return files;
  }
  async function readMain():Promise<VerifiedMain> {
    const prior=readQueue;let release!:()=>void;readQueue=new Promise<void>(resolve=>{release=resolve;});await prior;
    try {
      const cwd=await cache(),observed=await remote(cwd,'main');if(!observed) return bad('MAIN_NOT_FOUND',404);
      await text(cwd,['fetch','--no-tags','origin','refs/heads/main:refs/remotes/origin/main'],true);
      if(await text(cwd,['rev-parse','refs/remotes/origin/main'],true)!==observed) return stale();
      return {repositoryId:options.repositoryId,commit:observed,files:await tree(cwd,observed)};
    } finally {release();}
  }
  async function readAcceptedMainAt(oid:string):Promise<VerifiedMain> {
    gitOidSchema.parse(oid);
    const accepted=await readMain(),cwd=await cache();
    await commit(cwd,oid);
    if((await invoke(cwd,['merge-base','--is-ancestor',oid,accepted.commit],true,[1])).exitCode!==0) return integrity();
    return {repositoryId:options.repositoryId,commit:oid,files:await tree(cwd,oid)};
  }
  async function assertProposalDelta(cwd:string,tip:string,revision:PackageManifest['packageRevision'],maxRevision:number):Promise<void> {
    const changes=new TextDecoder('utf-8',{fatal:true}).decode((await invoke(cwd,['diff','--name-status','-z','--no-renames',revision.baseCommit,tip],true)).bytes).split('\0');
    if(changes.pop()!=='') return stale();const groups=new Map<string,Set<string>>();
    for(let i=0;i<changes.length;i+=2) {
      const name=changes[i+1],match=/^published\/workbench\/packages\/([a-f0-9-]{36})\/([1-9][0-9]*)\/(.+)$/.exec(name??'');
      if(changes[i]!=='A'||!match||match[1]!==revision.packageId||Number(match[2])>maxRevision) return stale();
      const prefix=`published/workbench/packages/${match[1]}/${match[2]}/`;const members=groups.get(prefix)??new Set<string>();members.add(match[3]);groups.set(prefix,members);
    }
    const published=await tree(cwd,tip);
    for(const [prefix,members] of groups) {
      const manifestBytes=published.get(prefix+'manifest.json');if(!manifestBytes) return stale();
      const manifest=packageManifestSchema.parse(JSON.parse(Buffer.from(manifestBytes).toString('utf8'))),owner=manifest.packageRevision;
      if(owner.packageId!==revision.packageId||owner.curatorPersonId!==revision.curatorPersonId||owner.cycleId!==revision.cycleId||prefix!==`published/workbench/packages/${owner.packageId}/${owner.revision}/`) return stale();
      const files=new Map<string,Uint8Array>();for(const [name,bytes] of published) if(name.startsWith(prefix)&&name!==prefix+'manifest.json') files.set(name.slice(prefix.length),bytes);
      if(!same([...members].sort(),['manifest.json',...files.keys()].sort())) return stale();
      const {contentHash:_hash,...base}=owner;if(!same(buildPackageManifest({package:base,files}),manifest)) return stale();
    }
  }
  const revisionDirectory=(revision:PreparedProposal['packageRevision'])=>path.join(root,'proposals',revision.packageId,String(revision.revision));
  const metadata=(revision:PreparedProposal['packageRevision'])=>path.join(revisionDirectory(revision),'prepared','descriptor.json');
  async function stored(revision:PreparedProposal['packageRevision']):Promise<PreparedProposal|null> {
    const filename=metadata(revision);try {await lstat(filename);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error;}
    return preparedSchema.parse(JSON.parse((await readPhysicalPackageFile(filename)).toString('utf8')));
  }
  async function validatePreparedLocal(value:PreparedProposal,manifest:PackageManifest):Promise<void> {
    const proposal=preparedSchema.parse(value),revision=manifest.packageRevision;
    if(!same(proposal.packageRevision,revision) || proposal.branch!==`uor/${revision.curatorPersonId}/${revision.packageId}`) return stale();
    const parent=revisionDirectory(revision);if(path.dirname(proposal.checkout)!==parent || !/^checkout-[0-9a-f-]{36}$/.test(path.basename(proposal.checkout))) return stale();
    await assertPhysicalPackagePath(proposal.checkout);await origin(proposal.checkout);
    if(await text(proposal.checkout,['rev-parse','HEAD'],true)!==proposal.commit || await text(proposal.checkout,['branch','--show-current'],true)!==proposal.branch) return stale();
    if(await text(proposal.checkout,['status','--porcelain','--untracked-files=all'],true)) return stale();
    await commit(proposal.checkout,proposal.commit);
    const expectedParent=proposal.expectedRemoteHead??revision.baseCommit;
    if(await text(proposal.checkout,['rev-parse',proposal.commit+'^'],true)!==expectedParent) return stale();
    await assertProposalDelta(proposal.checkout,proposal.commit,revision,revision.revision);
    const prefix=`published/workbench/packages/${revision.packageId}/${revision.revision}/`;
    const expected=[prefix+'manifest.json',...manifest.files.map(file=>prefix+file.path)].sort();
    const changed=(await text(proposal.checkout,['diff','--name-only','--no-renames',expectedParent,proposal.commit],true)).split(/\r?\n/).filter(Boolean).sort();
    if(!same(changed,expected)) return stale();
    const files=await tree(proposal.checkout,proposal.commit);const actualManifest=files.get(prefix+'manifest.json');if(!actualManifest || !same(JSON.parse(Buffer.from(actualManifest).toString('utf8')),manifest)) return stale();
    for(const file of manifest.files) {const bytes=files.get(prefix+file.path);if(!bytes || bytes.byteLength!==file.bytes || hashBytes(bytes)!==file.sha256) return stale();}
  }
  async function validatePrepared(value:PreparedProposal,manifest:PackageManifest):Promise<void> {
    await validatePreparedLocal(value,manifest);
    const main=await readMain();if(main.commit!==manifest.packageRevision.baseCommit || await remote(await cache(),value.branch)!==value.expectedRemoteHead) return stale();
  }
  async function checkpoint(proposal:PreparedProposal):Promise<PreparedProposal> {
    const destination=path.dirname(metadata(proposal.packageRevision)),staged=path.join(revisionDirectory(proposal.packageRevision),'.prepared-'+randomUUID());
    await assertPhysicalPackagePath(destination,true);await mkdir(staged);const filename=path.join(staged,'descriptor.json');
    const handle=await open(filename,'wx');try {await handle.writeFile(canonicalBytes(proposal));await handle.sync();} finally {await handle.close();}
    try {await rename(staged,destination);return proposal;}
    catch(error) {
      if(!['EEXIST','ENOTEMPTY','EPERM'].includes((error as NodeJS.ErrnoException).code??'')) throw error;
      const winner=await stored(proposal.packageRevision);
      if(!winner||!same(winner.packageRevision,proposal.packageRevision)||winner.expectedRemoteHead!==proposal.expectedRemoteHead) return stale();
      return winner;
    } finally {
      // Remove only this call's two known temporary entries, never a saved checkout.
      await unlink(filename).catch(error=>{if(error.code!=='ENOENT') throw error;});
      await rmdir(staged).catch(error=>{if(error.code!=='ENOENT') throw error;});
    }
  }
  async function recoverCandidate(manifest:PackageManifest,expectedRemoteHead:string|null):Promise<PreparedProposal|null> {
    const parent=revisionDirectory(manifest.packageRevision);let entries;
    try {await assertPhysicalPackagePath(parent);entries=await readdir(parent,{withFileTypes:true});}
    catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT') return null;throw error;}
    for(const entry of entries) {
      if(!entry.isDirectory()||!/^checkout-[0-9a-f-]{36}$/.test(entry.name)) continue;
      const checkout=path.join(parent,entry.name),revision=manifest.packageRevision;
      try {
        const bytes=await readPhysicalPackageFile(path.join(checkout,'published','workbench','packages',revision.packageId,String(revision.revision),'manifest.json'));
        if(!same(JSON.parse(bytes.toString('utf8')),manifest)) continue;
        const candidate={packageRevision:revision,checkout,branch:`uor/${revision.curatorPersonId}/${revision.packageId}`,commit:await text(checkout,['rev-parse','HEAD'],true),expectedRemoteHead};
        await validatePreparedLocal(candidate,manifest);return checkpoint(candidate);
      } catch(error) {
        if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof WorkbenchHttpError&&['PREVIEW_STALE','GIT_PROVIDER_FAILED'].includes(error.code)) continue;
        throw error;
      }
    }
    return null;
  }
  const port:PublicationGitPort={
    readAcceptedMainAt,
    readMain,
    async inspectRemote(branch) {if(!branchPattern.test(branch)) return bad();return remote(await cache(),branch);},
    async verifyPrepared(candidate) {
      const parsed=preparedSchema.parse(candidate);const saved=await stored(parsed.packageRevision);if(!saved || !same(saved,parsed)) return stale();
      const prefix=path.join(saved.checkout,'published','workbench','packages',saved.packageRevision.packageId,String(saved.packageRevision.revision));
      const manifest=packageManifestSchema.parse(JSON.parse((await readPhysicalPackageFile(path.join(prefix,'manifest.json'))).toString('utf8')));
      return validatePrepared(saved,manifest);
    },
    async prepare(unparsed) {
      const manifest=packageManifestSchema.parse(unparsed.manifest);const files=new Map([...unparsed.files].map(([name,bytes])=>[name,new Uint8Array(bytes)]));
      const expectedRemoteHead=unparsed.expectedRemoteHead===null?null:gitOidSchema.parse(unparsed.expectedRemoteHead);
      for(const [name,bytes] of files) {allowedRelative(name);if(bytes.byteLength>32*1024*1024) return integrity();}
      const {contentHash:_hash,...base}=manifest.packageRevision;
      if(!same(buildPackageManifest({package:base,files}),manifest)) return integrity();
      const key=manifest.packageRevision.packageId+'/'+manifest.packageRevision.revision;const binding=hashBytes(canonicalBytes({manifest,expectedRemoteHead}));
      const pending=preparing.get(key);if(pending) {if(pending.binding!==binding) return integrity();return pending.work;}
      const work=(async()=>{
        const revision=manifest.packageRevision;const branch=`uor/${revision.curatorPersonId}/${revision.packageId}`;
        const main=await readMain();if(main.commit!==revision.baseCommit || await remote(await cache(),branch)!==expectedRemoteHead) return stale();
        const existing=await stored(revision);if(existing) {if(existing.expectedRemoteHead!==expectedRemoteHead || !same(existing.packageRevision,revision)) return stale();await port.verifyPrepared(existing);return existing;}
        const recovered=await recoverCandidate(manifest,expectedRemoteHead);if(recovered) {await validatePrepared(recovered,manifest);return recovered;}
        const parent=revisionDirectory(revision);await assertPhysicalPackagePath(parent,true);await mkdir(parent,{recursive:true});await assertPhysicalPackagePath(parent);
        const checkout=path.join(parent,'checkout-'+randomUUID());await mkdir(checkout);await assertPhysicalPackagePath(checkout);
        await text(checkout,['-c','core.longpaths=true','init','--initial-branch=uor-staging']);await text(checkout,['config','core.longpaths','true']);await text(checkout,['remote','add','origin',options.remoteUrl]);
        await text(checkout,['fetch','--no-tags','origin','refs/heads/main'],true);if(await text(checkout,['rev-parse','FETCH_HEAD'],true)!==revision.baseCommit) return stale();
        const start=expectedRemoteHead??revision.baseCommit;
        if(expectedRemoteHead) {
          await text(checkout,['fetch','--no-tags','origin','refs/heads/'+branch],true);if(await text(checkout,['rev-parse','FETCH_HEAD'],true)!==expectedRemoteHead) return stale();
          if((await invoke(checkout,['merge-base','--is-ancestor',revision.baseCommit,expectedRemoteHead],true,[1])).exitCode!==0) return stale();
          await assertProposalDelta(checkout,expectedRemoteHead,revision,revision.revision-1);
        }
        await text(checkout,['switch','--create',branch,start]);
        const name=await text(options.projectRoot,['config','--get','user.name'],true,[1]),email=await text(options.projectRoot,['config','--get','user.email'],true,[1]);
        if(!name||!email||/[\x00-\x1f\x7f]/.test(name+email)) return bad();
        await text(checkout,['config','user.name',name]);await text(checkout,['config','user.email',email]);
        const sourceHooks=await text(options.projectRoot,['rev-parse','--git-path','hooks'],true);
        const configuredHooks=await text(options.projectRoot,['config','--path','--get','core.hooksPath'],true,[1]);
        const hooks=path.resolve(options.projectRoot,configuredHooks||sourceHooks);await text(checkout,['config','core.hooksPath',hooks]);
        const prefix=`published/workbench/packages/${revision.packageId}/${revision.revision}/`;
        for(const [relative,bytes] of [...files,["manifest.json",canonicalBytes(manifest)] as const]) {
          const filename=path.join(checkout,prefix,relative);await assertPhysicalPackagePath(filename,true);await mkdir(path.dirname(filename),{recursive:true});await assertPhysicalPackagePath(path.dirname(filename));await writeFile(filename,bytes,{flag:'wx'});
        }
        await text(checkout,['add','--',prefix+'manifest.json',...manifest.files.map(file=>prefix+file.path)]);
        await text(checkout,['commit','-m',`UOR package ${revision.packageId} revision ${revision.revision}`]);
        const proposal:PreparedProposal={packageRevision:revision,checkout,branch,commit:await text(checkout,['rev-parse','HEAD'],true),expectedRemoteHead};
        await validatePreparedLocal(proposal,manifest);const saved=await checkpoint(proposal);
        await validatePrepared(saved,manifest);return saved;
      })();
      preparing.set(key,{binding,work});try{return await work;}finally{if(preparing.get(key)?.work===work) preparing.delete(key);}
    },
  };
  return port;
}
