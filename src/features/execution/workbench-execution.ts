import { z } from 'zod';
import type { Decision, DirectoryEntity, Work, WorkDependency } from '../../domain/workbench/entities';
import type { EntityRef, Header, UtcInstant, VersionRef } from '../../domain/workbench/primitives';
import { uuidSchema, utcInstantSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { entityReferences, validateReferences } from '../../domain/workbench/schemas';
import { decisionSchema, workDependencySchema, workSchema } from '../../domain/workbench/schemas/states';
import { WorkbenchError } from '../../domain/workbench/errors';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext, CommandOutcome, CommandRegistry } from '../../server/workbench/command-registry';
import { createCommandStore, stableJson } from '../../server/workbench/command-store';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { businessDefinition, draftDefinitionSchema, type DraftOwnerSave, type DraftSaveResult, type DraftService, type PartialDraftInput } from '../catalog/workbench-drafts';
import { draftSaveResultSchema } from '../catalog/workbench-draft-commands';
import type { StoredDraft, StoredPackage } from '../catalog/workbench-draft-store';
import { isDeadlineOverdue } from './workbench-reminders';
import type { ExecutionStore } from './workbench-execution-store';

export type WorkDraftSaveInput = { draftId: string; definition: PartialDraftInput<Work> };
export type WorkDependencyDraftSaveInput = { draftId: string; definition: PartialDraftInput<WorkDependency> };
export type DecisionDraftSaveInput = { draftId: string; definition: PartialDraftInput<Decision> };
export type WorkTransitionInput = { draftId: string; ref: VersionRef; targetState: Work['state']; reason: string | null; resultDescription: string | null };
export type ExecutionGraph = { works: Work[]; dependencies: WorkDependency[]; decisions: Decision[] };
export type ExecutionProjection = {
  works: Array<{ work: Work; overdue: boolean; blockingWorkIds: string[]; affectedWorkIds: string[]; affectedGoalIds: string[]; overdueDecisionIds: string[] }>;
  decisions: Array<{ decision: Decision; status: 'open' | 'answered'; overdue: boolean }>;
};
const fail = (code: string, statusCode = 422): never => { throw new WorkbenchHttpError(statusCode, code, code); };
const full = (entry: StoredDraft) => ({ ...entry.header, ...entry.definition });

function assertAcyclic(dependencies: WorkDependency[]): void {
  const outgoing = new Map<string, string[]>(); const indegree = new Map<string, number>();
  for (const link of dependencies.filter(v => v.active)) {
    if (link.predecessorWorkId === link.successorWorkId) fail('DEPENDENCY_CYCLE');
    const next = outgoing.get(link.predecessorWorkId) ?? []; next.push(link.successorWorkId); outgoing.set(link.predecessorWorkId, next);
    if (!indegree.has(link.predecessorWorkId)) indegree.set(link.predecessorWorkId, 0);
    indegree.set(link.successorWorkId, (indegree.get(link.successorWorkId) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id); let visited = 0;
  for (let index = 0; index < queue.length; index++) { visited++; for (const id of outgoing.get(queue[index]) ?? []) { const count = indegree.get(id)! - 1; indegree.set(id, count); if (!count) queue.push(id); } }
  if (visited !== indegree.size) fail('DEPENDENCY_CYCLE');
}
function validateGraph(graph: ExecutionGraph): void {
  assertAcyclic(graph.dependencies); const works = new Map(graph.works.map(v => [v.id, v]));
  for (const dependency of graph.dependencies) {
    if (!works.has(dependency.predecessorWorkId) || !works.has(dependency.successorWorkId)) fail('REFERENCE_NOT_FOUND');
    if (!dependency.active) continue;
    const previous = works.get(dependency.predecessorWorkId)!, next = works.get(dependency.successorWorkId)!;
    if (previous.state === 'cancelled') fail('DEPENDENCY_RESOLUTION_REQUIRED');
    if (next.state === 'completed' && previous.state !== 'completed') fail('DEPENDENCY_BLOCKED');
  }
  for (const decision of graph.decisions) if (!works.has(decision.workId)) fail('REFERENCE_NOT_FOUND');
}
function validateWorkChange(previous: Work | null, value: Work): void {
  if (previous?.state === 'completed' && value.state !== 'completed') {
    if (value.state !== 'in_progress') fail('INVALID_WORK_TRANSITION');
    if (!value.reason?.trim()) fail('WORK_REASON_REQUIRED');
  }
}

/** Pure read projection. Due dates and manually entered forecasts are never changed. */
export function projectExecution(input: ExecutionGraph & { now: UtcInstant }): ExecutionProjection {
  utcInstantSchema.parse(input.now);
  const works = input.works.map(v => workSchema.parse(v)); const dependencies = input.dependencies.map(v => workDependencySchema.parse(v));
  const decisions = input.decisions.map(v => decisionSchema.parse(v)); assertAcyclic(dependencies);
  const byId = new Map(works.map(work => [work.id, work])); const active = dependencies.filter(v => v.active);
  const decisionViews = decisions.map(decision => ({ decision, status: decision.answer === null ? 'open' as const : 'answered' as const, overdue: decision.answer === null && isDeadlineOverdue(decision.dueOn, input.now) }));
  return { decisions: decisionViews, works: works.map(work => {
    const open = !['completed','cancelled'].includes(work.state); const overdue = open && isDeadlineOverdue(work.dueOn, input.now);
    const overdueDecisionIds = decisionViews.filter(v => v.decision.workId === work.id && v.overdue).map(v => v.decision.id);
    const affectedWorkIds: string[] = []; const seen = new Set([work.id]); const queue = [work.id];
    if (open && (overdue || work.risk || work.blocker || overdueDecisionIds.length)) for (let index = 0; index < queue.length; index++) {
      for (const link of active.filter(v => v.predecessorWorkId === queue[index])) if (!seen.has(link.successorWorkId)) { seen.add(link.successorWorkId); affectedWorkIds.push(link.successorWorkId); queue.push(link.successorWorkId); }
    }
    const affectedGoalIds = [...new Set(affectedWorkIds.flatMap(id => byId.get(id)?.goalIds ?? []))];
    return { work, overdue, blockingWorkIds: active.filter(v => v.successorWorkId === work.id && byId.get(v.predecessorWorkId)?.state !== 'completed').map(v => v.predecessorWorkId), affectedWorkIds, affectedGoalIds, overdueDecisionIds };
  }) };
}

export function createExecutionService({ repository, drafts, store, clock }: { repository: WorkbenchRepository; drafts: DraftService; store: ExecutionStore; clock: CommandContext['clock'] }) {
  const graphFor = (pkg: StoredPackage, replacement?: { type: string; value: Header }): ExecutionGraph => {
    const published = store.readPublishedGraph(); const works = new Map(published.works.map(v => [v.id, v]));
    const dependencies = new Map(published.dependencies.map(v => [v.id, v])); const decisions = new Map(published.decisions.map(v => [v.id, v]));
    const overlay = (type: string, value: unknown) => {
      if (type === 'work') { const parsed = workSchema.safeParse(value); if (parsed.success) works.set(parsed.data.id, parsed.data); }
      if (type === 'work_dependency') { const parsed = workDependencySchema.safeParse(value); if (parsed.success) dependencies.set(parsed.data.id, parsed.data); }
      if (type === 'decision') { const parsed = decisionSchema.safeParse(value); if (parsed.success) decisions.set(parsed.data.id, parsed.data); }
    };
    // A temporarily incomplete form must not erase the last valid own state.
    // Frozen private values have the same fallback lifetime as published values.
    for (const version of drafts.readDraftVersions(pkg.packageId)) overlay(version.entityRef.entityType, version.value);
    for (const entry of pkg.entries as StoredDraft[]) overlay(entry.entityRef.entityType, full(entry));
    if (replacement) overlay(replacement.type, replacement.value);
    return { works: [...works.values()], dependencies: [...dependencies.values()], decisions: [...decisions.values()] };
  };
  const lastFrozen = (entry: StoredDraft): Header | null => drafts.readDraftVersions(entry.packageId).filter(v => v.entityRef.entityType === entry.entityRef.entityType && v.entityRef.id === entry.entityRef.id).at(-1)?.value ?? (entry.baseRef ? repository.readVersion(entry.baseRef) : null);
  const validatePeople = (type: string, value: Work | Decision, resolve: (ref: EntityRef | VersionRef) => Header | null) => {
    const person = (id: string) => { const found = resolve({ entityType: 'directory_entity', id }) as DirectoryEntity | null; if (!found || found.kind !== 'person') fail('PERSON_REFERENCE_REQUIRED'); };
    if (type === 'decision') person((value as Decision).requestedFromPersonId);
    else for (const responsibility of (value as Work).responsibility) {
      person(responsibility.personId); const scope = resolve({ entityType: 'directory_entity', id: responsibility.scope.id }) as DirectoryEntity | null;
      if (!scope || scope.kind !== responsibility.scope.kind) fail('SCOPE_REFERENCE_MISMATCH');
    }
  };
  const checkChange = (entry: StoredDraft, value: Header, previous: Header | null) => {
    if (entry.entityRef.entityType === 'work') validateWorkChange(previous as Work | null, value as Work);
    if (entry.entityRef.entityType === 'work_dependency' && previous) {
      const before = previous as WorkDependency, after = value as WorkDependency;
      if ((before.active !== after.active || before.predecessorWorkId !== after.predecessorWorkId || before.successorWorkId !== after.successorWorkId) && !after.changeReason?.trim()) fail('DEPENDENCY_CHANGE_REASON_REQUIRED');
    }
  };
  const validateSave = ({ context, entry, definition, previous }: DraftOwnerSave) => {
    const type = entry.entityRef.entityType;
    const parsed = (type === 'work' ? workSchema : type === 'work_dependency' ? workDependencySchema : decisionSchema).safeParse({ ...entry.header, ...definition });
    if (!parsed.success) return; // incomplete inputs stay forms, never a valid package
    checkChange(entry, parsed.data, previous);
    const pkg = drafts.readOwnPackage(context, entry.packageId); const graph = graphFor(pkg, { type, value: parsed.data });
    if (type === 'work') {
      const work = parsed.data as Work;
      if (work.state === 'cancelled' && graph.dependencies.some(link => link.active && link.predecessorWorkId === work.id)) fail('DEPENDENCY_RESOLUTION_REQUIRED');
      if (work.state === 'completed' && graph.dependencies.some(link => link.active && link.successorWorkId === work.id && graph.works.find(candidate => candidate.id === link.predecessorWorkId)?.state !== 'completed')) fail('DEPENDENCY_BLOCKED');
    }
    // Unknown form refs are reported by package validation; a complete known graph
    // must already obey strict state and dependency rules before any mutation.
    assertAcyclic(graph.dependencies);
    const known = new Set(graph.works.map(v => v.id));
    validateGraph({ ...graph, dependencies: graph.dependencies.filter(v => known.has(v.predecessorWorkId) && known.has(v.successorWorkId)), decisions: graph.decisions.filter(v => known.has(v.workId)) });
    if (type === 'work' && (parsed.data as Work).state === 'completed') {
      const resolve = (ref: EntityRef | VersionRef) => drafts.resolveOwnReference(context, pkg.packageId, ref);
      validateReferences(entityReferences('work', parsed.data as Work), resolve); validatePeople(type, parsed.data as Work, resolve);
    }
  };
  drafts.registerOwnerPolicy(['work','work_dependency','decision'], {
    validateSave,
    afterSave({ entry, previous }) {
      if (entry.entityRef.entityType !== 'work') return;
      const parsed = workSchema.safeParse(full(entry));
      if (parsed.success && parsed.data.state === 'completed' && (previous as Work | null)?.state !== 'completed') store.recordCompletion(entry.packageId, parsed.data);
    },
    validatePackage({ context, entry, value, previous, resolve }) {
      checkChange(entry, value, previous);
      if (entry.entityRef.entityType !== 'work_dependency') validatePeople(entry.entityRef.entityType, value as Work | Decision, resolve);
      validateGraph(graphFor(drafts.readOwnPackage(context, entry.packageId)));
    },
  });
  return {
    async saveWork(context: CommandContext, input: WorkDraftSaveInput): Promise<DraftSaveResult> { return drafts.saveDefinition(context, input, ['work']); },
    async saveDependency(context: CommandContext, input: WorkDependencyDraftSaveInput): Promise<DraftSaveResult> { return drafts.saveDefinition(context, input, ['work_dependency']); },
    async saveDecision(context: CommandContext, input: DecisionDraftSaveInput): Promise<DraftSaveResult> {
      const entry = drafts.readOwnEntry(context, input.draftId, ['decision']); const definition = { ...input.definition };
      if (definition.answer !== undefined) {
        const current = drafts.readOwnFormHistory(context, input.draftId).slice().reverse().find(version => Object.hasOwn(version.definition, 'answer'))?.definition ?? {};
        definition.answeredAt = definition.answer === null ? null : current.answer === definition.answer && typeof current.answeredAt === 'string' ? current.answeredAt : clock.now();
      } else if (definition.answeredAt !== undefined && definition.answeredAt !== null) fail('ANSWER_TIME_SERVER_OWNED');
      return drafts.saveDefinition(context, { draftId: input.draftId, definition }, ['decision']);
    },
    async transition(context: CommandContext, input: WorkTransitionInput): Promise<DraftSaveResult> {
      const entry = drafts.readOwnEntry(context, input.draftId, ['work']);
      if (input.ref.entityType !== 'work' || input.ref.id !== entry.entityRef.id) fail('WORK_REFERENCE_MISMATCH');
      const previous = lastFrozen(entry) as Work | null; if (!previous) fail('DRAFT_REFERENCE_INCOMPLETE');
      const isCurrent = input.ref.revision === entry.header.revision;
      const base = entry.baseRef ? repository.readVersion<Work>(entry.baseRef) : null;
      const isUneditedBase = base && input.ref.revision === entry.baseRef?.revision && entry.header.revision === base.revision + 1 && stableJson(businessDefinition(base)) === stableJson(entry.definition);
      if (!isCurrent && !isUneditedBase) fail('REVISION_CONFLICT', 409);
      if (entry.baseRef && repository.readPublishedHead(entry.entityRef)?.revision !== entry.baseRef.revision) fail('REVISION_CONFLICT', 409);
      const value = workSchema.safeParse({ ...entry.header, ...entry.definition, state: input.targetState, reason: input.reason, resultDescription: input.resultDescription ?? previous!.resultDescription });
      if (!value.success) return fail('INVALID_WORK_TRANSITION');
      return drafts.saveDefinition(context, { draftId: input.draftId, definition: businessDefinition(value.data) }, ['work']);
    },
    readForPackage(context: CommandContext, packageId: string): ExecutionProjection { return projectExecution({ ...graphFor(drafts.readOwnPackage(context, packageId)), now: clock.now() }); },
    readPublished(): ExecutionProjection { return projectExecution({ ...store.readPublishedGraph(), now: clock.now() }); },
  };
}
export type ExecutionService = ReturnType<typeof createExecutionService>;

export function registerExecutionCommands(registry: CommandRegistry, service: ExecutionService): void {
  const bind = <I>(name: string, schema: z.ZodType<I>, action: (context: CommandContext, input: I) => Promise<DraftSaveResult>) => registry.register({
    name, inputSchema: schema, outputSchema: draftSaveResultSchema, capability: 'uor.prepare', ownership: 'person', effect: 'sharedDraft', execution: 'sync',
    async handler(context, input) {
      try { await action(context, input); } catch (error) { if (error instanceof WorkbenchError) throw new WorkbenchHttpError(error.code === 'REFERENCE_NOT_FOUND' ? 404 : error.code === 'REVISION_CONFLICT' ? 409 : 422, error.code, error.code); throw error; }
      const receipt = createCommandStore(context.repository).get(context.installationId, context.commandId)?.receipt_json;
      if (!receipt) throw Error('Execution effect did not commit its receipt'); return JSON.parse(receipt) as CommandOutcome<DraftSaveResult>;
    },
  });
  bind('work.draft.save', z.strictObject({ draftId: uuidSchema, definition: draftDefinitionSchema('work') }), (context, input) => service.saveWork(context, input as WorkDraftSaveInput));
  bind('workDependency.draft.save', z.strictObject({ draftId: uuidSchema, definition: draftDefinitionSchema('work_dependency') }), (context, input) => service.saveDependency(context, input as WorkDependencyDraftSaveInput));
  bind('decision.draft.save', z.strictObject({ draftId: uuidSchema, definition: draftDefinitionSchema('decision') }), (context, input) => service.saveDecision(context, input as DecisionDraftSaveInput));
  bind('work.transition', z.strictObject({ draftId: uuidSchema, ref: versionRefSchema.refine(ref => ref.entityType === 'work'), targetState: z.enum(['planned','in_progress','paused','completed','cancelled']), reason: z.string().trim().min(1).nullable(), resultDescription: z.string().trim().min(1).nullable() }), service.transition);
}
