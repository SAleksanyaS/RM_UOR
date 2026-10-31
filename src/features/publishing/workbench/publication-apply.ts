import type { AgreedSnapshot, Attestation, CalculationResult, Capture, CoreGoalDefinition, DirectoryEntity, DirectoryLink, EvaluationBasis, EvaluationInput, GoalAssignment, ManualCorrection, ManualStatusEvent, MethodVersion, MetricDefinition, ObservedFact, Template, Work, WorkDependency, Decision, Evidence, WorkbenchEntity, WorkbenchEntityType } from '../../../domain/workbench/entities';
import type { Clock, EntityRef, Header, VersionRef } from '../../../domain/workbench/primitives';
import type { PublicationAnchor } from '../../../domain/workbench/publication';
import { entityReferences, validateReferences } from '../../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { CommandContext } from '../../../server/workbench/command-registry';
import { commitCommandEffect, createCommandStore } from '../../../server/workbench/command-store';
import type { Problem } from '../../../server/workbench/protocol';
import { canUseCapability } from '../../identity/workbench-access-policy';
import { validateDirectoryChanges } from '../../catalog/workbench-directory';
import { businessDefinition } from '../../catalog/workbench-drafts';
import { validateGraph, validateWorkChange } from '../../execution/workbench-execution';
import { canonicalBasis, digestBasis } from '../../evaluation/workbench/basis';
import { evaluateAssignment } from '../../evaluation/workbench/evaluate';
import { validateAgreedSnapshot, validateAttestation, validateCorrection } from '../../evaluation/workbench/state-rules';
import type { BitbucketPort, MergeEvidence, ProposalLink } from './bitbucket-port';
import type { PublicationGitPort } from './git-port';
import type { PublicationClassification } from './package-preview';
import { gitOidSchema, mergeEvidenceSchema, packageManifestSchema, proposalLinkSchema, type PackageArtifactStore, type PackageManifest, type VerifiedMain } from './contracts';
import { canonicalBytes, hashBytes, integrity } from './package-manifest';
import { fail, objectKey, problem, readMainProjection, versionKey } from './package-projection';
import { verifyPublicationAnchor } from './publication-anchor';

export type PublicationApplyResult = { appliedCommit: string; stateRevision: string; anchors: PublicationAnchor[]; warnings: Problem[] };
export type PublicationApplyDependencies = { repository: WorkbenchRepository; git: PublicationGitPort; artifacts: PackageArtifactStore; clock: Clock; bitbucket: BitbucketPort | null; publication?: PublicationClassification; recheck?: () => Promise<void>; knownProposal?: (packageId: string) => ProposalLink | null; evidence?: { stagePublished(context:CommandContext,evidence:Evidence,bytes:Uint8Array):Promise<{commit():void}> } };
type Applied = { repositoryId: string; commit: string };
type Item = { type: string; value: WorkbenchEntity };
type Capsule = { manifest: PackageManifest; files: Map<string, Uint8Array>; main: VerifiedMain; anchor: PublicationAnchor };
const refOf = (item: Item): VersionRef => ({ entityType: item.type, id: item.value.id, revision: item.value.revision });
const equal = (left: unknown, right: unknown) => hashBytes(canonicalBytes(left)) === hashBytes(canonicalBytes(right));
const copyMain = (main: VerifiedMain): VerifiedMain => ({ ...main, files: new Map([...main.files].map(([name, bytes]) => [name, new Uint8Array(bytes)])) });
const mainSignature = (main: VerifiedMain) => hashBytes(canonicalBytes({ repositoryId: main.repositoryId, commit: main.commit, files: [...main.files].map(([name, bytes]) => ({ name, hash: hashBytes(bytes) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }));
function appliedStore(repository: WorkbenchRepository) {
  const sql = repository.sqlForModule('publishing', { trackStateRevision: false });
  sql.execMigration('v1-applied-publication', 'CREATE TABLE wb_publishing_applied(singleton INTEGER PRIMARY KEY CHECK(singleton=1),repository_id TEXT NOT NULL,commit_oid TEXT NOT NULL)');
  return {
    read: (): Applied | null => { const row = sql.get<{ repository_id: string; commit_oid: string }>('SELECT repository_id,commit_oid FROM wb_publishing_applied WHERE singleton=1'); return row ? { repositoryId: row.repository_id, commit: row.commit_oid } : null; },
    write: (value: Applied) => sql.run('INSERT OR REPLACE INTO wb_publishing_applied(singleton,repository_id,commit_oid) VALUES(1,?,?)', [value.repositoryId, value.commit]),
  };
}
export function readAppliedPublication(repository: WorkbenchRepository): Applied | null { return appliedStore(repository).read(); }

function capsules(main: VerifiedMain, verifiedAt: string): { all: Capsule[]; selected: Capsule[] } {
  gitOidSchema.parse(main.commit);
  if (!main.repositoryId.trim()) return integrity();
  const prefixes = new Set<string>();
  for (const name of main.files.keys()) {
    const match = /^(published\/workbench\/packages\/([a-f0-9-]{36})\/([1-9][0-9]*)\/)(.+)$/.exec(name);
    if (!match) return integrity();
    prefixes.add(match[1]);
  }
  const selected = new Map<string, Capsule>();
  const all: Capsule[] = [];
  for (const prefix of [...prefixes].sort()) {
    let manifest: PackageManifest;
    try { manifest = packageManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(main.files.get(prefix + 'manifest.json')))); }
    catch { return integrity(); }
    if (prefix !== `published/workbench/packages/${manifest.packageRevision.packageId}/${manifest.packageRevision.revision}/`) return integrity();
    const isolated = { ...main, files: new Map([...main.files].filter(([name]) => name.startsWith(prefix))) };
    const anchor = verifyPublicationAnchor({ main: isolated, manifest, evidence: null, verifiedAt });
    const projection = readMainProjection(isolated);
    for (const item of projection.versions.values()) if (item.value.publicationAnchorId !== anchor.id) return fail('PUBLICATION_ANCHOR_MISMATCH');
    const files = new Map([...isolated.files].filter(([name]) => name !== prefix + 'manifest.json').map(([name, bytes]) => [name.slice(prefix.length), bytes]));
    const capsule = { manifest, files, main: isolated, anchor };
    all.push(capsule);
    if ((selected.get(anchor.id)?.anchor.revision ?? 0) < anchor.revision) selected.set(anchor.id, capsule);
  }
  return { all, selected: [...selected.values()].sort((a, b) => a.anchor.id < b.anchor.id ? -1 : a.anchor.id > b.anchor.id ? 1 : 0) };
}

function validateIncoming(repository: WorkbenchRepository, selected: Capsule[], anchors: PublicationAnchor[], allCapsules: Capsule[]) {
  const incoming = readMainProjection({ repositoryId: 'verified-projection', commit: '0'.repeat(40), files: new Map(selected.flatMap(capsule => [...capsule.main.files])) });
  const byAnchor = new Map(anchors.map(anchor => [anchor.id, anchor]));
  for (const item of incoming.versions.values()) {
    const prior = repository.readVersion<WorkbenchEntity>(refOf(item));
    if (prior && !equal(prior, item.value)) return fail('REFERENCE_VERSION_COLLISION');
  }
  for (const anchor of anchors) if (repository.readPublicationAnchor({ entityType: 'publication_anchor', id: anchor.id })?.publicationState !== 'confirmed') {
    for (const item of repository.readVersionsForPublicationAnchor(anchor.id)) {
      const verified = incoming.versions.get(versionKey({ entityType: item.entityType, id: item.value.id, revision: item.value.revision }));
      if (!verified || !equal(verified.value, item.value)) return fail('UNVERIFIED_ANCHOR_ACTIVATION');
    }
  }
  const published = repository.readPublishedCatalog();
  const combined = new Map<string, Item>(published.map(item => [objectKey({ entityType: item.entityType, id: item.value.id }), { type: item.entityType, value: item.value as WorkbenchEntity }]));
  for (const [key, item] of incoming.heads) if ((combined.get(key)?.value.revision ?? 0) < item.value.revision) combined.set(key, item);
  const read = (ref: EntityRef | VersionRef): WorkbenchEntity | PublicationAnchor | null => {
    if (ref.entityType === 'publication_anchor') return byAnchor.get(ref.id) ?? repository.readPublicationAnchor(ref);
    if (!('revision' in ref)) return combined.get(objectKey(ref))?.value ?? null;
    const selected = incoming.versions.get(versionKey(ref)); if (selected) return selected.value;
    const value = repository.readVersion<WorkbenchEntity>(ref);
    return value?.publicationAnchorId && repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId })?.publicationState === 'confirmed' ? value : null;
  };
  const exact = <T extends Header>(ref: EntityRef | VersionRef): T => { const value = read(ref); if (!value) return fail('REFERENCE_NOT_FOUND'); return value as unknown as T; };
  const requirements = (item: Item, current: boolean) => entityReferences(item.type as WorkbenchEntityType, item.value).map(requirement => current || 'revision' in requirement.ref ? requirement : { ...requirement, validateTarget: undefined });
  for (const capsule of allCapsules) {
    const historical = readMainProjection(capsule.main);
    const historicalRead = (ref: EntityRef | VersionRef) => (ref.entityType === 'publication_anchor' ? read(ref) : 'revision' in ref ? historical.versions.get(versionKey(ref))?.value ?? read(ref) : read(ref) ?? historical.heads.get(objectKey(ref))?.value ?? null);
    for (const item of historical.versions.values()) validateReferences(requirements(item, false), historicalRead);
  }
  for (const item of incoming.versions.values()) validateReferences(requirements(item, combined.get(objectKey(refOf(item)))?.value.revision === item.value.revision), read);
  for (const item of combined.values()) validateReferences(requirements(item, true), read);
  const values = <T>(type: string): T[] => [...combined.values()].filter(item => item.type === type).map(item => item.value as T);
  for (const assignment of values<GoalAssignment>('goal_assignment')) {
    const goal = exact<CoreGoalDefinition>({ entityType: 'core_goal_definition', id: assignment.goalId });
    const methodRef = assignment.methodBinding.kind === 'standalone' ? assignment.methodBinding.methodRef : exact<Template>({ entityType: 'template', id: assignment.methodBinding.templateId }).methodRef;
    if (exact<MethodVersion>(methodRef).mode !== goal.mode) return fail('METHOD_MODE_MISMATCH');
  }
  const directoryProblems = validateDirectoryChanges({ entities: values<DirectoryEntity>('directory_entity'), links: values<DirectoryLink>('directory_link'), previousLinks: published.filter(item => item.entityType === 'directory_link').map(item => item.value as DirectoryLink) });
  if (directoryProblems.length) return fail(directoryProblems[0].code);
  validateGraph({ works: values<Work>('work'), dependencies: values<WorkDependency>('work_dependency'), decisions: values<Decision>('decision') });
  for (const item of incoming.heads.values()) if (item.type === 'work') validateWorkChange(repository.readPublishedHead<Work>(refOf(item)), item.value as Work);
  for (const item of incoming.versions.values()) if (item.type === 'manual_correction') { const correction = item.value as ManualCorrection; validateCorrection(correction, correction.originalFactRefs.map(ref => exact<ObservedFact>(ref))); }

  const all = new Map([...combined.values(), ...incoming.versions.values()].map(item => [versionKey(refOf(item)), item]));
  const basisDefinitions = (basis: EvaluationBasis) => {
    const assignment = exact<GoalAssignment>(basis.assignmentRef), goal = exact<CoreGoalDefinition>(basis.goalRef), method = exact<MethodVersion>(basis.methodRef);
    if (assignment.goalId !== goal.id || goal.mode !== method.mode || goal.measurementMode !== basis.businessTime.kind || (goal.mode === 'numeric') !== (assignment.expectedPopulation !== null)) return fail('BASIS_MISMATCH');
    if (assignment.methodBinding.kind === 'standalone') {
      if (basis.templateRef !== null || !equal(assignment.methodBinding.methodRef, basis.methodRef)) return fail('BASIS_MISMATCH');
    } else {
      if (!basis.templateRef || basis.templateRef.id !== assignment.methodBinding.templateId || !equal(exact<Template>(basis.templateRef).methodRef, basis.methodRef)) return fail('BASIS_MISMATCH');
    }
    return { assignment, goal, method };
  };
  const basisInput = (basis: EvaluationBasis): EvaluationInput => {
    if (!basis.evaluatedAt) return fail('BASIS_EVALUATION_TIME_UNKNOWN');
    const { assignment, goal, method } = basisDefinitions(basis);
    const facts = basis.factRefs.map(ref => exact<ObservedFact>(ref));
    const captures = [...new Map(facts.map(fact => [fact.captureId, exact<Capture>({ entityType: 'capture', id: fact.captureId })])).values()];
    return { assignment, goal, method, metrics: method.mode === 'numeric' ? method.rules.map(rule => exact<MetricDefinition>(rule.metricRef)) : [], facts, captures, corrections: basis.correctionRefs.map(ref => exact(ref)), applicability: basis.applicabilityRefs.map(ref => exact(ref)), context: { evaluatedAt: basis.evaluatedAt, businessTime: basis.businessTime }, resolution: { basisRef: { entityType: 'evaluation_basis', id: basis.id, revision: basis.revision }, templateRef: basis.templateRef, directoryLinkRefs: basis.directoryLinkRefs, publicationAnchors: anchors, actor: basis.actor } };
  };
  const resultFor = (basis: EvaluationBasis): CalculationResult | null => {
    const result = [...all.values()].find(item => item.type === 'calculation_result' && equal((item.value as CalculationResult).basisRef, { entityType: 'evaluation_basis', id: basis.id, revision: basis.revision }));
    if (result) return result.value as CalculationResult;
    const stored = repository.findEvaluationByDigest(basis.digest)?.resultRef;
    return stored ? exact<CalculationResult>(stored) : null;
  };
  for (const item of incoming.versions.values()) {
    if (item.type === 'evaluation_basis') {
      const basis = item.value as EvaluationBasis;
      basisDefinitions(basis);
      const { schemaVersion: _schema, id: _id, revision: _revision, recordedAt: _recorded, actor: _actor, publicationAnchorId: _anchor, evaluatedAt: _at, digest: _digest, ...content } = basis;
      if (digestBasis(content) !== basis.digest || basis.evaluatedAt && digestBasis(canonicalBasis(basisInput(basis))) !== basis.digest) return fail('BASIS_MISMATCH');
    }
    if (item.type === 'calculation_result') {
      const saved = item.value as CalculationResult, basis = exact<EvaluationBasis>(saved.basisRef);
      if (!equal(businessDefinition(saved), evaluateAssignment(basisInput(basis)))) return fail('RESULT_MISMATCH');
    }
    if (item.type === 'attestation') {
      const attestation = item.value as Attestation;
      const basis = [...all.values()].find(candidate => candidate.type === 'evaluation_basis' && (candidate.value as EvaluationBasis).digest === attestation.basisDigest)?.value as EvaluationBasis | undefined;
      const stored = repository.findEvaluationByDigest(attestation.basisDigest)?.basisRef;
      const selectedBasis = basis ?? (stored ? exact<EvaluationBasis>(stored) : null);
      const result = selectedBasis && resultFor(selectedBasis);
      if (!selectedBasis || !result) return fail('BASIS_MISMATCH');
      validateAttestation({ basis: selectedBasis, result, attestation });
    }
    if (item.type === 'agreed_snapshot') {
      const snapshot = item.value as AgreedSnapshot, basis = exact<EvaluationBasis>(snapshot.basisRef);
      validateAgreedSnapshot({ snapshot, basis, result: snapshot.numericResult ? resultFor(basis) : null, manualStatus: snapshot.manualStatusRef ? exact<ManualStatusEvent>(snapshot.manualStatusRef) : null, attestation: snapshot.attestationRef ? exact<Attestation>(snapshot.attestationRef) : null });
    }
  }
  return incoming;
}

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
  const { selected, all } = capsules(main, deps.clock.now()), warnings: Problem[] = [];
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
  let incoming = validateIncoming(deps.repository, selected, anchors, all);
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
    incoming = validateIncoming(deps.repository, selected, anchors, all);
    for (const anchor of anchors) {
      const ref = { entityType: 'publication_anchor', id: anchor.id }, existing = deps.repository.readPublicationAnchor(ref);
      if (!existing || !equal(existing, anchor)) deps.repository.appendPublicationAnchor(anchor, deps.repository.publicationAnchorMetadataRevision(ref));
    }
    const changedRefs: EntityRef[] = anchors.map(anchor => ({ entityType: 'publication_anchor', id: anchor.id }));
    for (const item of [...incoming.versions.values()].sort((a, b) => versionKey(refOf(a)) < versionKey(refOf(b)) ? -1 : 1)) { deps.repository.importPublishedVersion(item.type, item.value); changedRefs.push({ entityType: item.type, id: item.value.id }); }
    for(const commitEvidence of evidenceCommits) commitEvidence();
    store.write({ repositoryId: main.repositoryId, commit: main.commit });
    return { result: { appliedCommit: main.commit, stateRevision: (BigInt(deps.repository.getStateRevision()) + 1n).toString(), anchors, warnings }, changedRefs, editToken: null };
  }).result;
}
