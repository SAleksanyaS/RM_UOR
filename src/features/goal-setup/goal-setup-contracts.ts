import type { Assignment, Evaluation, Goal, GoalMeasurement, Observation, SourceDefinition } from '../../domain/contracts';

export interface GoalSetupInput {
  requestId: string;
  goalId?: string;
  baseRevision?: string;
  goal: Pick<Goal, 'title' | 'category' | 'officialTarget' | 'internalTarget' | 'unit' | 'direction'> &
    Partial<Pick<Goal, 'target' | 'metric' | 'summary' | 'scopeType' | 'ownerId' | 'curatorId' | 'dueDate' | 'baseline' | 'workDirectionId' | 'priority' | 'weight' | 'links' | 'actions'>>;
  measurement: GoalMeasurement;
  assignments: { leaderId: string; participantIds: string[] }[];
  source: { existingSourceId?: string; kind?: SourceDefinition['kind']; name?: string; url?: string | null; accessUrl?: string | null; freshnessHours?: number };
  sample: { period: string; rows: Pick<Observation, 'leaderId' | 'participantId' | 'metricId' | 'value' | 'state' | 'reason'>[] };
}
export interface GoalSetupPreview {
  previewId: string; expiresAt: string; goal: Goal; assignments: Assignment[]; source: SourceDefinition;
  evaluations: Evaluation[]; warnings: string[];
}
export interface GoalSetupCommit { goalId: string; draftIds: string[]; operationId: string }
