import type { EntityRef, Header, ScopeRef, UUIDv4 } from '../primitives';

export type DirectoryEntity = Header & { kind: 'block' | 'tribe' | 'dit' | 'cluster' | 'product' | 'team' | 'person' | 'it_service'; name: string; externalKeys: { sourceId: UUIDv4; key: string }[]; sourceMetadata?: { importVersion: string; sourceHash: string; location: string; externalCode: string | null }; lifecycle?: 'active' | 'archived'; effectivePeriod?: { startInclusive: string; endExclusive: string | null } };
export type DirectoryLink = Header & ({ kind: 'block_tribe' | 'tribe_cluster' | 'dit_cluster' | 'cluster_product' | 'cluster_team' | 'product_team'; from: EntityRef; to: EntityRef } | { kind: 'leader'; scope: ScopeRef; personId: UUIDv4 });
export type PublicationAnchorRef = { publicationAnchorId: UUIDv4 };
