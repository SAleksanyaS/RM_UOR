import type { Classification, LocalSnapshot, SourceDefinition } from '../../domain/contracts';
export interface SourceReadiness { status: 'ready' | 'configuration_required' | 'manual_required' | 'access_denied' | 'unavailable'; message: string; accessUrl: string | null }
export interface CollectRequest { source: SourceDefinition; classification: Classification; period: string; requestedAt: string }
export type SourceEvent = { type: 'stage'; key: string; message: string } | { type: 'snapshot'; snapshot: LocalSnapshot } | { type: 'error'; code: string; message: string; accessUrl: string | null };
export interface SourceAdapter { check(): Promise<SourceReadiness>; collect(request: CollectRequest, signal: AbortSignal): AsyncIterable<SourceEvent> }
/** Legacy sources have no fallback: the previous snapshot never counts as a new collection. */
export class UnconfiguredSourceAdapter implements SourceAdapter {
  constructor(private readonly source: SourceDefinition) {}
  async check(): Promise<SourceReadiness> { return { status: this.source.kind==='manual'||this.source.kind==='file'?'manual_required':'configuration_required', message:'Настройте реальный сбор или внесите данные вручную. Предыдущие факты сохранены.',accessUrl:this.source.accessUrl }; }
  async *collect(_request:CollectRequest,signal:AbortSignal):AsyncIterable<SourceEvent>{signal.throwIfAborted();const readiness=await this.check();yield {type:'error',code:readiness.status,message:readiness.message,accessUrl:this.source.accessUrl};}
}
