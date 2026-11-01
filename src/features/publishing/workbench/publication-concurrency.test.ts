import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { gitStagingFixture, stagingCleanups } from '../../../../tests/fixtures/workbench/git-staging';
import { fixtureId, makeEntityGraph, makeNumericFixture } from '../../../../tests/fixtures/workbench/factories';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createCommandStore, withCommandExecution } from '../../../server/workbench/command-store';
import type { CommandContext } from '../../../server/workbench/command-registry';
import { publicationApplyResultSchema } from './contracts';
import { createGitStagingProvider } from './git-staging-provider';
import { createPackageArtifactStore } from './package-artifacts';
import { buildPackageManifest, canonicalBytes } from './package-manifest';
import { readMainProjection } from './package-projection';
import { applyVerifiedPublication, readAppliedPublication } from './publication-apply';
import { validatePublicationCandidate } from './publication-validation';
import { syntheticPublishedTree } from './testing/candidate-fixture';

afterEach(async()=>{for(const cleanup of stagingCleanups.splice(0).reverse())await cleanup();});
async function fixture(){
  const f=await gitStagingFixture(),graph=makeEntityGraph(makeNumericFixture({scope:{kind:'dit',id:fixtureId(101)}}));
  const files=syntheticPublishedTree(graph.entries,f.baseCommit,'2026-11-01T08:00:00Z',fixtureId(17));
  for(const [name,bytes]of files){const filename=path.join(f.projectRoot,name);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,bytes,{flag:'wx'});}
  await f.git(f.projectRoot,['add','--',...files.keys()]);await f.git(f.projectRoot,['commit','-m','Synthetic accepted graph']);await f.git(f.projectRoot,['push','origin','main']);
  const provider=createGitStagingProvider(f.options),main=await provider.readMain();
  const proposal=(id:number,revision:number,baseCommit:string,patch:Record<string,unknown>,goalRevision=2)=>{
    const packageId=fixtureId(id),value={...graph.input.goal,...patch,revision:goalRevision,publicationAnchorId:packageId};
    const files=new Map([[`records/core_goal_definition/${value.id}/${value.revision}.json`,canonicalBytes(value)]]);
    const manifest=buildPackageManifest({package:{schemaVersion:1,packageId,revision,cycleId:fixtureId(id+1),curatorPersonId:fixtureId(id+2),baseCommit,targetBranch:'main',createdAt:'2026-11-01T09:00:00Z'},files});
    return {manifest,files,expectedRemoteHead:null as string|null};
  };
  const firstA=await provider.prepare(proposal(930001,1,main.commit,{title:'Accepted title A'})),firstB=await provider.prepare(proposal(930011,1,main.commit,{description:'Own description B'}));
  for(const candidate of [firstA,firstB])await f.git(candidate.checkout,['push','origin',candidate.commit+':refs/heads/'+candidate.branch]);
  const accept=async(commit:string)=>{await f.git(f.projectRoot,['fetch','origin']);await f.git(f.projectRoot,['merge','--ff-only',commit]);await f.git(f.projectRoot,['push','origin','main']);};
  return {...f,graph,provider,main,proposal,firstA,firstB,accept};
}
it('rejects an actual clean two-curator Git merge before acceptance and retains a reader last-good main if external acceptance ignores the gate',async()=>{
  const f=await fixture(),repository=createWorkbenchRepository({filename:path.join(f.root,'reader.sqlite'),artifactRoot:path.join(f.root,'reader-artifacts')});
  stagingCleanups.push(async()=>repository.close());
  const commands=createCommandStore(repository),clock={now:()=> '2026-11-01T09:00:00Z'};let serial=931000;
  const apply=async()=>{
    const main=await f.provider.readMain(),commandId=fixtureId(serial++);
    const context:CommandContext={repository,clock,commandId,requestId:commandId,installationId:fixtureId(1),actor:{hostname:'synthetic-reader',installationId:fixtureId(1),profilePersonId:null},ownAccess:{role:'viewer',personId:null,displayName:null,policyState:'unavailable',checkedAt:null}};
    commands.begin({commandId,name:'publication.apply',baseRevision:null,payload:{mainCommit:main.commit}},context.installationId);
    return withCommandExecution(context,publicationApplyResultSchema,()=>applyVerifiedPublication(context,{mainCommit:main.commit},{repository,clock,git:f.provider,bitbucket:null,artifacts:createPackageArtifactStore({artifactRoot:path.join(f.root,'reader-packages')}),publication:{mode:'demo-only',classifyRecord:()=>true}}));
  };
  await apply();await f.accept(f.firstA.commit);await apply();const lastGood=readAppliedPublication(repository),saved=repository.exportWorkspaceCore();
  const target=await f.provider.readMain();
  // Different capsule paths make native Git merge clean despite equal entity revision numbers.
  await f.git(f.projectRoot,['merge','--no-ff','--no-edit',f.firstB.commit]);
  const merged=await f.git(f.projectRoot,['rev-parse','HEAD']),treeOid=await f.git(f.projectRoot,['rev-parse','HEAD^{tree}']);
  const names=(await f.git(f.projectRoot,['ls-tree','-r','--name-only',merged,'--','published/workbench/packages'])).split('\n');
  const files=new Map<string,Uint8Array>();for(const name of names)files.set(name,Buffer.from(await f.git(f.projectRoot,['show',merged+':'+name])));
  expect(()=>validatePublicationCandidate({target,candidate:{repositoryId:target.repositoryId,sourceOid:f.firstB.commit,targetOid:target.commit,candidateTreeOid:treeOid,files}})).toThrowError(expect.objectContaining({code:'INTEGRITY_MISMATCH'}));
  // Deliberately bypass the local gate in this owned bare fixture to model an
  // unsupported external hosting merge. The real reader must still fail closed.
  await f.git(f.projectRoot,['push','origin','main']);await expect(apply()).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
  expect(readAppliedPublication(repository)).toEqual(lastGood);expect(repository.exportWorkspaceCore()).toEqual(saved);
},60000);
it('reconciles independent fields into a fresh capsule, keeps prior proposal history, and validates the exact native future tree before a normal FF update',async()=>{
  const f=await fixture();await f.accept(f.firstA.commit);const target=await f.provider.readMain();
  await expect(f.provider.readCandidate!(f.firstB)).rejects.toMatchObject({code:'PREVIEW_STALE'});
  const next={...f.proposal(930011,2,target.commit,{title:'Accepted title A',description:'Own description B'},3),expectedRemoteHead:f.firstB.commit};
  const prepared=await f.provider.prepare(next),exact=await f.provider.readCandidate!(prepared),proof=validatePublicationCandidate(exact);
  expect(proof.candidateTreeOid).toBe(await f.git(prepared.checkout,['rev-parse',prepared.commit+'^{tree}']));
  expect((await f.git(prepared.checkout,['show','-s','--format=%P',prepared.commit])).split(' ')).toEqual([f.firstB.commit,target.commit]);
  await f.git(prepared.checkout,['push','origin',prepared.commit+':refs/heads/'+prepared.branch]);await f.accept(prepared.commit);
  const accepted=await f.provider.readMain(),projection=readMainProjection(accepted);
  expect(projection.heads.get(`core_goal_definition/${f.graph.input.goal.id}`)?.value).toMatchObject({revision:3,title:'Accepted title A',description:'Own description B'});
  expect(accepted.files.has(`published/workbench/packages/${f.firstB.packageRevision.packageId}/1/manifest.json`)).toBe(true);
  expect((await f.argv()).flat().some(arg=>['--force','--force-with-lease','reset','rebase'].includes(arg))).toBe(false);
},60000);
