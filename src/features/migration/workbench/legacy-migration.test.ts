import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { LegacyStagingMigration } from './legacy-migration';
import { createLegacyMigrationArchiveCodec, readLegacyMigrationRecords } from './contracts';
import { fixture } from '../../workspace-maintenance/workbench/test-fixture';
import { MaintenanceService } from '../../workspace-maintenance/workbench/maintenance-service';
import { createJobStore } from '../../../server/workbench/jobs';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createCoreWorkspaceArchiveCodec } from '../../workspace-maintenance/workbench/core-codec';
import { makeEntityGraph } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
import { assertLegacyCliAllowed, archiveLocalHistory } from '../../../../scripts/local-history';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function setup() {
  const f = await fixture('keep unrelated data'); cleanup.push(() => f.dispose());
  const personId = randomUUID(); f.context.ownAccess = { ...f.context.ownAccess, role: 'curator', personId }; f.context.actor.profilePersonId = personId;
  f.deps.modules = new Map([...f.deps.modules, ['core', createCoreWorkspaceArchiveCodec()], ['legacy_migration', createLegacyMigrationArchiveCodec()]]);
  f.deps.workspace!.requiredModuleIds = [...f.deps.workspace!.requiredModuleIds, 'legacy_migration'];
  const jobs = createJobStore({ repository: f.deps.repository, clock: f.deps.clock });
  const maintenance = new MaintenanceService({ archive: f.deps, jobs, jobSink: jobs });
  const stagingRoot = path.join(f.root, 'migration');
  const migration = () => new LegacyStagingMigration({ files: f.deps.files, get repository() { return f.deps.repository; }, clock: f.deps.clock, stagingRoot, maintenance });
  const stage = async (bytes: Uint8Array, name: string, purpose: 'goal-import' | 'evidence' = 'goal-import', owner = f.context.installationId, person = personId) => f.deps.files.stage({ installationId: owner, profilePersonId: person, purpose, name, mediaType: name.endsWith('.zip') ? 'application/zip' : name.endsWith('.json') ? 'application/json' : 'text/csv', stream: (async function* () { yield bytes; })() });
  return { ...f, maintenance, migration, stage, stagingRoot };
}
async function sourceCatalog() { return JSON.parse(await readFile('catalog/demo.json', 'utf8')); }
async function input(f: Awaited<ReturnType<typeof setup>>, value?: unknown) {
  const bytes = Buffer.from(JSON.stringify(value ?? await sourceCatalog())); const source = await f.stage(bytes, 'catalog.json');
  return { bytes, input: { sourceFileHandle: source.fileHandle, attachmentFileHandles: [], mappingFileHandle: null } };
}
async function oldBundle() {
  const catalog = await sourceCatalog();
  const snapshots = JSON.parse(await readFile('catalog/demo-snapshots.json', 'utf8'));
  const records = [{ namespace: 'catalog', id: 'active', value: catalog }, ...snapshots.map((value: { id: string }) => ({ namespace: 'snapshots', id: value.id, value })), { namespace: 'changes', id: 'old-history', value: { id: 'old-history', kind: 'import', objectId: catalog.id, objectLabel: catalog.name, actor: 'synthetic curator', at: '2026-10-01T09:00:00Z', fields: [] } }];
  const recordsBytes = JSON.stringify(records);
  const manifest = { format: 'uor-workspace-v1', version: 1, applicationVersion: '0.4.1', storageSchemaVersion: 1, classification: 'demo', createdAt: '2026-10-01T09:00:00Z', actor: { id: 'old-curator', name: 'Synthetic curator', installationId: 'old-installation' }, options: { includeOriginals: true, includeReports: false }, recordsSha256: hash(recordsBytes), files: [], omissions: [] };
  const zip = new JSZip(); zip.file('manifest.json', JSON.stringify(manifest)); zip.file('records.json', recordsBytes);
  return { bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }), snapshots };
}

describe('legacy migration through real FileStore and T28 staging', () => {
  it.each(['json', 'zip'])('rejects duplicate decoded keys before preserving %s original bytes', async format => {
    const f = await setup();
    for (const keys of [['\\u0070assword', '\\u0070assword'], ['cookies', 'cookies'], ['annotation', '\\u0061nnotation']]) {
      const injection = `"${keys[0]}":"private sentinel","${keys[1]}":null,`;
      let bytes: Buffer;
      if (format === 'json') bytes = Buffer.from(JSON.stringify(await sourceCatalog()).replace('{', '{' + injection));
      else {
        const zip = await JSZip.loadAsync((await oldBundle()).bytes);
        const records = (await zip.file('records.json')!.async('text')).replace('"value":{', '"value":{' + injection);
        const manifest = JSON.parse(await zip.file('manifest.json')!.async('text')); manifest.recordsSha256 = hash(records);
        zip.file('manifest.json', JSON.stringify(manifest)); zip.file('records.json', records);
        bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
      }
      const source = await f.stage(bytes, 'legacy.' + format);
      await expect(f.migration().preview(f.context, { sourceFileHandle: source.fileHandle, attachmentFileHandles: [], mappingFileHandle: null })).rejects.toMatchObject({ code: 'LEGACY_INPUT_INVALID' });
    }
    expect(f.activations()).toBe(0); expect(readLegacyMigrationRecords(f.deps.repository)).toEqual([]);
  });
  it.each([false, true])('shared content retains evidence priority regardless of manifest order %s and survives backup without originals', async reverse => {
    const f = await setup(); const zip = await JSZip.loadAsync((await oldBundle()).bytes);
    const content = Buffer.from('id,value\nproof,1'); const sha256 = hash(content); const key = 'files/' + sha256;
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('text'));
    manifest.files = ['evidence', 'original'].map(kind => ({ key, kind, relativePath: (kind === 'evidence' ? 'evidence/' : 'source-artifacts/') + 'proof.csv', sha256, bytes: content.length }));
    if (reverse) manifest.files.reverse();
    zip.file('manifest.json', JSON.stringify(manifest)); zip.file(key, content);
    const source = await f.stage(await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }), 'legacy.zip');
    const report = await f.migration().preview(f.context, { sourceFileHandle: source.fileHandle, attachmentFileHandles: [], mappingFileHandle: null });
    await f.migration().apply(f.context, { reportToken: report.reportToken, confirmedMappings: report.mappings });
    expect(f.files.find(file => file.path === key)?.kind).toBe('evidence');
    const backup = await f.maintenance.createBackup(f.context, { label: 'evidence only', includeOriginals: false });
    const archive = await JSZip.loadAsync(await f.archiveBytes(backup.backupId));
    expect(await archive.file(key)!.async('nodebuffer')).toEqual(content);
    const uploaded = await f.upload(await f.archiveBytes(backup.backupId));
    const restore = await f.maintenance.previewRestore(f.context, { fileHandle: uploaded.fileHandle });
    await f.maintenance.applyRestore(f.context, { restoreToken: restore.restoreToken, confirmReplacement: true });
    expect(f.files.find(file => file.path === key)?.kind).toBe('evidence');
  });
  it('completed migration cannot replay cached success or receipt in a changed repository', async () => {
    const f = await setup(); const source = await input(f); const report = await f.migration().preview(f.context, source.input);
    await f.migration().apply(f.context, { reportToken: report.reportToken, confirmedMappings: report.mappings });
    f.setRepo();
    await expect(f.migration().apply(f.context, { reportToken: report.reportToken, confirmedMappings: report.mappings })).rejects.toMatchObject({ code: 'PREVIEW_STALE' });
    const repeated = await f.migration().preview(f.context, source.input);
    expect(repeated.reportToken).not.toBe(report.reportToken); expect(f.activations()).toBe(1);
  });
  it('migrationPreservesOriginalsHistoryAndUnknownBasisWithoutGuessing', async () => {
    const f = await setup(); const bundle = await oldBundle(); const source = await f.stage(bundle.bytes, 'legacy.zip');
    const before = f.deps.repository.getStateRevision();
    const report = await f.migration().preview(f.context, { sourceFileHandle: source.fileHandle, attachmentFileHandles: [], mappingFileHandle: null });
    expect(f.activations()).toBe(0); expect(f.deps.repository.getStateRevision()).toBe(before);
    expect(report.sourceHash).toBe('sha256:' + hash(bundle.bytes)); expect(report.counts.input).toBe(report.counts.accepted + report.counts.problematic);
    expect(report.issues.some(issue => issue.code === 'LEGACY_BASIS_UNVERIFIED')).toBe(true); expect(report.basisVerified).toBe(false);
    const result = await f.migration().apply(f.context, { reportToken: report.reportToken, confirmedMappings: report.mappings });
    expect(result.requiresCuratorReview).toBe(true); expect(f.get()).toEqual([{ value: 'keep unrelated data' }]);
    const migrated = readLegacyMigrationRecords(f.deps.repository);
    expect(migrated.some(r => r.schemaId === 'legacy.record' && (r.value as { legacyId?: string }).legacyId === 'old-history')).toBe(true);
    expect(migrated.some(r => r.schemaId.includes('method_version'))).toBe(false);
    expect(f.files.some(file => Buffer.from(file.bytesValue).equals(bundle.bytes))).toBe(true);
    expect(f.invalidations()).toBe(1);
    const snapshots = migrated.filter(r => r.schemaId === 'legacy.record' && (r.value as { legacyType?: string }).legacyType === 'snapshots');
    expect(snapshots.map(r => (r.value as { original: { collectedAt: string } }).original.collectedAt)).toEqual(bundle.snapshots.map((s: { collectedAt: string }) => s.collectedAt));
  });
  it('sameSourceReplayAndFailedMigrationNeverDuplicateOrActivatePartial', async () => {
    const f = await setup(); const source = await input(f); const service = f.migration(); const report = await service.preview(f.context, source.input);
    const first = await service.apply(f.context, { reportToken: report.reportToken, confirmedMappings: report.mappings });
    const records = readLegacyMigrationRecords(f.deps.repository);
    expect(await f.migration().apply({ ...f.context, commandId: randomUUID() }, { reportToken: report.reportToken, confirmedMappings: report.mappings })).toEqual(first);
    const repeated = await f.migration().preview(f.context, source.input);
    expect(await f.migration().apply(f.context, { reportToken: repeated.reportToken, confirmedMappings: repeated.mappings })).toEqual(first);
    expect(readLegacyMigrationRecords(f.deps.repository)).toEqual(records); expect(f.activations()).toBe(1);
  });
  it('failed healthcheck restores prior active data and keeps original staging plus rescue', async () => {
    const f = await setup(); const source = await input(f); const report = await f.migration().preview(f.context, source.input);
    const before = f.deps.repository.getStateRevision();
    f.deps.workspace!.healthcheck = async () => { throw new Error('injected healthcheck'); };
    await expect(f.migration().apply(f.context, { reportToken: report.reportToken, confirmedMappings: report.mappings })).rejects.toThrow();
    expect(f.get()).toEqual([{ value: 'keep unrelated data' }]); expect(f.deps.repository.getStateRevision()).toBe(before);
    expect(readLegacyMigrationRecords(f.deps.repository)).toEqual([]); expect((await readdir(f.stagingRoot)).length).toBeGreaterThan(0);
    expect((await readdir(path.join(f.deps.artifactRoot, 'backups'))).length).toBeGreaterThan(0);
  });
  it.each(['owner', 'person', 'session', 'state', 'mapping', 'expiry'])('rejects changed %s binding before applying', async change => {
    const f = await setup(); const source = await input(f); const report = await f.migration().preview(f.context, source.input);
    let context = f.context; let mappings = report.mappings;
    if (change === 'owner') context = { ...context, installationId: randomUUID() };
    if (change === 'person') context = { ...context, ownAccess: { ...context.ownAccess, personId: randomUUID() } };
    if (change === 'session') f.setSession(); if (change === 'state') f.put('changed'); if (change === 'mapping') mappings = mappings.slice(1); if (change === 'expiry') f.setNow('2026-11-01T12:00:00.000Z');
    await expect(f.migration().apply(context, { reportToken: report.reportToken, confirmedMappings: mappings })).rejects.toThrow(); expect(f.activations()).toBe(0);
  });
  it('file handles enforce installation, person, purpose and attachment ownership', async () => {
    const f = await setup(); const source = await input(f);
    const foreignInstallation = randomUUID();
    await expect(f.migration().preview({ ...f.context, installationId: foreignInstallation, actor: { ...f.context.actor, installationId: foreignInstallation } }, source.input)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    const wrong = await f.stage(Buffer.from('id,value\nx,1'), 'evidence.csv', 'evidence');
    await expect(f.migration().preview(f.context, { ...source.input, sourceFileHandle: wrong.fileHandle })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    const foreignAttachment = await f.stage(Buffer.from('id,value\nx,1'), 'evidence.csv', 'evidence', randomUUID());
    await expect(f.migration().preview(f.context, { ...source.input, attachmentFileHandles: [foreignAttachment.fileHandle] })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });
  it('unknown dates, origins, dangling references and numeric thresholds are explicit problems', async () => {
    const f = await setup(); const catalog = await sourceCatalog();
    catalog.goals[0].numericThreshold = 90; delete catalog.goals[0].measurement;
    catalog.comments.push({ id: 'dangling-comment', goalId: 'missing-goal', leaderId: null, text: 'old text', author: 'synthetic', createdAt: null, validUntil: null, revision: 'old' });
    catalog.comments.push({ id: 'invalid-date-comment', goalId: catalog.goals[0].id, leaderId: null, text: 'old text', author: 'synthetic', createdAt: '2026-02-30T09:00:00Z', validUntil: null, revision: 'old' });
    const source = await input(f, catalog); const report = await f.migration().preview(f.context, source.input);
    expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['LEGACY_BASIS_UNVERIFIED', 'LEGACY_DATE_UNKNOWN', 'LEGACY_ORIGIN_UNKNOWN', 'LEGACY_DANGLING_REFERENCE']));
    expect(report.counts.problematic).toBeGreaterThan(0); expect(report.warnings.some(w => w.code === 'BP04_NOT_VERIFIED')).toBe(true);
    expect(report.issues.some(issue => issue.legacyId === 'invalid-date-comment' && issue.code === 'LEGACY_DATE_UNKNOWN')).toBe(true);
  });
  it('retains more than 2000 observations across separate captures without an aggregate cap', async () => {
    const f = await setup(); const bundle = await oldBundle(); const zip = await JSZip.loadAsync(bundle.bytes); const records = JSON.parse(await zip.file('records.json')!.async('text'));
    const snapshot = records.find((r: { namespace: string }) => r.namespace === 'snapshots').value;
    const row = snapshot.observations[0];
    records.splice(1, records.length - 1, ...Array.from({ length: 3 }, (_, capture) => ({ namespace: 'snapshots', id: `capture-${capture}`, value: { ...snapshot, id: `capture-${capture}`, observations: Array.from({ length: 1001 }, (_, index) => ({ ...row, id: `row-${capture}-${index}` })) } })));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('text')); const json = JSON.stringify(records); manifest.recordsSha256 = hash(json); zip.file('manifest.json', JSON.stringify(manifest)); zip.file('records.json', json);
    const source = await f.stage(await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }), 'legacy.zip'); const report = await f.migration().preview(f.context, { sourceFileHandle: source.fileHandle, attachmentFileHandles: [], mappingFileHandle: null });
    await f.migration().apply(f.context, { reportToken: report.reportToken, confirmedMappings: report.mappings });
    const imported = readLegacyMigrationRecords(f.deps.repository).filter(r => r.schemaId === 'legacy.record' && (r.value as { legacyType?: string }).legacyType === 'snapshots');
    expect(imported.reduce((count, r) => count + (r.value as { original: { observations: unknown[] } }).original.observations.length, 0)).toBe(3003);
  });
  it.each(['.runtime/workbench.sqlite', '.runtime/workbench/workbench.sqlite', '.runtime/app.db'])('legacy CLIs refuse workbench storage at %s without mutations', async file => {
    const f = await setup(); const target = path.join(f.root, file); await mkdir(path.dirname(target), { recursive: true });
    const database = createWorkbenchRepository({ filename: target, artifactRoot: path.join(f.root, 'cli-artifacts') }); database.close(); const before = await readFile(target);
    await expect(assertLegacyCliAllowed(f.root)).rejects.toThrow('WORKBENCH_MIGRATION_REQUIRED');
    await expect(archiveLocalHistory({ projectRoot: f.root })).rejects.toThrow('WORKBENCH_MIGRATION_REQUIRED');
    expect(await readFile(target)).toEqual(before);
  });
  it('explicit mappings link only to existing core entities and never synthesize new goal methods', async () => {
    const f = await setup(); const graph = makeEntityGraph(); seedGraph(f.deps.repository, graph);
    const source = await input(f); const catalog = await sourceCatalog();
    const targetRef = { entityType: 'core_goal_definition', id: graph.input.goal.id };
    const mapping = await f.stage(Buffer.from(JSON.stringify({ schemaVersion: 1, mappings: [{ legacyType: 'goal', legacyId: catalog.goals[0].id, targetRef }] })), 'mapping.json');
    const report = await f.migration().preview(f.context, { ...source.input, mappingFileHandle: mapping.fileHandle });
    expect(report.mappings.find(m => m.legacyType === 'goal' && m.legacyId === catalog.goals[0].id)?.targetRef).toEqual(targetRef);
    const before = f.deps.repository.exportWorkspaceCore();
    await f.migration().apply(f.context, { reportToken: report.reportToken, confirmedMappings: report.mappings });
    expect(f.deps.repository.exportWorkspaceCore()).toEqual(before);
    const missing = await f.stage(Buffer.from(JSON.stringify({ schemaVersion: 1, mappings: [{ legacyType: 'goal', legacyId: catalog.goals[0].id, targetRef: { ...targetRef, id: randomUUID() } }] })), 'mapping.json');
    await expect(f.migration().preview(f.context, { ...source.input, mappingFileHandle: missing.fileHandle })).rejects.toMatchObject({ code: 'LEGACY_MAPPING_TARGET_INVALID' });
  });
  it('changed private staged original bytes invalidate the report token before activation', async () => {
    const f = await setup(); const source = await input(f); const report = await f.migration().preview(f.context, source.input);
    await writeFile(path.join(f.stagingRoot, 'tokens', report.reportToken, 'source'), 'changed original');
    await expect(f.migration().apply(f.context, { reportToken: report.reportToken, confirmedMappings: report.mappings })).rejects.toMatchObject({ code: 'PREVIEW_STALE' }); expect(f.activations()).toBe(0);
  });
  it('an unowned role cannot inspect or apply legacy imports', async () => {
    const f = await setup(); const source = await input(f); const report = await f.migration().preview(f.context, source.input);
    const viewer = { ...f.context, ownAccess: { ...f.context.ownAccess, role: 'viewer' as const } };
    await expect(f.migration().preview(viewer, source.input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.migration().apply(viewer, { reportToken: report.reportToken, confirmedMappings: report.mappings })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('the actual legacy import CLI refuses before reading the source or writing imports', async () => {
    const f = await setup(); const target = path.join(f.root, '.runtime', 'workbench.sqlite'); await mkdir(path.dirname(target), { recursive: true });
    const db = createWorkbenchRepository({ filename: target, artifactRoot: path.join(f.root, 'cli-artifacts') }); db.close();
    const result = await promisify(execFile)(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/import-local.ts'), 'nonexistent-source.html'], { cwd: f.root }).then(value => ({ ...value, code: 0 }), error => error as { stdout: string; stderr: string; code: number });
    expect(result.code).toBe(1); expect(result.stderr).toContain('WORKBENCH_MIGRATION_REQUIRED');
    await expect(readdir(path.join(f.root, '.runtime', 'imports'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('legacy CLI refuses aliased runtime paths even before a database exists', async () => {
    const f = await setup(); const target = path.join(f.root, 'aliased-runtime'); await mkdir(target);
    await symlink(target, path.join(f.root, '.runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertLegacyCliAllowed(f.root)).rejects.toThrow('WORKBENCH_MIGRATION_REQUIRED');
  });
  it('the migration archive codec rejects private session payloads and inconsistent source hashes', () => {
    const codec = createLegacyMigrationArchiveCodec(); const id = randomUUID(); const source = 'a'.repeat(64); const mappingHash = 'b'.repeat(64);
    const value = { schemaVersion: 1, id, sourceHash: 'sha256:' + source, mappingHash, legacyType: 'goal', legacyId: 'old-goal', targetRef: { entityType: 'legacy_record', id }, original: { id: 'old-goal', ownerSessionId: 'private-session' }, historicalDate: null, origin: null, issues: [], links: [] };
    expect(() => codec.validate({ moduleId: 'legacy_migration', schemaId: 'legacy.record', schemaVersion: 1, key: `${source}/${mappingHash}/goal/${id}`, value })).toThrow();
    expect(() => codec.validate({ moduleId: 'legacy_migration', schemaId: 'legacy.import', schemaVersion: 1, key: `${source}/${mappingHash}`, value: { schemaVersion: 1, sourceHash: 'sha256:' + source, mappingHash, sourceFileSha256: 'c'.repeat(64), attachmentHashes: [], mappings: [], counts: { input: 0, accepted: 0, problematic: 0 }, basisVerified: false, requiresCuratorReview: true } })).toThrow();
  });
  it('secret fields and private namespaces are refused before original preservation', async () => {
    const f = await setup(); const catalog = await sourceCatalog();
    const secret = await input(f, { ...catalog, ownerSessionId: 'private-session' });
    await expect(f.migration().preview(f.context, secret.input)).rejects.toThrow();
    const bundle = await oldBundle(); const zip = await JSZip.loadAsync(bundle.bytes); const records = JSON.parse(await zip.file('records.json')!.async('text'));
    records.push({ namespace: 'sessions', id: 'private-row', value: { role: 'curator' } }); const bytes = JSON.stringify(records);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('text')); manifest.recordsSha256 = hash(bytes); zip.file('records.json', bytes); zip.file('manifest.json', JSON.stringify(manifest));
    const privateSource = await f.stage(await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }), 'legacy.zip');
    await expect(f.migration().preview(f.context, { sourceFileHandle: privateSource.fileHandle, attachmentFileHandles: [], mappingFileHandle: null })).rejects.toThrow();
    // The durable maintenance mutex is infrastructure; refused input must create no token/source/receipt files.
    expect((await readdir(f.stagingRoot)).filter(name => name !== 'maintenance-mutex.sqlite')).toEqual([]); expect(f.files).toEqual([]); expect(f.activations()).toBe(0);
  });
  it('archive stable target identities and nonnull links must resolve instead of claiming a dangling target exists', async () => {
    const f = await setup(); const codec = createLegacyMigrationArchiveCodec(); const id = randomUUID(); const source = 'a'.repeat(64); const mappingHash = 'b'.repeat(64);
    const value = { schemaVersion: 1, id, sourceHash: 'sha256:' + source, mappingHash, legacyType: 'goal', legacyId: 'old-goal', targetRef: { entityType: 'legacy_record', id }, original: { id: 'old-goal' }, historicalDate: null, origin: null, issues: [], links: [] };
    const record = { moduleId: 'legacy_migration', schemaId: 'legacy.record', schemaVersion: 1, key: `${source}/${mappingHash}/goal/${id}`, value };
    expect(() => codec.validate({ ...record, value: { ...value, targetRef: { entityType: 'legacy_record', id: randomUUID() } } })).toThrow();
    const dangling = { ...record, value: { ...value, links: [{ field: 'goalId', legacyType: 'goal', legacyId: 'missing-goal', targetRef: { entityType: 'legacy_record', id: randomUUID() } }] } };
    expect(() => f.deps.repository.transaction(() => codec.restoreRecords(f.deps.repository, [dangling]))).toThrow();
    expect(readLegacyMigrationRecords(f.deps.repository)).toEqual([]);
  });
});
