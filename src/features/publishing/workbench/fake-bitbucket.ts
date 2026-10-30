import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { proposalWriteSchema,proposalCommentSchema } from './contracts';
import type { BitbucketPort,BitbucketCapabilities,ProposalLink,ProposalSnapshot,ProposalComment } from './bitbucket-port';

/** Explicit test-only adapter. Never install this as a production default. */
export function createFakeBitbucket(options:{capabilities:BitbucketCapabilities}):BitbucketPort & {testing:{capabilities:BitbucketCapabilities;creates:number;updates:number;beforeWrite:(()=>void)|null;loseNextCreateResponse:boolean;loseNextUpdateResponse:boolean;setState:(link:ProposalLink,state:ProposalSnapshot['state'])=>void;addComment:(link:ProposalLink,comment:ProposalComment)=>void}} {
  const proposals=new Map<string,ProposalSnapshot>(),comments=new Map<string,ProposalComment[]>();let serial=0;
  const unknown=():never=>{throw new WorkbenchHttpError(409,'REMOTE_STATE_UNKNOWN','Native proposal result requires reconciliation');};
  const read=(link:ProposalLink)=>{const value=proposals.get(link.id);if(!value||JSON.stringify(value.link)!==JSON.stringify(link)) return unknown();return structuredClone(value);};
  const testing={capabilities:structuredClone(options.capabilities),creates:0,updates:0,beforeWrite:null as (()=>void)|null,loseNextCreateResponse:false,loseNextUpdateResponse:false,
    setState(link:ProposalLink,state:ProposalSnapshot['state']) {const value=read(link);proposals.set(link.id,{...value,state,externalVersion:String(Number(value.externalVersion)+1)});},
    addComment(link:ProposalLink,comment:ProposalComment) {read(link);comments.set(link.id,[...(comments.get(link.id)??[]),proposalCommentSchema.parse(comment)]);},
  };
  return {testing,async capabilities(){return structuredClone(testing.capabilities);},
    async findProposal(packageId) {const matches=[...proposals.values()].filter(value=>value.packageId===packageId);if(matches.length>1) return unknown();return matches.length?structuredClone(matches[0]):null;},
    async createProposal(unparsed) {const input=proposalWriteSchema.parse(unparsed);testing.beforeWrite?.();testing.creates++;
      const id=String(++serial);const value:ProposalSnapshot={link:{provider:'bitbucket',repositoryId:'synthetic-main',id,url:'https://bitbucket.invalid/proposals/'+id},packageId:input.packageRevision.packageId,sourceCommit:input.proposalCommit,targetCommit:input.packageRevision.baseCommit,state:'open',author:{externalId:'synthetic-native-author',displayName:'Native test author'},externalVersion:'1'};
      proposals.set(id,value);if(testing.loseNextCreateResponse){testing.loseNextCreateResponse=false;return unknown();}return structuredClone(value);
    },
    async updateProposal(link,unparsed) {const input=proposalWriteSchema.parse(unparsed),old=read(link);if(!['open','needs_rework'].includes(old.state)||old.packageId!==input.packageRevision.packageId) return unknown();testing.beforeWrite?.();testing.updates++;
      const value={...old,sourceCommit:input.proposalCommit,targetCommit:input.packageRevision.baseCommit,state:'open' as const,externalVersion:String(Number(old.externalVersion)+1)};proposals.set(link.id,value);
      if(testing.loseNextUpdateResponse){testing.loseNextUpdateResponse=false;return unknown();}return structuredClone(value);
    },
    async readProposal(link){return read(link);},async readComments(link){read(link);return structuredClone(comments.get(link.id)??[]);},
    async readMergeEvidence(link){const value=read(link);return {mainCommit:value.targetCommit,proposalCommit:value.sourceCommit,mergedAt:null,source:'synthetic-only',verified:value.state==='merged'};},
  };
}
