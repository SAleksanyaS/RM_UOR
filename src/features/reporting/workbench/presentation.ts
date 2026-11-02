import {cellProvenance,exactValue,ruleLabel,effectiveStateNames} from '../../evaluation/workbench/effective-matrix';
import type { ReportSnapshot } from './contracts';
const stateNames = { met: 'Выполнено', not_met: 'Ниже порога', missing: 'Нет данных', exception: 'Исключение без основания', no_event: 'Нет события', conflict: 'Конфликт' };
/** Shared semantic rows: every adapter consumes these exact frozen strings, never live data. */
export function reportSections(s: ReportSnapshot) {
    if (s.goalData)
        return goalSections(s);
    const m = s.maturity!, c = m.evaluation.counts;
    return s.definition.sections.map(section => ({ title: section.title, comment: section.comment, rows: section.kind === 'summary' ? [
            ['Показатель', 'Значение', 'Единица'], ['Выполнено / ожидается', `${c.met} / ${c.expected}`, 'метрики'], ['Ниже порога', String(c.notMet), 'метрики'], ['Нет данных', String(c.missing), 'метрики'], ['Исключения', String(c.exception), 'метрики'], ['Нет события', String(c.noEvent), 'метрики'], ['Подтверждение УОР', 'Отсутствует', ''], ['Основание', 'Выбранный источник, не принятые факты', '']
        ] : section.kind === 'matrix' ? [
            ['Команда / код', 'Показатель', 'Значение', 'Единица', 'Порог', 'Статус', 'Происхождение'], ...m.evaluation.slots.map(slot => { const t = m.teams.find(t => t.id === slot.teamId)!, metric = m.metrics.find(v => v.id === slot.metricId)!; return [t.name + ' / ' + t.code, metric.name, slot.value ?? 'Нет значения', '%', slot.target, stateNames[slot.state], slot.source ? JSON.stringify(slot.source) : 'Нет источника']; })
        ] : section.kind === 'comparison' ? [
            ['Период', 'Команды (заявлено)', 'Метрики (заявлено)', 'Основание'], ...m.reportedClaims.map(v => [v.period, `${v.teamsMet} / ${v.teamsAvailable}`, `${v.metricsMet} / ${v.metricsAvailable}`, 'Заявление источника; сопоставимая история не установлена']), ...(!m.reportedClaims.length ? [['Нет заявлений для выбранной области', '', '', '']] : [])
        ] : [['Проверка', 'Основание'], ['Методика', m.definition.policyVersion], ['Полнота', m.evaluation.complete ? 'Полные данные' : 'Неполное основание'], ['УОР', 'Подтверждение не создаётся отчётом'], ...m.limitations.map(v => ['Ограничение', v]), ...m.sources.map(v => ['Источник', `${v.path} · SHA-256 ${v.sha256}`]), ['Снимок', s.digest]] }));
}
export const reportRows = (s: ReportSnapshot) => reportSections(s).flatMap(v => v.rows);
const exact = (v: string | {
    numerator: string;
    denominator: string;
} | null | undefined) => typeof v === 'string' ? v : v ? v.denominator === '1' ? v.numerator : v.numerator + '/' + v.denominator : 'Нет данных';
const condition = (c: {
    op: string;
    target?: string;
    min?: string;
    max?: string;
}) => c.op === 'range' ? c.min + ' … ' + c.max : ({ gte: '≥', lte: '≤', eq: '=' }[c.op] ?? c.op) + ' ' + c.target;
function goalSections(s: ReportSnapshot) {
    const data = s.goalData!;
    return s.definition.sections.map(section => ({ title: section.title, comment: section.comment, rows: section.kind === 'summary' ? [
            ['Цель', 'Область', 'Результат', 'Единица', 'Статус расчёта', 'Качество', 'УОР'], ...data.rows.map(r => [r.goal.title, r.scopeName ?? 'Историческое имя не сохранено', exact(r.numericResult?.scorePercent), r.unit ?? '', r.numericResult ? ({ met: 'Условие выполнено', not_met: 'Условие не выполнено', unknown: 'Не определено', not_applicable: 'Не применимо' }[r.numericResult.achievement]) : r.manualStatus ? ({ not_started: 'Не начата', in_progress: 'В работе', completed: 'Завершена' }[r.manualStatus.to]) : 'Нет данных', r.numericResult?.complete ? 'Полные данные' : 'Неполное основание', r.attestation ? 'Подтверждено: ' + r.attestation.comment : 'Нет подтверждения'])
        ] : section.kind === 'matrix' ? [
            ['Назначение / участник', 'Показатель', 'Действующее значение', 'Единица / правило', 'Состояние', 'Происхождение'], ...(s.effectiveBases?.flatMap(b=>b.cells.map(cell=>{
              const row=data.rows.find(r=>r.assignment.id===b.assignment.id&&r.assignment.revision===b.assignment.revision);
              const name=cell.scope.id===b.assignment.scope.id?row?.scopeName:null;
              return [(name??cell.scope.kind+' '+cell.scope.id)+' · назначение '+b.assignment.id+'/'+b.assignment.revision,cell.metric.name+' · v'+cell.metric.revision,exactValue(cell.selection.value),cell.metric.unit.label+' · '+ruleLabel(cell.rule.condition),effectiveStateNames[cell.state],cellProvenance(cell)+'; методика '+b.method.id+'/'+b.method.revision];
            }))??[]), ...(!s.effectiveBases?.length?[['Действующие значения не сохранены в этой версии', '', '', '', '', 'Исходные факты не подменяют действующие значения']]:[])
        ] : section.kind === 'comparison' ? [
            ['История', 'Состояние'], ['Сопоставимая динамика', 'Не включена: для сравнения требуется отдельная проверка одинаковой методики'], ...data.tabs.history.map(v => [v.recordedAt, exact(v.numericResult?.scorePercent)])
        ] : [['Основание', 'Значение'], ...data.rows.map(r => ['Предупреждения', r.warnings.concat(r.numericResult?.qualityFlags ?? [], r.unavailableReason ? [r.unavailableReason] : []).join('; ') || 'Нет предупреждений']), ...data.tabs.method.flatMap(m => m.mode === 'numeric' ? m.rules.map(r => ['Методика ' + m.id + '/' + m.revision, (s.metrics.find(v => v.id === r.metricRef.id && v.revision === r.metricRef.revision)?.name ?? r.metricRef.id) + ': ' + condition(r.condition) + ' · вес ' + r.originalWeight + ' · ' + ({ increase_ratio_v1: 'Рост к целевому значению', decrease_ratio_capped_v1: 'Снижение с ограничением', zero_counter_v1: 'Нулевой счётчик', binary_condition_v1: 'Выполнение условия' }[r.normalization.kind])]) : [['Методика', m.id + '/' + m.revision + ' · ручной статус']]), ...data.tabs.calculation.map(b => ['Историческая основа', b.id + '/' + b.revision + ' · ' + b.digest + ' · фактов ' + b.factRefs.length]), ['Снимок', s.digest]] }));
}
