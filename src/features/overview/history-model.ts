import type { GoalHistoryPoint } from '../history/history-contracts';

export function buildHistoryChart(input: GoalHistoryPoint[], unit: string) {
  const ordered = [...input].sort((a, b) => a.period.localeCompare(b.period));
  const numeric = ordered.filter(point => point.actual !== null && Number.isFinite(point.actual) && Number.isFinite(new Date(point.period).getTime()));
  const values = numeric.flatMap(point => [point.actual!, ...(point.officialTarget !== null ? [point.officialTarget] : [])]);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(unit === '%' ? 100 : 1, ...values);
  const firstTime = numeric.length ? new Date(numeric[0].period).getTime() : 0;
  const lastTime = numeric.length ? new Date(numeric[numeric.length - 1].period).getTime() : 0;
  const y = (value: number) => 159 - (value - minimum) / Math.max(1, maximum - minimum) * 133;
  const points = numeric.map(point => ({ ...point, actual: point.actual!, x: lastTime === firstTime ? 285 : 44 + (new Date(point.period).getTime() - firstTime) / (lastTime - firstTime) * 488, y: y(point.actual!), targetY: point.officialTarget === null ? null : y(point.officialTarget) }));
  const segments: { from: (typeof points)[number]; to: (typeof points)[number] }[] = [];
  let hasIncompatiblePeriods = false;
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]; const current = ordered[index];
    const unsafeRules = [...previous.qualityFlags, ...current.qualityFlags].some(flag => flag === 'historical_rules_unknown' || flag === 'historical_rules_conflict');
    const comparable = current.comparableToPrevious && !!current.cohortKey && current.cohortKey === previous.cohortKey && !unsafeRules;
    if (!comparable) hasIncompatiblePeriods = true;
    const from = points.find(point => point.period === previous.period);
    const to = points.find(point => point.period === current.period);
    if (comparable && from && to && previous.period !== current.period) segments.push({ from, to });
  }
  return { ordered, points, segments, hasTrend: segments.length > 0, hasIncompatiblePeriods, minimum, maximum };
}
