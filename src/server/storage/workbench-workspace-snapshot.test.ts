import { afterEach, expect, it } from 'vitest';
import { createWorkbenchRepository, type WorkbenchRepository, type WorkspaceCoreRecord } from './workbench-repository';
import { makeEntityGraph } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';

const repositories: WorkbenchRepository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
function empty() { const repository = createWorkbenchRepository({ filename: ':memory:', artifactRoot: '.' }); repositories.push(repository); return repository; }
function source() { const repository = empty(); seedGraph(repository, makeEntityGraph()); return repository; }

it('refuses malformed snapshots without leaving versions, anchors, indexes or a changed revision', () => {
  const records = source().exportWorkspaceCore();
  const entity = records.find(record => record.entityType !== 'publication_anchor')!;
  const anchor = records.find(record => record.entityType === 'publication_anchor')!;
  const malformed: WorkspaceCoreRecord[][] = [
    [...records, structuredClone(entity)],
    records.map(record => record === entity ? { ...record, version: record.version + 1 } : record),
    records.map(record => record === anchor ? { ...record, version: 2 } : record),
    [...records, { ...entity, entityType: 'unknown_extension' }],
  ];
  for (const snapshot of malformed) {
    const target = empty(); const revision = target.getStateRevision();
    expect(() => target.restoreWorkspaceCore(snapshot)).toThrow();
    expect(target.exportWorkspaceCore()).toEqual([]);
    expect(target.getStateRevision()).toBe(revision);
    target.restoreWorkspaceCore(records);
    expect(target.exportWorkspaceCore()).toEqual(records);
  }
});

it('rolls back all inserted rows when final reference validation fails', () => {
  const original = source().exportWorkspaceCore();
  const snapshot = original.filter(record => record.entityType !== 'source_definition');
  const target = empty(); const revision = target.getStateRevision();
  expect(() => target.restoreWorkspaceCore(snapshot)).toThrowError(expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' }));
  expect(target.exportWorkspaceCore()).toEqual([]);
  expect(target.getStateRevision()).toBe(revision);
  target.restoreWorkspaceCore(original);
  expect(target.exportWorkspaceCore()).toEqual(original);
});

it('refuses replacement of a nonempty target without altering its complete history', () => {
  const target = source(), records = target.exportWorkspaceCore(), revision = target.getStateRevision();
  expect(() => target.restoreWorkspaceCore(records)).toThrowError(expect.objectContaining({ code: 'RESTORE_TARGET_NOT_EMPTY' }));
  expect(target.exportWorkspaceCore()).toEqual(records);
  expect(target.getStateRevision()).toBe(revision);
});
