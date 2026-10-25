export interface ReleaseField { path:string;label:string;before:unknown;local:unknown;remote:unknown;conflict:boolean }
export interface ReleaseDraft {id:string;kind:string;objectId:string;label:string;path:string;fields:ReleaseField[];conflicts:string[]}
export interface ReleaseItem {id:string;label:string;detail:string;bytes?:number;evidenceIds?:string[]}
export interface ReleasePreview { id:string;expiresAt:string;remoteCommit:string;publishedCommit:string;publicationAllowed:boolean;message:string;
 drafts:ReleaseDraft[];snapshots:ReleaseItem[];attestations:ReleaseItem[];evidence:ReleaseItem[];templates:ReleaseItem[];releaseChanges:ReleaseItem[] }
export interface PublicationSelection { previewId?:string;snapshotIds?:string[];attestationIds?:string[];evidenceIds?:string[];templateIds?:string[] }
export interface ResolveConflictInput {previewId:string;draftId:string;choices:Record<string,'local'|'remote'>}
