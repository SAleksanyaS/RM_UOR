import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { headerSchema } from '../../domain/workbench/primitives';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';
import { createWorkbenchRepository, type WorkbenchRepository } from './workbench-repository';
import { createStableWorkbenchRepository } from './workbench-runtime-repository';

const roots: string[] = [], repositories: WorkbenchRepository[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) {
    const allowed = realpathSync.native(tmpdir());
    if (path.dirname(root) !== allowed || !path.basename(root).startsWith('uor-stable-repo-')) throw Error('Unexpected owned test path');
    rmSync(root, { recursive: true, force: true });
  }
});
function raw() {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'uor-stable-repo-')); roots.push(root);
  const repository = createWorkbenchRepository({ filename: path.join(root, 'workspace.sqlite'), artifactRoot: path.join(root, 'files') });
  repositories.push(repository); return repository;
}
const ddl = 'CREATE TABLE wb_subject_values(id TEXT PRIMARY KEY,value TEXT NOT NULL)';
it('closes only the active native repository idempotently and refuses later activation', () => {
  const initial = raw(), next = raw(), stable = createStableWorkbenchRepository(initial);
  stable.rebind(next); stable.repository.close();
  expect(() => stable.repository.close()).not.toThrow();
  expect(() => stable.rebind(initial)).toThrow('REPOSITORY_CLOSED');
  expect(initial.getStateRevision()).toBeTruthy();
  expect(() => next.getStateRevision()).toThrow('REPOSITORY_CLOSED');
});
it('keeps captured methods and module SQL on the active native repository after the previous one closes', () => {
  const initial = raw(), next = raw(), stable = createStableWorkbenchRepository(initial);
  const sql = stable.repository.sqlForModule('subject'), getRevision = stable.repository.getStateRevision;
  sql.execMigration('v1', ddl); sql.run('INSERT INTO wb_subject_values VALUES(?,?)', ['old', 'retained']);
  stable.rebind(next); initial.close();
  expect(sql.all('SELECT * FROM wb_subject_values')).toEqual([]);
  sql.run('INSERT INTO wb_subject_values VALUES(?,?)', ['new', 'active']);
  expect(sql.get('SELECT value FROM wb_subject_values WHERE id=?', ['new'])).toEqual({ value: 'active' });
  expect(getRevision()).toBe(next.getStateRevision());
});
it('replays custom registrations and projection callbacks using captured facade SQL and retains transaction rollback', () => {
  const initial = raw(), next = raw(), stable = createStableWorkbenchRepository(initial);
  const sql = stable.repository.sqlForModule('subject'); sql.execMigration('v1', ddl);
  stable.repository.registerEntityType('runtime_test', { schema: headerSchema, references: () => [] });
  stable.repository.registerProjection('runtime-test', (type, value) => { if (type === 'runtime_test') sql.run('INSERT INTO wb_subject_values VALUES(?,?)', [value.id, 'projected']); });
  stable.rebind(next); initial.close();
  const value = makeHeader(38001);
  stable.repository.transaction(() => { stable.repository.append('runtime_test', value, null); });
  expect(sql.get('SELECT value FROM wb_subject_values WHERE id=?', [value.id])).toEqual({ value: 'projected' });
  expect(() => stable.repository.transaction(() => { sql.run('UPDATE wb_subject_values SET value=?', ['bad']); throw Error('abort'); })).toThrow('abort');
  expect(sql.get('SELECT value FROM wb_subject_values WHERE id=?', [value.id])).toEqual({ value: 'projected' });
});
it('does not activate a candidate whose migration preparation fails or switch inside an open transaction', () => {
  const initial = raw(), next = raw(), stable = createStableWorkbenchRepository(initial);
  const sql = stable.repository.sqlForModule('subject'); sql.execMigration('v1', ddl);
  next.sqlForModule('subject').execMigration('different', ddl);
  expect(() => stable.rebind(next)).toThrow();
  expect(() => stable.repository.transaction(() => stable.rebind(raw()))).toThrow('TRANSACTION_ACTIVE');
  sql.run('INSERT INTO wb_subject_values VALUES(?,?)', ['still', 'initial']);
  expect(initial.sqlForModule('subject').all('SELECT * FROM wb_subject_values')).toEqual([{ id: 'still', value: 'initial' }]);
  expect(next.getStateRevision()).toBeTruthy();
});
it('keeps an escaped transaction lease closed even after the active repository changes', async () => {
  const initial = raw(), next = raw(), stable = createStableWorkbenchRepository(initial);
  const sql = stable.repository.sqlForModule('subject'); sql.execMigration('v1', ddl);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let escaped!: Promise<unknown>;
  let escapedAttachment!: Promise<unknown>;
  const attach = stable.repository.attachVerifiedPublicationAnchor, late = makeHeader(38003);
  stable.repository.transaction(() => {
    escaped = gate.then(() => sql.run('INSERT INTO wb_subject_values VALUES(?,?)', [fixtureId(38002), 'late']));
    escapedAttachment = gate.then(() => attach('metric_definition', late, { installationId: late.actor.installationId, personId: late.actor.profilePersonId }));
  });
  stable.rebind(next); initial.close(); release();
  await expect(escaped).rejects.toThrow('TRANSACTION_CONTEXT_CLOSED');
  await expect(escapedAttachment).rejects.toThrow('TRANSACTION_CONTEXT_CLOSED');
  expect(sql.all('SELECT * FROM wb_subject_values')).toEqual([]);
});
