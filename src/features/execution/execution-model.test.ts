import { describe, expect, it } from 'vitest';
import { assertDependencyGraph, buildBurndown, forecastGoal, retentionStatus, weightedAchievement } from './execution-model';
import type { WorkPackage, ExecutionConfig } from './execution-contracts';
import type { Goal, Evaluation } from '../../domain/contracts';
import type { GoalHistoryPoint } from '../history/history-contracts';

const work = (id: string, dependencies: string[] = []): WorkPackage => ({ id, goalId: 'g', leaderId: null, title: id, owner: 'Анна', dueDate: '2026-11-10', weight: 1, effortHours: 8, dependencies, revision: id, baseline: null, events: [] });
describe('execution calculations', () => {
  it('rejects cross-goal cycles and missing dependency references', () => {
    expect(() => assertDependencyGraph([work('a', ['b']), { ...work('b', ['a']), goalId: 'other' }])).toThrow(/цикл/i);
    expect(() => assertDependencyGraph([work('a', ['missing'])])).toThrow(/зависим/i);
  });
  it('uses immutable baseline weights and real events without inventing prior completion', () => {
    const item = { ...work('a'), weight: 100, baseline: { at: '2026-10-25T10:00:00.000Z', dueDate: '2026-11-10', weight: 2, effortHours: 8 }, events: [{ id: 'e', at: '2026-10-27T10:00:00.000Z', completed: true, comment: 'Принят документ', evidence: '', actor: 'Анна' }] };
    const result = buildBurndown([item], '2026-10-28T10:00:00.000Z');
    expect(result.points[0]).toMatchObject({ at: item.baseline.at, remaining: 2 });
    expect(result.points.find(p => p.at === item.events[0].at)?.remaining).toBe(0);
    expect(result.plannedPoints.at(-1)).toMatchObject({ at: '2026-11-10T21:00:00.000Z', planned: 0 });
    expect(buildBurndown([work('unbased')]).points).toEqual([]);
  });
  it('requires three comparable real numeric periods and appropriate continuous method', () => {
    const goal = { measurement: { kind: 'scalar', aggregation: 'single', metrics: [] }, direction: 'increase', officialTarget: 40 } as unknown as Goal;
    const points = [10, 20, 30].map((actual, i) => ({ period: `2026-10-0${i + 1}`, actual, officialTarget: 40, cohortKey: 'same', comparableToPrevious: i > 0, qualityFlags: [], official: 'not_met' as const, validation: 'not_required' as const, eligibleParticipants: 1, metParticipants: 0, coverage: 1, snapshotIds: [`s${i}`], fingerprint: `f${i}` })) satisfies GoalHistoryPoint[];
    expect(forecastGoal(goal, points)).toMatchObject({ date: '2026-10-04', sampleCount: 3, ratePerDay: 10 });
    expect(forecastGoal(goal, points.slice(1)).date).toBeNull();
    expect(forecastGoal(goal, points.map((p, i) => ({ ...p, comparableToPrevious: i === 2 ? false : p.comparableToPrevious }))).date).toBeNull();
    expect(forecastGoal({ ...goal, measurement: { ...goal.measurement!, kind: 'binary' } }, points).date).toBeNull();
  });
  it('separates overdue retention from confirmation and schedules from actual last check', () => {
    const config = { cadenceDays: 7, nextCheckDate: '2026-10-26', checks: [] } as unknown as ExecutionConfig;
    expect(retentionStatus(config, '2026-10-27')).toEqual({ status: 'overdue', nextCheckDate: '2026-10-26' });
    expect(retentionStatus({ ...config, checks: [{ id: 'x', at: '2026-10-25T12:00:00Z', comment: 'Проверены факты', evidence: '', actor: 'А', result: 'regression' }] }, '2026-10-27').status).toBe('overdue');
  });
  it('reports missing and unknown weights separately from normalized confirmed share', () => {
    const goals = [{ id: 'a', weight: 2 }, { id: 'b', weight: 1 }, { id: 'c', weight: null }] as Goal[];
    const evaluations = [{ goalId: 'a', leaderId: null, official: 'met', validation: 'confirmed' }, { goalId: 'b', leaderId: null, official: 'unknown', validation: 'not_required' }] as Evaluation[];
    expect(weightedAchievement(goals, evaluations)).toMatchObject({ confirmedShare: 2 / 3, weightedGoals: 2, missingWeight: 1, unknownWeightedGoals: 1, denominator: 3 });
    expect(weightedAchievement([{ id: 'z', weight: 0 }] as Goal[], []).confirmedShare).toBeNull();
  });
});
