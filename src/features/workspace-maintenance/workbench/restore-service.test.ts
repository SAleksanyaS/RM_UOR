import { randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createWorkspaceArchive, validateWorkspaceArchive } from './workspace-archive';
import { fixture, digest } from './test-fixture';
const cleanup: Array<() => Promise<void>> = []; afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });
async function setup(value: string | null = null) { const f = await fixture(value); cleanup.push(() => f.dispose()); return f; }
async function incoming(f: Awaited<ReturnType<typeof setup>>, value = 'incoming') { const source = await setup(value); const backup = await createWorkspaceArchive(source.context, { label: null, includeOriginals: true }, source.deps); return f.upload(await source.archiveBytes(backup.backupId)); }
it('nonemptyReplaceWithSameIdsKeepsIndependentRescue', async () => {
  const f = await setup('previous'); const upload = await incoming(f); const preview = await f.service.previewRestore(f.context, { fileHandle: upload.fileHandle });
  expect(preview.mode).toBe('replace'); const result = await f.service.applyRestore(f.context, { restoreToken: preview.restoreToken, confirmReplacement: true });
  expect(f.get()).toEqual([{ value: 'incoming' }]); expect(result.rescue.status).toBe('created'); expect(f.invalidations()).toBe(1); expect(result.recheckRequired).toBe(true);
  if (result.rescue.backupId) { const rescue = await f.upload(await f.archiveBytes(result.rescue.backupId)); const p = await f.service.previewRestore({ ...f.context, commandId: randomUUID() }, { fileHandle: rescue.fileHandle }); await f.service.applyRestore({ ...f.context, commandId: randomUUID() }, { restoreToken: p.restoreToken, confirmReplacement: true }); expect(f.get()).toEqual([{ value: 'previous' }]); }
});
it('emptyTargetAndReplayHaveHonestSingleOutcome across service restart and different command ID', async () => {
  const f = await setup(); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle });
  const result = await f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true });
  expect(result.rescue).toEqual({ status: 'empty', backupId: null });
  const { RestoreService } = await import('./restore-service'); const restarted = new RestoreService(f.deps);
  expect(await restarted.applyRestore({ ...f.context, commandId: randomUUID() }, { restoreToken: p.restoreToken, confirmReplacement: true })).toEqual(result); expect(f.activations()).toBe(1);
});
it.each(['setting', 'session', 'repo', 'file', 'expiry'])('rejects stale %s before activation', async change => {
  const f = await setup('previous'); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle });
  if (change === 'setting') f.put('changed'); if (change === 'session') f.setSession(); if (change === 'repo') f.setRepo(); if (change === 'file') await f.addFile('evidence', Buffer.from('changed')); if (change === 'expiry') f.setNow('2026-10-31T12:30:00.000Z');
  await expect(f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true })).rejects.toMatchObject({ code: change === 'session' ? 'RESTORE_TOKEN_NOT_FOUND' : 'PREVIEW_STALE' }); expect(f.activations()).toBe(0);
});
it('changedAfterRescueKeepsActiveAndRescue', async () => {
  const f = await setup('previous'); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle }); f.deps.lifecycle.quiesce = async () => { f.put('changed-after-rescue'); };
  await expect(f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true })).rejects.toMatchObject({ code: 'PREVIEW_STALE' }); expect(f.get()).toEqual([{ value: 'changed-after-rescue' }]); expect((await f.service.listOwnBackups(f.context)).some(b => b.rescue)).toBe(true); expect(f.activations()).toBe(0);
});
it('denies another installation fileHandle', async () => { const f = await setup(); const source = await setup('source'); const b = await createWorkspaceArchive(source.context, { label: null, includeOriginals: true }, source.deps); const u = await f.upload(await source.archiveBytes(b.backupId), randomUUID()); await expect(f.service.previewRestore(f.context, { fileHandle: u.fileHandle })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' }); });
it('rolls back failed healthcheck; failed rollback freezes writes until recovery', async () => {
  const f = await setup('previous'); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle }); f.deps.workspace!.healthcheck = async () => { throw Error('health'); }; f.deps.workspace!.rollback = async () => { throw Error('rollback'); };
  await expect(f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' }); expect(f.frozen()).toBe(true);
  await expect(f.service.previewRestore(f.context, { fileHandle: u.fileHandle })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  await expect(createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
});
it('preview exercises every codec against a real empty staging repository without touching active', async () => {
  const f = await setup('previous'); const u = await incoming(f); const codec = f.deps.modules.get('personal')!; codec.restoreRecords = () => { throw Error('unsupported staged migration'); };
  await expect(f.service.previewRestore(f.context, { fileHandle: u.fileHandle })).rejects.toBeDefined(); expect(f.get()).toEqual([{ value: 'previous' }]); expect(f.activations()).toBe(0);
});
it('rejects an activation port which did not actually switch the exact staged state', async () => {
  const f = await setup('previous'); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle }); f.deps.lifecycle.activate = async () => {};
  await expect(f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true })).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' }); expect(f.get()).toEqual([{ value: 'previous' }]);
});
it('refuses replacement when the independent rescue bytes change during quiesce', async () => {
  const f = await setup('previous'); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle });
  f.deps.lifecycle.quiesce = async () => { const rescue = (await f.service.listOwnBackups(f.context)).find(b => b.rescue)!; await writeFile(path.join(f.deps.artifactRoot, 'backups', rescue.backupId, 'archive.zip'), 'corrupt'); };
  await expect(f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true })).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' }); expect(f.activations()).toBe(0); expect(f.get()).toEqual([{ value: 'previous' }]);
});
it('a failed healthcheck restores the old coherent SQLite and retains its rescue', async () => {
  const f = await setup('previous'); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle }); let first = true; f.deps.workspace!.healthcheck = async () => { if (first) { first = false; throw Error('health'); } };
  await expect(f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true })).rejects.toThrow('health'); expect(f.get()).toEqual([{ value: 'previous' }]); expect(f.frozen()).toBe(false); expect((await f.service.listOwnBackups(f.context)).filter(b => b.rescue)).toHaveLength(1);
});
it('concurrent token replay from two services yields one activation and the same result', async () => {
  const f = await setup(); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle }); const { RestoreService } = await import('./restore-service'); const other = new RestoreService(f.deps); const input = { restoreToken: p.restoreToken, confirmReplacement: true as const };
  const [a, b] = await Promise.all([f.service.applyRestore(f.context, input), other.applyRestore({ ...f.context, commandId: randomUUID() }, input)]); expect(a).toEqual(b); expect(f.activations()).toBe(1);
});
it('startup finalizes a committed result without rolling back later accepted data', async () => {
  const f = await setup('previous'); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle }); const result = await f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true });
  const metadataPath = path.join(f.deps.artifactRoot, 'tokens', p.restoreToken, 'metadata.json'); const metadata = JSON.parse(await readFile(metadataPath, 'utf8')); metadata.result = null; metadata.binding.consumedBy = null; await writeFile(metadataPath, JSON.stringify(metadata));
  f.put('accepted-after-commit'); let rollbacks = 0; f.deps.workspace!.rollback = async () => { rollbacks++; throw Error('Never roll back committed data'); };
  await f.service.recover(); expect(rollbacks).toBe(0); expect(f.get()).toEqual([{ value: 'accepted-after-commit' }]); expect(await f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true })).toEqual(result);
});
it('startup rolls back an interrupted precommit activation and rejects forged journal destinations', async () => {
  const f = await setup('previous'); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle }); await f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true });
  const name = (await readdir(path.join(f.deps.artifactRoot, 'journals')))[0]; const journalPath = path.join(f.deps.artifactRoot, 'journals', name); const journal = JSON.parse(await readFile(journalPath, 'utf8')); journal.phase = 'activating'; journal.result = null; await writeFile(journalPath, JSON.stringify(journal));
  await f.service.recover(); expect(f.get()).toEqual([{ value: 'previous' }]);
  journal.previousName = '..'; journal.phase = 'activating'; await writeFile(journalPath, JSON.stringify(journal)); await expect(f.service.recover()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' }); expect(f.frozen()).toBe(true);
});
it('recovery protects human changes made after an uncommitted activation', async () => {
  const f = await setup('previous'); const u = await incoming(f); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle }); await f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true });
  const name = (await readdir(path.join(f.deps.artifactRoot, 'journals')))[0]; const journalPath = path.join(f.deps.artifactRoot, 'journals', name); const journal = JSON.parse(await readFile(journalPath, 'utf8')); journal.phase = 'activating'; journal.result = null; await writeFile(journalPath, JSON.stringify(journal));
  f.put('human-change'); await expect(f.service.recover()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' }); expect(f.get()).toEqual([{ value: 'human-change' }]); expect(f.frozen()).toBe(true);
});
it('replaces actual evidence files and retains all previous originals in an independent rescue', async () => {
  const f = await setup('previous'); const source = await setup('incoming');
  await f.addFile('evidence', Buffer.from('old-proof')); await f.addFile('original', Buffer.from('old-original'));
  await source.addFile('evidence', Buffer.from('new-proof')); await source.addFile('original', Buffer.from('omitted-original'));
  const b = await createWorkspaceArchive(source.context, { label: null, includeOriginals: false }, source.deps); const u = await f.upload(await source.archiveBytes(b.backupId)); const p = await f.service.previewRestore(f.context, { fileHandle: u.fileHandle });
  const result = await f.service.applyRestore(f.context, { restoreToken: p.restoreToken, confirmReplacement: true }); expect(f.files.map(v => Buffer.from(v.bytesValue).toString())).toEqual(['new-proof']);
  expect(Buffer.from(await readFile(path.join(await f.deps.workspace!.activeRoot(), 'files', digest('new-proof')))).toString()).toBe('new-proof');
  const rescue = await validateWorkspaceArchive(await f.archiveBytes(result.rescue.backupId!), f.deps.modules, f.deps.workspace); expect([...rescue.files.values()].map(v => Buffer.from(v).toString()).sort()).toEqual(['old-original', 'old-proof']);
});
