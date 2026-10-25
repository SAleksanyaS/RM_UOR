import { z } from 'zod';

export const measurementSchema = z.object({
  kind: z.enum(['scalar', 'participant_share', 'binary', 'milestones', 'range', 'change']),
  aggregation: z.enum(['single', 'sum', 'average']),
  metrics: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(500),
    unit: z.string().max(100), target: z.number().finite(), direction: z.enum(['increase', 'decrease']) }).strict()).min(1).max(100),
  range: z.object({ min: z.number().finite(), max: z.number().finite() }).strict().optional(),
  change: z.object({ mode: z.enum(['absolute', 'percent']), baseline: z.number().finite() }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(value.metrics.map(metric => metric.id)).size !== value.metrics.length) fail('Идентификаторы показателей должны быть уникальны');
  if (!['participant_share', 'milestones'].includes(value.kind) && value.metrics.length !== 1) fail('Для выбранной методики нужен один показатель');
  if (value.kind === 'binary' && value.aggregation !== 'single') fail('Двоичный результат требует единственного значения');
  if (['participant_share', 'milestones'].includes(value.kind) && value.aggregation !== 'average') fail('Для доли выберите среднее');
  if (value.kind === 'range' ? !value.range || value.range.min > value.range.max : !!value.range) fail('Укажите корректные границы только для диапазона');
  if (value.kind === 'change' ? !value.change || value.change.mode === 'percent' && value.change.baseline === 0 : !!value.change) fail('Укажите явную базу изменения; процентная база не равна нулю');
});
