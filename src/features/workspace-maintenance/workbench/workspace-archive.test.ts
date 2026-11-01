import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createWorkspaceArchive, validateWorkspaceArchive } from './workspace-archive';
import { fixture, digest } from './test-fixture';
const cleanups: Array<() => Promise<void>> = []; afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });
async function setup(value: string | null = 'saved') { const f = await fixture(value); cleanups.push(() => f.dispose()); return f; }
describe('typed workspace archives', () => {
  it('exports viewer data and evidence, omits only originals, and verifies every recorded byte', async () => {
    const f = await setup(); const evidence = Buffer.from('proof'); const original = Buffer.from('source');
    await f.addFile('evidence', evidence); await f.addFile('original', original);
    const result = await createWorkspaceArchive(f.context, { label: null, includeOriginals: false }, f.deps);
    const bytes = await f.archiveBytes(result.backupId); expect(digest(bytes)).toBe(result.archiveSha256); expect(bytes.length).toBe(result.bytes);
    const archive = await validateWorkspaceArchive(bytes, f.deps.modules, f.deps.workspace);
    expect(archive.records.map(r => r.value)).toEqual([{ value: 'saved' }]); expect([...archive.files.values()].map(v => Buffer.from(v).toString())).toEqual(['proof']);
    expect(result.empty).toBe(false); expect(result.omissions).toContain('originals'); expect(archive.manifest.actor).toEqual(f.context.actor);
  });
  it('fails closed when the trusted complete codec inventory is absent or incomplete', async () => {
    const f = await setup(); await expect(createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, { ...f.deps, modules: new Map() })).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    await expect(createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, { ...f.deps, workspace: undefined })).rejects.toMatchObject({ code: 'ARCHIVE_UNAVAILABLE' });
  });
  it.each(['../escape', 'files/unknown', 'registry.json'])('rejects unlisted or unsafe member %s', async name => {
    const f = await setup(); const b = await createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps); const zip = await JSZip.loadAsync(await f.archiveBytes(b.backupId)); zip.file(name, 'malice');
    await expect(validateWorkspaceArchive(await zip.generateAsync({ type: 'uint8array' }), f.deps.modules, f.deps.workspace)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });
  it('rejects modified record hashes, unknown schemas, unknown modules, and broken cross references', async () => {
    const f = await setup(); const b = await createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps); const original = await f.archiveBytes(b.backupId);
    for (const change of ['hash', 'schema', 'module', 'ref']) {
      const zip = await JSZip.loadAsync(original); const records = JSON.parse(await zip.file('records.json')!.async('string'));
      if (change === 'schema') records[0].schemaVersion = 99; else if (change === 'module') records[0].moduleId = 'registry'; else records[0].value.value = change === 'ref' ? 'broken-ref' : 'tampered';
      const text = JSON.stringify(records); zip.file('records.json', text); if (change !== 'hash') { const m = JSON.parse(await zip.file('manifest.json')!.async('string')); m.recordsSha256 = digest(text); zip.file('manifest.json', JSON.stringify(m)); }
      await expect(validateWorkspaceArchive(await zip.generateAsync({ type: 'uint8array' }), f.deps.modules, f.deps.workspace)).rejects.toBeDefined();
    }
  });
  it('rejects duplicate physical ZIP members before normalization and inflation', async () => {
    const f = await setup(); const one = Buffer.from('one'), two = Buffer.from('two'); const first = 'files/' + digest(one), second = 'files/' + digest(two); await f.addFile('evidence', one); await f.addFile('evidence', two);
    const b = await createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps); const bytes = Buffer.from(await f.archiveBytes(b.backupId)); let end = bytes.length - 22; const count = bytes.readUInt16LE(end + 10); let at = bytes.readUInt32LE(end + 16);
    for (let i = 0; i < count; i++) { const length = bytes.readUInt16LE(at + 28); const name = bytes.subarray(at + 46, at + 46 + length).toString(); if (name === second) { bytes.write(first, at + 46, 'utf8'); const local = bytes.readUInt32LE(at + 42); bytes.write(first, local + 30, 'utf8'); } at += 46 + length + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32); }
    await expect(validateWorkspaceArchive(bytes, f.deps.modules, f.deps.workspace)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });
  it('bounds high compression ratios and dishonest expanded sizes before archive allocation', async () => {
    const f = await setup(); const b = await createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps); const zip = await JSZip.loadAsync(await f.archiveBytes(b.backupId)); const bomb = Buffer.alloc(1_000_000, 65); zip.file('files/' + digest(bomb), bomb);
    await expect(validateWorkspaceArchive(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }), f.deps.modules, f.deps.workspace)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
    const bytes = Buffer.from(await f.archiveBytes(b.backupId)); const central = bytes.readUInt32LE(bytes.length - 6); bytes.writeUInt32LE(300 * 1024 ** 2, central + 24); await expect(validateWorkspaceArchive(bytes, f.deps.modules, f.deps.workspace)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });
  it('rejects declared files without matching payloads and altered file bytes with valid ZIP CRC', async () => {
    const f = await setup(); const proof = Buffer.from('proof'); const key = 'files/' + digest(proof); await f.addFile('evidence', proof); const b = await createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps);
    for (const missing of [true, false]) { const zip = await JSZip.loadAsync(await f.archiveBytes(b.backupId)); if (missing) zip.remove(key); else zip.file(key, 'tampered-with-valid-crc'); await expect(validateWorkspaceArchive(await zip.generateAsync({ type: 'uint8array' }), f.deps.modules, f.deps.workspace)).rejects.toMatchObject({ code: missing ? 'INVALID_ARCHIVE' : 'INTEGRITY_MISMATCH' }); }
  });
  it('rejects private namespaces and secret-bearing owner payloads instead of exporting policy', async () => {
    const f = await setup(); const codec = f.deps.modules.get('personal')!; codec.exportRecords = () => [{ moduleId: 'registry', schemaId: 'grant', schemaVersion: 1, key: 'host', value: { role: 'chief' } }];
    await expect(createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    codec.exportRecords = () => [{ moduleId: 'personal', schemaId: 'preference', schemaVersion: 1, key: 'same-id', value: { value: 'okay', password: 'secret', cookie: 'secret' } }]; await expect(createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps)).rejects.toBeDefined();
  });
  it('refuses asynchronous validation codecs instead of treating their unchecked Promise as valid data', async () => {
    const f = await setup(); f.deps.modules.get('personal')!.validate = async () => {};
    await expect(createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps)).rejects.toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
  });
});
