import type { CatalogSnapshot, SnapshotEvaluationBasis, Goal, Assignment } from '../../domain/contracts';
import { measurementRules } from '../evaluation/measurement';

/** Capture on acceptance, never on reading an old snapshot. */
export function captureEvaluationBasis(catalog: CatalogSnapshot, goalId: string): SnapshotEvaluationBasis {
  const goal = catalog.goals.find(item => item.id === goalId);
  if (!goal) throw new Error('Цель для исторической основы не найдена');
  const assignments = catalog.assignments.filter(item => item.goalId === goalId);
  const leaderIds = new Set(assignments.map(item => item.leaderId));
  if (goal.ownerId) leaderIds.add(goal.ownerId);
  if (goal.curatorId) leaderIds.add(goal.curatorId);
  return structuredClone({ methodVersion: goal.measurement ? 'explicit-measurement-v1' : 'participant-all-applicable-metrics-v1', goal, assignments,
    organization: { leaders: catalog.leaders.filter(item => leaderIds.has(item.id)), entities: catalog.entities,
      directions: catalog.directions ?? [], comments: catalog.comments.filter(item => item.goalId === goalId), sources: catalog.sources.filter(item => item.goalIds.includes(goalId)) } });
}
export const evaluationScope = (assignments: Assignment[]) => assignments.map(a => ({ id: a.id, teams: [...a.teams].sort(), participantIds: a.participantIds ? [...a.participantIds].sort() : null, target: a.target ?? null })).sort((a, b) => a.id.localeCompare(b.id));
export const historicalRules = (goal: Goal, assignments: Assignment[]) => ({ id: goal.id, officialTarget: goal.officialTarget, internalTarget: goal.internalTarget,
  baseline: goal.baseline, direction: goal.direction, unit: goal.unit, scopeType: goal.scopeType, requiredMetricIds: [...(goal.requiredMetricIds ?? [])].sort(),
  measurement: goal.measurement ? measurementRules(goal.measurement) : null, scope: evaluationScope(assignments) });
