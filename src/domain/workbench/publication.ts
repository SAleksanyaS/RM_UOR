import type { PositiveInt, Sha256, UtcInstant, UUIDv4 } from './primitives';

export type GitOid = string;
export type UTCDateTime = UtcInstant;
/** revision here belongs to the publication package, not the repository metadata row. */
export type PublicationAnchor = { schemaVersion: 1; id: UUIDv4; packageId: UUIDv4; revision: PositiveInt; contentHash: Sha256; repositoryId: string; targetBranch: 'main'; pullRequestId: string | null; proposalCommit: GitOid | null; mainCommit: GitOid | null; publicationState: 'confirmed' | 'unconfirmed'; timeVerification: 'verified' | 'unknown'; mergedAt: UTCDateTime | null; verifiedAt: UTCDateTime | null; reason: string | null };
