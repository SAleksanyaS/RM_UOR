import { useState } from 'react';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import { useGoalRead } from './use-goal-read';
import { GoalOpenButton, goalRequest, QueryFeedback, ResultModeSelector } from './goal-view-utils';
import { ResultSummary } from './ResultSummary';
import { BasisInspector } from './BasisInspector';
import type { GoalReadRow, WorkbenchReadModels } from '../../catalog/workbench-read-models';
import { Search, ArrowDownUp, Filter, Target } from 'lucide-react';

function RequirementFacts({ row }: { row: GoalReadRow }) {
  const { context } = useGlobalContext();
  const detail = useWorkbenchQuery<WorkbenchReadModels['goals.detail']>('goals.detail', row.snapshot && context ? goalRequest({ ...context, goalId: row.goal.id }) : null);
  const basis = detail.data?.tabs.calculation.find(item => item.id === row.basisRef?.id && item.revision === row.basisRef.revision);
  const method = detail.data?.tabs.method.find(item => item.id === basis?.methodRef.id && item.revision === basis.methodRef.revision);
  return <><QueryFeedback loading={detail.loading} error={detail.error} /><BasisInspector row={row} basis={basis} method={method} variant="summary" /></>;
}

export function WorkbenchGoalsPage() {
  const { context } = useGlobalContext();
  const [search, setSearch] = useState(''), [status, setStatus] = useState('all');
  const [sort, setSort] = useState<'title' | 'scope' | 'owner'>('title'), [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [position, setPosition] = useState<{ selection: string; cursor: string | null }>({ selection: '', cursor: null });
  const selection = JSON.stringify([context, sort, direction]), cursor = position.selection === selection ? position.cursor : null;
  const query = useGoalRead('goals.list', context ? { ...goalRequest(context, {}, cursor), sort: [{ field: sort, direction }] } : null);
  const term = search.trim().toLocaleLowerCase('ru');
  const rows = (query.data?.items ?? []).filter(row => {
    const manual = row.goal.mode === 'manual_status';
    const complete = manual ? row.manualStatus?.to === 'completed' : row.numericResult?.achievement === 'met' && row.numericResult.complete && row.numericResult.calculation === 'ready';
    const needsAttention = !!row.unavailableReason || row.needs_calculation || !complete || !row.attestation || !manual && row.numericResult?.freshness !== 'fresh';
    return (!term || [row.goal.title, row.scopeName, row.leader?.name].some(value => value?.toLocaleLowerCase('ru').includes(term))) && (status === 'all' || status === 'attention' && needsAttention || status === 'confirmed' && !!row.attestation || status === 'manual' && manual);
  });
  return <section className="wb-goals-list" aria-label="Список целей">
    <div className="wb-result-toolbar"><ResultModeSelector selectedSnapshot={query.data?.items[0]?.snapshot} /><span className="wb-toolbar-note">Каждая область цели показана отдельно</span></div>
    <div className="wb-page-toolbar">
      <label className="wb-search-field"><span><Search size={16} aria-hidden="true" />Найти на странице</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Цель, область или ответственный" /></label>
      <label className="wb-field"><span><Filter size={15} aria-hidden="true" />Состояние на странице</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="all">Все состояния</option><option value="attention">Требуют внимания</option><option value="confirmed">Подтверждены УОР</option><option value="manual">Ручной статус</option></select></label>
      <label className="wb-field"><span><ArrowDownUp size={15} aria-hidden="true" />Сортировка всего списка</span><select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="title">По названию</option><option value="scope">По области</option><option value="owner">По ответственному</option></select></label>
      <label className="wb-field"><span>Порядок</span><select value={direction} onChange={event => setDirection(event.target.value as typeof direction)}><option value="asc">А → Я</option><option value="desc">Я → А</option></select></label>
    </div>
    <QueryFeedback loading={query.loading} error={query.error} operation={query.errorOperation} />
    {query.data && <>
      <div className="wb-list-summary"><span>Показано {rows.length} из {query.data.items.length} назначений на странице</span><span>Для поиска во всём рабочем месте используйте общий поиск</span></div>
      {rows.length ? <div className="wb-table-scroll wb-surface" role="region" aria-label="Таблица целей" tabIndex={0}><table className="wb-data-table wb-goals-table"><caption className="wb-visually-hidden">Цели: значение, требование, состояние и ответственность</caption><thead><tr><th scope="col">Цель и область</th><th scope="col">Факт и требование</th><th scope="col">Состояние и подтверждение</th><th scope="col">Ответственный и срок</th><th scope="col">Действие</th></tr></thead><tbody>{rows.map(row => {
        const numeric = row.numericResult;
        const resultLabel = row.goal.mode === 'manual_status' ? row.manualStatus ? ({ not_started: 'Не начата', in_progress: 'В работе', completed: 'Завершена' })[row.manualStatus.to] ?? `Неизвестный статус: ${row.manualStatus.to}` : 'Ручной статус не задан' : !numeric ? row.needs_calculation ? 'Требуется расчёт' : 'Нет данных' : numeric.calculation === 'not_applicable' ? 'Не применимо' : numeric.calculation === 'no_data' ? 'Нет данных' : numeric.calculation === 'blocked' ? 'Расчёт заблокирован' : numeric.calculation === 'preliminary' || !numeric.complete ? 'Данные неполны' : ({ met: 'Условие выполнено', not_met: 'Условие не выполнено', unknown: 'Выполнение не определено', not_applicable: 'Не применимо' })[numeric.achievement] ?? `Неизвестное состояние: ${numeric.achievement}`;
        return <tr key={row.ref.id}><td><h3>{row.goal.title}</h3><p className="wb-cell-note">{row.scopeName ?? 'Историческое имя области не сохранено'}</p></td><td className="wb-goals-facts"><RequirementFacts row={row} /></td><td><span className="wb-badge wb-badge-neutral">{resultLabel}</span>{numeric && <p className="wb-cell-note">{({ fresh: 'Данные актуальны', stale: 'Данные устарели', unknown: 'Актуальность не определена' })[numeric.freshness] ?? `Актуальность: ${numeric.freshness}`}</p>}<p className="wb-cell-note">{row.attestation ? 'Подтверждено УОР' : 'Подтверждение УОР отсутствует'}</p><details className="wb-inline-details"><summary>Полное состояние</summary><ResultSummary row={row} /></details></td><td><strong>{row.leader?.name ?? (row.snapshot ? 'Историческое имя не сохранено' : 'Не назначен')}</strong><p className="wb-cell-note">{row.assignment.officialDueOn ? 'До ' + row.assignment.officialDueOn.split('-').reverse().join('.') : 'Срок не задан'}</p></td><td><GoalOpenButton goalId={row.goal.id} title={row.goal.title} compact /></td></tr>;
      })}</tbody></table></div> : <div className="wb-content-empty wb-surface"><Target size={28} aria-hidden="true" /><h3>{query.data.items.length ? 'На этой странице нет совпадений' : 'Нет объектов по фильтру'}</h3><p>{query.data.items.length ? 'Измените поиск или состояние. Другие страницы списка доступны ниже.' : 'Выберите другую область или согласованный срез.'}</p>{(search || status !== 'all') && <button type="button" onClick={() => { setSearch(''); setStatus('all'); }}>Сбросить фильтры страницы</button>}</div>}
      <div className="wb-pagination">{cursor && <button type="button" disabled={query.loading} onClick={() => setPosition({ selection, cursor: null })}>К началу списка</button>}
      {query.data.page.nextCursor && <button type="button" disabled={query.loading} onClick={() => setPosition({ selection, cursor: query.data!.page.nextCursor })}>Следующая страница целей</button>}</div>
    </>}
  </section>;
}
