import { createHash } from 'node:crypto';
import type { Header } from '../../../../domain/workbench/primitives';
import type { PackageManifest, VerifiedMain } from '../contracts';
import type { PreparedProposal } from '../git-port';
import type { PublicationCandidateInput } from '../publication-validation';
import { buildPackageManifest, canonicalBytes, hashBytes } from '../package-manifest';

/** Test provider data only. These helpers build actual capsules, never a success proof. */
export function syntheticPublishedTree(entries: Array<{entityType:string;value:Header}>, baseCommit:string, createdAt:string, curatorPersonId:string):Map<string,Uint8Array> {
  const groups=new Map<string,Map<string,Uint8Array>>();
  for(const {entityType,value} of entries){
    if(!value.publicationAnchorId)throw Error('Synthetic accepted record needs its real package identity');
    const files=groups.get(value.publicationAnchorId)??new Map<string,Uint8Array>();
    files.set(`records/${entityType}/${value.id}/${value.revision}.json`,canonicalBytes(value));groups.set(value.publicationAnchorId,files);
  }
  const result=new Map<string,Uint8Array>();
  for(const [packageId,files] of groups){
    const manifest=buildPackageManifest({package:{schemaVersion:1,packageId,cycleId:packageId,curatorPersonId,revision:1,baseCommit,targetBranch:'main',createdAt},files});
    for(const [name,bytes] of syntheticProposalTree(manifest,files))result.set(name,bytes);
  }
  return result;
}
export function syntheticProposalTree(manifest:PackageManifest,files:ReadonlyMap<string,Uint8Array>):Map<string,Uint8Array>{
  const prefix=`published/workbench/packages/${manifest.packageRevision.packageId}/${manifest.packageRevision.revision}/`;
  const tree=new Map<string,Uint8Array>([...files].map(([name,bytes])=>[prefix+name,new Uint8Array(bytes)] as const));tree.set(prefix+'manifest.json',canonicalBytes(manifest));return tree;
}
export function syntheticCandidateInput(prepared:PreparedProposal,target:VerifiedMain,files:ReadonlyMap<string,Uint8Array>):PublicationCandidateInput {
  const snapshot=new Map([...files].map(([name,bytes])=>[name,new Uint8Array(bytes)]));
  // In-memory test providers have no Git object store; derive a deterministic
  // synthetic tree OID from all bytes. Native provider tests use actual Git OIDs.
  const candidateTreeOid=createHash('sha1').update(canonicalBytes([...snapshot].map(([name,bytes])=>[name,hashBytes(bytes)]).sort(([a],[b])=>a<b?-1:a>b?1:0))).digest('hex');
  return {target:{...target,files:new Map([...target.files].map(([name,bytes])=>[name,new Uint8Array(bytes)]))},candidate:{repositoryId:target.repositoryId,sourceOid:prepared.commit,targetOid:target.commit,candidateTreeOid,files:snapshot}};
}
