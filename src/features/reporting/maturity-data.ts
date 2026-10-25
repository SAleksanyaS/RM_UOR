import { createHash } from 'node:crypto';
import type { CatalogSnapshot, Goal, LocalSnapshot, Observation } from '../../domain/contracts';
import { ActionError } from '../identity/role-service';
import { normalizeObservations, metricKey } from '../evaluation/normalize';
import { selectFacts, snapshotFreshness } from '../snapshots/select-facts';
import { historicalRules } from './evaluation-basis';
import type { ReportSnapshot } from './report-contracts';
import type { MaturityReportData, MaturityPoint, MaturityStats, MaturityTeam } from './maturity-contracts';
import type { MaturityPreset } from '../report-templates/contracts';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ratio = (met: number, total: number) => total ? met / total * 100 : null;
export function maturityStats(teams: MaturityTeam[]): MaturityStats { const applicable = teams.filter(t => t.state !== 'excluded'), metrics = teams.flatMap(t => t.metrics), available = metrics.filter(m => m.state !== 'excluded'), known = available.filter(m => m.state !== 'unknown'); return { teamsMet: teams.filter(t => t.state === 'met').length, teamsEligible: applicable.length, teamsUnknown: teams.filter(t => t.state === 'unknown').length, teamsExcluded: teams.filter(t => t.state === 'excluded').length, metricsMet: metrics.filter(m => m.state === 'met').length, metricsEligible: available.length, metricsUnknown: available.length - known.length, metricsExcluded: metrics.length - available.length, teamShare: ratio(teams.filter(t => t.state === 'met').length, applicable.length), metricShare: ratio(metrics.filter(m => m.state === 'met').length, available.length) }; }
function point(catalog: CatalogSnapshot, snapshots: LocalSnapshot[], goal: Goal, period: string, metricIds: string[], now: string): MaturityPoint | null {
    const relevant = snapshots.filter(s => s.classification === catalog.classification && s.period === period && s.observations.some(o => o.goalId === goal.id));
    const selected = [...new Set(relevant.map(s => s.sourceId))].flatMap(sourceId => { const candidates = relevant.filter(s => s.sourceId === sourceId), source = catalog.sources.find(s => s.id === sourceId); const chosen = selectFacts({ mode: 'auto', goalId: goal.id, period, sourceId, personal: candidates.filter(s => s.status === 'personal'), published: candidates.filter(s => s.status === 'validated'), freshnessHours: source?.freshnessHours, now }).snapshot; return chosen ? [chosen] : []; });
    if (!selected.length)
        return null;
    const bases = selected.map(s => s.evaluationBasis), captured = bases.every(b => b?.goal.id === goal.id), historical = !!captured;
    const effectiveGoal = historical ? bases[0]!.goal : goal, assignments = (historical ? bases[0]!.assignments : catalog.assignments.filter(a => a.goalId === goal.id)).filter(a => a.active !== false);
    if (historical && bases.some(b => hash(historicalRules(b!.goal, b!.assignments)) !== hash(historicalRules(effectiveGoal, assignments))))
        throw new ActionError('Исторические методики источников различаются. Выберите согласованный снимок перед экспортом.', 400);
    if (effectiveGoal.measurement && effectiveGoal.measurement.kind !== 'participant_share')
        throw new ActionError('Шаблон модели зрелости поддерживает долю команд по всем метрикам. Для другой методики выберите общий шаблон.', 400);
    const declared = effectiveGoal.measurement?.metrics.map(m => m.id) ?? effectiveGoal.requiredMetricIds;
    if (!declared?.length || new Set(declared).size !== metricIds.length || declared.some(id => !metricIds.includes(id)))
        throw new ActionError('Для шаблона зрелости явно задайте полный состав показателей цели (от1 до5). Выбранные метрики должны совпадать с методикой.', 400);
    if (!assignments.length || assignments.some(a => a.participantIds === undefined))
        throw new ActionError('Для шаблона зрелости задайте участников в назначениях. Состав не выводится из полученных строк.', 400);
    const expected = [...new Set(assignments.flatMap(a => a.participantIds!))];
    const raw = selected.flatMap(s => s.observations).filter(o => o.goalId === goal.id);
    const normalized = normalizeObservations({ goal: effectiveGoal, observations: raw, period, expectedParticipants: expected, expectedMetricIds: metricIds });
    const conflicts = new Set(normalized.conflicts.map(c => c.key));
    const teams = expected.map(id => {
        const owner = assignments.filter(a => a.participantIds!.includes(id));
        if (new Set(owner.map(a => a.leaderId)).size > 1)
            throw new ActionError('Одна команда назначена нескольким ИТ-лидерам. Уточните контур отчёта.', 400);
        const sourceRows = raw.filter(o => o.participantId === id), name = sourceRows[0]?.participantName ?? (historical ? bases[0]!.organization?.entities : catalog.entities)?.find(e => e.id === id)?.name ?? id;
        const metrics = metricIds.map(metricId => {
            const row = normalized.observations.find(o => o.participantId === id && o.metricId === metricId)!;
            const declaredMetric = effectiveGoal.measurement?.metrics.find(m => m.id === metricId), direction = declaredMetric?.direction ?? effectiveGoal.direction;
            const target = declaredMetric?.target ?? row.target;
            const state: MaturityTeam['state'] = (row.state === 'exception' || row.state === 'no_events') && (!effectiveGoal.measurement || !!row.reason?.trim()) ? 'excluded' : row.state !== 'numeric' || row.value === null || target === null || conflicts.has(metricKey(row)) ? 'unknown' : (direction === 'increase' ? row.value >= target : row.value <= target) ? 'met' : 'not_met';
            return { id: metricId, name: sourceRows.find(o => o.metricId === metricId)?.metricName ?? declaredMetric?.name ?? metricId, value: row.value, target, unit: declaredMetric?.unit ?? row.unit, state, reason: conflicts.has(metricKey(row)) ? 'Конфликт фактов одного периода' : row.reason };
        });
        const state: MaturityTeam['state'] = metrics.every(m => m.state === 'excluded') ? 'excluded' : metrics.some(m => m.state === 'not_met') ? 'not_met' : metrics.some(m => m.state === 'unknown') ? 'unknown' : 'met';
        const team = { id, name, leaderId: owner[0]?.leaderId ?? null, metrics, state, stats: null as unknown as MaturityStats };
        team.stats = maturityStats([{ ...team, stats: {} as MaturityStats }]);
        return team;
    });
    const metrics = metricIds.map(id => { const values = teams.flatMap(t => t.metrics.filter(m => m.id === id)), available = values.filter(m => m.state !== 'excluded'), met = values.filter(m => m.state === 'met').length; return { id, name: values[0]?.name ?? id, met, available: available.length, unknown: values.filter(m => m.state === 'unknown').length, excluded: values.length - available.length, share: ratio(met, available.length), unmetTeams: teams.filter(t => t.metrics.some(m => m.id === id && m.state === 'not_met')).map(t => t.name) }; });
    const sourceIds = selected.map(s => s.sourceId).sort();
    return { period, summary: maturityStats(teams), teams, metrics, sourceText: sourceIds.join(', '), sourceUpdatedAt: selected.map(s => s.sourceUpdatedAt).filter((d): d is string => !!d).sort()[0] ?? null, stale: selected.some(s => snapshotFreshness(s, catalog.sources.find(source => source.id === s.sourceId)?.freshnessHours, now).isStale), historicalBasis: historical ? 'captured' : 'legacy', cohortKey: hash({ rules: historicalRules(effectiveGoal, assignments), metricIds: [...metricIds].sort(), sources: sourceIds, targets: normalized.observations.map(o => [o.participantId, o.metricId, o.target, o.unit]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }) };
}
export function buildMaturityReport(catalog: CatalogSnapshot, snapshots: LocalSnapshot[], report: ReportSnapshot, preset: MaturityPreset): MaturityReportData {
    const goal = catalog.goals.find(g => g.id === preset.goalId);
    if (!goal || !report.selection.goalIds.includes(goal.id))
        throw new ActionError('Включите настроенную цель модели зрелости в состав отчёта', 400);
    if (report.selection.goalIds.some(id => id !== goal.id && id !== preset.separateGoalId))
        throw new ActionError('Шаблон зрелости включает одну основную и одну отдельную цель. Для общего портфеля выберите встроенный шаблон.', 400);
    const current = point(catalog, snapshots, goal, report.selection.period, preset.metricIds, report.createdAt);
    if (!current)
        throw new ActionError('За выбранный период нет фактов модели зрелости. Выберите период загруженного снимка.', 400);
    let baseline:MaturityPoint|null=null,baselineIssue='';
    if(report.selection.baselinePeriod)try{baseline=point(catalog,snapshots,goal,report.selection.baselinePeriod,preset.metricIds,report.createdAt);}catch(error){if(!(error instanceof ActionError))throw error;baselineIssue=error.message;}
    const comparable = !!baseline && baseline.historicalBasis === 'captured' && current.historicalBasis === 'captured' && baseline.cohortKey === current.cohortKey && !!report.comparison?.rows.find(row=>row.goalId===goal.id&&row.leaderId===null)?.comparable;
    const order = [...preset.leaderOrder, ...report.selection.leaderIds.filter(id => !preset.leaderOrder.includes(id))];
    const selected = order.filter(id => report.selection.leaderIds.includes(id) && current.teams.some(t => t.leaderId === id));
    const row = report.rows.find(r => r.goalId === goal.id && r.leaderId === null)!;
    // Reuse the canonical goal result, including null for an incomplete modern method.
    current.summary.teamShare=row.evaluation.actual;
    for(const [key,actual] of [['eligibleParticipants',current.summary.teamsEligible],['metParticipants',current.summary.teamsMet],['eligibleMetrics',current.summary.metricsEligible],['metMetrics',current.summary.metricsMet]] as const)if(row.evaluation[key]!==actual)throw new ActionError('Детализация шаблона не совпала с основным расчётом. Проверьте состав, идентификаторы ИТ-лидеров и показатели источника.',400);
    const separateGoal = preset.separateGoalId ? catalog.goals.find(g => g.id === preset.separateGoalId) : null;
    const separateIds = separateGoal?.measurement?.metrics.map(m => m.id) ?? separateGoal?.requiredMetricIds ?? [];
    const separatePoint = separateGoal && separateIds.length ? point(catalog, snapshots, separateGoal, report.selection.period, separateIds, report.createdAt) : null;
    const separateTargets = [...new Set(separatePoint?.teams.flatMap(t => t.metrics.filter(m => m.state !== 'excluded' && m.target !== null).map(m => m.target!)) ?? [])];
    const limits = [...report.limitations,...(baselineIssue?[`Базовый период: ${baselineIssue}`]:[]), ...(current.historicalBasis === 'legacy' ? ['Историческая методика не сохранена: расчёт по текущим определениям; имена ИТ-лидеров из текущего справочника.'] : []), ...(!comparable ? ['Сопоставимый базовый период отсутствует: изменения и прошлые значения не придуманы.'] : []), ...(!separatePoint ? ['Отдельные факты GigaCode не загружены; значения исходного образца удалены.'] : [])];
    return { schemaVersion: 1, goalId: goal.id, goalTitle: goal.title, officialTarget: row.evaluation.officialTarget, officialStatus: row.evaluation.official, validation: row.evaluation.validation, metricIds: preset.metricIds, current, baseline, comparable, comparisonReason: comparable ? 'Совпадают сохранённые правила, состав, источники и пороги' : !baseline ? 'Базовый снимок не выбран или отсутствует' : current.historicalBasis === 'legacy' || baseline.historicalBasis === 'legacy' ? 'Историческая основа отсутствует; сравнение запрещено' : 'Изменились правила, состав, источники или пороги', leaders: selected.map(id => { const teams = current.teams.filter(t => t.leaderId === id), previousTeams = baseline?.teams.filter(t => t.leaderId === id) ?? []; return { id, name: report.rows.find(r => r.goalId === goal.id && r.leaderId === id)?.leaderName ?? catalog.leaders.find(l => l.id === id)?.name ?? id, current: maturityStats(teams), baseline: baseline ? maturityStats(previousTeams) : null, teams, previousTeams }; }), separate: { goalId: separateGoal?.id ?? null, title: separateGoal?.title ?? 'GigaCode — ежедневное использование', target: separateTargets.length === 1 ? separateTargets[0] : null, point: separatePoint }, limitations: [...new Set(limits)] };
}
