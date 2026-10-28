import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import type { SourceFieldMapping } from '../../domain/workbench/entities/sources';
import type { DirectoryEntity, DirectoryLink } from '../../domain/workbench/entities/directory';
import { defaultSourceParsingProfile, canonicalSourceRowSchema, rawSourceRowSchema } from '../../domain/workbench/schemas/sources';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';
import { parseWorkbenchTable, type ParsedSourceTable } from '../tabular-import/workbench-parser';
import { normalizeParsedWorkbenchTable } from './workbench-source-normalizer';
import { createBrowserExportPreview } from './workbench-browser-export';
import type { BrowserRuntimePort } from './workbench-browser-runtime';
import { privateProfileSchema } from './contracts';
import { enrichSourceRows } from '../catalog/workbench-directory';

const mapping: SourceFieldMapping = { ...makeHeader(15), sourceId: fixtureId(14), rowKeyFields: ['Product', 'Slice'], dimensionFields: { product: 'Product', slice: 'Slice' }, productKeyField: 'Product', fixedScope: null,
  metricFields: [{ metricId: fixtureId(2), fields: { value: 'Value' } }], dateField: 'Date', periodStartField: null, periodEndField: null, unitField: 'Unit', fixedUnitCode: null,
  parsingProfile: { ...defaultSourceParsingProfile, csvDelimiter: ';', decimalSeparator: ',', groupSeparator: 'space', dateFormat: 'dd.mm.yyyy' } };
const csv = (text: string, profile = mapping.parsingProfile!) => parseWorkbenchTable({ bytes: Buffer.from(text), name: 'synthetic.csv', parsingProfile: profile });

it('maps saved tuple keys, exact profile numbers, original dimensions, explicit dates and field units without mutating raw cells', async () => {
  const table = await csv('Product;Slice;Value;Date;Unit\nA;primary;1 234,50;31.10.2026;%');
  const before = structuredClone(table), result = normalizeParsedWorkbenchTable({ table, mapping });
  expect(result.rawRows[0]).toEqual({ rowKey: '["A","primary"]', cells: table.rows[0].cells });
  expect(result.canonicalRows[0]).toEqual({ rowKey: '["A","primary"]', dimensions: { product: 'A', slice: 'primary' }, numbers: { value: '1234.5' }, businessTime: { kind: 'as_of', date: '2026-10-31' }, unitCode: '%' });
  expect(result.rawRows[0].cells.Value.original).toBe('1 234,50'); expect(result.issues).toEqual([]); expect(table).toEqual(before);
  expect(rawSourceRowSchema.safeParse(result.rawRows[0]).success).toBe(true); expect(canonicalSourceRowSchema.safeParse(result.canonicalRows[0]).success).toBe(true);
});

it('uses unambiguous JSON tuples rather than joined keys or row ordinals', async () => {
  const table = await csv('Product;Slice;Value;Date;Unit\na|b;c;1;;%\na;b|c;2;;%');
  const result = normalizeParsedWorkbenchTable({ table, mapping });
  expect(result.rawRows.map(row => row.rowKey)).toEqual(['["a|b","c"]', '["a","b|c"]']);
  expect(result.canonicalRows.map(row => row.businessTime)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]);
});

it('keeps invalid and missing values null, with row diagnostics for invalid numbers and dates', async () => {
  const table = await csv('Product;Slice;Value;Date;Unit\nA;one;broken;30.02.2026;%\nB;two;;;%');
  const result = normalizeParsedWorkbenchTable({ table, mapping });
  expect(result.canonicalRows.map(row => row.numbers.value)).toEqual([null, null]);
  expect(result.canonicalRows.map(row => row.businessTime)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]);
  expect(result.issues.map(issue => ({ code: issue.code, rowKeys: issue.rowKeys }))).toEqual([
    { code: 'INVALID_NUMBER', rowKeys: ['["A","one"]'] }, { code: 'INVALID_BUSINESS_DATE', rowKeys: ['["A","one"]'] },
  ]);
});

it('uses exact OOXML numbers and explicit 1904 metadata independently of CSV numeric locale', async () => {
  const book = new ExcelJS.Workbook(); book.properties.date1904 = true;
  book.addWorksheet('Export').addRows([['Product', 'Slice', 'Value', 'Date', 'Unit'], ['A', 'one', 92, 0, '%']]);
  const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml')!.async('string')).replace('<v>92</v>', '<v>1.234567890123456789E+19</v>'));
  const serialMapping: SourceFieldMapping = { ...mapping, parsingProfile: { ...mapping.parsingProfile!, dateFormat: 'excel-serial' }, fixedUnitCode: 'saved-unit' };
  const table = await parseWorkbenchTable({ bytes: await zip.generateAsync({ type: 'nodebuffer' }), name: 'synthetic.xlsx', parsingProfile: serialMapping.parsingProfile! });
  const result = normalizeParsedWorkbenchTable({ table, mapping: serialMapping });
  expect(result.canonicalRows[0].numbers.value).toBe('12345678901234567890');
  expect(result.canonicalRows[0].businessTime).toEqual({ kind: 'as_of', date: '1904-01-01' });
  expect(result.canonicalRows[0].unitCode).toBe('saved-unit'); expect(result.issues).toEqual([]);
});

it('does not assume an Excel date epoch for CSV', async () => {
  const serialMapping: SourceFieldMapping = { ...mapping, parsingProfile: { ...mapping.parsingProfile!, dateFormat: 'excel-serial' } };
  const table = await csv('Product;Slice;Value;Date;Unit\nA;one;92;61;%', serialMapping.parsingProfile!);
  const result = normalizeParsedWorkbenchTable({ table, mapping: serialMapping });
  expect(result.canonicalRows[0].businessTime).toEqual({ kind: 'unknown' }); expect(result.issues[0].code).toBe('INVALID_BUSINESS_DATE');
});

it('uses explicit period bounds and leaves partial or reversed periods unknown', async () => {
  const periodMapping: SourceFieldMapping = { ...mapping, dateField: null, periodStartField: 'Start', periodEndField: 'End', parsingProfile: { ...mapping.parsingProfile!, dateFormat: 'iso' } };
  const table = await csv('Product;Slice;Value;Start;End;Unit\nA;one;92;2026-10-01;2026-11-01;%\nB;two;93;2026-11-01;2026-10-01;%\nC;three;94;2026-10-01;;%', periodMapping.parsingProfile!);
  const result = normalizeParsedWorkbenchTable({ table, mapping: periodMapping });
  expect(result.canonicalRows.map(row => row.businessTime)).toEqual([{ kind: 'period', startInclusive: '2026-10-01', endExclusive: '2026-11-01' }, { kind: 'unknown' }, { kind: 'unknown' }]);
  expect(result.issues.map(issue => issue.code)).toEqual(['INVALID_BUSINESS_DATE', 'INVALID_BUSINESS_DATE']);
});

it.each(['Product', 'Slice', 'Value', 'Date', 'Unit'])('rejects a missing mapped column %s before normalizing', async missing => {
  const table = await csv('Product;Slice;Value;Date;Unit\nA;one;92;31.10.2026;%');
  const changed: ParsedSourceTable = { ...table, columns: table.columns.filter(column => column !== missing) };
  expect(() => normalizeParsedWorkbenchTable({ table: changed, mapping })).toThrowError(expect.objectContaining({ code: 'SOURCE_SCHEMA_CHANGED' }));
});

it.each([
  { text: 'Product;Slice;Value;Date;Unit\nA;;92;;%', code: 'SOURCE_ROW_KEY_MISSING' },
  { text: 'Product;Slice;Value;Date;Unit\nA;one;92;;%\nA;one;93;;%', code: 'SOURCE_DUPLICATE_ROW_KEY' },
])('rejects invalid row identity with $code instead of inventing a business key', async ({ text, code }) => {
  const table = await csv(text);
  expect(() => normalizeParsedWorkbenchTable({ table, mapping })).toThrowError(expect.objectContaining({ code }));
});

it('rejects conflicting flat numeric mappings and ambiguous date/period configuration', async () => {
  const table = await csv('Product;Slice;Value;Date;Unit\nA;one;92;31.10.2026;%');
  const conflicting: SourceFieldMapping = { ...mapping, metricFields: [...mapping.metricFields, { metricId: fixtureId(3), fields: { value: 'Slice' } }] };
  expect(() => normalizeParsedWorkbenchTable({ table, mapping: conflicting })).toThrowError(expect.objectContaining({ code: 'SOURCE_INVALID_CONFIGURATION' }));
  expect(() => normalizeParsedWorkbenchTable({ table, mapping: { ...mapping, periodStartField: 'Date', periodEndField: 'Date' } })).toThrowError(expect.objectContaining({ code: 'SOURCE_INVALID_CONFIGURATION' }));
});

it('previews a browser CSV through exact mapping and directory enrichment without fabricating a Capture', async () => {
  const unavailable = async (): Promise<never> => { throw Error('Only replay is needed'); };
  const runtime: BrowserRuntimePort = { openLogin: unavailable, startRecording: unavailable, finish: unavailable, screenshot: unavailable, waitForCompletion: unavailable, closeOwned: unavailable,
    replay: async () => ({ name: 'oko.csv', contentType: 'text/csv', bytes: Buffer.from('Product;Slice;Value;Date;Unit\nA;one;12345678901234567890,001;31.10.2026;%') }) };
  const preview = await createBrowserExportPreview({ runtime }).run({ owner: { installationId: fixtureId(1), profilePersonId: null }, profile: privateProfileSchema.parse({ allowedOrigins: ['https://synthetic.invalid'], timeoutMs: 1000 }), parsingProfile: mapping.parsingProfile!,
    scenario: { ...makeHeader(44), sourceId: mapping.sourceId, startUrl: 'https://synthetic.invalid/report', authenticatedSelector: '#ready', steps: [{ action: 'download', locator: { kind: 'css', selector: '#export' } }], parameters: {}, expectedExport: { format: 'csv', requiredColumns: ['Product', 'Slice', 'Value', 'Date', 'Unit'] } } }, new AbortController().signal);
  const normalized = normalizeParsedWorkbenchTable({ table: preview.table, mapping });
  const directoryEntities: DirectoryEntity[] = [
    { ...makeHeader(100), kind: 'dit', name: 'Synthetic DIT', externalKeys: [] },
    { ...makeHeader(101), kind: 'cluster', name: 'Synthetic cluster', externalKeys: [] },
    { ...makeHeader(102), kind: 'product', name: 'Synthetic product', externalKeys: [{ sourceId: mapping.sourceId, key: 'A' }] },
    { ...makeHeader(103), kind: 'person', name: 'Synthetic leader', externalKeys: [] },
  ];
  const ref = (seed: number) => ({ entityType: 'directory_entity', id: fixtureId(seed) });
  const directoryLinks: DirectoryLink[] = [
    { ...makeHeader(110), kind: 'dit_cluster', from: ref(100), to: ref(101) },
    { ...makeHeader(111), kind: 'cluster_product', from: ref(101), to: ref(102) },
    { ...makeHeader(112), kind: 'leader', scope: { kind: 'cluster', id: fixtureId(101) }, personId: fixtureId(103) },
    { ...makeHeader(113), kind: 'leader', scope: { kind: 'product', id: fixtureId(102) }, personId: fixtureId(103) },
  ];
  const enriched = enrichSourceRows({ capture: { sourceId: mapping.sourceId, mappingRef: { entityType: 'source_field_mapping', id: mapping.id, revision: mapping.revision }, rawRows: normalized.rawRows, canonicalRows: normalized.canonicalRows }, mapping, directoryEntities, directoryLinks });
  expect(normalized.issues).toEqual([]); expect(enriched.issues).toEqual([]); expect(enriched.rows).toHaveLength(1);
  expect(enriched.rows[0]).toMatchObject({ rowKey: '["A","one"]', numbers: { value: '12345678901234567890.001' }, scope: { kind: 'product', id: fixtureId(102) }, businessTime: { kind: 'as_of', date: '2026-10-31' } });
  expect(normalized.rawRows[0].cells.Value.original).toBe('12345678901234567890,001');
  expect(preview.table.rows[0].cells.Date.original).toBe('31.10.2026');
  expect(preview).not.toHaveProperty('complete'); expect(enriched).not.toHaveProperty('complete');
});
