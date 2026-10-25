import { describe, expect, it } from 'vitest';
import type { PlanInput } from './plan-contracts';
import { executionPlanSchema, planInputSchema } from './plan-schema';
const empty: PlanInput = { stage: 'planned', plannedStartDate: null, targetDate: null, forecastDate: null, nextCheckDate: null, nextAction: '', blocker: '', decisionNeeded: '' };
describe('execution plan schema', () => {
  it('keeps unknown dates empty and reserves authorship and revision for the server', () => {
    expect(planInputSchema.parse(empty)).toEqual(empty);
    expect(() => planInputSchema.parse({ ...empty, updatedBy: 'forged' })).toThrow();
    expect(executionPlanSchema.parse({ ...empty, updatedBy: 'Куратор', updatedAt: '2026-10-24T10:00:00Z', revision: 'revision-one' }).updatedBy).toBe('Куратор');
  });
  it('requires a next action during active work and an explanation for a blocker', () => {
    expect(() => planInputSchema.parse({ ...empty, stage: 'in_progress' })).toThrow();
    expect(() => planInputSchema.parse({ ...empty, stage: 'blocked', nextAction: 'Проверить доступ', blocker: '   ' })).toThrow();
    expect(planInputSchema.parse({ ...empty, stage: 'blocked', nextAction: 'Запросить доступ', blocker: 'Не назначены права' }).stage).toBe('blocked');
  });
  it('rejects impossible calendar dates and deadlines or forecasts before planned start', () => {
    expect(() => planInputSchema.parse({ ...empty, targetDate: '2026-02-30' })).toThrow();
    expect(() => planInputSchema.parse({ ...empty, plannedStartDate: '2026-10-20', targetDate: '2026-10-19' })).toThrow();
    expect(() => planInputSchema.parse({ ...empty, plannedStartDate: '2026-10-20', forecastDate: '2026-10-19' })).toThrow();
    expect(planInputSchema.parse({ ...empty, plannedStartDate: '2026-10-20', targetDate: '2026-10-30', forecastDate: '2026-10-25' }).forecastDate).toBe('2026-10-25');
  });
});
