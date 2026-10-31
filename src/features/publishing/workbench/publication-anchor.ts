import type { UtcInstant } from '../../../domain/workbench/primitives';
import { positiveIntSchema, sha256Schema, utcInstantSchema, uuidSchema } from '../../../domain/workbench/primitives';
import { z } from 'zod';
import type { PublicationAnchor } from '../../../domain/workbench/publication';
import type { MergeEvidence } from './bitbucket-port';
import { gitOidSchema, mergeEvidenceSchema, packageManifestSchema, type PackageManifest, type VerifiedMain } from './contracts';
import { buildPackageManifest, canonicalBytes, hashBytes, integrity, validatePortablePaths } from './package-manifest';

export type { PublicationAnchor } from '../../../domain/workbench/publication';

// Optional bindings preserve legacy provider reads, but legacy evidence cannot
// establish the merge time of a particular package revision.
const evidenceTextSchema = z.string().refine(value => value.trim().length > 0);
const boundEvidenceSchema = mergeEvidenceSchema.extend({ source: evidenceTextSchema, repositoryId: evidenceTextSchema.optional(), packageId: uuidSchema.optional(), revision: positiveIntSchema.optional(), contentHash: sha256Schema.optional(), pullRequestId: evidenceTextSchema.optional() });

/** The caller supplies the Git provider's verified main, never a proposal tree. */
export function verifyPublicationAnchor(input: { main: VerifiedMain; manifest: PackageManifest; evidence: MergeEvidence | null; evidenceMain?: VerifiedMain; verifiedAt: UtcInstant }): PublicationAnchor {
  const { main } = input;
  gitOidSchema.parse(main.commit);
  utcInstantSchema.parse(input.verifiedAt);
  if (typeof main.repositoryId !== 'string' || !main.repositoryId.trim()) return integrity();
  const manifest = packageManifestSchema.parse(input.manifest);
  const revision = manifest.packageRevision;
  validatePortablePaths([...main.files.keys()]);
  validatePortablePaths(manifest.files.map(file => file.path));
  const prefix = `published/workbench/packages/${revision.packageId}/${revision.revision}/`;
  const manifestBytes = main.files.get(prefix + 'manifest.json');
  if (!manifestBytes) return integrity();
  let saved: PackageManifest;
  try { saved = packageManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))); }
  catch { return integrity(); }
  if (hashBytes(canonicalBytes(saved)) !== hashBytes(canonicalBytes(manifest))) return integrity();
  const files = new Map([...main.files].filter(([name]) => name.startsWith(prefix) && name !== prefix + 'manifest.json').map(([name, bytes]) => [name.slice(prefix.length), bytes]));
  const { contentHash: _hash, ...base } = revision;
  const actual = buildPackageManifest({ package: base, files });
  if (hashBytes(canonicalBytes(actual)) !== hashBytes(canonicalBytes(manifest))) return integrity();
  // This optional snapshot is supplied only by the trusted accepted-ancestry
  // reader. Both trees must contain the same immutable package, even when the
  // provider merge event predates this installation's first observed main.
  const evidenceMain = input.evidenceMain ?? main;
  if (input.evidenceMain) {
    if (evidenceMain.repositoryId !== main.repositoryId) return integrity();
    verifyPublicationAnchor({ main: evidenceMain, manifest, evidence: null, verifiedAt: input.verifiedAt });
  }
  const evidence = input.evidence === null ? null : boundEvidenceSchema.parse(input.evidence);
  if (evidence && (evidence.mainCommit !== evidenceMain.commit || evidence.repositoryId !== undefined && evidence.repositoryId !== main.repositoryId || evidence.packageId !== undefined && evidence.packageId !== revision.packageId || evidence.revision !== undefined && evidence.revision !== revision.revision || evidence.contentHash !== undefined && evidence.contentHash !== revision.contentHash)) return integrity();
  const bound = evidence?.repositoryId !== undefined && evidence.packageId !== undefined && evidence.revision !== undefined && evidence.contentHash !== undefined;
  const trusted = evidence !== null && evidence.verified && bound;
  const timeVerified = trusted && evidence.mergedAt !== null;
  const reason = timeVerified ? `Merge time verified by ${evidence.source}.` : evidence && !bound ? 'Provider evidence does not bind the repository and exact package revision/hash; merge time is unknown.' : 'Provider merge time is unavailable or unverified; publication was verified from main package bytes.';
  return { schemaVersion: 1, id: revision.packageId, packageId: revision.packageId, revision: revision.revision, contentHash: revision.contentHash, repositoryId: main.repositoryId, targetBranch: 'main', pullRequestId: trusted ? evidence.pullRequestId ?? null : null, proposalCommit: trusted ? evidence.proposalCommit : null, mainCommit: main.commit, publicationState: 'confirmed', timeVerification: timeVerified ? 'verified' : 'unknown', mergedAt: timeVerified ? evidence.mergedAt : null, verifiedAt: input.verifiedAt, reason };
}
