import type { Goal } from '../../domain/contracts';
const number = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
export function formatGoalActual(goal: Goal, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Нет данных';
  if (goal.measurement?.kind === 'binary' && (value === 0 || value === 1)) return value === 1 ? 'Да' : 'Нет';
  return `${number(value)}${goal.unit === '%' ? '%' : goal.unit ? ` ${goal.unit}` : ''}`;
}
export function formatGoalTarget(goal: Goal, contour: 'official' | 'internal' = 'official'): string {
  if (contour === 'official' && goal.measurement?.kind === 'range' && goal.measurement.range)
    return `${number(goal.measurement.range.min)}–${number(goal.measurement.range.max)}${goal.unit ? ` ${goal.unit}` : ''}`;
  const value = contour === 'official' ? goal.officialTarget : goal.internalTarget;
  return value == null ? 'Не задано' : formatGoalActual(goal, value);
}
