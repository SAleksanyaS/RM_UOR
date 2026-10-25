import type { Operation } from '../../domain/contracts';
import type { OperationStore } from '../../server/operations/operation-store';
import type { UpdatePlan } from './update-planner';
export interface UpdateDependencies {
  operations: OperationStore; syncPublished: () => Promise<void>;
  collectSource: (id: string, signal: AbortSignal) => Promise<void>;
  recalculate: () => Promise<void>; signal?: AbortSignal; startOperation?: Operation;
}
const explain = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Sequential synchronization; independent source failures never replace facts on their own. */
export async function runUpdate(plan: UpdatePlan, deps: UpdateDependencies): Promise<Operation> {
  const operation = deps.startOperation ?? await deps.operations.start('update', 'Обновление данных');
  if (operation.status !== 'running') throw new Error('Операция уже завершена');
  const signal = deps.signal ?? new AbortController().signal;
  const checkCancelled = () => signal.throwIfAborted();
  const details: string[] = [];
  let succeeded = 0, failed = 0;
  const finish = async (status: 'completed' | 'partial' | 'failed' | 'cancelled', message: string) => {
    await deps.operations.finish(operation.id, { status, message, details });
    return deps.operations.get(operation.id);
  };
  try {
    checkCancelled();
    if (plan.syncPublished) {
      await deps.operations.stage(operation.id, { key: 'sync', label: 'Получение опубликованных данных УОР' });
      try { await deps.syncPublished(); } catch (error) {
        if (signal.aborted) throw error;
        details.push(explain(error));
        return await finish('failed', 'Не удалось обновить общие данные УОР. Сбор источников не запускался.');
      }
      checkCancelled();
    }
    for (const [index, id] of plan.sourceIds.entries()) {
      checkCancelled();
      await deps.operations.stage(operation.id, { key: `source:${id}`, label: `Проверка и загрузка источника ${id}`, completed: index, total: plan.sourceIds.length });
      try {
        await deps.collectSource(id, signal);
        checkCancelled();
        succeeded += 1;
      } catch (error) {
        if (signal.aborted) throw error;
        failed += 1;
        details.push(`${id}: ${explain(error)}`);
      }
    }
    checkCancelled();
    if (plan.recalculate) {
      await deps.operations.stage(operation.id, { key: 'recalculate', label: 'Проверка, обработка данных и расчет статусов' });
      try { await deps.recalculate(); } catch (error) {
        if (signal.aborted) throw error;
        details.push(`Расчет: ${explain(error)}`);
        return await finish('failed', 'Не удалось завершить расчет. Предыдущие данные сохранены.');
      }
    }
    checkCancelled();
    if (failed && !succeeded) return await finish('failed', 'Не удалось обновить выбранные источники. Предыдущие данные сохранены.');
    if (failed) return await finish('partial', `Обновлено источников: ${succeeded} из ${plan.sourceIds.length}. По остальным сохранены предыдущие данные.`);
    return await finish('completed', 'Выбранные данные обновлены.');
  } catch (error) {
    if (signal.aborted) return finish('cancelled', 'Обновление отменено. Уже принятые данные сохранены.');
    details.push(explain(error));
    return finish('failed', 'Обновление завершилось с ошибкой.');
  }
}
