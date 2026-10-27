import type { EntityRef, Header, PositiveInt, Sha256, UUIDv4, VersionRef } from '../primitives';

export type CustomFieldDef = Header & { name: string; entityTypes: string[]; valueType: 'text' | 'long_text' | 'decimal' | 'boolean' | 'date' | 'enum' | 'multi_enum'; enumValues: string[] | null };
export type CustomFieldValue = Header & { objectRef: EntityRef; fieldRef: VersionRef; value: string | string[] | boolean | null };
export type Commentary = Header & { targetRef: EntityRef; text: string };
export type FileArtifactRef = { artifactId: UUIDv4; hash: Sha256; mimeType: string; bytes: number };
export type Evidence = Header & ({ kind: 'file'; file: FileArtifactRef } | { kind: 'url'; url: string });
export type RegisteredPayload = { schemaId: string; schemaVersion: PositiveInt; value: Record<string, unknown> };
export type DashboardDef = Header & { title: string; blocks: { id: UUIDv4; typeId: string; settings: RegisteredPayload }[]; filters: RegisteredPayload[] };
