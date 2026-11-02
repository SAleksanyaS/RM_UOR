import { ConnectorError } from '../../features/connectors/contracts';
import { safeErrorDetail } from '../../features/connectors/workbench-browser-diagnostics';
import { WorkbenchHttpError, type FieldProblem, type Problem } from './protocol';

type Failure = { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };

const failureOf = (error: unknown): Failure => (error && typeof error === 'object' ? error as Failure : {});
const nameOf = (error: unknown) => String(failureOf(error).name ?? '');
const codeOf = (error: unknown) => String(failureOf(error).code ?? '');

const connectorCodes: Record<ConnectorError['code'], { code: string; retryable: boolean }> = {
  configuration_required: { code: 'BROWSER_CONFIGURATION_REQUIRED', retryable: false },
  browser_launch: { code: 'BROWSER_LAUNCH_FAILED', retryable: true },
  manual_required: { code: 'AUTH_REQUIRED', retryable: true },
  manual_login_required: { code: 'AUTH_REQUIRED', retryable: true },
  access_denied: { code: 'SOURCE_ACCESS_DENIED', retryable: false },
  network: { code: 'SOURCE_UNAVAILABLE', retryable: true },
  certificate: { code: 'SOURCE_CERTIFICATE_REQUIRED', retryable: false },
  timeout: { code: 'SOURCE_TIMEOUT', retryable: true },
  format: { code: 'SOURCE_SCHEMA_CHANGED', retryable: false },
  incomplete: { code: 'DOWNLOAD_REQUIRED', retryable: true },
  cancelled: { code: 'SOURCE_CANCELLED', retryable: true },
};

/** Debug detail is opt-in: default logs never carry URLs, paths or selectors. */
export function logOperationFailure(operationId: string | null, error: unknown): void {
  const { code, message } = failureOf(error);
  const safe = { operationId, name: nameOf(error) || null, code: typeof code === 'string' ? code : null };
  if (process.env.UOR_OKO_DEBUG_CAUSE === '1') console.error('[oko] operation failed', { ...safe, message: typeof message === 'string' ? safeErrorDetail(message) : null, stack: (error as Error)?.stack });
  else console.error('[oko] operation failed', safe);
}

/** Converts any thrown value into a readable problem; the cause is never silently replaced by OPERATION_FAILED. */
export function problemFromError(error: unknown, operationId: string | null): Problem {
  const base = (code: string, message: string, retryable: boolean, details: FieldProblem[] = []): Problem => ({ code, message, retryable, details, operationId, provider: null });
  if (error instanceof WorkbenchHttpError)
    return { code: error.code, message: error.message, retryable: error.retryable, details: error.details, operationId: error.operationId ?? operationId, provider: error.provider };
  const name = nameOf(error), code = codeOf(error);
  if (name === 'AbortError' || code === 'ABORT_ERR')
    return base('SOURCE_CANCELLED', 'Ожидание или окно браузера закрыто до завершения операции. Откройте окно заново и повторите.', true);
  if (name === 'TimeoutError' || name === 'TimeoutOverflowWarning')
    return base('SOURCE_TIMEOUT', 'Операция не завершилась за отведённое время. Повторите её.', true);
  if (error instanceof ConnectorError) {
    const mapped = connectorCodes[error.code];
    const details: FieldProblem[] = error.detail ? [{ path: '/cause', code: error.reason ?? mapped.code, message: safeErrorDetail(error.detail), ref: null }] : [];
    return base(mapped.code, error.message.replace(/^[a-z_]+: /, ''), mapped.retryable, details);
  }
  const text = `${name} ${code} ${failureOf(error).message ?? ''}`;
  if (/Target page, context or browser has been closed|has been closed|Browser closed|browser has been closed/i.test(text))
    return base('BROWSER_WINDOW_CLOSED', 'Окно браузера закрылось до завершения операции. Откройте окно входа заново и повторите. Если перезапускался сервер разработки, все окна закрываются.', true);
  if (/net::ERR_ABORTED|net::ERR_BLOCKED_BY_CLIENT/i.test(text))
    return base('BROWSER_URL_BLOCKED', 'Браузер остановил переход: адрес вне разрешённых источников. Добавьте точный адрес сайта входа в личный профиль.', false);
  if (/no\s+available\s+engine|too many (active )?sessions|maximum (number of )?sessions|лицензи|активных сеансов/i.test(text))
    return base('BROWSER_SESSION_EXHAUSTED', 'Сервер отчёта отказал в доступе: исчерпаны лицензии (нет свободных сеансов). Закройте лишние окна Qlik Sense, подождите и нажмите «Обновить» в окне браузера.', true);
  if (/net::ERR_CERT|SSL|CERT_|certificate|self.signed|ERR_BAD_SSL/i.test(text))
    return base('SOURCE_CERTIFICATE_INVALID', 'Сервер отчёта предъявил недоверенный сертификат. Проверьте корневой сертификат банка в системе и повторите вход.', false);
  if (/net::ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(text))
    return base('SOURCE_UNAVAILABLE', 'Отчёт недоступен. Проверьте сеть, адрес отчёта и сессию входа.', true);
  if (name === 'ZodError' || code === 'VALIDATION_FAILED')
    return base('VALIDATION_FAILED', 'Внутренние данные операции не прошли проверку. Повторите действие или перезапишите сценарий.', false);
  logOperationFailure(operationId, error);
  return base('OPERATION_FAILED', 'Операция не завершена. Проверьте состояние и повторите; технические сведения доступны в журнале сервера.', false);
}
