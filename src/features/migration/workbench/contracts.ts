import { z } from 'zod';
import { entityRefSchema, sha256Schema, uuidSchema } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { problemSchema, revisionTokenSchema, WorkbenchHttpError } from '../../../server/workbench/protocol';
import type { WorkspaceArchiveCodec, WorkspaceArchiveRecord } from '../../workspace-maintenance/workbench/contracts';
import { assertJsonSafety } from '../../workspace-maintenance/zip';

const legacyId = z.string().min(1).max(500);
export const legacyMigrationInputSchema = z.strictObject({ sourceFileHandle: uuidSchema, attachmentFileHandles: z.array(uuidSchema).max(4093), mappingFileHandle: uuidSchema.nullable() }).refine(v => new Set(v.attachmentFileHandles).size === v.attachmentFileHandles.length);
export type LegacyMigrationInput = z.infer<typeof legacyMigrationInputSchema>;
export const legacyIdMappingSchema = z.strictObject({ legacyType: z.string().regex(/^[a-z][a-z0-9_-]*$/), legacyId, targetRef: entityRefSchema });
export type LegacyIdMapping = z.infer<typeof legacyIdMappingSchema>;
export const legacyMappingFileSchema = z.strictObject({ schemaVersion: z.literal(1), mappings: z.array(legacyIdMappingSchema) });
export const legacyMigrationIssueSchema = z.strictObject({ legacyId, code: z.string().regex(/^[A-Z0-9_]+$/), reason: z.string().min(1).max(300) });
export type LegacyMigrationIssue = z.infer<typeof legacyMigrationIssueSchema>;
const countsSchema = z.strictObject({ input: z.number().int().nonnegative(), accepted: z.number().int().nonnegative(), problematic: z.number().int().nonnegative() }).refine(v => v.input === v.accepted + v.problematic);
export const legacyMigrationReportSchema = z.strictObject({ sourceHash: sha256Schema, reportToken: z.string().regex(/^[a-f0-9]{64}$/), counts: countsSchema,
  mappings: z.array(legacyIdMappingSchema), issues: z.array(legacyMigrationIssueSchema), basisVerified: z.boolean(), warnings: z.array(problemSchema) });
export type LegacyMigrationReport = z.infer<typeof legacyMigrationReportSchema>;
export const legacyMigrationResultSchema = z.strictObject({ sourceHash: sha256Schema, stateRevision: revisionTokenSchema, counts: countsSchema, requiresCuratorReview: z.literal(true) });
export type LegacyMigrationResult = z.infer<typeof legacyMigrationResultSchema>;
export const legacyMigrationApplySchema = z.strictObject({ reportToken: z.string().regex(/^[a-f0-9]{64}$/), confirmedMappings: z.array(legacyIdMappingSchema) });
export const legacyRecordSchema = z.strictObject({ schemaVersion: z.literal(1), id: uuidSchema, sourceHash: sha256Schema, mappingHash: z.string().regex(/^[a-f0-9]{64}$/),
  legacyType: z.string().regex(/^[a-z][a-z0-9_-]*$/), legacyId, targetRef: entityRefSchema, original: z.record(z.string(), z.unknown()),
  historicalDate: z.string().nullable(), origin: z.string().nullable(), issues: z.array(legacyMigrationIssueSchema),
  links: z.array(z.strictObject({ field: z.string(), legacyType: z.string(), legacyId, targetRef: entityRefSchema.nullable() })),
});
export const legacyImportSchema = z.strictObject({ schemaVersion: z.literal(1), sourceHash: sha256Schema, mappingHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFileSha256: z.string().regex(/^[a-f0-9]{64}$/), attachmentHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  mappings: z.array(legacyIdMappingSchema), counts: countsSchema, basisVerified: z.literal(false), requiresCuratorReview: z.literal(true) });
const unavailable = () => new WorkbenchHttpError(422, 'LEGACY_ARCHIVE_INVALID', 'Invalid inert legacy archive record');
export function assertLegacyPayloadSafety(value: unknown): void {
  assertJsonSafety(value);
  const visit = (item: unknown) => { if (Array.isArray(item)) { item.forEach(visit); return; } if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { if (/^(?:password|accessToken|refreshToken|privateKey|certificatePem|cookies?|authorization|curatorCode|sessions?|sessionId|ownerSessionId|csrfToken|registry|serviceSettings|browserProfile|credentials)$/i.test(key)) throw unavailable(); visit(child); } };
  visit(value);
}
/** SQL and archived records belong only to this module; there is no core goal/method fallback. */
export function createLegacyMigrationArchiveCodec(): WorkspaceArchiveCodec {
  const validate = (record: WorkspaceArchiveRecord) => {
    if (record.moduleId !== 'legacy_migration' || record.schemaVersion !== 1 || !/^[a-f0-9]{64}\/[a-f0-9]{64}(?:\/[a-z][a-z0-9_-]*\/[a-f0-9-]{36})?$/.test(record.key)) throw unavailable();
    const value = record.schemaId === 'legacy.record' ? legacyRecordSchema.parse(record.value) : record.schemaId === 'legacy.import' ? legacyImportSchema.parse(record.value) : (() => { throw unavailable(); })();
    if (!record.key.startsWith(value.sourceHash.slice(7) + '/' + value.mappingHash)) throw unavailable();
    if (record.schemaId === 'legacy.record') { const r = legacyRecordSchema.parse(value); if (record.key !== `${r.sourceHash.slice(7)}/${r.mappingHash}/${r.legacyType}/${r.id}` || (r.targetRef.entityType === 'legacy_record' && r.targetRef.id !== r.id)) throw unavailable(); }
    else if (record.key !== `${value.sourceHash.slice(7)}/${value.mappingHash}` || legacyImportSchema.parse(value).sourceFileSha256 !== value.sourceHash.slice(7)) throw unavailable();
    assertLegacyPayloadSafety(value);
  };
  return { moduleId: 'legacy_migration', exportRecords: readLegacyMigrationRecords, validate,
    restoreRecords(repository, records) {
      const sql = repository.sqlForModule('legacy_migration'); sql.execMigration('v1', 'CREATE TABLE IF NOT EXISTS wb_legacy_migration_records (key TEXT PRIMARY KEY, schema_id TEXT NOT NULL, payload TEXT NOT NULL)');
      for (const record of records) { validate(record); sql.run('INSERT INTO wb_legacy_migration_records (key,schema_id,payload) VALUES (?,?,?)', [record.key, record.schemaId, JSON.stringify(record.value)]); }
      const values = records.filter(r => r.schemaId === 'legacy.record').map(r => legacyRecordSchema.parse(r.value));
      const identity = (source: string, mapping: string, type: string, id: string) => JSON.stringify([source, mapping, type, id]);
      const targets = new Map<string, typeof values[number]['targetRef']>();
      for (const value of values) { const key = identity(value.sourceHash, value.mappingHash, value.legacyType, value.legacyId); if (targets.has(key)) throw unavailable(); targets.set(key, value.targetRef); }
      for (const value of values) {
        if (value.targetRef.entityType !== 'legacy_record' && !repository.getHead(value.targetRef)) throw unavailable();
        for (const link of value.links) if (link.targetRef) {
          const target = targets.get(identity(value.sourceHash, value.mappingHash, link.legacyType, link.legacyId));
          if (!target || target.entityType !== link.targetRef.entityType || target.id !== link.targetRef.id || (target.entityType !== 'legacy_record' && !repository.getHead(target))) throw unavailable();
        }
      }
    }, isUserData: () => true };
}
export function readLegacyMigrationRecords(repository: WorkbenchRepository): WorkspaceArchiveRecord[] {
  try { return repository.sqlForModule('legacy_migration').all<{ key: string; schema_id: string; payload: string }>('SELECT key,schema_id,payload FROM wb_legacy_migration_records ORDER BY key').map(row => ({ moduleId: 'legacy_migration', schemaId: row.schema_id, schemaVersion: 1, key: row.key, value: JSON.parse(row.payload) })); }
  catch (error) { if (error instanceof Error && /no such table: wb_legacy_migration_records/.test(error.message)) return []; throw error; }
}
