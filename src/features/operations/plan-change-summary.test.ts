import { expect, it } from 'vitest';
import { planChangeSummary } from './plan-change-summary';

it('explains a plan change through work, dates and the next step without exposing internal revision data', () => {
  const text = planChangeSummary({ stage: 'in_progress', targetDate: '2026-11-15', forecastDate: '2026-11-20',
    nextAction: 'Закончить проверку', blocker: '', decisionNeeded: 'Согласовать приоритет', revision: 'private-internal-revision' });
  expect(text).toContain('В работе'); expect(text).toContain('Закончить проверку');
  expect(text).toContain('Согласовать приоритет'); expect(text).toContain('прогноз');
  expect(text).not.toContain('private-internal-revision'); expect(text).not.toContain('targetDate');
});
it('keeps an absent plan distinct from a declared stage', () => {
  expect(planChangeSummary(null)).toBe('План не задан');
  expect(planChangeSummary({ stage: 'planned' })).toContain('Запланировано');
});
