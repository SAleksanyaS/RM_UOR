import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixtureId, makeHeader } from '../../../../tests/fixtures/workbench/factories';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { buildPackageManifest, canonicalBytes } from './package-manifest';
import { publicationPackageRecordSchema, type PackageManifest, type VerifiedMain } from './contracts';
import type { MergeEvidence } from './bitbucket-port';
import { verifyPublicationAnchor } from './publication-anchor';

const verifiedAt = '2026-10-31T08:00:00Z';
const mainCommit = 'b'.repeat(40);
const mergedAt = '2026-10-30T09:00:00Z';
type BoundEvidence = MergeEvidence & { repositoryId: string; packageId: string; revision: number; contentHash: string; pullRequestId: string };
function fixture() {
  const packageId = fixtureId(260001);
  const files = new Map([['records/directory_entity/' + fixtureId(260002) + '/1.json', Buffer.from('{"synthetic":true}')]]);
  const manifest = buildPackageManifest({ package: { schemaVersion: 1, packageId, cycleId: fixtureId(260003), curatorPersonId: fixtureId(17), revision: 1, baseCommit: 'a'.repeat(40), targetBranch: 'main', createdAt: '2026-10-29T08:00:00Z' }, files });
  const prefix = `published/workbench/packages/${packageId}/1/`;
  const tree = new Map<string, Uint8Array>([...files].map(([name, bytes]) => [prefix + name, bytes]));
  tree.set(prefix + 'manifest.json', canonicalBytes(manifest));
  const main: VerifiedMain = { repositoryId: 'synthetic-repository', commit: mainCommit, files: tree };
  return { main, manifest, prefix, files };
}
function evidence(f = fixture()): BoundEvidence {
  return { mainCommit, proposalCommit: 'c'.repeat(40), mergedAt, source: 'synthetic-verified-merge-event', verified: true, repositoryId: f.main.repositoryId, packageId: f.manifest.packageRevision.packageId, revision: 1, contentHash: f.manifest.packageRevision.contentHash, pullRequestId: 'synthetic-pr-26' };
}

it('confirms verified Git package without inventing a publication timestamp', () => {
  const f = fixture();
  const anchor = verifyPublicationAnchor({ ...f, evidence: null, verifiedAt });
  expect(anchor).toEqual({ schemaVersion: 1, id: fixtureId(260001), packageId: fixtureId(260001), revision: 1, contentHash: f.manifest.packageRevision.contentHash, repositoryId: 'synthetic-repository', targetBranch: 'main', pullRequestId: null, proposalCommit: null, mainCommit, publicationState: 'confirmed', timeVerification: 'unknown', mergedAt: null, verifiedAt, reason: expect.any(String) });
  expect(anchor.reason?.trim().length).toBeGreaterThan(0);
  expect(anchor).not.toHaveProperty('appliedAt');
  expect(anchor).not.toHaveProperty('actor');
  expect(anchor).not.toHaveProperty('recordedAt');
});

it('keeps local verification time separate across installations', () => {
  const f = fixture();
  const first = verifyPublicationAnchor({ ...f, evidence: null, verifiedAt });
  const second = verifyPublicationAnchor({ ...f, evidence: null, verifiedAt: '2026-11-02T09:00:00Z' });
  expect(second).toEqual({ ...first, verifiedAt: '2026-11-02T09:00:00Z' });
  expect(first.mergedAt).toBeNull();
  expect(second.mergedAt).toBeNull();
});

it.each(['missing_manifest', 'missing_payload', 'extra_payload', 'changed_payload', 'wrong_inventory', 'wrong_hash', 'wrong_revision', 'unsupported_schema', 'unsafe_path', 'duplicate_path', 'wrong_repository', 'invalid_commit', 'invalid_verification_time'])('rejects %s before confirming publication', fault => {
  const f = fixture();
  const main = { ...f.main, files: new Map(f.main.files) };
  const manifest: PackageManifest = structuredClone(f.manifest);
  let checkedAt = verifiedAt;
  const payloadPath = [...f.files.keys()][0];
  if (fault === 'missing_manifest') main.files.delete(f.prefix + 'manifest.json');
  if (fault === 'missing_payload') main.files.delete(f.prefix + payloadPath);
  if (fault === 'extra_payload') main.files.set(f.prefix + 'extra.json', Buffer.from('{}'));
  if (fault === 'changed_payload') main.files.set(f.prefix + payloadPath, Buffer.from('{"synthetic":false}'));
  if (fault === 'wrong_inventory') manifest.files[0].bytes++;
  if (fault === 'wrong_hash') manifest.packageRevision.contentHash = 'sha256:' + '0'.repeat(64);
  if (fault === 'wrong_revision') manifest.packageRevision.revision = 2;
  if (fault === 'unsupported_schema') Object.assign(manifest.packageRevision, { schemaVersion: 2 });
  if (fault === 'unsafe_path') manifest.files[0].path = '../private.json';
  if (fault === 'duplicate_path') manifest.files.push({ ...manifest.files[0] });
  if (fault === 'wrong_repository') main.repositoryId = '   ';
  if (fault === 'invalid_commit') main.commit = 'main';
  if (fault === 'invalid_verification_time') checkedAt = '2026-02-31T08:00:00Z';
  expect(() => verifyPublicationAnchor({ main, manifest, evidence: null, verifiedAt: checkedAt })).toThrow();
});

it('verifies only the selected capsule inventory while retaining unrelated packages', () => {
  const f = fixture();
  const main = { ...f.main, files: new Map(f.main.files) };
  main.files.set('published/workbench/packages/' + fixtureId(260004) + '/1/unrelated.json', Buffer.from('{}'));
  expect(verifyPublicationAnchor({ main, manifest: f.manifest, evidence: null, verifiedAt }).publicationState).toBe('confirmed');
});

it('accepts squash merge time only when provider evidence names verified main and exact package', () => {
  const f = fixture(), proof = evidence(f);
  const anchor = verifyPublicationAnchor({ ...f, evidence: proof, verifiedAt });
  expect(anchor).toMatchObject({ publicationState: 'confirmed', timeVerification: 'verified', mergedAt, mainCommit, proposalCommit: 'c'.repeat(40), pullRequestId: 'synthetic-pr-26', revision: 1 });
  expect(anchor.reason).toContain('synthetic-verified-merge-event');
  const later = verifyPublicationAnchor({ ...f, evidence: proof, verifiedAt: '2026-11-02T09:00:00Z' });
  expect(later).toEqual({ ...anchor, verifiedAt: '2026-11-02T09:00:00Z' });
});

it.each(['legacy', 'partial_binding', 'unverified', 'missing_time'])('keeps Git publication confirmed with unknown time for %s evidence', kind => {
  const f = fixture();
  let proof: MergeEvidence = evidence(f);
  if (kind === 'legacy') proof = { mainCommit, proposalCommit: 'c'.repeat(40), mergedAt, source: 'synthetic-legacy', verified: true };
  if (kind === 'partial_binding') { const { contentHash: _hash, ...partial } = evidence(f); proof = partial; }
  if (kind === 'unverified') proof = { ...evidence(f), verified: false };
  if (kind === 'missing_time') proof = { ...evidence(f), mergedAt: null };
  expect(verifyPublicationAnchor({ ...f, evidence: proof, verifiedAt })).toMatchObject({ publicationState: 'confirmed', timeVerification: 'unknown', mergedAt: null, reason: expect.any(String) });
});

it.each([
  ['repositoryId', 'other-repository'], ['packageId', fixtureId(260099)], ['revision', 2], ['contentHash', 'sha256:' + '0'.repeat(64)], ['mainCommit', 'd'.repeat(40)],
  ['repositoryId', ' synthetic-repository '], ['proposalCommit', 'HEAD'], ['mergedAt', '2026-02-31T09:00:00Z'], ['source', ''], ['source', '   '], ['verified', 'true'], ['revision', 1.5], ['packageId', 'not-a-uuid'], ['authorDate', mergedAt], ['committerDate', mergedAt], ['pulledAt', mergedAt], ['appliedAt', mergedAt], ['createdAt', mergedAt],
])('rejects mismatched or malformed provider evidence %s=%s', (key, value) => {
  const f = fixture();
  const proof = { ...evidence(f), [key]: value } as MergeEvidence;
  expect(() => verifyPublicationAnchor({ ...f, evidence: proof, verifiedAt })).toThrow();
});

it('does not require a PR id or proposal commit to accept an exact provider merge event', () => {
  const f = fixture();
  const { pullRequestId: _id, ...proof } = evidence(f);
  expect(verifyPublicationAnchor({ ...f, evidence: { ...proof, proposalCommit: null }, verifiedAt })).toMatchObject({ timeVerification: 'verified', mergedAt, proposalCommit: null, pullRequestId: null });
});

it('verifies an earlier accepted merge tree while retaining the first observed main as publication proof', () => {
  const f = fixture(), firstObserved = { ...f.main, commit: 'e'.repeat(40) };
  const input = { main: firstObserved, manifest: f.manifest, evidence: evidence(f), evidenceMain: f.main, verifiedAt };
  expect(verifyPublicationAnchor(input)).toMatchObject({ mainCommit: 'e'.repeat(40), timeVerification: 'verified', mergedAt });
});

it.each(['wrong_commit', 'wrong_repository', 'missing_package', 'changed_bytes'])('rejects an earlier merge-tree proof with %s', fault => {
  const f = fixture(), proof = { ...f.main, files: new Map(f.main.files) };
  if (fault === 'wrong_commit') proof.commit = 'f'.repeat(40);
  if (fault === 'wrong_repository') proof.repositoryId = 'other-repository';
  if (fault === 'missing_package') proof.files.clear();
  if (fault === 'changed_bytes') proof.files.set(f.prefix + [...f.files.keys()][0], Buffer.from('tampered'));
  const input = { main: { ...f.main, commit: 'e'.repeat(40) }, manifest: f.manifest, evidence: evidence(f), evidenceMain: proof, verifiedAt };
  expect(() => verifyPublicationAnchor(input)).toThrow();
});

it('appends time metadata at storage version two while keeping package revision one and typed identity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-t26-anchor-'));
  const repository = createWorkbenchRepository({ filename: path.join(root, 'anchor.sqlite'), artifactRoot: path.join(root, 'artifacts') });
  try {
    const f = fixture();
    repository.registerEntityType('publication_package', { schema: publicationPackageRecordSchema, references: () => [] });
    const pkg = { ...makeHeader(260001), cycleId: fixtureId(260003), curatorPersonId: fixtureId(17), state: 'merged' as const, current: f.manifest.packageRevision, sent: f.manifest.packageRevision, draftRefs: [], proposal: null };
    repository.append('publication_package', pkg, null);
    const unknown = verifyPublicationAnchor({ ...f, evidence: null, verifiedAt });
    expect(repository.appendPublicationAnchor(unknown, null)).toEqual({ entityType: 'publication_anchor', id: pkg.id, revision: 1 });
    const known = verifyPublicationAnchor({ ...f, evidence: evidence(f), verifiedAt: '2026-11-02T09:00:00Z' });
    expect(repository.appendPublicationAnchor(known, 1)).toEqual({ entityType: 'publication_anchor', id: pkg.id, revision: 2 });
    expect(repository.readPublicationAnchor({ entityType: 'publication_anchor', id: pkg.id })).toEqual({ ...known, revision: 1, mainCommit, contentHash: unknown.contentHash });
    expect(() => repository.appendPublicationAnchor(unknown, 1)).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }));
    expect(repository.readPublicationAnchor({ entityType: 'publication_package', id: pkg.id })).toBeNull();
    expect(repository.getHead({ entityType: 'publication_package', id: pkg.id })).toEqual(pkg);
  } finally {
    repository.close();
    if (!path.basename(root).startsWith('uor-t26-anchor-')) throw Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
