import type { GitOid } from '../../../domain/workbench/publication';
import type { PackageManifest, PackageMainReader, PackageRevision } from './contracts';

/** Internal server-only descriptor. Never expose checkout paths through HTTP. */
export type PreparedProposal={packageRevision:PackageRevision;checkout:string;branch:string;commit:GitOid;expectedRemoteHead:GitOid|null};
export interface PublicationGitPort extends PackageMainReader {
  prepare(input:{manifest:PackageManifest;files:ReadonlyMap<string,Uint8Array>;expectedRemoteHead:GitOid|null}):Promise<PreparedProposal>;
  inspectRemote(branch:string):Promise<GitOid|null>;
  verifyPrepared(prepared:PreparedProposal):Promise<void>;
}
