import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { defaultSourceParsingProfile } from '../../domain/workbench/schemas/sources';
import { parseWorkbenchDate, parseWorkbenchNumber, parseWorkbenchTable, parseXlsxNumber } from './workbench-parser';

const profile = { ...defaultSourceParsingProfile };
const csv = (text: string, options = {}) => parseWorkbenchTable({ bytes: Buffer.from(text), name: 'synthetic.csv', parsingProfile: { ...profile, ...options } });
async function workbook(sheets: Array<{ name: string; rows: unknown[][] }> = [{ name: 'Report', rows: [['Product', 'Value'], ['A', 92]] }]) {
  const book = new ExcelJS.Workbook();
  for (const sheet of sheets) book.addWorksheet(sheet.name).addRows(sheet.rows);
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function patch(bytes: Uint8Array, file: string, change: (xml: string) => string) {
  const zip = await JSZip.loadAsync(bytes); zip.file(file, change(await zip.file(file)!.async('string')));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const xlsx = (bytes: Uint8Array, options = {}) => parseWorkbenchTable({ bytes, name: 'synthetic.xlsx', parsingProfile: { ...profile, ...options } });

async function relocateSharedStrings(decoy: boolean) {
  const zip = await JSZip.loadAsync(await workbook());
  const strings = await zip.file('xl/sharedStrings.xml')!.async('string');
  zip.file('xl/strings.xml', strings);
  zip.file('xl/_rels/workbook.xml.rels', (await zip.file('xl/_rels/workbook.xml.rels')!.async('string')).replace('Target="sharedStrings.xml"', 'Target="strings.xml"'));
  const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  zip.file('[Content_Types].xml', decoy
    ? contentTypes.replace('</Types>', '<Override PartName="/xl/strings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
    : contentTypes.replace('PartName="/xl/sharedStrings.xml"', 'PartName="/xl/strings.xml"'));
  if (decoy) zip.file('xl/sharedStrings.xml', strings.replace('<t>A</t>', '<t>WRONG-PRODUCT</t>'));
  else zip.remove('xl/sharedStrings.xml');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('workbench lossless source table parser', () => {
  it.each([false, true])('uses the referenced relocated shared strings with conventional-path decoy=%s', async decoy => {
    const table = await xlsx(await relocateSharedStrings(decoy));
    expect(table.columns).toEqual(['Product', 'Value']);
    expect(table.rows[0].cells.Product).toEqual({ kind: 'text', original: 'A' });
  });

  it('rejects ambiguous or unsafe shared-string relationships instead of using a conventional-path part', async () => {
    const bytes = await workbook();
    const sharedStringsType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings';
    const variants = [
      await patch(bytes, 'xl/_rels/workbook.xml.rels', xml => xml.replace('</Relationships>', '<Relationship Id="duplicateStrings" Type="' + sharedStringsType + '" Target="sharedStrings.xml"/></Relationships>')),
      await patch(bytes, 'xl/_rels/workbook.xml.rels', xml => xml.replace('Target="sharedStrings.xml"', 'Target="../sharedStrings.xml"')),
    ];
    for (const variant of variants) await expect(xlsx(variant)).rejects.toMatchObject({ code: 'INVALID_TABLE' });
  });

  it('keeps explicit CSV delimiter, quoting, blank and physical multiline coordinates without guessing values', async () => {
    const table = await csv('Product;Value;Note\r\n"A;1";12345678901234567890.001;"first\r\nsecond"\r\nB;0;\r\nC;;" "', { csvDelimiter: ';' });
    expect(table.columns).toEqual(['Product', 'Value', 'Note']);
    expect(table.sheet).toBeNull(); expect(table.dateSystem).toBeNull();
    expect(table.rows.map(row => row.coordinate.row)).toEqual([2, 4, 5]);
    expect(table.rows[0].cells).toEqual({ Product: { kind: 'text', original: 'A;1' }, Value: { kind: 'text', original: '12345678901234567890.001' }, Note: { kind: 'text', original: 'first\r\nsecond' } });
    expect(table.rows[1].cells.Value.original).toBe('0');
    expect(table.rows[2].cells.Value).toEqual({ kind: 'blank', original: '' });
    expect(table.rows[2].cells.Note).toEqual({ kind: 'text', original: ' ' });
  });

  it('rejects malformed CSV, nonrectangular rows and colliding or empty headers', async () => {
    for (const value of ['a,b\n"x,y', 'a,b\nx"y,z', 'a,b\n"x"junk,y', 'a,b\nx', 'a,A\nx,y', 'a,\nx,y', 'A,Ａ\nx,y', 'a,b\n']) await expect(csv(value)).rejects.toMatchObject({ code: 'INVALID_TABLE' });
    await expect(csv('a,b\nx,y', { sheetName: 'Report' })).rejects.toMatchObject({ code: 'SOURCE_SHEET_MISSING' });
  });

  it('honors UTF8 and windows1251 profiles and rejects invalid encoding, BOM mismatch and controls', async () => {
    expect((await csv('\ufeffПродукт,Значение\nА,1')).columns).toEqual(['Продукт', 'Значение']);
    const bytes = Buffer.from([0xcf,0xf0,0xee,0xe4,0xf3,0xea,0xf2,0x2c,0xc7,0xed,0xe0,0xf7,0xe5,0xed,0xe8,0xe5,0x0a,0xc0,0x2c,0x31]);
    const table = await parseWorkbenchTable({ bytes, name: 'source.csv', parsingProfile: { ...profile, csvEncoding: 'windows1251' } });
    expect(table.columns).toEqual(['Продукт', 'Значение']); expect(table.rows[0].cells.Продукт.original).toBe('А');
    for (const invalid of [Buffer.from([0x61,0x0a,0xff]), Buffer.from('a\nx\0'), Buffer.from([0xff,0xfe,0x61,0,0x0a,0])]) await expect(parseWorkbenchTable({ bytes: invalid, name: 'source.csv', parsingProfile: profile })).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
    await expect(parseWorkbenchTable({ bytes: Buffer.from('\ufeffa\nx'), name: 'source.csv', parsingProfile: { ...profile, csvEncoding: 'windows1251' } })).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
    await expect(parseWorkbenchTable({ bytes: Buffer.from([0x61,0x0a,0x98]), name: 'source.csv', parsingProfile: { ...profile, csvEncoding: 'windows1251' } })).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
  });

  it('enforces scan-time byte, record, column and cell bounds', async () => {
    await expect(csv('a\n' + 'x'.repeat(10001))).rejects.toMatchObject({ code: 'TABLE_LIMIT_EXCEEDED' });
    await expect(csv(Array.from({ length: 101 }, (_, i) => 'h' + i).join(',') + '\n' + Array(101).fill('x').join(','))).rejects.toMatchObject({ code: 'TABLE_LIMIT_EXCEEDED' });
    expect((await csv('a\n' + Array(20000).fill('x').join('\n'))).rows).toHaveLength(20000);
    await expect(csv('a\n' + Array(20001).fill('x').join('\n'))).rejects.toMatchObject({ code: 'TABLE_LIMIT_EXCEEDED' });
    await expect(parseWorkbenchTable({ bytes: Buffer.alloc(10 * 1024 ** 2 + 1), name: 'source.csv', parsingProfile: profile })).rejects.toMatchObject({ code: 'TABLE_LIMIT_EXCEEDED' });
  });

  it('preserves OOXML numeric lexemes before Number conversion, shared strings, booleans and blank cells', async () => {
    let bytes: Uint8Array = await workbook([{ name: 'Report', rows: [['Product', 'Value', 'Flag', 'Empty'], ['A', 92, false, null], ['B', 0.92, true, null]] }]);
    bytes = await patch(bytes, 'xl/worksheets/sheet1.xml', xml => xml.replace('<v>92</v>', '<v>12345678901234567890.001</v>'));
    const table = await xlsx(bytes);
    expect(table.dateSystem).toBe('1900'); expect(table.sheet).toBe('Report');
    expect(table.rows[0].cells.Value).toEqual({ kind: 'number', original: '12345678901234567890.001' });
    expect(table.rows[0].cells.Flag).toEqual({ kind: 'boolean', original: '0' });
    expect(table.rows[0].cells.Empty).toEqual({ kind: 'blank', original: null });
    expect(table.rows[1].cells.Value.original).toBe('0.92');
    const exponent = await patch(bytes, 'xl/worksheets/sheet1.xml', xml => xml.replace('12345678901234567890.001', '1.234567890123456789E+19'));
    expect((await xlsx(exponent)).rows[0].cells.Value.original).toBe('1.234567890123456789E+19');
  });

  it('requires exact saved sheet selection rather than first sheet and preserves sparse coordinates', async () => {
    let bytes: Uint8Array = await workbook([{ name: 'First', rows: [['Product', 'Value'], ['A', 1]] }, { name: 'Second', rows: [['Product', 'Value'], ['B', 2]] }]);
    await expect(xlsx(bytes)).rejects.toMatchObject({ code: 'SOURCE_SHEET_REQUIRED' });
    await expect(xlsx(bytes, { sheetName: 'Missing' })).rejects.toMatchObject({ code: 'SOURCE_SHEET_MISSING' });
    bytes = await patch(bytes, 'xl/worksheets/sheet2.xml', xml => xml.replace(/r="2"/g, 'r="7"').replace(/r="([A-Z]+)2"/g, 'r="$17"'));
    const table = await xlsx(bytes, { sheetName: 'Second' });
    expect(table.rows[0].coordinate).toEqual({ sheet: 'Second', row: 7 }); expect(table.rows[0].cells.Product.original).toBe('B');
  });

  it('rejects formulas even cached, active package content, external relations, merged and error cells', async () => {
    const bytes = await workbook();
    for (const changed of [
      await patch(bytes, 'xl/worksheets/sheet1.xml', xml => xml.replace('<v>92</v>', '<f>1+1</f><v>92</v>')),
      await patch(bytes, 'xl/worksheets/sheet1.xml', xml => xml.replace('</worksheet>', '<mergeCells count="1"><mergeCell ref="A2:B2"/></mergeCells></worksheet>')),
      await patch(bytes, 'xl/worksheets/sheet1.xml', xml => xml.replace('<c r="B2"', '<c t="e" r="B2"')),
      await patch(bytes, 'xl/_rels/workbook.xml.rels', xml => xml.replace('Target="worksheets/sheet1.xml"', 'TargetMode="External" Target="https://example.invalid/report.xml"')),
      await patch(bytes, '[Content_Types].xml', xml => xml.replace('spreadsheetml.sheet.main+xml', 'vnd.ms-excel.sheet.macroEnabled.main+xml')),
    ]) await expect(xlsx(changed)).rejects.toBeInstanceOf(Error);
  });

  it('rejects duplicate cell addresses, invalid shared indices, malformed numeric and sparse out of bounds', async () => {
    const bytes = await workbook();
    for (const xmlChange of [
      (xml: string) => xml.replace('<c r="B2"><v>92</v></c>', '<c r="B2"><v>92</v></c><c r="B2"><v>1</v></c>'),
      (xml: string) => xml.replace('<v>92</v>', '<v>92oops</v>'),
      (xml: string) => xml.replace('<v>92</v>', '<v>1E+99999999</v>'),
      (xml: string) => xml.replace('<c r="B2"><v>92</v></c>', '<c r="B2" t="s"><v>9999</v></c>'),
      (xml: string) => xml.replace('r="B2"', 'r="XFD1048576"'),
    ]) await expect(xlsx(await patch(bytes, 'xl/worksheets/sheet1.xml', xmlChange))).rejects.toBeInstanceOf(Error);
  });

  it('reads explicit XML boolean date systems without date-style interpretation', async () => {
    const bytes = await workbook();
    for (const [value, expected] of [['true', '1904'], ['1', '1904'], ['false', '1900'], ['0', '1900']] as const) {
      const changed = await patch(bytes, 'xl/workbook.xml', xml => xml.replace('<workbookPr', '<workbookPr date1904="' + value + '"'));
      expect((await xlsx(changed)).dateSystem).toBe(expected);
    }
    await expect(xlsx(await patch(bytes, 'xl/workbook.xml', xml => xml.replace('<workbookPr', '<workbookPr date1904="perhaps"')))).rejects.toMatchObject({ code: 'INVALID_TABLE' });
  });

  it('rejects wrong format, HTML pretending CSV, truncated archives and unsafe ZIP names', async () => {
    await expect(csv('<html>login</html>')).rejects.toBeInstanceOf(Error);
    await expect(parseWorkbenchTable({ bytes: Buffer.from('a\nx'), name: 'source.xls', parsingProfile: profile })).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    const bytes = await workbook(); await expect(xlsx(bytes.subarray(0, bytes.length - 4))).rejects.toBeInstanceOf(Error);
    const zip = await JSZip.loadAsync(bytes); zip.file('../unsafe.xml', '<x/>'); await expect(xlsx(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toBeInstanceOf(Error);
  });
});

describe('exact explicit profile conversions', () => {
  it('parses only complete declared decimal syntax without rounding or locale guessing', () => {
    expect(parseWorkbenchNumber('12345678901234567890.001', profile)).toBe('12345678901234567890.001');
    expect(parseWorkbenchNumber('-0.00', profile)).toBe('0');
    expect(parseWorkbenchNumber('1 234,50', { ...profile, decimalSeparator: ',', groupSeparator: 'space' })).toBe('1234.5');
    expect(parseWorkbenchNumber('1\u00a0234,50', { ...profile, decimalSeparator: ',', groupSeparator: 'nbsp' })).toBe('1234.5');
    for (const value of ['', ' 1', '1 ', '12 34', '1,5', 'NaN', 'Infinity', '1e3', '92%', '+1']) expect(() => parseWorkbenchNumber(value, profile)).toThrow();
    expect(() => parseWorkbenchNumber('1\u202f234,5', { ...profile, decimalSeparator: ',', groupSeparator: 'nbsp' })).toThrow();
    expect(() => parseWorkbenchNumber('12 34,5', { ...profile, decimalSeparator: ',', groupSeparator: 'space' })).toThrow();
    expect(() => parseWorkbenchNumber('1,5', { ...profile, decimalSeparator: ',', groupSeparator: 'comma' })).toThrow();
  });
  it('expands bounded OOXML numeric tokens exactly, independently of locale', () => {
    expect(parseXlsxNumber('1.234567890123456789E+19')).toBe('12345678901234567890');
    expect(parseXlsxNumber('9.2e-3')).toBe('0.0092'); expect(parseXlsxNumber('92.00')).toBe('92');
    for (const value of ['NaN', 'Infinity', '1e99999999', '1,5', '1oops', '']) expect(() => parseXlsxNumber(value)).toThrow();
  });
  it('validates complete dates, explicit workbook epochs and rejects fictitious or fractional serials', () => {
    expect(parseWorkbenchDate('31.10.2026', 'dd.mm.yyyy')).toBe('2026-10-31');
    expect(parseWorkbenchDate('2024-02-29', 'iso')).toBe('2024-02-29');
    expect(parseWorkbenchDate('1', 'excel-serial', '1900')).toBe('1900-01-01');
    expect(parseWorkbenchDate('59', 'excel-serial', '1900')).toBe('1900-02-28');
    expect(parseWorkbenchDate('61', 'excel-serial', '1900')).toBe('1900-03-01');
    expect(parseWorkbenchDate('0', 'excel-serial', '1904')).toBe('1904-01-01');
    expect(parseWorkbenchDate('1462', 'excel-serial', '1900')).toBe('1904-01-01');
    expect(parseWorkbenchDate('6.1E+1', 'excel-serial', '1900')).toBe('1900-03-01');
    expect(parseWorkbenchDate('1.0', 'excel-serial', '1900')).toBe('1900-01-01');
    for (const [value, format, epoch] of [['60', 'excel-serial', '1900'], ['0', 'excel-serial', '1900'], ['1.5', 'excel-serial', '1904'], ['999999999', 'excel-serial', '1904'], ['1', 'excel-serial', undefined], ['01/02/26', 'iso', undefined], ['2026-02-29', 'iso', undefined], ['', 'iso', undefined]] as const) expect(() => parseWorkbenchDate(value, format, epoch)).toThrow();
  });
  it('retains original header spelling while detecting normalized collisions', async () => {
    const table = await csv(' Product ,Value\nA,1');
    expect(table.columns).toEqual([' Product ', 'Value']); expect(table.rows[0].cells[' Product '].original).toBe('A');
    await expect(csv('Product, product \nA,B')).rejects.toMatchObject({ code: 'INVALID_TABLE' });
  });
});
