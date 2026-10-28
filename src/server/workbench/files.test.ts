import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm, link, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { afterEach, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import * as fileModule from './files';

const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('wb-files-')) throw Error('Unsafe test cleanup'); await rm(root, { recursive: true, force: true }); } });
async function fixture(limits = { goalImportBytes: 10 * 1024 ** 2, evidenceBytes: 32 * 1024 ** 2, restoreBytes: 64 * 1024 ** 2, restoreExpandedBytes: 256 * 1024 ** 2 }) {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-files-')); roots.push(root);
  expect(fileModule).toHaveProperty('createFileStore');
  return { root, limits, files: fileModule.createFileStore({ directory: path.join(root, 'private'), limits }) };
}
async function* chunks(value: Uint8Array) { for (let start = 0; start < value.length; start += 65536) yield value.subarray(start, start + 65536); }
const csv = Buffer.from('product,value\nsynthetic,92.00\n');
const upload = (bytes: Uint8Array = csv) => ({ installationId: owner, purpose: 'goal-import' as const, name: 'input.csv', mediaType: 'text/csv', stream: chunks(bytes) });
it('stages_exact_private_handle_and_reads_verified_copies_after_restart', async () => {
  const f = await fixture(); const handle = await f.files.stage(upload());
  expect(Object.keys(handle).sort()).toEqual(['bytes', 'fileHandle', 'mediaType', 'name', 'sha256']);
  expect(handle).toMatchObject({ name: 'input.csv', mediaType: 'text/csv', bytes: 30, sha256: createHash('sha256').update(csv).digest('hex') });
  expect(handle.fileHandle).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const read = await f.files.read(handle.fileHandle, owner, 'goal-import'); read.bytesValue[0] = 0;
  const restarted = fileModule.createFileStore({ directory: path.join(f.root, 'private'), limits: f.limits });
  expect(Buffer.from((await restarted.read(handle.fileHandle, owner, 'goal-import')).bytesValue)).toEqual(csv);
  await expect(restarted.read(handle.fileHandle, other, 'goal-import')).rejects.toMatchObject({ statusCode: 404 });
  await expect(restarted.read(handle.fileHandle, owner, 'evidence')).rejects.toMatchObject({ statusCode: 404 });
  await expect(restarted.read('../input.csv', owner, 'goal-import')).rejects.toMatchObject({ statusCode: 404 });
});
it('rejects_client_paths_unsafe_names_empty_spoofed_and_active_content', async () => {
  const f = await fixture();
  for (const name of ['../input.csv', '/input.csv', 'C:\\input.csv', 'a\\input.csv', 'a:b.csv', 'bad\0.csv', '.', 'CON.csv']) await expect(f.files.stage({ ...upload(), name })).rejects.toMatchObject({ statusCode: 422 });
  for (const input of [upload(Buffer.alloc(0)), { ...upload(), mediaType: 'image/png' }, upload(Buffer.from('MZ\0executable')), { ...upload(Buffer.from('<script>x</script>')), purpose: 'evidence' as const, name: 'a.html', mediaType: 'text/html' }, { ...upload(Buffer.from('%PDF-1.7\n/JavaScript bad\n%%EOF')), purpose: 'evidence' as const, name: 'a.pdf', mediaType: 'application/pdf' }]) await expect(f.files.stage(input)).rejects.toMatchObject({ statusCode: 422 });
  expect(await readdir(path.join(f.root, 'private'))).toEqual([]);
});
it('enforces_stream_caps_and_removes_partial_failed_streams', async () => {
  const f = await fixture({ goalImportBytes: csv.length, evidenceBytes: 100, restoreBytes: 100, restoreExpandedBytes: 100 });
  await f.files.stage(upload());
  await expect(f.files.stage(upload(Buffer.concat([csv, Buffer.from('x')])))).rejects.toMatchObject({ statusCode: 413 });
  async function* broken() { yield csv; throw Error('private upstream failure'); }
  await expect(f.files.stage({ ...upload(), stream: broken() })).rejects.toThrow();
  expect(await readdir(path.join(f.root, 'private'))).toHaveLength(1);
});
it('accepts_evidence_at_32MiB_and_rejects_one_more_byte', async () => {
  const f = await fixture(); const bytes = Buffer.alloc(32 * 1024 ** 2, 97);
  const input = { ...upload(bytes), purpose: 'evidence' as const, name: 'proof.txt', mediaType: 'text/plain' };
  expect((await f.files.stage(input)).bytes).toBe(33554432);
  await expect(f.files.stage({ ...input, stream: chunks(Buffer.concat([bytes, Buffer.from('a')])) })).rejects.toMatchObject({ statusCode: 413 });
});
it('rejects_tampered_payload_metadata_and_hardlinks', async () => {
  const f = await fixture(); const handle = await f.files.stage(upload());
  const directory = path.join(f.root, 'private', handle.fileHandle);
  await writeFile(path.join(directory, 'bytes'), 'changed');
  await expect(f.files.read(handle.fileHandle, owner, 'goal-import')).rejects.toMatchObject({ statusCode: 422 });
  await writeFile(path.join(directory, 'bytes'), csv); await link(path.join(directory, 'bytes'), path.join(f.root, 'alias'));
  await expect(f.files.read(handle.fileHandle, owner, 'goal-import')).rejects.toMatchObject({ statusCode: 422 });
  await rm(path.join(f.root, 'alias')); const metadata = JSON.parse(await readFile(path.join(directory, 'metadata.json'), 'utf8')); metadata.bytes = 999;
  await writeFile(path.join(directory, 'metadata.json'), JSON.stringify(metadata));
  await expect(f.files.read(handle.fileHandle, owner, 'goal-import')).rejects.toMatchObject({ statusCode: 422 });
});
it('rejects_symlink_roots_and_root_aliases', async () => {
  const f = await fixture(); await mkdir(path.join(f.root, 'real')); await symlink(path.join(f.root, 'real'), path.join(f.root, 'alias'), 'junction');
  const files = fileModule.createFileStore({ directory: path.join(f.root, 'alias', 'staging'), limits: f.limits });
  await expect(files.stage(upload())).rejects.toMatchObject({ statusCode: 422 });
});
it('bounds_profileless_evidence_csv_rows_columns_and_cells_without_truncation', async () => {
  const f = await fixture();
  await f.files.stage({ ...upload(Buffer.from('v\n' + '1\n'.repeat(20000))), purpose: 'evidence' });
  for (const text of ['v\n' + '1\n'.repeat(20001), Array(101).fill('v').join(',') + '\n1', 'v\n' + 'x'.repeat(10001), 'v\n"unterminated']) await expect(f.files.stage({ ...upload(Buffer.from(text)), purpose: 'evidence' })).rejects.toMatchObject({ statusCode: 422 });
});
async function zip(entries: Record<string, string>) { const book = new JSZip(); for (const [name, value] of Object.entries(entries)) book.file(name, value); return book.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); }
it('accepts_supported_xlsx_and_rejects_archive_paths_active_content_and_inflation_lies', async () => {
  const f = await fixture(); const book = new ExcelJS.Workbook(); book.addWorksheet('synthetic').addRows([['product', 'value'], ['demo', '92.00']]);
  const valid = Buffer.from(await book.xlsx.writeBuffer());
  const input = (bytes: Buffer) => ({ ...upload(bytes), name: 'source.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  await f.files.stage(input(valid));
  const entries = { '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' };
  for (const bytes of [await zip({ ...entries, '../escape.xml': 'bad' }), await zip({ ...entries, 'xl/vbaProject.bin': 'macro' }), await zip({ ...entries, 'xl/worksheets/sheet1.xml': '<worksheet><row r="20002"/></worksheet>' }), valid.subarray(0, valid.length - 3)]) await expect(f.files.stage(input(bytes))).rejects.toMatchObject({ statusCode: 422 });
  const bomb = await zip({ ...entries, 'xl/sharedStrings.xml': 'a'.repeat(1024 ** 2) });
  for (let i = 0; i < bomb.length - 46; i++) if (bomb.readUInt32LE(i) === 0x02014b50 && bomb.toString('utf8', i + 46, i + 46 + bomb.readUInt16LE(i + 28)) === 'xl/sharedStrings.xml') bomb.writeUInt32LE(1, i + 24);
  await expect(f.files.stage(input(bomb))).rejects.toMatchObject({ statusCode: 422 });
});
it('validates_restore_archives_and_server_expanded_limit', async () => {
  const f = await fixture({ goalImportBytes: 1000, evidenceBytes: 1000, restoreBytes: 10000, restoreExpandedBytes: 32 });
  const restore = (bytes: Buffer) => ({ ...upload(bytes), purpose: 'workspace-restore' as const, name: 'backup.zip', mediaType: 'application/zip' });
  await f.files.stage(restore(await zip({ 'manifest.json': '{}', 'records.json': '[]' })));
  await expect(f.files.stage(restore(await zip({ 'manifest.json': '{}', 'records.json': ' '.repeat(33) })))).rejects.toMatchObject({ statusCode: 422 });
  await expect(f.files.stage(restore(await zip({ 'manifest.json': '{}', 'records.json': '[]', 'bad.exe': 'MZ' })))).rejects.toMatchObject({ statusCode: 422 });
});
it('preserves_windows1251_goal_csv_for_the_later_published_parser_profile', async () => {
  const f = await fixture(); const bytes = Buffer.from([0xef,0xf0,0xee,0xe4,0xf3,0xea,0xf2,0x2c,0x76,0x0a,0xc4,0xe5,0xec,0xee,0x2c,0x31,0x0a]);
  const handle = await f.files.stage(upload(bytes)); expect(Buffer.from((await f.files.read(handle.fileHandle, owner, 'goal-import')).bytesValue)).toEqual(bytes);
});
it('rejects_xlsx_sparse_and_unaddressed_excess_columns_and_encoded_external_links', async () => {
  const f = await fixture(); const entries = { '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' };
  const overrides: Array<Record<string, string>> = [
    { 'xl/worksheets/sheet1.xml': '<worksheet><row r="1">' + '<c><v>1</v></c>'.repeat(101) + '</row></worksheet>' },
    { 'xl/worksheets/sheet1.xml': '<worksheet><dimension ref="A1:XFD1048576"/><row r="1"><c r="A1"/></row></worksheet>' },
    { 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship TargetMode="&#69;xternal" Target="https://outside.invalid"/></Relationships>' },
  ];
  for (const members of overrides) await expect(f.files.stage({ ...upload(await zip({ ...entries, ...members })), name: 'source.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).rejects.toMatchObject({ statusCode: 422 });
});
it('rejects_zip_symlink_encryption_crc_mismatch_and_path_metadata', async () => {
  const f = await fixture(); const original = await zip({ 'manifest.json': '{}', 'records.json': '[]' });
  const central = original.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  const variants = [Buffer.from(original), Buffer.from(original), Buffer.from(original)];
  variants[0].writeUInt32LE(0xa1ff0000, central + 38); variants[1].writeUInt16LE(1, central + 8); variants[2].writeUInt32LE(123, central + 16);
  for (const bytes of variants) await expect(f.files.stage({ ...upload(bytes), purpose: 'workspace-restore', name: 'backup.zip', mediaType: 'application/zip' })).rejects.toMatchObject({ statusCode: 422 });
});
it('supports_opaque_pdf_png_jpeg_evidence_and_rejects_spoofed_containers', async () => {
  const f = await fixture();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
  const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,1,0,1,1,1,0x11,0,0xff,0xda,0,8,1,1,0,0,63,0,1,0xff,0xd9]);
  const cases: Array<[string, string, Buffer]> = [['proof.pdf','application/pdf',Buffer.from('%PDF-2.0\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')], ['proof.png','image/png',png], ['proof.jpg','image/jpeg',jpeg]];
  for (const [name, mediaType, bytes] of cases) {
    const handle = await f.files.stage({ ...upload(bytes), purpose: 'evidence', name, mediaType }); expect(Buffer.from((await f.files.read(handle.fileHandle, owner, 'evidence')).bytesValue)).toEqual(bytes);
    await expect(f.files.stage({ ...upload(bytes.subarray(0, -5)), purpose: 'evidence', name, mediaType })).rejects.toMatchObject({ statusCode: 422 });
  }
});
it('does_not_choose_goal_csv_delimiter_or_decode_before_the_published_profile', async () => {
  const f = await fixture(); const bytes = Buffer.from('name;value\n' + ','.repeat(101) + ';92\n');
  const result = await f.files.stage(upload(bytes)); expect(Buffer.from((await f.files.read(result.fileHandle, owner, 'goal-import')).bytesValue)).toEqual(bytes);
});
it('rejects_payload_changed_during_staging_before_final_handle', async () => {
  const f = await fixture();
  async function* tamper() { yield csv; const pending = (await readdir(path.join(f.root, 'private')))[0]; await writeFile(path.join(f.root, 'private', pending, 'bytes'), 'product,value\nsynthetic,93.00\n'); }
  await expect(f.files.stage({ ...upload(), stream: tamper() })).rejects.toMatchObject({ statusCode: 422 }); expect(await readdir(path.join(f.root, 'private'))).toEqual([]);
});
it('rejects_many_unclosed_xlsx_rows_before_quadratic_work_or_full_xml_allocation', async () => {
  const f = await fixture(); const bytes = await zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' + '<row>'.repeat(64000) });
  const started = performance.now();
  await expect(f.files.stage({ ...upload(bytes), name: 'source.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).rejects.toMatchObject({ statusCode: 422 });
  expect(performance.now() - started).toBeLessThan(1500);
  expect(await readdir(path.join(f.root, 'private'))).toEqual([]);
});
it('checks_decoded_xlsx_coordinates_and_namespace_local_names_but_keeps_small_encoded_workbooks', async () => {
  const f = await fixture(); const members = { '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' };
  const wrap = (contents: string) => '<s-s:worksheet xmlns:s-s="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><s-s:sheetData>' + contents + '</s-s:sheetData></s-s:worksheet>';
  const invalidSheets = [
    '<worksheet><dimension ref="&#88;FD&#49;048576"/></worksheet>',
    '<worksheet><row r="&#49;048576"><c r="&#88;FD&#49;048576"/></row></worksheet>',
    wrap('<s-s:row>' + '<s-s:c/>'.repeat(101) + '</s-s:row>'),
    wrap('<s-s:row r="1"><s-s:c r="A1"><s-s:f>1+1</s-s:f><s-s:v>2</s-s:v></s-s:c></s-s:row>'),
  ];
  for (const sheet of invalidSheets) await expect(f.files.stage({ ...upload(await zip({ ...members, 'xl/worksheets/sheet1.xml': sheet })), name: 'source.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).rejects.toMatchObject({ statusCode: 422 });
  const safe = await zip({ ...members, 'xl/worksheets/sheet1.xml': wrap('<s-s:row r="&#49;"><s-s:c r="&#65;&#49;"><s-s:v>&#57;2</s-s:v></s-s:c></s-s:row>') });
  const handle = await f.files.stage({ ...upload(safe), name: 'source.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  expect(Buffer.from((await f.files.read(handle.fileHandle, owner, 'goal-import')).bytesValue)).toEqual(safe);
});
