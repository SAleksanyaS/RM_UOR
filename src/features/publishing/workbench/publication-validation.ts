import type { AgreedSnapshot, Attestation, CalculationResult, CoreGoalDefinition, DirectoryEntity, DirectoryLink, EvaluationBasis, GoalAssignment, ManualCorrection, ManualStatusEvent, MethodVersion, ObservedFact, Template, Work, WorkDependency, Decision, WorkbenchEntity, WorkbenchEntityType } from '../../../domain/workbench/entities';
import type { EntityRef, Header, VersionRef } from '../../../domain/workbench/primitives';
import type { PublicationAnchor } from '../../../domain/workbench/publication';
import { entityReferences, validateReferences } from '../../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { isPublicationAnchorAttachment } from '../../../server/storage/workbench-repository';
import { validateDirectoryChanges } from '../../catalog/workbench-directory';
import { businessDefinition } from '../../catalog/workbench-drafts';
import { validateGraph, validateWorkChange } from '../../execution/workbench-execution';
import { canonicalBasis, digestBasis } from '../../evaluation/workbench/basis';
import { evaluateAssignment } from '../../evaluation/workbench/evaluate';
import { validateAgreedSnapshot, validateAttestation, validateCorrection } from '../../evaluation/workbench/state-rules';
import { gitOidSchema, packageManifestSchema, type PackageManifest, type VerifiedMain } from './contracts';
import { canonicalBytes, hashBytes, integrity } from './package-manifest';
import { fail, objectKey, readMainProjection, versionKey } from './package-projection';
import { verifyPublicationAnchor } from './publication-anchor';
import { buildHistoricalEvaluationInput, historicalBasisDefinitions } from './historical-input';

type Item = { type: string; value: WorkbenchEntity };
export type PublicationCapsule = { manifest: PackageManifest; files: Map<string, Uint8Array>; main: VerifiedMain; anchor: PublicationAnchor };
type Capsule = PublicationCapsule;
export type PublicationGraphRepository = Pick<WorkbenchRepository, 'readVersion' | 'readPublicationAnchor' | 'readVersionsForPublicationAnchor' | 'readPublishedCatalog' | 'readPublishedHead' | 'findEvaluationByDigest'> & { canAttachLocalVersion?(type: string, value: Header, owner: { installationId: string; personId: string | null }): boolean };
const refOf = (item: Item): VersionRef => ({ entityType: item.type, id: item.value.id, revision: item.value.revision });
const equal = (left: unknown, right: unknown) => hashBytes(canonicalBytes(left)) === hashBytes(canonicalBytes(right));

/** Supplied by a trusted Git reader, never by browser request fields. files contains
 * every workbench capsule in the future tree; candidateTreeOid binds the entire Git tree. */
export type PublicationCandidate = { repositoryId: string; sourceOid: string; targetOid: string; candidateTreeOid: string; files: ReadonlyMap<string, Uint8Array> };
export type PublicationCandidateInput = { candidate: PublicationCandidate; target: VerifiedMain };
export type PublicationCandidateProof = Readonly<{ repositoryId: string; sourceOid: string; targetOid: string; candidateTreeOid: string; contentDigest: string; remoteAcceptance: 'not-enforced' }>;
const semanticTime='1970-01-01T00:00:00.000Z';
function candidateBinding({candidate,target}:PublicationCandidateInput):PublicationCandidateProof {
  for(const oid of [candidate.sourceOid,candidate.targetOid,candidate.candidateTreeOid,target.commit])gitOidSchema.parse(oid);
  if(!candidate.repositoryId.trim()||candidate.repositoryId!==target.repositoryId||candidate.targetOid!==target.commit) return fail('PREVIEW_STALE',409);
  const files=(value:ReadonlyMap<string,Uint8Array>)=>[...value].map(([path,bytes])=>({path,hash:hashBytes(bytes)})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return Object.freeze({repositoryId:candidate.repositoryId,sourceOid:candidate.sourceOid,targetOid:candidate.targetOid,candidateTreeOid:candidate.candidateTreeOid,contentDigest:'sha256:'+hashBytes(canonicalBytes({candidate:files(candidate.files),target:files(target.files)})),remoteAcceptance:'not-enforced'});
}
function graphRepository(capsules:Capsule[]):PublicationGraphRepository {
  const projection=readMainProjection({repositoryId:'candidate-baseline',commit:'0'.repeat(40),files:new Map(capsules.flatMap(capsule=>[...capsule.main.files]))});
  const anchors=new Map(capsules.map(capsule=>[capsule.anchor.id,capsule.anchor]));
  return {
    readVersion<T extends Header>(ref:VersionRef):T|null{return (projection.versions.get(versionKey(ref))?.value as T|undefined)??null;},
    readPublicationAnchor:ref=>anchors.get(ref.id)??null,
    readVersionsForPublicationAnchor:id=>[...projection.versions.values()].filter(item=>item.value.publicationAnchorId===id).map(item=>({entityType:item.type,value:item.value})),
    readPublishedCatalog:()=>[...projection.heads.values()].map(item=>({entityType:item.type,value:item.value})),
    readPublishedHead<T extends Header>(ref:EntityRef):T|null{return (projection.heads.get(objectKey(ref))?.value as T|undefined)??null;},
    findEvaluationByDigest:digest=>{
      const basis=[...projection.versions.values()].find(item=>item.type==='evaluation_basis'&&(item.value as EvaluationBasis).digest===digest);
      if(!basis)return null;
      const result=[...projection.versions.values()].find(item=>item.type==='calculation_result'&&equal((item.value as CalculationResult).basisRef,refOf(basis)));
      return {basisRef:refOf(basis),resultRef:result?refOf(result):null};
    },
  };
}

/** Local semantic proof only. It cannot enforce the external provider's final
 * source/target compare-and-accept step; that production capability is unsupported. */
export function validatePublicationCandidate(input:PublicationCandidateInput):PublicationCandidateProof {
  const proof=candidateBinding(input),{candidate,target}=input;
  for(const [name,bytes] of target.files)if(!candidate.files.has(name)||hashBytes(candidate.files.get(name)!)!==hashBytes(bytes))return fail('PUBLICATION_CONTENT_IMMUTABLE');
  const accepted=readPublicationCapsules(target,semanticTime);
  const future=readPublicationCapsules({repositoryId:candidate.repositoryId,commit:candidate.sourceOid,files:new Map(candidate.files)},semanticTime);
  // Synthetic anchors model the future accepted graph only inside validation.
  // No anchor, timestamp, result or proof is persisted by this pure function.
  const baseline=graphRepository(accepted.selected);
  const empty=graphRepository([]),owner={installationId:'candidate-validation',personId:null};
  validatePublicationGraph(empty,accepted.selected,accepted.selected.map(c=>c.anchor),accepted.all,owner);
  for(const old of accepted.selected){const next=future.selected.find(c=>c.anchor.id===old.anchor.id);if(!next||next.anchor.revision!==old.anchor.revision||next.anchor.contentHash!==old.anchor.contentHash)return fail('PUBLICATION_CONTENT_IMMUTABLE');}
  validatePublicationGraph(baseline,future.selected,future.selected.map(c=>c.anchor),future.all,owner);
  return proof;
}
export function assertPublicationCandidateProof(proof:PublicationCandidateProof,input:PublicationCandidateInput):void {
  if(!equal(proof,candidateBinding(input)))return fail('PREVIEW_STALE',409);
  validatePublicationCandidate(input);
}

export function readPublicationCapsules(main: VerifiedMain, verifiedAt: string): { all: Capsule[]; selected: Capsule[] } {
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

export function validatePublicationGraph(repository: PublicationGraphRepository, selected: Capsule[], anchors: PublicationAnchor[], allCapsules: Capsule[], owner:{installationId:string;personId:string|null}) {
  const incoming = readMainProjection({ repositoryId: 'verified-projection', commit: '0'.repeat(40), files: new Map(selected.flatMap(capsule => [...capsule.main.files])) });
  const byAnchor = new Map(anchors.map(anchor => [anchor.id, anchor]));
  for (const item of incoming.versions.values()) {
    const prior = repository.readVersion<WorkbenchEntity>(refOf(item));
    if (prior && !equal(prior, item.value) && !(isPublicationAnchorAttachment(prior,item.value) && byAnchor.get(item.value.publicationAnchorId!)?.publicationState==='confirmed' && repository.canAttachLocalVersion?.(item.type,prior,owner) === true)) return fail('REFERENCE_VERSION_COLLISION');
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
  const basisInput = (basis: EvaluationBasis) => buildHistoricalEvaluationInput(basis,read,anchors);
  const resultFor = (basis: EvaluationBasis): CalculationResult | null => {
    const result = [...all.values()].find(item => item.type === 'calculation_result' && equal((item.value as CalculationResult).basisRef, { entityType: 'evaluation_basis', id: basis.id, revision: basis.revision }));
    if (result) return result.value as CalculationResult;
    const stored = repository.findEvaluationByDigest(basis.digest)?.resultRef;
    return stored ? exact<CalculationResult>(stored) : null;
  };
  for (const item of incoming.versions.values()) {
    if (item.type === 'evaluation_basis') {
      const basis = item.value as EvaluationBasis;
      historicalBasisDefinitions(basis,read);
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
