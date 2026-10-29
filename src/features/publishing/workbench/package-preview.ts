import type { Evidence, WorkbenchEntity } from '../../../domain/workbench/entities';
import type { Clock } from '../../../domain/workbench/primitives';
import { newUuid } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { CommandContext } from '../../../server/workbench/command-registry';
import { commitCommandEffect, createCommandStore } from '../../../server/workbench/command-store';
import type { DraftService } from '../../catalog/workbench-drafts';
import { canUseCapability } from '../../identity/workbench-access-policy';
import { createPackageStore, type PreviewBinding } from './package-store';
import { buildPackageProjection, fail, problem } from './package-projection';
import { buildPackageManifest, canonicalBytes, hashBytes } from './package-manifest';
import { packagePreviewInputSchema, type PackageArtifactStore, type PackageMainReader, type PackagePreviewInput, type PackagePreviewResult, type VerifiedMain } from './contracts';

export type PublicationClassification = {
  mode:'demo-only'|'internal';
  classifyRecord:(entityType:string,value:WorkbenchEntity)=>boolean;
  classifyEvidence?:(evidence:Extract<Evidence,{kind:'file'}>,bytes:Uint8Array)=>Promise<boolean>;
};
export type PackagePreviewDependencies={repository:WorkbenchRepository;clock:Clock;artifacts:PackageArtifactStore;git:PackageMainReader;drafts:DraftService;publication?:PublicationClassification;recheck?:()=>Promise<void>;wait?:<T>(promise:Promise<T>)=>Promise<T>;store?:ReturnType<typeof createPackageStore>};
const signature=(main:VerifiedMain)=>hashBytes(canonicalBytes({repositoryId:main.repositoryId,commit:main.commit,files:[...main.files].map(([name,bytes])=>({name,hash:hashBytes(bytes)})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)}));
const snapshot=(main:VerifiedMain):VerifiedMain=>({...main,files:new Map([...main.files].map(([name,bytes])=>[name,new Uint8Array(bytes)]))});
function assertContext(context:CommandContext,deps:PackagePreviewDependencies,packageId:string,ownerPersonId:string) {
  if(context.repository!==deps.repository || context.actor.installationId!==context.installationId || context.actor.profilePersonId!==ownerPersonId || context.ownAccess.personId!==ownerPersonId) fail('COMMAND_CONTEXT_MISMATCH',409);
  if(!canUseCapability(context.ownAccess,'uor.prepare')) fail('COMMAND_FORBIDDEN',403);
  return deps.drafts.readOwnPackage(context,packageId);
}
export async function preparePackagePreview(context:CommandContext,packageId:string,main:VerifiedMain,deps:PackagePreviewDependencies) {
  const projection=buildPackageProjection(context,packageId,deps.drafts,main);
  const errors=[...projection.errors]; const files=new Map<string,Uint8Array>();
  const sorted=[...projection.exported.values()].sort((a,b)=>`${a.type}/${a.value.id}/${a.value.revision}`.localeCompare(`${b.type}/${b.value.id}/${b.value.revision}`,'en'));
  for(const {type,value} of sorted) {
    if(!deps.publication?.classifyRecord(type,value)) {errors.push(problem('CLASSIFICATION_REQUIRED'));continue;}
    const serialized={...value,publicationAnchorId:packageId};
    files.set(`records/${type}/${value.id}/${value.revision}.json`,canonicalBytes(serialized));
    if(type==='evidence' && (value as Evidence).kind==='file') {
      const evidence=value as Extract<Evidence,{kind:'file'}>;
      if(deps.publication.mode!=='internal' || !deps.publication.classifyEvidence) {errors.push(problem('EVIDENCE_CLASSIFICATION_REQUIRED'));continue;}
      const artifact=await deps.drafts.readOwnEvidenceArtifact(context,packageId,evidence.file.artifactId);
      const chunks:Buffer[]=[]; let length=0;
      for await(const chunk of artifact.stream) {const bytes=Buffer.from(chunk); length+=bytes.length; if(length>32*1024*1024) fail('INTEGRITY_MISMATCH'); chunks.push(bytes);}
      const bytes=Buffer.concat(chunks); const hash=hashBytes(bytes);
      if(bytes.length!==evidence.file.bytes || bytes.length!==artifact.bytes || `sha256:${hash}`!==evidence.file.hash || hash!==artifact.sha256 || artifact.mimeType!==evidence.file.mimeType) fail('INTEGRITY_MISMATCH');
      if(!['text/plain','application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(artifact.mimeType) || !await deps.publication.classifyEvidence(evidence,bytes)) {errors.push(problem('EVIDENCE_CLASSIFICATION_REQUIRED'));continue;}
      files.set(`artifacts/${hash}`,bytes);
    }
  }
  const fingerprint=hashBytes(canonicalBytes({repositoryId:main.repositoryId,mainCommit:main.commit,draftRevision:projection.draftRevision,basisDigests:projection.basisDigests,changes:projection.changes,errors,files:[...files].map(([name,bytes])=>({name,hash:hashBytes(bytes)}))}));
  return {projection,files,errors,fingerprint};
}
export async function createPackagePreview(context:CommandContext,input:PackagePreviewInput,deps:PackagePreviewDependencies):Promise<PackagePreviewResult> {
  const wait=deps.wait??(<T>(promise:Promise<T>)=>promise);
  packagePreviewInputSchema.parse(input);
  const personId=context.actor.profilePersonId; if(!personId) return fail('COMMAND_FORBIDDEN',403);
  const initial=assertContext(context,deps,input.packageId,personId); const revision=initial.revision;
  const intent=createCommandStore(deps.repository).get(context.installationId,context.commandId);
  if(!intent) return fail('COMMAND_INTENT_MISSING',409);
  if(JSON.parse(intent.request_json).baseRevision!==`draft:${initial.packageId}:${revision}`) return fail('REVISION_CONFLICT',409);
  const main=snapshot(await wait(deps.git.readMain()));
  await deps.recheck?.();
  if(assertContext(context,deps,input.packageId,personId).revision!==revision) return fail('PREVIEW_STALE',409);
  const prepared=await wait(preparePackagePreview(context,input.packageId,main,deps));
  await deps.recheck?.();
  if(assertContext(context,deps,input.packageId,personId).revision!==revision) return fail('PREVIEW_STALE',409);
  if(signature(snapshot(await wait(deps.git.readMain())))!==signature(main)) return fail('PREVIEW_STALE',409);
  await deps.recheck?.();
  if(assertContext(context,deps,input.packageId,personId).revision!==revision) return fail('PREVIEW_STALE',409);
  const store=deps.store??createPackageStore(deps.repository,deps.drafts);
  const reservation=store.reserve(context,input.packageId,prepared.fingerprint);
  const manifest=buildPackageManifest({package:{schemaVersion:1,packageId:input.packageId,curatorPersonId:personId,cycleId:reservation.cycleId,revision:reservation.revision,baseCommit:main.commit,targetBranch:'main',createdAt:reservation.createdAt},files:prepared.files});
  await wait(deps.artifacts.writeRevision(manifest.packageRevision,prepared.files));
  await deps.recheck?.();
  if(assertContext(context,deps,input.packageId,personId).revision!==revision) return fail('PREVIEW_STALE',409);
  if(signature(snapshot(await wait(deps.git.readMain())))!==signature(main)) return fail('PREVIEW_STALE',409);
  await deps.recheck?.();
  if(assertContext(context,deps,input.packageId,personId).revision!==revision) return fail('PREVIEW_STALE',409);
  // All async preparation is finished. Recheck semantic refs synchronously before
  // committing the own package record, issued token and command receipt together.
  const fresh=buildPackageProjection(context,input.packageId,deps.drafts,main);
  if(hashBytes(canonicalBytes({basisDigests:fresh.basisDigests,errors:fresh.errors}))!==hashBytes(canonicalBytes({basisDigests:prepared.projection.basisDigests,errors:prepared.projection.errors}))) return fail('PREVIEW_STALE',409);
  const prior=store.prior(context,input.packageId,prepared.fingerprint);
  const now=Date.parse(deps.clock.now());
  const result:PackagePreviewResult=prior && Date.parse(prior.result.expiresAt)>now?prior.result:{
    packageRevision:manifest.packageRevision,previewToken:newUuid(),expiresAt:new Date(now+30*60*1000).toISOString(),changes:prepared.projection.changes,
    warnings:prepared.projection.basisDigests.length?[]:[problem('NEEDS_CALCULATION')],errors:prepared.errors,
  };
  const binding:PreviewBinding={repositoryId:main.repositoryId,mainCommit:main.commit,draftRevision:revision,fingerprint:prepared.fingerprint};
  return commitCommandEffect(context,()=>({result,changedRefs:[store.commit(context,input.packageId,binding,result,[...prepared.projection.roots.values()].map(v=>({entityType:v.type,id:v.value.id,revision:v.value.revision})))],editToken:`draft:${initial.packageId}:${revision}`})).result;
}
export async function assertPackagePreview(context:CommandContext,input:{packageId:string;previewToken:string},deps:PackagePreviewDependencies):Promise<PackagePreviewResult> {
  const pkg=deps.drafts.readOwnPackage(context,input.packageId);
  const personId=context.actor.profilePersonId; if(!personId) return fail('COMMAND_FORBIDDEN',403);
  await deps.recheck?.(); assertContext(context,deps,input.packageId,personId);
  const store=deps.store??createPackageStore(deps.repository,deps.drafts);
  const token=store.token(context,input.packageId,input.previewToken);
  if(!token || Date.parse(token.result.expiresAt)<=Date.parse(deps.clock.now()) || token.binding.draftRevision!==pkg.revision) return fail('PREVIEW_STALE',409);
  if(token.result.errors.length) return fail('PREVIEW_NOT_READY',409);
  const main=snapshot(await deps.git.readMain());
  if(main.repositoryId!==token.binding.repositoryId || main.commit!==token.binding.mainCommit) return fail('PREVIEW_STALE',409);
  const prepared=await preparePackagePreview(context,input.packageId,main,deps);
  if(prepared.fingerprint!==token.binding.fingerprint || deps.drafts.readOwnPackage(context,input.packageId).revision!==pkg.revision) return fail('PREVIEW_STALE',409);
  const current=store.readPort.readOwnPackage(context,input.packageId);
  if(!current?.current || current.current.revision!==token.result.packageRevision.revision || current.current.contentHash!==token.result.packageRevision.contentHash) return fail('PREVIEW_STALE',409);
  await deps.artifacts.readRevision(token.result.packageRevision);
  if(signature(snapshot(await deps.git.readMain()))!==signature(main)) return fail('PREVIEW_STALE',409);
  await deps.recheck?.();
  if(assertContext(context,deps,input.packageId,personId).revision!==pkg.revision || Date.parse(token.result.expiresAt)<=Date.parse(deps.clock.now())) return fail('PREVIEW_STALE',409);
  const fresh=buildPackageProjection(context,input.packageId,deps.drafts,main);
  if(hashBytes(canonicalBytes({basisDigests:fresh.basisDigests,errors:fresh.errors}))!==hashBytes(canonicalBytes({basisDigests:prepared.projection.basisDigests,errors:prepared.projection.errors}))) return fail('PREVIEW_STALE',409);
  return token.result;
}
