import type { RawCell, SourceFieldMapping } from '../../domain/workbench/entities/sources';
import { moscowDateSchema, type Decimal, type MoscowDate } from '../../domain/workbench/primitives';
import { canonicalDecimal } from '../../domain/workbench/exact-number';
import { addMoscowDays } from '../../domain/workbench/time';
import { sourceParsingProfileSchema } from '../../domain/workbench/schemas/sources';
import JSZip from 'jszip';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import path from 'node:path';
import { validateFileContent } from '../../server/workbench/file-content-safety';
import { defaultFileLimits } from '../../server/workbench/files';

export type ParsedSourceTable = {
  format: 'csv' | 'xlsx'; sheet: string | null; columns: string[];
  rows: Array<{ coordinate: { sheet: string | null; row: number }; cells: Record<string, RawCell> }>;
  dateSystem: '1900' | '1904' | null;
};
export type ParsingProfile = NonNullable<SourceFieldMapping['parsingProfile']>;
export class WorkbenchParserError extends Error {
  constructor(readonly code: 'INVALID_TABLE' | 'INVALID_ENCODING' | 'INVALID_NUMBER' | 'INVALID_DATE' | 'INVALID_PROFILE' | 'TABLE_LIMIT_EXCEEDED' | 'UNSUPPORTED_FORMAT' | 'UNSUPPORTED_CELL' | 'SOURCE_SHEET_REQUIRED' | 'SOURCE_SHEET_MISSING', message: string) { super(message); this.name = 'WorkbenchParserError'; }
}
function fail(code: WorkbenchParserError['code'], message: string): never { throw new WorkbenchParserError(code, message); }
const MAX_BYTES = 10 * 1024 ** 2, MAX_ROWS = 20000, MAX_COLUMNS = 100, MAX_CELL = 10000;
const spreadsheetNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const documentRelationshipNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelationshipNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const forbiddenControls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

/** Source strings stay untouched. This explicit conversion accepts no surrounding whitespace. */
export function parseWorkbenchNumber(value: string, profile: ParsingProfile): Decimal {
  if (!sourceParsingProfileSchema.safeParse(profile).success) fail('INVALID_PROFILE', 'Invalid saved parsing profile');
  if (typeof value !== 'string' || !value.length || value.length > MAX_CELL) fail('INVALID_NUMBER', 'Invalid decimal value');
  const negative = value.startsWith('-'), unsigned = negative ? value.slice(1) : value;
  const parts = unsigned.split(profile.decimalSeparator);
  if (parts.length > 2 || parts.length === 2 && !/^\d+$/.test(parts[1])) fail('INVALID_NUMBER', 'Invalid decimal fraction');
  const group = { none: '', space: ' ', nbsp: '\u00a0', comma: ',', dot: '.' }[profile.groupSeparator];
  let integer = parts[0];
  if (group && integer.includes(group)) {
    const groups = integer.split(group);
    if (!/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some(part => !/^\d{3}$/.test(part))) fail('INVALID_NUMBER', 'Invalid decimal grouping');
    integer = groups.join('');
  }
  if (!/^\d+$/.test(integer)) fail('INVALID_NUMBER', 'Invalid decimal digits');
  return canonicalDecimal((negative ? '-' : '') + integer + (parts.length === 2 ? '.' + parts[1] : ''));
}

/** OOXML machine numbers always use dot/exponent syntax, never the display locale or styles. */
export function parseXlsxNumber(value: string): Decimal {
  if (typeof value !== 'string' || !value.length || value.length > MAX_CELL) fail('INVALID_NUMBER', 'Invalid OOXML numeric token');
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || (match[5]?.replace(/^[+-]/, '').replace(/^0+/, '').length ?? 0) > 5) fail('INVALID_NUMBER', 'Invalid OOXML numeric token');
  const exponent = Number(match[5] ?? '0');
  if (Math.abs(exponent) > MAX_CELL) fail('INVALID_NUMBER', 'OOXML exponent exceeds the supported precision bound');
  const whole = match[2] ?? '0', fraction = match[3] ?? match[4] ?? '', digits = whole + fraction, point = whole.length + exponent;
  if (digits.length + Math.max(0, -point, point - digits.length) > MAX_CELL) fail('INVALID_NUMBER', 'OOXML number exceeds the supported precision bound');
  const decimal = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
  return canonicalDecimal((match[1] === '-' ? '-' : '') + decimal);
}

/** Excel serials are date-only integers and require trusted workbook epoch metadata. */
export function parseWorkbenchDate(value: string, format: ParsingProfile['dateFormat'], dateSystem?: '1900' | '1904' | null): MoscowDate {
  let date: string;
  if (format === 'iso') date = value;
  else if (format === 'dd.mm.yyyy') {
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
    if (!match) fail('INVALID_DATE', 'Expected DD.MM.YYYY'); date = match[3] + '-' + match[2] + '-' + match[1];
  } else if (format === 'excel-serial') {
    if (dateSystem !== '1900' && dateSystem !== '1904') fail('INVALID_DATE', 'Date serial requires an explicit workbook epoch');
    let normalized: string; try { normalized = parseXlsxNumber(value); } catch { return fail('INVALID_DATE', 'Invalid date serial'); }
    if (!/^(?:0|[1-9]\d{0,6})$/.test(normalized)) fail('INVALID_DATE', 'Date serial requires a bounded integer');
    const serial = Number(normalized);
    if (serial > 2958465 || dateSystem === '1900' && (serial === 0 || serial === 60)) fail('INVALID_DATE', 'Unsupported Excel calendar date');
    try { date = addMoscowDays(dateSystem === '1904' ? '1904-01-01' : '1899-12-31', serial - (dateSystem === '1900' && serial > 60 ? 1 : 0)); }
    catch { return fail('INVALID_DATE', 'Date serial is outside the supported calendar'); }
  } else return fail('INVALID_PROFILE', 'Unsupported date profile');
  if (!moscowDateSchema.safeParse(date).success) fail('INVALID_DATE', 'Expected an existing complete calendar date'); return date;
}

type CellsRow = { row: number; cells: RawCell[] };
function headers(cells: RawCell[]): string[] {
  const columns = cells.map(cell => cell.original ?? '');
  if (!columns.length || columns.some(column => !column.trim()) || new Set(columns.map(column => column.trim().normalize('NFKC').toLocaleLowerCase('ru'))).size !== columns.length) fail('INVALID_TABLE', 'Headers must be nonempty and unique');
  return columns;
}
function result(format: 'csv' | 'xlsx', sheet: string | null, rows: CellsRow[], dateSystem: ParsedSourceTable['dateSystem']): ParsedSourceTable {
  if (!rows.length) fail('INVALID_TABLE', 'The table has no header');
  const columns = headers(rows[0].cells), data = rows.slice(1);
  if (!data.length) fail('INVALID_TABLE', 'The table has no data rows');
  if (data.some(row => row.cells.length !== columns.length)) fail('INVALID_TABLE', 'Row width differs from the header');
  return { format, sheet, columns, dateSystem, rows: data.map(row => ({ coordinate: { sheet, row: row.row }, cells: Object.fromEntries(columns.map((column, index) => [column, row.cells[index]])) })) };
}
function decodeCsv(bytes: Uint8Array, encoding: ParsingProfile['csvEncoding']): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff || encoding === 'windows1251' && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('INVALID_ENCODING', 'The file BOM differs from its saved encoding');
  let text: string;
  try { text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : 'windows-1251', { fatal: true }).decode(bytes); }
  catch { return fail('INVALID_ENCODING', 'The file is not valid in its saved encoding'); }
  if (forbiddenControls.test(text)) fail('INVALID_ENCODING', 'The file contains unsupported control characters');
  return text.replace(/^\ufeff/, '');
}
function csvRows(text: string, delimiter: ParsingProfile['csvDelimiter']): CellsRow[] {
  const rows: CellsRow[] = []; let values: RawCell[] = [], value = '', quoted = false, closed = false, line = 1, recordLine = 1, records = 0;
  const finishCell = () => {
    values.push({ kind: value === '' ? 'blank' : 'text', original: value }); value = ''; closed = false;
    if (values.length > MAX_COLUMNS) fail('TABLE_LIMIT_EXCEEDED', 'The table exceeds 100 columns');
  };
  const finishRow = () => {
    finishCell(); if (++records > MAX_ROWS + 1) fail('TABLE_LIMIT_EXCEEDED', 'The table exceeds 20000 data records');
    if (values.some(cell => cell.original !== '')) rows.push({ row: recordLine, cells: values }); values = [];
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '"') { if (text[at + 1] === '"') { value += '"'; at++; } else { quoted = false; closed = true; } }
      else { value += char; if (char === '\n' || char === '\r' && text[at + 1] !== '\n') line++; }
    } else if (char === delimiter) finishCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[at + 1] === '\n') at++; finishRow(); line++; recordLine = line;
    } else if (char === '"') { if (value || closed) fail('INVALID_TABLE', 'Unexpected CSV quote'); quoted = true; }
    else { if (closed) fail('INVALID_TABLE', 'Unexpected text after CSV quote'); value += char; }
    if (value.length > MAX_CELL) fail('TABLE_LIMIT_EXCEEDED', 'A table cell exceeds 10000 characters');
  }
  if (quoted) fail('INVALID_TABLE', 'Unterminated CSV quote'); if (value || values.length || closed) finishRow(); return rows;
}

function xml(bytes: Uint8Array): Document {
  const document = new DOMParser({ onError: () => { fail('INVALID_TABLE', 'Invalid workbook XML'); } }).parseFromString(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'application/xml');
  if (!document.documentElement) fail('INVALID_TABLE', 'Missing workbook XML root'); return document;
}
function elements(parent: Document | Element, localName: string, namespace = spreadsheetNS): Element[] { return Array.from(parent.getElementsByTagNameNS(namespace, localName)); }
function direct(parent: Element, localName: string): Element[] {
  const found: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) if (node.nodeType === 1 && (node as Element).namespaceURI === spreadsheetNS && (node as Element).localName === localName) found.push(node as Element);
  return found;
}
function oneValue(parent: Element, name: string): string | null {
  const found = direct(parent, name); if (found.length > 1) fail('INVALID_TABLE', 'Duplicate workbook cell value'); return found[0]?.textContent ?? null;
}
function stringValue(parent: Element): string {
  if (elements(parent, 'rPh').length || elements(parent, 'f').length) fail('UNSUPPORTED_CELL', 'Unsupported complex workbook string');
  const value = elements(parent, 't').map(element => element.textContent ?? '').join('');
  if (value.length > MAX_CELL || forbiddenControls.test(value)) fail('TABLE_LIMIT_EXCEEDED', 'Unsupported workbook string'); return value;
}
function cellValue(cell: Element, strings: string[]): RawCell {
  if (direct(cell, 'f').length) fail('UNSUPPORTED_CELL', 'Formula cells are unsupported');
  const kind = cell.getAttribute('t') ?? 'n', value = oneValue(cell, 'v');
  if (kind === 'inlineStr') {
    const inline = direct(cell, 'is'); if (inline.length !== 1 || value !== null) fail('INVALID_TABLE', 'Invalid inline workbook string');
    return { kind: 'text', original: stringValue(inline[0]) };
  }
  if (value === null) {
    if (kind !== 'n' || direct(cell, 'is').length) fail('INVALID_TABLE', 'Missing typed workbook value'); return { kind: 'blank', original: null };
  }
  if (kind === 's') {
    if (!/^(?:0|[1-9]\d{0,6})$/.test(value) || Number(value) >= strings.length) fail('INVALID_TABLE', 'Invalid shared string index'); return { kind: 'text', original: strings[Number(value)] };
  }
  if (kind === 'b') { if (!['0', '1'].includes(value)) fail('INVALID_TABLE', 'Invalid workbook boolean'); return { kind: 'boolean', original: value }; }
  if (kind === 'n') { parseXlsxNumber(value); return { kind: 'number', original: value }; }
  if (kind === 'str') { if (value.length > MAX_CELL) fail('TABLE_LIMIT_EXCEEDED', 'Workbook text is too long'); return { kind: 'text', original: value }; }
  return fail('UNSUPPORTED_CELL', 'Unsupported workbook cell type');
}
function address(value: string): { column: number; row: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,4})$/.exec(value); if (!match) fail('INVALID_TABLE', 'Invalid worksheet cell address');
  let column = 0; for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]); if (column > MAX_COLUMNS || row > MAX_ROWS + 1) fail('TABLE_LIMIT_EXCEEDED', 'Worksheet coordinates exceed the supported table bounds'); return { column, row };
}
function worksheet(document: Document, strings: string[]): CellsRow[] {
  if (document.documentElement?.localName !== 'worksheet' || document.documentElement.namespaceURI !== spreadsheetNS) fail('INVALID_TABLE', 'Invalid worksheet root');
  if (elements(document, 'mergeCell').length || elements(document, 'f').length || elements(document, 'hyperlink').length) fail('UNSUPPORTED_CELL', 'Merged, formula and hyperlink cells are unsupported');
  const sheetData = elements(document, 'sheetData'); if (sheetData.length !== 1) fail('INVALID_TABLE', 'Invalid worksheet data');
  const rows: CellsRow[] = []; let lastRow = 0, width = 0;
  for (const row of direct(sheetData[0], 'row')) {
    const rowNumber = row.getAttribute('r') ?? '';
    if (!/^[1-9]\d{0,4}$/.test(rowNumber) || Number(rowNumber) <= lastRow || Number(rowNumber) > MAX_ROWS + 1) fail('INVALID_TABLE', 'Invalid or unordered worksheet row');
    lastRow = Number(rowNumber); const cells: RawCell[] = []; let lastColumn = 0;
    for (const cell of direct(row, 'c')) {
      const coordinate = address(cell.getAttribute('r') ?? '');
      if (coordinate.row !== lastRow || coordinate.column <= lastColumn) fail('INVALID_TABLE', 'Duplicate, unordered or mismatched cell address');
      while (cells.length < coordinate.column - 1) cells.push({ kind: 'blank', original: null });
      cells.push(cellValue(cell, strings)); lastColumn = coordinate.column;
    }
    if (!cells.some(cell => cell.original !== null && cell.original !== '')) continue;
    width = Math.max(width, cells.length); rows.push({ row: lastRow, cells });
  }
  for (const row of rows) while (row.cells.length < width) row.cells.push({ kind: 'blank', original: null });
  return rows;
}
async function workbookRows(bytes: Buffer, selected: string | null): Promise<{ sheet: string; rows: CellsRow[]; dateSystem: '1900' | '1904' }> {
  // The shared gate checks raw ZIP paths/CRC/local-central agreement/actual inflation and all XML before JSZip allocates a workbook.
  await validateFileContent('goal-import', 'source.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes, defaultFileLimits).catch(() => fail('INVALID_TABLE', 'The workbook is malformed, active or exceeds resource limits'));
  const zip = await JSZip.loadAsync(bytes);
  const read = async (name: string) => { const file = zip.file(name); if (!file) fail('INVALID_TABLE', 'A workbook package part is missing'); return xml(await file.async('uint8array')); };
  const book = await read('xl/workbook.xml');
  if (book.documentElement?.localName !== 'workbook' || book.documentElement.namespaceURI !== spreadsheetNS) fail('INVALID_TABLE', 'Invalid workbook root');
  const properties = elements(book, 'workbookPr'); if (properties.length > 1) fail('INVALID_TABLE', 'Duplicate workbook properties');
  const epoch = properties[0]?.getAttribute('date1904'); if (epoch !== undefined && epoch !== null && !['0', '1', 'true', 'false'].includes(epoch)) fail('INVALID_TABLE', 'Invalid workbook date system');
  const dateSystem = epoch === '1' || epoch === 'true' ? '1904' as const : '1900' as const;
  const relations = await read('xl/_rels/workbook.xml.rels'), targets = new Map<string, string>();
  let sharedStringsTarget: string | null = null;
  for (const relation of elements(relations, 'Relationship', packageRelationshipNS)) {
    const id = relation.getAttribute('Id'), target = relation.getAttribute('Target'), type = relation.getAttribute('Type');
    if (!id || !target || targets.has(id) || relation.getAttribute('TargetMode')) fail('INVALID_TABLE', 'Invalid workbook relationship');
    const worksheetRelationship = type === documentRelationshipNS + '/worksheet';
    if (worksheetRelationship || type === documentRelationshipNS + '/sharedStrings') {
      const normalized = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target));
      const permittedTarget = worksheetRelationship ? /^xl\/worksheets\/[^/]+\.xml$/ : /^xl\/(?:[^/]+\/)*[^/]+\.xml$/;
      if (!permittedTarget.test(normalized) || target.includes('\\') || target.includes(':') || target.split('/').includes('..')) fail('INVALID_TABLE', 'Invalid workbook relationship target');
      if (!worksheetRelationship) {
        if (sharedStringsTarget !== null) fail('INVALID_TABLE', 'Duplicate shared-string relationship');
        sharedStringsTarget = normalized;
      }
      targets.set(id, worksheetRelationship ? normalized : '');
    } else targets.set(id, '');
  }
  const stringsDocument = sharedStringsTarget === null ? null : await read(sharedStringsTarget);
  const stringsRoot = stringsDocument?.documentElement;
  if (stringsDocument && (!stringsRoot || stringsRoot.localName !== 'sst' || stringsRoot.namespaceURI !== spreadsheetNS)) fail('INVALID_TABLE', 'Invalid shared-string root');
  const strings = stringsDocument ? elements(stringsDocument, 'si').map(stringValue) : [];
  if (strings.length > 2000100) fail('TABLE_LIMIT_EXCEEDED', 'Too many shared workbook strings');
  const names = new Set<string>(), ids = new Set<string>(), sheets: Array<{ name: string; target: string }> = [];
  for (const sheet of elements(book, 'sheet')) {
    const name = sheet.getAttribute('name'), id = sheet.getAttributeNS(documentRelationshipNS, 'id');
    if (!name || !id || names.has(name) || ids.has(id) || !targets.get(id)) fail('INVALID_TABLE', 'Invalid or duplicate workbook sheet');
    names.add(name); ids.add(id); sheets.push({ name, target: targets.get(id)! });
  }
  if (selected !== null) {
    const sheet = sheets.find(sheet => sheet.name === selected); if (!sheet) fail('SOURCE_SHEET_MISSING', 'The saved worksheet is absent');
    return { sheet: sheet.name, rows: worksheet(await read(sheet.target), strings), dateSystem };
  }
  let candidate: { sheet: string; rows: CellsRow[] } | undefined;
  for (const sheet of sheets) {
    const rows = worksheet(await read(sheet.target), strings); if (!rows.length) continue;
    if (candidate) fail('SOURCE_SHEET_REQUIRED', 'Save an explicit worksheet selection for this workbook'); candidate = { sheet: sheet.name, rows };
  }
  if (!candidate) fail('INVALID_TABLE', 'The workbook has no nonempty data sheet'); return { ...candidate, dateSystem };
}

/** Pure, inert parse only: no facts, dates, business keys, directory IDs or units are inferred. */
export async function parseWorkbenchTable(input: { bytes: Uint8Array; name: string; parsingProfile: ParsingProfile }): Promise<ParsedSourceTable> {
  if (!sourceParsingProfileSchema.safeParse(input.parsingProfile).success) fail('INVALID_PROFILE', 'Invalid saved parsing profile');
  if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > MAX_BYTES) fail('TABLE_LIMIT_EXCEEDED', 'Source bytes must be between 1 byte and 10 MiB');
  if (/\.csv$/i.test(input.name)) {
    if (input.parsingProfile.sheetName !== null) fail('SOURCE_SHEET_MISSING', 'CSV has no worksheets');
    const value = decodeCsv(input.bytes, input.parsingProfile.csvEncoding);
    if (/^\s*(?:MZ|<!doctype\s+html|<html|<script|<svg)/i.test(value)) fail('INVALID_TABLE', 'The downloaded file is not a CSV table');
    return result('csv', null, csvRows(value, input.parsingProfile.csvDelimiter), null);
  }
  if (/\.xlsx$/i.test(input.name)) {
    const data = await workbookRows(Buffer.from(input.bytes), input.parsingProfile.sheetName); return result('xlsx', data.sheet, data.rows, data.dateSystem);
  }
  return fail('UNSUPPORTED_FORMAT', 'Only CSV and XLSX source tables are supported');
}
