import { expect, it } from 'vitest';
import { buildHistoryChart } from './history-model';

const point = (period: string, actual: number | null, cohortKey = 'same', comparableToPrevious = false) => ({ period, actual, officialTarget: 80, official: 'met' as const, validation: 'pending' as const, eligibleParticipants: 3, metParticipants: 3, coverage: 100, qualityFlags: [], snapshotIds: [], fingerprint: period, cohortKey, comparableToPrevious });
it('draws a real trend only between compatible numeric periods', () => {
  const chart = buildHistoryChart([point('2026-10-01', 70), point('2026-10-08', 90, 'same', true)], '%');
  expect(chart.segments).toHaveLength(1);
  expect(chart.points.map(item => item.actual)).toEqual([70, 90]);
  expect(chart.hasTrend).toBe(true);
});
it('keeps one period, missing values and incompatible cohorts from becoming a continuous trend', () => {
  expect(buildHistoryChart([point('2026-10-01', 70)], '%').hasTrend).toBe(false);
  const chart = buildHistoryChart([point('2026-10-01', 70), point('2026-10-08', 90, 'changed', false), point('2026-10-16', null, 'changed', true)], '%');
  expect(chart.segments).toHaveLength(0);
  expect(chart.points.map(item => item.actual)).toEqual([70, 90]);
  expect(chart.hasIncompatiblePeriods).toBe(true);
});
