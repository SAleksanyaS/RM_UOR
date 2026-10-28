import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Header } from '../../domain/workbench/primitives';
import type { SourceFieldMapping } from '../../domain/workbench/entities';
import { parseWorkbenchTable } from '../tabular-import/workbench-parser';
import { buildOkoPreviewDirectory, previewOkoTable, serializeOkoEnrichedCsv } from './workbench-workflow-enrichment';
const sourceId = randomUUID(), header: Header = { schemaVersion: 1, id: randomUUID(), revision: 1, recordedAt: '2026-10-28T10:00:00Z', actor: { hostname: 'test', installationId: randomUUID(), profilePersonId: randomUUID() }, publicationAnchorId: null };
const row = () => ({ key: 'P1', productId: randomUUID(), productName: 'Продукт', clusterId: randomUUID(), clusterName: 'Кластер', ditId: randomUUID(), ditName: 'ДИТ', clusterLeaderId: randomUUID(), clusterLeaderName: 'Руководитель кластера', productLeaderId: randomUUID(), productLeaderName: 'Руководитель продукта', teamId: randomUUID(), teamName: 'Команда А' });
const mapping: SourceFieldMapping = { ...header, sourceId, rowKeyFields: ['Key'], productKeyField: 'Key', fixedScope: null, dimensionFields: { label: 'Label' }, metricFields: [{ metricId: randomUUID(), fields: { value: 'Amount' } }], dateField: 'Date', periodStartField: null, periodEndField: null, unitField: null, fixedUnitCode: 'units', parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'dd.mm.yyyy', decimalSeparator: '.', groupSeparator: 'none' } };
it('deduplicates a repeated product across multiple teams and enriches once through exact core refs', async () => {
  const first = row(), second = { ...first, teamId: randomUUID(), teamName: 'Команда Б' };
  const directory = buildOkoPreviewDirectory({ rows: [first, second], sourceId, header, newId: randomUUID });
  expect(directory.issues).toEqual([]);
  expect(directory.entities.filter(entity => entity.kind === 'product')).toHaveLength(1);
  const table = await parseWorkbenchTable({ bytes: Buffer.from('Key;Amount;Date;Label\r\nP1;12345678901234567890.001;28.10.2026;Исходное написание'), name: 'report.csv', parsingProfile: mapping.parsingProfile! });
  const preview = previewOkoTable({ table, mapping, directory });
  expect(preview.rows).toHaveLength(1); expect(preview.unresolvedRows).toBe(0);
  expect(preview.rows[0]).toMatchObject({ Amount: '12345678901234567890.001', 'number.value': '12345678901234567890.001', 'dimension.label': 'Исходное написание', sourceDate: '2026-10-28', 'directory.productId': first.productId, 'directory.teamNames': 'Команда А | Команда Б' });
  expect(preview.sourceDate).toBe('2026-10-28');
});
it('rejects conflicting names for one person UUID across leader roles and does not guess missing values', async () => {
  const first = row(); first.productLeaderId = first.clusterLeaderId;
  const directory = buildOkoPreviewDirectory({ rows: [first], sourceId, header, newId: randomUUID });
  expect(directory.issues.some(issue => issue.code === 'DIRECTORY_GRAPH_AMBIGUOUS')).toBe(true);
  const table = await parseWorkbenchTable({ bytes: Buffer.from('Key;Amount;Date;Label\r\nP1;unknown;28.10.2026;Не менять'), name: 'report.csv', parsingProfile: mapping.parsingProfile! });
  const preview = previewOkoTable({ table, mapping, directory });
  expect(preview.unresolvedRows).toBe(1); expect(preview.rows[0].Amount).toBe('unknown'); expect(preview.rows[0]['number.value']).toBeNull(); expect(preview.rows[0]['directory.productId']).toBeUndefined();
});
it('does not infer product aliases or permit a team to silently move across clusters', () => {
  const first = row(), moved = { ...first, key: 'P2', productId: randomUUID(), productName: 'Другой', clusterId: randomUUID(), clusterName: 'Другой кластер' };
  const directory = buildOkoPreviewDirectory({ rows: [first, moved], sourceId, header, newId: randomUUID });
  expect(directory.issues.some(issue => issue.code === 'TEAM_CLUSTER_MOVE_UNSUPPORTED' || issue.code === 'PRODUCT_TEAM_CLUSTER_MISMATCH')).toBe(true);
});
it('neutralizes formula-like enriched text and headers while retaining exact negative decimal strings', () => {
  const rows = [{ '=Header': '=1+1', plus: '+SUM(A1)', at: '@value', tab: '\ttext', minus: '-1+2', negative: '-12345678901234567890.001', normal: 'Исходный текст' }];
  const csv = serializeOkoEnrichedCsv(rows, Object.keys(rows[0])).toString('utf8');
  for (const text of ["'=Header", "'=1+1", "'+SUM(A1)", "'@value", "'\ttext", "'-1+2"]) expect(csv).toContain(text);
  expect(csv).toContain('"-12345678901234567890.001"'); expect(csv).toContain('Исходный текст');
});
it('keeps structurally invalid dictionary cells diagnostic rather than throwing during source preview', async () => {
  const invalid = row(); invalid.key = ' ';
  const directory = buildOkoPreviewDirectory({ rows: [invalid], sourceId, header, newId: randomUUID });
  expect(directory.issues.length).toBeGreaterThan(0);
  const table = await parseWorkbenchTable({ bytes: Buffer.from('Key;Amount;Date;Label\r\nP1;1;28.10.2026;raw'), name: 'report.csv', parsingProfile: mapping.parsingProfile! });
  expect(previewOkoTable({ table, mapping, directory }).unresolvedRows).toBe(1);
});
