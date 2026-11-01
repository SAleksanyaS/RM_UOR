import { useEffect, useRef, useState } from 'react';
import { useGlobalContext, useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import type { WorkbenchReadModels, ExecutionReadItem } from '../../catalog/workbench-read-models';
import { isDeadlineOverdue } from '../workbench-reminders';
import { WorkEditor } from './WorkEditor';
import { DecisionEditor } from './DecisionEditor';
import { DependencyView } from './DependencyView';
import { ExecutionError, executionOwner, executionRequest, formatExecutionDate, workStateLabels } from './execution-ui';
import './execution-views.css';
import { executionTargetFromUrl } from '../../../app/workbench/route-state';

export function WorkbenchExecutionPage() {
  const { client, session } = useWorkbench(); const { context } = useGlobalContext();
  if (!session || !context) return <p>Выберите область для просмотра работ.</p>;
  return <ExecutionWorkspace key={JSON.stringify([executionOwner(client), session.personId, session.role, session.allowedCommands, context])} />;
}
function ExecutionWorkspace() {
  const { session, loading: checking } = useWorkbench(); const { context, navigate } = useGlobalContext();
  const canonicalTarget = executionTargetFromUrl(window.location.href), returnTarget = useRef<string|null>(null);
  useEffect(() => { if (!canonicalTarget && returnTarget.current) { const target = document.querySelector<HTMLElement>('[data-wb-execution-open="' + returnTarget.current + '"]') ?? document.querySelector<HTMLElement>('#wb-main h1'); returnTarget.current = null; target?.focus(); } }, [canonicalTarget?.entityType, canonicalTarget?.id]);
  const openCanonical = (entityType:'work'|'decision', id:string) => navigate('/execution?ref=' + encodeURIComponent(entityType + '/' + id));
  const [cursor, setCursor] = useState<string | null>(null), [items, setItems] = useState<ExecutionReadItem[]>([]), [kind, setKind] = useState<'all' | 'work' | 'decision'>('all'), [selected, setSelected] = useState<{ type: 'work' | 'decision'; id: string | null; edit: boolean } | null>(null);
  const request = useWorkbenchQuery<WorkbenchReadModels['execution.list']>('execution.list', context ? executionRequest(context, { kind }, cursor) : null);
  const options = useWorkbenchQuery<WorkbenchReadModels['context.options']>('context.options', context ? executionRequest(context) : null);
  const detail = useWorkbenchQuery<WorkbenchReadModels['execution.detail']>('execution.detail', context && selected?.id ? executionRequest(context, { ref: { entityType: selected.type, id: selected.id } }) : null);
  const [retainedDetail, setRetainedDetail] = useState<WorkbenchReadModels['execution.detail'] | null>(null);
  useEffect(() => { if (detail.data) setRetainedDetail(detail.data); }, [detail.data]);
  const visibleDetail = detail.data ?? (retainedDetail?.item.ref.id === selected?.id && retainedDetail?.item.kind === selected?.type ? retainedDetail : null);
  useEffect(() => { if (request.data) setItems(previous => cursor === null ? request.data!.items : [...new Map([...previous, ...request.data!.items].map(item => [item.ref.entityType + '/' + item.ref.id, item])).values()]); }, [request.data, cursor]);
  const displayed = request.data && cursor === null ? request.data.items : items;
  const names = Object.fromEntries(displayed.filter(item => item.kind === 'work').map(item => [item.ref.id, item.title]));
  const people = Object.fromEntries(options.data?.entities.filter(entity => entity.kind === 'person').map(entity => [entity.id, entity.name]) ?? []);
  const canEditWork = session?.allowedCommands.includes('work.draft.save'), canEditDecision = session?.allowedCommands.includes('decision.draft.save');
  const now = request.response?.meta.generatedAt;
  return <div className="wb-execution"><p>Работы, риски и решения не подтверждают достижение цели.</p><label>Показать<select aria-label="Показать" value={kind} onChange={event => { setKind(event.target.value as typeof kind); setCursor(null); setItems([]); setSelected(null); }}><option value="all">Работы и решения</option><option value="work">Работы</option><option value="decision">Решения</option></select></label>{canEditWork && <button disabled={checking} onClick={() => setSelected({ type: 'work', id: null, edit: true })}>Создать работу</button>}{canEditDecision && <button disabled={checking} onClick={() => setSelected({ type: 'decision', id: null, edit: true })}>Создать запрос решения</button>}<ExecutionError error={request.error} operation="read" />{request.loading && <p role="status">Загружаем работы…</p>}{!request.loading && !displayed.length && <p>В выбранной области работ и решений пока нет.</p>}
    {canonicalTarget && <CanonicalExecutionCard key={canonicalTarget.entityType+'/'+canonicalTarget.id} reference={canonicalTarget} people={people} names={names} onClose={() => { returnTarget.current = canonicalTarget.entityType+'/'+canonicalTarget.id; navigate('/execution'); }} />}
    {displayed.map(item => item.kind === 'work' ? <section key={item.ref.id}><h2>{item.value.title}</h2><button data-wb-execution-open={"work/"+item.value.id} onClick={()=>openCanonical("work",item.value.id)}>Открыть карточку: {item.title}</button><p>{workStateLabels[item.value.state]}</p><p>Плановый срок: <span>{formatExecutionDate(item.value.dueOn)}</span></p><p>Прогноз: {formatExecutionDate(item.value.forecastOn)}</p>{now && !['completed', 'cancelled'].includes(item.value.state) && isDeadlineOverdue(item.value.dueOn, now) && <p>Просрочено</p>}<p>Ответственные: {item.value.responsibility.map(person => people[person.personId] ?? 'Имя недоступно').join(', ') || 'Не назначены'}</p><p>Следующий шаг: {item.value.nextAction || 'Не задан'}</p>{item.value.risk && <p>Риск: {item.value.risk.reason}. Нужна помощь: {item.value.risk.helpNeeded}</p>}{item.value.blocker && <p>Блокировка: {item.value.blocker}</p>}{item.value.resultDescription && <p>Результат: {item.value.resultDescription}</p>}<button onClick={() => setSelected({ type: 'work', id: item.value.id, edit: false })}>Зависимости: {item.title}</button>{canEditWork && <button disabled={checking} onClick={() => setSelected({ type: 'work', id: item.value.id, edit: true })}>Изменить работу: {item.title}</button>}</section> : <section key={item.ref.id}><h2>{item.value.request}</h2><button data-wb-execution-open={"decision/"+item.value.id} onClick={()=>openCanonical("decision",item.value.id)}>Открыть карточку: {item.title}</button><p>Адресат: {people[item.value.requestedFromPersonId] ?? 'Имя недоступно'}</p><p>Срок: {formatExecutionDate(item.value.dueOn)}</p><p>{item.value.answer ? 'Отвечено: ' + item.value.answer : 'Ответ ожидается'}</p>{now && !item.value.answer && isDeadlineOverdue(item.value.dueOn, now) && <p>Просрочено</p>}{item.value.answeredAt && <p>Ответ получен: {formatExecutionDate(item.value.answeredAt)}</p>}{canEditDecision && <button disabled={checking} onClick={() => setSelected({ type: 'decision', id: item.value.id, edit: true })}>Ответить на решение: {item.value.request}</button>}</section>)}
    {request.data?.page.nextCursor && <button disabled={request.loading} onClick={() => setCursor(request.data!.page.nextCursor)}>Показать ещё</button>}
    {selected && <ExecutionError error={detail.error} operation="read" />}{selected && detail.loading && <p role="status">Открываем работу…</p>}
    {selected && visibleDetail?.item.kind === 'work' && (canEditWork && selected.edit ? <WorkEditor key={visibleDetail.item.value.id} work={visibleDetail.item.value} dependencies={visibleDetail.dependencies} names={names} onClose={() => setSelected(null)} /> : <section><h2>Зависимости: {visibleDetail.item.title}</h2><DependencyView dependencies={visibleDetail.dependencies} names={names} /><button onClick={() => setSelected(null)}>Закрыть зависимости</button></section>)}
    {selected?.id === null && selected.type === 'work' && canEditWork && <WorkEditor work={null} dependencies={[]} names={names} onClose={() => setSelected(null)} />}
    {selected?.id === null && selected.type === 'decision' && canEditDecision && <DecisionEditor decision={null} onClose={() => setSelected(null)} />}
    {selected && visibleDetail?.item.kind === 'decision' && canEditDecision && <DecisionEditor key={visibleDetail.item.value.id} decision={visibleDetail.item.value} onClose={() => setSelected(null)} />}
  </div>;
}

/** Canonical search targets only read the actual detail endpoint, for every role. */
function CanonicalExecutionCard({reference,people,names,onClose}:{reference:{entityType:'work'|'decision';id:string};people:Record<string,string>;names:Record<string,string>;onClose():void}) {
 const {context}=useGlobalContext();const heading=useRef<HTMLHeadingElement>(null),focused=useRef(false);
 const detail=useWorkbenchQuery<WorkbenchReadModels['execution.detail']>('execution.detail',context?executionRequest(context,{ref:reference}):null);
 useEffect(()=>{if(detail.data&&!focused.current&&!document.querySelector('[role="dialog"][aria-modal="true"]')){focused.current=true;heading.current?.focus();}},[detail.data]);
 const item=detail.data?.item;
 return <section role="region" aria-label={item?'Карточка '+(item.kind==='work'?'работы: ':'решения: ')+item.title:'Карточка объекта'}><button onClick={onClose}>Закрыть карточку объекта</button><ExecutionError error={detail.error} operation="read"/>{detail.loading&&<p role="status">Открываем карточку объекта…</p>}{item&&<><h2 ref={heading} tabIndex={-1}>{item.title}</h2><p>Просмотр общей записи</p>{item.kind==='work'?<><p>Состояние: {workStateLabels[item.value.state]}</p><p>Плановый срок: {formatExecutionDate(item.value.dueOn)}</p><p>Прогноз: {formatExecutionDate(item.value.forecastOn)}</p><p>Ответственные: {item.value.responsibility.map(owner=>people[owner.personId]??'Имя недоступно').join(', ')||'Не назначены'}</p><p>Следующий шаг: {item.value.nextAction||'Не задан'}</p>{item.value.risk&&<p>Риск: {item.value.risk.reason}. Нужна помощь: {item.value.risk.helpNeeded}</p>}{item.value.blocker&&<p>Блокировка: {item.value.blocker}</p>}{item.value.resultDescription&&<p>Результат: {item.value.resultDescription}</p>}<DependencyView dependencies={detail.data!.dependencies} names={names}/></>:<><p>Работа: {names[item.value.workId]??'Имя работы недоступно'}</p><p>Адресат: {people[item.value.requestedFromPersonId]??'Имя недоступно'}</p><p>Срок: {formatExecutionDate(item.value.dueOn)}</p><p>Ответ: {item.value.answer??'Ответ ожидается'}</p>{item.value.answeredAt&&<p>Ответ получен: {formatExecutionDate(item.value.answeredAt)}</p>}</>}</>}</section>;
}
