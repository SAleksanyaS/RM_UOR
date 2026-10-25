import { randomUUID } from 'node:crypto';
import type { CuratorSession, Draft } from '../../domain/contracts';
import type { ApplicationContext } from '../../server/workspace/context';
import { ActionError } from '../identity/role-service';
import { canonicalJson } from '../publishing/merge-object';
import { executionPlanSchema, planSaveInputSchema } from './plan-schema';
import type { PlanSaveInput, PlanSaveResult } from './plan-contracts';

function signature(context: ApplicationContext, session: CuratorSession) {
  return canonicalJson({ catalog: context.db.get('catalog', 'active'), drafts: context.db.list<Draft>('drafts')
    .filter(draft => draft.curatorId === session.curatorId || draft.status === 'published').sort((a, b) => a.id.localeCompare(b.id)) });
}

/** Saves only declared work data. No fact calculation or attestation command is invoked. */
export async function saveExecutionPlan(context: ApplicationContext, session: CuratorSession, raw: PlanSaveInput): Promise<PlanSaveResult> {
  if (session.role !== 'curator' || !session.curatorId) throw new ActionError('План работ может изменять только куратор УОР', 403);
  const input = planSaveInputSchema.parse(raw);
  const initialSignature = signature(context, session);
  const catalog = await context.catalogs.readForSession(session);
  const goal = catalog.goals.find(item => item.id === input.goalId); if (!goal) throw new ActionError('Цель не найдена', 404);
  const assignment = input.leaderId === null ? undefined : catalog.assignments.find(item => item.goalId === goal.id && item.leaderId === input.leaderId && item.active !== false);
  if (input.leaderId !== null && !assignment) throw new ActionError('Для этого ИТ-лидера нет активного назначения цели', 404);
  const original = assignment ? assignment.plan : goal.plan;
  if ((original?.revision ?? null) !== input.baseRevision) throw new ActionError('План уже изменился. Обновите карточку перед сохранением; введённые данные остаются в форме.', 409);
  const plan = executionPlanSchema.parse({ ...input.plan, updatedAt: new Date().toISOString(), updatedBy: session.name, revision: randomUUID() });
  const operation = await context.operations.start('import', 'Сохранение плана работ');
  let saved: PlanSaveResult | undefined;
  try {
    await context.operations.stage(operation.id, { key: 'plan', label: 'Проверяем версию и сохраняем план работ' });
    const draft = await context.catalogs.saveDraft(session, { kind: assignment ? 'assignment' : 'goal', id: assignment?.id ?? goal.id,
      baseRevision: assignment ? null : goal.revision, patch: { plan } }, {
      beforeSave: () => {
        if (signature(context, session) !== initialSignature)
          throw new ActionError('Настройки изменились во время сохранения. Обновите карточку и повторите действие.', 409);
      },
      afterSave: () => context.catalogs.recordChange(session, 'execution_plan_updated', assignment?.id ?? goal.id,
        `${goal.title}${assignment ? ` · ${catalog.leaders.find(leader => leader.id === assignment.leaderId)?.name ?? ''}` : ' · общий план ДИТ'}`,
        { plan: original ?? null }, { plan }, operation.id),
    });
    saved = { goalId: goal.id, leaderId: input.leaderId, assignmentId: assignment?.id ?? null, plan, draftId: draft.id, operationId: operation.id };
    await context.operations.finish(operation.id, { status: 'completed', message: 'План работ сохранён локально. Факты и подтверждения выполнения не изменены.' });
    return saved;
  } catch (error) {
    if (saved) {
      await context.operations.finish(operation.id, { status: 'partial', message: 'План сохранён. Не удалось завершить запись результата операции.', details: [(error as Error).message] });
      return saved;
    }
    await context.operations.finish(operation.id, { status: 'failed', message: (error as Error).message, details: ['Прежний план и измеренные факты сохранены без изменений'] });
    throw error;
  }
}
