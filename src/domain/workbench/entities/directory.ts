import type { EntityRef, Header, ScopeRef, UUIDv4 } from '../primitives';

export type DirectoryEntity = Header & { kind: 'dit' | 'cluster' | 'product' | 'team' | 'person' | 'it_service'; name: string; externalKeys: { sourceId: UUIDv4; key: string }[] };
export type DirectoryLink = Header & ({ kind: 'dit_cluster' | 'cluster_product' | 'cluster_team' | 'product_team'; from: EntityRef; to: EntityRef } | { kind: 'leader'; scope: ScopeRef; personId: UUIDv4 });
export type PublicationAnchorRef = { publicationAnchorId: UUIDv4 };
