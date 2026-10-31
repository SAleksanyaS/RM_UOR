import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { Clock } from '../../../domain/workbench/primitives';
import { moscowDateSchema } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { CommandContext } from '../../../server/workbench/command-registry';
import type { FileStore, StagedFile } from '../../../server/workbench/files';
import { WorkbenchHttpError, problemSchema } from '../../../server/workbench/protocol';
import type { MaintenanceService } from '../../workspace-maintenance/workbench/maintenance-service';
import type { WorkspaceArchiveFileSource, WorkspaceArchiveRecord } from '../../workspace-maintenance/workbench/contracts';
import { durableWrite, optionalPrivate, readPrivate, withMaintenanceLock } from '../../workspace-maintenance/workbench/private-storage';
import { loadPortableZip } from '../../workspace-maintenance/zip';
import { validateWorkspaceBundle } from '../../workspace-maintenance/bundle-service';
import { assertLegacyPayloadSafety, legacyImportSchema, legacyMappingFileSchema, legacyMigrationApplySchema, legacyMigrationInputSchema, legacyMigrationReportSchema, legacyMigrationResultSchema, legacyRecordSchema, readLegacyMigrationRecords, type LegacyIdMapping, type LegacyMigrationInput, type LegacyMigrationIssue, type LegacyMigrationReport, type LegacyMigrationResult } from './contracts';

type Dependencies = { files: FileStore; repository: WorkbenchRepository; clock: Clock; stagingRoot: string; maintenance: MaintenanceService };
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const ordered = (mappings: LegacyIdMapping[]) => [...mappings].sort((a, b) => canonical([a.legacyType, a.legacyId]).localeCompare(canonical([b.legacyType, b.legacyId])));
const keyOf = (type: string, id: string) => canonical([type, id]);
const stale = () => new WorkbenchHttpError(409, 'PREVIEW_STALE', 'Migration inputs, mapping, owner or target changed');
const invalid = () => new WorkbenchHttpError(422, 'LEGACY_INPUT_INVALID', 'Unsupported or unsafe legacy input');
const tokenMissing = () => new WorkbenchHttpError(404, 'MIGRATION_TOKEN_NOT_FOUND', 'Own migration preview not found');
const savedSchema = z.strictObject({ report: legacyMigrationReportSchema, sourceSha256: z.string(), mappingHash: z.string(), attachmentHashes: z.array(z.string()),
  owner: z.string(), session: z.string(), repoId: z.string().min(1), repositoryState: z.string(), restoreToken: z.string(), expiresAt: z.string(), result: legacyMigrationResultSchema.nullable() });
const permittedNamespaces = new Set(['catalog', 'drafts', 'draft-history', 'snapshots', 'attestations', 'evidence', 'changes', 'shared-changes', 'published-items', 'import-artifacts', 'connector-artifacts', 'execution-journal']);
type OldRecord = { legacyType: string; legacyId: string; original: Record<string, unknown> };
type Source = { namespace: string; records: OldRecord[]; files: WorkspaceArchiveFileSource[] };
const object = z.record(z.string(), z.unknown());
const historicalDateSchema = z.union([moscowDateSchema, z.iso.datetime({ offset: true }).refine(value => moscowDateSchema.safeParse(value.slice(0, 10)).success)]);
function safeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // Inspect decoded keys before parsing the document: JSON.parse otherwise loses earlier duplicate values.
  const containers: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '{' || char === '[') { containers.push(char === '{' ? new Set() : null); if (containers.length > 64) throw invalid(); }
    else if (char === '}' || char === ']') containers.pop();
    else if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') { if (text[index] === '\\') index++; index++; }
      const decoded: string = JSON.parse(text.slice(start, index + 1));
      let next = index + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] === ':') {
        const keys = containers.at(-1); if (!keys || keys.has(decoded)) throw invalid(); keys.add(decoded);
      }
    }
  }
  const value: unknown = JSON.parse(text); assertLegacyPayloadSafety(value); return value;
}
function flattenCatalog(value: unknown): { namespace: string; records: OldRecord[] } {
  const catalog = z.object({ schemaVersion: z.literal(1), id: z.string().min(1), name: z.string(), goals: z.array(object), leaders: z.array(object), assignments: z.array(object), sources: z.array(object), comments: z.array(object), entities: z.array(object), directions: z.array(object).optional() }).passthrough().parse(value);
  const records: OldRecord[] = [{ legacyType: 'catalog', legacyId: catalog.id, original: catalog }];
  const types = { goals: 'goal', leaders: 'leader', assignments: 'assignment', sources: 'source', comments: 'comment', entities: 'entity', directions: 'direction' } as const;
  for (const [list, type] of Object.entries(types)) for (const original of (catalog[list as keyof typeof types] ?? [])) records.push({ legacyType: type, legacyId: z.string().min(1).max(500).parse(original.id), original });
  return { namespace: catalog.id, records };
}
async function decodeSource(file: StagedFile): Promise<Source> {
  try {
    if (file.name.toLowerCase().endsWith('.json') && file.mediaType === 'application/json') return { ...flattenCatalog(safeJson(file.bytesValue)), files: [] };
    if (!file.name.toLowerCase().endsWith('.zip') || file.mediaType !== 'application/zip') throw invalid();
    const bytes = Buffer.from(file.bytesValue); const zip = await loadPortableZip(bytes);
    const manifest = object.parse(safeJson(await zip.file('manifest.json')!.async('uint8array')));
    const rawRecords = z.array(z.strictObject({ namespace: z.string(), id: z.string().min(1).max(500), value: object })).parse(safeJson(await zip.file('records.json')!.async('uint8array')));
    if (rawRecords.some(r => !permittedNamespaces.has(r.namespace)) || manifest.applicationVersion !== '0.4.1') throw invalid();
    // The existing exporter/validator is the authoritative 0.4.1 wire format, not an invented bundle dialect.
    const checked = await validateWorkspaceBundle(bytes);
    const catalog = flattenCatalog(checked.catalog);
    const files = checked.manifest.files.map(file => ({ path: 'files/' + file.sha256, kind: file.kind, bytesValue: new Uint8Array(checked.files.get(file.key)!) }));
    return { ...catalog, records: [...catalog.records, ...rawRecords.filter(r => r.namespace !== 'catalog').map(r => ({ legacyType: r.namespace, legacyId: r.id, original: r.value }))], files };
  } catch { throw invalid(); }
}
function stableId(namespace: string, type: string, id: string): string {
  const hex = digest(canonical(['uor-legacy-v1', namespace, type, id]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const warning = (code: string, message: string) => problemSchema.parse({ code, message, retryable: false, details: [], operationId: null, provider: null });
const ownerKey = (context: CommandContext) => digest(canonical([context.installationId, context.ownAccess.personId]));
function requireCurator(context: CommandContext) { if (!['curator', 'chief'].includes(context.ownAccess.role)) throw new WorkbenchHttpError(403, 'FORBIDDEN', 'Legacy migration requires a curator'); }
function verifiedBytes(file: StagedFile) { if (digest(file.bytesValue) !== file.sha256 || file.bytesValue.length !== file.bytes) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Migration file bytes changed'); }

export class LegacyStagingMigration {
  constructor(private readonly deps: Dependencies) {}
  async preview(context: CommandContext, input: LegacyMigrationInput): Promise<LegacyMigrationReport> {
    requireCurator(context); input = legacyMigrationInputSchema.parse(input);
    return withMaintenanceLock(this.deps.stagingRoot, async () => {
      const session = this.deps.maintenance.migrationSessionBinding(context); if (!session) throw tokenMissing();
      const repoId = this.deps.maintenance.migrationRepositoryBinding(context);
      const sourceFile = await this.deps.files.read(input.sourceFileHandle, context.installationId, 'goal-import', context.ownAccess.personId); verifiedBytes(sourceFile);
      const source = await decodeSource(sourceFile); const sourceHash = 'sha256:' + sourceFile.sha256;
      const attachments = await Promise.all(input.attachmentFileHandles.map(handle => this.deps.files.read(handle, context.installationId, 'evidence', context.ownAccess.personId)));
      attachments.forEach(verifiedBytes);
      let overrides: LegacyIdMapping[] = [];
      if (input.mappingFileHandle) { const file = await this.deps.files.read(input.mappingFileHandle, context.installationId, 'goal-import', context.ownAccess.personId); verifiedBytes(file); overrides = legacyMappingFileSchema.parse(safeJson(file.bytesValue)).mappings; }
      const recordKeys = new Set(source.records.map(r => keyOf(r.legacyType, r.legacyId)));
      if (recordKeys.size !== source.records.length || new Set(overrides.map(m => keyOf(m.legacyType, m.legacyId))).size !== overrides.length || overrides.some(m => !recordKeys.has(keyOf(m.legacyType, m.legacyId)))) throw invalid();
      for (const mapping of overrides) if (mapping.targetRef.entityType === 'legacy_record' || !this.deps.repository.getHead(mapping.targetRef)) throw new WorkbenchHttpError(422, 'LEGACY_MAPPING_TARGET_INVALID', 'Explicit mapping must link a validated existing business entity');
      const mappings = ordered(source.records.map(record => overrides.find(m => m.legacyType === record.legacyType && m.legacyId === record.legacyId) ?? { legacyType: record.legacyType, legacyId: record.legacyId, targetRef: { entityType: 'legacy_record', id: stableId(source.namespace, record.legacyType, record.legacyId) } }));
      const attachmentHashes = [...new Set([...source.files.map(f => digest(f.bytesValue)), ...attachments.map(f => f.sha256)])].sort();
      const mappingHash = digest(canonical({ mappings, attachmentHashes }));
      const receiptPath = `receipts/${ownerKey(context)}/${sourceFile.sha256}-${mappingHash}.json`;
      const existing = await optionalPrivate(this.deps.stagingRoot, receiptPath);
      if (existing) {
        const saved = savedSchema.parse(JSON.parse(existing.toString()));
        const imported = readLegacyMigrationRecords(this.deps.repository).some(r => r.schemaId === 'legacy.import' && r.key === `${sourceFile.sha256}/${mappingHash}`);
        if (this.deps.maintenance.migrationSessionBinding(context) !== session || this.deps.maintenance.migrationRepositoryBinding(context) !== repoId) throw stale();
        if (saved.owner === ownerKey(context) && saved.session === session && saved.repoId === repoId && saved.result && imported) return saved.report;
      }
      const issues: LegacyMigrationIssue[] = []; let problematic = 0;
      const records: WorkspaceArchiveRecord[] = source.records.map(record => {
        const recordIssues: LegacyMigrationIssue[] = [];
        const issue = (code: string, reason: string) => recordIssues.push({ legacyId: record.legacyId, code, reason });
        if (record.legacyType === 'goal' || (record.legacyType === 'snapshots' && !record.original.evaluationBasis)) issue('LEGACY_BASIS_UNVERIFIED', 'Preserved old meaning has not been converted to a verified new methodology');
        const links: z.infer<typeof legacyRecordSchema>['links'] = [];
        const fields: Record<string, string> = { goalId: 'goal', leaderId: 'leader', sourceId: 'source', workDirectionId: 'direction', productId: 'entity' };
        for (const [field, type] of Object.entries(fields)) if (typeof record.original[field] === 'string') {
          const id = record.original[field] as string; const ref = mappings.find(m => m.legacyType === type && m.legacyId === id)?.targetRef ?? null;
          links.push({ field, legacyType: type, legacyId: id, targetRef: ref }); if (!ref) issue('LEGACY_DANGLING_REFERENCE', 'The old referenced object is absent; no replacement was guessed');
        }
        const dateField = record.legacyType === 'comment' ? 'createdAt' : record.legacyType === 'snapshots' ? 'period' : ['changes', 'shared-changes', 'execution-journal'].includes(record.legacyType) ? 'at' : null;
        const rawDate = dateField ? record.original[dateField] : null;
        const historicalDate = typeof rawDate === 'string' && historicalDateSchema.safeParse(rawDate).success ? rawDate : null;
        if (dateField && !historicalDate) issue('LEGACY_DATE_UNKNOWN', 'No trusted historical date is present; migration time is not substituted');
        const origin = typeof record.original.origin === 'string' ? record.original.origin : null;
        if (['snapshots', 'comment', 'changes', 'shared-changes', 'execution-journal'].includes(record.legacyType) && !origin) issue('LEGACY_ORIGIN_UNKNOWN', 'Original provenance is unknown and remains unknown');
        if (recordIssues.length) problematic++; issues.push(...recordIssues);
        const id = stableId(source.namespace, record.legacyType, record.legacyId);
        const value = legacyRecordSchema.parse({ schemaVersion: 1, id, sourceHash, mappingHash, legacyType: record.legacyType, legacyId: record.legacyId,
          targetRef: mappings.find(m => m.legacyType === record.legacyType && m.legacyId === record.legacyId)!.targetRef, original: record.original, historicalDate, origin, issues: recordIssues, links });
        return { moduleId: 'legacy_migration', schemaId: 'legacy.record', schemaVersion: 1, key: `${sourceFile.sha256}/${mappingHash}/${record.legacyType}/${id}`, value };
      });
      const counts = { input: records.length, accepted: records.length - problematic, problematic };
      records.push({ moduleId: 'legacy_migration', schemaId: 'legacy.import', schemaVersion: 1, key: `${sourceFile.sha256}/${mappingHash}`, value: legacyImportSchema.parse({ schemaVersion: 1, sourceHash, mappingHash, sourceFileSha256: sourceFile.sha256, attachmentHashes, mappings, counts, basisVerified: false, requiresCuratorReview: true }) });
      const files = [...source.files, { path: 'files/' + sourceFile.sha256, kind: 'original' as const, bytesValue: new Uint8Array(sourceFile.bytesValue) }, ...attachments.map(file => ({ path: 'files/' + file.sha256, kind: 'evidence' as const, bytesValue: new Uint8Array(file.bytesValue) }))];
      const byPath = new Map<string, WorkspaceArchiveFileSource>();
      const priority = { original: 0, module: 1, evidence: 2 };
      for (const file of files) {
        const previous = byPath.get(file.path);
        if (previous && !Buffer.from(previous.bytesValue).equals(Buffer.from(file.bytesValue))) throw invalid();
        if (!previous || priority[file.kind] > priority[previous.kind]) byPath.set(file.path, file);
      }
      const uniqueFiles = [...byPath.values()];
      const repositoryState = this.deps.repository.getStateRevision();
      const restore = await this.deps.maintenance.prepareLegacyRestore(context, { records, files: uniqueFiles });
      if (this.deps.repository.getStateRevision() !== repositoryState || this.deps.maintenance.migrationSessionBinding(context) !== session || this.deps.maintenance.migrationRepositoryBinding(context) !== repoId || restore.repoId !== repoId) throw stale();
      const reportToken = randomBytes(32).toString('hex');
      const report = legacyMigrationReportSchema.parse({ sourceHash, reportToken, counts, mappings, issues, basisVerified: false, warnings: [warning('BP04_NOT_VERIFIED', 'Actual bank source completeness and curator acceptance remain unverified'), warning('LEGACY_ARCHIVAL_REVIEW_REQUIRED', 'Accepted counts describe inert preserved objects, not converted business goals or newly verified facts')] });
      const saved = savedSchema.parse({ report, sourceSha256: sourceFile.sha256, mappingHash, attachmentHashes, owner: ownerKey(context), session, repoId: restore.repoId, repositoryState, restoreToken: restore.restoreToken, expiresAt: restore.expiresAt, result: null });
      await durableWrite(this.deps.stagingRoot, `tokens/${reportToken}/source`, sourceFile.bytesValue);
      await durableWrite(this.deps.stagingRoot, `tokens/${reportToken}/metadata.json`, JSON.stringify(saved));
      return report;
    });
  }
  async apply(context: CommandContext, input: { reportToken: string; confirmedMappings: LegacyIdMapping[] }): Promise<LegacyMigrationResult> {
    requireCurator(context); input = legacyMigrationApplySchema.parse(input);
    return withMaintenanceLock(this.deps.stagingRoot, async () => {
      const bytes = await optionalPrivate(this.deps.stagingRoot, `tokens/${input.reportToken}/metadata.json`); if (!bytes) throw tokenMissing();
      const saved = savedSchema.parse(JSON.parse(bytes.toString()));
      if (saved.owner !== ownerKey(context) || saved.session !== this.deps.maintenance.migrationSessionBinding(context) || saved.report.reportToken !== input.reportToken) throw tokenMissing();
      if (saved.repoId !== this.deps.maintenance.migrationRepositoryBinding(context)) throw stale();
      if (!isDeepStrictEqual(ordered(input.confirmedMappings), ordered(saved.report.mappings))) throw stale();
      if (digest(await readPrivate(this.deps.stagingRoot, `tokens/${input.reportToken}/source`)) !== saved.sourceSha256 || saved.report.sourceHash !== 'sha256:' + saved.sourceSha256) throw stale();
      if (saved.owner !== ownerKey(context) || saved.session !== this.deps.maintenance.migrationSessionBinding(context)) throw tokenMissing();
      if (saved.repoId !== this.deps.maintenance.migrationRepositoryBinding(context)) throw stale();
      if (saved.result) return saved.result;
      const imported = readLegacyMigrationRecords(this.deps.repository).some(r => r.schemaId === 'legacy.import' && r.key === `${saved.sourceSha256}/${saved.mappingHash}`);
      if (!imported && (this.deps.repository.getStateRevision() !== saved.repositoryState || Date.parse(this.deps.clock.now()) >= Date.parse(saved.expiresAt))) throw stale();
      // The actual active switch, rescue, verification and crash recovery are owned by T28, never direct writes here.
      const restored = await this.deps.maintenance.applyRestore(context, { restoreToken: saved.restoreToken, confirmReplacement: true });
      const result = legacyMigrationResultSchema.parse({ sourceHash: saved.report.sourceHash, stateRevision: restored.stateRevision, counts: saved.report.counts, requiresCuratorReview: true });
      saved.result = result;
      await durableWrite(this.deps.stagingRoot, `tokens/${input.reportToken}/metadata.json`, JSON.stringify(saved));
      await durableWrite(this.deps.stagingRoot, `receipts/${saved.owner}/${saved.sourceSha256}-${saved.mappingHash}.json`, JSON.stringify(saved));
      return result;
    });
  }
}
