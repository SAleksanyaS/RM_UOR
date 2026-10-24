import { useMemo, useState } from 'react';
import { AlertCircle, ArrowUpRight, CalendarClock, CirclePause, Clock3, Flag, Search, ShieldQuestion } from 'lucide-react';
import { useWorkspace } from '../../app/AppContext';
import type { WorkStage } from '../../domain/contracts';
import { statusPresentation } from '../overview/overview-model';
import { buildPlanningModel } from './planning-model';
import { WORK_STAGES, WORK_STAGE_LABELS } from './plan-contracts';
import { formatPlanDate, WorkStageBadge } from './ExecutionPlanPanel';
import './planning.css';

type PlanningRow = ReturnType<typeof buildPlanningModel>['rows'][number];
type OpenGoal = (goalId: string, leaderId?: string) => void;
function Decision({ row, onGoal }: { row: PlanningRow; onGoal: OpenGoal }) {
  return <article className="planning-decision-item"><div><span className="planning-scope">{row.leader?.name || 'Общий ДИТ'}</span><button type="button" onClick={() => onGoal(row.goal.id, row.leader?.id)} className="planning-goal-link">{row.goal.title}<ArrowUpRight size={14}/></button><p>{row.plan?.decisionNeeded}</p>{row.plan?.blocker && <details className="planning-blocker"><summary>Что мешает</summary><p>{row.plan.blocker}</p></details>}</div><WorkStageBadge stage={row.stage}/></article>;
}

export function PlanningPage({ onGoal, initialLeaderId = null }: { onGoal: OpenGoal; initialLeaderId?: string | null }) {
  const { state } = useWorkspace();
  const [leaderId, setLeaderId] = useState(initialLeaderId || '');
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<WorkStage | 'all' | 'unplanned'>('all');
  const model = useMemo(() => buildPlanningModel(state, { leaderId: leaderId || undefined }), [state, leaderId]);
  const search = query.trim().toLocaleLowerCase('ru');
  const matching = model.rows.filter(row => (!search || `${row.goal.title} ${row.leader?.name || ''}`.toLocaleLowerCase('ru').includes(search)) && (stage === 'all' || (stage === 'unplanned' ? row.missingPlan : row.stage === stage)));
  const decisions = model.rows.filter(row => row.needsDecision);
  const responsible = (row: PlanningRow) => row.leader?.name
    || state.catalog.entities.find(entity => entity.id === row.goal.ownerId)?.name
    || state.catalog.leaders.find(leader => leader.id === row.goal.ownerId)?.name
    || (row.goal.ownerId ? (/[а-яё]|\p{L}\s+\p{L}/iu.test(row.goal.ownerId) ? row.goal.ownerId : 'Уточнить владельца') : 'Не назначен');
  const counters = [
    { label: 'В работе', value: model.counts.byStage.in_progress, tone: 'progress', icon: Clock3 },
    { label: 'Заблокировано', value: model.counts.byStage.blocked, tone: 'blocked', icon: CirclePause },
    { label: 'Срок прошёл', value: model.counts.overdue, tone: 'overdue', icon: CalendarClock },
    { label: 'Нужно решение', value: model.counts.needsDecision, tone: 'decision', icon: Flag },
  ];
  return <div className="planning-page planning-ui">
    <header className="planning-page-heading"><div><h1>Планы и сроки</h1><p>Ход работ, ближайшие действия и решения, которые нужны командам.</p></div><label className="planning-field planning-leader-select">ИТ-лидер<select value={leaderId} onChange={event => setLeaderId(event.target.value)}><option value="">Общий ДИТ</option>{state.catalog.leaders.map(leader => <option key={leader.id} value={leader.id}>{leader.name}</option>)}</select></label></header>
    <div className="planning-summary" aria-label="Краткая сводка работ">{counters.map(({ label, value, tone, icon: Icon }) => <div className={`planning-summary-item planning-summary--${tone}`} key={label}><Icon size={18}/><div><strong>{value}</strong><span>{label}</span></div></div>)}</div>
    <p className="planning-scope-note">{leaderId ? 'Планы активных назначений выбранного ИТ-лидера.' : 'Общие планы целей ДИТ. Персональные планы — в выборе ИТ-лидера.'}<span>Этап работ не подтверждает результат цели.</span></p>
    <section aria-label="Требуется решение директора" className={`planning-decisions ${decisions.length ? 'has-decisions' : ''}`}>
      <div className="planning-section-heading"><h2><ShieldQuestion size={19}/>Требуется решение директора</h2><span>{decisions.length}</span></div>
      {decisions.length ? <><div className="planning-decision-list">{decisions.slice(0, 3).map(row => <Decision key={row.id} row={row} onGoal={onGoal}/>)}</div>{decisions.length > 3 && <details className="planning-more-decisions"><summary>Ещё решений: {decisions.length - 3}</summary>{decisions.slice(3).map(row => <Decision key={row.id} row={row} onGoal={onGoal}/>)}</details>}</> : <p className="planning-empty-decisions">Запросов на решение пока нет.</p>}
    </section>
    <section className="planning-list-section" aria-label="Список планов">
      <div className="planning-list-heading"><div><h2>Планы по целям</h2><span>{matching.length} из {model.counts.total} · без плана: {model.counts.unplanned}</span></div><div className="planning-filters"><label className="planning-search"><Search size={16}/><span className="sr-only">Поиск по цели</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти цель"/></label><label className="planning-field"><span className="sr-only">Состояние работ</span><select value={stage} onChange={event => setStage(event.target.value as typeof stage)}><option value="all">Все этапы</option><option value="unplanned">План не задан</option>{WORK_STAGES.map(value => <option key={value} value={value}>{WORK_STAGE_LABELS[value]}</option>)}</select></label></div></div>
      {matching.length ? <div className="planning-table-wrap"><table className="planning-table"><thead><tr><th>Цель</th><th>Ход работ</th><th>Ответственный</th><th>Срок</th><th>Прогноз</th><th>Следующий шаг</th></tr></thead><tbody>{matching.map(row => <tr key={row.id}>
        <td data-label="Цель"><button type="button" className="planning-goal-link" onClick={() => onGoal(row.goal.id, row.leader?.id)}>{row.goal.title}</button></td>
        <td data-label="Ход работ"><WorkStageBadge stage={row.stage}/><span className="planning-measured-status">Результат: {statusPresentation(row.measuredStatus).label.toLocaleLowerCase('ru')}</span></td>
        <td data-label="Ответственный"><span className="planning-person">{responsible(row)}</span></td>
        <td data-label="Срок"><strong className={row.deadlineOverdue ? 'planning-date-danger' : ''}>{row.deadline ? formatPlanDate(row.deadline) : 'Срок не задан'}</strong>{row.deadline && <small>{row.plan?.targetDate ? 'Обязательство' : 'Официальный срок'}</small>}{row.plan?.targetDate && row.officialDeadline && row.plan.targetDate !== row.officialDeadline && <small className={row.officialOverdue ? 'planning-date-danger' : ''}>Официальный: {formatPlanDate(row.officialDeadline)}</small>}{row.overdue && <span className="planning-risk"><AlertCircle size={12}/>{row.officialOverdue ? 'Официальный срок прошёл' : 'Срок работ прошёл'}</span>}</td>
        <td data-label="Прогноз"><strong className={row.forecastLate ? 'planning-date-warning' : ''}>{row.forecastDate ? formatPlanDate(row.forecastDate) : 'Прогноз не задан'}</strong>{row.forecastLate && <span className="planning-risk planning-risk--warning">{row.forecastMissesOfficial ? 'Позже официального срока' : 'Позже обязательства'}</span>}{row.plan?.nextCheckDate && <small>Проверка: {formatPlanDate(row.plan.nextCheckDate)}</small>}</td>
        <td data-label="Следующий шаг"><span>{row.plan?.nextAction || 'Шаг не задан'}</span>{row.plan?.blocker && <details className="planning-blocker"><summary>Препятствие</summary><p>{row.plan.blocker}</p></details>}</td>
      </tr>)}</tbody></table></div> : <div className="planning-empty"><CalendarClock size={24}/><p>{model.counts.total ? 'По выбранным условиям планов нет' : 'В этом контуре пока нет активных целей'}</p></div>}
    </section>
  </div>;
}
