import type { JobSnapshot } from '../../../server/workbench/protocol';

const titles: Record<JobSnapshot['status'], string> = {
  queued: 'Подготовка к получению данных', running: 'Получаем файл из отчёта', waiting_user: 'Завершите действие в браузере',
  retry_wait: 'Ожидаем повторного запуска', succeeded: 'Получение завершено', partial: 'Получено с замечаниями',
  failed: 'Получение остановлено', cancelled: 'Операция отменена', interrupted: 'Проверьте результат прерванной операции',
};
const stages: Record<string, string> = {
  queued: 'Ожидание запуска', running: 'Выполнение сохранённых действий', 'browser.auth': 'Вход в источник',
  'source.check': 'Проверка источника', 'source.collect': 'Получение файла', 'source.normalize': 'Разбор и нормализация файла', 'source.enrich': 'Сопоставление со справочником',
  'source.commit': 'Сохранение результата', completed: 'Обработка завершена', done: 'Обработка завершена', cancelled: 'Выполнение остановлено',
};
const units: Record<string, string> = { rows: 'строк', files: 'файлов', bytes: 'байт', steps: 'шагов', items: 'элементов' };
export function okoProblemMessage(problem: { code: string; message: string }): string {
  const known: Record<string, string> = {
    SOURCE_SCHEMA_CHANGED: 'Изменились столбцы или формат выгрузки. Откройте настройки, запишите актуальный файл и проверьте сопоставление.',
    BROWSER_CONFIGURATION_REQUIRED: 'Не удалось открыть личный браузер. Проверьте установленный браузер, его профиль и разрешение Chromium sandbox в ОС.',
    SCENARIO_REVIEW_REQUIRED: 'Завершите запись и сопоставление столбцов перед получением данных.',
    OPERATION_FAILED: 'Не удалось завершить получение. Проверьте доступ к отчёту и настройки сценария перед повтором.',
    MANUAL_LOGIN_REQUIRED: 'Войдите в ОКО в личном окне браузера и продолжите это задание.',
    AUTH_REQUIRED: 'Войдите в ОКО в личном окне браузера и продолжите это задание.',
  };
  return known[problem.code] ?? problem.message ?? problem.code;
}

/** All progress, actions and diagnostics come from the saved own job snapshot. */
export function PersonalOperationStatus({ job, busy, hasResult, execute }: {
  job: JobSnapshot; busy: boolean; hasResult: boolean; execute(name: string, payload: Record<string, unknown>): void;
}) {
  const next = job.nextAction;
  const progress = job.progress.total !== null || job.progress.completed > 0
    ? `${job.progress.completed}${job.progress.total !== null ? ` из ${job.progress.total}` : ''} ${units[job.progress.unit] ?? 'единиц'}` : null;
  return <div className={'wb-operation-state' + (job.status === 'waiting_user' ? ' wb-operation-manual' : '')} role="status" aria-live="polite">
    <div><strong>{titles[job.status]}</strong>
      {stages[job.stage] && <p>{stages[job.stage]}</p>}
      {progress && <p className="wb-operation-progress">Обработано: {progress}</p>}
      {job.status === 'waiting_user' && <p>Войдите в личном окне обычным способом и вернитесь сюда. Пароль и коды не входят в сценарий.</p>}
      {['failed', 'cancelled', 'interrupted'].includes(job.status) && <p>{hasResult ? 'Последний сохранённый результат доступен ниже.' : 'Новый результат не подтверждён. Проверьте состояние перед повтором.'}</p>}
      {job.error && <p>{okoProblemMessage(job.error)}</p>}
      {!!job.warnings.length && <ul>{job.warnings.map((warning, index) => <li key={index}>{okoProblemMessage(warning)}</li>)}</ul>}
      <details className="wb-operation-details"><summary>Технические сведения задания</summary><p>Этап: <code>{job.stage}</code></p><p>Прогресс: {job.progress.completed} / {job.progress.total ?? 'не указан'} <code>{job.progress.unit}</code></p>{[...(job.error ? [job.error] : []), ...job.warnings].map((problem, index) => <div key={index}><code>{problem.code}</code><p>{problem.message}</p>{problem.details.map((detail, detailIndex) => <p key={detailIndex}>{detail.path} · {detail.code} · {detail.message}</p>)}</div>)}</details>
    </div>
    <div className="wb-operation-actions">
      {job.cancelAvailable && <button type="button" onClick={() => execute('job.cancel', { jobId: job.jobId })}>Отменить получение</button>}
      {job.retryAvailable && next?.commandName !== 'job.retry' && <button type="button" disabled={busy} onClick={() => execute('job.retry', { jobId: job.jobId })}>Повторить получение</button>}
      {next?.commandName && <button type="button" disabled={busy || !next.enabled} onClick={() => execute(next.commandName!, next.payload ?? {})}>{next.label}</button>}
      {next && !next.enabled && next.disabledReason && <p>{next.disabledReason}</p>}
    </div>
  </div>;
}
