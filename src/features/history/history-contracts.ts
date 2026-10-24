import type { Evaluation } from '../../domain/contracts';

/** Browser-safe history contract. Reading history never changes present-day attestations. */
export interface GoalHistoryPoint {
  period: string; actual: number | null; officialTarget: number | null;
  official: Evaluation['official']; validation: Evaluation['validation'];
  eligibleParticipants: number; metParticipants: number; coverage: number | null;
  qualityFlags: string[]; snapshotIds: string[]; fingerprint: string;
  cohortKey: string; comparableToPrevious: boolean;
  changes?: { added: number; changed: number; removed: number };
  revisions?: number;
  historicalConfirmedAt?: string | null;
}
export interface GoalHistory { goalId: string; leaderId: string | null; points: GoalHistoryPoint[] }
