import type { Goal, Evaluation } from '../../domain/contracts';
import type { GoalHistoryPoint } from '../history/history-contracts';
import type { ExecutionConfig, Forecast, WorkPackage } from './execution-contracts';
const day = 86400000;
export function assertDependencyGraph(packages: WorkPackage[]) {
  const graph = new Map(packages.map(p => [p.id, p.dependencies]));
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error('Зависимости образуют цикл');
    if (visited.has(id)) return;
    if (!graph.has(id)) throw new Error('Не найдена веха зависимости: ' + id);
    visiting.add(id); for (const target of graph.get(id)!) visit(target); visiting.delete(id); visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
}
export function isCompleted(item: WorkPackage, at = new Date().toISOString()) { return item.events.filter(e => Date.parse(e.at) <= Date.parse(at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1)?.completed ?? false; }
export function workProgress(packages: WorkPackage[]) {
  const total = packages.reduce((sum, p) => sum + p.weight, 0);
  return total > 0 ? packages.filter(p => isCompleted(p)).reduce((sum, p) => sum + p.weight, 0) / total : null;
}
/** Baselines are introduced at their actual creation timestamp. No line precedes that timestamp. */
export function buildBurndown(packages: WorkPackage[], now = new Date().toISOString()) {
  const based = packages.filter(p => p.baseline && Date.parse(p.baseline.at) <= Date.parse(now));
  const dueEnd = (p: WorkPackage) => Date.parse(`${p.baseline!.dueDate}T00:00:00+03:00`) + day;
  const byTime = (a: string, b: string) => Date.parse(a) - Date.parse(b);
  const allTimes = [...new Set(based.flatMap(p => [p.baseline!.at, ...(dueEnd(p) >= Date.parse(p.baseline!.at) ? [new Date(dueEnd(p)).toISOString()] : []), ...p.events.filter(e => Date.parse(e.at) >= Date.parse(p.baseline!.at) && Date.parse(e.at) <= Date.parse(now)).map(e => e.at)]))].sort(byTime);
  const times = allTimes.filter(at => Date.parse(at) <= Date.parse(now));
  if (times.length && Date.parse(now) > Date.parse(times.at(-1)!)) times.push(now);
  const plannedAt = (at: string) => based.filter(p => Date.parse(p.baseline!.at) <= Date.parse(at) && Date.parse(at) < dueEnd(p)).reduce((n, p) => n + p.baseline!.weight, 0);
  const points = times.map(at => ({ at,
    remaining: based.filter(p => Date.parse(p.baseline!.at) <= Date.parse(at) && !isCompleted(p, at)).reduce((n, p) => n + p.baseline!.weight, 0),
    planned: plannedAt(at) }));
  return { points, plannedPoints: [...new Set([...allTimes, ...times])].sort(byTime).map(at => ({ at, planned: plannedAt(at) })), withoutBaseline: packages.length - based.length };
}
/** Ordinary least squares over the final uninterrupted run of comparable periods. */
export function forecastGoal(goal: Goal, points: GoalHistoryPoint[]): Forecast {
  const unavailable = (reason: string, sampleCount = 0): Forecast => ({ date: null, sampleCount, ratePerDay: null, reason, formula: 'Темп b = Σ((день − средний день) × (факт − средний факт)) / Σ((день − средний день)²). Дата = последний период + округление вверх(max(0, (порог − последний факт) / b)) дней.' });
  if (!goal.measurement || !['scalar', 'change'].includes(goal.measurement.kind)) return unavailable('Методика дискретная или не настроена; линейный прогноз неприменим.');
  const run: GoalHistoryPoint[] = [];
  for (const point of [...points].reverse()) {
    if (point.actual === null || !Number.isFinite(point.actual) || point.qualityFlags.length || !/^\d{4}-\d{2}-\d{2}$/.test(point.period) || !Number.isFinite(Date.parse(point.period)) || new Date(point.period).toISOString().slice(0, 10) !== point.period) break;
    if (run.length && (run[0].cohortKey !== point.cohortKey || !run[0].comparableToPrevious)) break;
    run.unshift(point);
  }
  if (run.length < 3) return unavailable('Нужно минимум три сопоставимых реальных числовых периода без разрыва методики, состава и качества.', run.length);
  const target = run.at(-1)!.officialTarget;
  if (target === null || target !== goal.officialTarget || run.some(p => p.officialTarget !== target)) return unavailable('Порог неизвестен или изменился.', run.length);
  const start = Date.parse(run[0].period), xs = run.map(p => (Date.parse(p.period) - start) / day), ys = run.map(p => p.actual!);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const divisor = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  if (!divisor) return unavailable('Нет разных дат наблюдения.', run.length);
  const slope = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / divisor;
  if (!Number.isFinite(slope) || (goal.direction === 'increase' ? slope <= 0 : slope >= 0)) return unavailable('Наблюдаемый темп не направлен к достижению порога.', run.length);
  const remaining = Math.max(0, (target - ys.at(-1)!) / slope), dateValue = Date.parse(run.at(-1)!.period) + Math.ceil(remaining) * day;
  if (!Number.isFinite(dateValue) || dateValue > Date.UTC(9999, 11, 31)) return unavailable('Расчётная дата выходит за допустимый диапазон.', run.length);
  return { ...unavailable('Экстраполяция фактов; не обязательство и не подтверждение результата.', run.length), date: new Date(dateValue).toISOString().slice(0, 10), ratePerDay: slope };
}
export function retentionStatus(config: ExecutionConfig, today = new Date().toISOString().slice(0, 10)) {
  return { status: !config.cadenceDays || !config.nextCheckDate ? 'unconfigured' as const : config.nextCheckDate < today ? 'overdue' as const : config.nextCheckDate === today ? 'pending' as const : 'scheduled' as const, nextCheckDate: config.nextCheckDate };
}
export function weightedAchievement(goals: Goal[], evaluations: Evaluation[]) {
  const weighted = goals.filter(g => typeof g.weight === 'number' && Number.isFinite(g.weight) && g.weight > 0);
  const denominator = weighted.reduce((sum, g) => sum + g.weight!, 0);
  const evaluation = (id: string) => evaluations.find(e => e.goalId === id && e.leaderId === null);
  const confirmedWeight = weighted.filter(g => evaluation(g.id)?.official === 'met' && evaluation(g.id)?.validation === 'confirmed').reduce((sum, g) => sum + g.weight!, 0);
  return { confirmedShare: denominator > 0 ? confirmedWeight / denominator : null, denominator, confirmedWeight, weightedGoals: weighted.length,
    missingWeight: goals.filter(g => g.weight === null || g.weight === undefined || !Number.isFinite(g.weight)).length,
    zeroWeight: goals.filter(g => g.weight === 0).length, unknownWeightedGoals: weighted.filter(g => !evaluation(g.id) || evaluation(g.id)?.official === 'unknown').length };
}
