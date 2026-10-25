import { useEffect, useState } from 'react';
import { useWorkspace } from '../../app/AppContext';
import { formatPlanDate } from '../planning/ExecutionPlanPanel';
import { buildDirectorModel, type DeadlineItem } from './director-model';
import type { DecisionEntity } from './decision-schema';
import './director.css';

type DecisionForm = { name: string; goalId: string; owner: string; dueDate: string; state: 'open' | 'closed'; closureComment: string };
const blank = (): DecisionForm => ({ name: '', goalId: '', owner: '', dueDate: '', state: 'open', closureComment: '' });
const readable = (value: unknown) => value === null || value === undefined ? 'Не задано' : typeof value === 'string' ? value : JSON.stringify(value);
export function DirectorPage({ onGoal }: { onGoal?: (goalId: string, leaderId?: string | null) => void }) {
  const { state, mutate, notify } = useWorkspace();
  const [model, setModel] = useState<ReturnType<typeof buildDirectorModel> | null>(null), [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false), [original, setOriginal] = useState<DecisionEntity | null>(null), [form, setForm] = useState<DecisionForm>(blank);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [showClosed, setShowClosed] = useState(false);
  useEffect(() => { let active = true; void fetch('/api/director').then(async response => { if (!response.ok) throw new Error('Не удалось прочитать журнал и сроки'); return response.json(); }).then(data => { if (active) { setModel(data); setLoadError(''); } }).catch(failure => { if (active) setLoadError((failure as Error).message); }); return () => { active = false; }; }, [state.catalog, state.changes]);
  const canEdit = state.session.role === 'curator';
  function begin(decision?: DecisionEntity) {
    setOriginal(decision ?? null); setError(''); setEditing(true);
    setForm(decision ? { name: decision.name, goalId: decision.goalId ?? '', owner: decision.owner, dueDate: decision.dueDate ?? '', state: decision.state, closureComment: decision.closureComment } : blank());
  }
  function change<K extends keyof DecisionForm>(key: K, value: DecisionForm[K]) { setForm(current => ({ ...current, [key]: value })); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy || !canEdit) return; setBusy(true); setError('');
    try {
      await mutate('/api/director/decisions', { ...(original ? { id: original.id } : {}), baseRevision: original?.revision ?? null, decision: { ...form, goalId: form.goalId || null, dueDate: form.dueDate || null } });
      setEditing(false); notify('Решение сохранено локально. Отправьте черновик через публикацию.');
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  function goalLink(id: string, title: string, leaderId?: string | null) { return onGoal ? <button className="director-goal-link" onClick={() => onGoal(id, leaderId)}>{title}</button> : <strong>{title}</strong>; }
  function deadline(item: DeadlineItem) { return <article key={item.id} className={`director-deadline ${item.overdue ? 'is-overdue' : ''}`}><div className="director-date"><strong>{formatPlanDate(item.date)}</strong><span>{item.label}</span></div><div>{goalLink(item.goalId, item.goalTitle, item.leaderId)}<p>{item.scopeName}</p>{item.kind !== 'official' && <small>Официальный срок: {formatPlanDate(item.officialDate)}</small>}{item.nextAction && <p className="director-next-action">{item.nextAction}</p>}</div></article>; }
  return <div className="director-page"><header><h1>Повестка директора</h1><p>Ближайшие обязательства, решения и фактические изменения за неделю.</p></header>
    {loadError && <p role="alert" className="director-error">{loadError}</p>}{!model && !loadError && <p>Загрузка повестки…</p>}
    {model && <><section className="director-section"><header><div><h2>Ближайшие 30 дней</h2><p>{formatPlanDate(model.today)} — {formatPlanDate(model.until)}. Обязательства и прогнозы взяты из объявленных планов.</p></div></header>
      {model.upcoming.length ? <div className="director-timeline">{model.upcoming.map(deadline)}</div> : <p className="director-empty">На ближайшие 30 дней сроки не заданы.</p>}
      {model.overdue.length > 0 && <details className="director-overdue"><summary>Прошедшие даты: {model.overdue.length}</summary><p>Прошедшая дата сама по себе не определяет факт выполнения цели.</p>{model.overdue.map(deadline)}</details>}
    </section>
    <section className="director-section"><header><div><h2>Реестр решений</h2><p>Ответственный, срок и основание закрытия. Общий обмен — через публикацию каталога.</p></div>{canEdit && <button className="button primary" onClick={() => begin()}>Новое решение</button>}</header>
      {editing && canEdit && <form className="director-decision-form" onSubmit={event => void save(event)}><fieldset disabled={busy}><legend>{original ? 'Изменение решения' : 'Новое решение'}</legend><label>Решение<textarea rows={3} required maxLength={500} value={form.name} onChange={event => change('name', event.target.value)}/></label><div className="director-form-grid"><label>Ответственный<input required maxLength={500} value={form.owner} onChange={event => change('owner', event.target.value)}/></label><label>Срок<input type="date" value={form.dueDate} onChange={event => change('dueDate', event.target.value)}/></label><label>Связанная цель<select value={form.goalId} onChange={event => change('goalId', event.target.value)}><option value="">Без привязки</option>{state.catalog.goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label><label>Состояние<select value={form.state} onChange={event => change('state', event.target.value as 'open' | 'closed')}><option value="open">Открыто</option><option value="closed">Закрыто</option></select></label></div><label>Основание закрытия<textarea rows={2} required={form.state === 'closed'} maxLength={5000} value={form.closureComment} onChange={event => change('closureComment', event.target.value)}/></label></fieldset>{error && <p role="alert" className="director-error">{error} Введённые данные остаются в форме.</p>}<div className="director-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => setEditing(false)}>Отмена</button><button className="button primary" type="submit" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить решение'}</button></div></form>}
      <label className="director-show-closed"><input type="checkbox" checked={showClosed} onChange={event => setShowClosed(event.target.checked)}/>Показать закрытые</label>
      {model.decisions.filter(item => showClosed || item.state === 'open').map(item => <article className={`director-decision ${item.state === 'closed' ? 'is-closed' : ''}`} key={item.id}><div><span className="director-decision-state">{item.state === 'open' ? 'Открыто' : 'Закрыто'}</span><h3>{item.name}</h3><p>Ответственный: {item.owner}. Срок: {formatPlanDate(item.dueDate)}</p>{item.goalId && goalLink(item.goalId, state.catalog.goals.find(goal => goal.id === item.goalId)?.title ?? 'Цель не найдена')}{item.closureComment && <p>Основание закрытия: {item.closureComment}</p>}<small>{item.updatedBy} · {new Date(item.updatedAt).toLocaleString('ru-RU')}</small></div>{canEdit && <button className="button secondary" onClick={() => begin(item)}>Изменить</button>}</article>)}
      {!model.decisions.some(item => showClosed || item.state === 'open') && <p className="director-empty">Решений в выбранном состоянии нет.</p>}{model.invalidDecisions > 0 && <p role="alert">Некорректных записей решений: {model.invalidDecisions}. Проверьте каталог.</p>}
      {model.requests.length > 0 && <details><summary>Запросы из планов: {model.requests.length}</summary><p>Это исходные запросы из планов. Они не становятся решениями автоматически.</p>{model.requests.map((item, index) => <article className="director-plan-request" key={`${item.goalId}:${item.leaderId}:${index}`}>{goalLink(item.goalId, item.goalTitle, item.leaderId)}<small>{item.scopeName}</small><p>{item.text}</p>{canEdit && <button className="button secondary" onClick={() => { begin(); setForm({ ...blank(), name: item.text, goalId: item.goalId }); }}>Добавить в реестр</button>}</article>)}</details>}
    </section>
    <section className="director-section"><header><div><h2>Что изменилось за неделю</h2><p>С {new Date(model.digest.from).toLocaleString('ru-RU')} включительно до {new Date(model.digest.to).toLocaleString('ru-RU')}. Показаны реальные записи полного журнала.</p></div></header><p className="director-digest-note">События описывают записанные изменения. Отсутствие события не доказывает отсутствие изменений во внешних источниках.</p>
      {model.digest.events.length ? model.digest.events.map(event => <details key={event.id} className="director-change"><summary><strong>{event.objectLabel}</strong><span>{event.actor} · {new Date(event.at).toLocaleString('ru-RU')}</span></summary><dl>{event.fields.map((field, index) => <div key={`${field.field}:${index}`}><dt>{field.field}</dt><dd><span>Было: {readable(field.before)}</span><span>Стало: {readable(field.after)}</span></dd></div>)}</dl></details>) : <p className="director-empty">За этот период в журнале изменений нет.</p>}
    </section></>}
  </div>;
}
