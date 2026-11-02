import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { problemFromError } from './problem-from-error';
import { WorkbenchHttpError } from './protocol';
import { ConnectorError } from '../../features/connectors/contracts';

afterEach(() => vi.restoreAllMocks());

const id = randomUUID();

it('keeps the thrown cause instead of a generic OPERATION_FAILED', () => {
  const aborted = new DOMException('Cancelled', 'AbortError');
  expect(problemFromError(aborted, id)).toMatchObject({ code: 'SOURCE_CANCELLED', retryable: true, operationId: id });
  const timeout = Object.assign(Error('signal timed out'), { name: 'TimeoutError' });
  expect(problemFromError(timeout, id)).toMatchObject({ code: 'SOURCE_TIMEOUT', retryable: true });
  const closed = Error('Target page, context or browser has been closed');
  expect(problemFromError(closed, id)).toMatchObject({ code: 'BROWSER_WINDOW_CLOSED', retryable: true });
  const blocked = Error('page.goto: net::ERR_BLOCKED_BY_CLIENT at https://oko.example');
  expect(problemFromError(blocked, id)).toMatchObject({ code: 'BROWSER_URL_BLOCKED', retryable: false });
});

it('maps a browser launch failure with a safe diagnostic detail', () => {
  const problem = problemFromError(new ConnectorError('browser_launch', 'Не удалось запустить браузер с включённой защитой. Проверьте chrome-sandbox.', { reason: 'SANDBOX_DENIED', detail: 'sandbox: No usable sandbox! diagnostic-canary-private-value' }), id);
  expect(problem).toMatchObject({ code: 'BROWSER_LAUNCH_FAILED', retryable: true });
  expect(problem.message).not.toMatch(/^browser_launch: /);
  expect(problem.details).toEqual([{ path: '/cause', code: 'SANDBOX_DENIED', message: 'BROWSER_OPERATION_FAILED', ref: null }]);
  expect(JSON.stringify(problem)).not.toContain('diagnostic-canary-private-value');
});

it('reports exhausted report licences and rejected certificates with their own codes', () => {
  const licences = Error('page.goto: Доступ к Qlik Sense невозможен из-за большого количества активных сеансов.');
  expect(problemFromError(licences, id)).toMatchObject({ code: 'BROWSER_SESSION_EXHAUSTED', retryable: true });
  const certificate = Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://oko.example');
  expect(problemFromError(certificate, id)).toMatchObject({ code: 'SOURCE_CERTIFICATE_INVALID', retryable: false });
});

it('passes WorkbenchHttpError through and logs unknown failures without their message', () => {
  expect(problemFromError(new WorkbenchHttpError(409, 'REVISION_CONFLICT', 'Workflow changed', [], false), id)).toMatchObject({ code: 'REVISION_CONFLICT', message: 'Workflow changed', operationId: id });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const problem = problemFromError(Error('secret https://internal.example/report failed'), id);
  expect(problem).toMatchObject({ code: 'OPERATION_FAILED', operationId: id });
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(log.mock.calls[0])).not.toContain('internal.example');
});
