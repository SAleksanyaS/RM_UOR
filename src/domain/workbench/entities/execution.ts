import type { Header, MoscowDate, ScopeRef, UtcInstant, UUIDv4 } from '../primitives';

export type Work = Header & { title: string; goalIds: UUIDv4[]; responsibility: { scope: ScopeRef; personId: UUIDv4 }[]; state: 'planned' | 'in_progress' | 'paused' | 'completed' | 'cancelled'; dueOn: MoscowDate | null; forecastOn: MoscowDate | null; nextAction: string; reason: string | null; resultDescription: string | null; evidenceIds: UUIDv4[]; risk: { reason: string; helpNeeded: string } | null; blocker: string | null };
export type WorkDependency = Header & { predecessorWorkId: UUIDv4; successorWorkId: UUIDv4; active: boolean; changeReason: string | null };
export type Decision = Header & { workId: UUIDv4; request: string; requestedFromPersonId: UUIDv4; dueOn: MoscowDate; answer: string | null; answeredAt: UtcInstant | null };
