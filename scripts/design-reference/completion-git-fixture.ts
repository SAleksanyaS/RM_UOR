import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Clock, Header } from '../../src/domain/workbench/primitives';
import type { PublicationAnchor } from '../../src/domain/workbench/publication';
import type { WorkbenchRepository } from '../../src/server/storage/workbench-repository';
import type { PublicationGitPort } from '../../src/features/publishing/workbench/git-port';
import type { PublicationClassification } from '../../src/features/publishing/workbench/package-preview';
import { createGitStagingProvider } from '../../src/features/publishing/workbench/git-staging-provider';
import { buildPackageManifest, canonicalBytes } from '../../src/features/publishing/workbench/package-manifest';
import { validatePublicationCandidate } from '../../src/features/publishing/workbench/publication-validation';

const execute=promisify(execFile);
const repositoryId='synthetic-design-reference';

/** Disposable actual Git transport for the explicitly synthetic design-reference
 * workspace. It supplies neither Bitbucket acceptance nor a successful preview DTO. */
export async function createCompletionGitFixture({directory,gitExecutable='/usr/bin/git'}:{directory:string;gitExecutable?:string}) {
  if(!path.isAbsolute(directory)||!path.isAbsolute(gitExecutable))throw Error('Completion Git fixture requires absolute local paths');
  await mkdir(directory,{recursive:true});const parent=await realpath(directory);
  const root=await mkdtemp(path.join(parent,'uor-completion-git-')),projectRoot=path.join(root,'source'),remoteUrl=path.join(root,'shared.git'),runtimeRoot=path.join(root,'private-staging');
  const isolatedConfig=path.join(root,'synthetic-global.gitconfig');await writeFile(isolatedConfig,'',{flag:'wx'});
  const env={...process.env,GIT_CONFIG_GLOBAL:isolatedConfig,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_CONFIG','GIT_CONFIG_COUNT'])delete (env as NodeJS.ProcessEnv)[key];
  const run=async(cwd:string,args:string[])=>String((await execute(gitExecutable,args,{cwd,env,shell:false,windowsHide:true,timeout:30000,maxBuffer:16*1024*1024})).stdout).trim();
  let provider:PublicationGitPort|null=null,seeded=false,closed=false;
  const ready=()=>{if(closed||!provider)throw Error('Synthetic Git fixture has not been seeded or is closed');return provider;};
  const git:PublicationGitPort={
    readMain:()=>ready().readMain(),
    readAcceptedMainAt:commit=>ready().readAcceptedMainAt!(commit),
    prepare:input=>ready().prepare(input),
    inspectRemote:branch=>ready().inspectRemote(branch),
    verifyPrepared:prepared=>ready().verifyPrepared(prepared),
    readCandidate:prepared=>ready().readCandidate!(prepared),
  };
  // Every record in this disposable workspace is explicitly synthetic. The
  // production default and local_preview external-send policy are unchanged.
  const classification:PublicationClassification={mode:'demo-only',classifyRecord:()=>seeded&&!closed};
  async function seed(repository:WorkbenchRepository,clock:Clock) {
    if(closed||provider)throw Error('Synthetic Git fixture may be seeded exactly once');
    const records=repository.exportWorkspaceCore(),anchors=records.filter(r=>r.entityType==='publication_anchor').map(r=>r.value as PublicationAnchor);
    if(!anchors.length||anchors.some(anchor=>anchor.repositoryId!==repositoryId||anchor.id!==anchor.packageId||anchor.publicationState!=='confirmed'))throw Error('Only the explicit synthetic-design-reference seed is allowed');
    const known=new Map(anchors.map(anchor=>[anchor.id,anchor]));
    const entries=records.filter(r=>r.entityType!=='publication_anchor'&&'publicationAnchorId' in r.value&&r.value.publicationAnchorId!==null).map(r=>({entityType:r.entityType,value:r.value as Header}));
    if(!entries.length||entries.some(({value})=>!known.has(value.publicationAnchorId!)||value.actor.hostname!=='synthetic-design-reference'))throw Error('Refusing non-reference business data');
    await mkdir(projectRoot);await run(root,['init','--bare','--initial-branch=main',remoteUrl]);await run(projectRoot,['init','--initial-branch=main']);
    await run(projectRoot,['config','user.name','Synthetic Design Reference']);await run(projectRoot,['config','user.email','synthetic-design-reference@local.invalid']);
    await writeFile(path.join(projectRoot,'README.md'),'Disposable synthetic workbench publication fixture. No bank data.\n',{flag:'wx'});
    await run(projectRoot,['add','--','README.md']);await run(projectRoot,['commit','-m','Create disposable synthetic reference repository']);
    const baseCommit=await run(projectRoot,['rev-parse','HEAD']),paths:string[]=[];
    for(const anchor of known.values()){
      const selected=entries.filter(({value})=>value.publicationAnchorId===anchor.id),files=new Map(selected.map(({entityType,value})=>[`records/${entityType}/${value.id}/${value.revision}.json`,canonicalBytes(value)]));
      const curatorPersonId=selected.map(({value})=>value.actor.profilePersonId).find((id):id is string=>id!==null);if(!curatorPersonId)throw Error('Synthetic reference has no declared curator');
      const manifest=buildPackageManifest({package:{schemaVersion:1,packageId:anchor.packageId,cycleId:anchor.packageId,curatorPersonId,revision:anchor.revision,baseCommit,targetBranch:'main',createdAt:clock.now()},files}),prefix=`published/workbench/packages/${anchor.id}/${anchor.revision}/`;
      for(const [relative,bytes]of [...files,['manifest.json',canonicalBytes(manifest)]as const]){
        const name=prefix+relative,filename=path.join(projectRoot,name);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,bytes,{flag:'wx'});paths.push(name);
      }
    }
    await run(projectRoot,['add','--',...paths]);await run(projectRoot,['commit','-m','Publish complete synthetic reference capsules']);
    await run(projectRoot,['remote','add','origin',remoteUrl]);await run(projectRoot,['push','origin','main']);
    provider=createGitStagingProvider({projectRoot,runtimeRoot,repositoryId,remoteUrl,gitExecutable});
    const main=await provider.readMain(),treeOid=await run(projectRoot,['rev-parse',main.commit+'^{tree}']);
    validatePublicationCandidate({target:{repositoryId,commit:baseCommit,files:new Map()},candidate:{repositoryId,sourceOid:main.commit,targetOid:baseCommit,candidateTreeOid:treeOid,files:main.files}});
    seeded=true;return {repositoryId,mainCommit:main.commit,treeOid,packageIds:[...known.keys()]};
  }
  async function close(){
    if(closed)return;closed=true;
    const owned=await realpath(root);if(path.dirname(owned)!==parent||!path.basename(owned).startsWith('uor-completion-git-'))throw Error('Unsafe synthetic fixture cleanup');
    await rm(owned,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
  return {git,classification,seed,close};
}
