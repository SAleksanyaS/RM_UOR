import { describe, expect, it } from 'vitest';
import type { Goal, GoalMeasurement, Observation } from '../../domain/contracts';
import { evaluateGoal } from './evaluate';
import demo from '../../../catalog/demo.json';

const metric = { id: 'value', name: 'Значение', unit: 'шт', target: 5, direction: 'increase' as const };
const goal = { ...demo.goals[0], id: 'goal', officialTarget: 5, internalTarget: null, direction: 'increase' } as Goal;
function evaluate(measurement: GoalMeasurement, values: number[], extra: Partial<Goal> = {}, participants = values.map((_, i) => `p${i}`)) {
  const observations: Observation[] = values.map((value, i) => ({ id: `r${i}`, goalId: 'goal', leaderId: 'leader', participantId: `p${i}`,
    participantName: '', metricId: 'value', metricName: '', value, target: 1000, unit: 'шт', state: 'numeric', reason: null,
    sourceId: 'source', period: '2026-10-25', sourceUpdatedAt: null, downloadedAt: '' }));
  return evaluateGoal({ goal: { ...goal, ...extra, measurement }, observations, period: '2026-10-25', expectedParticipants: participants });
}
describe('explicit methodology registry', () => {
  it('reports meaningful progress without inventing a scalar baseline', () => {
    expect(evaluate({ kind: 'participant_share', aggregation: 'average', metrics: [metric] }, [5, 0], { officialTarget: 100 }).progress).toBe(50);
    expect(evaluate({ kind: 'milestones', aggregation: 'average', metrics: [metric] }, [1, 0], { officialTarget: 100 }).progress).toBe(50);
    expect(evaluate({ kind: 'binary', aggregation: 'single', metrics: [metric] }, [1], { officialTarget: 1 }).progress).toBe(100);
    expect(evaluate({ kind: 'binary', aggregation: 'single', metrics: [metric] }, [0], { officialTarget: 1 }).progress).toBe(0);
    expect(evaluate({ kind: 'range', aggregation: 'single', metrics: [metric], range: { min: 3, max: 8 } }, [5]).progress).toBe(100);
    expect(evaluate({ kind: 'range', aggregation: 'single', metrics: [metric], range: { min: 3, max: 8 } }, [9]).progress).toBe(0);
    expect(evaluate({ kind: 'scalar', aggregation: 'single', metrics: [metric] }, [5], { baseline: null, unit: 'шт' }).progress).toBeNull();
    expect(evaluate({ kind: 'scalar', aggregation: 'single', metrics: [metric] }, [5], { baseline: 0, officialTarget: 10 }).progress).toBe(50);
    expect(evaluate({ kind: 'change', aggregation: 'single', metrics: [metric], change: { mode: 'absolute', baseline: 20 } }, [25], { officialTarget: 10 }).progress).toBe(50);
  });
  it('uses explicit scalar aggregation rather than participant share', () => {
    expect(evaluate({ kind: 'scalar', aggregation: 'sum', metrics: [metric] }, [2, 3])).toMatchObject({ actual: 5, official: 'met' });
    expect(evaluate({ kind: 'scalar', aggregation: 'average', metrics: [metric] }, [2, 4])).toMatchObject({ actual: 3, official: 'not_met' });
    expect(evaluate({ kind: 'scalar', aggregation: 'single', metrics: [metric] }, [9, 9]).official).toBe('unknown');
  });
  it('never accepts incomplete expected participants', () => {
    expect(evaluate({ kind: 'scalar', aggregation: 'sum', metrics: [metric] }, [9], {}, ['p0', 'p1']).official).toBe('unknown');
  });
  it('does not count an unmeasured defined milestone as a completed plan', () => {
    const measurement: GoalMeasurement = { kind: 'milestones', aggregation: 'average', metrics: [metric, { ...metric, id: 'second' }] };
    const observations: Observation[] = ['value', 'second'].map((metricId, index) => ({ id: metricId, goalId: 'goal', leaderId: 'leader', participantId: 'p0', participantName: '',
      metricId, metricName: '', value: index ? null : 1, target: 1, unit: '', state: index ? 'exception' : 'numeric', reason: index ? 'Не проверено' : null,
      sourceId: 'source', period: '2026-10-25', sourceUpdatedAt: null, downloadedAt: '' }));
    expect(evaluateGoal({ goal: { ...goal, officialTarget: 100, measurement }, observations, period: '2026-10-25', expectedParticipants: ['p0'] }).official).toBe('unknown');
  });
  it('requires binary values and counts defined milestones only', () => {
    expect(evaluate({ kind: 'binary', aggregation: 'single', metrics: [metric] }, [1], { officialTarget: 1 })).toMatchObject({ actual: 1, official: 'met' });
    expect(evaluate({ kind: 'binary', aggregation: 'single', metrics: [metric] }, [2], { officialTarget: 1 }).official).toBe('unknown');
    expect(evaluate({ kind: 'milestones', aggregation: 'average', metrics: [metric] }, [1, 0], { officialTarget: 100 })).toMatchObject({ actual: 50, official: 'not_met' });
  });
  it('checks inclusive range and signed change from an explicit base', () => {
    expect(evaluate({ kind: 'range', aggregation: 'single', metrics: [metric], range: { min: 3, max: 8 } }, [5])).toMatchObject({ actual: 5, official: 'met' });
    expect(evaluate({ kind: 'range', aggregation: 'single', metrics: [metric], range: { min: 3, max: 8 } }, [9]).official).toBe('not_met');
    expect(evaluate({ kind: 'change', aggregation: 'single', metrics: [metric], change: { mode: 'percent', baseline: 20 } }, [30], { officialTarget: 50 })).toMatchObject({ actual: 50, official: 'met' });
    expect(evaluate({ kind: 'change', aggregation: 'single', metrics: [metric], change: { mode: 'percent', baseline: 0 } }, [30]).official).toBe('unknown');
  });
  it('compares each participant metric using its own direction and threshold', () => {
    const measurement: GoalMeasurement = { kind: 'participant_share', aggregation: 'average', metrics: [{ ...metric, direction: 'decrease' }] };
    expect(evaluate(measurement, [3, 9], { officialTarget: 50 })).toMatchObject({ actual: 50, official: 'met', metParticipants: 1 });
  });
  it('requires every defined metric across the selected cohort with independent directions', () => {
    const measurement: GoalMeasurement = { kind: 'participant_share', aggregation: 'average', metrics: [metric, { ...metric, id: 'errors', target: 2, direction: 'decrease' }] };
    const observations: Observation[] = [['p0', 'value', 10], ['p0', 'errors', 1], ['p1', 'value', 9], ['p1', 'errors', 4]].map(([participantId, metricId, value], i) => ({
      id: String(i), goalId: 'goal', leaderId: 'leader', participantId: String(participantId), metricId: String(metricId), value: Number(value),
      participantName: '', metricName: '', target: 99, unit: '', state: 'numeric', reason: null, sourceId: 'source', period: '2026-10-25', sourceUpdatedAt: null, downloadedAt: '' }));
    const input = { goal: { ...goal, officialTarget: 50, measurement }, observations, period: '2026-10-25', expectedParticipants: ['p0', 'p1'] };
    expect(evaluateGoal(input)).toMatchObject({ actual: 50, official: 'met', metParticipants: 1, metMetrics: 3 });
    expect(evaluateGoal({ ...input, observations: observations.slice(0, 3) })).toMatchObject({ official: 'unknown', missing: 1, coverage: 75 });
    expect(evaluateGoal({ ...input, expectedParticipants: undefined }).official).toBe('unknown');
  });
  it('binds confirmations to the configured method and ignores display names', () => {
    const measurement: GoalMeasurement = { kind: 'scalar', aggregation: 'sum', metrics: [metric] };
    const initial = evaluate(measurement, [5]);
    expect(evaluate({ ...measurement, aggregation: 'average' }, [5]).fingerprint).not.toBe(initial.fingerprint);
    expect(evaluate({ ...measurement, metrics: [{ ...metric, name: 'Другое название' }] }, [5]).fingerprint).toBe(initial.fingerprint);
  });
});
