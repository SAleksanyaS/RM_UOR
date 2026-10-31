import type { Readable } from 'node:stream';
import { z } from 'zod';
import { actorRefSchema, utcInstantSchema, uuidSchema, type ActorRef, type Clock, type UUIDv4, type UtcInstant } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { CommandContext } from '../../../server/workbench/command-registry';
import type { QueryContext } from '../../../server/workbench/query-registry';
import type { FileStore } from '../../../server/workbench/files';
import type { JobSink, JobStore } from '../../../server/workbench/jobs';
import { problemSchema, revisionTokenSchema, type RevisionToken, type Problem } from '../../../server/workbench/protocol';
import type { CodeUpdateService } from '../../system/workbench/code-update-service';

export const rawSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type RawSha256 = string;
const count = z.number().int().nonnegative().safe();
export const backupCreateInputSchema = z.strictObject({ label: z.string().min(1).max(200).nullable(), includeOriginals: z.boolean() });
export const backupCreateResultSchema = z.strictObject({ backupId: uuidSchema, archiveSha256: rawSha256Schema, bytes: count, createdAt: utcInstantSchema, sourceStateRevision: revisionTokenSchema, empty: z.boolean(), omissions: z.array(z.string()) });
export const restorePreviewInputSchema = z.strictObject({ fileHandle: uuidSchema });
export const restorePreviewResultSchema = z.strictObject({ restoreToken: z.string().min(1), archiveSha256: rawSha256Schema, repoId: z.string().min(1), currentStateRevision: revisionTokenSchema, currentEmpty: z.boolean(), mode: z.literal('replace'), expiresAt: utcInstantSchema, counts: z.strictObject({ records: count, files: count }), warnings: z.array(problemSchema) });
export const restoreApplyInputSchema = z.strictObject({ restoreToken: z.string().min(1), confirmReplacement: z.literal(true) });
export const rescueSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('created'), backupId: uuidSchema }), z.strictObject({ status: z.literal('empty'), backupId: z.null() })]);
export const restoreApplyResultSchema = z.strictObject({ mode: z.literal('replace'), appliedArchiveSha256: rawSha256Schema, stateRevision: revisionTokenSchema, rescue: rescueSchema, recheckRequired: z.literal(true) });
export type BackupCreateInput = z.infer<typeof backupCreateInputSchema>;
export type BackupCreateResult = z.infer<typeof backupCreateResultSchema>;
export type RestorePreviewInput = z.infer<typeof restorePreviewInputSchema>;
export type RestorePreviewResult = z.infer<typeof restorePreviewResultSchema>;
export type RestoreApplyInput = z.infer<typeof restoreApplyInputSchema>;
export type RestoreApplyResult = z.infer<typeof restoreApplyResultSchema>;
export type BackupFile = { stream: Readable; bytes: number; sha256: RawSha256; name: string };
export const archiveRecordSchema = z.strictObject({ moduleId: z.string().regex(/^[a-z][a-z0-9_-]*$/), schemaId: z.string().min(1).max(200), schemaVersion: z.number().int().positive().safe(), key: z.string().min(1).max(1000), value: z.unknown() });
export type WorkspaceArchiveRecord = z.infer<typeof archiveRecordSchema>;
export const archiveFileSchema = z.strictObject({ path: z.string().regex(/^files\/[a-f0-9]{64}$/), sha256: rawSha256Schema, bytes: count, kind: z.enum(['evidence', 'original', 'module']) });
export const archiveManifestSchema = z.strictObject({ format: z.literal('uor-workspace-v1'), version: z.literal(1), applicationVersion: z.string().min(1).max(100), storageSchemaVersion: z.number().int().positive().safe(), createdAt: utcInstantSchema, actor: actorRefSchema, recordsSha256: rawSha256Schema, files: z.array(archiveFileSchema).max(4094), exclusions: z.array(z.string().max(200)).max(100) });
export type WorkspaceArchiveManifest = z.infer<typeof archiveManifestSchema>;
export type ValidatedWorkspaceArchive = { manifest: WorkspaceArchiveManifest; records: WorkspaceArchiveRecord[]; files: ReadonlyMap<string, Uint8Array> };
export const restoreTokenRecordSchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/), archiveSha256: rawSha256Schema, stateRevision: revisionTokenSchema, repositoryId: z.string().min(1), installationId: uuidSchema, sessionId: z.string().min(1), expiresAt: utcInstantSchema, consumedBy: uuidSchema.nullable() });
export type RestoreTokenRecord = z.infer<typeof restoreTokenRecordSchema>;
export type WorkspaceArchiveCodec = { moduleId: string; exportRecords(repository: WorkbenchRepository): WorkspaceArchiveRecord[]; validate(record: WorkspaceArchiveRecord): void; restoreRecords(repository: WorkbenchRepository, records: WorkspaceArchiveRecord[]): void; isUserData(record: WorkspaceArchiveRecord): boolean };
export type WorkspaceLifecycle = { quiesce(operationId: UUIDv4): Promise<void>; resume(): Promise<void>; activate(stagedRoot: string): Promise<void>; recover(): Promise<void> };
export type WorkspaceArchiveFileSource = { path: string; kind: 'evidence' | 'original' | 'module'; bytesValue: Uint8Array };
/** Server-only completeness/ownership contract. Never derive this inventory from the incoming archive.
 * All files must be owner-whitelisted, inert subject files; never scan a runtime/browser/profile root.
 * managedRoot contains only owned active/staged workspace directories. artifactRoot is independent.
 * activate/rollback must atomically switch a coherent directory and rebind the stable repository facade.
 */
export type WorkspaceArchiveWorkspacePort = {
  repositoryId(): string; applicationVersion: string; storageSchemaVersion: number; requiredModuleIds: readonly string[]; managedRoot: string;
  activeRoot(): Promise<string>;
  files(records: readonly WorkspaceArchiveRecord[]): Promise<WorkspaceArchiveFileSource[]>;
  validateArchive(archive: ValidatedWorkspaceArchive): void;
  /** Mandatory trusted owner policy for the COMPLETE inventory (including private file owners).
   * Throw ACCESS_DENIED for any private owner other than context.ownAccess.personId, including
   * anonymous callers, unless a separate explicit trusted transfer policy authorizes it.
   * Unknown ownership must fail closed. Never filter records to manufacture an incomplete rescue.
   * Replace checks both retained target records and incoming records; export also governs rescue.
   * This synchronous check must not mutate records. T39 supplies the actual module owner adapter.
   */
  authorizeCompleteWorkspace(context: MaintenanceContext, request: { operation: 'export' | 'replace'; records: readonly WorkspaceArchiveRecord[]; incomingRecords?: readonly WorkspaceArchiveRecord[] }): void;
  openStagedRepository(stagedRoot: string): Promise<WorkbenchRepository>;
  healthcheck(): Promise<void>;
  /** Verify the previous owned root still has this complete subject fingerprint before switching. */
  rollback(previousRoot: string, expectedStateRevision: string): Promise<void>;
  invalidateAdmission(): Promise<void>;
  freezeWrites(): Promise<void>;
};
export type ArchiveDependencies = { repository: WorkbenchRepository; artifactRoot: string; files: FileStore; sessionId(context: CommandContext): string; modules: ReadonlyMap<string, WorkspaceArchiveCodec>; lifecycle: WorkspaceLifecycle; clock: Clock; workspace?: WorkspaceArchiveWorkspacePort };
export type MaintenanceDependencies = { archive: ArchiveDependencies; codeUpdate?: CodeUpdateService; jobs: JobStore; jobSink: JobSink };
export type BackupIndexRecord = BackupCreateResult & { repositoryId: string; installationId: UUIDv4; personId: UUIDv4 | null; rescue: boolean };
export type MaintenanceContext = CommandContext | QueryContext;
export type { ActorRef, UUIDv4, UtcInstant, RevisionToken, Problem };
