import type { Capture, DirectoryEntity, DirectoryLink, SourceFieldMapping } from '../../domain/workbench/entities';
import type { EntityRef, ScopeRef, VersionRef } from '../../domain/workbench/primitives';
import { uuidSchema } from '../../domain/workbench/primitives';
import { captureSchema, directoryEntitySchema, directoryLinkSchema, sourceFieldMappingSchema } from '../../domain/workbench/schemas';
import { WorkbenchError } from '../../domain/workbench/errors';
import type { FieldProblem } from '../../server/workbench/protocol';
import type { EnrichedRow, EnrichmentResult } from '../connectors/workbench-source-contracts';

const entityRef = (id: string): EntityRef => ({ entityType: 'directory_entity', id });
const version = (entityType: string, value: { id: string; revision: number }): VersionRef => ({ entityType, id: value.id, revision: value.revision });
const normalizedKey = (key: string): string => key.normalize('NFC').trim();
const edgeKinds = { dit_cluster: ['dit', 'cluster'], cluster_product: ['cluster', 'product'], cluster_team: ['cluster', 'team'], product_team: ['product', 'team'] } as const;
const problem = (path: string, code: string, ref: EntityRef | null): FieldProblem => ({ path, code, message: code, ref });
export type SourceRowsForEnrichment = Pick<Capture, 'sourceId' | 'mappingRef' | 'rawRows' | 'canonicalRows'>;
const sourceRowsSchema = captureSchema.pick({ sourceId: true, mappingRef: true, rawRows: true, canonicalRows: true });

/** Complete proposed graph. previousLinks is required to detect a move whose old edge was removed.
 * Values are never published, assigned IDs or modified by this validator. */
export function validateDirectoryChanges({ entities, links, previousLinks = [] }: { entities: DirectoryEntity[]; links: DirectoryLink[]; previousLinks?: DirectoryLink[] }): FieldProblem[] {
  const issues: FieldProblem[] = []; const byId = new Map<string, DirectoryEntity>(); const seenLinks = new Set<string>();
  entities.forEach((entity, i) => {
    if (!directoryEntitySchema.safeParse(entity).success) { issues.push(problem(`/entities/${i}`, 'DIRECTORY_ENTITY_INVALID', null)); return; }
    if (byId.has(entity.id)) issues.push(problem(`/entities/${i}`, 'DUPLICATE_DIRECTORY_ENTITY', entityRef(entity.id))); else byId.set(entity.id, entity);
  });
  const keys = new Map<string, string>();
  entities.forEach((entity, i) => { if (!directoryEntitySchema.safeParse(entity).success) return; entity.externalKeys.forEach(external => {
    const key = JSON.stringify([external.sourceId, normalizedKey(external.key)]);
    if (!normalizedKey(external.key) || keys.has(key)) issues.push(problem(`/entities/${i}/externalKeys`, 'DUPLICATE_EXTERNAL_KEY', entityRef(entity.id)));
    else keys.set(key, entity.id);
  }); });
  const valid: DirectoryLink[] = []; const relationships = new Set<string>();
  links.forEach((link, i) => {
    const ref = uuidSchema.safeParse(link.id).success ? { entityType: 'directory_link', id: link.id } : null;
    if (!directoryLinkSchema.safeParse(link).success) { issues.push(problem(`/links/${i}`, 'DIRECTORY_LINK_INVALID', ref)); return; }
    if (seenLinks.has(link.id)) issues.push(problem(`/links/${i}`, 'DUPLICATE_DIRECTORY_LINK', ref)); seenLinks.add(link.id);
    const relationship = link.kind === 'leader' ? JSON.stringify([link.kind, link.scope, link.personId]) : JSON.stringify([link.kind, link.from.id, link.to.id]);
    if (relationships.has(relationship)) issues.push(problem(`/links/${i}`, 'DUPLICATE_DIRECTORY_RELATIONSHIP', link.kind === 'leader' ? entityRef(link.scope.id) : entityRef(link.from.id))); relationships.add(relationship);
    if (link.kind === 'leader') {
      if (byId.get(link.scope.id)?.kind !== link.scope.kind || byId.get(link.personId)?.kind !== 'person') issues.push(problem(`/links/${i}`, 'DIRECTORY_LINK_KIND_MISMATCH', entityRef(link.scope.id)));
      else valid.push(link);
    } else {
      const [parent, child] = edgeKinds[link.kind];
      if (byId.get(link.from.id)?.kind !== parent || byId.get(link.to.id)?.kind !== child) issues.push(problem(`/links/${i}`, 'DIRECTORY_LINK_KIND_MISMATCH', entityRef(link.to.id)));
      else valid.push(link);
    }
  });
  const parents = (id: string, kind: 'dit_cluster' | 'cluster_product' | 'cluster_team') => valid.filter((l): l is Extract<DirectoryLink, { from: EntityRef }> => l.kind === kind && l.to.id === id);
  for (const [i, entity] of entities.entries()) {
    if (!directoryEntitySchema.safeParse(entity).success) continue;
    const check = (count: number, missing: string, multiple: string) => { if (count !== 1) issues.push(problem(`/entities/${i}`, count ? multiple : missing, entityRef(entity.id))); };
    if (entity.kind === 'cluster') check(parents(entity.id, 'dit_cluster').length, 'CLUSTER_DIT_REQUIRED', 'MULTIPLE_CLUSTER_DITS');
    if (entity.kind === 'product') check(parents(entity.id, 'cluster_product').length, 'PRODUCT_CLUSTER_REQUIRED', 'MULTIPLE_PRODUCT_CLUSTERS');
    if (entity.kind === 'team') {
      const current = parents(entity.id, 'cluster_team'); check(current.length, 'TEAM_CLUSTER_REQUIRED', 'TEAM_CLUSTER_MOVE_UNSUPPORTED');
      const old = previousLinks.filter((l): l is Extract<DirectoryLink, { from: EntityRef }> => l.kind === 'cluster_team' && l.to.id === entity.id);
      if (current.length === 1 && old.some(l => l.from.id !== current[0].from.id)) issues.push(problem(`/entities/${i}`, 'TEAM_CLUSTER_MOVE_UNSUPPORTED', entityRef(entity.id)));
    }
    if (entity.kind === 'cluster' || entity.kind === 'product') check(valid.filter(l => l.kind === 'leader' && l.scope.id === entity.id).length, 'LEADER_REQUIRED', 'MULTIPLE_LEADERS');
    else if (entity.kind === 'team' && valid.filter(l => l.kind === 'leader' && l.scope.id === entity.id).length > 1) issues.push(problem(`/entities/${i}`, 'MULTIPLE_LEADERS', entityRef(entity.id)));
  }
  for (const [i, link] of valid.entries()) if (link.kind === 'product_team') {
    const products = parents(link.from.id, 'cluster_product'), teams = parents(link.to.id, 'cluster_team');
    if (products.length === 1 && teams.length === 1 && products[0].from.id !== teams[0].from.id) issues.push(problem(`/links/${i}`, 'PRODUCT_TEAM_CLUSTER_MISMATCH', entityRef(link.from.id)));
  }
  return issues;
}

/** Explicit mapping addendum to T16: arbitrary canonical dimension names cannot identify product keys.
 * This pure function consumes a caller-verified directory snapshot; publication selection is owned by
 * DirectoryStore. Keys match raw source + exact external key. NFC/trim is used ONLY to block ambiguous
 * directory aliases, never to guess a product from a similar name/key. */
export function enrichSourceRows({ capture: unparsedCapture, mapping: unparsedMapping, directoryEntities, directoryLinks }: { capture: SourceRowsForEnrichment; mapping: SourceFieldMapping; directoryEntities: DirectoryEntity[]; directoryLinks: DirectoryLink[] }): EnrichmentResult {
  const { sourceId, mappingRef, rawRows, canonicalRows } = unparsedCapture;
  const capture = sourceRowsSchema.parse({ sourceId, mappingRef, rawRows, canonicalRows }), mapping = sourceFieldMappingSchema.parse(unparsedMapping);
  if (mapping.sourceId !== capture.sourceId || mapping.id !== capture.mappingRef.id || mapping.revision !== capture.mappingRef.revision) throw new WorkbenchError('SOURCE_MAPPING_MISMATCH');
  const entities = directoryEntities.map(e => directoryEntitySchema.parse(e)); const links = directoryLinks.map(l => directoryLinkSchema.parse(l));
  const byId = new Map(entities.map(e => [e.id, e])); const rawByKey = new Map(capture.rawRows.map(row => [row.rowKey, row]));
  const graphIssues = validateDirectoryChanges({ entities, links }); const issues: FieldProblem[] = []; const usedLinks = new Map<string, VersionRef>();
  const rows: EnrichedRow[] = capture.canonicalRows.map((canonical, rowIndex) => {
    const row: EnrichedRow = { ...structuredClone(canonical), scope: null, directoryEntityRefs: [] }; const path = `/canonicalRows/${rowIndex}`;
    const raw = rawByKey.get(row.rowKey); if (!raw) { issues.push(problem(path, 'SOURCE_ROW_MISSING', null)); return row; }
    let scope: ScopeRef | null = mapping.fixedScope;
    if (!scope) {
      const key = mapping.productKeyField ? raw.cells[mapping.productKeyField]?.original : null;
      const aliases = key === undefined || key === null ? [] : entities.filter(e => e.kind === 'product' && e.externalKeys.some(k => k.sourceId === capture.sourceId && normalizedKey(k.key) === normalizedKey(key)));
      const matches = key === undefined || key === null ? [] : entities.filter(e => e.kind === 'product' && e.externalKeys.some(k => k.sourceId === capture.sourceId && k.key === key));
      if (aliases.length > 1) { issues.push(problem(path, 'AMBIGUOUS_PRODUCT', null)); return row; }
      if (matches.length !== 1) { issues.push(problem(path, 'UNMAPPED_PRODUCT', null)); return row; }
      scope = { kind: 'product', id: matches[0].id };
    }
    if (byId.get(scope.id)?.kind !== scope.kind) { issues.push(problem(path, 'UNMAPPED_SCOPE', entityRef(scope.id))); return row; }
    const included = new Set([scope.id]); const relevant = new Map<string, DirectoryLink>();
    // Ascend only declared parent relationships; siblings never become extra contributions.
    const pending = [scope.id];
    while (pending.length) {
      const id = pending.pop()!;
      for (const link of links) if (link.kind !== 'leader' && link.kind !== 'product_team' && link.to.id === id) {
        relevant.set(link.id, link); if (!included.has(link.from.id)) { included.add(link.from.id); pending.push(link.from.id); }
      }
    }
    const mandatoryIds = new Set(included);
    const failures = graphIssues.filter(p => !p.ref || p.ref.entityType === 'directory_entity' && mandatoryIds.has(p.ref.id));
    if (failures.length) { issues.push(...failures.map(p => ({ ...p, path }))); return row; }
    for (const link of links) if (link.kind === 'product_team' && link.from.id === scope.id) {
      const team = byId.get(link.to.id); const cluster = links.find(l => l.kind === 'cluster_team' && l.to.id === link.to.id);
      if (team?.kind === 'team' && cluster?.kind === 'cluster_team' && mandatoryIds.has(cluster.from.id)) { included.add(team.id); relevant.set(link.id, link); relevant.set(cluster.id, cluster); }
    }
    for (const link of links) if (link.kind === 'leader' && included.has(link.scope.id)) { included.add(link.personId); relevant.set(link.id, link); }
    row.scope = { ...scope }; row.directoryEntityRefs = [...included].map(id => byId.get(id)!).filter(Boolean).map(e => version('directory_entity', e)).sort((a, b) => a.id.localeCompare(b.id));
    for (const link of relevant.values()) usedLinks.set(link.id, version('directory_link', link));
    return row;
  });
  return { rows, issues, directoryLinkRefs: [...usedLinks.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}
