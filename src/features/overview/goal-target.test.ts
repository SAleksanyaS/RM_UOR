import { expect, it } from 'vitest';
import type { Goal } from '../../domain/contracts';
import { formatGoalTarget, formatGoalActual } from './goal-target';
it('shows configured interval bounds instead of an absent scalar target', () => {
  const goal = { unit: 'мс', officialTarget: null, internalTarget: null, measurement: { kind: 'range', range: { min: 10, max: 20 } } } as Goal;
  expect(formatGoalTarget(goal)).toBe('10–20 мс'); expect(formatGoalTarget(goal, 'internal')).toBe('Не задано');
});
it('renders binary targets and facts in understandable words', () => {
  const goal = { unit: '', officialTarget: 1, internalTarget: null, measurement: { kind: 'binary' } } as Goal;
  expect(formatGoalTarget(goal)).toBe('Да'); expect(formatGoalActual(goal, 0)).toBe('Нет'); expect(formatGoalActual(goal, null)).toBe('Нет данных');
});
