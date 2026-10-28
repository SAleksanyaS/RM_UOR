import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import type { BrowserScenarioDefinition } from '../../domain/workbench/browser-scenario';
import { defaultSourceParsingProfile } from '../../domain/workbench/schemas/sources';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';
import type { Downloaded } from './transport';
import { privateProfileSchema } from './contracts';
import type { BrowserReplayInput, BrowserRuntimePort } from './workbench-browser-runtime';
import { createBrowserExportPreview, validateBrowserExport } from './workbench-browser-export';

const parsingProfile = { ...defaultSourceParsingProfile, csvDelimiter: ';' as const };
const scenario: BrowserScenarioDefinition = { ...makeHeader(44), sourceId: fixtureId(45), startUrl: 'https://synthetic.invalid/report', authenticatedSelector: '#report', parameters: {},
  steps: [{ action: 'download', locator: { kind: 'css', selector: '#export' } }], expectedExport: { format: 'csv', requiredColumns: ['Product', 'Value'] } };
const csv: Downloaded = { name: 'export.csv', contentType: 'application/octet-stream', bytes: Buffer.from('Product;Value\r\nA;12345678901234567890.001\r\n') };
const replayInput: BrowserReplayInput = { owner: { installationId: fixtureId(1), profilePersonId: null }, profile: privateProfileSchema.parse({ allowedOrigins: ['https://synthetic.invalid'], timeoutMs: 1000 }), scenario };
function runtime(replay: BrowserRuntimePort['replay']): BrowserRuntimePort {
  const unavailable = async (): Promise<never> => { throw Error('This preview only uses replay'); };
  return { replay, openLogin: unavailable, startRecording: unavailable, finish: unavailable, screenshot: unavailable, waitForCompletion: unavailable, closeOwned: unavailable };
}

it('validates the explicit CSV profile and hashes original bytes without implying coverage', async () => {
  const result = await validateBrowserExport({ download: csv, scenario, parsingProfile });
  expect(result.table.rows[0].cells.Value).toEqual({ kind: 'text', original: '12345678901234567890.001' });
  expect(result.table.rows[0].coordinate).toEqual({ sheet: null, row: 2 });
  expect(result.payloadHash).toBe(createHash('sha256').update(csv.bytes).digest('hex'));
  expect(Object.keys(result).sort()).toEqual(['payloadHash', 'table']);
});

it('validates downloaded XLSX lexical values with the same parser', async () => {
  const book = new ExcelJS.Workbook(); book.addWorksheet('Export').addRows([['Product', 'Value'], ['A', 92]]);
  const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  zip.file('xl/worksheets/sheet1.xml', (await zip.file('xl/worksheets/sheet1.xml')!.async('string')).replace('<v>92</v>', '<v>12345678901234567890.001</v>'));
  const download: Downloaded = { name: 'export.xlsx', contentType: 'application/octet-stream', bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) };
  const result = await validateBrowserExport({ download, scenario: { ...scenario, expectedExport: { ...scenario.expectedExport, format: 'xlsx' } }, parsingProfile });
  expect(result.table.rows[0].cells.Value).toEqual({ kind: 'number', original: '12345678901234567890.001' });
  expect(result.table.dateSystem).toBe('1900');
  expect(result.payloadHash).toBe(createHash('sha256').update(download.bytes).digest('hex'));
});

it.each([
  { label: 'wrong filename format', download: { ...csv, name: 'export.xlsx' } },
  { label: 'changed required column', download: { ...csv, bytes: Buffer.from('Product;Renamed\nA;92') } },
  { label: 'HTML login masquerading as CSV', download: { ...csv, bytes: Buffer.from('<!DOCTYPE html><html>Login</html>') } },
  { label: 'empty file', download: { ...csv, bytes: Buffer.alloc(0) } },
  { label: 'header-only file', download: { ...csv, bytes: Buffer.from('Product;Value\n') } },
  { label: 'oversized file', download: { ...csv, bytes: Buffer.alloc(10 * 1024 ** 2 + 1, 97) } },
  { label: 'client path filename', download: { ...csv, name: 'C:\\private\\export.csv' } },
])('rejects $label with SOURCE_SCHEMA_CHANGED', async ({ download }) => {
  await expect(validateBrowserExport({ download, scenario, parsingProfile })).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_CHANGED' });
});

it('rejects HTML login masquerading as the expected XLSX format', async () => {
  await expect(validateBrowserExport({ download: { ...csv, name: 'export.xlsx', bytes: Buffer.from('<html>Login</html>') }, scenario: { ...scenario, expectedExport: { ...scenario.expectedExport, format: 'xlsx' } }, parsingProfile })).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_CHANGED' });
});

it('runs the browser replay port and returns only the named parsed preview', async () => {
  const service = createBrowserExportPreview({ runtime: runtime(async (input, signal) => {
    expect(input).toEqual(replayInput); expect(signal.aborted).toBe(false); return csv;
  }) });
  const result = await service.run({ ...replayInput, parsingProfile }, new AbortController().signal);
  expect(result.name).toBe('export.csv'); expect(result.table.rows).toHaveLength(1);
  expect(Object.keys(result).sort()).toEqual(['name', 'payloadHash', 'table']);
});

it('preserves replay failures instead of returning an apparent preview', async () => {
  const failure = Object.assign(Error('Synthetic authentication failure'), { code: 'manual_login_required' });
  const service = createBrowserExportPreview({ runtime: runtime(async () => { throw failure; }) });
  await expect(service.run({ ...replayInput, parsingProfile }, new AbortController().signal)).rejects.toBe(failure);
});

it('does not start cancelled replay and rejects a download returned after cancellation', async () => {
  const cancellation = new AbortController(); cancellation.abort(); let called = false;
  const first = createBrowserExportPreview({ runtime: runtime(async () => { called = true; return csv; }) });
  await expect(first.run({ ...replayInput, parsingProfile }, cancellation.signal)).rejects.toMatchObject({ name: 'AbortError' }); expect(called).toBe(false);
  const later = new AbortController();
  const second = createBrowserExportPreview({ runtime: runtime(async () => { later.abort(); return csv; }) });
  await expect(second.run({ ...replayInput, parsingProfile }, later.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
