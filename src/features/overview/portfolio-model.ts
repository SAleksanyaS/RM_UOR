import type { Evaluation, Goal, Leader, LocalSnapshot } from '../../domain/contracts';
import { buildOverview, evaluationStatus, statusColors, statusOrder } from './overview-model';
import type { GoalStatus, OverviewCell, OverviewInput } from './overview-model';

export interface PortfolioSegment { status: GoalStatus; count: number; share: number; color: string }
export interface PortfolioGoal {
  goal: Goal; cells: OverviewCell[]; evaluation?: Evaluation; status: GoalStatus;
  knownAssignments: number; totalAssignments: number; stale: boolean;
}
export interface PortfolioLeader { leader: Leader; total: number; known: number; segments: PortfolioSegment[] }
export type PortfolioOverall = 'no_goals' | 'insufficient_data' | 'attention' | 'validation' | 'confirmed';
export interface PortfolioModel {
  goals: PortfolioGoal[]; leaders: PortfolioLeader[]; segments: PortfolioSegment[];
  goalCount: number; assignmentCount: number; knownGoals: number; knownAssignments: number;
  confirmedGoals: number; remainingGoals: number;
  /** Coverage is a ratio from 0 to 1. Segment shares are percentages from 0 to 100. */
  coverage: number | null; assignmentCoverage: number | null;
  staleGoals: number; overall: PortfolioOverall; periods: string[];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) if (!unique.has(key(value))) unique.set(key(value), value);
  return [...unique.values()];
}
function segments(statuses: GoalStatus[]): PortfolioSegment[] {
  return statusOrder.map(status => {
    const count = statuses.filter(value => value === status).length;
    return { status, count, share: statuses.length ? count / statuses.length * 100 : 0, color: statusColors[status] };
  });
}
const staleEvaluation = (evaluation?: Evaluation) => evaluation?.qualityFlags.some(flag => /stale|outdated|устар/i.test(flag)) ?? false;
const hasActual = (evaluation: Evaluation) => evaluation.actual !== null && Number.isFinite(evaluation.actual);

/** Current periods follow selected evidence, never every file in the historical archive. */
function selectedPeriods(goals: PortfolioGoal[], snapshots: LocalSnapshot[]): string[] {
  const periods = new Set<string>();
  const add = (period?: string) => { if (period?.trim()) periods.add(period); };
  const selected = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  for (const row of goals) {
    const addEvaluation = (evaluation?: Evaluation, provenance?: LocalSnapshot) => {
      if (!evaluation) return;
      if (evaluation.snapshotIds !== undefined) {
        for (const id of evaluation.snapshotIds) {
          const snapshot = selected.get(id);
          if (snapshot?.observations.some(fact => fact.goalId === row.goal.id
            && (evaluation.leaderId === null ? fact.leaderId === null || row.cells.some(cell => cell.leader.id === fact.leaderId) : fact.leaderId === evaluation.leaderId))) add(snapshot.period);
        }
      } else {
        if (hasActual(evaluation)) add(evaluation.period);
        if (provenance?.observations.length) add(provenance.period);
      }
    };
    addEvaluation(row.evaluation);
    for (const cell of row.cells) addEvaluation(cell.evaluation, cell.provenance);
  }
  return [...periods].sort();
}

/**
 * A portfolio counts official global goal outcomes. Leader outcomes form a
 * separate assignment distribution; metric values and weights are not averaged.
 */
export function buildPortfolioModel(input: OverviewInput, selectedGoalId?: string | null): PortfolioModel {
  const definitions = uniqueBy(input.catalog.goals, goal => goal.id).filter(goal => selectedGoalId == null || goal.id === selectedGoalId);
  const leaders = uniqueBy(input.catalog.leaders, leader => leader.id);
  const goalIds = new Set(definitions.map(goal => goal.id)), leaderIds = new Set(leaders.map(leader => leader.id));
  const assignments = uniqueBy(input.catalog.assignments.filter(assignment => assignment.active !== false
    && goalIds.has(assignment.goalId) && leaderIds.has(assignment.leaderId)), assignment => JSON.stringify([assignment.goalId, assignment.leaderId]));
  const overview = buildOverview({ ...input, catalog: { ...input.catalog, goals: definitions, leaders, assignments } });
  const assignedRows = new Map(overview.goals.map(row => [row.goal.id, row]));
  const visibleGoals = definitions.filter(goal => goal.scopeType === 'global' || assignedRows.has(goal.id) || selectedGoalId != null
    || !input.catalog.assignments.some(assignment => assignment.goalId === goal.id));
  const goals: PortfolioGoal[] = visibleGoals.map(goal => {
    const row = assignedRows.get(goal.id) ?? { goal, cells: [] };
    const evaluation = input.evaluations.find(item => item.goalId === row.goal.id && item.leaderId === null);
    return { ...row, evaluation, status: evaluationStatus(evaluation, 'official'), totalAssignments: row.cells.length,
      knownAssignments: row.cells.filter(cell => cell.status !== 'unknown').length,
      stale: staleEvaluation(evaluation) || row.cells.some(cell => cell.stale) };
  });
  const goalCount = goals.length, assignmentCount = overview.cells.length;
  const knownGoals = goals.filter(goal => goal.status !== 'unknown').length;
  const knownAssignments = overview.cells.filter(cell => cell.status !== 'unknown').length;
  const confirmedGoals = goals.filter(goal => goal.status === 'confirmed').length;
  const overall: PortfolioOverall = !goalCount ? 'no_goals' : knownGoals < goalCount ? 'insufficient_data'
    : goals.some(goal => goal.status === 'not_met') ? 'attention'
      : goals.some(goal => goal.status === 'pending') ? 'validation' : 'confirmed';
  return {
    goals, leaders: overview.leaders.map(leader => {
      const cells = overview.cells.filter(cell => cell.leader.id === leader.id);
      return { leader, total: cells.length, known: cells.filter(cell => cell.status !== 'unknown').length, segments: segments(cells.map(cell => cell.status)) };
    }), segments: segments(goals.map(goal => goal.status)), goalCount, assignmentCount, knownGoals, knownAssignments,
    confirmedGoals, remainingGoals: goalCount - confirmedGoals, coverage: goalCount ? knownGoals / goalCount : null,
    assignmentCoverage: assignmentCount ? knownAssignments / assignmentCount : null,
    staleGoals: goals.filter(goal => goal.stale).length, overall, periods: selectedPeriods(goals, input.snapshots),
  };
}
