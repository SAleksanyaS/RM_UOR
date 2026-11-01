import { useEffect, useState } from 'react';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { Decision } from '../../../domain/workbench/entities';
import type { DraftSaveResult } from '../../catalog/workbench-drafts';
import { ExecutionError, executionRequest, ExecutionDialog, ExecutionDraftEditor, type ExecutionEditorApi } from './execution-ui';
export function DecisionEditor({ decision, onClose }: { decision: Decision | null; onClose(): void }) {
  return <ExecutionDialog title={decision ? 'Решение: ' + decision.request : 'Новый запрос решения'} onClose={onClose}><ExecutionDraftEditor reference={decision ? { entityType: 'decision', id: decision.id } : null} entityType="decision" commandName="decision.draft.save">{api => <DecisionForm api={api} />}</ExecutionDraftEditor></ExecutionDialog>;
}
function DecisionForm({ api }: { api: ExecutionEditorApi }) {
  const { context } = useGlobalContext();
  const options = useWorkbenchQuery<WorkbenchReadModels['context.options']>('context.options', context ? executionRequest(context) : null);
  const [cursor, setCursor] = useState<string | null>(null), [works, setWorks] = useState<WorkbenchReadModels['execution.list']['items']>([]);
  const workList = useWorkbenchQuery<WorkbenchReadModels['execution.list']>('execution.list', context ? executionRequest(context, { kind: 'work' }, cursor) : null);
  useEffect(() => { if (workList.data) setWorks(previous => cursor === null ? workList.data!.items : [...new Map([...previous, ...workList.data!.items].map(item => [item.ref.id, item])).values()]); }, [workList.data, cursor]);
  const initial = api.entry.definition as Partial<Decision>;
  const [request, setRequest] = useState(initial.request ?? ''), [dueOn, setDueOn] = useState(initial.dueOn ?? ''), [answer, setAnswer] = useState(initial.answer ?? '');
  const [workId, setWorkId] = useState(initial.workId ?? ''), [recipient, setRecipient] = useState(initial.requestedFromPersonId ?? '');
  const workChoices = new Map(works.map(item => [item.ref.id, item.title]));
  for (const entry of api.entries) if (entry.entityRef.entityType === 'work') workChoices.set(entry.entityRef.id, typeof entry.definition.title === 'string' ? entry.definition.title + ' (личный черновик)' : 'Незаполненная работа (личный черновик)');
  if (workId && !workChoices.has(workId)) workChoices.set(workId, 'Связанная работа ещё не загружена');
  const save = () => api.perform('decision', async () => {
    const definition: Record<string, unknown> = { ...api.entry.definition, answer: answer.trim() || null };
    if (request.trim()) definition.request = request; else delete definition.request;
    if (dueOn) definition.dueOn = dueOn; else delete definition.dueOn;
    if (workId) definition.workId = workId; else delete definition.workId;
    if (recipient) definition.requestedFromPersonId = recipient; else delete definition.requestedFromPersonId;
    delete definition.answeredAt;
    await api.run<DraftSaveResult>('decision.save', 'decision.draft.save', { draftId: api.entry.draftId, definition });
  });
  return <><fieldset disabled={api.disabled}><legend>Запрос решения</legend><ExecutionError error={options.error} operation="read" /><ExecutionError error={workList.error} operation="read" /><label>Работа запроса<select aria-label="Работа запроса" value={workId} onChange={event => setWorkId(event.target.value)}><option value="">Выберите работу</option>{[...workChoices].map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>{workList.data?.page.nextCursor && <button disabled={workList.loading} onClick={() => setCursor(workList.data!.page.nextCursor)}>Показать ещё работы</button>}<label>Адресат решения<select aria-label="Адресат решения" value={recipient} onChange={event => setRecipient(event.target.value)}><option value="">Выберите сотрудника</option>{options.data?.entities.filter(entity => entity.kind === 'person').map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label>Запрос<textarea value={request} onChange={event => setRequest(event.target.value)} /></label><label>Срок решения<input type="date" value={dueOn} onChange={event => setDueOn(event.target.value)} /></label><label>Ответ на запрос<textarea value={answer} onChange={event => setAnswer(event.target.value)} /></label><p>Время ответа заполняется при сохранении вместе с ответом.</p></fieldset><button type="button" disabled={api.disabled && !api.unknown} onClick={save}>Сохранить решение</button>{api.entry.problems.map((problem, index) => <p key={index}>{problem.path}: {problem.message}</p>)}</>;
}
