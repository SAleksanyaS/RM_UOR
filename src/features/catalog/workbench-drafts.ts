import { z } from 'zod';
import { WorkbenchError } from '../../domain/workbench/errors';
import type { AgreedSnapshot, Attestation, CalculationResult, CoreGoalDefinition, DirectoryEntity, DirectoryLink, Evidence, EvaluationBasis, EvaluationInput, GoalAssignment, ManualCorrection, ManualStatusEvent, ObservedFact, Template, WorkbenchEntity, WorkbenchEntityType } from '../../domain/workbench/entities';
import type { EntityRef, Header, VersionRef } from '../../domain/workbench/primitives';
import { newUuid } from '../../domain/workbench/primitives';
import { entityReferences, schemaForEntity, validateReferences } from '../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext } from '../../server/workbench/command-registry';
import { commitCommandEffect, createCommandStore } from '../../server/workbench/command-store';
import { fieldProblems, WorkbenchHttpError, type FieldProblem, type RevisionToken } from '../../server/workbench/protocol';
import type { FileStore } from '../../server/workbench/files';
import { canUseCapability } from '../identity/workbench-access-policy';
import type { DirectorySnapshotRefs, DirectoryStore } from './workbench-directory-store';
import { proposeTeamAssignments, validateDirectoryChanges } from './workbench-directory';
import type { DraftStore, StoredDraft, StoredPackage } from './workbench-draft-store';
import type { EvidenceService } from '../evidence/workbench-evidence';
import { prepareEvaluation as defaultPrepare } from '../evaluation/workbench/prepare-evaluation';
import { resolveEvaluationInput } from '../evaluation/workbench/resolve-input';
import { canonicalBasis, digestBasis } from '../evaluation/workbench/basis';
import { evaluateAssignment } from '../evaluation/workbench/evaluate';
import { validateAgreedSnapshot, validateAttestation, validateCorrection, validateManualTransition } from '../evaluation/workbench/state-rules';

type DeepPartial<T> = T extends readonly (infer V)[] ? DeepPartial<V>[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type PartialDraftInput<T> = T extends Header ? DeepPartial<Omit<T, keyof Header>> : never;
export type DraftEntry = { draftId: string; entityRef: EntityRef; versionRef: VersionRef; baseRef: VersionRef | null; definition: Record<string, unknown>; complete: boolean; problems: FieldProblem[] };
export type DraftPackageView = { packageId: string; ownerPersonId: string; revision: number; baseCommit: string | null; entries: DraftEntry[] };
export type DraftValidation = { complete: boolean; problems: FieldProblem[]; changedRefs: EntityRef[] };
export type DraftOpenInput = { entityType: string; ref: EntityRef | null; packageId: string | null };
export type DraftOpenResult = { draftId: string; objectId: string; entityRef: EntityRef; editToken: RevisionToken };
export type DraftSaveInput = { draftId: string; definition: PartialDraftInput<WorkbenchEntity> };
export type DraftSaveResult = { draftId: string; entityRef: EntityRef; versionRef: VersionRef; complete: boolean; problems: FieldProblem[] };
export type DraftOwnerSave = { context: CommandContext; entry: StoredDraft; definition: Record<string, unknown>; previous: Header | null };
export type DraftOwnerPolicy = {
  initialDefinition?(entityType: string): Record<string, unknown>;
  validateSave?(input: DraftOwnerSave): void;
  afterSave?(input: DraftOwnerSave): void;
  validatePackage?(input: { context: CommandContext; entry: StoredDraft; value: WorkbenchEntity; previous: Header | null; resolve: (ref: EntityRef | VersionRef) => Header | null }): void;
};
const headerKeys = new Set(['schemaVersion','id','revision','recordedAt','actor','publicationAnchorId']);
export const draftEntityTypes = ['core_goal_definition','goal_assignment','method_version','metric_definition','template','source_definition','source_field_mapping','applicability','directory_entity','directory_link','manual_status_event','manual_correction','attestation','agreed_snapshot','commentary','evidence','work','work_dependency','decision','dashboard_def','custom_field_def','custom_field_value','business_calendar','reminder_settings'] as const;
const definitionTypes = new Set<string>(['core_goal_definition','goal_assignment','method_version','metric_definition','template','source_definition','source_field_mapping','applicability','directory_entity','directory_link','work','work_dependency','decision','dashboard_def','custom_field_def','custom_field_value','business_calendar','reminder_settings']);
const fail = (code: string, status = 422): never => { throw new WorkbenchHttpError(status, code, code); };
const refOf = (entityType: string, value: Header): VersionRef => ({ entityType, id: value.id, revision: value.revision });
export const businessDefinition = (value: object): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([key]) => !headerKeys.has(key)));
const issue = (code: string, path = '', ref: EntityRef | null = null): FieldProblem => ({ path, code, message: code, ref });
const validatedEntity = (type: string, value: unknown) => { const parsed = schemaForEntity(type).safeParse(value); if (!parsed.success) throw new WorkbenchHttpError(422, 'VALIDATION_FAILED', 'Invalid business values', fieldProblems(parsed.error)); return parsed.data; };

/** Structural partial forms retain strict present scalar values. Full object/array cross-field
 * invariants run at completion and package validation, never by inventing absent values. */
function partialSchema(schema: z.ZodType, top = false): z.ZodType {
  if (schema instanceof z.ZodObject) return z.strictObject(Object.fromEntries(Object.entries(schema.shape).filter(([key]) => !top || !headerKeys.has(key)).map(([key, value]) => [key, partialSchema(value as z.ZodType).optional()])));
  if (schema instanceof z.ZodNullable) return partialSchema(schema.unwrap() as z.ZodType).nullable();
  if (schema instanceof z.ZodOptional) return partialSchema(schema.unwrap() as z.ZodType).optional();
  if (schema instanceof z.ZodArray) return z.array(partialSchema(schema.element as z.ZodType));
  if (schema instanceof z.ZodUnion) return z.union(schema.options.map(option => partialSchema(option as z.ZodType, top)));
  if (schema instanceof z.ZodRecord) return z.record(schema.keyType, partialSchema(schema.valueType as z.ZodType));
  return schema;
}
const partials = new Map<string, z.ZodType>();
export function draftDefinitionSchema(type: string): z.ZodType {
  if (!draftEntityTypes.includes(type as typeof draftEntityTypes[number])) return fail('DRAFT_TYPE_UNSUPPORTED');
  let result = partials.get(type); if (!result) { result = partialSchema(schemaForEntity(type), true); partials.set(type, result); } return result;
}

export function createDraftService({ repository, store, clock, prepareEvaluation = defaultPrepare, evidence, sourceState, directory, directoryRefs, assignmentInventory }: {
  repository: WorkbenchRepository; store: DraftStore; clock: CommandContext['clock']; files: FileStore; prepareEvaluation?: typeof defaultPrepare; directory: DirectoryStore; evidence: EvidenceService;
  sourceState: { readLatestAttempt(input: { installationId: string; goalId: string }): { complete: boolean } | null };
  directoryRefs?: () => DirectorySnapshotRefs | null;
  assignmentInventory?: () => { assignments: GoalAssignment[]; templates: Template[] } | null;
}) {
  const ownerPolicies = new Map<string, DraftOwnerPolicy>();
  const previousFrozen = (entry: StoredDraft, excludeCurrent = false): Header | null => store.frozenVersions(entry.packageId).filter(v => v.entityRef.entityType === entry.entityRef.entityType && v.entityRef.id === entry.entityRef.id && (!excludeCurrent || v.value.revision < entry.header.revision)).at(-1)?.value ?? (entry.baseRef ? repository.readVersion(entry.baseRef) : null);
  const assertContext = (context: CommandContext, edit = true) => {
    if (context.repository !== repository || context.actor.installationId !== context.installationId || context.actor.profilePersonId !== context.ownAccess.personId) return fail('COMMAND_CONTEXT_MISMATCH', 409);
    if (edit && (!context.ownAccess.personId || !canUseCapability(context.ownAccess, 'uor.prepare'))) return fail('COMMAND_FORBIDDEN', 403);
  };
  const ownPackage = (context: CommandContext, packageId: string): StoredPackage => {
    const pkg = store.getPackage(packageId); if (!pkg || pkg.installationId !== context.installationId || pkg.ownerPersonId !== context.ownAccess.personId) return fail('DRAFT_NOT_FOUND', 404); return pkg;
  };
  const own = (context: CommandContext, draftId: string, types?: string[]) => {
    assertContext(context); const entry = store.getEntry(draftId); if (!entry) return fail('DRAFT_NOT_FOUND', 404); ownPackage(context, entry.packageId);
    if (types && !types.includes(entry.entityRef.entityType)) return fail('DRAFT_TYPE_MISMATCH'); return entry;
  };
  const expectedToken = (context: CommandContext): string | null => {
    const intent = createCommandStore(repository).get(context.installationId, context.commandId);
    if (!intent) return fail('COMMAND_INTENT_MISSING', 409); return (JSON.parse(intent.request_json) as { baseRevision: string | null }).baseRevision;
  };
  const isPublished = (value: Header) => value.publicationAnchorId !== null && repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId })?.publicationState === 'confirmed';
  const accessible = (context: CommandContext, value: Header) => isPublished(value) || value.actor.installationId === context.installationId && value.actor.profilePersonId === context.ownAccess.personId;
  const materialize = (entry: StoredDraft) => ({ ...entry.header, ...entry.definition }) as WorkbenchEntity;
  const resolve = <T extends Header>(context: CommandContext, ref: EntityRef | VersionRef, pkg?: StoredPackage): T => {
    const draft = pkg?.entries.find(entry => entry.entityRef.entityType === ref.entityType && entry.entityRef.id === ref.id) as StoredDraft | undefined;
    if (draft && (!('revision' in ref) || ref.revision === draft.header.revision)) {
      const parsed = schemaForEntity(ref.entityType).safeParse(materialize(draft)); if (!parsed.success) return fail('DRAFT_REFERENCE_INCOMPLETE'); return parsed.data as T;
    }
    const historical = pkg && 'revision' in ref ? store.readDraftVersion(pkg.packageId, ref) : null;
    if (historical) return historical as T;
    const value = 'revision' in ref ? repository.readVersion<T>(ref) : repository.readPublishedHead<T>(ref);
    if (!value || !accessible(context, value)) return fail('REFERENCE_NOT_FOUND', 404); return value;
  };
  const assess = (entry: StoredDraft, definition: Record<string, unknown>) => {
    const parsed = schemaForEntity(entry.entityRef.entityType).safeParse({ ...entry.header, ...definition });
    return { complete: parsed.success, problems: parsed.success ? [] : fieldProblems(parsed.error) };
  };
  // Form audit is mutable input. Only a fully reference-checked closure reserves
  // immutable entity versions; a corrected bad reference must not leave a gap.
  const freezeReadyForms = (context: CommandContext, packageId: string) => {
    const pkg = ownPackage(context, packageId);
    for (const entry of pkg.entries as StoredDraft[]) {
      const closure = new Map<string, { type: string; value: Header }>();
      const visit = (ref: EntityRef | VersionRef): Header => {
        const local = pkg.entries.find(e => e.entityRef.entityType === ref.entityType && e.entityRef.id === ref.id) as StoredDraft | undefined;
        if (!local || 'revision' in ref && ref.revision !== local.header.revision) {
          const derived = 'revision' in ref ? store.readDerived(ref) : null;
          const historical = 'revision' in ref ? store.readDraftVersion(packageId, ref) ?? (derived?.packageId === packageId ? derived.value : null) : null;
          if (historical) return historical;
          return resolve(context, ref, pkg);
        }
        const value = validatedEntity(ref.entityType, materialize(local)) as WorkbenchEntity;
        const key = `${ref.entityType}/${value.id}/${value.revision}`;
        if (!closure.has(key)) {
          closure.set(key, { type: ref.entityType, value });
          validateReferences(entityReferences(ref.entityType as WorkbenchEntityType, value), visit);
          if (ref.entityType === 'goal_assignment') {
            const assignment = value as GoalAssignment; const goal = visit({ entityType: 'core_goal_definition', id: assignment.goalId }) as CoreGoalDefinition;
            const methodRef = assignment.methodBinding.kind === 'standalone' ? assignment.methodBinding.methodRef : (visit({ entityType: 'template', id: assignment.methodBinding.templateId }) as Template).methodRef;
            if ((visit(methodRef) as Header & { mode: string }).mode !== goal.mode) fail('METHOD_MODE_MISMATCH');
          }
        }
        return value;
      };
      try { visit(entry.versionRef); }
      catch (error) { if (error instanceof WorkbenchHttpError || error instanceof WorkbenchError || error instanceof z.ZodError) continue; throw error; }
      for (const { type, value } of closure.values()) store.freeze(packageId, type, value);
    }
  };
  const write = (context: CommandContext, draftId: string, definition: Record<string, unknown>, types?: string[], before?: (entry: StoredDraft) => void): DraftSaveResult => {
    return commitCommandEffect(context, () => {
      const entry = own(context, draftId, types); store.assertToken(entry.packageId, expectedToken(context));
      const partial = draftDefinitionSchema(entry.entityRef.entityType).safeParse(definition);
      if (!partial.success) throw new WorkbenchHttpError(422, 'VALIDATION_FAILED', 'Invalid form values', fieldProblems(partial.error));
      const body = partial.data as Record<string, unknown>; const state = assess(entry, body);
      const policy = ownerPolicies.get(entry.entityRef.entityType); const previous = previousFrozen(entry);
      policy?.validateSave?.({ context, entry, definition: body, previous });
      const editToken = store.save(draftId, body, state.complete, state.problems, context.actor, clock.now());
      before?.(store.getEntry(draftId)!);
      freezeReadyForms(context, entry.packageId);
      policy?.afterSave?.({ context, entry: store.getEntry(draftId)!, definition: body, previous });
      return { result: { draftId, entityRef: entry.entityRef, versionRef: store.getEntry(draftId)!.versionRef, ...state }, changedRefs: [entry.entityRef], editToken };
    }).result;
  };
  const evaluationInput = (context: CommandContext, request: { assignmentRef: VersionRef; businessTime: EvaluationInput['context']['businessTime'] }, packageOverride?: StoredPackage): EvaluationInput => {
    const drafts = store.findOwn(context.installationId, context.ownAccess.personId, request.assignmentRef).filter(e => e.header.revision === request.assignmentRef.revision);
    if (drafts.length > 1) return fail('DRAFT_REFERENCE_AMBIGUOUS', 409);
    const pkg = packageOverride ?? (drafts[0] ? ownPackage(context, drafts[0].packageId) : undefined);
    const checked = new Set<string>();
    const findLocal = (ref: EntityRef | VersionRef) => {
      const entry = pkg?.entries.find(e => e.entityRef.entityType === ref.entityType && e.entityRef.id === ref.id) as StoredDraft | undefined;
      const value = entry && (!('revision' in ref) || entry.header.revision === ref.revision) ? materialize(entry) : pkg && 'revision' in ref ? store.readDraftVersion(pkg.packageId, ref) : null;
      if (!value) return null;
      const parsed = validatedEntity(ref.entityType, value) as WorkbenchEntity; const key = `${ref.entityType}/${value.id}/${value.revision}`;
      if (!checked.has(key)) { checked.add(key); validateReferences(entityReferences(ref.entityType as WorkbenchEntityType, parsed), target => findLocal(target) ?? resolve(context, target)); }
      return parsed;
    };
    const filtered: WorkbenchRepository = { ...repository, readEvaluationCandidates(query) {
      const candidates = repository.readEvaluationCandidates(query);
      const captures = candidates.captures.filter(c => accessible(context, c)); const ids = new Set(captures.map(c => c.id));
      return { captures, facts: candidates.facts.filter(f => accessible(context, f) && ids.has(f.captureId)), applicability: candidates.applicability, corrections: candidates.corrections };
    } };
    return resolveEvaluationInput(request, filtered, clock, context.actor, pkg ? { read: findLocal, accepts: (value, ref) => checked.has(`${ref.entityType}/${value.id}/${value.revision}`) } : undefined);
  };
  const derived = <T extends Header>(context: CommandContext, ref: VersionRef, pkg?: StoredPackage): T | null => {
    const local = store.readDerived(ref);
    if (local) { ownPackage(context, local.packageId); if (pkg && pkg.packageId !== local.packageId) return fail('REFERENCE_NOT_FOUND', 404); return local.value as T; }
    return repository.readVersion<T>(ref);
  };
  const currentBasis = (context: CommandContext, basis: EvaluationBasis, pkg: StoredPackage | undefined, code: string) => {
    const input = evaluationInput(context, { assignmentRef: basis.assignmentRef, businessTime: basis.businessTime }, pkg);
    const currentAssignment = pkg?.entries.find(entry => entry.entityRef.entityType === 'goal_assignment' && entry.entityRef.id === input.assignment.id)?.versionRef ?? repository.readPublishedHead<GoalAssignment>({ entityType: 'goal_assignment', id: input.assignment.id });
    if (currentAssignment && currentAssignment.revision !== basis.assignmentRef.revision || digestBasis(canonicalBasis(input)) !== basis.digest) return fail(code);
    return input;
  };
  type ManualProof = { previousRef: VersionRef | null; publishedRootRef: VersionRef | null; assignmentRef: VersionRef; goalRef: VersionRef };
  const refKey = (ref: VersionRef | null) => ref ? `${ref.entityType}/${ref.id}/${ref.revision}` : 'absent';
  const publishedManual = (ref: VersionRef): ManualStatusEvent | null => {
    const value = repository.readVersion<ManualStatusEvent>(ref); return value && isPublished(value) ? value : null;
  };
  const manualDefinitions = (context: CommandContext, pkg: StoredPackage, assignmentId: string) => {
    const assignment = resolve<GoalAssignment>(context, { entityType: 'goal_assignment', id: assignmentId }, pkg);
    const goal = resolve<CoreGoalDefinition>(context, { entityType: 'core_goal_definition', id: assignment.goalId }, pkg);
    if (goal.mode !== 'manual_status') return fail('INVALID_MANUAL_TRANSITION');
    return { assignmentRef: refOf('goal_assignment', assignment), goalRef: refOf('core_goal_definition', goal) };
  };
  const manualChain = (context: CommandContext, pkg: StoredPackage, ref: VersionRef, assignmentId: string) => {
    const refs = new Set<string>(); const definitions = manualDefinitions(context, pkg, assignmentId);
    const walk = (current: VersionRef): VersionRef | null => {
      const key = refKey(current); if (refs.has(key)) return fail('INVALID_MANUAL_TRANSITION'); refs.add(key);
      const published = publishedManual(current); if (published) { if (published.assignmentId !== assignmentId) fail('INVALID_MANUAL_TRANSITION'); return current; }
      const entry = pkg.entries.find(e => e.entityRef.entityType === current.entityType && e.entityRef.id === current.id);
      const proof = entry && store.readProof<ManualProof>(entry.draftId, `manual-transition:${current.revision}`);
      if (!proof) return fail('TRANSITION_PROOF_REQUIRED');
      if (refKey(proof.assignmentRef) !== refKey(definitions.assignmentRef) || refKey(proof.goalRef) !== refKey(definitions.goalRef)) return fail('REVISION_CONFLICT', 409);
      const event = resolve<ManualStatusEvent>(context, current, pkg);
      const previous = proof.previousRef ? resolve<ManualStatusEvent>(context, proof.previousRef, pkg) : null;
      if (event.assignmentId !== assignmentId) return fail('INVALID_MANUAL_TRANSITION');
      validateManualTransition(previous, event);
      const root = proof.previousRef ? walk(proof.previousRef) : null;
      if (refKey(root) !== refKey(proof.publishedRootRef)) return fail('REVISION_CONFLICT', 409);
      return root;
    };
    const rootRef = walk(ref); const latest = repository.readLatestManualStatus(assignmentId);
    if (refKey(latest ? refOf('manual_status_event', latest) : null) !== refKey(rootRef)) return fail('REVISION_CONFLICT', 409);
    return { rootRef, refs };
  };
  const assertManualTip = (pkg: StoredPackage, assignmentId: string, chain: Set<string>) => {
    for (const entry of pkg.entries as StoredDraft[]) {
      if (entry.entityRef.entityType !== 'manual_status_event' || entry.definition.assignmentId !== assignmentId || publishedManual(entry.versionRef)) continue;
      if (!chain.has(refKey(entry.versionRef))) return fail('REVISION_CONFLICT', 409);
    }
  };
  const currentConfirmation = (context: CommandContext, resultRef: VersionRef, pkg?: StoredPackage) => {
    if (resultRef.entityType !== 'calculation_result') return fail('BASIS_NOT_CONFIRMABLE');
    const result = derived<CalculationResult>(context, resultRef, pkg); if (!result) return fail('BASIS_NOT_CONFIRMABLE');
    const basis = derived<EvaluationBasis>(context, result.basisRef, pkg); if (!basis) return fail('BASIS_NOT_CONFIRMABLE');
    const input = currentBasis(context, basis, pkg, 'BASIS_NOT_CONFIRMABLE');
    const fresh = evaluateAssignment({ ...input, resolution: { ...input.resolution, basisRef: result.basisRef } });
    if (!fresh.canConfirm || !result.canConfirm || sourceState.readLatestAttempt({ installationId: context.installationId, goalId: input.goal.id })?.complete === false) return fail('BASIS_NOT_CONFIRMABLE');
    return { basis, result, input };
  };

  const service = {
    registerOwnerPolicy(types: string[], policy: DraftOwnerPolicy) {
      for (const type of types) if (!definitionTypes.has(type) || ownerPolicies.has(type)) fail('DRAFT_OWNER_ALREADY_REGISTERED', 409);
      for (const type of types) ownerPolicies.set(type, policy);
    },
    readOwnEntry(context: CommandContext, draftId: string, types?: string[]) { return own(context, draftId, types); },
    readOwnFormHistory(context: CommandContext, draftId: string) { own(context, draftId); return store.history(draftId); },
    readOwnPackage(context: CommandContext, packageId: string) { assertContext(context, false); return ownPackage(context, packageId); },
    resolveOwnReference(context: CommandContext, packageId: string, ref: EntityRef | VersionRef): Header { assertContext(context, false); return resolve(context, ref, ownPackage(context, packageId)); },
    async open(context: CommandContext, input: DraftOpenInput): Promise<DraftOpenResult> {
      assertContext(context); draftDefinitionSchema(input.entityType);
      return commitCommandEffect(context, () => {
        const pkg = input.packageId ? ownPackage(context, input.packageId) : null;
        if (pkg) store.assertToken(pkg.packageId, expectedToken(context));
        if (input.ref && input.ref.entityType !== input.entityType) return fail('DRAFT_TYPE_MISMATCH');
        const existing = pkg && input.ref ? store.find(pkg.packageId, input.ref) : null;
        if (existing) return { result: { draftId: existing.draftId, objectId: existing.entityRef.id, entityRef: existing.entityRef, editToken: store.token(pkg!) }, changedRefs: [], editToken: store.token(pkg!) };
        const base = input.ref ? repository.readPublishedHead<Header>(input.ref) : null;
        if (input.ref && (!base || !isPublished(base))) return fail('DRAFT_NOT_FOUND', 404);
        const packageId = pkg?.packageId ?? newUuid(); if (!pkg) store.createPackage({ packageId, installationId: context.installationId, ownerPersonId: context.ownAccess.personId!, baseCommit: null });
        const entityRef = { entityType: input.entityType, id: input.ref?.id ?? newUuid() }; const draftId = newUuid();
        const header: Header = { schemaVersion: 1, id: entityRef.id, revision: (base?.revision ?? 0) + 1, actor: context.actor, recordedAt: clock.now(), publicationAnchorId: null };
        const definition = base ? businessDefinition(base) : draftDefinitionSchema(input.entityType).parse(ownerPolicies.get(input.entityType)?.initialDefinition?.(input.entityType) ?? {}) as Record<string, unknown>;
        const temp = { entityRef, header } as StoredDraft; const state = assess(temp, definition);
        const editToken = store.add({ draftId, packageId, entityRef, baseRef: base ? refOf(input.entityType, base) : null, definition, ...state, header });
        freezeReadyForms(context, packageId);
        return { result: { draftId, objectId: entityRef.id, entityRef, editToken }, changedRefs: [entityRef], editToken };
      }).result;
    },
    async saveDefinition(context: CommandContext, input: DraftSaveInput, expectedTypes?: string[]): Promise<DraftSaveResult> {
      const entry = own(context, input.draftId, expectedTypes); if (!definitionTypes.has(entry.entityRef.entityType)) return fail('DRAFT_SPECIAL_COMMAND_REQUIRED');
      return write(context, input.draftId, input.definition as Record<string, unknown>);
    },
    readDraftPackage(packageId: string): DraftPackageView {
      const pkg = store.getPackage(packageId); if (!pkg) return fail('DRAFT_NOT_FOUND', 404);
      return { packageId, ownerPersonId: pkg.ownerPersonId, revision: pkg.revision, baseCommit: pkg.baseCommit, entries: pkg.entries.map(({ draftId, entityRef, versionRef, baseRef, definition, complete, problems }) => ({ draftId, entityRef, versionRef, baseRef, definition, complete, problems })) };
    },
    // Internal publisher ports: caller must authorize package ownership before using them.
    // Export reference-checked immutable dependencies, never intermediate form audit.
    readDraftVersions(packageId: string) {
      const pkg = store.getPackage(packageId); if (!pkg) return fail('DRAFT_NOT_FOUND', 404);
      return store.frozenVersions(packageId);
    },
    readPreparedForPackage(packageId: string, ref: VersionRef) { const found = store.readDerived(ref); if (!store.getPackage(packageId) || found?.packageId !== packageId) return fail('REFERENCE_NOT_FOUND', 404); return found.value; },
    validateDraftPackage(packageId: string): DraftValidation {
      const pkg = store.getPackage(packageId); if (!pkg) return fail('DRAFT_NOT_FOUND', 404);
      const problems: FieldProblem[] = []; const candidates = new Map<string, WorkbenchEntity>();
      const context: CommandContext = { repository, clock, installationId: pkg.installationId, commandId: newUuid(), requestId: newUuid(), actor: { hostname: 'package-validation', installationId: pkg.installationId, profilePersonId: pkg.ownerPersonId }, ownAccess: { role: 'curator', personId: pkg.ownerPersonId, displayName: null, policyState: 'local_preview', checkedAt: null } };
      for (const entry of pkg.entries as StoredDraft[]) {
        const parsed = schemaForEntity(entry.entityRef.entityType).safeParse(materialize(entry));
        if (!parsed.success) { problems.push(...fieldProblems(parsed.error).map(p => ({ ...p, path: `/entries/${entry.draftId}${p.path}` }))); continue; }
        candidates.set(`${entry.entityRef.entityType}/${entry.entityRef.id}`, parsed.data as WorkbenchEntity);
      }
      const target = (ref: EntityRef | VersionRef) => {
        const candidate = candidates.get(`${ref.entityType}/${ref.id}`);
        if (candidate && (!('revision' in ref) || candidate.revision === ref.revision)) return candidate;
        const historical = 'revision' in ref ? store.readDraftVersion(packageId, ref) : null;
        if (historical) return historical;
        const local = 'revision' in ref ? store.readDerived(ref) : null;
        if (local?.packageId === packageId) return local.value;
        const value = 'revision' in ref ? repository.readVersion(ref) : repository.readPublishedHead(ref);
        if (!value || !isPublished(value) && (!['observed_fact','capture','evaluation_basis','calculation_result'].includes(ref.entityType) || !accessible(context, value))) return null; return value;
      };
      for (const entry of pkg.entries as StoredDraft[]) {
        const value = candidates.get(`${entry.entityRef.entityType}/${entry.entityRef.id}`); if (!value) continue;
        try {
          if (['work','work_dependency','decision'].includes(entry.entityRef.entityType) && !ownerPolicies.has(entry.entityRef.entityType)) fail('DRAFT_OWNER_REQUIRED');
          validateReferences(entityReferences(entry.entityRef.entityType as WorkbenchEntityType, value), target);
          if (entry.baseRef) { const published = repository.readPublishedHead(entry.entityRef); if (!published || published.revision !== entry.baseRef.revision) fail('REVISION_CONFLICT', 409); }
          if (entry.entityRef.entityType === 'goal_assignment') {
            const assignment = value as GoalAssignment; const goal = target({ entityType: 'core_goal_definition', id: assignment.goalId }) as CoreGoalDefinition;
            const binding = assignment.methodBinding; const methodRef = binding.kind === 'standalone' ? binding.methodRef : (target({ entityType: 'template', id: binding.templateId }) as Template).methodRef;
            const method = target(methodRef) as { mode: string } | null; if (!method || method.mode !== goal.mode) fail('METHOD_MODE_MISMATCH');
          }
          if (entry.entityRef.entityType === 'attestation') {
            const attestation = value as Attestation;
            const proof = store.readProof<{ resultRef: VersionRef }>(entry.draftId, 'result-confirmation');
            if (!proof) fail('CONFIRMATION_PROOF_REQUIRED');
            const checked = currentConfirmation(context, proof!.resultRef, pkg); if (checked.basis.digest !== attestation.basisDigest) fail('BASIS_NOT_CONFIRMABLE');
          }
          if (entry.entityRef.entityType === 'agreed_snapshot') {
            const snapshot = value as AgreedSnapshot; const basis = derived<EvaluationBasis>(context, snapshot.basisRef, pkg);
            if (!store.readProof(entry.draftId, 'snapshot')) fail('SNAPSHOT_PROOF_REQUIRED');
            if (!basis) fail('BASIS_MISMATCH'); else currentBasis(context, basis, pkg, 'BASIS_MISMATCH');
          }
          if (entry.entityRef.entityType === 'manual_status_event') {
            const event = value as ManualStatusEvent; const published = repository.readPublishedHead<ManualStatusEvent>(entry.entityRef);
            if (!published || published.revision !== event.revision) {
              manualChain(context, pkg, entry.versionRef, event.assignmentId);
            }
          }
          ownerPolicies.get(entry.entityRef.entityType)?.validatePackage?.({ context, entry, value, previous: previousFrozen(entry, true), resolve: target });
        }
        catch (error) { problems.push(issue((error as { code?: string }).code ?? 'DRAFT_REFERENCE_INVALID', `/entries/${entry.draftId}`, entry.entityRef)); }
      }
      // All pending events for one assignment must belong to a single chain.
      const manualAssignments = new Set((pkg.entries as StoredDraft[]).filter(e => e.entityRef.entityType === 'manual_status_event' && e.complete).map(e => e.definition.assignmentId as string));
      for (const assignmentId of manualAssignments) {
        const events = (pkg.entries as StoredDraft[]).filter(e => e.entityRef.entityType === 'manual_status_event' && e.definition.assignmentId === assignmentId && !publishedManual(e.versionRef));
        if (events.length < 2) continue;
        const linear = events.some(entry => { try { assertManualTip(pkg, assignmentId, manualChain(context, pkg, entry.versionRef, assignmentId).refs); return true; } catch { return false; } });
        if (!linear) problems.push(issue('REVISION_CONFLICT'));
      }
      const org = [...candidates].filter(([key]) => key.startsWith('directory_entity/') || key.startsWith('directory_link/'));
      if (org.length) {
        const refs = directoryRefs?.();
        if (!refs) problems.push(issue('DIRECTORY_INVENTORY_REQUIRED'));
        else {
          try {
            const current = directory.read({ refs, mode: { kind: 'current' } });
            const entities = new Map(current.directoryEntities.map(value => [value.id, value])); const links = new Map(current.directoryLinks.map(value => [value.id, value]));
            for (const [key, value] of org) { if (key.startsWith('directory_entity/')) entities.set(value.id, value as DirectoryEntity); else links.set(value.id, value as DirectoryLink); }
            problems.push(...validateDirectoryChanges({ entities: [...entities.values()], links: [...links.values()], previousLinks: current.directoryLinks }));
          } catch (error) { problems.push(issue((error as { code?: string }).code ?? 'DIRECTORY_VALIDATION_FAILED')); }
        }
      }
      return { complete: problems.length === 0 && pkg.entries.length > 0, problems, changedRefs: pkg.entries.map(e => e.entityRef) };
    },
    async proposeTeam(context: CommandContext, input: { teamDraftId: string; clusterRef: EntityRef; teamTemplateBindings: { goalId: string; templateId: string }[] }) {
      return commitCommandEffect(context, () => {
        const teamEntry = own(context, input.teamDraftId, ['directory_entity']); const pkg = ownPackage(context, teamEntry.packageId); store.assertToken(pkg.packageId, expectedToken(context));
        const refs = directoryRefs?.(), inventory = assignmentInventory?.(); if (!refs || !inventory) return fail('DIRECTORY_INVENTORY_REQUIRED', 503);
        const current = directory.read({ refs, mode: { kind: 'current' } });
        const links = new Map(current.directoryLinks.map(value => [value.id, value]));
        const verified = <T extends Header>(type: string, values: T[]) => values.map(value => { const actual = repository.readPublishedHead<T>({ entityType: type, id: value.id }); if (!actual || actual.revision !== value.revision || !isPublished(actual)) return fail('INVENTORY_STALE', 409); return actual; });
        const assignments = new Map(verified('goal_assignment', inventory.assignments).map(value => [value.id, value]));
        const templates = new Map(verified('template', inventory.templates).map(value => [value.id, value]));
        for (const entry of pkg.entries as StoredDraft[]) {
          if (!['directory_link','goal_assignment','template'].includes(entry.entityRef.entityType) || !entry.complete) continue;
          const value = validatedEntity(entry.entityRef.entityType, materialize(entry));
          if (entry.entityRef.entityType === 'directory_link') links.set(value.id, value as DirectoryLink);
          else if (entry.entityRef.entityType === 'goal_assignment') assignments.set(value.id, value as GoalAssignment);
          else templates.set(value.id, value as Template);
        }
        const active = [...assignments.values()].filter(assignment => resolve<CoreGoalDefinition>(context, { entityType: 'core_goal_definition', id: assignment.goalId }, pkg).lifecycle === 'active');
        const proposed = proposeTeamAssignments({ team: validatedEntity('directory_entity', materialize(teamEntry)) as DirectoryEntity, clusterRef: input.clusterRef, links: [...links.values()], assignments: active, templates: [...templates.values()], teamTemplateBindings: input.teamTemplateBindings, confirmedLinkRefs: current.refs.linkRefs.filter(ref => links.get(ref.id)?.revision === ref.revision) });
        const changedRefs: EntityRef[] = [];
        const add = (type: string, id: string, definition: Record<string, unknown>) => {
          const entityRef = { entityType: type, id }; const existing = store.find(pkg.packageId, entityRef); if (existing) return existing.draftId;
          const header: Header = { schemaVersion: 1, id, revision: 1, actor: context.actor, recordedAt: clock.now(), publicationAnchorId: null };
          const draftId = newUuid(); const state = assess({ entityRef, header } as StoredDraft, definition);
          if (type === 'goal_assignment' && definition.expectedPopulation === null && resolve<CoreGoalDefinition>(context, { entityType: 'core_goal_definition', id: definition.goalId as string }, pkg).mode === 'numeric') { state.complete = false; state.problems = [issue('EXPECTED_POPULATION_REQUIRED', '/expectedPopulation', entityRef)]; }
          store.add({ draftId, packageId: pkg.packageId, entityRef, baseRef: null, definition, header, ...state }); changedRefs.push(entityRef); return draftId;
        };
        const draftIds: string[] = []; const assignmentRefs: EntityRef[] = []; const pendingLinkRefs: EntityRef[] = [];
        for (const proposal of proposed) {
          const { id, publicationPending: _pending, pendingLinks, ...definition } = proposal;
          draftIds.push(add('goal_assignment', id, definition)); assignmentRefs.push({ entityType: 'goal_assignment', id });
          for (const link of pendingLinks) { const { id: linkId, ...body } = link; add('directory_link', linkId, body); if (!pendingLinkRefs.some(ref => ref.id === linkId)) pendingLinkRefs.push({ entityType: 'directory_link', id: linkId }); }
        }
        freezeReadyForms(context, pkg.packageId);
        return { result: { draftIds, assignmentRefs, pendingLinkRefs }, changedRefs, editToken: store.token(store.getPackage(pkg.packageId)!) };
      }).result;
    },
    async prepare(context: CommandContext, input: { assignmentRef: VersionRef; businessTime: EvaluationInput['context']['businessTime'] }) {
      assertContext(context, false);
      return commitCommandEffect(context, () => {
        const resolved = evaluationInput(context, input);
        const local = store.findOwn(context.installationId, context.ownAccess.personId, input.assignmentRef).find(e => e.header.revision === input.assignmentRef.revision);
        if (local) freezeReadyForms(context, local.packageId);
        return { result: prepareEvaluation(resolved, repository, local ? store.evaluationStore(local.packageId) : undefined), changedRefs: [], editToken: null };
      }).result;
    },
    async saveComment(context: CommandContext, input: { draftId: string; targetRef: EntityRef; text: string }) {
      const entry = own(context, input.draftId, ['commentary']); const pkg = ownPackage(context, entry.packageId);
      if (!pkg.entries.some(e => e.entityRef.entityType === input.targetRef.entityType && e.entityRef.id === input.targetRef.id)) resolve(context, input.targetRef);
      return write(context, input.draftId, { targetRef: input.targetRef, text: input.text }, ['commentary']);
    },
    async saveEvidence(context: CommandContext, input: { draftId: string; kind: 'url'; url: string } | { draftId: string; kind: 'file'; fileHandle: string }) {
      const entry = own(context, input.draftId, ['evidence']); store.assertToken(entry.packageId, expectedToken(context));
      const value: Evidence = input.kind === 'file' ? await evidence.fromHandle(context, input) : validatedEntity('evidence', { ...entry.header, kind: 'url', url: input.url }) as Evidence;
      return write(context, input.draftId, businessDefinition(value), ['evidence'], updated => { if (input.kind === 'file') evidence.commitPrepared(context, materialize(updated) as Evidence); });
    },
    async correct(context: CommandContext, input: { draftId: string; factKey: string; originalFactRefs: VersionRef[]; replacement: string; reason: string }) {
      const entry = own(context, input.draftId, ['manual_correction']);
      const { draftId, ...definition } = input;
      const value = validatedEntity('manual_correction', { ...entry.header, ...definition }) as ManualCorrection;
      validateCorrection(value, value.originalFactRefs.map(ref => resolve<ObservedFact>(context, ref)));
      return write(context, draftId, definition, ['manual_correction']);
    },
    async confirm(context: CommandContext, input: { draftId: string; resultRef: VersionRef; comment: string; evidenceIds: string[] }) {
      const entry = own(context, input.draftId, ['attestation']);
      const pkg = ownPackage(context, entry.packageId); const { basis, result } = currentConfirmation(context, input.resultRef, pkg);
      const attestation = validatedEntity('attestation', { ...entry.header, basisDigest: basis.digest, comment: input.comment, evidenceIds: input.evidenceIds }) as Attestation;
      input.evidenceIds.forEach(id => resolve<Evidence>(context, { entityType: 'evidence', id }, ownPackage(context, entry.packageId)));
      validateAttestation({ basis, result, attestation });
      return write(context, input.draftId, businessDefinition(attestation), ['attestation'], () => { currentConfirmation(context, input.resultRef, ownPackage(context, entry.packageId)); store.setProof(input.draftId, 'result-confirmation', { resultRef: input.resultRef }); });
    },
    async snapshot(context: CommandContext, input: { draftId: string; basisRef: VersionRef; resultRef: VersionRef | null; manualStatusRef: VersionRef | null; attestationRef: VersionRef | null }) {
      const entry = own(context, input.draftId, ['agreed_snapshot']); const pkg = ownPackage(context, entry.packageId);
      const basis = derived<EvaluationBasis>(context, input.basisRef, pkg); if (!basis || input.basisRef.entityType !== 'evaluation_basis') return fail('BASIS_MISMATCH');
      // Resolve the same semantic basis under current access; historical snapshots may use
      // an older fact set, but never a foreign private basis or client-supplied numeric values.
      resolve<GoalAssignment>(context, basis.assignmentRef, pkg);
      for (const ref of [...basis.factRefs, ...basis.correctionRefs, ...basis.applicabilityRefs]) resolve(context, ref, pkg);
      currentBasis(context, basis, pkg, 'BASIS_MISMATCH');
      const result = input.resultRef ? derived<CalculationResult>(context, input.resultRef, pkg) : null;
      if (result && (result.basisRef.entityType !== input.basisRef.entityType || result.basisRef.id !== input.basisRef.id || result.basisRef.revision !== input.basisRef.revision)) return fail('BASIS_MISMATCH');
      const manualStatus = input.manualStatusRef ? resolve<ManualStatusEvent>(context, input.manualStatusRef, pkg) : null;
      const attestation = input.attestationRef ? resolve<Attestation>(context, input.attestationRef, pkg) : null;
      const numericResult = result ? businessDefinition(result) : null;
      const value = validatedEntity('agreed_snapshot', { ...entry.header, basisRef: input.basisRef, numericResult, manualStatusRef: input.manualStatusRef, attestationRef: input.attestationRef }) as AgreedSnapshot;
      validateAgreedSnapshot({ snapshot: value, basis, result, manualStatus, attestation });
      return write(context, input.draftId, businessDefinition(value), ['agreed_snapshot'], () => store.setProof(input.draftId, 'snapshot', input));
    },
    async transition(context: CommandContext, input: { draftId: string; ref: VersionRef; targetState: ManualStatusEvent['to']; reason: string | null; resultDescription: string | null }) {
      const entry = own(context, input.draftId, ['manual_status_event']); const pkg = ownPackage(context, entry.packageId);
      const previous = input.ref.entityType === 'manual_status_event' ? resolve<ManualStatusEvent>(context, input.ref, pkg) : null;
      if (!previous && input.ref.entityType !== 'goal_assignment') return fail('INVALID_MANUAL_TRANSITION');
      const assignmentRef = previous ? { entityType: 'goal_assignment', id: previous.assignmentId } : input.ref;
      const assignment = resolve<GoalAssignment>(context, assignmentRef, pkg);
      const definitions = manualDefinitions(context, pkg, assignment.id);
      const chain = previous ? manualChain(context, pkg, input.ref, assignment.id) : { rootRef: null, refs: new Set<string>() };
      if (!previous && repository.readLatestManualStatus(assignment.id)) return fail('REVISION_CONFLICT', 409);
      assertManualTip(pkg, assignment.id, chain.refs);
      const value = validatedEntity('manual_status_event', { ...entry.header, assignmentId: assignment.id, from: previous?.to ?? null, to: input.targetState, reason: input.reason, resultDescription: input.resultDescription ?? previous?.resultDescription ?? null, evidenceIds: previous?.evidenceIds ?? [] }) as ManualStatusEvent;
      validateManualTransition(previous, value); return write(context, input.draftId, businessDefinition(value), ['manual_status_event'], updated => store.setProof(input.draftId, `manual-transition:${updated.versionRef.revision}`, { previousRef: previous ? input.ref : null, publishedRootRef: chain.rootRef, ...definitions } satisfies ManualProof));
    },
    async archive(context: CommandContext, input: { draftId: string; goalRef: VersionRef; reason: string }, restore = false) {
      const entry = own(context, input.draftId, ['core_goal_definition']);
      if (!input.reason.trim() || input.goalRef.entityType !== 'core_goal_definition' || input.goalRef.id !== entry.entityRef.id) return fail('INVALID_GOAL_TRANSITION');
      resolve(context, input.goalRef); const definition = { ...entry.definition, lifecycle: restore ? 'active' : 'archived', archiveReason: restore ? null : input.reason };
      return write(context, input.draftId, definition, ['core_goal_definition']);
    },
  };
  return service;
}
export type DraftService = ReturnType<typeof createDraftService>;
