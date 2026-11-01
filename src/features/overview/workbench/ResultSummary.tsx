import type { GoalReadRow } from '../../catalog/workbench-read-models';
import { displayExact } from './goal-view-utils';

export function ResultSummary({ row, names = {} }: { row: GoalReadRow; names?: Record<string, string> }) {
  const result = row.numericResult;
  return <div>
    {row.goal.mode === 'manual_status' ? <p>{row.manualStatus ? ({ not_started: 'Не начата', in_progress: 'В работе', completed: 'Завершена' }[row.manualStatus.to]) : 'Ручной статус не задан'}</p> : !result ? <p>{row.needs_calculation ? 'Требуется подготовить расчёт' : 'Нет данных'}</p> : <>
      {result.scorePercent !== null && <p>Итоговый балл: <strong>{displayExact(result.scorePercent)}%</strong></p>}
      {result.calculation === 'preliminary' && <><p>Предварительный результат</p>{result.preliminaryPercent !== null && <p>Предварительный балл: {displayExact(result.preliminaryPercent)}%</p>}</>}
      <p>{({ ready: 'Расчёт готов', preliminary: 'Данные неполны', no_data: 'Нет данных', not_applicable: 'Не применимо', blocked: 'Расчёт заблокирован' })[result.calculation]}</p>
      <p>{({ met: 'Условие выполнено', not_met: 'Условие не выполнено', unknown: 'Выполнение не определено', not_applicable: 'Условие не применимо' })[result.achievement]}</p>
      <p>{({ fresh: 'Данные актуальны', stale: 'Данные устарели', unknown: 'Свежесть данных неизвестна' })[result.freshness]}</p>
      {result.coveragePercent !== null && <p>Покрытие показателей: {displayExact(result.coveragePercent)}%</p>}
      {!result.complete && result.calculation !== 'preliminary' && <p>Данные неполны</p>}
      {result.missingPopulation.length > 0 && <><h4>Недостающие участники</h4><ul>{result.missingPopulation.map(item => <li key={item.metricId + item.scope.id}>{names[item.scope.id] ?? item.scope.id}</li>)}</ul></>}
      {result.missingMetricIds.length > 0 && <p>Не получены показатели: {result.missingMetricIds.map(id => names[id] ?? id).join(', ')}</p>}
      {result.qualityFlags.length > 0 && <details><summary>Причины качества данных</summary><ul>{result.qualityFlags.map(flag => <li key={flag}>{flag}</li>)}</ul></details>}
    </>}
    <p>{row.attestation ? 'Подтверждено УОР' : 'Подтверждение УОР отсутствует'}</p>
    {row.attestation && <p>{row.attestation.comment} · {row.attestation.recordedAt}</p>}
    <p>Ответственный: {row.leader?.name ?? (row.snapshot ? 'Историческое имя не сохранено' : 'Не назначен')}</p>
    <p>Официальный срок: {row.assignment.officialDueOn ?? 'Не задан'}</p>
    {row.warnings.map(warning => <p key={warning}>{warning === 'PUBLICATION_TIME_UNVERIFIED' ? 'Время публикации не подтверждено' : warning === 'HISTORICAL_DIRECTORY_LABELS_UNAVAILABLE' ? 'Исторические имена справочника недоступны' : warning}</p>)}
    {row.unavailableReason && <p role="status">{row.unavailableReason === 'AGREED_SNAPSHOT_UNAVAILABLE' ? 'Согласованный срез не опубликован' : row.unavailableReason}</p>}
    <p>Следующий шаг: {row.nextActions.find(action => action.enabled)?.label ?? 'Проверьте основания'}</p>
  </div>;
}
