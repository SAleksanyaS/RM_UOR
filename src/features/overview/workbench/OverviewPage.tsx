import { useState } from 'react';
import { useGlobalContext } from '../../../app/workbench/context';
import { useGoalRead } from './use-goal-read';
import { ContextLink, GoalOpenButton, goalRequest, QueryFeedback, ResultModeSelector } from './goal-view-utils';
import { ResultSummary } from './ResultSummary';

export function WorkbenchOverviewPage() {
  const { context } = useGlobalContext();
  const [kind, setKind] = useState<'goal' | 'work' | 'decision' | 'data' | ''>('');
  const query = useGoalRead('overview', context ? goalRequest(context, { kind: kind || null }) : null);
  const data = query.data;
  return <section aria-label="Ситуация в выбранной области"><ResultModeSelector /><label>Исключения<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="">Все</option><option value="goal">Цели</option><option value="work">Работы</option><option value="decision">Решения</option><option value="data">Данные</option></select></label>
    <QueryFeedback loading={query.loading} error={query.error} operation={query.errorOperation} />
    {data && <><p>Целей: {data.counts.goals} · Работ: {data.counts.works} · Решений: {data.counts.decisions} · Проблем данных: {data.counts.data}</p>
      <h2>Отклонения целей</h2>{data.goals.filter(row => row.numericResult?.achievement !== 'met' || row.numericResult.freshness !== 'fresh' || !row.attestation).map(row => <article key={row.ref.id}><h3>{row.goal.title} · {row.scopeName ?? row.assignment.scope.id}</h3><ResultSummary row={row} /><GoalOpenButton goalId={row.goal.id} title={row.goal.title} /></article>)}
      <h2>Работы и решения</h2>{data.execution.length ? data.execution.map(item => <p key={item.ref.id}><ContextLink path={'/execution#' + item.kind + '/' + item.ref.id} label={item.title} /></p>) : <p>Связанных работ и решений нет</p>}
      <h2>Проблемы данных</h2><p>Наборов с частичной загрузкой: {data.counts.data}</p><ContextLink path="/data" label="Проверить источники и данные" />
      {!data.goals.length && !data.execution.length && <p>Нет объектов по фильтру</p>}
    </>}
  </section>;
}
