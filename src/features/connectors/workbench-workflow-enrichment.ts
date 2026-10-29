import type { DirectoryEntity, DirectoryLink, SourceFieldMapping } from '../../domain/workbench/entities';
import type { Header } from '../../domain/workbench/primitives';
import { uuidSchema } from '../../domain/workbench/primitives';
import type { FieldProblem } from '../../server/workbench/protocol';
import { enrichSourceRows, validateDirectoryChanges } from '../catalog/workbench-directory';
import type { ParsedSourceTable } from '../tabular-import/workbench-parser';
import { normalizeParsedWorkbenchTable } from './workbench-source-normalizer';

export type OkoPreviewRow = Record<string, string | null>;
export type OkoPreviewDirectory = { entities: DirectoryEntity[]; links: DirectoryLink[]; issues: FieldProblem[] };
const problem = (path: string, code: string, message: string): FieldProblem => ({ path, code, message, ref: null });
/** Builds only a private preview graph. All entity identities come verbatim from the file;
 * link IDs are reserved by the server and never published by this adapter. */
export function buildOkoPreviewDirectory({ rows, sourceId, header, newId, previousLinks = [] }: { rows: OkoPreviewRow[]; sourceId: string; header: Header; newId(): string; previousLinks?: DirectoryLink[] }): OkoPreviewDirectory {
  const entities = new Map<string, DirectoryEntity>(), links = new Map<string, DirectoryLink>(), issues: FieldProblem[] = [];
  const addEntity = (id: string | null | undefined, name: string | null | undefined, kind: DirectoryEntity['kind'], at: string, externalKey?: string | null): string | null => {
    if (!uuidSchema.safeParse(id).success) { issues.push(problem(at, 'DIRECTORY_UUID_REQUIRED', 'Идентификатор справочника должен быть явно задан UUID.')); return null; }
    if (!name?.trim()) { issues.push(problem(at, 'DIRECTORY_VALUE_REQUIRED', 'Не задано название сущности справочника.')); return null; }
    const existing = entities.get(id!);
    if (existing && (existing.kind !== kind || existing.name !== name)) { issues.push(problem(at, 'DIRECTORY_GRAPH_AMBIGUOUS', 'Один UUID имеет разные имена или виды сущности.')); return null; }
    const entity = existing ?? { ...header, id: id!, kind, name, externalKeys: [] };
    if (kind === 'product' && externalKey?.trim() && !entity.externalKeys.some(key => key.sourceId === sourceId && key.key === externalKey)) entity.externalKeys.push({ sourceId, key: externalKey });
    entities.set(id!, entity); return id!;
  };
  const edge = (kind: 'dit_cluster' | 'cluster_product' | 'cluster_team' | 'product_team', from: string | null, to: string | null) => { if (!from || !to) return; const key = JSON.stringify([kind, from, to]); if (!links.has(key)) links.set(key, { ...header, id: newId(), kind, from: { entityType: 'directory_entity', id: from }, to: { entityType: 'directory_entity', id: to } }); };
  const leader = (kind: 'cluster' | 'product', scope: string | null, personId: string | null) => { if (!scope || !personId) return; const key = JSON.stringify(['leader', kind, scope, personId]); if (!links.has(key)) links.set(key, { ...header, id: newId(), kind: 'leader', scope: { kind, id: scope }, personId }); };
  rows.forEach((row, index) => {
    const at = `/dictionary/rows/${index}`;
    if (!row.key?.trim()) issues.push(problem(at + '/key', 'DIRECTORY_VALUE_REQUIRED', 'Не задан внешний ключ продукта.'));
    const dit = addEntity(row.ditId, row.ditName, 'dit', at + '/ditId');
    const cluster = addEntity(row.clusterId, row.clusterName, 'cluster', at + '/clusterId');
    const product = addEntity(row.productId, row.productName, 'product', at + '/productId', row.key);
    const clusterLeader = addEntity(row.clusterLeaderId, row.clusterLeaderName, 'person', at + '/clusterLeaderId');
    const productLeader = addEntity(row.productLeaderId, row.productLeaderName, 'person', at + '/productLeaderId');
    edge('dit_cluster', dit, cluster); edge('cluster_product', cluster, product); leader('cluster', cluster, clusterLeader); leader('product', product, productLeader);
    if (row.teamId || row.teamName) { const team = addEntity(row.teamId, row.teamName, 'team', at + '/teamId'); edge('cluster_team', cluster, team); edge('product_team', product, team); }
  });
  const result = { entities: [...entities.values()], links: [...links.values()], issues };
  result.issues.push(...validateDirectoryChanges({ entities: result.entities, links: result.links, previousLinks }));
  return result;
}

/** Reuses the normalizer and exact directory traversal used by accepted sources. */
export function previewOkoTable({ table, mapping, directory }: { table: ParsedSourceTable; mapping: SourceFieldMapping; directory: OkoPreviewDirectory }): { rows: OkoPreviewRow[]; issues: FieldProblem[]; unresolvedRows: number; sourceDate: string | null } {
  const normalized = normalizeParsedWorkbenchTable({ table, mapping });
  // Invalid private input remains a diagnostic preview, never a partially trusted graph.
  const enriched = enrichSourceRows({ capture: { sourceId: mapping.sourceId, mappingRef: { entityType: 'source_field_mapping', id: mapping.id, revision: mapping.revision }, rawRows: normalized.rawRows, canonicalRows: normalized.canonicalRows }, mapping, directoryEntities: directory.issues.length ? [] : directory.entities, directoryLinks: directory.issues.length ? [] : directory.links });
  const rowIndex = new Map(normalized.rawRows.map((row, index) => [row.rowKey, index]));
  const issues: FieldProblem[] = [...directory.issues, ...normalized.issues.flatMap(issue => issue.rowKeys.map(key => problem(`/rows/${rowIndex.get(key) ?? 0}`, issue.code, issue.message))), ...enriched.issues];
  const failed = new Set<number>();
  for (const issue of normalized.issues) for (const key of issue.rowKeys) { const index = rowIndex.get(key); if (index !== undefined) failed.add(index); }
  for (const issue of enriched.issues) { const match = /^\/canonicalRows\/(\d+)/.exec(issue.path); if (match) failed.add(Number(match[1])); }
  const byId = new Map(directory.entities.map(entity => [entity.id, entity]));
  const dates = new Set<string>();
  let allDated = true;
  const rows = enriched.rows.map((canonical, index) => {
    const raw = normalized.rawRows[index]; const original: OkoPreviewRow = Object.fromEntries(table.columns.map(column => [column, raw.cells[column]?.original ?? null]));
    const row: OkoPreviewRow = {};
    // Source headers retain their exact names. Prefix derived collisions repeatedly,
    // including source headers that already use the escape prefix.
    const retain = () => { for (const [field, value] of Object.entries(row)) { let name = field; while (Object.hasOwn(original, name)) name = 'derived.' + name; original[name] = value; } return original; };
    row.rowKey = canonical.rowKey;
    for (const [field, value] of Object.entries(canonical.dimensions)) row['dimension.' + field] = value;
    for (const [field, value] of Object.entries(canonical.numbers)) { row['number.' + field] = value; if (value === null) { failed.add(index); if (!normalized.issues.some(issue => issue.code === 'INVALID_NUMBER' && issue.rowKeys.includes(canonical.rowKey))) issues.push(problem(`/rows/${index}/${field}`, 'MISSING_NUMBER', 'Числовое значение отсутствует.')); } }
    row.unitCode = canonical.unitCode; row.sourceDate = canonical.businessTime.kind === 'as_of' ? canonical.businessTime.date : null;
    if (row.sourceDate !== null) dates.add(row.sourceDate);
    else { allDated = false; if (mapping.dateField !== null) { failed.add(index); if (!normalized.issues.some(issue => issue.code === 'INVALID_BUSINESS_DATE' && issue.rowKeys.includes(canonical.rowKey))) issues.push(problem(`/rows/${index}/sourceDate`, 'MISSING_BUSINESS_DATE', 'Дата источника отсутствует.')); } }
    if (directory.issues.length) { failed.add(index); return retain(); }
    if (canonical.scope === null) { failed.add(index); return retain(); }
    const related = canonical.directoryEntityRefs.map(ref => byId.get(ref.id)!).filter(Boolean);
    for (const kind of ['dit', 'cluster', 'product'] as const) { const entity = related.find(value => value.kind === kind); if (entity) { row[`directory.${kind}Id`] = entity.id; row[`directory.${kind}Name`] = entity.name; } }
    for (const kind of ['cluster', 'product'] as const) { const scope = related.find(value => value.kind === kind); const link = directory.links.find(link => link.kind === 'leader' && link.scope.id === scope?.id); if (link?.kind === 'leader') { row[`directory.${kind}LeaderId`] = link.personId; row[`directory.${kind}LeaderName`] = byId.get(link.personId)?.name ?? null; } }
    const teams = related.filter(entity => entity.kind === 'team').sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.id.localeCompare(b.id));
    row['directory.teamIds'] = teams.length ? teams.map(team => team.id).join(' | ') : null;
    row['directory.teamNames'] = teams.length ? teams.map(team => team.name).join(' | ') : null;
    if (teams.length === 1) { row['directory.teamId'] = teams[0].id; row['directory.teamName'] = teams[0].name; }
    return retain();
  });
  return { rows, issues, unresolvedRows: failed.size, sourceDate: dates.size === 1 && allDated ? [...dates][0] : null };
}

const safeCsvText = (value: string): string => /^[\t\r\n]/.test(value) || /^\s*[=+@]/.test(value) || /^\s*-/.test(value) && !/^-\d+(?:[.,]\d+)?$/.test(value) ? "'" + value : value;
/** Neutralization affects only the derived spreadsheet CSV. Original bytes remain untouched. */
export const serializeOkoEnrichedCsv = (rows: OkoPreviewRow[], columns: string[]): Buffer => Buffer.from('\ufeff' + [columns, ...rows.map(row => columns.map(column => row[column] ?? ''))].map(row => row.map(value => '"' + safeCsvText(String(value)).replace(/"/g, '""') + '"').join(';')).join('\r\n'), 'utf8');
