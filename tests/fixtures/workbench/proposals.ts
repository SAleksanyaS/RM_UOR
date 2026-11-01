import { draftFixture } from './drafts';
import { fixtureId } from './factories';
import { createFakeBitbucket } from '../../../src/features/publishing/workbench/fake-bitbucket';
import { buildPackageManifest } from '../../../src/features/publishing/workbench/package-manifest';
import type { BitbucketCapabilities, ProposalWrite } from '../../../src/features/publishing/workbench/bitbucket-port';

export const syntheticCapabilities:BitbucketCapabilities={profileId:'synthetic-only',edition:'synthetic',version:'1',nativePullRequests:true,findByPackageMarker:true,updateOpenProposal:true,readComments:true,explicitReworkState:true,mergeEvidence:'verified',terminalAuthProfileId:'synthetic-terminal'};
export function proposalFixture() {
  const f=draftFixture();f.context.ownAccess={...f.context.ownAccess,policyState:'verified'};
  const fake=createFakeBitbucket({capabilities:syntheticCapabilities});let serial=240000;const gates:string[]=[];
  const accessPolicy={...f.policy,async assertFreshPublishAllowed(operationId:string){gates.push(operationId);return f.context.ownAccess;}};
  const input=(revision=1):ProposalWrite=>({packageRevision:buildPackageManifest({package:{schemaVersion:1,packageId:fixtureId(240001),cycleId:fixtureId(240002),curatorPersonId:f.context.ownAccess.personId!,revision,baseCommit:'a'.repeat(40),targetBranch:'main',createdAt:f.clock.now()},files:new Map()}).packageRevision,branch:`uor/${f.context.ownAccess.personId}/${fixtureId(240001)}`,proposalCommit:(revision===1?'b':'c').repeat(40),summary:'Синтетическое предложение',marker:'uor-package:'+fixtureId(240001)});
  const command=()=>{const context={...f.context,commandId:fixtureId(serial++)};const job=f.jobs.create(context.commandId,context.installationId,'package.submit');return {context,job};};
  return {...f,businessInput:f.input,fake,input,gates,command,deps:{repository:f.repository,accessPolicy,jobs:f.jobs,bitbucket:fake}};
}
