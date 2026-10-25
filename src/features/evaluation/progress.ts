import type { Goal } from '../../domain/contracts';
const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
/** Progress requires a meaningful baseline; percentage shares may explicitly use zero. */
export function goalProgress(actual: number | null, target: number | null, baseline: number | null,
  direction: Goal['direction'], unit = ''): number | null {
  if (!finite(actual) || !finite(target)) return null;
  if (baseline === null) {
    if (direction === 'increase' && ['%', 'percent', 'percentage'].includes(unit.toLowerCase()) && target > 0)
      return Math.max(0, actual / target * 100);
    return null;
  }
  if (!finite(baseline)) return null;
  if (baseline === target) return (direction === 'increase' ? actual >= target : actual <= target) ? 100 : 0;
  return Math.max(0, (actual - baseline) / (target - baseline) * 100);
}
