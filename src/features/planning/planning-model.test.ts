import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot, Evaluation, ExecutionPlan, Goal } from '../../domain/contracts';
import { buildPlanningModel, moscowToday } from './planning-model';
function goal(id: string, dueDate: string | null): Goal { return { id, dueDate, title: id, category: 'process', target: '', metric: '', summary: '', status: '', scopeType: 'team', actions: [], links: [],
  officialTarget: 80, internalTarget: null, unit: '%', direction: 'increase', baseline: 0, weight: null, priority: null, ownerId: null, curatorId: null, revision: 'one' }; }
function plan(patch: Partial<ExecutionPlan> = {}): ExecutionPlan { return { stage: 'planned', plannedStartDate: null, targetDate: null, forecastDate: null, nextCheckDate: null,
  nextAction: '', blocker: '', decisionNeeded: '', updatedAt: '2026-10-24T00:00:00Z', updatedBy: 'Куратор', revision: 'plan-one', ...patch }; }
function evaluation(goalId: string, validation: Evaluation['validation']): Evaluation { return { id: goalId, goalId, leaderId: null, period: '2026-10-24', actual: 100, progress: 100, officialTarget: 80,
  internalTarget: null, official: 'met', internal: 'unknown', validation, fingerprint: 'demo', eligibleMetrics: 1, metMetrics: 1, eligibleParticipants: 1, metParticipants: 1, excluded: 0, missing: 0, coverage: 100, qualityFlags: [] }; }
function catalog(): CatalogSnapshot { return { schemaVersion: 1, id: 'planning-demo', name: 'Пример', classification: 'demo', importedAt: '2026-10-24T00:00:00Z',
  goals: [goal('g1', '2026-10-20'), goal('g2', null)], leaders: [{ id: 'l1', name: 'Лидер А', teams: [] }, { id: 'l2', name: 'Лидер Б', teams: [] }],
  assignments: [{ id: 'a1', goalId: 'g1', leaderId: 'l1', teams: [] }, { id: 'a2', goalId: 'g2', leaderId: 'l1', teams: [], active: false }, { id: 'a3', goalId: 'g1', leaderId: 'l2', teams: [] }],
  sources: [], entities: [], comments: [] }; }

describe('declared planning projection', () => {
  it('does not hide a missed official deadline behind a later work commitment or monitoring stage', () => {
    const source = catalog(); source.goals[0].plan = plan({ stage: 'monitoring', targetDate: '2026-11-15', forecastDate: '2026-11-10' });
    const row = buildPlanningModel({ catalog: source, snapshots: [], evaluations: [] }, { today: '2026-10-24' }).rows[0];
    expect(row.deadline).toBe('2026-11-15');
    expect(row.officialDeadline).toBe('2026-10-20');
    expect(row.overdue).toBe(true); expect(row.forecastLate).toBe(true);
  });
  it('keeps missing plans unknown and uses the official due date only as a fallback', () => {
    const source = catalog(); source.assignments = source.assignments.filter(item => item.goalId !== 'g2');
    const model = buildPlanningModel({ catalog: source, snapshots: [], evaluations: [] }, { today: '2026-10-24' });
    expect(model.rows).toHaveLength(2);
    expect(model.rows[0]).toMatchObject({ scope: 'goal', leader: null, stage: null, missingPlan: true, deadline: '2026-10-20', officialDeadline: '2026-10-20', forecastDate: null, overdue: true, measuredStatus: 'unknown' });
    expect(model.counts).toMatchObject({ total: 2, unplanned: 2, overdue: 1, withoutForecast: 2 });
    expect(model.counts.byStage.planned).toBe(0);
  });
  it('uses only a selected leader’s own active assignment plans without inheriting the global plan', () => {
    const source = catalog(); source.goals[0].plan = plan({ targetDate: '2026-10-30' });
    source.assignments[1].plan = plan({ stage: 'monitoring' }); source.assignments[2].plan = plan({ targetDate: '2026-10-29' });
    const model = buildPlanningModel({ catalog: source, snapshots: [], evaluations: [] }, { leaderId: 'l1', today: '2026-10-24' });
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ scope: 'assignment', leader: { id: 'l1' }, assignment: { id: 'a1' }, missingPlan: true, deadline: '2026-10-20' });
    expect(model.rows[0].plan).toBeUndefined();
    expect(buildPlanningModel({ catalog: source, snapshots: [], evaluations: [] }, { leaderId: 'l1', goalId: 'g2', today: '2026-10-24' }).rows).toEqual([]);
  });
  it('separates work stage and manual forecasts from confirmed result and uses the Moscow calendar', () => {
    const source = catalog(); source.assignments = source.assignments.filter(item => item.goalId !== 'g2');
    source.goals[0].plan = plan({ stage: 'ready_for_review', targetDate: '2026-10-22', forecastDate: '2026-10-25', decisionNeeded: 'Согласовать ресурс' });
    source.goals[1].plan = plan({ stage: 'blocked', targetDate: '2026-10-20', blocker: 'Внешняя зависимость', nextAction: 'Повторить проверку' });
    const model = buildPlanningModel({ catalog: source, snapshots: [], evaluations: [evaluation('g1', 'pending'), evaluation('g2', 'confirmed')] }, { today: '2026-10-24' });
    expect(model.rows[0]).toMatchObject({ overdue: true, forecastLate: true, needsDecision: true, measuredStatus: 'pending', officialDeadline: '2026-10-20', deadline: '2026-10-22' });
    expect(model.rows[1]).toMatchObject({ stage: 'blocked', overdue: false, forecastDate: null, measuredStatus: 'confirmed' });
    expect(model.counts).toMatchObject({ overdue: 1, forecastLate: 1, needsDecision: 1, withoutForecast: 1 });
    expect(moscowToday(new Date('2026-10-24T21:01:00Z'))).toBe('2026-10-25');
  });
});
