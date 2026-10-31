import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { uuidSchema } from '../../../domain/workbench/primitives';
import type { CommandContext } from '../../../server/workbench/command-registry';
import type { QueryContext } from '../../../server/workbench/query-registry';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { restoreApplyInputSchema, restoreApplyResultSchema, restorePreviewInputSchema, restoreTokenRecordSchema, type ArchiveDependencies, type BackupIndexRecord, type BackupCreateInput, type BackupCreateResult, type BackupFile, type RestoreApplyInput, type RestoreApplyResult, type RestorePreviewInput, type RestorePreviewResult, type RestoreTokenRecord, type ValidatedWorkspaceArchive } from './contracts';
import { archiveHash, backupFile, backupIndexSchema, readOwnBackup, requireArchiveWorkspace, saveWorkspaceBackup, snapshotWorkspace, synchronousArchiveCall, validateWorkspaceArchive, workspaceRevision, type WorkspaceSnapshot } from './workspace-archive';
import { assertOwnedWorkspaceRoot, clearDeadMaintenanceLock, clearRecoveryRequired, durableWrite, ensurePhysicalDirectory, isRecoveryRequired, latchRecoveryRequired, optionalPrivate, privatePath, readPrivate, withMaintenanceLock } from './private-storage';

const savedTokenSchema = z.strictObject({ binding: restoreTokenRecordSchema, personId: uuidSchema.nullable(), result: restoreApplyResultSchema.nullable() });
type SavedToken = z.infer<typeof savedTokenSchema>;
const journalSchema = z.strictObject({ version: z.literal(1), id: uuidSchema, token: z.string().regex(/^[a-f0-9]{64}$/), previousName: z.string().regex(/^[a-zA-Z0-9._-]+$/), stagedName: z.string().regex(/^restore-[a-f0-9-]{36}$/), previousRevision: z.string().regex(/^[a-f0-9]{64}$/), stagedRevision: z.string().regex(/^[a-f0-9]{64}$/), archiveSha256: z.string().regex(/^[a-f0-9]{64}$/), rescue: z.union([uuidSchema, z.null()]), phase: z.enum(['prepared', 'activating', 'committed', 'rolled_back', 'recovery_required']), result: restoreApplyResultSchema.nullable() });
type RestoreJournal = z.infer<typeof journalSchema>;
const stale = () => new WorkbenchHttpError(409, 'PREVIEW_STALE', 'The workspace or restore preview changed');
const recoveryRequired = () => new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Workspace writes require startup recovery');
const tokenMissing = () => new WorkbenchHttpError(404, 'RESTORE_TOKEN_NOT_FOUND', 'Restore preview not found');
const sortedRecords = (records: ValidatedWorkspaceArchive['records']) => [...records].sort((a, b) => JSON.stringify([a.moduleId, a.schemaId, a.key]).localeCompare(JSON.stringify([b.moduleId, b.schemaId, b.key])));

/** The artifact catalog/tokens/journals live outside the replaced directory and SQLite database. */
export class RestoreService {
  constructor(private readonly deps: ArchiveDependencies) {}
  async createBackup(context: CommandContext, input: BackupCreateInput): Promise<BackupCreateResult> { return withMaintenanceLock(this.deps.artifactRoot, async () => { await this.assertReady(); return saveWorkspaceBackup(context, input, this.deps); }); }
  private async journalNames(): Promise<string[]> { const root = await privatePath(this.deps.artifactRoot, 'journals'); try { return (await readdir(root)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).sort(); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; } }
  private async assertReady(): Promise<void> {
    requireArchiveWorkspace(this.deps);
    if (isRecoveryRequired(this.deps.artifactRoot) || await optionalPrivate(this.deps.artifactRoot, 'recovery-required.json', 10000)) throw recoveryRequired();
    for (const name of await this.journalNames()) { const j = journalSchema.parse(JSON.parse((await readPrivate(this.deps.artifactRoot, 'journals/' + name, 100000)).toString())); if (!['committed', 'rolled_back'].includes(j.phase)) throw recoveryRequired(); }
  }
  private async freeze(causes: unknown[]): Promise<WorkbenchHttpError> {
    latchRecoveryRequired(this.deps.artifactRoot);
    const w = requireArchiveWorkspace(this.deps);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => w.freezeWrites()),
      Promise.resolve().then(() => durableWrite(this.deps.artifactRoot, 'recovery-required.json', JSON.stringify({ at: this.deps.clock.now() }))),
    ]);
    return Object.assign(recoveryRequired(), { cause: new AggregateError([...causes, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])], 'Restore recovery failed; writes remain frozen') });
  }
  private async token(token: string, context: CommandContext): Promise<SavedToken> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw tokenMissing(); const value = await optionalPrivate(this.deps.artifactRoot, `tokens/${token}/metadata.json`, 100000); if (!value) throw tokenMissing(); const saved = savedTokenSchema.parse(JSON.parse(value.toString())); const b = saved.binding;
    if (b.token !== token || b.installationId !== context.installationId || saved.personId !== context.ownAccess.personId || b.sessionId !== this.deps.sessionId(context)) throw tokenMissing();
    if (b.repositoryId !== requireArchiveWorkspace(this.deps).repositoryId()) throw stale(); return saved;
  }
  private async saveToken(saved: SavedToken): Promise<void> { await durableWrite(this.deps.artifactRoot, `tokens/${saved.binding.token}/metadata.json`, JSON.stringify(savedTokenSchema.parse(saved))); }
  private async safeRollback(journal: RestoreJournal): Promise<void> {
    const w = requireArchiveWorkspace(this.deps); const active = path.resolve(await w.activeRoot()); const previous = path.resolve(w.managedRoot, journal.previousName); const staged = path.resolve(w.managedRoot, journal.stagedName); const state = await snapshotWorkspace(this.deps);
    if ((active !== previous || state.revision !== journal.previousRevision) && (active !== staged || state.revision !== journal.stagedRevision)) throw recoveryRequired();
    await w.rollback(previous, journal.previousRevision);
    if (path.resolve(await w.activeRoot()) !== previous || (await snapshotWorkspace(this.deps)).revision !== journal.previousRevision) throw recoveryRequired();
  }
  private async verifyLive(saved: SavedToken, context: CommandContext): Promise<WorkspaceSnapshot> {
    await this.token(saved.binding.token, context); if (Date.parse(this.deps.clock.now()) >= Date.parse(saved.binding.expiresAt)) throw stale();
    const current = await snapshotWorkspace(this.deps); if (current.revision !== saved.binding.stateRevision || current.repositoryId !== saved.binding.repositoryId) throw stale();
    const bytes = await readPrivate(this.deps.artifactRoot, `tokens/${saved.binding.token}/archive.zip`); if (archiveHash(bytes) !== saved.binding.archiveSha256) throw stale();
    return current;
  }
  async previewRestore(context: CommandContext, input: RestorePreviewInput,expectedSourceRevision?:string): Promise<RestorePreviewResult> {
    input = restorePreviewInputSchema.parse(input);
    return withMaintenanceLock(this.deps.artifactRoot, async () => {
      await this.assertReady(); const w = requireArchiveWorkspace(this.deps); const sessionId = this.deps.sessionId(context); if (!sessionId) throw tokenMissing();
      const staged = await this.deps.files.read(input.fileHandle, context.installationId, 'workspace-restore', context.ownAccess.personId);
      const bytes = new Uint8Array(staged.bytesValue); const archiveSha256 = archiveHash(bytes); if (archiveSha256 !== staged.sha256 || bytes.length !== staged.bytes) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Uploaded workspace bytes changed');
      const archive = await validateWorkspaceArchive(bytes, this.deps.modules, w); const current = await snapshotWorkspace(this.deps);
      synchronousArchiveCall(() => w.authorizeCompleteWorkspace(context, { operation: 'replace', records: current.records, incomingRecords: archive.records }));
      await this.stage(archive, randomUUID());
      if(expectedSourceRevision!==undefined&&current.revision!==expectedSourceRevision)throw stale();
      if (this.deps.sessionId(context) !== sessionId) throw tokenMissing();
      const expiresAt = new Date(Date.parse(this.deps.clock.now()) + 30 * 60_000).toISOString(); const token = randomBytes(32).toString('hex');
      const binding: RestoreTokenRecord = { token, archiveSha256, stateRevision: current.revision, repositoryId: current.repositoryId, installationId: context.installationId, sessionId, expiresAt, consumedBy: null };
      await durableWrite(this.deps.artifactRoot, `tokens/${token}/archive.zip`, bytes); await this.saveToken({ binding, personId: context.ownAccess.personId, result: null });
      return { restoreToken: token, archiveSha256, repoId: current.repositoryId, currentStateRevision: current.revision, currentEmpty: current.empty, mode: 'replace', expiresAt, counts: { records: archive.records.length, files: archive.files.size }, warnings: [] };
    });
  }
  private async stage(archive: ValidatedWorkspaceArchive, id: string): Promise<string> {
    const w = requireArchiveWorkspace(this.deps); await ensurePhysicalDirectory(w.managedRoot); const stagedRoot = path.join(w.managedRoot, 'restore-' + id);
    await mkdir(stagedRoot, { mode: 0o700 }); await assertOwnedWorkspaceRoot(w.managedRoot, stagedRoot);
    await durableWrite(stagedRoot, 'workspace-archive-manifest.json', JSON.stringify(archive.manifest));
    for (const [relative, bytes] of archive.files) await durableWrite(stagedRoot, relative, bytes);
    const repository = await w.openStagedRepository(stagedRoot);
    try {
      repository.transaction(() => { for (const [moduleId, codec] of this.deps.modules) synchronousArchiveCall(() => codec.restoreRecords(repository, archive.records.filter(r => r.moduleId === moduleId))); });
      const actual = [...this.deps.modules].flatMap(([moduleId, codec]) => codec.exportRecords(repository).map(r => { if (r.moduleId !== moduleId) throw Error('Foreign staged namespace'); synchronousArchiveCall(() => codec.validate(r)); return r; }));
      if (!isDeepStrictEqual(sortedRecords(actual), sortedRecords(archive.records))) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Staged records do not match the validated archive');
    } finally { repository.close(); }
    for (const [relative, bytes] of archive.files) { const actual = await readPrivate(stagedRoot, relative); if (archiveHash(actual) !== archiveHash(bytes)) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Staged workspace file changed'); }
    return stagedRoot;
  }
  async applyRestore(context: CommandContext, input: RestoreApplyInput): Promise<RestoreApplyResult> {
    input = restoreApplyInputSchema.parse(input);
    return withMaintenanceLock(this.deps.artifactRoot, async () => {
      await this.assertReady(); const w = requireArchiveWorkspace(this.deps); const saved = await this.token(input.restoreToken, context);
      if (saved.result) return saved.result;
      // A committed journal is authoritative even if token finalization was interrupted.
      for (const name of await this.journalNames()) { const j = journalSchema.parse(JSON.parse((await readPrivate(this.deps.artifactRoot, 'journals/' + name, 100000)).toString())); if (j.token === input.restoreToken && j.phase === 'committed' && j.result) { saved.result = j.result; saved.binding.consumedBy = j.id; await this.saveToken(saved); return j.result; } }
      const authorizedCurrent = await this.verifyLive(saved, context);
      const archive = await validateWorkspaceArchive(await readPrivate(this.deps.artifactRoot, `tokens/${input.restoreToken}/archive.zip`), this.deps.modules, w);
      synchronousArchiveCall(() => w.authorizeCompleteWorkspace(context, { operation: 'replace', records: authorizedCurrent.records, incomingRecords: archive.records }));
      const id = randomUUID(); const stagedRoot = await this.stage(archive, id); await this.verifyLive(saved, context);
      const current = await snapshotWorkspace(this.deps); let rescue: RestoreApplyResult['rescue'] = { status: 'empty', backupId: null };
      if (!current.empty) { const backup = await saveWorkspaceBackup(context, { label: 'Before workspace replacement', includeOriginals: true }, this.deps, true); const verified = await readOwnBackup(context, backup.backupId, this.deps); await validateWorkspaceArchive(verified.bytes, this.deps.modules, w); if (backup.sourceStateRevision !== saved.binding.stateRevision) throw stale(); rescue = { status: 'created', backupId: backup.backupId }; }
      let quiesced = false; let journal: RestoreJournal | null = null; let activationAttempted = false; let commitAttempted = false;
      const saveJournal = async () => { await durableWrite(this.deps.artifactRoot, `journals/${id}.json`, JSON.stringify(journalSchema.parse(journal))); };
      try {
        quiesced = true; await this.deps.lifecycle.quiesce(id); const quiescedCurrent = await this.verifyLive(saved, context);
        synchronousArchiveCall(() => w.authorizeCompleteWorkspace(context, { operation: 'replace', records: quiescedCurrent.records, incomingRecords: archive.records }));
        if (rescue.status === 'created') { const verified = await readOwnBackup(context, rescue.backupId, this.deps); await validateWorkspaceArchive(verified.bytes, this.deps.modules, w); }
        const previousRoot = await w.activeRoot(); await assertOwnedWorkspaceRoot(w.managedRoot, previousRoot); if (path.resolve(previousRoot) === path.resolve(stagedRoot)) throw recoveryRequired();
        journal = { version: 1, id, token: input.restoreToken, previousName: path.basename(previousRoot), stagedName: path.basename(stagedRoot), previousRevision: saved.binding.stateRevision, stagedRevision: workspaceRevision(saved.binding.repositoryId, archive.records, archive.manifest.files), archiveSha256: saved.binding.archiveSha256, rescue: rescue.backupId, phase: 'prepared', result: null }; await saveJournal();
        journal.phase = 'activating'; await saveJournal(); activationAttempted = true; await this.deps.lifecycle.activate(stagedRoot);
        if (path.resolve(await w.activeRoot()) !== path.resolve(stagedRoot)) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Workspace activation did not switch the staged directory');
        await w.healthcheck(); await w.invalidateAdmission();
        const activated = await snapshotWorkspace(this.deps);
        const activatedFiles = activated.files.map(({ bytesValue: _bytes, ...meta }) => meta); const expectedFiles = [...archive.manifest.files].sort((a, b) => a.path.localeCompare(b.path));
        if (!isDeepStrictEqual(sortedRecords(activated.records), sortedRecords(archive.records)) || !isDeepStrictEqual(activatedFiles, expectedFiles)) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Activated workspace does not match the validated archive');
        const result: RestoreApplyResult = restoreApplyResultSchema.parse({ mode: 'replace', appliedArchiveSha256: saved.binding.archiveSha256, stateRevision: activated.revision, rescue, recheckRequired: true });
        journal.phase = 'committed'; journal.result = result; commitAttempted = true; await saveJournal();
        saved.binding.consumedBy = context.commandId; saved.result = result; await this.saveToken(saved); return result;
      } catch (e) {
        if (commitAttempted) throw await this.freeze([e]);
        if (activationAttempted && journal) {
          try { await this.safeRollback(journal); await w.healthcheck(); journal.phase = 'rolled_back'; await saveJournal(); }
          catch (rollbackError) {
            latchRecoveryRequired(this.deps.artifactRoot); journal.phase = 'recovery_required'; const causes = [e, rollbackError];
            try { await saveJournal(); } catch (journalError) { causes.push(journalError); }
            throw await this.freeze(causes);
          }
        } else if (journal) { journal.phase = 'rolled_back'; try { await saveJournal(); } catch (journalError) { throw await this.freeze([e, journalError]); } }
        throw e;
      } finally { if (quiesced && !isRecoveryRequired(this.deps.artifactRoot) && !await optionalPrivate(this.deps.artifactRoot, 'recovery-required.json', 10000)) { try { await this.deps.lifecycle.resume(); } catch (error) { throw await this.freeze([error]); } } }
    });
  }
  async getBackupFile(context: QueryContext, backupId: string): Promise<BackupFile> { return backupFile(context, backupId, this.deps); }
  async listOwnBackups(context: QueryContext): Promise<BackupIndexRecord[]> {
    const w = requireArchiveWorkspace(this.deps); const directory = await privatePath(this.deps.artifactRoot, 'backups'); let names: string[];
    try { names = await readdir(directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const result: BackupIndexRecord[] = [];
    for (const id of names.filter(n => uuidSchema.safeParse(n).success)) { const value = await optionalPrivate(this.deps.artifactRoot, `backups/${id}/index.json`, 100000); if (!value) continue; const index = backupIndexSchema.parse(JSON.parse(value.toString())); if (index.backupId === id && index.installationId === context.installationId && index.personId === context.ownAccess.personId && index.repositoryId === w.repositoryId()) result.push(index); }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** Mandatory before startup imports/requests. Never restores an older root after committed. */
  async recover(): Promise<void> {
    const w = requireArchiveWorkspace(this.deps); await clearDeadMaintenanceLock(this.deps.artifactRoot);
    return withMaintenanceLock(this.deps.artifactRoot, async () => {
      try {
        for (const name of await this.journalNames()) {
          const journal = journalSchema.parse(JSON.parse((await readPrivate(this.deps.artifactRoot, 'journals/' + name, 100000)).toString()));
          if (name !== journal.id + '.json') throw recoveryRequired();
          await assertOwnedWorkspaceRoot(w.managedRoot, path.join(w.managedRoot, journal.previousName)); await assertOwnedWorkspaceRoot(w.managedRoot, path.join(w.managedRoot, journal.stagedName));
          if (journal.phase === 'committed') { if (!journal.result) throw recoveryRequired(); const saved = savedTokenSchema.parse(JSON.parse((await readPrivate(this.deps.artifactRoot, `tokens/${journal.token}/metadata.json`, 100000)).toString())); if (saved.binding.archiveSha256 !== journal.archiveSha256) throw recoveryRequired(); saved.result = journal.result; saved.binding.consumedBy ??= journal.id; await this.saveToken(saved); }
          else if (journal.phase !== 'rolled_back') { await this.safeRollback(journal); journal.phase = 'rolled_back'; await durableWrite(this.deps.artifactRoot, 'journals/' + name, JSON.stringify(journal)); }
        }
        await this.deps.lifecycle.recover(); await w.healthcheck();
        const marker = await optionalPrivate(this.deps.artifactRoot, 'recovery-required.json', 10000); if (marker) { const { unlink } = await import('node:fs/promises'); await unlink(await privatePath(this.deps.artifactRoot, 'recovery-required.json')); }
        await this.deps.lifecycle.resume();
        clearRecoveryRequired(this.deps.artifactRoot);
      } catch (error) { throw await this.freeze([error]); }
    });
  }
}
