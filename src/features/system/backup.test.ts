import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDatabase } from '../../server/storage/database';
import { createBackup, listBackups, restoreBackup, migrateStorage } from './backup-service';
const roots: string[] = [], dbs: LocalDatabase[] = [];
afterEach(async () => { dbs.splice(0).forEach(db => db.close()); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'uor-backup-')); roots.push(root); const db = new LocalDatabase(join(root,'db.sqlite')); dbs.push(db); return { root, db }; }
it('copies committed WAL data consistently, preserves a rollback and restores exact records', async () => {
  const { root, db } = await fixture(); db.set('test-records','active',{ title:'Исходная запись' });
  const copy = await createBackup(db, root, 'manual'); db.set('test-records','active',{ title:'Поздняя правка' });
  await restoreBackup(db,root,copy.id);
  expect(db.get('test-records','active')).toEqual({ title:'Исходная запись' });
  expect((await listBackups(root)).some(item => item.reason === 'before_restore')).toBe(true);
});
it('refuses traversal and tampered files without replacing current data', async () => {
  const { root, db } = await fixture(); db.set('x','v',42);
  await expect(restoreBackup(db,root,'../db.sqlite')).rejects.toThrow();
  const copy = await createBackup(db,root,'manual'); await writeFile(join(root,'backups',copy.id,'database.sqlite'),'not sqlite');
  await expect(restoreBackup(db,root,copy.id)).rejects.toThrow(); expect(db.get('x','v')).toBe(42);
});
it('backs up an existing schema before an idempotent migration', async () => {
  const { root, db } = await fixture(); db.set('x','v',1);
  await migrateStorage(db,root); const count=(await listBackups(root)).length;
  await migrateStorage(db,root); expect((await listBackups(root)).length).toBe(count);
  expect(db.get('settings','storageSchemaVersion')).toBe(2);
});
