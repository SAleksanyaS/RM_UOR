import { useState } from 'react';
import type { Assignment, Goal, KnowledgeEntity } from '../../domain/contracts';
import { useWorkspace } from '../../app/AppContext';
import { getDirections, getGoalDirectionId } from './directions';
import { TeamScopePicker, type ScopeSelection } from './TeamScopePicker';
import type { AssignmentScopeInput, AssignmentScopeResult } from './scope-contracts';

interface AssignmentForm extends ScopeSelection { id: string; baseAssignment: Assignment; active: boolean; target: string; summary: string }
const sameValues = (left: string[] | undefined, right: string[] | undefined) => left === undefined || right === undefined
  ? left === right : JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
const scopeForm = (assignment: Assignment): AssignmentForm => ({ id: assignment.id, baseAssignment: structuredClone(assignment),
  active: assignment.active !== false, teams: [...assignment.teams],
  ...(assignment.participantIds !== undefined ? { participantIds: [...assignment.participantIds] } : {}),
  target: assignment.target || '', summary: assignment.summary || '', newEntities: [] });

export function GoalEditor({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const { state, mutate, notify } = useWorkspace();
  const directions = getDirections(state.catalog);
  const [assignmentForms, setAssignments] = useState<AssignmentForm[]>(() => state.catalog.assignments.filter(assignment => assignment.goalId === goal.id).map(scopeForm));
  const [createdEntities, setCreatedEntities] = useState<KnowledgeEntity[]>([]);
  const entities = [...new Map([...(state.catalog.entities ?? []), ...createdEntities].map(entity => [entity.id, entity])).values()];
  const [form, setForm] = useState({ title: goal.title, summary: goal.summary, officialTarget: goal.officialTarget === null ? '' : String(goal.officialTarget), internalTarget: goal.internalTarget === null ? '' : String(goal.internalTarget), weight: goal.weight === null ? '' : String(goal.weight), priority: goal.priority || '', ownerId: goal.ownerId || '', curatorId: goal.curatorId || '', dueDate: goal.dueDate || '', workDirectionId: directions.some(direction => direction.id === getGoalDirectionId(goal)) ? getGoalDirectionId(goal) || '' : '', links: goal.links.map(link => `${link.label} | ${link.url}`).join('\n') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (key: keyof typeof form, value: string) => setForm(current => ({ ...current, [key]: value }));
  const changeAssignment = (id: string, patch: Partial<(typeof assignmentForms)[number]>) => setAssignments(current => current.map(assignment => assignment.id === id ? { ...assignment, ...patch } : assignment));
  async function save(publish: boolean) {
    setBusy(true); setError('');
    try {
      const links = form.links.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
        const divider = line.indexOf('|');
        const label = divider < 0 ? 'Источник' : line.slice(0, divider).trim();
        const url = (divider < 0 ? line : line.slice(divider + 1)).trim();
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error(`Ссылка в строке ${index + 1}: укажите полный адрес https://…`); }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Ссылка в строке ${index + 1}: поддерживаются только http и https.`);
        return { label: label || 'Источник', url, kind: goal.links.find(link => link.url === url)?.kind || 'reference' };
      });
      await mutate(`/api/goals/${encodeURIComponent(goal.id)}`, { ...form, links, workDirectionId: form.workDirectionId || null, officialTarget: form.officialTarget === '' ? null : Number(form.officialTarget), internalTarget: form.internalTarget === '' ? null : Number(form.internalTarget), weight: form.weight === '' ? null : Number(form.weight), priority: form.priority || null, ownerId: form.ownerId || null, curatorId: form.curatorId || null, dueDate: form.dueDate || null, baseRevision: goal.revision });
      for (const assignment of assignmentForms) {
        const original = assignment.baseAssignment;
        const patch: AssignmentScopeInput = { baseAssignment: original, active: assignment.active, teams: [...assignment.teams],
          ...(assignment.participantIds !== undefined ? { participantIds: [...assignment.participantIds] } : {}),
          target: assignment.target, summary: assignment.summary,
          ...(assignment.newEntities.length ? { newEntities: assignment.newEntities } : {}) };
        if (patch.active === (original.active !== false) && sameValues(patch.teams, original.teams)
          && sameValues(patch.participantIds, original.participantIds) && patch.target === (original.target || '')
          && patch.summary === (original.summary || '') && !assignment.newEntities.length) continue;
        const accepted = await mutate(`/api/assignments/${encodeURIComponent(assignment.id)}/scope`, patch) as AssignmentScopeResult;
        if (!accepted?.assignment) throw new Error('Служба не вернула сохранённый состав. Обновите данные и проверьте результат операции.');
        setCreatedEntities(current => [...new Map([...current, ...accepted.createdEntities.map(item => item.entity)].map(entity => [entity.id, entity])).values()]);
        setAssignments(current => current.map(item => item.id === assignment.id ? scopeForm(accepted.assignment) : item));
      }
      if (publish) await mutate('/api/publish', {});
      notify(publish ? 'Публикация запущена. Результат — в панели операций.' : 'Цель и изменённые назначения сохранены на этом компьютере');
      onClose();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="editor-card">
    <fieldset className="goal-editor-fields" disabled={busy}>
    <div className="section-heading"><h3>Настройка цели</h3><span className="inline-tag">Черновик куратора</span></div>
    <label className="field">Название<input value={form.title} onChange={event => change('title', event.target.value)}/></label>
    <label className="field">Описание<textarea rows={3} value={form.summary} onChange={event => change('summary', event.target.value)}/></label>
    <label className="field">Направление<select value={form.workDirectionId} onChange={event => change('workDirectionId', event.target.value)}><option value="">Без направления</option>{directions.map(direction => <option key={direction.id} value={direction.id}>{direction.name}</option>)}</select></label>
    <div className="form-grid">
      <label className="field">Официальный порог<input type="number" step="any" value={form.officialTarget} onChange={event => change('officialTarget', event.target.value)}/></label>
      <label className="field">Внутренний порог<input type="number" step="any" value={form.internalTarget} onChange={event => change('internalTarget', event.target.value)}/></label>
      <label className="field">Вес цели<input type="number" min="0" step="any" value={form.weight} onChange={event => change('weight', event.target.value)}/></label>
      <label className="field">Приоритет<select value={form.priority} onChange={event => change('priority', event.target.value)}><option value="">Не задан</option><option value="high">Высокий</option><option value="normal">Обычный</option><option value="low">Низкий</option></select></label>
      <label className="field">Владелец цели<input placeholder="Имя или устойчивый ID" value={form.ownerId} onChange={event => change('ownerId', event.target.value)}/></label>
      <label className="field">Куратор УОР<input placeholder="Имя или устойчивый ID" value={form.curatorId} onChange={event => change('curatorId', event.target.value)}/></label>
      <label className="field">Срок<input type="date" value={form.dueDate} onChange={event => change('dueDate', event.target.value)}/></label>
    </div>
    <label className="field">Ссылки цели<textarea aria-label="Ссылки цели" rows={3} value={form.links} placeholder="Название | https://адрес" onChange={event => change('links', event.target.value)}/></label>
    <p className="form-note">Каждая ссылка — с новой строки: название | полный адрес.</p>
    <section className="assignment-editor"><div className="section-heading"><h3>Назначения ИТ-лидерам</h3><span className="inline-tag">{assignmentForms.length}</span></div><p className="form-note">Применимость, состав объектов карты и особенности цели настраиваются отдельно для каждого лидера.</p>
      {assignmentForms.map(assignment => {
        const original = assignment.baseAssignment;
        const name = state.catalog.leaders.find(leader => leader.id === original.leaderId)?.name || original.leaderId;
        return <details className="assignment-editor-item" key={assignment.id} open={assignmentForms.length === 1 ? true : undefined}><summary><strong>{name}</strong><span>{assignment.active ? 'Применяется' : 'Не применяется'}</span></summary><div><label className="assignment-checkbox"><input type="checkbox" disabled={busy} aria-label={`Применяется: ${name}`} checked={assignment.active} onChange={event => changeAssignment(assignment.id, { active: event.target.checked })}/><span>Цель применяется к ИТ-лидеру</span></label><TeamScopePicker assignment={original} entities={entities} value={assignment} disabled={busy} onChange={patch => changeAssignment(assignment.id, patch)}/><label className="field">Цель назначения<input disabled={busy} aria-label={`Цель назначения: ${name}`} value={assignment.target} onChange={event => changeAssignment(assignment.id, { target: event.target.value })}/></label><label className="field">Особенности назначения<textarea disabled={busy} aria-label={`Особенности назначения: ${name}`} rows={2} value={assignment.summary} onChange={event => changeAssignment(assignment.id, { summary: event.target.value })}/></label></div></details>;
      })}
    </section>
    {error && <div className="error-inline" role="alert">{error}</div>}
    <p className="form-note">Изменения сохраняются локально. «Сохранить и отправить» публикует их в общую релизную ветку; руководитель УОР выпускает версию.</p>
    </fieldset>
    <div className="button-row"><button className="button secondary" onClick={onClose}>Отмена</button><button className="button secondary" disabled={busy || !form.title.trim()} onClick={() => void save(false)}>Сохранить черновик</button><button className="button primary" disabled={busy || !form.title.trim()} onClick={() => void save(true)}>{busy ? 'Сохранение…' : 'Сохранить и отправить'}</button></div>
  </div>;
}
