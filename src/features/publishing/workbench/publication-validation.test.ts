import { expect, it } from 'vitest';
import type { WorkbenchEntity, WorkbenchEntityType } from '../../../domain/workbench/entities';
import { fixtureId, makeEntityGraph, makeNumericFixture } from '../../../../tests/fixtures/workbench/factories';
import { buildPackageManifest, canonicalBytes } from './package-manifest';
import { assertPublicationCandidateProof, validatePublicationCandidate } from './publication-validation';

type Entry={entityType:WorkbenchEntityType;value:WorkbenchEntity};
const oid=(char:string)=>char.repeat(40),repositoryId='synthetic-candidate';
function capsule(entries:Entry[],id:number,revision=1){
  const packageId=fixtureId(id),files=new Map(entries.map(({entityType,value})=>[`records/${entityType}/${value.id}/${value.revision}.json`,canonicalBytes({...value,publicationAnchorId:packageId})]));
  const manifest=buildPackageManifest({package:{schemaVersion:1,packageId,revision,cycleId:fixtureId(id+1),curatorPersonId:fixtureId(17),baseCommit:oid('a'),targetBranch:'main',createdAt:'2026-11-01T08:00:00Z'},files});
  const prefix=`published/workbench/packages/${packageId}/${revision}/`;
  const tree=new Map<string,Uint8Array>([...files].map(([name,bytes])=>[prefix+name,bytes] as const));tree.set(prefix+'manifest.json',canonicalBytes(manifest));return tree;
}
function fixture(){
  const graph=makeEntityGraph(makeNumericFixture({scope:{kind:'dit',id:fixtureId(101)}})),target={repositoryId,commit:oid('a'),files:capsule(graph.entries,920001)};
  const candidate={repositoryId,sourceOid:oid('b'),targetOid:target.commit,candidateTreeOid:oid('c'),files:new Map(target.files)};
  return {graph,target,candidate};
}
it('validates the complete future graph, including independent capsules, with an exact local proof',()=>{
  const f=fixture(),other=makeEntityGraph(makeNumericFixture({seedBase:100000,scope:{kind:'dit',id:fixtureId(100101)}}));
  for(const [name,bytes] of capsule(other.entries,920011)) f.candidate.files.set(name,bytes);
  const bytes=()=>[...f.candidate.files].map(([name,value])=>[name,Buffer.from(value).toString('hex')]);
  const before=bytes(),proof=validatePublicationCandidate(f);
  expect(proof).toMatchObject({repositoryId,sourceOid:oid('b'),targetOid:oid('a'),candidateTreeOid:oid('c'),remoteAcceptance:'not-enforced'});
  expect(proof.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);expect(()=>assertPublicationCandidateProof(proof,f)).not.toThrow();expect(bytes()).toEqual(before);
});
it('rejects two clean capsule additions that allocate different bytes to the same entity revision',()=>{
  const f=fixture();
  for(const [id,title] of [[920021,'Curator A'],[920031,'Curator B']] as const) for(const [name,bytes] of capsule([{entityType:'core_goal_definition',value:{...f.graph.input.goal,revision:2,title}}],id)) f.candidate.files.set(name,bytes);
  expect(()=>validatePublicationCandidate(f)).toThrowError(expect.objectContaining({code:'INTEGRITY_MISMATCH'}));
});
it('checks unchanged dependants of a changed definition in the complete candidate graph',()=>{
  const f=fixture();
  for(const [name,bytes] of capsule([{entityType:'core_goal_definition',value:{...f.graph.input.goal,revision:2,mode:'manual_status'}}],920041))f.candidate.files.set(name,bytes);
  expect(()=>validatePublicationCandidate(f)).toThrow();
});
it.each(['sourceOid','targetOid','candidateTreeOid','repositoryId','bytes'] as const)('invalidates a prior proof after %s movement',fault=>{
  const f=fixture(),proof=validatePublicationCandidate(f);
  if(fault==='bytes'){const name=f.candidate.files.keys().next().value!;f.candidate.files.set(name,Buffer.from('{}'));}
  else f.candidate[fault]=fault==='repositoryId'?'changed-repository':oid('d');
  expect(()=>assertPublicationCandidateProof(proof,f)).toThrowError(expect.objectContaining({code:'PREVIEW_STALE'}));
});
it('rejects changed target bytes with the same claimed target OID and an unchanged candidate',()=>{
  const f=fixture(),proof=validatePublicationCandidate(f),name=f.target.files.keys().next().value!;
  f.target.files.set(name,Buffer.from('{}'));
  expect(()=>assertPublicationCandidateProof(proof,f)).toThrowError(expect.objectContaining({code:'PREVIEW_STALE'}));
});
it('preserves accepted capsules and refuses later replacement of an already accepted package revision',()=>{
  const f=fixture(),name=f.target.files.keys().next().value!;
  f.candidate.files.delete(name);expect(()=>validatePublicationCandidate(f)).toThrowError(expect.objectContaining({code:'PUBLICATION_CONTENT_IMMUTABLE'}));
  f.candidate.files=new Map([...f.target.files,...capsule(f.graph.entries,920001,2)]);
  expect(()=>validatePublicationCandidate(f)).toThrowError(expect.objectContaining({code:'PUBLICATION_CONTENT_IMMUTABLE'}));
});
it('keeps abandoned proposal bytes but evaluates only the latest revision of that unaccepted package',()=>{
  const f=fixture(),acceptedGoal={entityType:'core_goal_definition' as const,value:{...f.graph.input.goal,revision:2,title:'Accepted independent title'}};
  f.target.files=new Map([...f.target.files,...capsule([acceptedGoal],920051)]);
  const abandoned={entityType:'core_goal_definition' as const,value:{...f.graph.input.goal,revision:2,description:'Own old proposal'}};
  const resolved={entityType:'core_goal_definition' as const,value:{...acceptedGoal.value,revision:3,description:'Own old proposal'}};
  f.candidate.files=new Map([...f.target.files,...capsule([abandoned],920061),...capsule([resolved],920061,2)]);
  expect(()=>validatePublicationCandidate(f)).not.toThrow();
});
