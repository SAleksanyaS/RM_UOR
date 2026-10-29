import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { DirectoryEntity, DirectoryLink, EvaluationBasis, GoalAssignment, SourceFieldMapping, Template } from '../../domain/workbench/entities';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { canonicalBasis, digestBasis } from '../evaluation/workbench/basis';
import { enrichSourceRows, proposeTeamAssignments, validateDirectoryChanges } from './workbench-directory';
import { createDirectoryStore } from './workbench-directory-store';

const ref = (entityType: string, value: { id: string; revision: number }) => ({ entityType, id: value.id, revision: value.revision });
const entityRef = (seed: number) => ({ entityType: 'directory_entity', id: fixtureId(seed) });
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function teamProposalFixture() {
  const team: DirectoryEntity = { ...makeHeader(700), kind: 'team', name: 'New team', externalKeys: [] };
  const assignments: GoalAssignment[] = [
    { ...makeHeader(701), goalId: fixtureId(710), scope: { kind: 'cluster', id: fixtureId(103) }, methodBinding: { kind: 'standalone', methodRef: { entityType: 'method_version', id: fixtureId(720), revision: 1 } }, officialDueOn: '2026-12-31', expectedPopulation: [{ kind: 'product', id: fixtureId(101) }] },
    { ...makeHeader(702), goalId: fixtureId(711), scope: { kind: 'cluster', id: fixtureId(103) }, methodBinding: { kind: 'template', templateId: fixtureId(721) }, officialDueOn: '2026-11-30', expectedPopulation: [{ kind: 'team', id: fixtureId(104) }] },
  ];
  const templates: Template[] = [730, 731].map(seed => ({ ...makeHeader(seed), name: `Team template ${seed}`, methodRef: { entityType: 'method_version', id: fixtureId(seed + 10), revision: 1 } }));
  return { team, clusterRef: entityRef(103), links: [] as DirectoryLink[], assignments, templates, teamTemplateBindings: assignments.map((assignment, i) => ({ goalId: assignment.goalId, templateId: templates[i].id })) };
}

it('new_team_does_not_expand_other_population_and_uses_each_explicit_team_template', () => {
  const f = teamProposalFixture(); const before = structuredClone(f);
  const proposed = proposeTeamAssignments(f);
  expect(proposed).toHaveLength(2); expect(f).toEqual(before);
  expect(proposed.map(p => p.goalId).sort()).toEqual(f.assignments.map(a => a.goalId).sort());
  for (const proposal of proposed) {
    expect(proposal).toMatchObject({ scope: { kind: 'team', id: f.team.id }, methodBinding: { kind: 'template', templateId: f.teamTemplateBindings.find(b => b.goalId === proposal.goalId)!.templateId }, officialDueOn: null, expectedPopulation: null, publicationPending: true });
    for (const key of ['revision', 'recordedAt', 'actor', 'publicationAnchorId', 'effectiveAt']) expect(proposal).not.toHaveProperty(key);
    expect(proposal.pendingLinks).toEqual([expect.objectContaining({ kind: 'cluster_team', from: f.clusterRef, to: { entityType: 'directory_entity', id: f.team.id } })]);
    expect(proposal.pendingLinks[0]).not.toHaveProperty('revision');
  }
  expect(proposed[0].pendingLinks[0].id).toBe(proposed[1].pendingLinks[0].id);
  expect(new Set([...proposed.map(p => p.id), proposed[0].pendingLinks[0].id]).size).toBe(3);
  proposed[0].pendingLinks[0].from.id = fixtureId(799);
  expect(proposed[1].pendingLinks[0].from).toEqual(f.clusterRef); expect(f).toEqual(before);
});

it('proposes_only_missing_team_goals_of_the_selected_cluster_without_replacing_an_existing_method', () => {
  const f = teamProposalFixture(); const existing = { ...f.assignments[0], id: fixtureId(750), scope: { kind: 'team' as const, id: f.team.id } };
  f.assignments.push(existing, { ...f.assignments[1], id: fixtureId(751), goalId: fixtureId(752), scope: { kind: 'cluster', id: fixtureId(753) } });
  f.teamTemplateBindings = f.teamTemplateBindings.slice(1);
  const proposed = proposeTeamAssignments(f);
  expect(proposed.map(p => p.goalId)).toEqual([fixtureId(711)]); expect(f.assignments[2]).toEqual(existing);
  expect(proposeTeamAssignments({ ...f, assignments: [] })).toEqual([]);
});

it('never_guesses_a_team_template_from_name_order_or_cluster_method', () => {
  const f = teamProposalFixture();
  expect(() => proposeTeamAssignments({ ...f, teamTemplateBindings: [] })).toThrowError(expect.objectContaining({ code: 'TEAM_TEMPLATE_REQUIRED' }));
  expect(() => proposeTeamAssignments({ ...f, templates: [] })).toThrowError(expect.objectContaining({ code: 'TEAM_TEMPLATE_MISSING' }));
  expect(() => proposeTeamAssignments({ ...f, teamTemplateBindings: [...f.teamTemplateBindings, f.teamTemplateBindings[0]] })).toThrowError(expect.objectContaining({ code: 'TEAM_TEMPLATE_AMBIGUOUS' }));
  expect(() => proposeTeamAssignments({ ...f, templates: [...f.templates, f.templates[0]] })).toThrowError(expect.objectContaining({ code: 'TEAM_TEMPLATE_AMBIGUOUS' }));
  expect(() => proposeTeamAssignments({ ...f, assignments: [...f.assignments, { ...f.assignments[0], id: fixtureId(754) }] })).toThrowError(expect.objectContaining({ code: 'TEAM_ASSIGNMENT_AMBIGUOUS' }));
});

it('never_moves_a_team_to_another_cluster_or_creates_product_service_relationships', () => {
  const f = teamProposalFixture(); const link: DirectoryLink = { ...makeHeader(760), kind: 'cluster_team', from: f.clusterRef, to: { entityType: 'directory_entity', id: f.team.id } };
  expect(() => proposeTeamAssignments({ ...f, links: [{ ...link, from: entityRef(761) }] })).toThrowError(expect.objectContaining({ code: 'TEAM_CLUSTER_MOVE_UNSUPPORTED' }));
  expect(() => proposeTeamAssignments({ ...f, links: [link, { ...link, id: fixtureId(762) }] })).toThrowError(expect.objectContaining({ code: 'TEAM_CLUSTER_LINK_AMBIGUOUS' }));
  expect(proposeTeamAssignments({ ...f, links: [{ ...link, publicationAnchorId: fixtureId(2) }], confirmedLinkRefs: [{ entityType: 'directory_link', id: link.id, revision: link.revision }] }).every(p => p.pendingLinks.length === 0)).toBe(true);
  expect(proposeTeamAssignments({ ...f, links: [{ ...link, publicationAnchorId: null }] })[0].pendingLinks).toEqual([{ id: link.id, kind: link.kind, from: link.from, to: link.to }]);
  expect(() => proposeTeamAssignments({ ...f, team: { ...f.team, kind: 'product' } })).toThrow();
  expect(() => proposeTeamAssignments({ ...f, clusterRef: { ...f.clusterRef, entityType: 'template' } })).toThrow();
  expect(() => proposeTeamAssignments({ ...f, effectiveAt: '2026-01-01' } as unknown as Parameters<typeof proposeTeamAssignments>[0])).toThrow();
});

it('a_reserved_package_anchor_does_not_remove_the_pending_cluster_link', () => {
  const f = teamProposalFixture();
  const link: DirectoryLink = { ...makeHeader(763), kind: 'cluster_team', from: f.clusterRef, to: { entityType: 'directory_entity', id: f.team.id }, publicationAnchorId: fixtureId(764) };
  expect(proposeTeamAssignments({ ...f, links: [link] })[0].pendingLinks).toEqual([{ id: link.id, kind: link.kind, from: link.from, to: link.to }]);
});

it('only_caller_verified_exact_link_revisions_can_remove_pending_dependencies', () => {
  const f = teamProposalFixture();
  const link: DirectoryLink = { ...makeHeader(763), kind: 'cluster_team', from: f.clusterRef, to: { entityType: 'directory_entity', id: f.team.id }, publicationAnchorId: fixtureId(2) };
  const confirmed = { entityType: 'directory_link', id: link.id, revision: link.revision };
  for (const confirmedLinkRefs of [[{ ...confirmed, revision: 2 }], [{ ...confirmed, id: fixtureId(765) }], [confirmed, confirmed]]) {
    expect(() => proposeTeamAssignments({ ...f, links: [link], confirmedLinkRefs })).toThrowError(expect.objectContaining({ code: 'TEAM_LINK_CONFIRMATION_INVALID' }));
  }
  expect(() => proposeTeamAssignments({ ...f, links: [{ ...link, publicationAnchorId: null }], confirmedLinkRefs: [confirmed] })).toThrowError(expect.objectContaining({ code: 'TEAM_LINK_CONFIRMATION_INVALID' }));
  expect(proposeTeamAssignments({ ...f, links: [link], confirmedLinkRefs: [confirmed] }).every(p => p.pendingLinks.length === 0)).toBe(true);
});

it('pending_team_proposals_are_not_current_until_confirmed_publication_and_keep_old_basis', () => {
  const f = repositoryFixture(); const input = teamProposalFixture();
  input.assignments = [{ ...f.input.assignment, scope: { kind: 'cluster', id: fixtureId(103) } }];
  input.templates = [{ ...input.templates[0], methodRef: { entityType: 'method_version', id: f.input.method.id, revision: f.input.method.revision } }];
  input.teamTemplateBindings = [{ goalId: f.input.goal.id, templateId: input.templates[0].id }];
  const proposals = proposeTeamAssignments(input);
  const oldBasis = canonicalBasis(f.input); const oldDigest = digestBasis(oldBasis);
  const savedBasis: EvaluationBasis = { ...makeHeader(774), ...oldBasis, evaluatedAt: f.input.context.evaluatedAt, digest: oldDigest };
  const savedBasisRef = f.repository.append('evaluation_basis', savedBasis, null);
  const originalAssignment = f.repository.readVersion<GoalAssignment>({ entityType: 'goal_assignment', id: f.input.assignment.id, revision: f.input.assignment.revision });
  const assignmentRef = { entityType: 'goal_assignment', id: proposals[0].id };
  const pendingLink = proposals[0].pendingLinks[0]; const linkRef = { entityType: 'directory_link', id: pendingLink.id };
  expect(f.repository.readPublishedHead(assignmentRef)).toBeNull(); expect(f.repository.readPublishedHead(linkRef)).toBeNull();
  const { pendingLinks: _links, publicationPending: _pending, ...definition } = proposals[0];
  const completedDefinition = { ...definition, expectedPopulation: [{ kind: 'team' as const, id: input.team.id }] };
  f.repository.transaction(() => {
    f.repository.append('template', input.templates[0], null);
    f.repository.append('directory_entity', input.team, null);
    f.repository.append('directory_link', { ...makeHeader(771), ...pendingLink, publicationAnchorId: null }, null);
  });
  expect(() => f.repository.append('goal_assignment', { ...makeHeader(770), ...definition, publicationAnchorId: null }, null)).toThrowError(expect.objectContaining({ code: 'ASSIGNMENT_POPULATION_MISMATCH' }));
  f.repository.append('goal_assignment', { ...makeHeader(770), ...completedDefinition, publicationAnchorId: null }, null);
  expect(f.repository.readPublishedHead(assignmentRef)).toBeNull();
  const anchor = makePublicationAnchor({ id: fixtureId(772), packageId: fixtureId(773), timeVerification: 'unknown', mergedAt: null });
  f.repository.transaction(() => {
    f.repository.appendPublicationAnchor(anchor, null);
    f.repository.append('template', { ...input.templates[0], revision: 2, publicationAnchorId: anchor.id }, 1);
    f.repository.append('goal_assignment', { ...makeHeader(770), ...definition, revision: 2, publicationAnchorId: anchor.id, expectedPopulation: [{ kind: 'team', id: input.team.id }] }, 1);
    f.repository.append('directory_entity', { ...input.team, revision: 2, publicationAnchorId: anchor.id }, 1);
    f.repository.append('directory_link', { ...makeHeader(771), ...pendingLink, revision: 2, publicationAnchorId: anchor.id }, 1);
  });
  expect(f.repository.readPublishedHead(assignmentRef)).toMatchObject({ id: proposals[0].id, revision: 2 });
  const current = createDirectoryStore({ repository: f.repository }).read({ refs: { entityRefs: [{ entityType: 'directory_entity', id: input.team.id, revision: 2 }], linkRefs: [{ ...linkRef, revision: 2 }] }, mode: { kind: 'current' } });
  expect(current.directoryLinks).toHaveLength(1);
  expect(f.repository.readVersion(savedBasisRef)).toEqual(savedBasis);
  expect(f.repository.readVersion({ entityType: 'goal_assignment', id: f.input.assignment.id, revision: f.input.assignment.revision })).toEqual(originalAssignment);
});
function fixture() {
  const input = makeNumericFixture({ values: ['92'], scope: { kind: 'dit', id: fixtureId(100) }, expectedPopulation: [{ kind: 'product', id: fixtureId(101) }, { kind: 'product', id: fixtureId(102) }] });
  const graph = makeEntityGraph(input);
  const entities = graph.entries.filter(e => e.entityType === 'directory_entity').map(e => e.value as DirectoryEntity);
  for (const [seed, kind] of [[103, 'cluster'], [104, 'team'], [105, 'team'], [106, 'person']] as const) entities.push({ ...makeHeader(seed, { publicationAnchorId: fixtureId(2) }), kind, name: `synthetic-${seed}`, externalKeys: [] });
  entities.find(e => e.id === fixtureId(101))!.externalKeys = [{ sourceId: input.goal.sourceId, key: 'PRODUCT-A' }];
  entities.find(e => e.id === fixtureId(102))!.externalKeys = [{ sourceId: input.goal.sourceId, key: 'PRODUCT-B' }];
  const link = (seed: number, kind: Exclude<DirectoryLink['kind'], 'leader'>, from: number, to: number): DirectoryLink => ({ ...makeHeader(seed, { publicationAnchorId: fixtureId(2) }), kind, from: entityRef(from), to: entityRef(to) });
  const leader = (seed: number, kind: 'cluster' | 'product', scopeSeed: number): DirectoryLink => ({ ...makeHeader(seed, { publicationAnchorId: fixtureId(2) }), kind: 'leader', scope: { kind, id: fixtureId(scopeSeed) }, personId: fixtureId(17) });
  const links: DirectoryLink[] = [link(110, 'dit_cluster', 100, 103), link(111, 'cluster_product', 103, 101), link(112, 'cluster_product', 103, 102), link(113, 'cluster_team', 103, 104), link(114, 'cluster_team', 103, 105), leader(115, 'cluster', 103), leader(116, 'product', 101), leader(117, 'product', 102), link(118, 'product_team', 101, 104), link(119, 'product_team', 102, 104), link(120, 'product_team', 101, 105)];
  graph.entries = graph.entries.filter(e => !['directory_entity', 'directory_link'].includes(e.entityType));
  entities.forEach(value => graph.entries.push({ entityType: 'directory_entity', value })); links.forEach(value => graph.entries.push({ entityType: 'directory_link', value }));
  const mapping = graph.entries.find(e => e.entityType === 'source_field_mapping')!.value as SourceFieldMapping;
  mapping.productKeyField = 'published-product-column';
  const capture = input.captures[0];
  capture.rawRows.forEach((row, i) => { row.cells['published-product-column'] = { kind: 'text', original: i ? 'PRODUCT-B' : 'PRODUCT-A' }; row.cells.demo_value.original = '92.00'; });
  capture.canonicalRows.forEach(row => { row.dimensions = { arbitraryPublishedDimension: 'preserved' }; });
  const refs = { entityRefs: entities.map(e => ref('directory_entity', e)), linkRefs: links.map(l => ref('directory_link', l)) };
  return { input, graph, entities, links, mapping, capture, refs };
}
function repositoryFixture() {
  const f = fixture(); const root = mkdtempSync(path.join(os.tmpdir(), 'uor-directory-'));
  const config = { filename: path.join(root, 'db.sqlite'), artifactRoot: path.join(root, 'artifacts') };
  const repository = createWorkbenchRepository(config); seedGraph(repository, f.graph);
  cleanups.push(() => { repository.close(); if (!path.basename(root).startsWith('uor-directory-')) throw Error('Invalid temporary root'); rmSync(root, { recursive: true, force: true }); });
  return { ...f, repository, config };
}

it('retains_raw_and_reports_required_unmapped_product_without_inventing_ID', () => {
  const f = fixture(); f.capture.rawRows[0].cells['published-product-column'].original = 'UNMAPPED';
  const before = structuredClone(f.capture);
  const result = enrichSourceRows({ capture: f.capture, mapping: f.mapping, directoryEntities: f.entities, directoryLinks: f.links });
  expect(result.rows).toHaveLength(2); expect(result.rows[0]).toMatchObject({ rowKey: 'demo_0_0', numbers: { demo_value: '92' }, dimensions: { arbitraryPublishedDimension: 'preserved' }, scope: null });
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'UNMAPPED_PRODUCT', path: '/canonicalRows/0' }));
  expect(f.capture).toEqual(before); expect(f.capture.rawRows[0].cells.demo_value.original).toBe('92.00');
});
it('resolves_exact_source_keys_and_preserves_one_row_through_many_to_many_teams', () => {
  const f = fixture(); const unrelated: DirectoryEntity = { ...makeHeader(999), kind: 'product', name: 'same-name', externalKeys: [{ sourceId: fixtureId(999), key: 'PRODUCT-A' }] };
  const result = enrichSourceRows({ capture: f.capture, mapping: f.mapping, directoryEntities: [...f.entities, unrelated], directoryLinks: f.links });
  expect(result.rows).toHaveLength(2); expect(result.issues).toEqual([]);
  expect(result.rows.map(row => row.scope)).toEqual([{ kind: 'product', id: fixtureId(101) }, { kind: 'product', id: fixtureId(102) }]);
  expect(result.rows[0].directoryEntityRefs).toEqual(expect.arrayContaining([ref('directory_entity', f.entities.find(e => e.id === fixtureId(104))!), ref('directory_entity', f.entities.find(e => e.id === fixtureId(105))!)]));
  expect(new Set(result.directoryLinkRefs.map(r => r.id)).size).toBe(result.directoryLinkRefs.length);
  result.rows[0].numbers.demo_value = '0'; expect(f.capture.canonicalRows[0].numbers.demo_value).toBe('92');
});
it('missing_optional_teams_is_not_a_completeness_problem_and_fixed_scope_is_explicit', () => {
  const f = fixture(); const links = f.links.filter(l => !['product_team', 'cluster_team'].includes(l.kind));
  const result = enrichSourceRows({ capture: f.capture, mapping: f.mapping, directoryEntities: f.entities.filter(e => e.kind !== 'team'), directoryLinks: links });
  expect(result.issues).toEqual([]); expect(result.rows[0].scope).toEqual({ kind: 'product', id: fixtureId(101) });
  const fixed = { ...f.mapping, productKeyField: null, fixedScope: { kind: 'product' as const, id: fixtureId(101) } };
  expect(enrichSourceRows({ capture: f.capture, mapping: fixed, directoryEntities: f.entities, directoryLinks: f.links }).rows.every(r => r.scope?.id === fixtureId(101))).toBe(true);
});
it('ambiguous_normalized_source_keys_and_wrong_mapping_never_resolve_a_product', () => {
  const f = fixture(); f.entities.find(e => e.id === fixtureId(102))!.externalKeys.push({ sourceId: f.capture.sourceId, key: ' PRODUCT-A ' });
  const result = enrichSourceRows({ capture: f.capture, mapping: f.mapping, directoryEntities: f.entities, directoryLinks: f.links });
  expect(result.rows[0].scope).toBeNull(); expect(result.issues.some(p => p.code === 'AMBIGUOUS_PRODUCT')).toBe(true);
  expect(validateDirectoryChanges({ entities: f.entities, links: f.links }).some(p => p.code === 'DUPLICATE_EXTERNAL_KEY')).toBe(true);
  expect(() => enrichSourceRows({ capture: f.capture, mapping: { ...f.mapping, sourceId: fixtureId(999) }, directoryEntities: f.entities, directoryLinks: f.links })).toThrowError(expect.objectContaining({ code: 'SOURCE_MAPPING_MISMATCH' }));
});
it('enriches_a_precapture_projection_without_fabricated_header_or_capture_ID', () => {
  const f = fixture(); const { sourceId, mappingRef, rawRows, canonicalRows } = f.capture;
  const result = enrichSourceRows({ capture: { sourceId, mappingRef, rawRows, canonicalRows }, mapping: f.mapping, directoryEntities: f.entities, directoryLinks: f.links });
  expect(result.issues).toEqual([]); expect(result.rows.map(row => row.rowKey)).toEqual(['demo_0_0', 'demo_0_1']);
});
it('never_guesses_trimmed_keys_or_replaces_missing_raw_lineage', () => {
  const f = fixture(); f.capture.rawRows[0].cells['published-product-column'].original = ' PRODUCT-A ';
  f.capture.rawRows.pop();
  const result = enrichSourceRows({ capture: f.capture, mapping: f.mapping, directoryEntities: f.entities, directoryLinks: f.links });
  expect(result.rows.map(r => r.scope)).toEqual([null, null]);
  expect(result.issues.map(p => p.code)).toEqual(['UNMAPPED_PRODUCT', 'SOURCE_ROW_MISSING']);
});
it('validates_parent_kinds_single_parent_leaders_and_team_cluster_moves', () => {
  const f = fixture(); expect(validateDirectoryChanges({ entities: f.entities, links: f.links })).toEqual([]);
  const wrong: DirectoryLink = { ...makeHeader(150), kind: 'cluster_product', from: entityRef(101), to: entityRef(102) };
  expect(validateDirectoryChanges({ entities: f.entities, links: [...f.links, wrong] }).some(p => p.code === 'DIRECTORY_LINK_KIND_MISMATCH')).toBe(true);
  expect(validateDirectoryChanges({ entities: f.entities, links: f.links.filter(l => l.id !== fixtureId(116)) }).some(p => p.code === 'LEADER_REQUIRED')).toBe(true);
  const duplicate = { ...f.links.find(l => l.id === fixtureId(116))!, id: fixtureId(151) };
  expect(validateDirectoryChanges({ entities: f.entities, links: [...f.links, duplicate] }).some(p => p.code === 'MULTIPLE_LEADERS')).toBe(true);
  const nextCluster: DirectoryEntity = { ...makeHeader(160), kind: 'cluster', name: 'next', externalKeys: [] };
  const changed = f.links.map(l => l.kind === 'cluster_team' && l.to.id === fixtureId(104) ? { ...l, from: entityRef(160) } : l);
  expect(validateDirectoryChanges({ entities: [...f.entities, nextCluster], links: changed, previousLinks: f.links }).some(p => p.code === 'TEAM_CLUSTER_MOVE_UNSUPPORTED')).toBe(true);
});
it('rejects_cross_cluster_product_team_links_and_duplicate_or_missing_parent_edges', () => {
  const f = fixture();
  const without = f.links.filter(l => l.id !== fixtureId(111));
  expect(validateDirectoryChanges({ entities: f.entities, links: without }).some(p => p.code === 'PRODUCT_CLUSTER_REQUIRED')).toBe(true);
  const otherCluster: DirectoryEntity = { ...makeHeader(170), kind: 'cluster', name: 'other', externalKeys: [] };
  const extra: DirectoryLink = { ...makeHeader(171), kind: 'cluster_product', from: entityRef(170), to: entityRef(101) };
  expect(validateDirectoryChanges({ entities: [...f.entities, otherCluster], links: [...f.links, extra] }).some(p => p.code === 'MULTIPLE_PRODUCT_CLUSTERS')).toBe(true);
  const moved = f.links.map(l => l.kind === 'cluster_team' && l.to.id === fixtureId(104) ? { ...l, from: entityRef(170) } : l);
  expect(validateDirectoryChanges({ entities: [...f.entities, otherCluster], links: moved }).some(p => p.code === 'PRODUCT_TEAM_CLUSTER_MISMATCH')).toBe(true);
});
it('returns_problems_for_malformed_entities_and_duplicate_semantic_team_relationships', () => {
  const f = fixture(); const duplicate = { ...f.links.find(l => l.id === fixtureId(118))!, id: fixtureId(199) };
  expect(validateDirectoryChanges({ entities: f.entities, links: [...f.links, duplicate] }).some(p => p.code === 'DUPLICATE_DIRECTORY_RELATIONSHIP')).toBe(true);
  const malformed = { ...f.entities[0], externalKeys: null } as unknown as DirectoryEntity;
  expect(validateDirectoryChanges({ entities: [malformed], links: [] }).some(p => p.code === 'DIRECTORY_ENTITY_INVALID')).toBe(true);
});
it('confirmed_unknown_time_enables_current_links_but_historical_time_uses_anchor_guard', () => {
  const f = repositoryFixture(); const store = createDirectoryStore({ repository: f.repository }); const old = f.links.find(l => l.id === fixtureId(116))!;
  const anchor = makePublicationAnchor({ id: fixtureId(900), packageId: fixtureId(901), timeVerification: 'unknown', mergedAt: null });
  f.repository.transaction(() => { f.repository.appendPublicationAnchor(anchor, null); f.repository.append('directory_link', { ...old, revision: 2, publicationAnchorId: anchor.id, personId: fixtureId(106) }, 1); });
  const current = store.read({ refs: f.refs, mode: { kind: 'current' } }); expect(current.directoryLinks.find(l => l.id === old.id)).toMatchObject({ revision: 2, personId: fixtureId(106) });
  expect(() => store.read({ refs: f.refs, mode: { kind: 'at', effectiveAt: '2026-10-28T09:00:00Z' } })).toThrowError(expect.objectContaining({ code: 'EFFECTIVE_TIME_UNVERIFIED' }));
  expect(store.read({ refs: f.refs, mode: { kind: 'snapshot' } }).directoryLinks.find(l => l.id === old.id)).toMatchObject({ revision: 1, personId: fixtureId(17) });
});
it('unconfirmed_draft_does_not_replace_current_directory_and_saved_basis_digest_is_unchanged', () => {
  const f = repositoryFixture(); const store = createDirectoryStore({ repository: f.repository });
  const content = canonicalBasis({ ...f.input, resolution: { ...f.input.resolution, directoryLinkRefs: f.refs.linkRefs } });
  const basis: EvaluationBasis = { ...makeHeader(910), ...content, evaluatedAt: f.input.context.evaluatedAt, digest: digestBasis(content) };
  const basisRef = f.repository.append('evaluation_basis', basis, null); const storedBefore = f.repository.readVersion<EvaluationBasis>(basisRef)!;
  const old = f.entities.find(e => e.id === fixtureId(101))!; f.repository.append('directory_entity', { ...old, revision: 2, name: 'Unpublished new name', publicationAnchorId: null }, 1);
  expect(store.read({ refs: f.refs, mode: { kind: 'current' } }).directoryEntities.find(e => e.id === old.id)?.name).toBe(old.name);
  expect(() => store.read({ refs: { ...f.refs, entityRefs: f.refs.entityRefs.map(r => r.id === old.id ? { ...r, revision: 2 } : r) }, mode: { kind: 'snapshot' } })).toThrowError(expect.objectContaining({ code: 'DIRECTORY_REFERENCE_UNPUBLISHED' }));
  f.repository.append('directory_entity', { ...old, revision: 3, name: 'Published new name' }, 2);
  expect(store.read({ refs: f.refs, mode: { kind: 'current' } }).directoryEntities.find(e => e.id === old.id)?.name).toBe('Published new name');
  expect(store.read({ refs: f.refs, mode: { kind: 'snapshot' } }).directoryEntities.find(e => e.id === old.id)?.name).toBe(old.name);
  expect(f.repository.readVersion<EvaluationBasis>(basisRef)).toEqual(storedBefore); expect(f.repository.readVersion<EvaluationBasis>(basisRef)?.digest).toBe(basis.digest);
});
