import type { WorkStage } from '../../domain/contracts';
import { WORK_STAGE_LABELS } from '../planning/plan-contracts';
import { formatDate } from '../overview/overview-model';

export function planChangeSummary(value: unknown): string {
  if (!value || typeof value !== 'object') return 'План не задан';
  const plan = value as Record<string, unknown>;
  const text = (key: string) => typeof plan[key] === 'string' ? plan[key] as string : '';
  return [WORK_STAGE_LABELS[text('stage') as WorkStage] || 'Этап не указан',
    text('targetDate') ? `обязательство ${formatDate(text('targetDate'))}` : '',
    text('forecastDate') ? `прогноз ${formatDate(text('forecastDate'))}` : '',
    text('nextCheckDate') ? `проверка ${formatDate(text('nextCheckDate'))}` : '',
    text('nextAction') ? `следующий шаг: ${text('nextAction')}` : '',
    text('blocker') ? `препятствие: ${text('blocker')}` : '',
    text('decisionNeeded') ? `нужное решение: ${text('decisionNeeded')}` : ''].filter(Boolean).join(' · ');
}
