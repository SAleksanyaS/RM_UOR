import { useEffect, useRef, useState } from 'react';
import type { FileFactCorrectionCandidate, ImportApplyResult, ImportPreviewResult } from '../../tabular-import/workbench-import';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import type { CommandRequest } from '../../../server/workbench/protocol';
import { useGlobalContext, useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import { dataError, dataIssueLabel, dataPageRequest, formatDataTime, runDataCommand } from './data-client';

function CorrectionDiff({ correction }: { correction: FileFactCorrectionCandidate }) {
  const { context } = useGlobalContext();
  const before = useWorkbenchQuery<WorkbenchReadModels['data.lineage']>('data.lineage', context ? { ...dataPageRequest, context, filter: { factRef: correction.beforeFactRef } } : null);
  const previous = before.data?.facts.find(f => f.id === correction.beforeFactRef.id && f.revision === correction.beforeFactRef.revision);
  return <span>{previous ? `Было: ${typeof previous.value === 'string' ? previous.value : JSON.stringify(previous.value)}; станет: ${typeof correction.afterFact.value === 'string' ? correction.afterFact.value : JSON.stringify(correction.afterFact.value)}` : before.error ? 'Исходное значение недоступно; изменение требует повторной проверки' : 'Загружаем исходное значение…'}</span>;
}
export function ImportPreview({ preview, onApplied }: { preview: ImportPreviewResult; onApplied(result: ImportApplyResult): void }) {
  const { client, loading } = useWorkbench();
  const [selected, setSelected] = useState<string[]>([]), [corrections, setCorrections] = useState<string[]>([]);
  const [result, setResult] = useState<ImportApplyResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [stage, setStage] = useState('');
  const lifetime = useRef<AbortController | null>(null), request = useRef<CommandRequest | null>(null);
  useEffect(() => { const owner = new AbortController(); lifetime.current = owner; return () => { owner.abort(); }; }, []);
  const change = (id: string, checked: boolean, kind: 'row' | 'correction') => {
    if (busy || result) return;
    request.current = null; setError(null);
    const update = (values: string[]) => checked ? [...values, id] : values.filter(v => v !== id);
    (kind === 'row' ? setSelected : setCorrections)(update);
  };
  const valid = preview.rows.filter(row => row.acceptable && !preview.corrections.some(c => c.afterFact.id === row.proposedFact?.id));
  const apply = async () => {
    const owner = lifetime.current; if (!owner || busy || result || loading) return;
    request.current ??= { commandId: crypto.randomUUID(), name: 'import.apply', baseRevision: null, payload: { previewToken: preview.previewToken, acceptedRowIds: selected, acceptedCorrectionIds: corrections } };
    setBusy(true); setError(null);
    try { const accepted = await runDataCommand<ImportApplyResult>(client, request.current, owner.signal, setStage); if (!owner.signal.aborted) { setResult(accepted); onApplied(accepted); } }
    catch (failure) { if (!owner.signal.aborted) setError(failure); }
    finally { if (!owner.signal.aborted) setBusy(false); }
  };
  const rejected = result ? preview.rows.filter(r => result.rejectedRowIds.includes(r.id)) : preview.rows.filter(r => !r.acceptable);
  return <section role="region" aria-label="Предпросмотр импорта" aria-busy={busy} className="wb-panel">
    <h2>Предпросмотр импорта</h2><p className="wb-status-note">Файл ещё не создаёт подтверждение УОР. Выберите строки и изменения явно.</p>
    {preview.issues.map((issue, i) => <p key={i}>{dataIssueLabel(issue.code, issue.message)}</p>)}
    {!preview.complete && <p className="wb-risk-note">Набор неполный. Отсутствующие значения не заменяются нулём.</p>}
    <dl className="wb-import-metrics"><div><dt>Строк в файле</dt><dd>{preview.rows.length}</dd></div><div><dt>Выбрано новых строк</dt><dd>{selected.length}</dd></div><div><dt>Выбрано исправлений</dt><dd>{corrections.length}</dd></div><div><dt>Строк с проблемами</dt><dd>{preview.rows.filter(row => !row.acceptable).length}</dd></div></dl>
    <div className="wb-form-actions"><button type="button" disabled={busy || result !== null} onClick={() => { request.current = null; setSelected(valid.map(r => r.id)); }}>Выбрать корректные строки</button></div>
    <div className="wb-table-scroll" role="region" aria-label="Строки предпросмотра" tabIndex={0}><table className="wb-data-table"><caption className="wb-visually-hidden">Строки файла</caption><thead><tr><th>Выбор</th><th>Строка</th><th>Значение</th><th>Исходная дата / период</th><th>Проверка</th></tr></thead><tbody>{preview.rows.map(row => {
      const revision = preview.corrections.find(c => c.afterFact.id === row.proposedFact?.id);
      return <tr key={row.id}><td>{!revision && <input type="checkbox" aria-label={'Принять строку ' + row.coordinate.row} disabled={!row.acceptable || busy || result !== null} checked={selected.includes(row.id)} onChange={e => change(row.id, e.target.checked, 'row')} />}</td><td>{row.coordinate.sheet ?? 'CSV'}: {row.coordinate.row}</td><td>{row.proposedFact?.value === null || !row.proposedFact ? 'Нет данных' : typeof row.proposedFact.value === 'string' ? row.proposedFact.value : JSON.stringify(row.proposedFact.value)}</td><td>{row.proposedFact ? formatDataTime(row.proposedFact.businessTime) : 'Не разобрана'}</td><td>{row.problems.map(p => dataIssueLabel(p.code, p.message)).join('; ') || 'Корректна'}</td></tr>;
    })}</tbody></table></div>
    {preview.corrections.length > 0 && <fieldset className="wb-form-section" disabled={busy || result !== null}><legend>Изменения прежних фактов</legend>{preview.corrections.map(c => <label className="wb-check-label" key={c.id}><input type="checkbox" aria-label={'Принять изменение ' + c.beforeFactRef.id} checked={corrections.includes(c.id)} onChange={e => change(c.id, e.target.checked, 'correction')} /><CorrectionDiff correction={c} /></label>)}</fieldset>}
    <div className="wb-form-actions"><button className="wb-primary-button" type="button" disabled={busy || loading || result !== null || selected.length + corrections.length === 0} onClick={() => { void apply(); }}>Принять выбранные строки</button></div>
    {busy && <p role="status">Принимаем данные: {stage}</p>}
    {error !== null && <p role="alert">{dataError(error)} <button type="button" disabled={busy} onClick={() => { void apply(); }}>Повторить принятие</button></p>}
    {result && <p role="status">Принято: {result.acceptedRowIds.length + result.acceptedCorrectionIds.length}; не принято: {result.rejectedRowIds.length}</p>}
    {rejected.length > 0 && <section role="region" aria-label="Непринятые строки"><h3>Непринятые строки</h3><ul>{rejected.map(row => <li key={row.id}>Строка {row.coordinate.row}: {row.problems.map(p => dataIssueLabel(p.code, p.message)).join('; ') || 'Не выбрана для принятия'}</li>)}</ul><p>Исправьте эти строки в файле и загрузите исправленный файл. Принятые факты сохранятся.</p></section>}
  </section>;
}
