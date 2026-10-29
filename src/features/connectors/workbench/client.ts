import { commandResultSchema, jobAcceptedSchema } from '../../../server/workbench/protocol';
import type { SessionView, JobSnapshot, JobAccepted, CommandReconciliation } from '../../../server/workbench/protocol';
import type { OkoWorkflowView, OkoWorkspaceView } from '../workbench-workflow-contracts';

export class OkoClientError extends Error {
  readonly name = 'OkoClientError';
  constructor(readonly code: string, message: string, readonly details: Array<{ path?: string; message?: string; code?: string }> = [], readonly uncertain = code === 'NETWORK_ERROR' || code === 'INVALID_RESPONSE') { super(message); }
}
export class OkoClient {
  private csrf = '';
  constructor(private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}
  private async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try { response = await this.fetcher('/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': this.csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal }); }
    catch (error) { if (signal?.aborted) throw error; throw new OkoClientError('NETWORK_ERROR', 'Нет связи с локальной службой. Проверьте окно запуска и повторите действие.'); }
    const envelope = await response.json().catch(() => null);
    if (!response.ok) throw new OkoClientError(envelope?.error?.code ?? 'HTTP_ERROR', envelope?.error?.message ?? 'Не удалось выполнить действие.', envelope?.error?.details ?? [], response.status >= 500);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !('data' in envelope)) throw new OkoClientError('INVALID_RESPONSE', 'Служба вернула неполный ответ.');
    return envelope.data as T;
  }
  async session(): Promise<SessionView> { const value = await this.request<SessionView>('/session'); this.csrf = value.csrfToken; return value; }
  workspace(workflowId?: string): Promise<OkoWorkspaceView> { return this.request('/queries/source.browser.workspace', { context: null, filter: workflowId ? { workflowId } : {}, sort: [], page: { limit: 50, cursor: null } }); }
  async command<T = OkoWorkflowView>(name: string, payload: Record<string, unknown>, commandId: string = crypto.randomUUID()): Promise<T | JobAccepted> {
    const value = await this.request<unknown>('/commands', { commandId, name, baseRevision: null, payload });
    const accepted = jobAcceptedSchema.safeParse(value);
    if (accepted.success) return accepted.data;
    const completed = commandResultSchema.safeParse(value);
    if (completed.success && completed.data.commandId === commandId) return completed.data.result as T;
    throw new OkoClientError('INVALID_RESPONSE', 'Служба вернула неполный ответ команды.');
  }
  job(id: string): Promise<JobSnapshot> { return this.request('/jobs/' + encodeURIComponent(id)); }
  reconcileCommand(id: string): Promise<CommandReconciliation> { return this.request('/commands/' + encodeURIComponent(id)); }
  async upload(file: File): Promise<string> {
    const body = new FormData(); body.append('purpose', 'goal-import'); body.append('file', file);
    const response = await this.fetcher('/api/v1/files', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': this.csrf }, body });
    const envelope = await response.json().catch(() => null);
    if (!response.ok) throw new OkoClientError(envelope?.error?.code ?? 'UPLOAD_FAILED', envelope?.error?.message ?? 'Не удалось загрузить справочник.', envelope?.error?.details ?? []);
    if (typeof envelope?.data?.fileHandle !== 'string') throw new OkoClientError('INVALID_RESPONSE', 'Служба не вернула идентификатор загруженного файла.');
    return envelope.data.fileHandle;
  }
}
