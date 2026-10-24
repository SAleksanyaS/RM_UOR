import { describe, expect, it } from 'vitest';
import type { Attestation, EvaluationInput, Goal, Observation } from '../../domain/contracts';
import { evaluateGoal, goalProgress, validateAchievement } from './evaluate';
import { evaluationFingerprint } from './fingerprint';
import maturityFixture from '../../../tests/fixtures/maturity-demo.json';

const goal: Goal = {
  id: 'maturity-demo', title: 'Демонстрационная зрелость', category: 'process', target: '100%',
  metric: 'Доля команд', status: '', summary: '', actions: [], scopeType: 'team', links: [],
  ownerId: null, curatorId: null, officialTarget: 100, internalTarget: 100, unit: '%',
  direction: 'increase', baseline: 0, weight: null, priority: null, dueDate: null, revision: '1',
};
function observation(participantId: string, metricId: string, value: number | null, overrides: Partial<Observation> = {}): Observation {
  return {
    id: `${participantId}-${metricId}`, goalId: goal.id, leaderId: 'leader-demo', participantId,
    participantName: participantId, metricId, metricName: metricId, value, target: 80, unit: '%',
    state: 'numeric', reason: null, period: '2026-10', sourceId: 'demo',
    sourceUpdatedAt: '2026-10-16T10:00:00Z', downloadedAt: '2026-10-24T10:00:00Z', ...overrides,
  };
}
function input(observations: Observation[], overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return { goal, observations, period: '2026-10', leaderId: 'leader-demo', ...overrides };
}
function attestation(i: EvaluationInput): Attestation {
  return { id: 'confirmed', goalId: i.goal.id, leaderId: i.leaderId ?? null, fingerprint: evaluationFingerprint(i),
    period: i.period, curatorId: 'curator-demo', curatorName: 'Куратор демо',
    confirmedAt: '2026-10-24T12:00:00Z', comment: 'Проверено по приложенному расчёту', evidenceIds: [] };
}

describe('evaluateGoal', () => {
  it('matches the independent synthetic fixture control totals', () => {
    const result = evaluateGoal(maturityFixture as EvaluationInput);
    expect(result).toMatchObject(maturityFixture.expected);
  });
  it('counts a participant once and requires every applicable numeric metric', () => {
    const result = evaluateGoal(input([
      observation('team-a', 'metric-a', 90), observation('team-a', 'metric-b', 70),
      observation('team-b', 'metric-a', 100), observation('team-b', 'metric-b', 90),
    ]));
    expect(result.actual).toBe(50);
    expect(result.eligibleParticipants).toBe(2);
    expect(result.metParticipants).toBe(1);
    expect(result.eligibleMetrics).toBe(4);
    expect(result.metMetrics).toBe(3);
    expect(result.official).toBe('not_met');
    expect(result.validation).toBe('not_required');
  });

  it('does not double weight duplicate rows', () => {
    const row = observation('team-a', 'metric-a', 90);
    const result = evaluateGoal(input([row, { ...row, id: 'second-copy' }, observation('team-b', 'metric-a', 0)]));
    expect(result.actual).toBe(50);
    expect(result.eligibleMetrics).toBe(2);
    expect(result.eligibleParticipants).toBe(2);
  });

  it('uses latest source business date for duplicate metrics', () => {
    const old = observation('team-a', 'metric-a', 0, { sourceUpdatedAt: '2026-10-01T00:00:00Z' });
    const latest = observation('team-a', 'metric-a', 90, { sourceUpdatedAt: '2026-10-16T00:00:00Z' });
    expect(evaluateGoal(input([latest, old])).actual).toBe(100);
    expect(evaluateGoal(input([old, latest])).official).toBe('met');
  });

  it('does not report success for conflicting same-date duplicate metrics', () => {
    const result = evaluateGoal(input([observation('team-a', 'metric-a', 0), observation('team-a', 'metric-a', 90)]));
    expect(result.official).not.toBe('met');
    expect(result.qualityFlags).toContain('conflicting_duplicate_metrics');
  });

  it('excludes exception and no-events rows without making their participants successful', () => {
    const result = evaluateGoal(input([
      observation('team-a', 'metric-a', null, { state: 'exception' }),
      observation('team-b', 'metric-a', null, { state: 'no_events' }),
    ]));
    expect(result.actual).toBeNull();
    expect(result.official).toBe('unknown');
    expect(result.excluded).toBe(2);
    expect(result.metParticipants).toBe(0);
  });

  it('ignores excluded metrics alongside an applicable successful metric', () => {
    const result = evaluateGoal(input([
      observation('team-a', 'metric-a', 90),
      observation('team-a', 'metric-b', null, { state: 'no_events' }),
    ]));
    expect(result.actual).toBe(100);
    expect(result.official).toBe('met');
  });

  it('does not coerce a null numeric value or missing threshold to zero', () => {
    const result = evaluateGoal(input([
      observation('team-a', 'metric-a', null),
      observation('team-b', 'metric-a', 90, { target: null }),
    ]));
    expect(result.official).toBe('unknown');
    expect(result.metParticipants).toBe(0);
    expect(result.missing).toBe(2);
    expect(result.coverage).toBe(0);
  });

  it('counts absent expected participants as missing coverage', () => {
    const result = evaluateGoal(input([observation('team-a', 'metric-a', 90)], { expectedParticipants: ['team-a', 'team-b'] }));
    expect(result.actual).toBe(50);
    expect(result.coverage).toBe(50);
    expect(result.official).toBe('unknown');
    expect(result.eligibleParticipants).toBe(2);
    expect(result.missing).toBe(1);
  });

  it('keeps a proven failure visible despite another missing participant', () => {
    const result = evaluateGoal(input([observation('team-a', 'metric-a', 0)], { expectedParticipants: ['team-a', 'team-b'] }));
    expect(result.official).toBe('not_met');
    expect(result.coverage).toBe(50);
  });

  it('does not let unexpected participants improve a fixed cohort', () => {
    const result = evaluateGoal(input([
      observation('team-a', 'metric-a', 0), observation('outsider', 'metric-a', 100),
    ], { expectedParticipants: ['team-a'] }));
    expect(result.actual).toBe(0);
    expect(result.eligibleParticipants).toBe(1);
    expect(result.qualityFlags).toContain('unexpected_participants');
  });

  it('scopes facts by goal, leader and period', () => {
    const result = evaluateGoal(input([
      observation('team-a', 'metric-a', 90),
      observation('team-b', 'metric-a', 0, { leaderId: 'other' }),
      observation('team-c', 'metric-a', 0, { period: '2026-09' }),
      observation('team-d', 'metric-a', 0, { goalId: 'other-goal' }),
    ]));
    expect(result.actual).toBe(100);
    expect(result.eligibleParticipants).toBe(1);
  });

  it('treats an explicit empty expected cohort as empty, not all observed', () => {
    const result = evaluateGoal(input([observation('outsider', 'metric-a', 90)], { expectedParticipants: [] }));
    expect(result.actual).toBeNull();
    expect(result.official).toBe('unknown');
  });

  it('compares a direct scalar fact to distinct official and internal targets', () => {
    const result = evaluateGoal(input([observation('scope', goal.id, 85)], {
      goal: { ...goal, officialTarget: 80, internalTarget: 95 },
    }));
    expect(result.actual).toBe(85);
    expect(result.official).toBe('met');
    expect(result.internal).toBe('not_met');
    expect(result.validation).toBe('pending');
  });

  it('supports decrease direction without averaging scalar facts into participant rates', () => {
    const result = evaluateGoal(input([observation('scope', goal.id, 4)], {
      goal: { ...goal, direction: 'decrease', baseline: 20, officialTarget: 5, internalTarget: 3 },
    }));
    expect(result.actual).toBe(4);
    expect(result.official).toBe('met');
    expect(result.internal).toBe('not_met');
    expect(result.progress).toBeCloseTo(106.666666, 4);
  });

  it('uses decrease direction for participant metric thresholds', () => {
    const result = evaluateGoal(input([observation('team-a', 'metric-a', 4, { target: 5 })], {
      goal: { ...goal, direction: 'decrease', officialTarget: 100 },
    }));
    // Dimensional result is a percentage of participants, so more is always better.
    expect(result.actual).toBe(100);
    expect(result.official).toBe('met');
  });

  it('does not invent achievement where the official target is missing', () => {
    const result = evaluateGoal(input([observation('scope', goal.id, 90)], { goal: { ...goal, officialTarget: null, internalTarget: null } }));
    expect(result.official).toBe('unknown');
    expect(result.progress).toBeNull();
    expect(result.validation).toBe('not_required');
  });

  it('refuses an ambiguous mixture of scalar and dimensional observations', () => {
    const result = evaluateGoal(input([observation('scope', goal.id, 100), observation('team-a', 'metric-a', 90)]));
    expect(result.actual).toBeNull();
    expect(result.official).toBe('unknown');
    expect(result.qualityFlags).toContain('mixed_measurement_modes');
  });

  it('confirms only an attestation for the exact positive evaluation', () => {
    const i = input([observation('team-a', 'metric-a', 90)]);
    expect(evaluateGoal(i).validation).toBe('pending');
    expect(evaluateGoal({ ...i, attestation: attestation(i) }).validation).toBe('confirmed');
    expect(evaluateGoal({ ...i, goal: { ...goal, officialTarget: 95 }, attestation: attestation(i) }).validation).toBe('pending');
    expect(evaluateGoal({ ...i, attestation: { ...attestation(i), leaderId: 'other' } }).validation).toBe('pending');
  });

  it('automatically regresses despite an earlier confirmation', () => {
    const i = input([observation('team-a', 'metric-a', 90)]);
    const result = evaluateGoal({ ...i, observations: [observation('team-a', 'metric-a', 10)], attestation: attestation(i) });
    expect(result.official).toBe('not_met');
    expect(result.validation).toBe('not_required');
  });
});

describe('evaluationFingerprint', () => {
  it('is stable for reordered facts, identical re-downloads and non-calculation edits', () => {
    const i = input([observation('team-a', 'metric-a', 90), observation('team-b', 'metric-a', 90)]);
    const changed = {
      ...i, expectedParticipants: undefined,
      goal: { ...goal, title: 'Другое описание', summary: 'Подробности', weight: 99, revision: '2' },
      observations: [...i.observations].reverse().map((row) => ({ ...row, id: `new-${row.id}`, downloadedAt: '2027-01-01T00:00:00Z', sourceUpdatedAt: '2026-10-24T12:00:00Z', participantName: 'Новое имя' })),
    };
    expect(evaluationFingerprint(changed)).toBe(evaluationFingerprint(i));
  });

  it('binds period, target, cohort, direction and observed values', () => {
    const i = input([observation('team-a', 'metric-a', 90)]);
    for (const next of [
      { ...i, period: '2026-11' },
      { ...i, goal: { ...goal, officialTarget: 95 } },
      { ...i, expectedParticipants: ['team-a', 'team-b'] },
      { ...i, goal: { ...goal, direction: 'decrease' as const } },
      { ...i, observations: [observation('team-a', 'metric-a', 91)] },
      { ...i, observations: [observation('team-a', 'metric-a', 90, { target: 85 })] },
    ]) expect(evaluationFingerprint(next)).not.toBe(evaluationFingerprint(i));
  });

  it('ignores repeated identical business rows and irrelevant scopes', () => {
    const row = observation('team-a', 'metric-a', 90);
    expect(evaluationFingerprint(input([row, { ...row, id: 'copy' }, observation('other', 'metric-a', 0, { leaderId: 'other' })])))
      .toBe(evaluationFingerprint(input([row])));
  });
});

describe('achievement evidence and progress', () => {
  it('requires positive status and a substantive comment or artifact', () => {
    const positive = evaluateGoal(input([observation('team-a', 'metric-a', 90)]));
    expect(() => validateAchievement(positive, null, [])).toThrow();
    expect(() => validateAchievement(positive, '  ', [])).toThrow();
    expect(() => validateAchievement(positive, 'ок', [])).toThrow();
    expect(() => validateAchievement(positive, 'Проверено по первичной выгрузке', [])).not.toThrow();
    expect(() => validateAchievement(positive, null, ['evidence-demo'])).not.toThrow();
    const negative = evaluateGoal(input([observation('team-a', 'metric-a', 0)]));
    expect(() => validateAchievement(negative, 'Проверено по первичной выгрузке', [])).toThrow();
  });

  it('does not invent a baseline for scalar progress and handles hold targets', () => {
    expect(goalProgress(85, 100, null, 'increase', '%')).toBe(85);
    expect(goalProgress(85, 100, null, 'increase', 'шт.')).toBeNull();
    expect(goalProgress(5, 10, null, 'decrease', '%')).toBeNull();
    expect(goalProgress(100, 100, 100, 'increase', '%')).toBe(100);
    expect(goalProgress(99, 100, 100, 'increase', '%')).toBe(0);
    expect(goalProgress(110, 100, 0, 'increase', '%')).toBeCloseTo(110);
  });
});
