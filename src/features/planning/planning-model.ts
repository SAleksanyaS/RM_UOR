import type { Assignment, Evaluation, ExecutionPlan, Goal, Leader, WorkStage } from '../../domain/contracts';
import type { GoalStatus, OverviewInput } from '../overview/overview-model';
import { evaluationStatus } from '../overview/overview-model';
import { buildPortfolioModel } from '../overview/portfolio-model';
import { WORK_STAGES } from './plan-contracts';

export interface PlanningRow {
  id: string; scope: 'goal' | 'assignment'; goal: Goal; leader: Leader | null; assignment?: Assignment;
  plan?: ExecutionPlan; evaluation?: Evaluation; stage: WorkStage | null; measuredStatus: GoalStatus;
  deadline: string | null; officialDeadline: string | null; forecastDate: string | null;
  overdue: boolean; forecastLate: boolean; needsDecision: boolean; missingPlan: boolean;
  officialOverdue: boolean; deadlineOverdue: boolean; forecastMissesOfficial: boolean;
}
export interface PlanningCounts {
  total: number; unplanned: number; byStage: Record<WorkStage, number>;
  overdue: number; forecastLate: number; needsDecision: number; withoutForecast: number;
}
export interface PlanningModel { rows: PlanningRow[]; counts: PlanningCounts; today: string }
export interface PlanningOptions { leaderId?: string | null; goalId?: string | null; today?: string }

/** Calendar boundaries follow the user's Moscow timezone, independently of the host. */
export function moscowToday(at = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function calendarDate(value: string) {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
    throw new Error('Укажите календарную дату в формате ГГГГ-ММ-ДД');
  return value;
}

/** Declared work plans never stand in for measured results or infer missing dates. */
export function buildPlanningModel(input: OverviewInput, options: PlanningOptions = {}): PlanningModel {
  const today = calendarDate(options.today ?? moscowToday());
  const portfolio = buildPortfolioModel(input, options.goalId);
  const rows: PlanningRow[] = portfolio.goals.flatMap(row => {
    if (options.leaderId) {
      const cell = row.cells.find(item => item.leader.id === options.leaderId);
      if (!cell) return [];
      return [makeRow(row.goal, cell.leader, cell.assignment, cell.assignment.plan, cell.evaluation)];
    }
    return [makeRow(row.goal, null, undefined, row.goal.plan, row.evaluation)];
  });
  function makeRow(goal: Goal, leader: Leader | null, assignment: Assignment | undefined, plan: ExecutionPlan | undefined, evaluation: Evaluation | undefined): PlanningRow {
    const deadline = plan?.targetDate ?? goal.dueDate ?? null;
    const forecastDate = plan?.forecastDate ?? null;
    const officialDeadline = goal.dueDate ?? null;
    const unconfirmed = evaluation?.validation !== 'confirmed';
    const deadlineOverdue = !!deadline && deadline < today && unconfirmed;
    const officialOverdue = !!officialDeadline && officialDeadline < today && unconfirmed;
    const forecastMissesOfficial = !!officialDeadline && !!forecastDate && forecastDate > officialDeadline;
    return { id: assignment ? `assignment:${assignment.id}` : `goal:${goal.id}`, scope: assignment ? 'assignment' : 'goal', goal, leader,
      assignment, plan, evaluation, stage: plan?.stage ?? null, measuredStatus: evaluationStatus(evaluation), deadline,
      officialDeadline, forecastDate, overdue: deadlineOverdue || officialOverdue, officialOverdue, deadlineOverdue, forecastMissesOfficial,
      forecastLate: forecastMissesOfficial || !!deadline && !!forecastDate && forecastDate > deadline, needsDecision: !!plan?.decisionNeeded.trim(), missingPlan: !plan };
  }
  const byStage = Object.fromEntries(WORK_STAGES.map(stage => [stage, 0])) as Record<WorkStage, number>;
  for (const row of rows) if (row.stage) byStage[row.stage]++;
  return { rows, today, counts: { total: rows.length, unplanned: rows.filter(row => row.missingPlan).length, byStage,
    overdue: rows.filter(row => row.overdue).length, forecastLate: rows.filter(row => row.forecastLate).length,
    needsDecision: rows.filter(row => row.needsDecision).length, withoutForecast: rows.filter(row => row.forecastDate === null).length } };
}
