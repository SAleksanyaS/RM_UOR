import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import JSZip from 'jszip';
import { Readable } from 'node:stream';
import type { CommandContext } from '../../../server/workbench/command-registry';
import { defaultFileLimits } from '../../../server/workbench/files';
import { validateFileContent } from '../../../server/workbench/file-content-safety';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { assertJsonSafety } from '../zip';
import { archiveManifestSchema, archiveRecordSchema, backupCreateInputSchema, backupCreateResultSchema, type ArchiveDependencies, type BackupCreateInput, type BackupCreateResult, type BackupIndexRecord, type MaintenanceContext, type ValidatedWorkspaceArchive, type WorkspaceArchiveCodec, type WorkspaceArchiveManifest, type WorkspaceArchiveRecord, type WorkspaceArchiveWorkspacePort, type BackupFile } from './contracts';
import { durableWrite, isRecoveryRequired, optionalPrivate, privatePath, readPrivate, withMaintenanceLock } from './private-storage';

export const archiveHash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
function stableJson(value: unknown): string { return JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v); }
export function workspaceRevision(repositoryId: string, records: readonly WorkspaceArchiveRecord[], files: readonly WorkspaceArchiveManifest['files'][number][]): string { return archiveHash(stableJson({ repositoryId, records: [...records].sort((a, b) => JSON.stringify([a.moduleId, a.schemaId, a.key]).localeCompare(JSON.stringify([b.moduleId, b.schemaId, b.key]))), files: [...files].sort((a, b) => a.path.localeCompare(b.path)) })); }
export const privateExclusions = ['registry', 'ownAccess', 'grants', 'sessions', 'secrets', 'cookies', 'credentials', 'certificates', 'connection-config', 'managed-browser-profiles', 'screenshots'];
const forbiddenModules = new Set(['registry', 'identity', 'policy', 'access', 'sessions', 'credentials', 'browser-profile', 'connection-config']);
const invalid = () => new WorkbenchHttpError(422, 'INVALID_ARCHIVE', 'The workspace archive is invalid');
const unsupported = () => new WorkbenchHttpError(422, 'SCHEMA_UNSUPPORTED', 'Complete registered workspace archive codecs are required');
const notFound = () => new WorkbenchHttpError(404, 'BACKUP_NOT_FOUND', 'Backup not found');

export function requireArchiveWorkspace(deps: ArchiveDependencies): WorkspaceArchiveWorkspacePort {
  const w = deps.workspace; const functions = ['repositoryId', 'activeRoot', 'files', 'validateArchive', 'authorizeCompleteWorkspace', 'openStagedRepository', 'healthcheck', 'rollback', 'invalidateAdmission', 'freezeWrites'] as const;
  if (!w || typeof w.managedRoot !== 'string' || !w.managedRoot || typeof w.applicationVersion !== 'string' || !w.applicationVersion || !Array.isArray(w.requiredModuleIds) || functions.some(name => typeof w[name] !== 'function')) throw new WorkbenchHttpError(503, 'ARCHIVE_UNAVAILABLE', 'Complete workspace storage adapter is unavailable');
  assertCodecs(deps.modules, w);
  if (!w.repositoryId().trim() || !Number.isSafeInteger(w.storageSchemaVersion) || w.storageSchemaVersion < 1) throw unsupported();
  const relative = path.relative(path.resolve(w.managedRoot), path.resolve(deps.artifactRoot));
  const inverse = path.relative(path.resolve(deps.artifactRoot), path.resolve(w.managedRoot));
  if ((!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) || (!inverse || !inverse.startsWith('..') && !path.isAbsolute(inverse))) throw new WorkbenchHttpError(422, 'ARCHIVE_UNAVAILABLE', 'Archive catalog and replaceable workspace must be independent');
  return w;
}
function assertCodecs(modules?: ReadonlyMap<string, WorkspaceArchiveCodec>, workspace?: WorkspaceArchiveWorkspacePort): asserts modules is ReadonlyMap<string, WorkspaceArchiveCodec> {
  if (!modules || !workspace || !workspace.requiredModuleIds.includes('core') || new Set(workspace.requiredModuleIds).size !== workspace.requiredModuleIds.length || modules.size !== workspace.requiredModuleIds.length) throw unsupported();
  for (const id of workspace.requiredModuleIds) { const c = modules.get(id); if (!c || c.moduleId !== id || forbiddenModules.has(id)) throw unsupported(); for (const method of ['validate', 'restoreRecords', 'exportRecords', 'isUserData'] as const) if (typeof c[method] !== 'function' || ['AsyncFunction', 'AsyncGeneratorFunction'].includes(c[method].constructor.name)) throw unsupported(); }
}
export function synchronousArchiveCall<T>(action: () => T): T { const value = action(); if (value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') { if (value instanceof Promise) void value.catch(() => undefined); throw unsupported(); } return value; }
function validateRecords(records: WorkspaceArchiveRecord[], modules: ReadonlyMap<string, WorkspaceArchiveCodec>): void {
  const keys = new Set<string>(); assertJsonSafety(records);
  for (const r of records) { const key = JSON.stringify([r.moduleId, r.schemaId, r.key]); if (keys.has(key)) throw invalid(); keys.add(key); const c = modules.get(r.moduleId); if (!c || forbiddenModules.has(r.moduleId)) throw unsupported(); synchronousArchiveCall(() => c.validate(r)); }
}
/** Bound compression ratios before the shared ZIP parser allocates or inflates any member. */
function checkZipRatios(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.length > defaultFileLimits.restoreBytes) throw invalid();
  let end = -1; for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  if (end < 0) throw invalid(); const count = bytes.readUInt16LE(end + 10); if (count > 4096) throw invalid(); let cursor = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) { if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid(); const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24); if (expanded > 0 && (compressed === 0 || expanded / compressed > 200)) throw invalid(); cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32); }
  if (cursor !== end) throw invalid();
}
export async function validateWorkspaceArchive(bytes: Uint8Array, modules?: ReadonlyMap<string, WorkspaceArchiveCodec>, workspace?: WorkspaceArchiveWorkspacePort): Promise<ValidatedWorkspaceArchive> {
  assertCodecs(modules, workspace);
  try {
    const buffer = Buffer.from(bytes); checkZipRatios(buffer);
    await validateFileContent('workspace-restore', 'workspace.zip', 'application/zip', buffer, defaultFileLimits);
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true }); const decoder = new TextDecoder('utf-8', { fatal: true });
    const manifest = archiveManifestSchema.parse(JSON.parse(decoder.decode(await zip.file('manifest.json')!.async('uint8array'))));
    if (manifest.storageSchemaVersion !== workspace!.storageSchemaVersion) throw unsupported();
    const recordBytes = await zip.file('records.json')!.async('uint8array'); if (archiveHash(recordBytes) !== manifest.recordsSha256) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Workspace record hash does not match');
    const records = z.array(archiveRecordSchema).max(1_000_000).parse(JSON.parse(decoder.decode(recordBytes))); validateRecords(records, modules);
    const expected = new Set(['manifest.json', 'records.json', 'files/']); const files = new Map<string, Uint8Array>();
    for (const f of manifest.files) { if (files.has(f.path) || f.path !== 'files/' + f.sha256 || !zip.file(f.path)) throw invalid(); const value = await zip.file(f.path)!.async('uint8array'); if (value.length !== f.bytes || archiveHash(value) !== f.sha256) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Workspace file hash does not match'); files.set(f.path, value); expected.add(f.path); }
    for (const [name, file] of Object.entries(zip.files)) if (!expected.has(name) || ('unsafeOriginalName' in file && file.unsafeOriginalName !== name)) throw invalid();
    const archive = { manifest, records, files }; synchronousArchiveCall(() => workspace!.validateArchive(archive)); return archive;
  } catch (e) { if (e instanceof WorkbenchHttpError && ['SCHEMA_UNSUPPORTED', 'INTEGRITY_MISMATCH', 'INVALID_ARCHIVE'].includes(e.code)) throw e; throw invalid(); }
}
export type WorkspaceSnapshot = { records: WorkspaceArchiveRecord[]; files: Array<{ path: string; sha256: string; bytes: number; kind: 'evidence' | 'original' | 'module'; bytesValue: Uint8Array }>; revision: string; empty: boolean; repositoryId: string };
export async function snapshotWorkspace(deps: ArchiveDependencies): Promise<WorkspaceSnapshot> {
  const w = requireArchiveWorkspace(deps); const repositoryId = w.repositoryId();
  const records = deps.repository.transaction(() => [...deps.modules].sort(([a], [b]) => a.localeCompare(b)).flatMap(([id, codec]) => codec.exportRecords(deps.repository).map(r => { if (r.moduleId !== id) throw unsupported(); return archiveRecordSchema.parse(structuredClone(r)); })));
  records.sort((a, b) => JSON.stringify([a.moduleId, a.schemaId, a.key]).localeCompare(JSON.stringify([b.moduleId, b.schemaId, b.key]))); validateRecords(records, deps.modules);
  const seen = new Set<string>(); const files = (await w.files(records)).map(f => { const bytesValue = new Uint8Array(f.bytesValue); const sha256 = archiveHash(bytesValue); if (f.path !== 'files/' + sha256 || seen.has(f.path) || bytesValue.length > 32 * 1024 ** 2 || !['evidence', 'original', 'module'].includes(f.kind)) throw invalid(); seen.add(f.path); return { path: f.path, sha256, bytes: bytesValue.length, kind: f.kind, bytesValue }; }).sort((a, b) => a.path.localeCompare(b.path));
  const revision = workspaceRevision(repositoryId, records, files.map(({ bytesValue: _bytes, ...meta }) => meta));
  const empty = !records.some(r => deps.modules.get(r.moduleId)!.isUserData(r)) && files.length === 0;
  // Owner validates both cross-module and file references, including files intentionally omitted later.
  synchronousArchiveCall(() => w.validateArchive({ manifest: { format: 'uor-workspace-v1', version: 1, applicationVersion: w.applicationVersion, storageSchemaVersion: w.storageSchemaVersion, createdAt: deps.clock.now(), actor: { hostname: 'snapshot', installationId: '00000000-0000-4000-8000-000000000000', profilePersonId: null }, recordsSha256: archiveHash(JSON.stringify(records)), files: files.map(({ bytesValue: _bytes, ...meta }) => meta), exclusions: privateExclusions }, records, files: new Map(files.map(f => [f.path, f.bytesValue])) }));
  if (w.repositoryId() !== repositoryId) throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Workspace repository changed');
  return { records, files, revision, empty, repositoryId };
}
export const backupIndexSchema = backupCreateResultSchema.extend({ repositoryId: z.string().min(1), installationId: z.string().uuid(), personId: z.string().uuid().nullable(), rescue: z.boolean() }).strict();
export async function saveWorkspaceBackup(context: CommandContext, input: BackupCreateInput, deps: ArchiveDependencies, rescue = false): Promise<BackupCreateResult> {
  input = backupCreateInputSchema.parse(input); const w = requireArchiveWorkspace(deps); const snapshot = await snapshotWorkspace(deps);
  synchronousArchiveCall(() => w.authorizeCompleteWorkspace(context, { operation: 'export', records: snapshot.records }));
  const files = snapshot.files.filter(f => input.includeOriginals || f.kind !== 'original'); const createdAt = deps.clock.now();
  const manifest: WorkspaceArchiveManifest = archiveManifestSchema.parse({ format: 'uor-workspace-v1', version: 1, applicationVersion: w.applicationVersion, storageSchemaVersion: w.storageSchemaVersion, createdAt, actor: context.actor, recordsSha256: archiveHash(JSON.stringify(snapshot.records)), files: files.map(({ bytesValue: _bytes, ...meta }) => meta), exclusions: [...privateExclusions, ...(!input.includeOriginals ? ['originals'] : [])] });
  const zip = new JSZip(); zip.file('manifest.json', JSON.stringify(manifest)); zip.file('records.json', JSON.stringify(snapshot.records)); for (const f of files) zip.file(f.path, f.bytesValue);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE', platform: 'DOS' }); await validateWorkspaceArchive(bytes, deps.modules, w);
  const current = await snapshotWorkspace(deps); if (current.revision !== snapshot.revision) throw new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Workspace changed during backup');
  synchronousArchiveCall(() => w.authorizeCompleteWorkspace(context, { operation: 'export', records: current.records }));
  const result: BackupCreateResult = backupCreateResultSchema.parse({ backupId: randomUUID(), archiveSha256: archiveHash(bytes), bytes: bytes.length, createdAt, sourceStateRevision: snapshot.revision, empty: snapshot.empty, omissions: [...manifest.exclusions] });
  const index: BackupIndexRecord = { ...result, repositoryId: snapshot.repositoryId, installationId: context.installationId, personId: context.ownAccess.personId, rescue };
  await durableWrite(deps.artifactRoot, `backups/${result.backupId}/archive.zip`, bytes);
  const verified = await readPrivate(deps.artifactRoot, `backups/${result.backupId}/archive.zip`); if (archiveHash(verified) !== result.archiveSha256 || verified.length !== result.bytes) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Saved backup did not verify');
  await durableWrite(deps.artifactRoot, `backups/${result.backupId}/index.json`, JSON.stringify(backupIndexSchema.parse(index))); return result;
}
export async function createWorkspaceArchive(context: CommandContext, input: BackupCreateInput, deps: ArchiveDependencies): Promise<BackupCreateResult> {
  return withMaintenanceLock(deps.artifactRoot, async () => {
    if (isRecoveryRequired(deps.artifactRoot) || await optionalPrivate(deps.artifactRoot, 'recovery-required.json', 10000)) throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Workspace writes require startup recovery');
    let names: string[] = []; try { names = await readdir(await privatePath(deps.artifactRoot, 'journals')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    for (const name of names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) { const value = JSON.parse((await readPrivate(deps.artifactRoot, 'journals/' + name, 100000)).toString()) as { phase?: unknown }; if (!['committed', 'rolled_back'].includes(String(value.phase))) throw new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Workspace writes require startup recovery'); }
    return saveWorkspaceBackup(context, input, deps);
  });
}
export async function readOwnBackup(context: MaintenanceContext, backupId: string, deps: ArchiveDependencies): Promise<{ index: BackupIndexRecord; bytes: Buffer }> {
  if (!z.string().uuid().safeParse(backupId).success) throw notFound(); const w = requireArchiveWorkspace(deps); const value = await optionalPrivate(deps.artifactRoot, `backups/${backupId}/index.json`, 100_000); if (!value) throw notFound();
  let index: BackupIndexRecord; try { index = backupIndexSchema.parse(JSON.parse(value.toString())); } catch { throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Backup index is invalid'); }
  if (index.backupId !== backupId || index.installationId !== context.installationId || index.repositoryId !== w.repositoryId() || index.personId !== context.ownAccess.personId) throw notFound();
  const bytes = await readPrivate(deps.artifactRoot, `backups/${backupId}/archive.zip`); if (bytes.length !== index.bytes || archiveHash(bytes) !== index.archiveSha256) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Stored backup failed integrity verification'); return { index, bytes };
}
export async function backupFile(context: MaintenanceContext, backupId: string, deps: ArchiveDependencies): Promise<BackupFile> { const { index, bytes } = await readOwnBackup(context, backupId, deps); return { stream: Readable.from([bytes]), bytes: bytes.length, sha256: index.archiveSha256, name: `uor-workspace-${index.backupId}.zip` }; }
