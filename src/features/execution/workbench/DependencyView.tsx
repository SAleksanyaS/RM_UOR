import { useEffect, useState } from 'react';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import type { Work, WorkDependency } from '../../../domain/workbench/entities';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import { ExecutionError, executionRequest } from './execution-ui';
export type DependencyResolution = Record<string, { inactive: boolean; reason: string }>;
export function DependencyView({ dependencies, names, resolution, onChange, disabled = false }: { dependencies: WorkDependency[]; names: Record<string, string>; resolution?: DependencyResolution; onChange?(next: DependencyResolution): void; disabled?: boolean }) {
  const { context } = useGlobalContext();
  const [cursor, setCursor] = useState<string | null>(null), [works, setWorks] = useState<Work[]>([]);
  // Goal filtering must not hide another goal affected by this shared Work.
  const readContext = context ? { ...context, goalId: null } : null;
  const request = useWorkbenchQuery<WorkbenchReadModels['execution.list']>('execution.list', readContext && dependencies.length ? executionRequest(readContext, { kind: 'work' }, cursor) : null);
  const options = useWorkbenchQuery<WorkbenchReadModels['context.options']>('context.options', context && dependencies.length ? executionRequest(context) : null);
  useEffect(() => { if (request.data) { const values = request.data.items.filter(item => item.kind === 'work').map(item => item.value as Work); setWorks(previous => cursor === null ? values : [...new Map([...previous, ...values].map(work => [work.id, work])).values()]); } }, [request.data, cursor]);
  if (!dependencies.length) return <p>Зависимостей нет</p>;
  const byId = new Map(works.map(work => [work.id, work]));
  const directory = new Map(options.data?.entities.map(entity => [entity.id, entity.name]) ?? []);
  const goals = new Map(options.data?.goals.map(goal => [goal.id, goal.title]) ?? []);
  return <section aria-label="Зависимости работ"><h3>Зависимости</h3><ExecutionError error={request.error} operation="read" /><ExecutionError error={options.error} operation="read" />{request.loading && <p role="status">Загружаем связанные работы…</p>}{dependencies.map(link => {
    const previous = byId.get(link.predecessorWorkId), next = byId.get(link.successorWorkId);
    const label = `${previous?.title ?? names[link.predecessorWorkId] ?? 'Работа вне выбранной области'} → ${next?.title ?? names[link.successorWorkId] ?? 'Работа вне выбранной области'}`, choice = resolution?.[link.id] ?? { inactive: false, reason: '' };
    return <div key={link.id}><p>{label} · {link.active ? 'Действует' : 'Снята'}</p>{[previous,next].filter((work): work is Work => !!work).map(work => <div key={work.id}><h4>{work.title}</h4>{work.responsibility.map(person => <p key={person.scope.id}>Ответственный: {directory.get(person.personId) ?? 'Имя недоступно'} · {directory.get(person.scope.id) ?? 'Область недоступна'}</p>)}{!work.responsibility.length && <p>Ответственный не назначен</p>}{work.id === link.successorWorkId && <p>Затронутые цели: {work.goalIds.map(id => goals.get(id) ?? 'Название недоступно').join(', ') || 'Не связаны'}</p>}</div>)}{(!previous || !next) && !request.loading && <p>Часть связанных работ вне выбранной области или ещё не загружена.</p>}{link.changeReason && <p>Причина: {link.changeReason}</p>}{link.active && onChange && <><label><input type="checkbox" disabled={disabled} checked={choice.inactive} onChange={event => onChange({ ...resolution, [link.id]: { ...choice, inactive: event.target.checked } })} />Снять зависимость: {label}</label>{choice.inactive && <label>Причина снятия зависимости<textarea disabled={disabled} value={choice.reason} onChange={event => onChange({ ...resolution, [link.id]: { ...choice, reason: event.target.value } })} /></label>}</>}</div>;
  })}{request.data?.page.nextCursor && <button type="button" disabled={request.loading} onClick={() => setCursor(request.data!.page.nextCursor)}>Показать ещё связанные работы</button>}</section>;
}
