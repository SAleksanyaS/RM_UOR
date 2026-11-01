import { useEffect, useRef, useState } from 'react';
import { useWorkbench } from '../../../app/workbench/context';
import type { CaptureResult } from '../workbench-source-contracts';
import { browserProblem, useBrowserOperation } from './shared-browser-client';
import { DataJobError, observeDataJob } from '../../sources/workbench/data-client';
import type { JobSnapshot } from '../../../server/workbench/protocol';

/** Capture has its own job observer: opening a login window does not replace it. */
export function SharedBrowserCapture({ goalId, configured, previous, onCaptured }: { goalId: string; configured: boolean; previous?: Pick<CaptureResult, 'captureRef' | 'acceptedRows' | 'rejectedRows'>; onCaptured(): void }) {
  const { session, client } = useWorkbench();
  const storageKey = `wb.browser.capture:${session?.personId ?? 'unassigned'}:${goalId}`;
  const remember = (id: string | null) => { try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch { /* Server jobs stay owned and continue if storage is unavailable. */ } };
  const [restoreId] = useState(() => { try { return sessionStorage.getItem(storageKey); } catch { return null; } });
  const [restoreEpoch, refreshRestore] = useState(0);
  const [restoredJob, setRestoredJob] = useState<JobSnapshot | null>(null), [restoreError, setRestoreError] = useState<unknown>(null), [restoring, setRestoring] = useState(!!restoreId);
  const captured = useRef(onCaptured); captured.current = onCaptured;
  const capture = useBrowserOperation(remember), controls = useBrowserOperation();
  const [result, setResult] = useState<CaptureResult | null>(null);
  const baseJob = capture.job ?? restoredJob;
  const job = controls.job?.jobId === baseJob?.jobId ? controls.job : baseJob;
  const done = (value: CaptureResult) => { setResult(value); remember(null); onCaptured(); };
  useEffect(() => {
    if (!restoreId) return; const observer = new AbortController(); setRestoring(true); setRestoreError(null);
    void observeDataJob<CaptureResult>(client, restoreId, observer.signal, undefined, setRestoredJob, 500).then(value => { if (!observer.signal.aborted) { setResult(value); remember(null); captured.current(); } }, error => { if (!observer.signal.aborted) { if (error instanceof DataJobError) setRestoredJob(error.job); setRestoreError(error); } }).finally(() => { if (!observer.signal.aborted) setRestoring(false); });
    return () => observer.abort();
  }, [client, restoreId, restoreEpoch]);
  const shown = result ?? previous;
  const start = () => capture.run(async () => { setRestoreError(null); done((await capture.command<CaptureResult>('source.capture', { goalId })).result); });
  const control = (name: string) => controls.run(async () => { capture.setError(null); setRestoreError(null); const response = await controls.command<CaptureResult>(name, { jobId: job!.jobId }); if (response.result.captureRef) done(response.result); });
  return <section aria-label="Получение данных ОКО">
    <button type="button" disabled={!configured || restoring || !!restoreId && !job || capture.busy || controls.busy || !session?.allowedCommands.includes('source.capture') || !!job && ['queued', 'running', 'waiting_user', 'retry_wait', 'interrupted'].includes(job.status)} onClick={() => { void start(); }}>Обновить данные</button>
    {job && <p role="status">Задание получения: {job.status} · {job.stage}; {job.progress.completed}{job.progress.total !== null ? ` / ${job.progress.total}` : ''}.</p>}
    {job?.cancelAvailable && <button type="button" disabled={controls.busy} onClick={() => { void control('job.cancel'); }}>Отменить получение</button>}
    {job?.retryAvailable && <button type="button" disabled={capture.busy || controls.busy} onClick={() => { void control('job.retry'); }}>Продолжить получение</button>}
    {capture.error !== null && <p role="alert">{browserProblem(capture.error)} Последний успешный набор сохранён.</p>}
    {controls.error !== null && <p role="alert">{browserProblem(controls.error)}</p>}
    {restoreError !== null && <div role="alert">{browserProblem(restoreError)}<button type="button" disabled={restoring} onClick={() => refreshRestore(v => v + 1)}>Обновить состояние прежнего получения</button></div>}
    {shown && <div><p role="status">{result ? 'Получение завершено' : 'Сохранённая личная выгрузка'}: принято {shown.acceptedRows}, отклонено {shown.rejectedRows}.</p><a href={`/api/v1/browser/results/${encodeURIComponent(shown.captureRef.id)}/original`} download>Скачать исходную выгрузку</a>{' '}<a href={`/api/v1/browser/results/${encodeURIComponent(shown.captureRef.id)}/enriched`} download>Скачать обогащённый CSV</a></div>}
  </section>;
}
