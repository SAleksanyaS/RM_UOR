import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { draftCleanups, draftFixture } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makePublicationAnchor } from '../../../tests/fixtures/workbench/factories';

afterEach(async () => { while (draftCleanups.length) await draftCleanups.pop()!(); });
export async function saveEvidence(f: ReturnType<typeof draftFixture>, text = 'Synthetic proof') {
  const bytes = Buffer.from(text); const draft = await f.open('evidence');
  const staged = await f.files.stage({ installationId: f.context.installationId, profilePersonId: f.context.ownAccess.personId, purpose: 'evidence', name: 'Доказательство.txt', mediaType: 'text/plain', stream: (async function* () { yield bytes; })() });
  await f.execute('evidence.draft.save', { draftId: draft.draftId, kind: 'file', fileHandle: staged.fileHandle });
  const entry = f.store.getEntry(draft.draftId)!;
  return { draft, staged, bytes, entry, file: (entry.definition as any).file as { artifactId: string; hash: string; bytes: number; mimeType: string } };
}
const queryContext = (f: ReturnType<typeof draftFixture>) => ({ requestId: fixtureId(555), installationId: f.context.installationId, clock: f.clock, repository: f.repository, ownAccess: f.context.ownAccess });
export async function readBytes(stream: AsyncIterable<Uint8Array>) { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }

it('file_evidence_uses_own_verified_handle_and_never_accepts_client_artifact_paths', async () => {
  const f = draftFixture(); const saved = await saveEvidence(f);
  expect(saved.file.artifactId).not.toBe(saved.staged.fileHandle); expect(saved.file.hash).toBe('sha256:' + saved.staged.sha256);
  expect(f.count('evidence')).toBe(0);
  const result = await f.evidence.readArtifactForContext(queryContext(f), saved.file.artifactId);
  expect(result).toMatchObject({ name: 'Доказательство.txt', mimeType: 'text/plain', bytes: saved.bytes.length, sha256: saved.staged.sha256 }); expect(await readBytes(result.stream)).toEqual(saved.bytes);
  await expect(f.execute('evidence.draft.save', { draftId: saved.draft.draftId, kind: 'file', file: saved.file })).rejects.toMatchObject({ statusCode: 422 });
  await expect(f.evidence.readArtifactForContext(queryContext(f), saved.staged.fileHandle)).rejects.toMatchObject({ statusCode: 404 });
});
it('orphan_foreign_and_unconfirmed_evidence_never_exposes_bytes_but_confirmed_evidence_does', async () => {
  const f = draftFixture(); const saved = await saveEvidence(f);
  f.context.ownAccess.personId = fixtureId(777); f.context.actor.profilePersonId = fixtureId(777);
  await expect(f.evidence.readArtifactForContext(queryContext(f), saved.file.artifactId)).rejects.toMatchObject({ statusCode: 404 });
  const value = { ...saved.entry.header, ...saved.entry.definition, publicationAnchorId: null };
  f.repository.append('evidence', value, null);
  await expect(f.evidence.readArtifactForContext(queryContext(f), saved.file.artifactId)).rejects.toMatchObject({ statusCode: 404 });
  f.repository.append('evidence', { ...value, revision: 2, publicationAnchorId: makePublicationAnchor().id }, 1);
  expect(await readBytes((await f.evidence.readArtifactForContext(queryContext(f), saved.file.artifactId)).stream)).toEqual(saved.bytes);
});
it('evidence_validates_url_credentials_empty_comments_and_staged_integrity', async () => {
  const f = draftFixture(); const draft = await f.open('evidence');
  for (const url of ['https://user:password@example.org/private', 'javascript:alert(1)', '/relative', '']) await expect(f.execute('evidence.draft.save', { draftId: draft.draftId, kind: 'url', url })).rejects.toMatchObject({ statusCode: 422 });
  await f.execute('evidence.draft.save', { draftId: draft.draftId, kind: 'url', url: 'https://example.org/proof' });
  const staged = await f.files.stage({ installationId: f.context.installationId, profilePersonId: f.context.ownAccess.personId, purpose: 'evidence', name: 'proof.txt', mediaType: 'text/plain', stream: (async function* () { yield Buffer.from('Original'); })() });
  writeFileSync(path.join(f.root, 'uploads', staged.fileHandle, 'bytes'), 'Tampered');
  await expect(f.execute('evidence.draft.save', { draftId: draft.draftId, kind: 'file', fileHandle: staged.fileHandle })).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  expect(f.store.getEntry(draft.draftId)?.definition).toEqual({ kind: 'url', url: 'https://example.org/proof' });
});
it('saved_artifact_integrity_is_checked_before_any_stream_bytes_are_exposed', async () => {
  const f = draftFixture(); const saved = await saveEvidence(f); const filename = path.join(f.store.artifactDirectory, saved.file.artifactId);
  chmodSync(filename, 0o600); writeFileSync(filename, 'Modified');
  await expect(f.evidence.readArtifactForContext(queryContext(f), saved.file.artifactId)).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
});

it('previous_saved_and_published_evidence_versions_remain_downloadable_after_a_file_revision', async () => {
  const f = draftFixture(); const first = await saveEvidence(f, 'Historical proof');
  f.repository.append('evidence', { ...first.entry.header, ...first.entry.definition, publicationAnchorId: makePublicationAnchor().id }, null);
  const bytes = Buffer.from('Current proof');
  const staged = await f.files.stage({ installationId: f.context.installationId, profilePersonId: f.context.ownAccess.personId, purpose: 'evidence', name: 'current.txt', mediaType: 'text/plain', stream: (async function* () { yield bytes; })() });
  await f.execute('evidence.draft.save', { draftId: first.draft.draftId, kind: 'file', fileHandle: staged.fileHandle });
  const current = f.store.getEntry(first.draft.draftId)!; f.repository.append('evidence', { ...current.header, ...current.definition, publicationAnchorId: makePublicationAnchor().id }, 1);
  expect(await readBytes((await f.evidence.readArtifactForContext(queryContext(f), first.file.artifactId)).stream)).toEqual(first.bytes);
  f.context.ownAccess.personId = fixtureId(777); f.context.actor.profilePersonId = fixtureId(777);
  expect(await readBytes((await f.evidence.readArtifactForContext(queryContext(f), first.file.artifactId)).stream)).toEqual(first.bytes);
});
