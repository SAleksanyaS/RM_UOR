import { randomUUID } from 'node:crypto';
import type { Operation, OperationKind, OperationStage, OperationResult } from '../../domain/contracts';
import { LocalDatabase } from '../storage/database';

export class OperationStore {
  constructor(private db: LocalDatabase, private clock: () => Date = () => new Date()) {}
  async start(kind: OperationKind, label = 'Операция'): Promise<Operation> {
    const at = this.clock().toISOString();
    const operation: Operation = { id: randomUUID(), kind, label, status: 'running', stage: { key: 'start', label: 'Подготовка' }, startedAt: at, stageStartedAt: at, finishedAt: null, result: null, events: [{ id: 1, at, stage: { key: 'start', label: 'Подготовка' }, message: label }] };
    this.db.set('operations', operation.id, operation); return operation;
  }
  async stage(id: string, stage: OperationStage): Promise<void> {
    const op = await this.get(id); if (op.status !== 'running') return;
    const at = this.clock().toISOString(); op.stage = stage; op.stageStartedAt = at;
    op.events.push({ id: op.events.length + 1, at, stage, message: stage.label }); this.db.set('operations', id, op);
  }
  async finish(id: string, result: OperationResult): Promise<void> {
    const op = await this.get(id); op.status = result.status; op.result = result; op.finishedAt = this.clock().toISOString();
    op.events.push({ id: op.events.length + 1, at: op.finishedAt, stage: op.stage, message: result.message }); this.db.set('operations', id, op);
  }
  async get(id: string): Promise<Operation> {
    const value = this.db.get<Operation>('operations', id); if (!value) throw new Error('Операция не найдена'); return value;
  }
  list(): Operation[] { return this.db.list<Operation>('operations').sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50); }
  async recoverInterrupted() {
    for (const op of this.list()) if (op.status === 'running') await this.finish(op.id, { status: 'interrupted', message: 'Служба была остановлена. Можно повторить действие.' });
  }
}
