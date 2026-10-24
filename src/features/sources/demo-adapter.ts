import type { LocalSnapshot, SourceDefinition } from '../../domain/contracts';
import type { CollectRequest, SourceAdapter, SourceEvent, SourceReadiness } from './source-adapter';

export class DemoAdapter implements SourceAdapter {
  constructor(private readonly source: SourceDefinition, private readonly snapshot?: LocalSnapshot, private readonly outcome: 'success' | 'access_denied' | 'unavailable' = 'success') {}
  async check(): Promise<SourceReadiness> {
    if (this.source.kind !== 'demo') return { status: 'stub', message: 'Демонстрационный адаптер не подключается к рабочим источникам.', accessUrl: this.source.accessUrl };
    if (this.outcome === 'access_denied') return { status: 'access_denied', message: 'Демонстрация ошибки: нет доступа к источнику. Проверьте доступ по ссылке.', accessUrl: this.source.accessUrl };
    if (this.outcome === 'unavailable' || !this.snapshot) return { status: 'unavailable', message: 'Демонстрационный набор недоступен или не настроен.', accessUrl: this.source.accessUrl };
    return { status: 'ready', message: 'Демонстрационный набор готов. Все значения в нем вымышлены.', accessUrl: null };
  }
  async *collect(request: CollectRequest, signal: AbortSignal): AsyncIterable<SourceEvent> {
    signal.throwIfAborted();
    const error = (code: string, message: string): SourceEvent => ({ type: 'error', code, message, accessUrl: this.source.accessUrl });
    if (request.classification !== 'demo' || this.snapshot?.classification !== 'demo' || this.source.kind !== 'demo') {
      yield error('classification_mismatch', 'Демонстрационные факты доступны только в демонстрационном наборе.'); return;
    }
    if (request.source.id !== this.source.id || this.snapshot.sourceId !== this.source.id) {
      yield error('source_mismatch', 'Демонстрационный набор относится к другому источнику.'); return;
    }
    const readiness = await this.check();
    signal.throwIfAborted();
    if (readiness.status !== 'ready') { yield error(readiness.status, readiness.message); return; }
    if (request.period !== this.snapshot.period) {
      yield error('period_mismatch', 'У демонстрационного набора другой период. Новые факты не созданы.'); return;
    }
    yield { type: 'stage', key: 'demo-check', message: 'Проверка демонстрационного набора' };
    signal.throwIfAborted();
    const snapshot: LocalSnapshot = {
      ...structuredClone(this.snapshot), origin: 'demo', classification: 'demo', status: 'personal',
      curatorId: null, curatorName: null, validatedAt: null, collectedAt: request.requestedAt,
      observations: this.snapshot.observations.map(row => ({ ...row, downloadedAt: request.requestedAt })),
    };
    yield { type: 'stage', key: 'demo-ready', message: 'Демонстрационные значения подготовлены. Реальный дашборд не запрашивался.' };
    signal.throwIfAborted();
    yield { type: 'snapshot', snapshot };
  }
}
