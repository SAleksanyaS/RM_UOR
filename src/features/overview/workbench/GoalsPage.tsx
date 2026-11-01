import { useState } from 'react';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import { useGoalRead } from './use-goal-read';
import { GoalOpenButton, goalRequest, QueryFeedback, ResultModeSelector } from './goal-view-utils';
import { ResultSummary } from './ResultSummary';
import { BasisInspector } from './BasisInspector';
import type { GoalReadRow, WorkbenchReadModels } from '../../catalog/workbench-read-models';

function RequirementFacts({ row }: { row: GoalReadRow }) {
  const { context } = useGlobalContext();
  const detail = useWorkbenchQuery<WorkbenchReadModels['goals.detail']>('goals.detail', row.snapshot && context ? goalRequest({ ...context, goalId: row.goal.id }) : null);
  const basis = detail.data?.tabs.calculation.find(item => item.id === row.basisRef?.id && item.revision === row.basisRef.revision);
  const method = detail.data?.tabs.method.find(item => item.id === basis?.methodRef.id && item.revision === basis.methodRef.revision);
  return <><QueryFeedback loading={detail.loading} error={detail.error} /><BasisInspector row={row} basis={basis} method={method} variant="summary" /></>;
}

export function WorkbenchGoalsPage() {
  const { context } = useGlobalContext();
  const [position, setPosition] = useState<{ selection: string; cursor: string | null }>({ selection: '', cursor: null });
  const selection = JSON.stringify(context), cursor = position.selection === selection ? position.cursor : null;
  const query = useGoalRead('goals.list', context ? goalRequest(context, {}, cursor) : null);
  return <section aria-label="Список целей"><ResultModeSelector selectedSnapshot={query.data?.items[0]?.snapshot} /><QueryFeedback loading={query.loading} error={query.error} operation={query.errorOperation} />
    {query.data && <>{!query.data.items.length && <p>Нет объектов по фильтру</p>}{query.data.items.map(row => <article key={row.ref.id}><h2>{row.goal.title}</h2><p>Область: {row.scopeName ?? row.assignment.scope.id}</p><ResultSummary row={row} /><RequirementFacts row={row} /><GoalOpenButton goalId={row.goal.id} title={row.goal.title} /></article>)}
      {cursor && <button type="button" onClick={() => setPosition({ selection, cursor: null })}>К началу списка</button>}
      {query.data.page.nextCursor && <button type="button" onClick={() => setPosition({ selection, cursor: query.data!.page.nextCursor })}>Следующая страница целей</button>}
    </>}
  </section>;
}
