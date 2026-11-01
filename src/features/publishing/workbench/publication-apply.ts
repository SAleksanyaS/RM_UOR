import type { Evidence, WorkbenchEntity } from '../../../domain/workbench/entities';
import type { Clock, EntityRef, VersionRef } from '../../../domain/workbench/primitives';
import type { PublicationAnchor } from '../../../domain/workbench/publication';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { isPublicationAnchorAttachment } from '../../../server/storage/workbench-repository';
import { isOwnCoreVersion } from '../../../server/storage/workbench-ownership';
import type { CommandContext } from '../../../server/workbench/command-registry';
import { commitCommandEffect, createCommandStore } from '../../../server/workbench/command-store';
import type { Problem } from '../../../server/workbench/protocol';
import { canUseCapability } from '../../identity/workbench-access-policy';
import type { BitbucketPort, MergeEvidence, ProposalLink } from './bitbucket-port';
import type { PublicationGitPort } from './git-port';
import type { PublicationClassification } from './package-preview';
import { gitOidSchema, mergeEvidenceSchema, proposalLinkSchema, type PackageArtifactStore, type VerifiedMain } from './contracts';
import { canonicalBytes, hashBytes, integrity } from './package-manifest';
import { fail, problem, readMainProjection, versionKey } from './package-projection';
import { verifyPublicationAnchor } from './publication-anchor';
import { readPublicationCapsules, validatePublicationGraph } from './publication-validation';

export type PublicationApplyResult = { appliedCommit: string; appliedAt: string | null; stateRevision: string; anchors: PublicationAnchor[]; warnings: Problem[] };
export type PublicationApplyDependencies = { repository: WorkbenchRepository; git: PublicationGitPort; artifacts: PackageArtifactStore; clock: Clock; bitbucket: BitbucketPort | null; publication?: PublicationClassification; recheck?: () => Promise<void>; knownProposal?: (packageId: string) => ProposalLink | null; evidence?: { stagePublished(context:CommandContext,evidence:Evidence,bytes:Uint8Array):Promise<{commit():void}> } };
type Applied = { repositoryId: string; commit: string; appliedAt: string | null };
type Item = { type: string; value: WorkbenchEntity };
const refOf = (item: Item): VersionRef => ({ entityType: item.type, id: item.value.id, revision: item.value.revision });
const equal = (left: unknown, right: unknown) => hashBytes(canonicalBytes(left)) === hashBytes(canonicalBytes(right));
const copyMain = (main: VerifiedMain): VerifiedMain => ({ ...main, files: new Map([...main.files].map(([name, bytes]) => [name, new Uint8Array(bytes)])) });
const mainSignature = (main: VerifiedMain) => hashBytes(canonicalBytes({ repositoryId: main.repositoryId, commit: main.commit, files: [...main.files].map(([name, bytes]) => ({ name, hash: hashBytes(bytes) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }));
function appliedStore(repository: WorkbenchRepository) {
  const sql = repository.sqlForModule('publishing', { trackStateRevision: false });
  sql.execMigration('v1-applied-publication', 'CREATE TABLE wb_publishing_applied(singleton INTEGER PRIMARY KEY CHECK(singleton=1),repository_id TEXT NOT NULL,commit_oid TEXT NOT NULL)');
  // Existing pointers have no observed local apply time. Preserve that absence.
  sql.execMigration('v2-applied-publication-time', 'ALTER TABLE wb_publishing_applied ADD COLUMN applied_at TEXT');
  return {
    read: (): Applied | null => { const row = sql.get<{ repository_id: string; commit_oid: string; applied_at: string | null }>('SELECT repository_id,commit_oid,applied_at FROM wb_publishing_applied WHERE singleton=1'); return row ? { repositoryId: row.repository_id, commit: row.commit_oid, appliedAt: row.applied_at } : null; },
    write: (value: Applied) => sql.run('INSERT OR REPLACE INTO wb_publishing_applied(singleton,repository_id,commit_oid,applied_at) VALUES(1,?,?,?)', [value.repositoryId, value.commit, value.appliedAt]),
  };
}
export function readAppliedPublication(repository: WorkbenchRepository): Applied | null { return appliedStore(repository).read(); }


export async function applyVerifiedPublication(context: CommandContext, input: { mainCommit: string }, deps: PublicationApplyDependencies): Promise<PublicationApplyResult> {
  gitOidSchema.parse(input.mainCommit);
  const identity = { installationId: context.installationId, personId: context.ownAccess.personId };
  const assertContext = () => { if (context.repository !== deps.repository || context.actor.installationId !== identity.installationId || context.installationId !== identity.installationId || context.ownAccess.personId !== identity.personId || context.actor.profilePersonId !== identity.personId) return fail('COMMAND_CONTEXT_MISMATCH', 409); if (!canUseCapability(context.ownAccess, 'publication.apply')) return fail('COMMAND_FORBIDDEN', 403); };
  assertContext();
  const commands = createCommandStore(deps.repository), intent = commands.assertAccess(context.installationId, context.commandId, identity.personId);
  if (!intent) return fail('COMMAND_INTENT_MISSING', 409);
  const request = JSON.parse(intent.request_json);
  if (request.name !== 'publication.apply' || request.payload.mainCommit !== input.mainCommit) return fail('IDEMPOTENCY_CONFLICT', 409);
  if (intent.receipt_json) return JSON.parse(intent.receipt_json).result;
  const store = appliedStore(deps.repository), priorApplied = store.read();
  const recheck = async () => { await deps.recheck?.(); assertContext(); };
  const main = copyMain(await deps.git.readMain()); await recheck();
  if (main.commit !== input.mainCommit) return fail('PREVIEW_STALE', 409);
  if (priorApplied && priorApplied.repositoryId !== main.repositoryId) return fail('REPOSITORY_MISMATCH', 409);
  const { selected, all } = readPublicationCapsules(main, deps.clock.now()), warnings: Problem[] = [];
  const anchors: PublicationAnchor[] = [];
  for (const capsule of selected) {
    const old = deps.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: capsule.anchor.id });
    if (old?.publicationState === 'confirmed' && (old.packageId !== capsule.anchor.packageId || old.revision !== capsule.anchor.revision || old.contentHash !== capsule.anchor.contentHash || old.repositoryId !== main.repositoryId || old.targetBranch !== 'main' || !old.mainCommit)) return fail('PUBLICATION_CONTENT_IMMUTABLE', 409);
    let anchor = old?.publicationState === 'confirmed' ? old : capsule.anchor;
    const link = deps.bitbucket && deps.knownProposal?.(anchor.packageId);
    if (link && anchor.timeVerification === 'unknown') {
      const proposal = proposalLinkSchema.safeParse(link);
      if (!proposal.success || proposal.data.repositoryId !== main.repositoryId) {
        warnings.push(problem('MERGE_TIME_UNVERIFIED')); anchors.push(anchor); continue;
      }
      let evidence: MergeEvidence | null = null;
      try { evidence = await deps.bitbucket!.readMergeEvidence(proposal.data); } catch { warnings.push(problem('MERGE_TIME_UNAVAILABLE')); }
      await recheck();
      if (evidence) {
        let parsed:MergeEvidence|null=null,evidenceMain:VerifiedMain|undefined,unverifiable=false;
        try {parsed=mergeEvidenceSchema.parse(evidence);} catch {unverifiable=true;}
        if(parsed && parsed.mainCommit!==anchor.mainCommit) {
          try {
            if(parsed.mainCommit===main.commit) evidenceMain=main;
            else if(deps.git.readAcceptedMainAt) evidenceMain=copyMain(await deps.git.readAcceptedMainAt(parsed.mainCommit));
            else unverifiable=true;
          } catch {unverifiable=true;}
          // Access cancellation/revocation must never be hidden by the optional
          // merge-metadata fallback.
          await recheck();
        }
        if(!unverifiable) {
          try {
            const verified = verifyPublicationAnchor({ main: { ...main, commit: anchor.mainCommit! }, manifest: capsule.manifest, evidence:parsed, evidenceMain, verifiedAt: deps.clock.now() });
            if (verified.timeVerification === 'verified') anchor = { ...verified, pullRequestId: verified.pullRequestId ?? anchor.pullRequestId, proposalCommit: verified.proposalCommit ?? anchor.proposalCommit };
            else unverifiable=true;
          } catch {unverifiable=true;}
        }
        if(unverifiable) warnings.push(problem('MERGE_TIME_UNVERIFIED'));
      }
    }
    anchors.push(anchor);
  }
  let incoming = validatePublicationGraph({ ...deps.repository, canAttachLocalVersion: (type, value, owner) => isOwnCoreVersion(deps.repository, type, value, owner) }, selected, anchors, all, identity);
  if (main.files.size && !deps.publication) return fail('CLASSIFICATION_REQUIRED');
  for (const owner of all) for (const item of readMainProjection(owner.main).versions.values()) {
    if (!deps.publication!.classifyRecord(item.type, structuredClone(item.value))) return fail('CLASSIFICATION_REQUIRED');
    if (item.type === 'evidence' && (item.value as Evidence).kind === 'file') {
      const evidence = item.value as Extract<Evidence, { kind: 'file' }>;
      const bytes = owner.files.get('artifacts/' + evidence.file.hash.slice(7));
      if (!bytes || deps.publication!.mode !== 'internal' || !deps.publication!.classifyEvidence || !await deps.publication!.classifyEvidence(structuredClone(evidence), new Uint8Array(bytes))) return fail('EVIDENCE_CLASSIFICATION_REQUIRED');
      await recheck();
    }
  }
  const evidenceCommits:Array<()=>void>=[];
  for(const item of incoming.versions.values()) if(item.type==='evidence' && (item.value as Evidence).kind==='file') {
    if(!deps.evidence) return fail('EVIDENCE_STORE_UNAVAILABLE',503);
    const evidence=item.value as Extract<Evidence,{kind:'file'}>;
    const owner=selected.find(capsule=>capsule.anchor.id===evidence.publicationAnchorId)!;
    const bytes=owner.files.get('artifacts/'+evidence.file.hash.slice(7));if(!bytes) return integrity();
    const staged=await deps.evidence.stagePublished(context,structuredClone(evidence),new Uint8Array(bytes));await recheck();
    evidenceCommits.push(()=>staged.commit());
  }
  for (const capsule of selected) {
    await deps.artifacts.writeRevision(capsule.manifest.packageRevision, capsule.files); await recheck();
    const saved = await deps.artifacts.readRevision(capsule.manifest.packageRevision); await recheck();
    if (!equal([...saved].map(([name, bytes]) => ({ name, hash: hashBytes(bytes) })).sort((a, b) => a.name < b.name ? -1 : 1), [...capsule.files].map(([name, bytes]) => ({ name, hash: hashBytes(bytes) })).sort((a, b) => a.name < b.name ? -1 : 1))) return integrity();
  }
  if (mainSignature(copyMain(await deps.git.readMain())) !== mainSignature(main)) return fail('PREVIEW_STALE', 409);
  await recheck();
  return commitCommandEffect(context, () => {
    assertContext();
    if (!equal(store.read(), priorApplied)) return fail('PREVIEW_STALE', 409);
    incoming = validatePublicationGraph({ ...deps.repository, canAttachLocalVersion: (type, value, owner) => isOwnCoreVersion(deps.repository, type, value, owner) }, selected, anchors, all, identity);
    for (const anchor of anchors) {
      const ref = { entityType: 'publication_anchor', id: anchor.id }, existing = deps.repository.readPublicationAnchor(ref);
      if (!existing || !equal(existing, anchor)) deps.repository.appendPublicationAnchor(anchor, deps.repository.publicationAnchorMetadataRevision(ref));
    }
    const changedRefs: EntityRef[] = anchors.map(anchor => ({ entityType: 'publication_anchor', id: anchor.id }));
    for (const item of [...incoming.versions.values()].sort((a, b) => versionKey(refOf(a)) < versionKey(refOf(b)) ? -1 : 1)) {
      const prior=deps.repository.readVersion(refOf(item));
      if(prior && isPublicationAnchorAttachment(prior,item.value))deps.repository.attachVerifiedPublicationAnchor(item.type,item.value,identity);
      else deps.repository.importPublishedVersion(item.type, item.value);
      changedRefs.push({ entityType: item.type, id: item.value.id });
    }
    for(const commitEvidence of evidenceCommits) commitEvidence();
    const appliedAt = priorApplied?.commit === main.commit ? priorApplied.appliedAt : deps.clock.now();
    store.write({ repositoryId: main.repositoryId, commit: main.commit, appliedAt });
    return { result: { appliedCommit: main.commit, appliedAt, stateRevision: (BigInt(deps.repository.getStateRevision()) + 1n).toString(), anchors, warnings }, changedRefs, editToken: null };
  }).result;
}
