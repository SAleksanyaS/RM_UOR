import type { Assignment, CatalogSnapshot, Category, Evaluation, Goal, Leader, LocalSnapshot } from '../../domain/contracts';
import { getDirections, getGoalDirectionId } from '../catalog/directions';

export type GoalStatus = 'unknown' | 'not_met' | 'pending' | 'confirmed';
export const categories: Record<Category, { label: string; short: string; color: string }> = {
  process: { label: 'Процессы и зрелость', short: 'Процессы', color: '#4268dd' },
  data: { label: 'Данные и аналитика', short: 'Данные', color: '#159d90' },
  architecture: { label: 'Архитектура и технологии', short: 'Архитектура', color: '#8b6cce' },
  security: { label: 'Информационная безопасность', short: 'Безопасность', color: '#cc9140' },
};
export function statusPresentation(status: GoalStatus) {
  return ({ unknown: { label: 'Нет данных', short: 'Нет данных', tone: 'neutral' }, not_met: { label: 'Не выполнено', short: 'Отклонение', tone: 'danger' }, pending: { label: 'На проверке УОР', short: 'На проверке', tone: 'warning' }, confirmed: { label: 'Подтверждено', short: 'Выполнено', tone: 'success' } })[status];
}
export function evaluationStatus(evaluation?: Evaluation, contour: 'official' | 'internal' = 'official'): GoalStatus {
  if (!evaluation || evaluation[contour] === 'unknown') return 'unknown';
  if (evaluation[contour] === 'not_met') return 'not_met';
  return evaluation.validation === 'confirmed' ? 'confirmed' : 'pending';
}
export interface OverviewCell { goal: Goal; leader: Leader; assignment: Assignment; evaluation?: Evaluation; status: GoalStatus; provenance?: LocalSnapshot; stale: boolean }
export interface GoalRow { goal: Goal; cells: OverviewCell[] }
export interface OverviewFilter { search?: string; category?: Category | 'all'; leaderId?: string; status?: GoalStatus | 'all'; contour?: 'official' | 'internal' }
export interface OverviewInput { catalog: CatalogSnapshot; evaluations: Evaluation[]; snapshots: LocalSnapshot[] }
export function selectGoalSnapshot(snapshots: LocalSnapshot[], goalId: string, leaderId?: string | null, period?: string | null, snapshotIds?: string[]) {
  return [...snapshots].filter(snapshot => (snapshotIds === undefined || snapshotIds.includes(snapshot.id)) && (!period || snapshot.period === period) && snapshot.observations.some(observation => observation.goalId === goalId && (!leaderId || observation.leaderId === leaderId))).sort((a, b) => b.collectedAt.localeCompare(a.collectedAt))[0];
}
export function buildOverview(input: OverviewInput, filter: OverviewFilter = {}) {
  const query = filter.search?.trim().toLocaleLowerCase('ru') ?? '';
  const leaderMatches = input.catalog.leaders.filter(leader => leader.name.toLocaleLowerCase('ru').includes(query));
  let leaders = input.catalog.leaders.filter(leader => !filter.leaderId || leader.id === filter.leaderId);
  if (query && leaderMatches.length) leaders = leaders.filter(leader => leaderMatches.some(match => match.id === leader.id));
  const goals: GoalRow[] = input.catalog.goals
    .filter(goal => !filter.category || filter.category === 'all' || goal.category === filter.category)
    .filter(goal => !query || leaderMatches.length > 0 || `${goal.title} ${goal.id} ${goal.summary}`.toLocaleLowerCase('ru').includes(query))
    .map(goal => ({ goal, cells: leaders.flatMap(leader => {
      const assignment = input.catalog.assignments.find(item => item.goalId === goal.id && item.leaderId === leader.id && item.active !== false);
      if (!assignment) return [];
      const evaluation = input.evaluations.find(item => item.goalId === goal.id && item.leaderId === leader.id);
      const status = evaluationStatus(evaluation, filter.contour);
      if (filter.status && filter.status !== 'all' && status !== filter.status) return [];
      const provenance = selectGoalSnapshot(input.snapshots, goal.id, leader.id, evaluation?.period, evaluation?.snapshotIds);
      return [{ goal, leader, assignment, evaluation, status, provenance, stale: evaluation?.qualityFlags.some(flag => /stale|outdated|устар/i.test(flag)) ?? false }];
    }) })).filter(row => row.cells.length > 0);
  leaders = leaders.filter(leader => goals.some(row => row.cells.some(cell => cell.leader.id === leader.id)));
  const cells = goals.flatMap(row => row.cells);
  const totals = { goals: goals.length, assignments: cells.length, confirmed: 0, pending: 0, not_met: 0, unknown: 0 };
  cells.forEach(cell => totals[cell.status]++);
  const groups = (Object.keys(categories) as Category[]).map(category => ({ category, ...categories[category], rows: goals.filter(row => row.goal.category === category) })).filter(group => group.rows.length > 0);
  return { goals, leaders, cells, groups, totals };
}
export type OverviewModel = ReturnType<typeof buildOverview>;
export const statusOrder: GoalStatus[] = ['confirmed', 'not_met', 'pending', 'unknown'];
export const statusColors: Record<GoalStatus, string> = { confirmed: '#13a174', not_met: '#e57867', pending: '#dfb254', unknown: '#dce5e9' };
export function buildExecutiveModel(input: OverviewInput, filter: OverviewFilter = {}) {
  const overview = buildOverview(input, filter);
  const total = overview.totals.assignments;
  const countSegments = (cells: OverviewCell[]) => statusOrder.map(status => ({ status, count: cells.filter(cell => cell.status === status).length, share: cells.length ? cells.filter(cell => cell.status === status).length / cells.length * 100 : 0, color: statusColors[status] }));
  const known = total - overview.totals.unknown;
  const leaders = overview.leaders.map(leader => { const cells = overview.cells.filter(cell => cell.leader.id === leader.id); return { leader, cells, total: cells.length, known: cells.filter(cell => cell.status !== 'unknown').length, deviations: cells.filter(cell => cell.status === 'not_met').length, segments: countSegments(cells) }; });
  const directions = overview.groups.map(group => { const cells = group.rows.flatMap(row => row.cells); return { ...group, total: cells.length, known: cells.filter(cell => cell.status !== 'unknown').length, segments: countSegments(cells) }; });
  const actions = overview.cells.filter(cell => cell.status === 'not_met' || cell.status === 'pending').sort((a, b) => (a.status === 'not_met' ? 0 : 1) - (b.status === 'not_met' ? 0 : 1));
  const focusGoals = overview.goals.filter(row => row.cells.some(cell => cell.evaluation?.actual !== null && cell.evaluation?.actual !== undefined)).map(row => row.goal);
  const focusRows = (goalId: string) => overview.cells.filter(cell => cell.goal.id === goalId).map(cell => ({ leader: cell.leader, evaluation: cell.evaluation?.actual === null ? undefined : cell.evaluation, status: cell.status, stale: cell.stale }));
  return { ...overview, total, known, knownShare: total ? known / total * 100 : 0, segments: countSegments(overview.cells), leaders, directions, actions, focusGoals, focusRows };
}
export function buildDirectionOverview(input: OverviewInput) {
  const goals = [...new Map(input.catalog.goals.map(goal => [goal.id, goal])).values()];
  const overview = buildOverview({ ...input, catalog: { ...input.catalog, goals } });
  const definitions = getDirections(input.catalog);
  const knownIds = new Set(definitions.map(direction => direction.id));
  const directionId = (goal: Goal) => { const id = getGoalDirectionId(goal); return id && knownIds.has(id) ? id : null; };
  const summarize = (selected: Goal[]) => {
    const ids = new Set(selected.map(goal => goal.id));
    const cells = overview.cells.filter(cell => ids.has(cell.goal.id));
    const total = cells.length;
    const known = cells.filter(cell => cell.status !== 'unknown').length;
    const segments = statusOrder.map(status => ({ status, count: cells.filter(cell => cell.status === status).length, share: total ? cells.filter(cell => cell.status === status).length / total * 100 : 0, color: statusColors[status] }));
    return { goals: selected, cells, total, known, coverage: total ? known / total * 100 : null, segments };
  };
  const directions = definitions.map(direction => ({ ...direction, ...summarize(goals.filter(goal => directionId(goal) === direction.id)) }));
  const unassigned = summarize(goals.filter(goal => directionId(goal) === null));
  return { directions, unassigned, total: overview.totals.assignments, goalCount: goals.length };
}
export function sourceDisplayName(source: import('../../domain/contracts').SourceDefinition, catalog: CatalogSnapshot) {
  if (source.kind === 'manual') { const titles = source.goalIds.map(id => catalog.goals.find(goal => goal.id === id)?.title).filter(Boolean); return titles.length ? `Данные куратора: ${titles.join(', ')}` : 'Данные, внесённые куратором'; }
  return source.name.replace(/\b(?:SW|OB|SD|AR|ITZ|IZT|MT)\d+(?:\.\d+)?\b/g, '').replace(/\s*[·:]\s*$/, '').trim() || 'Источник данных';
}
export function buildTeamPracticeRows(observations: import('../../domain/contracts').Observation[], goal: Goal) {
  return [...new Set(observations.map(observation => observation.participantId))].map(id => {
    const facts = observations.filter(observation => observation.participantId === id);
    const numeric = facts.filter(observation => observation.state === 'numeric' && observation.value !== null && observation.target !== null);
    const eligible = numeric.length;
    const met = numeric.filter(observation => goal.direction === 'decrease' ? observation.value! <= observation.target! : observation.value! >= observation.target!).length;
    const excluded = facts.filter(observation => observation.state === 'exception' || observation.state === 'no_events').length;
    const missing = (goal.requiredMetricIds || []).filter(metricId => !facts.some(fact => fact.metricId === metricId && fact.state !== 'missing')).length;
    return { id, name: facts[0].participantName, eligible, met, excluded, missing, share: eligible ? met / eligible * 100 : null };
  }).sort((a, b) => (a.share ?? -1) - (b.share ?? -1) || a.name.localeCompare(b.name, 'ru'));
}
export function formatValue(value: number | null | undefined, unit = '%') { return value === null || value === undefined ? '—' : `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`; }
export function formatDate(value?: string | null, withTime = false) { if (!value) return 'Не указано'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', withTime ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short', year: 'numeric' }); }
