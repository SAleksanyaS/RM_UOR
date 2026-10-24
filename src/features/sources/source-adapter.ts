import type { Classification, LocalSnapshot, SourceDefinition } from '../../domain/contracts';

export interface SourceReadiness { status: 'ready' | 'stub' | 'access_denied' | 'unavailable'; message: string; accessUrl: string | null }
export interface CollectRequest { source: SourceDefinition; classification: Classification; period: string; requestedAt: string }
export type SourceEvent = { type: 'stage'; key: string; message: string }
  | { type: 'snapshot'; snapshot: LocalSnapshot }
  | { type: 'error'; code: string; message: string; accessUrl: string | null };
export interface SourceAdapter {
  check(): Promise<SourceReadiness>;
  collect(request: CollectRequest, signal: AbortSignal): AsyncIterable<SourceEvent>;
}

export class StubSourceAdapter implements SourceAdapter {
  constructor(private readonly source: SourceDefinition) {}
  async check(): Promise<SourceReadiness> {
    return { status: 'stub', message: 'Автоматический сбор из этого источника пока не подключен. Последние локальные данные сохранены.', accessUrl: this.source.accessUrl };
  }
  async *collect(_request: CollectRequest, signal: AbortSignal): AsyncIterable<SourceEvent> {
    signal.throwIfAborted();
    yield { type: 'error', code: 'stub_not_connected', message: 'Заглушка: реальная загрузка с дашборда будет подключена на следующем этапе. Новые данные не получены.', accessUrl: this.source.accessUrl };
  }
}
