import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createWorkbenchRepository, type WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createFileStore, defaultFileLimits } from '../../../server/workbench/files';
import type { CommandContext } from '../../../server/workbench/command-registry';
import type { ArchiveDependencies, WorkspaceArchiveCodec, WorkspaceArchiveFileSource } from './contracts';
import { RestoreService } from './restore-service';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';

export const digest = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export async function fixture(initial: string | null = null) {
  const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 'uor-t28-'));
  const managed = path.join(root, 'managed'); const artifacts = path.join(root, 'archives');
  let active = path.join(managed, 'initial'); await mkdir(active, { recursive: true });
  let repository = createWorkbenchRepository({ filename: path.join(active, 'workspace.sqlite'), artifactRoot: path.join(active, 'files') });
  const init = (r: WorkbenchRepository) => r.sqlForModule('personal').execMigration('v1', 'CREATE TABLE IF NOT EXISTS wb_personal_values (key TEXT PRIMARY KEY, payload TEXT NOT NULL)');
  const put = (value: string, ownerPersonId?: string) => repository.transaction(() => { init(repository); repository.sqlForModule('personal').run('INSERT OR REPLACE INTO wb_personal_values VALUES (?,?)', ['same-id', JSON.stringify({ value, ...(ownerPersonId ? { ownerPersonId } : {}) })]); });
  init(repository); if (initial !== null) put(initial);
  let now = '2026-10-31T12:00:00.000Z'; let session = randomUUID(); let repoId = 'repo-one';
  let activations = 0; let invalidations = 0; let frozen = false;
  const files: WorkspaceArchiveFileSource[] = [];
  const addFile = async (kind: WorkspaceArchiveFileSource['kind'], bytesValue: Uint8Array) => { const relative = 'files/' + digest(bytesValue); await writeFile(path.join(active, relative), bytesValue); files.push({ path: relative, kind, bytesValue: new Uint8Array(bytesValue) }); };
  const fileSets = new Map<string, WorkspaceArchiveFileSource[]>();
  const switchFiles = async (nextRoot: string) => {
    fileSets.set(active, files.map(f => ({ ...f, bytesValue: new Uint8Array(f.bytesValue) })));
    let next = fileSets.get(nextRoot);
    if (!next) { const manifest = JSON.parse(await readFile(path.join(nextRoot, 'workspace-archive-manifest.json'), 'utf8')) as { files: Array<{path: string; kind: WorkspaceArchiveFileSource['kind']}> }; next = await Promise.all(manifest.files.map(async f => ({ path: f.path, kind: f.kind, bytesValue: new Uint8Array(await readFile(path.join(nextRoot, f.path))) }))); }
    files.splice(0, files.length, ...next.map(f => ({ ...f, bytesValue: new Uint8Array(f.bytesValue) })));
  };
  const personal: WorkspaceArchiveCodec = {
    moduleId: 'personal',
    exportRecords(r) { init(r); return r.sqlForModule('personal').all<{key: string; payload: string}>('SELECT key,payload FROM wb_personal_values ORDER BY key').map(v => ({ moduleId: 'personal', schemaId: 'preference', schemaVersion: 1, key: v.key, value: JSON.parse(v.payload) })); },
    validate(r) { if (r.schemaId !== 'preference' || r.schemaVersion !== 1 || r.key !== 'same-id') throw Error('bad schema'); z.strictObject({ value: z.string(), ownerPersonId: z.string().uuid().optional() }).parse(r.value); },
    restoreRecords(r, records) { init(r); for (const record of records) r.sqlForModule('personal').run('INSERT INTO wb_personal_values VALUES (?,?)', [record.key, JSON.stringify(record.value)]); },
    isUserData: () => true,
  };
  const core: WorkspaceArchiveCodec = { moduleId: 'core', exportRecords: () => [], validate() { throw Error('No core entities registered in this fixture'); }, restoreRecords(_r, records) { if (records.length) throw Error('bad core'); }, isUserData: () => true };
  const deps: ArchiveDependencies = {
    get repository() { return repository; }, artifactRoot: artifacts,
    files: createFileStore({ directory: path.join(root, 'uploads'), limits: defaultFileLimits }),
    sessionId: () => session, modules: new Map([['core', core], ['personal', personal]]), clock: { now: () => now },
    lifecycle: { async quiesce() {}, async resume() {}, async recover() {}, async activate(staged) { activations++; await switchFiles(staged); repository.close(); active = staged; repository = createWorkbenchRepository({ filename: path.join(active, 'workspace.sqlite'), artifactRoot: path.join(active, 'files') }); } },
    workspace: {
      repositoryId: () => repoId, applicationVersion: '0.4.1', storageSchemaVersion: 1, requiredModuleIds: ['core', 'personal'], managedRoot: managed,
      async activeRoot() { return active; }, async files() { return Promise.all(files.map(async f => ({ ...f, bytesValue: new Uint8Array(await readFile(path.join(active, f.path))) }))); },
      validateArchive(archive) { for (const r of archive.records) if ((r.value as { value?: string }).value === 'broken-ref') throw Error('broken reference'); },
      authorizeCompleteWorkspace(context, request) {
        for (const record of [...request.records, ...request.incomingRecords ?? []]) {
          const owner = (record.value as { ownerPersonId?: string }).ownerPersonId;
          if (owner && owner !== context.ownAccess.personId) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Workspace contains another person’s private records');
        }
      },
      async openStagedRepository(staged) { return createWorkbenchRepository({ filename: path.join(staged, 'workspace.sqlite'), artifactRoot: path.join(staged, 'files') }); },
      async healthcheck() { personal.exportRecords(repository); },
      async rollback(previous) { await switchFiles(previous); repository.close(); active = previous; repository = createWorkbenchRepository({ filename: path.join(active, 'workspace.sqlite'), artifactRoot: path.join(active, 'files') }); },
      async invalidateAdmission() { invalidations++; }, async freezeWrites() { frozen = true; },
    },
  };
  const installationId = randomUUID(); const actor = { hostname: 'fixture-host', installationId, profilePersonId: null };
  const context: CommandContext = { requestId: randomUUID(), commandId: randomUUID(), installationId, actor, get repository() { return repository; }, clock: deps.clock, ownAccess: { role: 'viewer', displayName: null, personId: null, policyState: 'unavailable', checkedAt: null } };
  const service = new RestoreService(deps);
  const upload = async (bytes: Uint8Array, owner = installationId) => deps.files.stage({ installationId: owner, purpose: 'workspace-restore', name: 'backup.zip', mediaType: 'application/zip', stream: (async function* () { yield bytes; })() });
  return { root, deps, context, service, files, addFile, put, upload, get: () => personal.exportRecords(repository).map(r => r.value), setNow: (v: string) => { now = v; }, setSession: () => { session = randomUUID(); }, setRepo: () => { repoId = 'repo-two'; }, activations: () => activations, invalidations: () => invalidations, frozen: () => frozen, async archiveBytes(id: string) { return readFile(path.join(artifacts, 'backups', id, 'archive.zip')); }, async dispose() { repository.close(); await rm(root, { recursive: true, force: true }); } };
}
