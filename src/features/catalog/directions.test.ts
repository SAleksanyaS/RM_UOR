import { describe, expect, it } from 'vitest';
import demo from '../../../catalog/demo.json';
import type { CatalogSnapshot, Goal } from '../../domain/contracts';
import { getDirections, getGoalDirectionId, normalizeDirections } from './directions';
import { validateCatalog } from '../publishing/validate-version';
const base = demo as CatalogSnapshot;
describe('work directions', () => {
  it('adds six editable directions to a legacy catalog without inventing goals or rewriting source categories', () => {
    const result = normalizeDirections(base);
    expect(getDirections(result).map(item => item.name)).toEqual(['Архитектура', 'Производственный процесс', 'Управление технологическим долгом', 'Данные', 'МЕТЛА', 'Тарифные модели ИТ и SberInfra']);
    expect(result.goals).toHaveLength(base.goals.length);
    expect(result.goals.map(goal => goal.category)).toEqual(base.goals.map(goal => goal.category));
    expect(result.goals.filter(goal => goal.workDirectionId === 'resources')).toHaveLength(0);
    expect(normalizeDirections(result)).toEqual(result);
    expect(base.directions).toBeUndefined();
  });
  it('uses provisional mapping and keeps risk/security goals outside METLA', () => {
    const goal = base.goals[0];
    const variants = [
      { ...goal, id: 'a', category: 'architecture' }, { ...goal, id: 'd', category: 'data' },
      { ...goal, id: 'p', category: 'process' }, { ...goal, id: 'SW26.2', category: 'process' },
      { ...goal, id: 'MT26.1', category: 'security' }, { ...goal, id: 'ITZ26', category: 'security', title: 'Контроль рисков' },
    ] as Goal[];
    expect(variants.map(getGoalDirectionId)).toEqual(['architecture', 'data', 'production', 'technical-debt', 'metla', null]);
    expect(getGoalDirectionId({ ...goal, workDirectionId: null })).toBeNull();
  });
  it('preserves custom catalogs, explicit unassigned goals, and a deliberately empty taxonomy', () => {
    const custom = { ...base, directions: [{ id: 'custom', name: 'Свое', description: '', color: '#123456', order: 1 }], goals: [{ ...base.goals[0], workDirectionId: 'custom' }] };
    expect(normalizeDirections(custom)).toEqual(custom);
    expect(normalizeDirections({ ...base, directions: [] }).directions).toEqual([]);
    expect(normalizeDirections({ ...base, directions: [] }).goals.every(goal => goal.workDirectionId === null)).toBe(true);
  });
  it('rejects unknown direction references and malformed direction values', () => {
    expect(() => validateCatalog({ ...base, goals: base.goals.map((goal, index) => index === 0 ? { ...goal, workDirectionId: 'unknown' } : goal) })).toThrow();
    expect(() => validateCatalog({ ...base, directions: [{ id: 'one', name: 'Bad', description: '', color: 'url(x)', order: Infinity }] })).toThrow();
  });
});
