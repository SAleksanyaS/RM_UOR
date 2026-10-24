import { GitCommitHorizontal, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useWorkspace } from '../../app/AppContext';
import { formatDate } from '../overview/overview-model';
import { OperationPanel } from './OperationPanel';
import { getDirections } from '../catalog/directions';
import { planChangeSummary } from './plan-change-summary';

const fieldNames: Record<string, string> = { title: 'Название цели', summary: 'Описание', weight: 'Вес цели', officialTarget: 'Официальная цель', internalTarget: 'Внутренняя цель', priority: 'Приоритет', ownerId: 'Владелец', curatorId: 'Куратор УОР', text: 'Комментарий', metric: 'Показатель', workDirectionId: 'Направление', name: 'Название', description: 'Описание', color: 'Цвет', order: 'Порядок', plan: 'Ход работ и сроки', clusterName: 'Кластер', leaderId: 'ИТ-лидер', goalId: 'Цель', active: 'Применимость', teams: 'Объекты карты', participantIds: 'Команды в расчёте' };
export function ChangesView() {
  const { state, mutate, notify } = useWorkspace();
  const [tab, setTab] = useState<'operations' | 'changes'>('operations');
  const changedValue = (field: string, value: unknown) => {
    if (field === 'plan') return planChangeSummary(value);
    if (field === 'workDirectionId') return value == null ? 'Не назначено' : getDirections(state.catalog).find(direction => direction.id === value)?.name || 'Направление недоступно';
    if (field === 'leaderId') return state.catalog.leaders.find(leader => leader.id === value)?.name || 'Не назначен';
    if (field === 'goalId') return state.catalog.goals.find(goal => goal.id === value)?.title || 'Цель недоступна';
    if (field === 'participantIds' && Array.isArray(value)) return value.map(id => state.catalog.entities.find(entity => entity.id === id)?.name || 'Команда недоступна').join(', ') || 'Нет выбранных команд';
    if (field === 'active' && typeof value === 'boolean') return value ? 'Применяется' : 'Не применяется';
    if (Array.isArray(value)) return value.join(', ') || 'Не задано';
    return typeof value === 'object' ? JSON.stringify(value) : String(value ?? 'Не задано');
  };
  const changeLabel = (kind: string) => /plan/i.test(kind) ? 'План работ' : /leader/i.test(kind) ? 'ИТ-лидер кластера' : /direction/i.test(kind) ? 'Направление' : ({ goal_updated: 'Цель', assignment_updated: 'Назначение', assignment_added: 'Назначение', comment_added: 'Комментарий УОР', catalog_published: 'Публикация', source_updated: 'Источник' })[kind] || 'Изменение данных';
  return <><div className="page-heading"><div><div className="eyebrow">ПРОЗРАЧНОСТЬ КАЖДОГО ДЕЙСТВИЯ</div><h1>Обновления и история</h1><p>Что изменилось в рабочем месте, кто внес изменение и чем завершилась операция.</p></div><button className="button secondary" onClick={() => void mutate('/api/updates/check', {}).then(() => notify('Проверка версии завершена')).catch(failure => notify((failure as Error).message))}><RefreshCw size={16}/>Проверить версию</button></div><div className="repository-banner"><GitCommitHorizontal size={23}/><div><strong>{state.updates.message || 'Локальная версия рабочего места'}</strong><p>{state.repository.publishedBranch} · {state.updates.currentCommit?.slice(0, 8) || 'Версия не определена'} · проверено {formatDate(state.updates.checkedAt, true)}</p></div><span className="inline-tag">{state.updates.status === 'available' ? 'Есть обновления' : state.updates.status === 'current' ? 'Актуально' : 'Проверка репозитория'}</span></div><div className="page-tabs"><button className={tab === 'operations' ? 'active' : ''} onClick={() => setTab('operations')}>Операции<span>{state.operations.length}</span></button><button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>Изменения содержания<span>{state.changes.length}</span></button></div>{tab === 'operations' ? <OperationPanel/> : <div className="change-list">{state.changes.length === 0 && <div className="empty-state"><strong>Изменений содержания пока нет</strong><p>После изменения цели, комментария или порога здесь появится понятное описание.</p></div>}{[...state.changes].reverse().map(change => <article key={change.id}><span className="change-icon"><GitCommitHorizontal size={20}/></span><div><span className="small-label">{changeLabel(change.kind)}</span><h3>{change.objectLabel}</h3>{change.fields.map((field, index) => <p key={index}><strong>{fieldNames[field.field] || field.field}:</strong> <del>{changedValue(field.field, field.before)}</del><span className="change-arrow">→</span><span>{changedValue(field.field, field.after)}</span></p>)}<small>{change.actor} · {formatDate(change.at, true)}</small></div></article>)}</div>}</>;
}
