import type { CommandContext } from '../../../server/workbench/command-registry';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { uuidSchema } from '../../../domain/workbench/primitives';
import { canUseCapability,type AccessPolicyService } from '../../identity/workbench-access-policy';
import { buildPackageManifest,canonicalBytes,hashBytes } from './package-manifest';
import type { PackageArtifactStore } from './contracts';
import type { PreparedProposal,PublicationGitPort } from './git-port';
import type { PreTransferGate } from './terminal-runner';

type Dependencies={accessPolicy:AccessPolicyService;git:PublicationGitPort;artifacts:PackageArtifactStore;operationId?:string;assertPreview?:()=>Promise<unknown>};
const fail=(code:string,status=409):never=>{throw new WorkbenchHttpError(status,code,code);};
/** Both additional inputs are trusted owner ports, never values supplied by a browser. */
export function createPreTransferGate(context:CommandContext,prepared:PreparedProposal,deps:Dependencies):PreTransferGate {
  const candidate=structuredClone(prepared),person=context.actor.profilePersonId,installation=context.installationId,command=context.commandId;
  const identity=()=>{if(!person||person!==candidate.packageRevision.curatorPersonId||context.installationId!==installation||context.commandId!==command||context.actor.installationId!==installation||context.actor.profilePersonId!==person||context.ownAccess.personId!==person) return fail('COMMAND_CONTEXT_MISMATCH');};
  return async()=>{
    identity();if(!deps.assertPreview) return fail('PREVIEW_RECHECK_REQUIRED');if(!uuidSchema.safeParse(deps.operationId).success) return fail('COMMAND_JOB_MISSING');
    await deps.assertPreview();identity();const files=await deps.artifacts.readRevision(candidate.packageRevision);identity();
    const {contentHash:_hash,...base}=candidate.packageRevision;
    if(hashBytes(canonicalBytes(buildPackageManifest({package:base,files}).packageRevision))!==hashBytes(canonicalBytes(candidate.packageRevision))) return fail('INTEGRITY_MISMATCH',422);
    await deps.git.verifyPrepared(candidate);identity();await deps.assertPreview();identity();
    const fresh=await deps.accessPolicy.assertFreshPublishAllowed(deps.operationId!);identity();
    if(fresh.personId!==person||!canUseCapability(fresh,'package.submit')) return fail('ACCESS_DENIED',403);context.ownAccess=fresh;
  };
}
