import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { DirectoryEntity, DirectoryLink, EvaluationBasis, SourceFieldMapping } from '../../domain/workbench/entities';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, makePublicationAnchor } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { canonicalBasis, digestBasis } from '../evaluation/workbench/basis';
import { enrichSourceRows, validateDirectoryChanges } from './workbench-directory';
import { createDirectoryStore } from './workbench-directory-store';

const ref = (entityType: string, value: { id: string; revision: number }) => ({ entityType, id: value.id, revision: value.revision });
const entityRef = (seed: number) => ({ entityType: 'directory_entity', id: fixtureId(seed) });
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
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
