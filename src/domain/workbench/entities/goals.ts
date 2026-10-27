import type { Header, MoscowDate, ScopeRef, UUIDv4, VersionRef } from '../primitives';

export type CoreGoalDefinition = Header & {
  title: string; description: string; mode: 'numeric' | 'manual_status'; measurementMode: 'as_of' | 'period'; sourceId: UUIDv4;
  primaryCuratorPersonId: UUIDv4; coCuratorPersonIds: UUIDv4[]; lifecycle: 'active' | 'archived'; archiveReason: string | null;
};
export type MethodBinding = { kind: 'template'; templateId: UUIDv4 } | { kind: 'standalone'; methodRef: VersionRef };
export type GoalAssignment = Header & { goalId: UUIDv4; scope: ScopeRef; methodBinding: MethodBinding; officialDueOn: MoscowDate | null; expectedPopulation: ScopeRef[] | null };
export type Template = Header & { name: string; methodRef: VersionRef };
