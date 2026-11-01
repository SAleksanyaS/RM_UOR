import type { VersionRef } from '../../../domain/workbench/primitives';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import { dataError, dataPageRequest, formatDataTime } from './data-client';

export function LineagePanel({ factRef, resultRef, onClose }: { factRef?: VersionRef; resultRef?: VersionRef; onClose?(): void }) {
  const { context } = useGlobalContext();
  const filter = resultRef ? { resultRef } : factRef ? { factRef } : null;
  const query = useWorkbenchQuery<WorkbenchReadModels['data.lineage']>('data.lineage', context && filter ? { ...dataPageRequest, context, filter } : null);
  return <section role="region" aria-label="Происхождение данных" className="wb-panel"><header className="wb-section-header"><div><span className="wb-eyebrow">Точное основание</span><h2>Происхождение данных</h2></div>{onClose && <button type="button" onClick={onClose}>Закрыть происхождение</button>}</header>
    {query.loading && <p role="status">Загружаем основание…</p>}{query.error !== null && <p role="alert">{dataError(query.error, 'read')}</p>}
    {query.data && <div className="wb-lineage-chain"><section><h3>Факты</h3>{query.data.facts.map(fact => <article key={fact.id + '/' + fact.revision}><p>Значение: {fact.value === null ? 'Нет данных' : typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value)} {fact.unitCode}</p><p>Исходная дата / период: {formatDataTime(fact.businessTime)}</p><p>Редакция факта: {fact.revision}; строки: {fact.lineage.sourceRowKeys.join(', ')}</p><details><summary>Ссылки на основание факта</summary><p>Источник: {fact.sourceId}; получение: {fact.captureId}</p><p>Область: {fact.scope.kind} / {fact.scope.id}</p></details></article>)}
      </section><section><h3>Получение и исходник</h3>{query.data.captures.map(capture => <article key={capture.id}><p>Получено: {capture.capturedAt}; дата обновления источника: {capture.sourceUpdatedAt ?? 'неизвестна'}</p><p>Способ: {capture.obtainedVia === 'file_import' ? 'Файл' : 'Штатный источник'}; принято: {capture.acceptedRows}; не принято: {capture.rejectedRows}</p><details className="wb-technical-details"><summary>Контрольная сумма исходника</summary><code>{capture.payloadHash}</code></details></article>)}
      </section><section role="region" aria-label="Исходные строки основания"><h3>Исходные строки основания</h3>{query.data.captures.map(capture => {
        const rowKeys = new Set(query.data!.facts.filter(fact => fact.captureId === capture.id).flatMap(fact => fact.lineage.sourceRowKeys));
        return <article key={capture.id + '/' + capture.revision}><p>Точное получение: {capture.id}, редакция {capture.revision}</p><div className="wb-table-scroll" role="region" aria-label="Точные исходные строки" tabIndex={0}><table className="wb-data-table"><thead><tr><th>Ключ строки</th><th>Исходные значения</th></tr></thead><tbody>{capture.rawRows.filter(row => rowKeys.has(row.rowKey)).map(row => <tr key={row.rowKey}><td>{row.rowKey}</td><td>{Object.entries(row.cells).map(([name, cell]) => `${name}: ${cell.original ?? 'пусто'}`).join('; ')}</td></tr>)}</tbody></table></div>{[...rowKeys].some(key => !capture.rawRows.some(row => row.rowKey === key)) && <p>Часть исходных строк этого основания недоступна. Последний набор их не заменяет.</p>}</article>;
      })}</section>
      <section><h3>Соответствие и обогащение</h3>{query.data.mappings.map(mapping => <article key={mapping.id + '/' + mapping.revision}><p>Редакция соответствия: {mapping.revision}; лист: {mapping.parsingProfile?.sheetName ?? 'первый лист'}</p><p>Формат даты: {mapping.parsingProfile?.dateFormat ?? 'ISO'}; десятичный знак: {mapping.parsingProfile?.decimalSeparator ?? '.'}; кодировка CSV: {mapping.parsingProfile?.csvEncoding ?? 'utf8'}</p><details><summary>Ссылка на соответствие</summary>{mapping.id}</details></article>)}
      <p>Организационные связи: {query.data.directoryLinks.length}. Обогащение и расчёт используют отдельные сохранённые основания.</p>
      {query.data.method && <p>Методика: {query.data.method.id}, редакция {query.data.method.revision}</p>}
    </section></div>}
  </section>;
}
