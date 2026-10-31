import { z } from 'zod';
import { apiErrorSchema, apiSuccessSchema, commandResultSchema, jobAcceptedSchema, sessionViewSchema, jobSnapshotSchema, type ApiSuccess, type AnyQueryRequest, type CommandRequest, type JobAccepted, type JobSnapshot, type Problem, type SessionView } from '../../server/workbench/protocol';
import type { FileHandleView, FilePurpose } from '../../server/workbench/files';
import { fileHandleViewSchema } from '../../server/workbench/file-view';

export class WorkbenchApiError extends Error {
  constructor(public readonly problem: Problem, public readonly status: number, public readonly requestId: string | null) {
    super(problem.message); this.name = 'WorkbenchApiError';
  }
}
const invalidResponse: Problem = { code: 'INVALID_RESPONSE', message: 'Сервер вернул некорректный ответ', retryable: false, details: [], operationId: null, provider: null };

/** Cookies stay in the browser. Mutations are sent exactly once with the caller's commandId. */
export class WorkbenchClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  private csrfToken: string | null = null;
  private pendingSession: Promise<ApiSuccess<SessionView>> | null = null;
  private sessionSequence = 0;
  constructor(options: { fetch?: typeof fetch; baseUrl?: string } = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/$/, '');
  }
  private async request<T>(path: string, init: RequestInit, validate?: (data: unknown) => boolean): Promise<ApiSuccess<T>> {
    const response = await this.fetcher(this.baseUrl + path, { ...init, credentials: 'same-origin' });
    let body: unknown;
    try { body = await response.json(); } catch { throw new WorkbenchApiError(invalidResponse, response.status, response.headers.get('x-request-id')); }
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(body);
      if (parsed.success) throw new WorkbenchApiError(parsed.data.error, response.status, parsed.data.requestId);
      throw new WorkbenchApiError(invalidResponse, response.status, response.headers.get('x-request-id'));
    }
    const parsed = apiSuccessSchema(z.unknown()).safeParse(body);
    if (!parsed.success) throw new WorkbenchApiError(invalidResponse, response.status, response.headers.get('x-request-id'));
    if (validate && !validate(parsed.data.data)) throw new WorkbenchApiError(invalidResponse, response.status, parsed.data.requestId);
    return parsed.data as ApiSuccess<T>;
  }
  async session(): Promise<ApiSuccess<SessionView>> {
    if (this.pendingSession) return this.pendingSession;
    const sequence = ++this.sessionSequence;
    const promise = this.request<SessionView>('/session', { method: 'GET' }).then(response => {
      const parsed = sessionViewSchema.safeParse(response.data);
      if (!parsed.success) throw new WorkbenchApiError(invalidResponse, 200, response.requestId);
      if (sequence === this.sessionSequence) this.csrfToken = parsed.data.csrfToken;
      return { ...response, data: parsed.data };
    });
    this.pendingSession = promise;
    try { return await promise; } finally { if (this.pendingSession === promise) this.pendingSession = null; }
  }
  private async mutationHeaders(): Promise<Record<string, string>> {
    if (!this.csrfToken) await (this.pendingSession ?? this.session());
    return { 'X-CSRF-Token': this.csrfToken! };
  }
  query<T>(name: string, input: AnyQueryRequest, options: { signal?: AbortSignal } = {}): Promise<ApiSuccess<T>> {
    return this.request('/queries/' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: options.signal });
  }
  async command<T>(input: CommandRequest): Promise<ApiSuccess<T | JobAccepted>> {
    const headers = await this.mutationHeaders();
    return this.request<T | JobAccepted>('/commands', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, data => {
      const parsed = z.union([commandResultSchema, jobAcceptedSchema]).safeParse(data);
      return parsed.success && (!('commandId' in parsed.data) || parsed.data.commandId === input.commandId);
    });
  }
  async job(id: string): Promise<ApiSuccess<JobSnapshot>> {
    const response = await this.request<JobSnapshot>('/jobs/' + encodeURIComponent(id), { method: 'GET' });
    const parsed = jobSnapshotSchema.safeParse(response.data);
    if (!parsed.success) throw new WorkbenchApiError(invalidResponse, 200, response.requestId);
    return { ...response, data: parsed.data };
  }
  async upload(file: File, purpose: FilePurpose): Promise<ApiSuccess<FileHandleView>> {
    const headers = await this.mutationHeaders();
    const body = new FormData(); body.append('purpose', purpose); body.append('file', file);
    return this.request<FileHandleView>('/files', { method: 'POST', headers, body }, data => fileHandleViewSchema.safeParse(data).success);
  }
}
