import type { DateRange, Decimal, Header, UUIDv4, VersionRef } from '../primitives';

export type Applicability = Header & { assignmentId: UUIDv4; metricId: UUIDv4; period: DateRange; kind: 'not_applicable'; reason: string };
export type ManualCorrection = Header & { factKey: string; originalFactRefs: VersionRef[]; replacement: Decimal; reason: string };
export type ManualState = 'not_started' | 'in_progress' | 'completed';
export type ManualStatusEvent = Header & { assignmentId: UUIDv4; from: ManualState | null; to: ManualState; resultDescription: string | null; reason: string | null; evidenceIds: UUIDv4[] };
