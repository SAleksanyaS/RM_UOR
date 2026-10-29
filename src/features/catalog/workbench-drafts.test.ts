import { afterEach, expect, it } from 'vitest';
import type { CalculationResult, DirectoryEntity, DirectoryLink, ManualStatusEvent } from '../../domain/workbench/entities';
import { fixtureId, makeHeader, makePublicationAnchor } from '../../../tests/fixtures/workbench/factories';
import { business, draftCleanups, draftFixture } from '../../../tests/fixtures/workbench/drafts';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { createDraftStore } from './workbench-draft-store';

afterEach(async () => { while (draftCleanups.length) await draftCleanups.pop()!(); });

it('reserves_source_goal_refs_and_keeps_partial_form_without_headers_or_activation', async () => {
  const f = draftFixture(); const goal = await f.open('core_goal_definition'); const source = await f.open('source_definition');
  const saved = await f.execute('goal.draft.save', { draftId: goal.draftId, definition: { title: 'New goal', sourceId: source.objectId } });
  expect(saved.result).toMatchObject({ complete: false, entityRef: goal.entityRef });
  expect((saved.result as any).problems).toContainEqual(expect.objectContaining({ path: '/mode' }));
  const entry = f.service.readDraftPackage(f.packageId()).entries.find(e => e.draftId === goal.draftId)!;
  expect(entry.definition).toEqual({ title: 'New goal', sourceId: source.objectId });
  expect(f.repository.getHead(goal.entityRef)).toBeNull(); expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(false);
  for (const definition of [{ actor: f.context.actor }, { title: 42 }, { lifecycle: 'garbage' }, { mode: null }, { unexpected: true }]) {
    await expect(f.execute('goal.draft.save', { draftId: goal.draftId, definition })).rejects.toMatchObject({ statusCode: 422 });
  }
  expect(f.service.readDraftPackage(f.packageId()).entries.find(e => e.draftId === goal.draftId)!.definition).toEqual(entry.definition);
});

it('partial_nested_values_are_strict_and_missing_is_distinct_from_null', async () => {
  const f = draftFixture(); const draft = await f.open('goal_assignment');
  await f.execute('assignment.draft.save', { draftId: draft.draftId, definition: { scope: { kind: 'team' }, officialDueOn: null } });
  expect(f.service.readDraftPackage(f.packageId()).entries[0].definition).toEqual({ scope: { kind: 'team' }, officialDueOn: null });
  await expect(f.execute('assignment.draft.save', { draftId: draft.draftId, definition: { scope: { kind: 'space' } } })).rejects.toMatchObject({ statusCode: 422 });
  await f.execute('assignment.draft.save', { draftId: draft.draftId, definition: {} });
  expect(f.service.readDraftPackage(f.packageId()).entries[0].definition).toEqual({});
});

it('stale_edit_token_keeps_prior_input_and_foreign_owner_cannot_open_or_save', async () => {
  const f = draftFixture(); const draft = await f.open('core_goal_definition'); const old = f.token();
  await f.execute('goal.draft.save', { draftId: draft.draftId, definition: { title: 'Kept' } });
  await expect(f.execute('goal.draft.save', { draftId: draft.draftId, definition: { title: 'Lost' } }, { baseRevision: old })).rejects.toMatchObject({ statusCode: 409, code: 'REVISION_CONFLICT' });
  f.context.ownAccess.personId = fixtureId(777); f.context.actor.profilePersonId = fixtureId(777);
  await expect(f.execute('goal.draft.save', { draftId: draft.draftId, definition: {} })).rejects.toMatchObject({ statusCode: 404 });
  await expect(f.execute('draft.open', { entityType: 'core_goal_definition', ref: null, packageId: f.packageId() })).rejects.toMatchObject({ statusCode: 404 });
  expect(f.service.readDraftPackage(f.packageId()).entries[0].definition.title).toBe('Kept');
});

it('saves_durable_atomic_receipts_and_reservations_across_new_connections', async () => {
  const f = draftFixture(); const commandId = fixtureId(120001);
  const first = await f.execute('draft.open', { entityType: 'core_goal_definition', ref: null, packageId: null }, { commandId, baseRevision: null });
  const again = await f.execute('draft.open', { entityType: 'core_goal_definition', ref: null, packageId: null }, { commandId, baseRevision: null });
  expect(again).toEqual(first);
  const reopened = createWorkbenchRepository(f.config);
  try { const persisted = createDraftStore({ repository: reopened, artifactDirectory: f.store.artifactDirectory }); expect(persisted.getEntry((first.result as any).draftId)?.entityRef).toEqual((first.result as any).entityRef); }
  finally { reopened.close(); }
});

it('completed_cross_linked_manual_package_validates_and_prepares_without_public_activation', async () => {
  const f = draftFixture(); const goal = await f.open('core_goal_definition'); const source = await f.open('source_definition');
  const method = await f.open('method_version'); const assignment = await f.open('goal_assignment');
  await f.execute('goal.draft.save', { draftId: goal.draftId, definition: { ...business(f.input.goal), mode: 'manual_status', sourceId: source.objectId } });
  await f.execute('source.draft.save', { draftId: source.draftId, definition: { goalId: goal.objectId, kind: 'manual_status', mappingRef: null, publicLocator: null } });
  await f.execute('method.draft.save', { draftId: method.draftId, definition: { mode: 'manual_status' } });
  await f.execute('assignment.draft.save', { draftId: assignment.draftId, definition: { goalId: goal.objectId, scope: f.input.assignment.scope, methodBinding: { kind: 'standalone', methodRef: { ...method.entityRef, revision: 1 } }, officialDueOn: null, expectedPopulation: null } });
  expect(f.service.validateDraftPackage(f.packageId())).toMatchObject({ complete: true, problems: [] });
  const ready = await f.execute('calculation.prepare', { assignmentRef: { ...assignment.entityRef, revision: 1 }, businessTime: f.input.context.businessTime });
  expect(ready.result).toMatchObject({ resultRef: null }); expect(f.repository.getHead(assignment.entityRef)).toBeNull();
});

it('comment_and_snapshot_never_create_attestation_or_source_observations', async () => {
  const f = draftFixture(); const ready = await f.prepare(); expect(await f.prepare()).toEqual(ready);
  const comment = await f.open('commentary'); await f.execute('comment.draft.save', { draftId: comment.draftId, targetRef: { entityType: 'core_goal_definition', id: f.input.goal.id }, text: 'Checked' });
  const snapshot = await f.open('agreed_snapshot');
  await f.execute('snapshot.save', { draftId: snapshot.draftId, ...ready, manualStatusRef: null, attestationRef: null });
  expect(f.count('attestation')).toBe(0); expect(f.count('capture')).toBe(0); expect(f.count('observed_fact')).toBe(0);
  expect(f.service.readDraftPackage(f.packageId()).entries.find(e => e.draftId === snapshot.draftId)?.definition).toMatchObject({ basisRef: ready.basisRef, numericResult: { achievement: 'met' }, manualStatusRef: null, attestationRef: null });
});

it('confirmation_requires_exact_current_confirmable_basis_and_explicit_comment', async () => {
  const f = draftFixture(); const ready = await f.prepare(); const draft = await f.open('attestation');
  await expect(f.execute('result.confirm', { draftId: draft.draftId, resultRef: ready.resultRef, comment: '', evidenceIds: [] })).rejects.toMatchObject({ statusCode: 422 });
  await f.execute('result.confirm', { draftId: draft.draftId, resultRef: ready.resultRef, comment: 'Reviewed', evidenceIds: [] });
  expect(f.count('attestation')).toBe(0);
  const oldResult = f.repository.readVersion<CalculationResult>(ready.resultRef)!;
  const changed = { ...f.input.facts[0], revision: 2, value: '93' };
  f.repository.append('observed_fact', changed, 1);
  await expect(f.execute('result.confirm', { draftId: draft.draftId, resultRef: ready.resultRef, comment: 'Stale', evidenceIds: [] })).rejects.toMatchObject({ code: 'BASIS_NOT_CONFIRMABLE' });
  expect(f.repository.readVersion(ready.resultRef)).toEqual(oldResult);
});

it('confirmation_rechecks_freshness_even_when_cached_semantic_basis_and_result_are_reused', async () => {
  const f = draftFixture(); const ready = await f.prepare(); const draft = await f.open('attestation');
  f.setNow('2027-01-01T09:00:00Z');
  expect(await f.prepare()).toEqual(ready);
  await expect(f.execute('result.confirm', { draftId: draft.draftId, resultRef: ready.resultRef, comment: 'Too old', evidenceIds: [] })).rejects.toMatchObject({ code: 'BASIS_NOT_CONFIRMABLE' });
});

it('own_complete_definitions_get_immutable_versions_and_calculation_does_not_require_unrelated_forms', async () => {
  const f = draftFixture(); const goal = await f.open('core_goal_definition', { entityType: 'core_goal_definition', id: f.input.goal.id });
  const assignment = await f.open('goal_assignment', { entityType: 'goal_assignment', id: f.input.assignment.id });
  const assignmentRef = { ...assignment.entityRef, revision: f.store.getEntry(assignment.draftId)!.header.revision };
  const first = (await f.execute('calculation.prepare', { assignmentRef, businessTime: f.input.context.businessTime })).result as any;
  const frozen = f.store.readDerived(first.basisRef)!.value;
  expect(f.repository.readVersion(first.basisRef)).toBeNull();
  await f.execute('goal.draft.save', { draftId: goal.draftId, definition: { ...business(f.input.goal), description: 'Changed locally' } });
  await f.open('commentary'); // unrelated incomplete form must not block this valid assignment
  const second = (await f.execute('calculation.prepare', { assignmentRef, businessTime: f.input.context.businessTime })).result as any;
  expect(second.basisRef).not.toEqual(first.basisRef); expect(f.store.readDerived(first.basisRef)!.value).toEqual(frozen);
  expect(f.repository.readPublishedHead(goal.entityRef)).toEqual(f.input.goal);
  const snapshot = await f.open('agreed_snapshot');
  await f.execute('snapshot.save', { draftId: snapshot.draftId, ...second, manualStatusRef: null, attestationRef: null });
  expect(f.store.getEntry(snapshot.draftId)?.complete).toBe(true);
});

it('snapshot_refuses_a_stale_semantic_basis_even_if_the_old_result_matches_it', async () => {
  const f = draftFixture(); const ready = await f.prepare(); const draft = await f.open('agreed_snapshot');
  f.repository.append('observed_fact', { ...f.input.facts[0], revision: 2, value: '99' }, 1);
  await expect(f.execute('snapshot.save', { draftId: draft.draftId, ...ready, manualStatusRef: null, attestationRef: null })).rejects.toMatchObject({ code: 'BASIS_MISMATCH' });
});

it('wrong_owner_command_and_foreign_private_sources_cannot_bypass_definition_or_confirmation_guards', async () => {
  const f = draftFixture(); const draft = await f.open('source_definition');
  await expect(f.execute('goal.draft.save', { draftId: draft.draftId, definition: {} })).rejects.toMatchObject({ code: 'DRAFT_TYPE_MISMATCH' });
  f.repository.transaction(() => {
    const capture = f.input.captures[0];
    f.repository.append('capture', { ...capture, id: fixtureId(120080), operationId: fixtureId(120081), publicationAnchorId: null, actor: { ...capture.actor, profilePersonId: fixtureId(888) } }, null);
    f.repository.append('observed_fact', { ...f.input.facts[0], revision: 2, captureId: fixtureId(120080), value: '999', publicationAnchorId: null, actor: { ...capture.actor, profilePersonId: fixtureId(888) }, lineage: { ...f.input.facts[0].lineage, captureId: fixtureId(120080) } }, 1);
  });
  const ready = await f.prepare(); const result = f.repository.readVersion<CalculationResult>(ready.resultRef)!;
  const basis = f.repository.readVersion<any>(result.basisRef)!;
  expect(basis.factRefs).toEqual([{ entityType: 'observed_fact', id: f.input.facts[0].id, revision: 1 }]);
});

it('incomplete_latest_import_blocks_confirmation_of_retained_old_complete_facts', async () => {
  const f = draftFixture(); const ready = await f.prepare(); const draft = await f.open('attestation'); f.setIncompleteAttempt(true);
  await expect(f.execute('result.confirm', { draftId: draft.draftId, resultRef: ready.resultRef, comment: 'Incomplete source', evidenceIds: [] })).rejects.toMatchObject({ code: 'BASIS_NOT_CONFIRMABLE' });
});

it('snapshot_rejects_mismatched_result_manual_branch_and_attestation_digest', async () => {
  const f = draftFixture(); const ready = await f.prepare(); const draft = await f.open('agreed_snapshot');
  await expect(f.execute('snapshot.save', { draftId: draft.draftId, ...ready, manualStatusRef: { entityType: 'manual_status_event', id: fixtureId(99), revision: 1 }, attestationRef: null })).rejects.toMatchObject({ statusCode: 422 });
  const other = { ...f.input.facts[0], revision: 2, value: '94' }; f.repository.append('observed_fact', other, 1); const newer = await f.prepare();
  await expect(f.execute('snapshot.save', { draftId: draft.draftId, basisRef: ready.basisRef, resultRef: newer.resultRef, manualStatusRef: null, attestationRef: null })).rejects.toMatchObject({ code: 'BASIS_MISMATCH' });
});

it('source_correction_requires_originals_and_reason_and_only_changes_a_proposal', async () => {
  const f = draftFixture(); const correction = await f.open('manual_correction'); const original = f.input.facts[0];
  const input = { draftId: correction.draftId, factKey: original.factKey, originalFactRefs: [{ entityType: 'observed_fact', id: original.id, revision: original.revision }], replacement: '97', reason: 'Verified source issue' };
  await f.execute('fact.correct', input); expect(f.repository.getHead({ entityType: 'observed_fact', id: original.id })).toEqual(original); expect(f.count('manual_correction')).toBe(0);
  await expect(f.execute('fact.correct', { ...input, factKey: 'other' })).rejects.toMatchObject({ code: 'CORRECTION_ORIGINAL_MISMATCH' });
  await expect(f.execute('fact.correct', { ...input, reason: '' })).rejects.toMatchObject({ statusCode: 422 });
});

it('manual_reopen_retains_completion_and_requires_result_and_reason', async () => {
  const f = draftFixture(); const graphHeader = { publicationAnchorId: makePublicationAnchor().id };
  f.repository.transaction(() => {
    f.repository.append('core_goal_definition', { ...f.input.goal, revision: 2, mode: 'manual_status' }, 1);
    f.repository.append('source_definition', { ...makeHeader(12, graphHeader), goalId: f.input.goal.id, kind: 'manual_status', mappingRef: null, publicLocator: null, revision: 2 }, 1);
    f.repository.append('method_version', { ...makeHeader(14, graphHeader), mode: 'manual_status', revision: 2 }, 1);
    f.repository.append('goal_assignment', { ...f.input.assignment, revision: 2, expectedPopulation: null, methodBinding: { kind: 'standalone', methodRef: { entityType: 'method_version', id: f.input.method.id, revision: 2 } } }, 1);
  });
  const draft = await f.open('manual_status_event'); const assignmentRef = { entityType: 'goal_assignment', id: f.input.assignment.id, revision: 2 };
  await expect(f.execute('manualGoal.transition', { draftId: draft.draftId, ref: assignmentRef, targetState: 'completed', reason: null, resultDescription: null })).rejects.toMatchObject({ statusCode: 422 });
  await f.execute('manualGoal.transition', { draftId: draft.draftId, ref: assignmentRef, targetState: 'completed', reason: null, resultDescription: 'Original completion' });
  const completed = f.store.getEntry(draft.draftId)!; const completedValue: ManualStatusEvent = { ...completed.header, ...completed.definition } as ManualStatusEvent;
  const published = { ...completedValue, publicationAnchorId: makePublicationAnchor().id }; f.repository.append('manual_status_event', published, null);
  const reopened = await f.open('manual_status_event'); const ref = { entityType: 'manual_status_event', id: completedValue.id, revision: completedValue.revision };
  await expect(f.execute('manualGoal.transition', { draftId: reopened.draftId, ref, targetState: 'in_progress', reason: '', resultDescription: null })).rejects.toMatchObject({ statusCode: 422 });
  await f.execute('manualGoal.transition', { draftId: reopened.draftId, ref, targetState: 'in_progress', reason: 'More work', resultDescription: null });
  expect(f.store.getEntry(reopened.draftId)?.definition).toMatchObject({ from: 'completed', to: 'in_progress', resultDescription: 'Original completion', reason: 'More work' });
  expect(f.repository.readVersion(ref)).toMatchObject({ to: 'completed', resultDescription: 'Original completion' });
});

it('archive_and_restore_create_local_revisions_without_changing_goal_or_history', async () => {
  const f = draftFixture(); const draft = await f.open('core_goal_definition', { entityType: 'core_goal_definition', id: f.input.goal.id });
  const goalRef = { entityType: 'core_goal_definition', id: f.input.goal.id, revision: 1 };
  await f.execute('goal.archive', { draftId: draft.draftId, goalRef, reason: 'Paused direction' });
  expect(f.store.getEntry(draft.draftId)?.definition).toMatchObject({ lifecycle: 'archived', archiveReason: 'Paused direction' });
  await f.execute('goal.restore', { draftId: draft.draftId, goalRef, reason: 'Reopened direction' });
  expect(f.store.history(draft.draftId).map(e => e.definition.lifecycle)).toEqual(expect.arrayContaining(['archived', 'active']));
  expect(f.repository.readVersion(goalRef)).toEqual(f.input.goal);
});

it('archive_preserves_the_current_partial_form_instead_of_resetting_it_to_published_content', async () => {
  const f = draftFixture(); const draft = await f.open('core_goal_definition', { entityType: 'core_goal_definition', id: f.input.goal.id });
  await f.execute('goal.draft.save', { draftId: draft.draftId, definition: { title: 'Unsaved direction edits', description: 'Keep this text' } });
  await f.execute('goal.archive', { draftId: draft.draftId, goalRef: { entityType: 'core_goal_definition', id: f.input.goal.id, revision: 1 }, reason: 'Archive' });
  expect(f.store.getEntry(draft.draftId)?.definition).toEqual({ title: 'Unsaved direction edits', description: 'Keep this text', lifecycle: 'archived', archiveReason: 'Archive' });
});

it('a_stale_manual_state_cannot_branch_from_an_older_published_event_or_restart_at_null', async () => {
  const f = draftFixture(); const anchor = makePublicationAnchor().id;
  f.repository.transaction(() => {
    f.repository.append('core_goal_definition', { ...f.input.goal, revision: 2, mode: 'manual_status' }, 1);
    f.repository.append('source_definition', { ...makeHeader(12), publicationAnchorId: anchor, goalId: f.input.goal.id, kind: 'manual_status', mappingRef: null, publicLocator: null, revision: 2 }, 1);
    f.repository.append('method_version', { ...makeHeader(14), publicationAnchorId: anchor, mode: 'manual_status', revision: 2 }, 1);
    f.repository.append('goal_assignment', { ...f.input.assignment, revision: 2, expectedPopulation: null, methodBinding: { kind: 'standalone', methodRef: { entityType: 'method_version', id: f.input.method.id, revision: 2 } } }, 1);
    f.repository.append('manual_status_event', { ...makeHeader(120150), publicationAnchorId: anchor, assignmentId: f.input.assignment.id, from: null, to: 'completed', resultDescription: 'Original', reason: null, evidenceIds: [] }, null);
    f.repository.append('manual_status_event', { ...makeHeader(120151), recordedAt: '2026-10-23T11:00:00Z', publicationAnchorId: anchor, assignmentId: f.input.assignment.id, from: 'completed', to: 'in_progress', resultDescription: 'Original', reason: 'Reopened', evidenceIds: [] }, null);
  });
  const draft = await f.open('manual_status_event');
  for (const ref of [{ entityType: 'manual_status_event', id: fixtureId(120150), revision: 1 }, { entityType: 'goal_assignment', id: f.input.assignment.id, revision: 2 }]) {
    await expect(f.execute('manualGoal.transition', { draftId: draft.draftId, ref, targetState: 'completed', reason: null, resultDescription: 'Wrong branch' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  }
});

it('package_validation_rejects_a_prepared_confirmation_after_current_facts_change', async () => {
  const f = draftFixture(); const ready = await f.prepare(); const draft = await f.open('attestation');
  await f.execute('result.confirm', { draftId: draft.draftId, resultRef: ready.resultRef, comment: 'Reviewed', evidenceIds: [] });
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(true);
  f.repository.append('observed_fact', { ...f.input.facts[0], revision: 2, value: '97' }, 1);
  expect(f.service.validateDraftPackage(f.packageId())).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'BASIS_NOT_CONFIRMABLE' })]) });
});

it('new_team_proposals_are_saved_atomically_with_stable_reserved_ids_until_explicit_completion', async () => {
  const f = draftFixture(); const h = { publicationAnchorId: makePublicationAnchor().id };
  const dit: DirectoryEntity = { ...makeHeader(100, h), kind: 'dit', name: 'DIT', externalKeys: [] };
  const cluster: DirectoryEntity = { ...makeHeader(103, h), kind: 'cluster', name: 'Cluster', externalKeys: [] };
  const ref = (id: string) => ({ entityType: 'directory_entity', id });
  const links: DirectoryLink[] = [
    { ...makeHeader(110, h), kind: 'dit_cluster', from: ref(dit.id), to: ref(cluster.id) },
    { ...makeHeader(111, h), kind: 'cluster_product', from: ref(cluster.id), to: ref(f.input.assignment.scope.id) },
    { ...makeHeader(112, h), kind: 'leader', scope: { kind: 'cluster', id: cluster.id }, personId: fixtureId(17) },
    { ...makeHeader(113, h), kind: 'leader', scope: f.input.assignment.scope, personId: fixtureId(17) },
  ];
  const assignment = { ...f.input.assignment, id: fixtureId(760), scope: { kind: 'cluster' as const, id: cluster.id } };
  const template = { ...makeHeader(730, h), name: 'Explicit team default', methodRef: { entityType: 'method_version', id: f.input.method.id, revision: 1 } };
  f.repository.transaction(() => { f.repository.append('directory_entity', dit, null); f.repository.append('directory_entity', cluster, null); for (const link of links) f.repository.append('directory_link', link, null); f.repository.append('goal_assignment', assignment, null); f.repository.append('template', template, null); });
  const entityRefs = [dit.id, cluster.id, f.input.assignment.scope.id, fixtureId(17)].map(id => ({ entityType: 'directory_entity', id, revision: 1 }));
  f.setInventories({ entityRefs, linkRefs: links.map(link => ({ entityType: 'directory_link', id: link.id, revision: 1 })) }, [assignment], [template]);
  const team = await f.open('directory_entity');
  await f.execute('organization.draft.save', { draftId: team.draftId, definition: { kind: 'team', name: 'New team', externalKeys: [] } });
  const input = { teamDraftId: team.draftId, clusterRef: ref(cluster.id), teamTemplateBindings: [{ goalId: f.input.goal.id, templateId: template.id }] };
  const token = f.token(); const commandId = fixtureId(120100);
  const proposed = await f.execute('organization.team.propose', input, { commandId, baseRevision: token });
  expect(await f.execute('organization.team.propose', input, { commandId, baseRevision: token })).toEqual(proposed);
  const pkg = f.service.readDraftPackage(f.packageId()); expect(pkg.entries).toHaveLength(3);
  const newAssignment = pkg.entries.find(entry => entry.entityRef.entityType === 'goal_assignment')!;
  expect(newAssignment.definition).toMatchObject({ methodBinding: { kind: 'template', templateId: template.id }, expectedPopulation: null });
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(false);
  await f.execute('assignment.draft.save', { draftId: newAssignment.draftId, definition: { ...newAssignment.definition, expectedPopulation: [{ kind: 'team', id: team.objectId }] } });
  expect(f.service.validateDraftPackage(f.packageId())).toMatchObject({ complete: true, problems: [] });
  expect(f.repository.readPublishedHead(newAssignment.entityRef)).toBeNull(); expect(f.repository.readVersion({ entityType: 'goal_assignment', id: assignment.id, revision: 1 })).toEqual(assignment);
});

it('metric_definitions_have_a_strict_owner_command_and_missing_org_inventory_blocks_publication', async () => {
  const f = draftFixture(); const metric = await f.open('metric_definition');
  await f.execute('metric.draft.save', { draftId: metric.draftId, definition: { name: 'Metric', domain: 'nonnegative_decimal', unit: { code: 'count', label: 'Count' } } });
  const team = await f.open('directory_entity'); await f.execute('organization.draft.save', { draftId: team.draftId, definition: { kind: 'team', name: 'No trusted parent graph', externalKeys: [] } });
  expect(f.service.validateDraftPackage(f.packageId())).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'DIRECTORY_INVENTORY_REQUIRED' })]) });
});

it('package_validation_checks_assignment_method_mode_and_snapshot_assignment_revision', async () => {
  const f = draftFixture(); const method = await f.open('method_version'); await f.execute('method.draft.save', { draftId: method.draftId, definition: { mode: 'manual_status' } });
  const assignment = await f.open('goal_assignment');
  await f.execute('assignment.draft.save', { draftId: assignment.draftId, definition: { ...business(f.input.assignment), methodBinding: { kind: 'standalone', methodRef: { ...method.entityRef, revision: 1 } } } });
  expect(f.service.validateDraftPackage(f.packageId())).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'METHOD_MODE_MISMATCH' })]) });
  const ready = await f.prepare(); const snapshot = await f.open('agreed_snapshot');
  f.repository.append('goal_assignment', { ...f.input.assignment, revision: 2, officialDueOn: '2026-12-31' }, 1);
  await expect(f.execute('snapshot.save', { draftId: snapshot.draftId, ...ready, manualStatusRef: null, attestationRef: null })).rejects.toMatchObject({ code: 'BASIS_MISMATCH' });
});

it('confirmation_and_snapshot_require_explicit_commands_and_immutable_server_proofs', async () => {
  const f = draftFixture(); const ready = await f.prepare(); const draft = await f.open('attestation');
  const result = f.repository.readVersion<CalculationResult>(ready.resultRef)!; const basis = f.repository.readVersion<any>(ready.basisRef)!;
  f.repository.append('attestation', { ...makeHeader(120180), publicationAnchorId: makePublicationAnchor().id, basisDigest: basis.digest, comment: 'Existing official review', evidenceIds: [] }, null);
  const cloned = await f.open('attestation', { entityType: 'attestation', id: fixtureId(120180) });
  const validation = f.service.validateDraftPackage(f.packageId());
  expect(validation.problems).toContainEqual(expect.objectContaining({ code: 'CONFIRMATION_PROOF_REQUIRED', ref: cloned.entityRef }));
  expect(result.canConfirm).toBe(true); expect(f.store.getEntry(draft.draftId)?.definition).toEqual({});
});

function publishManualGraph(f: ReturnType<typeof draftFixture>) {
  const anchor = makePublicationAnchor().id;
  f.repository.transaction(() => {
    f.repository.append('core_goal_definition', { ...f.input.goal, revision: 2, mode: 'manual_status' }, 1);
    f.repository.append('source_definition', { ...makeHeader(12), publicationAnchorId: anchor, goalId: f.input.goal.id, kind: 'manual_status', mappingRef: null, publicLocator: null, revision: 2 }, 1);
    f.repository.append('method_version', { ...makeHeader(14), publicationAnchorId: anchor, mode: 'manual_status', revision: 2 }, 1);
    f.repository.append('goal_assignment', { ...f.input.assignment, revision: 2, expectedPopulation: null, methodBinding: { kind: 'standalone', methodRef: { entityType: 'method_version', id: f.input.method.id, revision: 2 } } }, 1);
  });
}

it('private_manual_ancestry_rechecks_its_original_published_root_including_absence', async () => {
  const f = draftFixture(); publishManualGraph(f);
  const draft = await f.open('manual_status_event');
  const completed = await f.execute('manualGoal.transition', { draftId: draft.draftId, ref: { entityType: 'goal_assignment', id: f.input.assignment.id, revision: 2 }, targetState: 'completed', reason: null, resultDescription: 'Done' });
  const completedRef = (completed.result as any).versionRef;
  await f.execute('manualGoal.transition', { draftId: draft.draftId, ref: completedRef, targetState: 'in_progress', reason: 'More work', resultDescription: null });
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(true);
  f.repository.append('manual_status_event', { ...makeHeader(120200), recordedAt: '2026-10-24T11:00:00Z', publicationAnchorId: makePublicationAnchor().id, assignmentId: f.input.assignment.id, from: null, to: 'in_progress', resultDescription: null, reason: null, evidenceIds: [] }, null);
  expect(f.service.validateDraftPackage(f.packageId()).problems).toContainEqual(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
  const currentRef = f.store.getEntry(draft.draftId)!.versionRef;
  await expect(f.execute('manualGoal.transition', { draftId: draft.draftId, ref: currentRef, targetState: 'completed', reason: null, resultDescription: 'Stale' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(f.store.readDraftVersion(f.packageId(), completedRef)).toMatchObject({ to: 'completed', resultDescription: 'Done' });
});

it('manual_proof_is_invalidated_by_a_current_numeric_assignment_graph', async () => {
  const f = draftFixture(); publishManualGraph(f); const draft = await f.open('manual_status_event');
  await f.execute('manualGoal.transition', { draftId: draft.draftId, ref: { entityType: 'goal_assignment', id: f.input.assignment.id, revision: 2 }, targetState: 'completed', reason: null, resultDescription: 'Done' });
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(true);
  f.repository.transaction(() => {
    f.repository.append('core_goal_definition', { ...f.input.goal, revision: 3 }, 2);
    f.repository.append('source_definition', { ...f.repository.readVersion<any>({ entityType: 'source_definition', id: f.input.goal.sourceId, revision: 1 }), revision: 3 }, 2);
    f.repository.append('method_version', { ...f.input.method, revision: 3 }, 2);
    f.repository.append('goal_assignment', { ...f.input.assignment, revision: 3, methodBinding: { kind: 'standalone', methodRef: { entityType: 'method_version', id: f.input.method.id, revision: 3 } } }, 2);
  });
  expect(f.service.validateDraftPackage(f.packageId()).problems).toContainEqual(expect.objectContaining({ code: 'INVALID_MANUAL_TRANSITION' }));
});

it('business_noop_keeps_the_exact_completed_header_and_version', async () => {
  const f = draftFixture(); const goal = await f.open('core_goal_definition', { entityType: 'core_goal_definition', id: f.input.goal.id });
  const ref = f.store.getEntry(goal.draftId)!.versionRef; const before = f.store.readDraftVersion(f.packageId(), ref);
  expect(before).not.toBeNull(); f.setNow('2026-10-24T10:00:00Z'); f.context.actor.hostname = 'renamed-host';
  const saved = await f.execute('goal.draft.save', { draftId: goal.draftId, definition: business(f.input.goal) });
  expect((saved.result as any).versionRef).toEqual(ref);
  expect(f.store.readDraftVersion(f.packageId(), ref)).toEqual(before);
  expect(f.service.readDraftVersions(f.packageId()).find(e => e.entityRef.id === ref.id)?.value).toEqual(before);
});

it('private_calculation_receipts_are_person_owned_before_replay_and_anonymous_public_calculation_still_works', async () => {
  const f = draftFixture(); const assignment = await f.open('goal_assignment', { entityType: 'goal_assignment', id: f.input.assignment.id });
  const payload = { assignmentRef: f.store.getEntry(assignment.draftId)!.versionRef, businessTime: f.input.context.businessTime };
  const commandId = fixtureId(120201); const baseRevision = f.token();
  const own = await f.execute('calculation.prepare', payload, { commandId, baseRevision });
  expect(await f.execute('calculation.prepare', payload, { commandId, baseRevision })).toEqual(own);
  for (const personId of [fixtureId(778), null]) {
    f.context.ownAccess.personId = personId; f.context.actor.profilePersonId = personId;
    await expect(f.execute('calculation.prepare', payload, { commandId, baseRevision })).rejects.toMatchObject({ statusCode: 404 });
  }
  f.context.ownAccess.role = 'viewer';
  const published = await f.prepare(); expect(published.resultRef).not.toBeNull();
  await expect(f.execute('calculation.prepare', payload)).rejects.toMatchObject({ statusCode: 404 });
});

it('correcting_a_broken_reference_does_not_export_an_invalid_intermediate_entity_revision', async () => {
  const f = draftFixture(); const template = await f.open('template');
  const definition = { name: 'Template', methodRef: { entityType: 'method_version', id: fixtureId(120202), revision: 1 } };
  await f.execute('template.draft.save', { draftId: template.draftId, definition });
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(false);
  await f.execute('template.draft.save', { draftId: template.draftId, definition: { ...definition, methodRef: { entityType: 'method_version', id: f.input.method.id, revision: 1 } } });
  expect(f.service.validateDraftPackage(f.packageId())).toMatchObject({ complete: true, problems: [] });
  const versions = f.service.readDraftVersions(f.packageId());
  expect(versions).toHaveLength(1); expect(versions[0].value).toMatchObject({ revision: 1, methodRef: { id: f.input.method.id } });
  expect(f.store.history(template.draftId)).toHaveLength(3); // invalid input remains in private form audit
});

it('a_prepared_cross_linked_graph_keeps_frozen_versions_after_later_form_edits', async () => {
  const f = draftFixture(); const goal = await f.open('core_goal_definition'); const source = await f.open('source_definition'); const method = await f.open('method_version'); const assignment = await f.open('goal_assignment');
  await f.execute('goal.draft.save', { draftId: goal.draftId, definition: { ...business(f.input.goal), mode: 'manual_status', sourceId: source.objectId } });
  await f.execute('source.draft.save', { draftId: source.draftId, definition: { goalId: goal.objectId, kind: 'manual_status', mappingRef: null, publicLocator: null } });
  await f.execute('method.draft.save', { draftId: method.draftId, definition: { mode: 'manual_status' } });
  await f.execute('assignment.draft.save', { draftId: assignment.draftId, definition: { goalId: goal.objectId, scope: f.input.assignment.scope, methodBinding: { kind: 'standalone', methodRef: { ...method.entityRef, revision: 1 } }, officialDueOn: null, expectedPopulation: null } });
  const prepared = (await f.execute('calculation.prepare', { assignmentRef: { ...assignment.entityRef, revision: 1 }, businessTime: f.input.context.businessTime })).result as any;
  const basis = f.service.readPreparedForPackage(f.packageId(), prepared.basisRef) as any;
  const old = f.store.readDraftVersion(f.packageId(), basis.goalRef); expect(old).not.toBeNull();
  await f.execute('goal.draft.save', { draftId: goal.draftId, definition: { ...f.store.getEntry(goal.draftId)!.definition, title: 'Changed title' } });
  expect(f.store.getEntry(goal.draftId)!.versionRef.revision).toBe(2);
  expect(f.store.readDraftVersion(f.packageId(), basis.goalRef)).toEqual(old);
  expect(f.service.readDraftVersions(f.packageId()).filter(e => e.entityRef.id === goal.objectId).map(e => e.value.revision)).toEqual([1, 2]);
});

it('manual_private_chains_keep_a_published_root_and_reject_parallel_local_branches', async () => {
  const f = draftFixture(); publishManualGraph(f); const rootRef = { entityType: 'manual_status_event', id: fixtureId(120210), revision: 1 };
  f.repository.append('manual_status_event', { ...makeHeader(120210), publicationAnchorId: makePublicationAnchor().id, assignmentId: f.input.assignment.id, from: null, to: 'in_progress', reason: null, resultDescription: null, evidenceIds: [] }, null);
  const first = await f.open('manual_status_event');
  const completed = await f.execute('manualGoal.transition', { draftId: first.draftId, ref: rootRef, targetState: 'completed', reason: null, resultDescription: 'Done' });
  const second = await f.open('manual_status_event');
  await expect(f.execute('manualGoal.transition', { draftId: second.draftId, ref: rootRef, targetState: 'completed', reason: null, resultDescription: 'Parallel' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await f.execute('manualGoal.transition', { draftId: second.draftId, ref: (completed.result as any).versionRef, targetState: 'in_progress', reason: 'Follow-up', resultDescription: null });
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(true);
  f.repository.append('manual_status_event', { ...makeHeader(120211), recordedAt: '2026-10-25T10:00:00Z', publicationAnchorId: makePublicationAnchor().id, assignmentId: f.input.assignment.id, from: 'in_progress', to: 'completed', reason: null, resultDescription: 'Other sequence', evidenceIds: [] }, null);
  expect(f.service.validateDraftPackage(f.packageId()).problems).toContainEqual(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
});

it('identity_cannot_change_from_anonymous_acceptance_to_private_execution', async () => {
  const f = draftFixture(); const assignment = await f.open('goal_assignment', { entityType: 'goal_assignment', id: f.input.assignment.id });
  const originalAccess = { ...f.context.ownAccess }; let calls = 0;
  f.context.ownAccess.personId = null; f.context.actor.profilePersonId = null;
  f.policy.assertCommandAllowed = async () => ++calls === 1 ? { ...originalAccess, personId: null } : originalAccess;
  const derivedBefore = f.service.readDraftVersions(f.packageId());
  await expect(f.execute('calculation.prepare', { assignmentRef: f.store.getEntry(assignment.draftId)!.versionRef, businessTime: f.input.context.businessTime })).rejects.toMatchObject({ code: 'COMMAND_CONTEXT_MISMATCH' });
  expect(f.service.readDraftVersions(f.packageId())).toEqual(derivedBefore);
});
