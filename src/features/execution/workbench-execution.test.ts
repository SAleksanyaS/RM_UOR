import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import type { Decision, Work, WorkDependency } from '../../domain/workbench/entities';
import { business, draftCleanups, draftFixture } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
import { createExecutionService, projectExecution, registerExecutionCommands } from './workbench-execution';
import { createExecutionStore } from './workbench-execution-store';

afterEach(async () => { while (draftCleanups.length) await draftCleanups.pop()!(); });
function fixture() {
  const f = draftFixture(); const executionStore = createExecutionStore({ repository: f.repository });
  const execution = createExecutionService({ repository: f.repository, drafts: f.service, store: executionStore, clock: f.clock });
  registerExecutionCommands(f.registry, execution);
  const body = (overrides: Partial<Omit<Work, keyof ReturnType<typeof makeHeader>>> = {}) => ({ title: 'Prepare source', goalIds: [f.input.goal.id], responsibility: [{ scope: f.input.assignment.scope, personId: fixtureId(17) }], state: 'planned', dueOn: '2026-10-30', forecastOn: null, nextAction: 'Check the source', reason: null, resultDescription: null, evidenceIds: [], risk: null, blocker: null, ...overrides });
  const work = async (overrides: Parameters<typeof body>[0] = {}) => { const entry = await f.open('work'); await f.execute('work.draft.save', { draftId: entry.draftId, definition: body(overrides) }); return entry; };
  const dependency = async (predecessorWorkId: string, successorWorkId: string) => { const entry = await f.open('work_dependency'); await f.execute('workDependency.draft.save', { draftId: entry.draftId, definition: { predecessorWorkId, successorWorkId, active: true, changeReason: null } }); return entry; };
  const transition = (entry: { draftId: string }, targetState: Work['state'], reason: string | null = null, resultDescription: string | null = null, ref = f.store.getEntry(entry.draftId)!.versionRef) => f.execute('work.transition', { draftId: entry.draftId, ref, targetState, reason, resultDescription });
  const current = (entry: { draftId: string }) => { const value = f.store.getEntry(entry.draftId)!; return { ...value.header, ...value.definition } as Work; };
  return { ...f, execution, executionStore, body, work, dependency, transition, current };
}

it('rejects_cycles_and_cancellation_without_dependency_resolution', async () => {
  const f = fixture(); const a = await f.work(), b = await f.work(); const link = await f.dependency(a.objectId, b.objectId);
  const reverse = await f.open('work_dependency');
  await expect(f.execute('workDependency.draft.save', { draftId: reverse.draftId, definition: { predecessorWorkId: b.objectId, successorWorkId: a.objectId, active: true, changeReason: null } })).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
  await expect(f.transition(a, 'cancelled', 'Cancelled')).rejects.toMatchObject({ code: 'DEPENDENCY_RESOLUTION_REQUIRED' });
  await f.execute('workDependency.draft.save', { draftId: link.draftId, definition: { predecessorWorkId: a.objectId, successorWorkId: b.objectId, active: false, changeReason: 'Replaced by another plan' } });
  await f.transition(a, 'cancelled', 'Cancelled');
  expect(f.current(b).state).toBe('planned'); expect(f.current(b).dueOn).toBe('2026-10-30');
  expect(f.store.history(link.draftId).map(v => v.definition.active)).toEqual([undefined, true, false]);
});

it('reopen_preserves_completion_and_forecast_does_not_shift_due', async () => {
  const f = fixture(); const work = await f.work();
  await expect(f.transition(work, 'completed')).rejects.toMatchObject({ statusCode: 422 });
  await f.transition(work, 'completed', null, 'Source verified'); const completed = f.current(work);
  await expect(f.transition(work, 'in_progress', '')).rejects.toMatchObject({ statusCode: 422 });
  await expect(f.transition(work, 'planned', 'Reset')).rejects.toMatchObject({ code: 'INVALID_WORK_TRANSITION' });
  await f.transition(work, 'in_progress', 'More checks');
  expect(f.current(work)).toMatchObject({ state: 'in_progress', resultDescription: 'Source verified' });
  expect(f.executionStore.completionEvents(f.packageId(), work.objectId)).toHaveLength(1);
  expect(f.store.readDraftVersion(f.packageId(), { entityType: 'work', id: completed.id, revision: completed.revision })).toEqual(completed);
  await f.execute('work.draft.save', { draftId: work.draftId, definition: { ...business(f.current(work)), forecastOn: '2026-11-05', risk: { reason: 'Supplier late', helpNeeded: 'Escalation' } } });
  expect(f.current(work)).toMatchObject({ dueOn: '2026-10-30', forecastOn: '2026-11-05', state: 'in_progress' });
});

it('one_work_links_multiple_goals_without_facts', async () => {
  const f = fixture(); const other = makeNumericFixture({ seedBase: 2000 }); seedGraph(f.repository, makeEntityGraph(other));
  const initial = f.count('observed_fact'); const work = await f.work({ goalIds: [f.input.goal.id, other.goal.id] });
  await f.transition(work, 'completed', null, 'One shared result');
  expect(f.current(work).goalIds).toEqual([f.input.goal.id, other.goal.id]);
  expect(f.count('observed_fact')).toBe(initial); expect(f.count('attestation')).toBe(0); expect(f.count('agreed_snapshot')).toBe(0);
  expect(f.service.validateDraftPackage(f.packageId())).toMatchObject({ complete: true, problems: [] });
});

it('completed_successor_waits_for_every_active_predecessor_and_needs_no_attachment', async () => {
  const f = fixture(); const a = await f.work(), b = await f.work(); await f.dependency(a.objectId, b.objectId);
  await expect(f.transition(b, 'completed', null, 'Too early')).rejects.toMatchObject({ code: 'DEPENDENCY_BLOCKED' });
  await f.transition(a, 'completed', null, 'Done without evidence'); await f.transition(b, 'completed', null, 'Now ready');
  expect(f.current(b)).toMatchObject({ state: 'completed', evidenceIds: [] });
});

it('partial_state_edits_cannot_bypass_strict_reopen_or_pause_rules', async () => {
  const f = fixture(); const work = await f.work(); await f.transition(work, 'completed', null, 'Original');
  await f.execute('work.draft.save', { draftId: work.draftId, definition: { title: 'Still being edited', state: 'in_progress' } });
  await expect(f.execute('work.draft.save', { draftId: work.draftId, definition: f.body({ state: 'in_progress' }) })).rejects.toMatchObject({ code: 'WORK_REASON_REQUIRED' });
  expect(f.executionStore.completionEvents(f.packageId(), work.objectId)).toHaveLength(1);
  await f.execute('work.draft.save', { draftId: work.draftId, definition: f.body({ state: 'in_progress', reason: 'More work', resultDescription: 'Original' }) });
  await expect(f.transition(work, 'paused')).rejects.toMatchObject({ statusCode: 422 });
});

it('decision_answer_time_comes_from_the_server_and_does_not_change_on_noop_or_other_edits', async () => {
  const f = fixture(); const work = await f.work(); const decision = await f.open('decision');
  const definition = { workId: work.objectId, request: 'Choose a supplier', requestedFromPersonId: fixtureId(17), dueOn: '2026-10-30', answer: null, answeredAt: null };
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition });
  expect(f.store.getEntry(decision.draftId)!.definition).toMatchObject({ answer: null, answeredAt: null });
  f.setNow('2026-10-24T10:00:00Z');
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { ...definition, answer: 'Supplier A', answeredAt: '2000-01-01T00:00:00Z' } });
  expect(f.store.getEntry(decision.draftId)!.definition).toMatchObject({ answer: 'Supplier A', answeredAt: '2026-10-24T10:00:00Z' });
  f.setNow('2026-10-25T10:00:00Z');
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { ...f.store.getEntry(decision.draftId)!.definition, request: 'Choose a verified supplier' } });
  expect(f.store.getEntry(decision.draftId)!.definition.answeredAt).toBe('2026-10-24T10:00:00Z');
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { ...definition, answer: 'Supplier B' } });
  expect(f.store.getEntry(decision.draftId)!.definition.answeredAt).toBe('2026-10-25T10:00:00Z');
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition });
  expect(f.store.getEntry(decision.draftId)!.definition.answeredAt).toBeNull();
});

it('partial_decision_stays_partial_and_foreign_or_nonperson_refs_block_readiness', async () => {
  const f = fixture(); const decision = await f.open('decision');
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { request: 'Missing target' } });
  expect(f.store.getEntry(decision.draftId)!.definition).toEqual({ request: 'Missing target' });
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { workId: fixtureId(140000), request: 'Missing target', requestedFromPersonId: fixtureId(17), dueOn: '2026-10-30', answer: null } });
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(false);
  const work = await f.work(); await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { workId: work.objectId, request: 'Wrong kind', requestedFromPersonId: f.input.assignment.scope.id, dueOn: '2026-10-30', answer: null } });
  expect(f.service.validateDraftPackage(f.packageId()).problems).toContainEqual(expect.objectContaining({ code: 'PERSON_REFERENCE_REQUIRED' }));
});

it('pure_projection_shows_the_delayed_chain_and_moscow_overdue_without_rewriting_dates', () => {
  const base = { title: 'Work', goalIds: [fixtureId(11)], responsibility: [], state: 'planned' as const, dueOn: '2026-10-30', forecastOn: '2026-11-05', nextAction: '', reason: null, resultDescription: null, evidenceIds: [], risk: null, blocker: null };
  const works: Work[] = [{ ...makeHeader(140001), ...base, risk: { reason: 'Delayed', helpNeeded: 'Help' } }, { ...makeHeader(140002), ...base }, { ...makeHeader(140003), ...base }];
  const dependencies: WorkDependency[] = [{ ...makeHeader(140004), predecessorWorkId: works[0].id, successorWorkId: works[1].id, active: true, changeReason: null }, { ...makeHeader(140005), predecessorWorkId: works[1].id, successorWorkId: works[2].id, active: true, changeReason: null }];
  const decisions: Decision[] = [{ ...makeHeader(140006), workId: works[0].id, request: 'Decide', requestedFromPersonId: fixtureId(17), dueOn: '2026-10-30', answer: null, answeredAt: null }];
  const before = structuredClone({ works, dependencies, decisions });
  const onTime = projectExecution({ ...before, now: '2026-10-30T20:59:59Z' });
  expect(onTime.decisions[0]).toMatchObject({ overdue: false, status: 'open' });
  const late = projectExecution({ works, dependencies, decisions, now: '2026-10-30T21:00:00Z' });
  expect(late.works[0]).toMatchObject({ overdue: true, affectedWorkIds: [works[1].id, works[2].id], affectedGoalIds: [fixtureId(11)], overdueDecisionIds: [fixtureId(140006)] });
  expect(late.works[2].blockingWorkIds).toEqual([works[1].id]); expect(late.decisions[0].overdue).toBe(true);
  expect({ works, dependencies, decisions }).toEqual(before);
});

it('published_graph_is_authoritative_and_a_new_predecessor_blocks_an_already_prepared_completion', async () => {
  const f = fixture(); const a = await f.work(), b = await f.work(); await f.transition(b, 'completed', null, 'Prepared');
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(true);
  f.repository.transaction(() => {
    for (const entry of [a, b]) { const value = f.current(entry); f.repository.append('work', { ...value, revision: 1, state: 'planned', resultDescription: null, publicationAnchorId: makePublicationAnchor().id }, null); }
    f.repository.append('work_dependency', { ...makeHeader(140011), publicationAnchorId: makePublicationAnchor().id, predecessorWorkId: a.objectId, successorWorkId: b.objectId, active: true, changeReason: null }, null);
  });
  expect(f.service.validateDraftPackage(f.packageId()).problems).toContainEqual(expect.objectContaining({ code: 'DEPENDENCY_BLOCKED' }));
});

it('transitions_keep_atomic_receipts_cas_and_person_ownership', async () => {
  const f = fixture(); const work = await f.work(); const commandId = fixtureId(140020); const token = f.token();
  const payload = { draftId: work.draftId, ref: f.store.getEntry(work.draftId)!.versionRef, targetState: 'completed', reason: null, resultDescription: 'Once' };
  const first = await f.execute('work.transition', payload, { commandId, baseRevision: token });
  expect(await f.execute('work.transition', payload, { commandId, baseRevision: token })).toEqual(first);
  expect(f.executionStore.completionEvents(f.packageId(), work.objectId)).toHaveLength(1);
  await expect(f.execute('work.draft.save', { draftId: work.draftId, definition: f.body() }, { baseRevision: token })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  f.context.ownAccess.personId = fixtureId(140021); f.context.actor.profilePersonId = fixtureId(140021);
  await expect(f.execute('work.transition', payload, { commandId, baseRevision: token })).rejects.toMatchObject({ statusCode: 404 });
  expect(() => f.execution.readForPackage(f.context, f.packageId())).toThrow();
});

it('dependency_endpoint_replacement_requires_a_reason', async () => {
  const f = fixture(); const a = await f.work(), b = await f.work(), c = await f.work(); const link = await f.dependency(a.objectId, b.objectId);
  await expect(f.execute('workDependency.draft.save', { draftId: link.draftId, definition: { predecessorWorkId: c.objectId, successorWorkId: b.objectId, active: true, changeReason: null } })).rejects.toMatchObject({ code: 'DEPENDENCY_CHANGE_REASON_REQUIRED' });
  await f.execute('workDependency.draft.save', { draftId: link.draftId, definition: { predecessorWorkId: c.objectId, successorWorkId: b.objectId, active: true, changeReason: 'New supplier' } });
  await f.transition(a, 'cancelled', 'Replaced'); expect(f.current(b).state).toBe('planned');
});

it('a_cycle_spanning_published_and_private_links_is_rejected_and_partial_removal_keeps_the_public_block', async () => {
  const f = fixture(); const anchor = makePublicationAnchor().id;
  f.repository.transaction(() => {
    for (const seed of [140030, 140031]) f.repository.append('work', { ...makeHeader(seed), ...f.body(), publicationAnchorId: anchor }, null);
    f.repository.append('work_dependency', { ...makeHeader(140032), publicationAnchorId: anchor, predecessorWorkId: fixtureId(140030), successorWorkId: fixtureId(140031), active: true, changeReason: null }, null);
  });
  const a = await f.open('work', { entityType: 'work', id: fixtureId(140030) });
  const reverse = await f.open('work_dependency');
  await expect(f.execute('workDependency.draft.save', { draftId: reverse.draftId, definition: { predecessorWorkId: fixtureId(140031), successorWorkId: a.objectId, active: true, changeReason: null } })).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
  const link = await f.open('work_dependency', { entityType: 'work_dependency', id: fixtureId(140032) });
  await f.execute('workDependency.draft.save', { draftId: link.draftId, definition: { predecessorWorkId: a.objectId, successorWorkId: fixtureId(140031), active: false } });
  await expect(f.transition(a, 'cancelled', 'Still blocking')).rejects.toMatchObject({ code: 'DEPENDENCY_RESOLUTION_REQUIRED' });
  await f.execute('workDependency.draft.save', { draftId: link.draftId, definition: { predecessorWorkId: a.objectId, successorWorkId: fixtureId(140031), active: false, changeReason: 'Explicit resolution' } });
  await f.transition(a, 'cancelled', 'Resolved'); expect(f.current(a).state).toBe('cancelled');
});

it('public_reads_ignore_foreign_private_heads_and_dangling_responsibility_and_self_links_are_not_ready', async () => {
  const f = fixture(); const pub: Work = { ...makeHeader(140040), ...f.body(), state: 'planned', publicationAnchorId: makePublicationAnchor().id } as Work;
  f.repository.append('work', pub, null);
  f.repository.append('work', { ...pub, revision: 2, title: 'FOREIGN PRIVATE', publicationAnchorId: null, actor: { ...pub.actor, profilePersonId: fixtureId(140041) } }, 1);
  expect(f.execution.readPublished().works).toHaveLength(1);
  expect(f.execution.readPublished().works[0].work).toEqual(pub);
  const work = await f.work({ responsibility: [{ scope: f.input.assignment.scope, personId: fixtureId(140041) }] });
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(false);
  const self = await f.open('work_dependency');
  await f.execute('workDependency.draft.save', { draftId: self.draftId, definition: { predecessorWorkId: work.objectId, successorWorkId: work.objectId, active: true, changeReason: null } });
  expect(f.store.getEntry(self.draftId)!.complete).toBe(false); expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(false);
});

it('invalid_atomic_output_rolls_back_both_work_and_completion_audit', async () => {
  const f = fixture(); const work = await f.work();
  const payload = { draftId: work.draftId, ref: f.store.getEntry(work.draftId)!.versionRef, targetState: 'completed' as const, reason: null, resultDescription: 'Must roll back' };
  f.registry.register({ name: 'execution.outputFailure', inputSchema: z.unknown(), outputSchema: z.strictObject({ impossible: z.literal(true) }), capability: 'uor.prepare', ownership: 'person', effect: 'sharedDraft', execution: 'sync', async handler(context) {
    await f.execution.transition(context, payload); return { result: { impossible: true }, changedRefs: [], editToken: null };
  } });
  await expect(f.execute('execution.outputFailure', {})).rejects.toThrow();
  expect(f.current(work).state).toBe('planned'); expect(f.executionStore.completionEvents(f.packageId(), work.objectId)).toEqual([]);
});

it('work_transition_rejects_an_old_local_version_even_with_a_current_package_token', async () => {
  const f = fixture(); const work = await f.work(); const ref = f.store.getEntry(work.draftId)!.versionRef;
  await f.transition(work, 'in_progress');
  await expect(f.transition(work, 'completed', null, 'Stale request', ref)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(f.current(work).state).toBe('in_progress');
});

it('an_incomplete_reserved_predecessor_is_not_treated_as_a_finished_or_missing_dependency', async () => {
  const f = fixture(); const predecessor = await f.open('work'); const successor = await f.work();
  await f.dependency(predecessor.objectId, successor.objectId);
  await expect(f.transition(successor, 'completed', null, 'Not ready')).rejects.toMatchObject({ code: 'DEPENDENCY_BLOCKED' });
  expect(f.executionStore.completionEvents(f.packageId(), successor.objectId)).toEqual([]);
});

it('partial_private_dependency_edits_keep_the_last_frozen_constraint_until_resolved', async () => {
  const f = fixture(); const predecessor = await f.work(), successor = await f.work(); const link = await f.dependency(predecessor.objectId, successor.objectId);
  await f.execute('workDependency.draft.save', { draftId: link.draftId, definition: { active: false } });
  await expect(f.transition(successor, 'completed', null, 'Premature')).rejects.toMatchObject({ code: 'DEPENDENCY_BLOCKED' });
  await expect(f.transition(predecessor, 'cancelled', 'Hidden edge')).rejects.toMatchObject({ code: 'DEPENDENCY_RESOLUTION_REQUIRED' });
  expect(f.executionStore.completionEvents(f.packageId(), successor.objectId)).toEqual([]);
  await f.transition(predecessor, 'completed', null, 'Predecessor done');
  await f.transition(successor, 'completed', null, 'Successor done');
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(false); // partial input still needs completion
  await f.execute('workDependency.draft.save', { draftId: link.draftId, definition: { predecessorWorkId: predecessor.objectId, successorWorkId: successor.objectId, active: false, changeReason: 'Explicitly removed' } });
  expect(f.service.validateDraftPackage(f.packageId())).toMatchObject({ complete: true, problems: [] });
});

it('an_older_published_base_ref_cannot_transition_a_locally_edited_work', async () => {
  const f = fixture(); const published: Work = { ...makeHeader(140050), ...f.body(), state: 'planned', publicationAnchorId: makePublicationAnchor().id } as Work;
  f.repository.append('work', published, null);
  const work = await f.open('work', { entityType: 'work', id: published.id }); const baseRef = { entityType: 'work', id: published.id, revision: 1 };
  await f.transition(work, 'in_progress', null, null, baseRef); // a genuinely untouched clone may use its published source
  const latest = f.current(work); await f.execute('work.draft.save', { draftId: work.draftId, definition: { ...business(latest), forecastOn: '2026-11-06' } });
  await expect(f.transition(work, 'completed', null, 'Stale published source', baseRef)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(f.current(work)).toMatchObject({ state: 'in_progress', forecastOn: '2026-11-06' });
  expect(f.executionStore.completionEvents(f.packageId(), work.objectId)).toEqual([]);
});

it('restoring_an_unchanged_answer_after_partial_form_edit_keeps_its_original_answer_time', async () => {
  const f = fixture(); const work = await f.work(); const decision = await f.open('decision');
  const definition = { workId: work.objectId, request: 'Choose supplier', requestedFromPersonId: fixtureId(17), dueOn: '2026-10-30', answer: 'Supplier A' };
  f.setNow('2026-10-24T10:00:00Z');
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition });
  const first = f.store.getEntry(decision.draftId)!; const original = f.store.readDraftVersion(f.packageId(), first.versionRef);
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { request: 'Request being revised' } });
  f.setNow('2026-10-27T10:00:00Z');
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { ...definition, request: 'Revised request' } });
  expect(f.store.getEntry(decision.draftId)!.definition.answeredAt).toBe('2026-10-24T10:00:00Z');
  expect(f.store.readDraftVersion(f.packageId(), first.versionRef)).toEqual(original);
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { ...definition, answer: null } });
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition });
  expect(f.store.getEntry(decision.draftId)!.definition.answeredAt).toBe('2026-10-27T10:00:00Z'); // explicit reopen/answer is a new event
});

it('partial_answer_history_distinguishes_omission_from_an_explicit_clear_or_changed_answer', async () => {
  const f = fixture(); const work = await f.work(); const decision = await f.open('decision');
  const definition = { workId: work.objectId, request: 'Choose supplier', requestedFromPersonId: fixtureId(17), dueOn: '2026-10-30', answer: 'A' };
  f.setNow('2026-10-24T10:00:00Z'); await f.execute('decision.draft.save', { draftId: decision.draftId, definition });
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { answer: null } });
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { request: 'Editing after clear' } });
  f.setNow('2026-10-25T10:00:00Z'); await f.execute('decision.draft.save', { draftId: decision.draftId, definition });
  expect(f.store.getEntry(decision.draftId)!.definition.answeredAt).toBe('2026-10-25T10:00:00Z');
  f.setNow('2026-10-26T10:00:00Z'); await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { answer: 'B' } });
  await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { request: 'Still editing' } });
  f.setNow('2026-10-27T10:00:00Z'); await f.execute('decision.draft.save', { draftId: decision.draftId, definition: { ...definition, answer: 'B' } });
  expect(f.store.getEntry(decision.draftId)!.definition.answeredAt).toBe('2026-10-26T10:00:00Z');
});

it('goal_archive_does_not_cancel_work_or_erase_completion_history', async () => {
  const f = fixture(); const work = await f.work(); await f.transition(work, 'completed', null, 'Original');
  const goal = await f.open('core_goal_definition', { entityType: 'core_goal_definition', id: f.input.goal.id });
  await f.execute('goal.archive', { draftId: goal.draftId, goalRef: { entityType: 'core_goal_definition', id: f.input.goal.id, revision: 1 }, reason: 'Archived' });
  expect(f.current(work).state).toBe('completed'); expect(f.executionStore.completionEvents(f.packageId(), work.objectId)).toHaveLength(1);
  expect(f.service.validateDraftPackage(f.packageId())).toMatchObject({ complete: true, problems: [] });
});
