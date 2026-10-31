import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { fixture } from './test-fixture';
import { createWorkspaceArchive, saveWorkspaceBackup, validateWorkspaceArchive } from './workspace-archive';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';

const cleanup: Array<() => Promise<void>> = []; afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
async function setup(value: string | null = null) { const f = await fixture(value); cleanup.push(() => f.dispose()); return f; }
const personA = randomUUID(); const personB = randomUUID();
it.each([personB, null])('retained private A records cannot be exported or rescued by caller %s', async personId => {
  const f = await setup(); f.put('private A draft', personA); f.context.ownAccess.personId = personId;
  await expect(createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  await expect(f.service.createBackup(f.context, { label: null, includeOriginals: false })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  await expect(saveWorkspaceBackup(f.context, { label: null, includeOriginals: true }, f.deps, true)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(await f.service.listOwnBackups(f.context)).toEqual([]);
});
it.each([personB, null])('caller %s cannot replace a target containing retained private A records', async personId => {
  const f = await setup(); f.put('private A draft', personA); f.context.ownAccess.personId = personId;
  const source = await setup('public incoming'); const backup = await source.service.createBackup(source.context, { label: null, includeOriginals: true });
  const upload = await f.upload(await source.archiveBytes(backup.backupId));
  await expect(f.service.previewRestore(f.context, { fileHandle: upload.fileHandle })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(f.get()).toEqual([{ value: 'private A draft', ownerPersonId: personA }]); expect(f.activations()).toBe(0);
});
it.each([personB, null])('caller %s cannot import another owner private records into an empty target', async personId => {
  const source = await setup(); source.put('private A draft', personA); source.context.ownAccess.personId = personA;
  const backup = await source.service.createBackup(source.context, { label: null, includeOriginals: true }); const f = await setup(); f.context.ownAccess.personId = personId;
  const upload = await f.upload(await source.archiveBytes(backup.backupId));
  await expect(f.service.previewRestore(f.context, { fileHandle: upload.fileHandle })).rejects.toMatchObject({ code: 'ACCESS_DENIED' }); expect(f.get()).toEqual([]);
});
it('same owner exports a complete private workspace and rescue with ownership unchanged', async () => {
  const f = await setup(); f.put('private A draft', personA); f.context.ownAccess.personId = personA;
  const backup = await f.service.createBackup(f.context, { label: null, includeOriginals: true });
  const archive = await validateWorkspaceArchive(await f.archiveBytes(backup.backupId), f.deps.modules, f.deps.workspace);
  expect(archive.records.map(record => record.value)).toEqual([{ value: 'private A draft', ownerPersonId: personA }]);
  const upload = await f.upload(await f.archiveBytes(backup.backupId)); const preview = await f.service.previewRestore(f.context, { fileHandle: upload.fileHandle });
  const applied = await f.service.applyRestore(f.context, { restoreToken: preview.restoreToken, confirmReplacement: true }); expect(applied.rescue.status).toBe('created');
  expect(f.get()).toEqual([{ value: 'private A draft', ownerPersonId: personA }]);
});
it('missing trusted complete-workspace authorization fails closed even for an empty workspace', async () => {
  const f = await setup(); Reflect.deleteProperty(f.deps.workspace!, 'authorizeCompleteWorkspace');
  await expect(f.service.createBackup(f.context, { label: null, includeOriginals: true })).rejects.toMatchObject({ code: 'ARCHIVE_UNAVAILABLE' });
});
it('replacement authorization is checked again under quiesce before active switch', async () => {
  const f = await setup('previous'); const source = await setup('incoming'); const backup = await source.service.createBackup(source.context, { label: null, includeOriginals: true });
  const upload = await f.upload(await source.archiveBytes(backup.backupId)); const preview = await f.service.previewRestore(f.context, { fileHandle: upload.fileHandle });
  f.deps.lifecycle.quiesce = async () => { f.deps.workspace!.authorizeCompleteWorkspace = (_context, request) => { if (request.operation === 'replace') throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Transfer policy revoked'); }; };
  await expect(f.service.applyRestore(f.context, { restoreToken: preview.restoreToken, confirmReplacement: true })).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  expect(f.activations()).toBe(0); expect(f.get()).toEqual([{ value: 'previous' }]);
});
