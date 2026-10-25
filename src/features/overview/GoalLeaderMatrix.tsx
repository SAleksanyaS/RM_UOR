import { ArrowUpRight, ChevronDown, ChevronRight, CircleCheck, Clock3, Minus, TriangleAlert } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { categories, formatValue, statusPresentation, type GoalStatus, type OverviewModel } from './overview-model';
import '../preferences/matrix-preferences.css';

export function StatusBadge({ status, compact = false }: { status: GoalStatus; compact?: boolean }) {
  const presentation = statusPresentation(status);
  const Icon = status === 'confirmed' ? CircleCheck : status === 'pending' ? Clock3 : status === 'not_met' ? TriangleAlert : Minus;
  return <span className={`status-badge ${presentation.tone}`}><Icon size={12} strokeWidth={2} /><span>{compact ? presentation.short : presentation.label}</span></span>;
}
const GOALS_PER_PAGE = 50, LEADERS_PER_PAGE = 16;
export function GoalLeaderMatrix({ model, density, hiddenLeaderIds = [], onGoal, onLeader }: { model: OverviewModel; density: 'compact' | 'comfortable'; hiddenLeaderIds?: string[]; onGoal: (goalId: string, leaderId?: string) => void; onLeader: (leaderId: string) => void }) {
  const [collapsed, setCollapsed] = useState<string[]>([]), [goalPage, setGoalPage] = useState(0), [leaderPage, setLeaderPage] = useState(0);
  const ordered = useMemo(() => model.groups.flatMap(group => group.rows), [model.groups]);
  const eligibleLeaders = model.leaders.filter(leader => !hiddenLeaderIds.includes(leader.id));
  const goalSignature = ordered.map(row => row.goal.id).join('\u0000'), leaderSignature = eligibleLeaders.map(leader => leader.id).join('\u0000');
  useEffect(() => { setGoalPage(0); }, [goalSignature]);
  useEffect(() => { setLeaderPage(0); }, [leaderSignature]);
  const goalPages = Math.max(1, Math.ceil(ordered.length / GOALS_PER_PAGE)), leaderPages = Math.max(1, Math.ceil(eligibleLeaders.length / LEADERS_PER_PAGE));
  const currentGoalPage = Math.min(goalPage, goalPages - 1), currentLeaderPage = Math.min(leaderPage, leaderPages - 1);
  const start = currentGoalPage * GOALS_PER_PAGE, leaderStart = currentLeaderPage * LEADERS_PER_PAGE;
  const rows = ordered.slice(start, start + GOALS_PER_PAGE), leaders = eligibleLeaders.slice(leaderStart, leaderStart + LEADERS_PER_PAGE);
  const rowIds = new Set(rows.map(row => row.goal.id)), leaderIds = new Set(leaders.map(leader => leader.id));
  const displayedRows = rows.filter(row => !collapsed.includes(row.goal.category)), displayedAssignments = displayedRows.flatMap(row => row.cells).filter(cell => leaderIds.has(cell.leader.id)).length;
  const headerCounts = new Map(leaders.map(leader => [leader.id, displayedRows.filter(row => row.cells.some(cell => cell.leader.id === leader.id)).length]));
  const groups = model.groups.map(group => ({ ...group, rows: group.rows.filter(row => rowIds.has(row.goal.id)) })).filter(group => group.rows.length);
  return <div className="matrix-paged">
    <div className="matrix-paging-bar">
      <nav aria-label="Страницы целей"><span aria-live="polite">{ordered.length ? `Цели ${start + 1}–${start + rows.length} из ${ordered.length}` : 'Целей в фильтре нет'}</span>{goalPages > 1 && <div><button type="button" aria-label="Предыдущие цели" disabled={currentGoalPage === 0} onClick={() => setGoalPage(currentGoalPage - 1)}>Назад</button><span>{currentGoalPage + 1} / {goalPages}</span><button type="button" aria-label="Следующие цели" disabled={currentGoalPage + 1 >= goalPages} onClick={() => setGoalPage(currentGoalPage + 1)}>Далее</button></div>}</nav>
      <nav aria-label="Страницы столбцов ИТ-лидеров"><span aria-live="polite">{eligibleLeaders.length ? `Столбцы ИТ-лидеров ${leaderStart + 1}–${leaderStart + leaders.length} из ${eligibleLeaders.length}` : 'Столбцы ИТ-лидеров скрыты или отсутствуют'}</span>{leaderPages > 1 && <div><button type="button" aria-label="Предыдущие ИТ-лидеры" disabled={currentLeaderPage === 0} onClick={() => setLeaderPage(currentLeaderPage - 1)}>Назад</button><span>{currentLeaderPage + 1} / {leaderPages}</span><button type="button" aria-label="Следующие ИТ-лидеры" disabled={currentLeaderPage + 1 >= leaderPages} onClick={() => setLeaderPage(currentLeaderPage + 1)}>Далее</button></div>}</nav>
    </div>
    <p className="matrix-shown-scope">Назначений в фильтре: {model.totals.assignments}. В показанных строках и столбцах: {displayedAssignments}. Развёрнуто целей на странице: {displayedRows.length} из {rows.length}. Скрыто столбцов в фильтре: {model.leaders.length - eligibleLeaders.length}.</p>
    <div className={`matrix-wrap ${density}`}>
      <table className="goal-matrix" aria-label="Матрица целей и ИТ-лидеров" style={{ minWidth: Math.max(leaders.length ? 850 : 350, 290 + leaders.length * 150) }}>
        <thead><tr><th className="goal-heading" scope="col">Цель технологической повестки <span title="Целей на странице">{rows.length}</span></th>{leaders.map(leader => <th key={leader.id} scope="col"><button className="leader-column" onClick={() => onLeader(leader.id)}><span className="mini-avatar">{leader.name.slice(0, 1)}</span><span>{leader.name}<small>{headerCounts.get(leader.id)} назначений на странице</small></span><ArrowUpRight size={13}/></button></th>)}</tr></thead>
        <tbody>{groups.map(group => <Fragment key={group.category}>
          <tr className="group-row"><td colSpan={leaders.length + 1}><button aria-expanded={!collapsed.includes(group.category)} onClick={() => setCollapsed(current => current.includes(group.category) ? current.filter(item => item !== group.category) : [...current, group.category])}>{collapsed.includes(group.category) ? <ChevronRight size={15}/> : <ChevronDown size={15}/>}<i style={{ background: categories[group.category].color }}/>{group.label}<span title="Целей на странице">{group.rows.length}</span></button></td></tr>
          {!collapsed.includes(group.category) && group.rows.map(row => <tr key={row.goal.id}>
            <td className="matrix-goal"><button onClick={() => onGoal(row.goal.id)}><span className="goal-code">{row.goal.id}</span><strong>{row.goal.title}</strong><span className="goal-target">{row.goal.target || row.goal.metric || 'Показатель уточняется'}</span></button></td>
            {leaders.map(leader => { const cell = row.cells.find(item => item.leader.id === leader.id); return <td key={leader.id}>{cell ? <button className={`matrix-cell ${cell.status}`} onClick={() => onGoal(row.goal.id, leader.id)} title={`Открыть: ${row.goal.title} · ${leader.name}`}><div className="cell-numbers"><strong>{formatValue(cell.evaluation?.actual, row.goal.unit)}</strong>{cell.evaluation?.officialTarget !== null && cell.evaluation?.officialTarget !== undefined && <span>/ {formatValue(cell.evaluation.officialTarget, row.goal.unit)}</span>}</div>{cell.evaluation?.progress !== null && cell.evaluation?.progress !== undefined && <div className="micro-progress"><i style={{ width: `${Math.min(100, Math.max(0, cell.evaluation.progress))}%` }}/></div>}<StatusBadge status={cell.status} compact />{cell.stale && <small className="stale-label">Данные устарели</small>}</button> : <span className="not-assigned" title="Цель не назначена">—</span>}</td>; })}
          </tr>)}
        </Fragment>)}</tbody>
      </table>
      {model.goals.length === 0 && <div className="empty-state"><strong>В этом срезе нет целей</strong><p>Попробуйте изменить поиск или фильтры.</p></div>}
    </div>
  </div>;
}
