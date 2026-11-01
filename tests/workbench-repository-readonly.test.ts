import { afterEach, expect, it, vi } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createWorkbenchRepository } from '../src/server/storage/workbench-repository';
import { draftFixture, draftCleanups } from './fixtures/workbench/drafts';
import { makePublicationAnchor } from './fixtures/workbench/factories';

afterEach(async () => { while (draftCleanups.length) await draftCleanups.pop()!(); });
it('readonly repository never migrates, creates artifacts or executes a persistent mutator', async () => {
  const f = draftFixture();
  f.repository.sqlForModule('readonly_probe').execMigration('v1', 'CREATE TABLE wb_readonly_probe_rows(value TEXT)');
  f.repository.close();
  const before = await readFile(f.config.filename), artifactRoot = path.join(f.root, 'must-not-be-created');
  const repository = createWorkbenchRepository({ ...f.config, artifactRoot, readOnly: true });
  try {
    await expect(access(artifactRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(repository.readPublishedHead({ entityType: 'core_goal_definition', id: f.input.goal.id })).toMatchObject({ id: f.input.goal.id });
    expect(repository.readCaptureMetadata({ entityType: 'capture', id: f.input.captures[0].id, revision: 1 })).toMatchObject({ id: f.input.captures[0].id, sourceId: f.input.goal.sourceId, result: 'accepted' });
    const action = vi.fn(), module = repository.sqlForModule('readonly_probe');
    for (const mutate of [
      () => repository.append('core_goal_definition', f.input.goal, 1),
      () => repository.importPublishedVersion('core_goal_definition', f.input.goal),
      () => repository.attachVerifiedPublicationAnchor('core_goal_definition', f.input.goal, { installationId: f.context.installationId, personId: f.context.ownAccess.personId }),
      () => repository.appendPublicationAnchor(makePublicationAnchor(), null),
      () => repository.restoreWorkspaceCore([]),
      () => repository.transaction(action),
      () => module.run("INSERT INTO wb_readonly_probe_rows VALUES('forbidden')"),
      () => module.execMigration('v2', 'CREATE TABLE wb_readonly_probe_other(value TEXT)'),
    ]) expect(mutate).toThrow('REPOSITORY_READ_ONLY');
    expect(action).not.toHaveBeenCalled(); expect(module.all('SELECT * FROM wb_readonly_probe_rows')).toEqual([]);
  } finally { repository.close(); }
  expect(await readFile(f.config.filename)).toEqual(before);
});
