import { z } from 'zod';
import { WORK_STAGES, type PlanInput } from './plan-contracts';

const date = z.iso.date().nullable();
const text = z.string().trim().max(5000);
const shape = { stage: z.enum(WORK_STAGES), plannedStartDate: date, targetDate: date, forecastDate: date, nextCheckDate: date,
  nextAction: text, blocker: text, decisionNeeded: text };
function coherent(plan: PlanInput, context: z.RefinementCtx) {
  if (plan.plannedStartDate) {
    if (plan.targetDate && plan.targetDate < plan.plannedStartDate)
      context.addIssue({ code: 'custom', path: ['targetDate'], message: 'Обязательство не может быть раньше начала работ' });
    if (plan.forecastDate && plan.forecastDate < plan.plannedStartDate)
      context.addIssue({ code: 'custom', path: ['forecastDate'], message: 'Прогноз не может быть раньше начала работ' });
  }
  if ((plan.stage === 'in_progress' || plan.stage === 'blocked') && !plan.nextAction.trim())
    context.addIssue({ code: 'custom', path: ['nextAction'], message: 'Укажите следующий шаг' });
  if (plan.stage === 'blocked' && !plan.blocker.trim())
    context.addIssue({ code: 'custom', path: ['blocker'], message: 'Опишите препятствие' });
}
/** Only declared work data is accepted from a client; authorship is server-owned. */
export const planInputSchema = z.object(shape).strict().superRefine(coherent);
export const executionPlanSchema = z.object({ ...shape, updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: z.string().trim().min(1).max(500), revision: z.string().min(1).max(500) }).strict().superRefine(coherent);
export const planSaveInputSchema = z.object({ goalId: z.string().min(1).max(500), leaderId: z.string().min(1).max(500).nullable(),
  baseRevision: z.string().min(1).max(500).nullable(), plan: planInputSchema }).strict();
