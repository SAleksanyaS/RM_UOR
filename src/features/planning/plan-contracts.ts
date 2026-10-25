import type { ExecutionPlan, WorkStage } from '../../domain/contracts';

export const WORK_STAGES = ['planned', 'in_progress', 'blocked', 'paused', 'ready_for_review', 'monitoring'] as const satisfies readonly WorkStage[];
export const WORK_STAGE_LABELS: Record<WorkStage, string> = {
  planned: 'Запланировано', in_progress: 'В работе', blocked: 'Есть препятствие', paused: 'Приостановлено',
  ready_for_review: 'Готово к проверке', monitoring: 'На удержании',
};
export type PlanInput = Omit<ExecutionPlan, 'updatedAt' | 'updatedBy' | 'revision'>;
export interface PlanSaveInput { goalId: string; leaderId: string | null; baseRevision: string | null; plan: PlanInput }
export interface PlanSaveResult { goalId: string; leaderId: string | null; assignmentId: string | null; plan: ExecutionPlan; draftId: string; operationId: string }
