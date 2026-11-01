import { useEffect, useState } from 'react';
import { useUnsavedChanges } from '../../../app/workbench/use-unsaved-changes';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { Work, WorkDependency } from '../../../domain/workbench/entities';
import type { DraftSaveResult } from '../../catalog/workbench-drafts';
import { businessFields, executionRequest, ExecutionError, ExecutionDialog, ExecutionDraftEditor, workStateLabels, type ExecutionEditorApi } from './execution-ui';
import { DependencyView, type DependencyResolution } from './DependencyView';
export function WorkEditor({ work, dependencies, names, onClose }: { work: Work | null; dependencies: WorkDependency[]; names: Record<string, string>; onClose(): void }) {
  const [dirty, setDirty] = useState(false);
  const requestLeave = useUnsavedChanges(dirty);
  return <ExecutionDialog title={work ? 'Работа: ' + work.title : 'Новая работа'} onClose={() => requestLeave(onClose)}><ExecutionDraftEditor reference={work ? { entityType: 'work', id: work.id } : null} entityType="work" commandName="work.draft.save">{api => <WorkForm api={api} dependencies={dependencies} names={names} onDirty={setDirty} />}</ExecutionDraftEditor></ExecutionDialog>;
}
function WorkForm({ api, dependencies, names, onDirty }: { api: ExecutionEditorApi; dependencies: WorkDependency[]; names: Record<string, string>; onDirty(value: boolean): void }) {
  const { context } = useGlobalContext();
  const options = useWorkbenchQuery<WorkbenchReadModels['context.options']>('context.options', context ? executionRequest(context) : null);
  const initial = api.entry.definition as Partial<Work>;
  const [title, setTitle] = useState(initial.title ?? ''), [dueOn, setDueOn] = useState(initial.dueOn ?? ''), [forecastOn, setForecastOn] = useState(initial.forecastOn ?? ''), [nextAction, setNextAction] = useState(initial.nextAction ?? ''), [riskReason, setRiskReason] = useState(initial.risk?.reason ?? ''), [helpNeeded, setHelpNeeded] = useState(initial.risk?.helpNeeded ?? ''), [blocker, setBlocker] = useState(initial.blocker ?? '');
  const [target, setTarget] = useState<Work['state']>(initial.state ?? 'planned'), [reason, setReason] = useState(''), [result, setResult] = useState(initial.resultDescription ?? ''), [resolution, setResolution] = useState<DependencyResolution>({});
  const [goalIds, setGoalIds] = useState(initial.goalIds ?? []), [responsibility, setResponsibility] = useState(initial.responsibility ?? []), [scopeId, setScopeId] = useState(''), [personId, setPersonId] = useState('');
  const fieldSignature = JSON.stringify({ title, dueOn, forecastOn, nextAction, riskReason, helpNeeded, blocker, goalIds, responsibility });
  const stateSignature = JSON.stringify({ target, reason, result, resolution });
  const [savedFields, setSavedFields] = useState(fieldSignature), [savedState, setSavedState] = useState(stateSignature);
  useEffect(() => { onDirty(fieldSignature !== savedFields || stateSignature !== savedState); }, [fieldSignature, stateSignature, savedFields, savedState, onDirty]);
  const scopes = options.data?.entities.filter(entity => ['dit', 'cluster', 'product', 'team'].includes(entity.kind)) ?? [];
  const people = options.data?.entities.filter(entity => entity.kind === 'person') ?? [];
  const saveFields = () => api.perform('fields', async () => {
    const definition: Record<string, unknown> = { state: initial.state ?? 'planned', reason: null, resultDescription: null, evidenceIds: [], ...api.entry.definition, goalIds, responsibility, dueOn: dueOn || null, forecastOn: forecastOn || null, nextAction, blocker: blocker.trim() || null, risk: riskReason.trim() || helpNeeded.trim() ? { ...(riskReason.trim() ? { reason: riskReason } : {}), ...(helpNeeded.trim() ? { helpNeeded } : {}) } : null };
    if (title.trim()) definition.title = title; else delete definition.title;
    await api.run<DraftSaveResult>('work.fields', 'work.draft.save', { draftId: api.entry.draftId, definition });
  }, () => { setSavedFields(fieldSignature); onDirty(stateSignature !== savedState); });
  const transition = () => api.perform('state', async () => {
    for (const link of dependencies) {
      const choice = resolution[link.id]; if (!link.active || !choice?.inactive) continue;
      const opened = await api.run<{ draftId: string }>('dependency.open.' + link.id, 'draft.open', { entityType: 'work_dependency', ref: { entityType: 'work_dependency', id: link.id }, packageId: api.packageId });
      await api.run<DraftSaveResult>('dependency.save.' + link.id, 'workDependency.draft.save', { draftId: opened.draftId, definition: { ...businessFields(link as unknown as Record<string, unknown>), active: false, changeReason: choice.reason.trim() || null } });
    }
    await api.run<DraftSaveResult>('work.state', 'work.transition', { draftId: api.entry.draftId, ref: api.entry.versionRef, targetState: target, reason: reason.trim() || null, resultDescription: result.trim() || null });
  }, () => { setSavedState(stateSignature); onDirty(fieldSignature !== savedFields); });
  const currentState = api.entry.definition.state as Work['state'] | undefined;
  return <>
    <p className="wb-status-note">Состояние в черновике: <strong>{currentState ? workStateLabels[currentState] ?? `Неизвестное состояние: ${currentState}` : 'Не задано'}</strong></p>
    <fieldset className="wb-form-section" disabled={api.disabled}>
      <legend>Поля работы</legend>
      <ExecutionError error={options.error} operation="read" />
      <div className="wb-form-grid">
        <label className="wb-field wb-form-full"><span>Название работы</span><input value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label className="wb-field"><span>Плановый срок</span><input type="date" value={dueOn} onChange={event => setDueOn(event.target.value)} /></label>
        <label className="wb-field"><span>Прогноз</span><input type="date" value={forecastOn} onChange={event => setForecastOn(event.target.value)} /></label>
        <p className="wb-form-full wb-status-note">Прогноз не меняет плановый срок.</p>
        <label className="wb-field wb-form-full"><span>Следующий шаг</span><textarea value={nextAction} onChange={event => setNextAction(event.target.value)} /></label>
      </div>
      <h3>Связанные цели</h3>
      <div className="wb-checklist">{options.data?.goals.map(goal => <label key={goal.id}><input type="checkbox" checked={goalIds.includes(goal.id)} onChange={event => setGoalIds(previous => event.target.checked ? [...previous, goal.id] : previous.filter(id => id !== goal.id))} />Цель работы: {goal.title}</label>)}</div>
      <h3>Ответственность</h3>
      <div className="wb-form-grid">
        <label className="wb-field"><span>Область ответственности</span><select aria-label="Область ответственности" value={scopeId} onChange={event => setScopeId(event.target.value)}><option value="">Выберите область</option>{scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.name}</option>)}</select></label>
        <label className="wb-field"><span>Ответственный</span><select aria-label="Ответственный" value={personId} onChange={event => setPersonId(event.target.value)}><option value="">Выберите сотрудника</option>{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      </div>
      <div className="wb-form-actions"><button type="button" disabled={!scopeId || !personId} onClick={() => { const scope = scopes.find(item => item.id === scopeId); if (scope) setResponsibility(previous => [...previous.filter(item => item.scope.id !== scope.id), { scope: { kind: scope.kind as Work['responsibility'][number]['scope']['kind'], id: scope.id }, personId }]); }}>Добавить ответственного</button></div>
      <ul className="wb-assignment-list">{responsibility.map(item => <li key={item.scope.id}><span>{scopes.find(scope => scope.id === item.scope.id)?.name ?? 'Область недоступна'}: <strong>{people.find(person => person.id === item.personId)?.name ?? 'Имя недоступно'}</strong></span><button type="button" aria-label={'Удалить ответственность: ' + item.scope.id} onClick={() => setResponsibility(previous => previous.filter(value => value.scope.id !== item.scope.id))}>Удалить</button></li>)}</ul>
      <div className="wb-form-grid">
        <label className="wb-field"><span>Причина риска</span><textarea value={riskReason} onChange={event => setRiskReason(event.target.value)} /></label>
        <label className="wb-field"><span>Требуемая помощь</span><textarea value={helpNeeded} onChange={event => setHelpNeeded(event.target.value)} /></label>
        <label className="wb-field wb-form-full"><span>Блокировка</span><textarea value={blocker} onChange={event => setBlocker(event.target.value)} /></label>
      </div>
    </fieldset>
    <div className="wb-form-actions"><button className="wb-primary-button" type="button" disabled={api.disabled && !api.unknown} onClick={saveFields}>Сохранить поля работы</button></div>
    <fieldset className="wb-form-section" disabled={api.disabled}>
      <legend>Изменение состояния</legend>
      <div className="wb-form-grid">
        <label className="wb-field"><span>Новое состояние</span><select aria-label="Новое состояние" value={target} onChange={event => setTarget(event.target.value as Work['state'])}>{Object.entries(workStateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="wb-field wb-form-full"><span>Причина изменения состояния</span><textarea value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label className="wb-field wb-form-full"><span>Результат работы</span><textarea value={result} onChange={event => setResult(event.target.value)} /></label>
      </div>
      <p className="wb-status-note">Возобновление завершённой работы требует причины. Предыдущий результат остаётся в истории.</p>
      <DependencyView dependencies={dependencies} names={names} resolution={resolution} onChange={setResolution} disabled={api.disabled} />
    </fieldset>
    <div className="wb-form-actions"><button type="button" disabled={(api.disabled && !api.unknown) || !api.entry.complete} onClick={transition}>Изменить состояние</button>{!api.entry.complete && <p>Для изменения состояния сначала дополните поля работы.</p>}</div>
    {!!api.entry.problems.length && <div className="wb-form-problems">{api.entry.problems.map((problem, index) => <p key={index}>{problem.path}: {problem.message}</p>)}</div>}
  </>;
}
