import type { z } from 'zod';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import type { bitbucketCapabilitiesSchema,proposalLinkSchema,proposalSnapshotSchema,proposalCommentSchema,proposalWriteSchema,mergeEvidenceSchema } from './contracts';
export type BitbucketCapabilities=z.infer<typeof bitbucketCapabilitiesSchema>;
export type ProposalLink=z.infer<typeof proposalLinkSchema>;
export type ProposalSnapshot=z.infer<typeof proposalSnapshotSchema>;
export type ProposalComment=z.infer<typeof proposalCommentSchema>;
export type ProposalWrite=z.infer<typeof proposalWriteSchema>;
export type MergeEvidence=z.infer<typeof mergeEvidenceSchema>;
export interface BitbucketPort {
  openAuth?(input:{signal:AbortSignal}):Promise<void>;
  capabilities():Promise<BitbucketCapabilities>;
  findProposal(packageId:string):Promise<ProposalSnapshot|null>;
  createProposal(input:ProposalWrite):Promise<ProposalSnapshot>;
  updateProposal(link:ProposalLink,input:ProposalWrite):Promise<ProposalSnapshot>;
  readProposal(link:ProposalLink):Promise<ProposalSnapshot>;
  readComments(link:ProposalLink):Promise<ProposalComment[]>;
  readMergeEvidence(link:ProposalLink):Promise<MergeEvidence>;
}
/** No production endpoint/auth profile is inferred from a successful synthetic port. */
export function createUnavailableBitbucketPort():BitbucketPort {
  const unavailable=async():Promise<never>=>{throw new WorkbenchHttpError(503,'BITBUCKET_NOT_READY','Native proposal integration has not been verified');};
  return {async capabilities(){return {profileId:'unavailable',edition:'unknown',version:'unknown',nativePullRequests:false,findByPackageMarker:false,updateOpenProposal:false,readComments:false,explicitReworkState:false,mergeEvidence:'unsupported',terminalAuthProfileId:null};},findProposal:unavailable,createProposal:unavailable,updateProposal:unavailable,readProposal:unavailable,readComments:unavailable,readMergeEvidence:unavailable};
}
