import { ArrowUpRight, Building2, Pencil, Plus, Search, UsersRound, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useDialog, useWorkspace } from '../../app/AppContext';
import type { Leader } from '../../domain/contracts';
import type { LeaderInput } from './leader-contracts';
import './cluster-leaders.css';

const goalCountLabel = (count: number) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'цель' : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'цели' : 'целей'}`;
export function ClusterLeadersPage({ onLeader, onGoal }: { onLeader?: (id: string) => void; onGoal?: (id: string) => void }) {
  const { state } = useWorkspace(), [query, setQuery] = useState(''), [editing, setEditing] = useState<Leader | 'new' | null>(null);
  const curator = state.session.role === 'curator';
  const rows = useMemo(() => state.catalog.leaders.map(leader => ({ leader,
    goals: state.catalog.goals.filter(goal => state.catalog.assignments.some(a => a.leaderId === leader.id && a.goalId === goal.id && a.active !== false)) }))
    .filter(({ leader }) => `${leader.name} ${leader.clusterName ?? ''}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))), [state.catalog, query]);
  return <div className="cluster-leaders-page">
    <div className="page-heading"><div><h1>ИТ-лидеры кластеров</h1><p>Люди, кластеры и назначенные цели технологической повестки</p></div>{curator && <button className="button primary" onClick={() => setEditing('new')}><Plus size={17}/>Добавить ИТ-лидера</button>}</div>
    {!curator && <p className="cluster-leaders-footnote">Для добавления и изменения ИТ-лидера выберите «Войти как куратор» в профиле справа вверху.</p>}
    <div className="cluster-leaders-toolbar"><span><UsersRound size={18}/>{state.catalog.leaders.length} ИТ-лидеров</span><label className="cluster-leaders-search"><Search size={17}/><input aria-label="Найти ИТ-лидера или кластер" placeholder="Фамилия или кластер" value={query} onChange={event => setQuery(event.target.value)}/></label></div>
    {rows.length ? <div className="cluster-leaders-table-wrap"><table className="cluster-leaders-table"><thead><tr><th>ИТ-лидер</th><th>Кластер</th><th>Назначенные цели</th>{curator && <th><span className="sr-only">Редактирование</span></th>}</tr></thead><tbody>{rows.map(({ leader, goals }) => <tr key={leader.id}>
      <td>{onLeader ? <button className="cluster-leader-name" onClick={() => onLeader(leader.id)}>{leader.name}<ArrowUpRight size={14}/></button> : <strong>{leader.name}</strong>}</td>
      <td><span className={`cluster-leader-cluster${leader.clusterName ? '' : ' unspecified'}`}><Building2 size={15}/>{leader.clusterName || 'Не указан'}</span></td>
      <td><span className="cluster-leader-count">{goalCountLabel(goals.length)}</span>{goals.length ? <details className="cluster-leader-goals"><summary>Показать цели</summary><div>{goals.map(goal => onGoal ? <button key={goal.id} onClick={() => onGoal(goal.id)}>{goal.title}<ArrowUpRight size={13}/></button> : <span key={goal.id}>{goal.title}</span>)}</div></details> : <small className="cluster-leader-no-goals">Цели пока не назначены</small>}</td>
      {curator && <td><button className="button secondary" aria-label={`Изменить ИТ-лидера ${leader.name}`} onClick={() => setEditing(leader)}><Pencil size={14}/>Изменить</button></td>}
    </tr>)}</tbody></table></div> : <div className="cluster-leaders-empty"><UsersRound size={30}/><h2>{query ? 'Никого не нашли' : 'Добавьте первого ИТ-лидера'}</h2><p>{query ? 'Попробуйте другую фамилию или название кластера.' : 'Укажите ФИО, кластер и цели, за которые отвечает ИТ-лидер.'}</p></div>}
    <p className="cluster-leaders-footnote">Назначение цели задаёт ответственность. Команды для расчёта и фактические данные настраиваются отдельно в карточке цели.</p>
    {editing && <LeaderEditor leader={editing === 'new' ? null : editing} onClose={() => setEditing(null)}/>}
  </div>;
}
function LeaderEditor({ leader, onClose }: { leader: Leader | null; onClose: () => void }) {
  const { state, mutate, notify } = useWorkspace();
  const [baseLeader] = useState(() => leader ? structuredClone(leader) : null);
  const [baseGoalIds] = useState(() => [...new Set(state.catalog.assignments.filter(a => a.leaderId === leader?.id && a.active !== false).map(a => a.goalId))].sort());
  const [name, setName] = useState(leader?.name ?? ''), [clusterName, setCluster] = useState(leader?.clusterName ?? '');
  const [goalIds, setGoals] = useState(baseGoalIds), [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const close = () => { if (!busy) onClose(); }; useDialog(close);
  const visibleGoals = state.catalog.goals.filter(goal => goal.title.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')));
  async function save() {
    setBusy(true); setError('');
    const input: LeaderInput = { name, clusterName: clusterName.trim() || null, goalIds: [...goalIds].sort(), ...(baseLeader ? { baseLeader, baseGoalIds } : {}) };
    try {
      await mutate(baseLeader ? `/api/leaders/${encodeURIComponent(baseLeader.id)}` : '/api/leaders', input);
      notify('ИТ-лидер и назначения сохранены в черновик. Отправьте изменения в общую версию.'); onClose();
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  return <div className="modal-overlay" onClick={close}><form className="modal cluster-leader-editor" role="dialog" aria-modal="true" aria-label={baseLeader ? 'Изменить ИТ-лидера' : 'Новый ИТ-лидер'} onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); if (!busy) void save(); }}>
    <div className="modal-heading"><div><span className="cluster-leader-editor-eyebrow">Справочник ответственности</span><h2>{baseLeader ? 'Изменить ИТ-лидера' : 'Добавить ИТ-лидера'}</h2></div><button className="icon-button" type="button" disabled={busy} aria-label="Закрыть" onClick={close}><X size={20}/></button></div>
    <fieldset disabled={busy}><label className="field">ФИО ИТ-лидера<input required maxLength={500} autoComplete="name" value={name} onChange={event => setName(event.target.value)}/></label><label className="field">Название кластера<input maxLength={500} placeholder="Можно заполнить позже" value={clusterName} onChange={event => setCluster(event.target.value)}/></label>
      <section className="cluster-leader-goal-picker"><div><h3>Цели ИТ-лидера</h3><span>{goalCountLabel(goalIds.length)} выбрано</span></div><p>Отметьте цели в зоне ответственности. Снятие галочки отключит текущее назначение и сохранит историю.</p><label className="cluster-leaders-search"><Search size={16}/><input aria-label="Найти цель для ИТ-лидера" placeholder="Поиск цели" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <div className="cluster-leader-goal-options">{visibleGoals.length ? visibleGoals.map(goal => <label key={goal.id}><input type="checkbox" checked={goalIds.includes(goal.id)} onChange={event => setGoals(previous => event.target.checked ? [...previous, goal.id] : previous.filter(id => id !== goal.id))}/><span>{goal.title}</span></label>) : <p>Целей по этому запросу нет.</p>}</div>
      </section>
    </fieldset>{error && <div className="error-inline" role="alert">{error}</div>}
    <div className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>Отмена</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? 'Сохраняем…' : 'Сохранить ИТ-лидера'}</button></div>
  </form></div>;
}
