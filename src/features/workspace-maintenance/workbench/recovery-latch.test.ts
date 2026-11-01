import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './test-fixture';
import { createWorkspaceArchive } from './workspace-archive';
import { RestoreService } from './restore-service';

const faults = vi.hoisted(() => ({ marker: false, journal: false }));
vi.mock('./private-storage', async importOriginal => {
  const actual = await importOriginal<typeof import('./private-storage')>();
  return { ...actual, durableWrite: async (...args: Parameters<typeof actual.durableWrite>) => {
    if (faults.marker && args[1] === 'recovery-required.json' || faults.journal && args[1].startsWith('journals/')) throw Object.assign(Error('disk full: ' + args[1]), { code: 'ENOSPC' });
    return actual.durableWrite(...args);
  } };
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { faults.marker = false; faults.journal = false; for (const dispose of cleanup.splice(0)) await dispose(); });
async function setup(value: string) { const f = await fixture(value); cleanup.push(() => f.dispose()); return f; }
it('failed rollback and ENOSPC marker never resume writes and retain all failure causes', async () => {
  const f = await setup('previous'); const source = await setup('incoming');
  const backup = await source.service.createBackup(source.context, { label: null, includeOriginals: true });
  const upload = await f.upload(await source.archiveBytes(backup.backupId)); const preview = await f.service.previewRestore(f.context, { fileHandle: upload.fileHandle });
  let writesOpen = true; let resumes = 0;
  f.deps.lifecycle.quiesce = async () => { writesOpen = false; };
  f.deps.lifecycle.resume = async () => { resumes++; writesOpen = true; };
  f.deps.workspace!.freezeWrites = async () => { writesOpen = false; };
  f.deps.workspace!.healthcheck = async () => { throw Error('activation health failed'); };
  f.deps.workspace!.rollback = async () => { faults.marker = true; faults.journal = true; throw Error('rollback failed'); };
  const error = await f.service.applyRestore(f.context, { restoreToken: preview.restoreToken, confirmReplacement: true }).catch(error => error);
  expect(error).toMatchObject({ code: 'RECOVERY_REQUIRED' });
  expect({ writesOpen, resumes }).toEqual({ writesOpen: false, resumes: 0 });
  expect(error.cause).toBeInstanceOf(AggregateError);
  expect(error.cause.errors.map((value: Error) => value.message)).toEqual(expect.arrayContaining(['activation health failed', 'rollback failed', expect.stringContaining('disk full: journals/'), 'disk full: recovery-required.json']));
});
it('a failed resume latches recovery across service instances and direct exports when marker persistence fails', async () => {
  const f = await setup('previous'); const source = await setup('incoming');
  const backup = await source.service.createBackup(source.context, { label: null, includeOriginals: true });
  const upload = await f.upload(await source.archiveBytes(backup.backupId)); const preview = await f.service.previewRestore(f.context, { fileHandle: upload.fileHandle });
  f.deps.lifecycle.resume = async () => { faults.marker = true; throw Error('resume failed'); };
  await expect(f.service.applyRestore(f.context, { restoreToken: preview.restoreToken, confirmReplacement: true })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  // The journal is committed and no marker exists, so only the in-memory latch can guard this runtime.
  const restarted = new RestoreService(f.deps);
  await expect(restarted.createBackup(f.context, { label: null, includeOriginals: true })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await expect(createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});
