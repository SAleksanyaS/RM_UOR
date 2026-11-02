import { commandResultSchema, jobAcceptedSchema } from '../../../server/workbench/protocol';
import type { SessionView, JobSnapshot, JobAccepted, CommandReconciliation } from '../../../server/workbench/protocol';
import type { OkoWorkflowView, OkoWorkspaceView, OkoExportsView } from '../workbench-workflow-contracts';
import { personalWorkflowAlias, personalWorkflowName, type PersonalWorkflowPrefix } from '../workbench-workflow-names';
import type { BrowserEnvironment } from '../../system/workbench/environment-query';

export class OkoClientError extends Error {
  readonly name = 'OkoClientError';
  constructor(readonly code: string, message: string, readonly details: Array<{ path?: string; message?: string; code?: string }> = [], readonly uncertain = code === 'NETWORK_ERROR' || code === 'INVALID_RESPONSE') { super(message); }
}
export class OkoClient {
  private csrf = '';
  readonly prefix: PersonalWorkflowPrefix;
  readonly storageScope: string;
  constructor(private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init), options: { prefix?: PersonalWorkflowPrefix } = {}) {
    this.prefix = options.prefix ?? 'source.browser';
    if (!['source.browser', 'oko.workflow'].includes(this.prefix)) throw new Error('Unsupported personal workflow namespace');
    this.storageScope = this.prefix === 'source.browser' ? '' : ':oko.workflow';
  }
  private async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try { response = await this.fetcher('/api/v1' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': this.csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal }); }
    catch (error) { if (signal?.aborted) throw error; throw new OkoClientError('NETWORK_ERROR', 'Нет связи с локальной службой. Проверьте окно запуска и повторите действие.'); }
    const envelope = await response.json().catch(() => null);
    if (!response.ok) throw new OkoClientError(envelope?.error?.code ?? 'HTTP_ERROR', envelope?.error?.message ?? 'Не удалось выполнить действие.', envelope?.error?.details ?? [], response.status >= 500);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !('data' in envelope)) throw new OkoClientError('INVALID_RESPONSE', 'Служба вернула неполный ответ.');
    return envelope.data as T;
  }
  async session(): Promise<SessionView> { const value = await this.request<SessionView>('/session'); this.csrf = value.csrfToken; return this.prefix === 'source.browser' ? value : { ...value, allowedCommands: value.allowedCommands.map(name => personalWorkflowAlias(this.prefix, name)).filter((name): name is string => name !== null) }; }
  workspace(workflowId?: string): Promise<OkoWorkspaceView> { return this.request('/queries/' + personalWorkflowName(this.prefix, 'source.browser.workspace'), { context: null, filter: workflowId ? { workflowId } : {}, sort: [], page: { limit: 50, cursor: null } }); }
  browserEnvironment(): Promise<BrowserEnvironment> { return this.request('/queries/environment.browser', { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } }); }
  exports(filter: { workflowId?: string; includeHidden?: boolean } = {}): Promise<OkoExportsView> { return this.request('/queries/' + personalWorkflowName(this.prefix, 'source.browser.exports'), { context: null, filter, sort: [], page: { limit: 100, cursor: null } }); }
  async command<T = OkoWorkflowView>(name: string, payload: Record<string, unknown>, commandId: string = crypto.randomUUID()): Promise<T | JobAccepted> {
    const value = await this.request<unknown>('/commands', { commandId, name: personalWorkflowName(this.prefix, name), baseRevision: null, payload });
    const accepted = jobAcceptedSchema.safeParse(value);
    if (accepted.success) return accepted.data;
    const completed = commandResultSchema.safeParse(value);
    if (completed.success && completed.data.commandId === commandId) return completed.data.result as T;
    throw new OkoClientError('INVALID_RESPONSE', 'Служба вернула неполный ответ команды.');
  }
  job(id: string): Promise<JobSnapshot> { return this.request('/jobs/' + encodeURIComponent(id)); }
  async reconcileCommand(id: string): Promise<CommandReconciliation> { const value = await this.request<CommandReconciliation>('/commands/' + encodeURIComponent(id)); if (value.name === null || this.prefix === 'source.browser') return value; const name = personalWorkflowAlias(this.prefix, value.name); if (name === null) throw new OkoClientError('INVALID_RESPONSE', 'Ответ относится к другому сценарию.'); return { ...value, name }; }
  async upload(file: File): Promise<string> {
    const body = new FormData(); body.append('purpose', this.prefix === 'oko.workflow' ? 'oko-directory' : 'goal-import'); body.append('file', file);
    const response = await this.fetcher('/api/v1/files', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': this.csrf }, body });
    const envelope = await response.json().catch(() => null);
    if (!response.ok) throw new OkoClientError(envelope?.error?.code ?? 'UPLOAD_FAILED', envelope?.error?.message ?? 'Не удалось загрузить справочник.', envelope?.error?.details ?? []);
    if (typeof envelope?.data?.fileHandle !== 'string') throw new OkoClientError('INVALID_RESPONSE', 'Служба не вернула идентификатор загруженного файла.');
    return envelope.data.fileHandle;
  }
}
