import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import type { EvaluationBasis, MethodVersion, NumericCondition } from '../../../domain/workbench/entities';
import type { VersionRef } from '../../../domain/workbench/primitives';
import type { GoalReadRow, WorkbenchReadModels } from '../../catalog/workbench-read-models';
import { ContextLink, displayExact, goalRequest, QueryFeedback } from './goal-view-utils';

function conditionText(condition: NumericCondition, unit: string) {
  return condition.op === 'range' ? `${condition.min}–${condition.max}${unit}` : `${({ gte: '≥', lte: '≤', eq: '=' })[condition.op]} ${condition.target}${unit}`;
}
function Lineage({ row, reference, kind, method, deliveries, variant }: { row: GoalReadRow; reference: VersionRef; kind: 'resultRef' | 'factRef'; method?: MethodVersion; deliveries: Record<string, 'git' | 'local-cache'>; variant: 'all' | 'summary' | 'details' }) {
  const { context } = useGlobalContext();
  const query = useWorkbenchQuery<WorkbenchReadModels['data.lineage']>('data.lineage', context ? goalRequest({ ...context, goalId: row.goal.id }, { [kind]: reference }) : null);
  const data = query.data, resolvedMethod = data?.method ?? method;
  return <><QueryFeedback loading={query.loading} error={query.error} />{data && <>
    {data.facts.map(fact => <div key={fact.id + '/' + fact.revision}>{variant !== 'details' && <p className="wb-basis-fact">Факт: <strong>{displayExact(fact.value)}{fact.unitCode === 'percent' && fact.value !== null ? '%' : fact.value !== null ? ` ${fact.unitCode}` : ''}</strong></p>}{variant !== 'summary' && <><p>Дата измерения: {fact.businessTime.kind === 'as_of' ? fact.businessTime.date : fact.businessTime.kind === 'period' ? `${fact.businessTime.startInclusive} — ${fact.businessTime.endExclusive} (не включая)` : 'Неизвестна'}</p><p>Исходные строки: {fact.lineage.sourceRowKeys.join(', ')}</p></>}</div>)}
    {variant !== 'details' && resolvedMethod?.mode === 'numeric' && resolvedMethod.rules.filter(rule => kind === 'resultRef' || data.facts.some(fact => fact.metricId === rule.metricRef.id)).map(rule => <p className="wb-basis-threshold" key={rule.metricRef.id}>Порог: {conditionText(rule.condition, data.facts.find(fact => fact.metricId === rule.metricRef.id)?.unitCode === 'percent' ? '%' : '')}</p>)}
    {variant !== 'summary' && <>{data.captures.map(capture => <div key={capture.id}><p>Дата источника: {capture.sourceUpdatedAt ?? 'Неизвестна'}</p><p>Получено: {capture.capturedAt}</p><p>Способ получения: {capture.obtainedVia === 'direct' ? 'Напрямую' : 'Импорт файла'}</p>{deliveries[capture.id] && <p>Доставка: {deliveries[capture.id] === 'local-cache' ? 'Локальный кэш' : 'Из Git'}</p>}</div>)}
    <details><summary>Версии основания</summary><p>Редакция методики: {resolvedMethod?.revision ?? 'Неизвестна'}</p><ul>{data.mappings.map(mapping => <li key={mapping.id}>Сопоставление {mapping.id}, редакция {mapping.revision}</li>)}</ul><p>Факты: {data.facts.map(fact => `${fact.id}, редакция ${fact.revision}`).join('; ')}</p></details></>}
  </>}</>;
}
export function BasisInspector({ row, basis, method, deliveries = {}, variant = 'all' }: { row: GoalReadRow; basis?: EvaluationBasis; method?: MethodVersion; deliveries?: Record<string, 'git' | 'local-cache'>; variant?: 'all' | 'summary' | 'details' }) {
  return <div aria-label="Основание результата">
    {row.resultRef ? <Lineage row={row} reference={row.resultRef} kind="resultRef" method={method} deliveries={deliveries} variant={variant} /> : basis?.factRefs.length ? basis.factRefs.map(reference => <Lineage key={reference.id + '/' + reference.revision} row={row} reference={reference} kind="factRef" method={method} deliveries={deliveries} variant={variant} />) : <p>{row.goal.mode === 'manual_status' ? 'Числовое основание не применяется' : 'Основание расчёта отсутствует'}</p>}
    {variant !== 'summary' && basis && <p>Основание: {basis.id}, редакция {basis.revision}</p>}
    {row.resultRef ? <ContextLink path={`/data?result=${row.resultRef.id}&resultRevision=${row.resultRef.revision}`} label="Открыть источник и данные" /> : basis?.factRefs.length ? basis.factRefs.map(reference => <p key={reference.id}><ContextLink path={`/data?fact=${reference.id}&factRevision=${reference.revision}`} label="Открыть источник и данные" /></p>) : <ContextLink path="/data" label="Открыть источник и данные" />}
  </div>;
}
