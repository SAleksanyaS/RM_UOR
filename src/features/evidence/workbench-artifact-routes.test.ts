import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { draftCleanups, draftFixture } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makePublicationAnchor } from '../../../tests/fixtures/workbench/factories';
import { createWorkbenchApp } from '../../server/workbench/app';
import { QueryRegistry } from '../../server/workbench/query-registry';
import { createLocalSessionStore } from '../../server/workbench/session';

afterEach(async () => { while (draftCleanups.length) await draftCleanups.pop()!(); });
it('streams_owned_or_published_evidence_and_hides_private_paths_through_real_http', async () => {
  const f = draftFixture(); const draft = await f.open('evidence'); const bytes = Buffer.from('Synthetic binary proof\n');
  const staged = await f.files.stage({ installationId: f.context.installationId, profilePersonId: f.context.ownAccess.personId, purpose: 'evidence', name: 'Проверка.txt', mediaType: 'text/plain', stream: (async function* () { yield bytes; })() });
  await f.execute('evidence.draft.save', { draftId: draft.draftId, kind: 'file', fileHandle: staged.fileHandle });
  const entry = f.store.getEntry(draft.draftId)!; const file = (entry.definition as any).file;
  const sessions = createLocalSessionStore({ clock: f.clock });
  const app = await createWorkbenchApp({ hostname: () => 'demo-host', repository: f.repository, clock: f.clock, accessPolicy: f.policy, commands: f.registry, queries: new QueryRegistry(), jobs: f.jobs, modules: [], sessions, allowedOrigins: ['http://localhost'], installationId: f.context.installationId, files: f.files, evidence: f.evidence });
  draftCleanups.push(() => app.close());
  const url = '/api/v1/artifacts/' + file.artifactId;
  expect((await app.inject({ method: 'GET', url, headers: { host: 'localhost' } })).statusCode).toBe(401);
  const local = sessions.issue(); const headers = { host: 'localhost', origin: 'http://localhost', cookie: 'uor-workbench-session=' + local.id };
  const own = await app.inject({ method: 'GET', url, headers });
  expect(own.statusCode).toBe(200); expect(own.rawPayload).toEqual(bytes); expect(own.headers['content-type']).toBe('text/plain');
  expect(own.headers['content-length']).toBe(String(bytes.length)); expect(own.headers['x-content-sha256']).toBe(staged.sha256); expect(own.headers['cache-control']).toBe('no-store'); expect(own.headers['x-content-type-options']).toBe('nosniff');
  expect(own.headers['content-disposition']).toContain(encodeURIComponent('Проверка.txt'));
  const correction = await f.open('manual_correction');
  const invalidCorrection = await app.inject({ method: 'POST', url: '/api/v1/commands', headers: { ...headers, 'x-csrf-token': local.csrfToken }, payload: { commandId: fixtureId(120200), name: 'fact.correct', baseRevision: f.token(), payload: { draftId: correction.draftId, factKey: 'Wrong key', originalFactRefs: [{ entityType: 'observed_fact', id: f.input.facts[0].id, revision: 1 }], replacement: '97', reason: 'Synthetic invalid correction' } } });
  expect(invalidCorrection.statusCode).toBe(422); expect(invalidCorrection.json().error.code).toBe('CORRECTION_ORIGINAL_MISMATCH');
  expect((await app.inject({ method: 'GET', url, headers: { ...headers, origin: 'https://foreign.example.org' } })).statusCode).toBe(403);
  f.context.ownAccess.role = 'viewer'; f.context.ownAccess.personId = fixtureId(999);
  expect((await app.inject({ method: 'GET', url, headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/api/v1/artifacts/' + staged.fileHandle, headers })).statusCode).toBe(404);
  f.repository.append('evidence', { ...entry.header, ...entry.definition, publicationAnchorId: makePublicationAnchor().id }, null);
  expect((await app.inject({ method: 'GET', url, headers })).rawPayload).toEqual(bytes);
  const sentinel = 'PRIVATE_PROFILE_DO_NOT_EXPOSE'; writeFileSync(path.join(f.root, 'private-profile.txt'), sentinel);
  for (const blocked of ['/api/v1/artifacts/%2e%2e%2fprivate-profile', '/api/v1/artifacts?path=C%3A%5Cprivate', '/api/v1/browser-profiles/session.json', url + '?path=private-profile.txt']) {
    const response = await app.inject({ method: 'GET', url: blocked, headers }); expect(response.statusCode).toBeGreaterThanOrEqual(400); expect(response.body).not.toContain(sentinel);
  }
  chmodSync(path.join(f.store.artifactDirectory, file.artifactId), 0o600); writeFileSync(path.join(f.store.artifactDirectory, file.artifactId), 'Tampered');
  const corrupt = await app.inject({ method: 'GET', url, headers }); expect(corrupt.statusCode).toBe(422); expect(corrupt.json().error.code).toBe('INTEGRITY_MISMATCH'); expect(corrupt.body).not.toContain('Synthetic binary proof');
});
