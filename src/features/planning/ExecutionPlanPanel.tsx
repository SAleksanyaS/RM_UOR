import { useId, useState } from 'react';
import { CalendarClock, Pencil, Save } from 'lucide-react';
import { useWorkspace } from '../../app/AppContext';
import type { ExecutionPlan, WorkStage } from '../../domain/contracts';
import { WORK_STAGES, WORK_STAGE_LABELS } from './plan-contracts';
import './planning.css';

export function formatPlanDate(value: string | null | undefined) {
  if (!value) return 'Не задан';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}
export function WorkStageBadge({ stage }: { stage?: WorkStage | null }) {
  return <span className={`work-stage work-stage--${stage || 'unknown'}`}>{stage ? WORK_STAGE_LABELS[stage] : 'План не задан'}</span>;
}
interface PlanForm {
  stage: WorkStage | ''; plannedStartDate: string; targetDate: string; forecastDate: string;
  nextCheckDate: string; nextAction: string; blocker: string; decisionNeeded: string;
}
const fromPlan = (plan?: ExecutionPlan): PlanForm => ({ stage: plan?.stage || '', plannedStartDate: plan?.plannedStartDate || '', targetDate: plan?.targetDate || '', forecastDate: plan?.forecastDate || '', nextCheckDate: plan?.nextCheckDate || '', nextAction: plan?.nextAction || '', blocker: plan?.blocker || '', decisionNeeded: plan?.decisionNeeded || '' });

/** Keyed scope keeps an open form from carrying over to another goal or leader. */
export function ExecutionPlanPanel(props: { goalId: string; leaderId: string | null }) {
  return <PlanScope key={`${props.goalId}:${props.leaderId || 'dit'}`} {...props}/>;
}
function PlanScope({ goalId, leaderId }: { goalId: string; leaderId: string | null }) {
  const { state, mutate, notify } = useWorkspace();
  const headingId = useId();
  const goal = state.catalog.goals.find(item => item.id === goalId);
  const assignment = leaderId ? state.catalog.assignments.find(item => item.goalId === goalId && item.leaderId === leaderId && item.active !== false) : undefined;
  const plan = leaderId ? assignment?.plan : goal?.plan;
  const leader = state.catalog.leaders.find(item => item.id === leaderId);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PlanForm>(() => fromPlan(plan));
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!goal) return null;
  const hasScope = !leaderId || Boolean(assignment);
  const canEdit = state.session.role === 'curator' && hasScope;
  const change = (key: keyof PlanForm, value: string) => setForm(current => ({ ...current, [key]: value }));
  function beginEdit() { setForm(fromPlan(plan)); setBaseRevision(plan?.revision ?? null); setError(''); setEditing(true); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !form.stage || !canEdit) return;
    setBusy(true); setError('');
    try {
      await mutate('/api/plans', { goalId, leaderId, baseRevision, plan: { ...form, plannedStartDate: form.plannedStartDate || null, targetDate: form.targetDate || null, forecastDate: form.forecastDate || null, nextCheckDate: form.nextCheckDate || null } });
      setEditing(false);
      notify('План сохранён локально. Отправьте изменения в разделе публикации.');
    } catch (failure) { setError((failure as Error).message || 'Не удалось сохранить план'); }
    finally { setBusy(false); }
  }
  return <section className="execution-plan planning-ui" aria-labelledby={headingId}>
    <header className="execution-plan-heading"><div><h3 id={headingId}><CalendarClock size={18}/>План работ</h3><p>{leaderId ? leader?.name || 'ИТ-лидер' : 'Общий план ДИТ'}</p></div>{hasScope && <WorkStageBadge stage={plan?.stage}/>}</header>
    <p className="planning-boundary">Этап работ и прогноз не подтверждают измеренный результат цели.</p>
    {!hasScope ? <div className="planning-empty">Нет активного назначения</div> : editing && canEdit ? <form onSubmit={event => void save(event)} className="execution-plan-form">
      <fieldset disabled={busy}><legend className="sr-only">Редактирование плана</legend>
        <div className="planning-official-date"><span>Официальный срок цели</span><strong>{formatPlanDate(goal.dueDate)}</strong></div>
        <label className="planning-field">Этап работ<select value={form.stage} required onChange={event => change('stage', event.target.value)}><option value="" disabled>Выберите этап</option>{WORK_STAGES.map(stage => <option key={stage} value={stage}>{WORK_STAGE_LABELS[stage]}</option>)}</select></label>
        <div className="planning-form-grid">
          <label className="planning-field">Плановое начало<input type="date" value={form.plannedStartDate} onChange={event => change('plannedStartDate', event.target.value)}/></label>
          <label className="planning-field">Обязательство по сроку<input type="date" min={form.plannedStartDate || undefined} value={form.targetDate} onChange={event => change('targetDate', event.target.value)}/></label>
          <label className="planning-field">Прогноз завершения<input type="date" min={form.plannedStartDate || undefined} value={form.forecastDate} onChange={event => change('forecastDate', event.target.value)}/></label>
          <label className="planning-field">Следующая проверка<input type="date" value={form.nextCheckDate} onChange={event => change('nextCheckDate', event.target.value)}/></label>
        </div>
        <label className="planning-field">Следующий шаг<textarea rows={2} maxLength={5000} required={form.stage === 'in_progress' || form.stage === 'blocked'} value={form.nextAction} onChange={event => change('nextAction', event.target.value)} placeholder="Конкретное действие до следующей проверки"/></label>
        <label className="planning-field">Препятствие<textarea rows={2} maxLength={5000} required={form.stage === 'blocked'} value={form.blocker} onChange={event => change('blocker', event.target.value)} placeholder="Что мешает двигаться дальше"/></label>
        <label className="planning-field">Что требуется от директора<textarea rows={2} maxLength={5000} value={form.decisionNeeded} onChange={event => change('decisionNeeded', event.target.value)} placeholder="Какое решение или помощь нужны"/></label>
      </fieldset>
      {error && <div role="alert" className="planning-error"><strong>{error}</strong><span>Введённые значения остаются в форме.</span></div>}
      <div className="planning-form-footer"><span>Общий план и план ИТ-лидера настраиваются отдельно.</span><div><button type="button" className="button secondary" disabled={busy} onClick={() => setEditing(false)}>Отмена</button><button type="submit" className="button primary" disabled={busy || !form.stage}><Save size={14}/>{busy ? 'Сохранение…' : 'Сохранить план'}</button></div></div>
    </form> : <>
      <dl className="execution-plan-dates"><div><dt>Официальный срок</dt><dd>{formatPlanDate(goal.dueDate)}</dd></div><div><dt>Обязательство</dt><dd>{formatPlanDate(plan?.targetDate)}</dd></div><div className="plan-forecast"><dt>Прогноз завершения</dt><dd>{plan?.forecastDate ? formatPlanDate(plan.forecastDate) : 'Прогноз не задан'}</dd></div><div><dt>Следующая проверка</dt><dd>{formatPlanDate(plan?.nextCheckDate)}</dd></div></dl>
      {plan?.plannedStartDate && <p className="planning-start">Плановое начало: {formatPlanDate(plan.plannedStartDate)}</p>}
      {plan?.nextAction && <div className="planning-next-step"><span>Следующий шаг</span><p>{plan.nextAction}</p></div>}
      {plan?.decisionNeeded && <div className="planning-decision"><span>Требуется решение директора</span><p>{plan.decisionNeeded}</p></div>}
      {plan?.blocker && <details className="planning-blocker"><summary>Препятствие</summary><p>{plan.blocker}</p></details>}
      <div className="execution-plan-footer"><span>{plan ? `Обновил(а): ${plan.updatedBy} · ${formatPlanDate(plan.updatedAt)}` : 'Планирование пока не заполнено'}</span>{canEdit && <button type="button" className="planning-edit-button" onClick={beginEdit}><Pencil size={14}/>{plan ? 'Изменить план' : 'Настроить план'}</button>}</div>
    </>}
  </section>;
}
