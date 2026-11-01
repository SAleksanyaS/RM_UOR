import { useState } from 'react';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import type { GlobalContext } from '../../../server/workbench/protocol';
import type { GoalReadRow, WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { EvaluationBasis, MethodVersion } from '../../../domain/workbench/entities';
import { BasisInspector } from './BasisInspector';
import { ResultSummary } from './ResultSummary';
import { ContextLink, displayExact, goalRequest, QueryFeedback, ResultModeSelector } from './goal-view-utils';
import { useGoalRead } from './use-goal-read';

const tabs = ['Состояние', 'Работы и решения', 'Методика', 'Расчёт', 'Обогащённые данные', 'Исходные строки', 'История'] as const;
function RowState({ row, basis, method, names, deliveries }: { row: GoalReadRow; basis?: EvaluationBasis; method?: MethodVersion; names: Record<string, string>; deliveries: Record<string, 'git' | 'local-cache'> }) {
  return <section className="wb-goal-card" aria-label={row.scopeName ?? `Сохранённая область ${row.assignment.scope.id}`}><h3>{row.scopeName ?? row.assignment.scope.id}</h3><ResultSummary row={row} names={names} /><BasisInspector row={row} basis={basis} method={method} deliveries={deliveries} variant="summary" /></section>;
}
function GoalHistory({ row, context, method }: { row: GoalReadRow; context: GlobalContext; method?: MethodVersion }) {
  const [position, setPosition] = useState<{ key: string; cursor: string | null }>({ key: '', cursor: null });
  const methodKey = JSON.stringify([context, method?.id, method?.revision]);
  const metrics = method?.mode === 'numeric' ? method.rules.map(rule => rule.metricRef) : [];
  const [selection, setSelection] = useState({ methodKey: '', metric: '' });
  const metricKey = selection.methodKey === methodKey ? selection.metric : '';
  const metricRef = metrics.find(ref => `${ref.id}/${ref.revision}` === metricKey) ?? metrics[0] ?? null;
  const key = JSON.stringify([context, metricRef]);
  const query = useWorkbenchQuery<WorkbenchReadModels['history.series']>('history.series', metricRef ? goalRequest(context, { metricRef, granularity: 'friday' }, position.key === key ? position.cursor : null) : null);
  return <section aria-label={'История ' + (row.scopeName ?? row.assignment.scope.id)}><h3>{row.scopeName ?? row.assignment.scope.id}</h3><QueryFeedback loading={query.loading} error={query.error} />
    {metricRef && <label>Показатель истории<select value={`${metricRef.id}/${metricRef.revision}`} onChange={event => setSelection({ methodKey, metric: event.target.value })}>{metrics.map((ref, index) => <option key={`${ref.id}/${ref.revision}`} value={`${ref.id}/${ref.revision}`}>Показатель {index + 1} · {ref.id}, редакция {ref.revision}</option>)}</select></label>}
    {!metricRef && <p>Числовая история не применяется</p>}
    {query.data && <>{!query.data.points.length && <p>Новых измерений в выбранном периоде нет</p>}<ul>{query.data.points.map((point, i) => { const time = 'sourceBusinessTime' in point ? point.sourceBusinessTime : point.businessTime; return <li key={i}><p>{'friday' in point ? point.friday : 'date' in point ? point.date : 'Наблюдение'}: {displayExact(point.value)}</p>{'warning' in point && point.warning && <p>{point.warning}</p>}<p>Исходное измерение: {time?.kind === 'as_of' ? time.date : time?.kind === 'period' ? time.startInclusive : 'Неизвестно'}</p><p>Исходное получение: {point.sourceCapturedAt ?? 'Неизвестно'}</p></li>; })}</ul>{query.data.qualityFlags.map(flag => <p key={flag}>{flag}</p>)}{query.data.nextCursor && <button type="button" onClick={() => setPosition({ key, cursor: query.data!.nextCursor })}>Следующая страница истории</button>}</>}
  </section>;
}
export function WorkbenchGoalDetailPage({ goalId }: { goalId: string }) {
  const { context, setContext } = useGlobalContext();
  const [tab, setTab] = useState<(typeof tabs)[number]>('Состояние');
  const requestContext = context?.goalId === goalId ? context : null;
  const query = useGoalRead('goals.detail', requestContext ? goalRequest(requestContext) : null);
  const catalog = useWorkbenchQuery<WorkbenchReadModels['context.options']>('context.options', requestContext?.resultMode === 'current' ? goalRequest(requestContext) : null);
  const data = query.data, names = Object.fromEntries(catalog.data?.entities.map(entity => [entity.id, entity.name]) ?? []);
  const deliveries = Object.fromEntries(data?.tabs.enriched.map(item => [item.capture.id, item.obtainedVia]) ?? []);
  const basisFor = (row: GoalReadRow) => data?.tabs.calculation.find(basis => basis.id === row.basisRef?.id && basis.revision === row.basisRef.revision);
  const methodFor = (row: GoalReadRow) => {
    const basis = basisFor(row), ref = basis?.methodRef ?? (row.assignment.methodBinding.kind === 'standalone' ? row.assignment.methodBinding.methodRef : null);
    return data?.tabs.method.find(method => method.id === ref?.id && method.revision === ref.revision);
  };
  return <section aria-label="Карточка цели"><ResultModeSelector goalId={goalId} selectedSnapshot={data?.rows[0]?.snapshot} /><QueryFeedback loading={query.loading} error={query.error} operation={query.errorOperation} />
    {data && <><h2>{data.goal.title}</h2>{data.goal.description && <p>{data.goal.description}</p>}
      <p>Области: {data.rows.map(row => row.scopeName ?? row.assignment.scope.id).join('; ')}</p><p>Дата данных: {data.tabs.enriched[0]?.capture.sourceUpdatedAt ?? 'Неизвестна'}</p>
      <p>Официальные сроки: {data.rows.map(row => `${row.scopeName ?? row.assignment.scope.id}: ${row.assignment.officialDueOn ?? 'Не задан'}`).join('; ')}</p>
      <p>Следующий предметный шаг: {data.tabs.work.some(item => item.kind === 'work') ? 'Проверить связанные работы' : 'Проверить состояние и основания'}</p>
      <section aria-label="Сводка состояния цели" className="wb-goal-rows">{data.rows.map(row => <RowState key={row.ref.id} row={row} names={names} basis={basisFor(row)} method={methodFor(row)} deliveries={deliveries} />)}</section>
      <div className="wb-goal-tabs" role="tablist" aria-label="Разделы цели">{tabs.map(label => <button key={label} id={'goal-tab-' + tabs.indexOf(label)} type="button" role="tab" aria-selected={tab === label} aria-controls="goal-tab-panel" onClick={() => setTab(label)}>{label}</button>)}</div>
      <div id="goal-tab-panel" role="tabpanel" aria-labelledby={'goal-tab-' + tabs.indexOf(tab)}>
        {!data.rows.length && <p>Нет назначений в выбранной области</p>}
        {tab === 'Состояние' && <div className="wb-goal-rows">{data.rows.map(row => <BasisInspector key={row.ref.id} row={row} basis={basisFor(row)} method={methodFor(row)} deliveries={deliveries} variant="details" />)}</div>}
        {tab === 'Работы и решения' && <>{data.tabs.work.length ? data.tabs.work.map(item => <article key={item.ref.id}><h3>{item.title}</h3>{item.kind === 'work' && <><p>Следующий шаг: {item.value.nextAction ?? 'Не задан'}</p>{item.value.risk && <p>Риск: {item.value.risk.reason}</p>}</>}<ContextLink path={'/execution#' + item.kind + '/' + item.ref.id} label="Открыть работу или решение" /></article>) : <p>Связанных работ и решений нет</p>}<ContextLink path="/execution" label="Все работы и решения" /></>}
        {tab === 'Методика' && data.tabs.method.map(method => <article key={method.id}><h3>Методика, редакция {method.revision}</h3>{method.mode === 'manual_status' ? <p>Ручной статус</p> : <ul>{method.rules.map(rule => <li key={rule.metricRef.id}>Показатель {rule.metricRef.id}; вес {rule.originalWeight}; {rule.mandatory ? 'обязательный' : 'необязательный'}; условие {rule.condition.op === 'range' ? `${rule.condition.min}–${rule.condition.max}` : rule.condition.target}</li>)}</ul>}</article>)}
        {tab === 'Расчёт' && data.rows.map(row => <BasisInspector key={row.ref.id} row={row} basis={basisFor(row)} method={methodFor(row)} deliveries={deliveries} variant="details" />)}
        {(tab === 'Обогащённые данные' || tab === 'Исходные строки') && <>{data.tabs[tab === 'Исходные строки' ? 'raw' : 'enriched'].map(item => <article key={item.capture.id}><h3>Получение {item.capture.capturedAt}</h3><p>Дата источника: {item.capture.sourceUpdatedAt ?? 'Неизвестна'}</p><p>Доставка: {item.obtainedVia === 'git' ? 'Из Git' : 'Локальный кэш'}</p>{tab === 'Исходные строки' ? <table><caption>Исходные строки</caption><tbody>{item.capture.rawRows.map(row => <tr key={row.rowKey}><th scope="row">{row.rowKey}</th><td>{Object.entries(row.cells).map(([name, cell]) => `${name}: ${cell.original ?? 'Пусто'}`).join('; ')}</td></tr>)}</tbody></table> : <table><caption>Обогащённые данные</caption><tbody>{item.capture.canonicalRows.map(row => <tr key={row.rowKey}><th scope="row">{row.rowKey}</th><td>{Object.entries(row.numbers).map(([name, value]) => `${name}: ${displayExact(value)}`).join('; ')}</td><td>{Object.entries(row.dimensions).map(([name, value]) => `${name}: ${value ?? 'Не сопоставлено'}`).join('; ')}</td></tr>)}</tbody></table>}<ContextLink path="/data" label="Открыть набор данных" /></article>)}{!data.tabs.raw.length && <p>Нет данных</p>}</>}
        {tab === 'История' && requestContext && <>{data.rows.length === 1 ? <GoalHistory key={data.rows[0].ref.id} row={data.rows[0]} context={requestContext} method={methodFor(data.rows[0])} /> : <><p>У независимых назначений нет единого временного ряда. Выберите область для истории.</p>{data.rows.filter(row => row.assignment.scope.kind === 'cluster').map(row => <button key={row.ref.id} type="button" onClick={() => { void setContext({ scopePath: { clusterId: row.assignment.scope.id } }).catch(() => undefined); }}>История области: {row.scopeName ?? row.assignment.scope.id}</button>)}</>}<p>Согласованных срезов: {data.tabs.history.length}</p></>}
      </div>
    </>}
  </section>;
}
