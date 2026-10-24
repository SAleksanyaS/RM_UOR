import type { Leader } from '../../domain/contracts';

export interface LeaderInput {
  name: string;
  clusterName: string | null;
  goalIds: string[];
  baseLeader?: Leader;
  /** Complete active membership observed when the editor was opened. */
  baseGoalIds?: string[];
}
export interface LeaderResult { leader: Leader; goalIds: string[]; operationId: string }
