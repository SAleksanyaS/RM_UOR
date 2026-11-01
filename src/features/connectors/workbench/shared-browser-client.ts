import { useEffect, useRef, useState } from 'react';
import { useWorkbench } from '../../../app/workbench/context';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import type { CommandRequest, CommandResult, JobSnapshot } from '../../../server/workbench/protocol';
import { observeDataJob, DataJobError } from '../../sources/workbench/data-client';

export const browserOwnRequest = { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } };
/** A lost response retries the immutable request with its original commandId. Polling never replaces form state. */
export function useBrowserOperation(onAccepted?: (jobId: string) => void) {
  const { client } = useWorkbench();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [job, setJob] = useState<JobSnapshot | null>(null);
  const lifetime = useRef<AbortController | null>(null), running = useRef(false);
  const pending = useRef<CommandRequest | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, [client]);
  const command = async <T,>(name: string, payload: Record<string, unknown>, baseRevision: string | null = null): Promise<{ result: T; editToken: string | null }> => {
    if (!lifetime.current || lifetime.current.signal.aborted) throw Error('Просмотр закрыт');
    if (pending.current && (pending.current.name !== name || JSON.stringify(pending.current.payload) !== JSON.stringify(payload))) throw Error('Сначала повторите незавершённую операцию с прежними значениями.');
    const request = pending.current ?? { commandId: crypto.randomUUID(), name, payload: structuredClone(payload), baseRevision }; pending.current = request;
    try {
      const { data } = await client.command<CommandResult>(request);
      if ('result' in data) { pending.current = null; return { result: data.result as T, editToken: data.editToken }; }
      onAccepted?.(data.jobId);
      const result = await observeDataJob<T>(client, data.jobId, lifetime.current.signal, undefined, setJob, Math.min(data.pollAfterMs, 500));
      pending.current = null; return { result, editToken: null };
    } catch (failure) {
      if (failure instanceof DataJobError || failure instanceof WorkbenchApiError && failure.status < 500 && failure.problem.code !== 'INVALID_RESPONSE') pending.current = null;
      throw failure;
    }
  };
  const run = async (action: () => Promise<void>) => {
    if (running.current) return; running.current = true; setBusy(true); setError(null);
    try { await action(); } catch (failure) { if (!lifetime.current?.signal.aborted) setError(failure); }
    finally { running.current = false; if (!lifetime.current?.signal.aborted) setBusy(false); }
  };
  return { command, run, busy, error, job, unknown: pending.current !== null, setError };
}
export function browserProblem(error: unknown): string {
  const code = error instanceof WorkbenchApiError ? error.problem.code : error instanceof DataJobError ? error.job.error?.code : null;
  const messages: Record<string, string> = { BROWSER_CONFIGURATION_REQUIRED: 'Настройте личный браузер и разрешённые сайты.', PROFILE_IN_USE: 'Профиль занят. Завершите другую операцию и повторите.', AUTH_REQUIRED: 'Нужно войти в открытом браузере.', SOURCE_UNAVAILABLE: 'Источник недоступен. Проверьте подключение и повторите.', SELECTOR_NOT_FOUND: 'Элемент отчёта изменился. Повторите выбор признака и запись.', SELECTOR_NOT_UNIQUE: 'Найдено несколько элементов. Выберите однозначный признак отчёта.', REVISION_CONFLICT: 'Пакет изменился. Ввод сохранён; откройте актуальную редакцию перед сохранением.', ACCESS_DENIED: 'Право подготовки изменилось. Локальный просмотр сохранён.', COMMAND_FORBIDDEN: 'Право подготовки изменилось. Локальный просмотр сохранён.', DOWNLOAD_REQUIRED: 'Нет завершённой выгрузки. Повторите запись и скачайте CSV или XLSX.', EXPORT_COVERAGE_UNVERIFIED: 'Полнота выгрузки не подтверждена.', SOURCE_CONFIGURATION_CHANGED: 'Настройка источника или личного браузера изменилась. Повторите проверку.' };
  return code ? `${messages[code] ?? 'Операция не завершена.'} (${code})` : error instanceof Error ? error.message : 'Результат операции неизвестен. Повтор сохранит прежний идентификатор операции.';
}
