import type { WorkbenchClient } from '../../../app/workbench/api-client';
import type { AnyQueryRequest, CommandRequest, CommandResult, JobSnapshot } from '../../../server/workbench/protocol';
import { useEffect, useRef, useState } from 'react';
import { useWorkbench } from '../../../app/workbench/context';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import type { BusinessTime } from '../../../domain/workbench/primitives';

export class DataJobError extends Error {
  constructor(public readonly job: JobSnapshot) { super(job.error ? `${job.error.message} (${job.error.code})` : 'Операция приостановлена. Выберите доступное действие задания.'); }
}
export const definitiveDataRejection = (error: unknown) => error instanceof WorkbenchApiError && error.status === 422 && error.problem.code !== 'INVALID_RESPONSE';
export function useRetainedDataQuery<T>(name: string, input: AnyQueryRequest | null, refreshRevision = 0) {
  const { client, session } = useWorkbench();
  const owner = useRef({ client, generation: 0 });
  if (owner.current.client !== client) owner.current = { client, generation: owner.current.generation + 1 };
  const key = JSON.stringify([name, input, owner.current.generation, session?.personId, session?.role]);
  const sequence = useRef(0);
  const [state, setState] = useState<{ key: string; data: T | null; loading: boolean; error: unknown }>({ key, data: null, loading: false, error: null });
  useEffect(() => {
    const current = ++sequence.current, controller = new AbortController();
    if (!session || !input) { setState({ key, data: null, loading: false, error: null }); return () => { sequence.current++; controller.abort(); }; }
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: null }));
    void client.query<T>(name, input, { signal: controller.signal }).then(response => {
      if (sequence.current === current && !controller.signal.aborted) setState({ key, data: response.data, loading: false, error: null });
    }, error => {
      if (sequence.current === current && !controller.signal.aborted) setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: false, error }));
    });
    return () => { sequence.current++; controller.abort(); };
    // key is the complete serializable request and owner; refresh is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, session, key, refreshRevision]);
  return state.key === key ? state : { key, data: null, loading: session !== null && input !== null, error: null };
}

export async function runDataCommand<T>(client: WorkbenchClient, request: CommandRequest, signal: AbortSignal, progress?: (stage: string) => void, onJob?: (job: JobSnapshot) => void): Promise<T> {
  if (signal.aborted) throw new Error('Просмотр закрыт');
  const response = await client.command<CommandResult>(request);
  if ('result' in response.data) return response.data.result as T;
  return observeDataJob<T>(client, response.data.jobId, signal, progress, onJob, response.data.pollAfterMs);
}
export async function observeDataJob<T>(client: WorkbenchClient, jobId: string, signal: AbortSignal, progress?: (stage: string) => void, onJob?: (job: JobSnapshot) => void, pollAfterMs = 1000): Promise<T> {
  while (!signal.aborted) {
    const { data: job } = await client.job(jobId);
    if (signal.aborted) break;
    onJob?.(job);
    progress?.(({ 'import.read': 'Чтение файла', 'import.parse': 'Разбор значений', 'import.preview': 'Проверка строк', 'import.commit': 'Сохранение выбранных строк', 'source.check': 'Проверка источника', 'source.collect': 'Получение выгрузки', 'source.normalize': 'Разбор значений', 'source.enrich': 'Обогащение', 'source.commit': 'Сохранение набора' } as Record<string, string>)[job.stage] ?? 'Обработка');
    if (job.status === 'succeeded' || job.status === 'partial') return job.result as T;
    if (job.error || ['waiting_user', 'retry_wait', 'cancelled', 'interrupted', 'failed'].includes(job.status)) throw new DataJobError(job);
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, pollAfterMs);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  throw new Error('Просмотр закрыт');
}
export function dataError(error: unknown, operation: 'read' | 'mutation' = 'mutation'): string {
  return error instanceof DataJobError ? error.message : workbenchErrorMessage(error, operation);
}
export const dataPageRequest = { filter: {}, sort: [], page: { limit: 100, cursor: null } };
export function formatDataTime(time: BusinessTime): string {
  return time.kind === 'unknown' ? 'Дата неизвестна' : time.kind === 'as_of' ? time.date : `${time.startInclusive} — ${time.endExclusive} (конец не включён)`;
}
export function dataIssueLabel(code: string, message: string): string {
  const labels: Record<string, string> = { INVALID_NUMBER: 'Некорректное число', INVALID_BUSINESS_DATE: 'Некорректная дата или граница периода', UNKNOWN_BUSINESS_DATE: 'Дата наблюдения неизвестна', missing_reducer_component: 'Недостаточно значений для расчёта строки', REQUIRED_SCOPE_UNRESOLVED: 'Продукт не сопоставлен с ожидаемым составом', MANUAL_CORRECTION_DISCREPANCY: 'Новая выгрузка отличается от ручной поправки. Ручная поправка сохраняется', IMPORT_ROWS_NOT_ACCEPTED: 'Часть строк не принята' };
  return `${labels[code] ?? (message && message !== code ? message : 'Требуется проверка строки')} (${code})`;
}
