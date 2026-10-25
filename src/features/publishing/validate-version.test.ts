import { describe, expect, it } from 'vitest';
import demo from '../../../catalog/demo.json';
import snapshots from '../../../catalog/demo-snapshots.json';
import { validateCatalog, validateSnapshot, validateEvaluationBasis } from './validate-version';

describe('shared version validation', () => {
  it('requires explicit method metadata to match the saved historical goal', () => {
    const measurement = { kind: 'scalar', aggregation: 'single', metrics: [{ id: 'value', name: 'Значение', target: 1, unit: 'шт', direction: 'increase' }] };
    const goal = { ...demo.goals[0], measurement };
    expect(validateEvaluationBasis({ methodVersion: 'explicit-measurement-v1', goal, assignments: [] }).goal.measurement).toEqual(measurement);
    expect(() => validateEvaluationBasis({ methodVersion: 'participant-all-applicable-metrics-v1', goal, assignments: [] })).toThrow();
    expect(() => validateEvaluationBasis({ methodVersion: 'explicit-measurement-v1', goal: demo.goals[0], assignments: [] })).toThrow();
  });
  it('rejects explicit calculation cohorts whose participants are not available in the shared catalog', () => {
    const value = structuredClone(demo) as unknown as Record<string, any>;
    const assigned = value.assignments[0];
    value.goals.find((goal: { id: string }) => goal.id === assigned.goalId).measurement = { kind: 'scalar', aggregation: 'single', metrics: [{ id: 'value', name: 'Число', target: 1, unit: 'шт', direction: 'increase' }] };
    assigned.participantIds = ['unpublished-participant'];
    expect(() => validateCatalog(value)).toThrow();
    assigned.participantIds = [assigned.leaderId];
    expect(() => validateCatalog(value)).not.toThrow();
  });
  it('accepts the supplied standalone demo catalog and facts', () => {
    const catalog = validateCatalog(demo);
    expect(catalog.goals.length).toBeGreaterThan(0);
    expect(validateSnapshot(snapshots[0], catalog).observations.length).toBeGreaterThan(0);
  });
  it('rejects malformed or unsupported catalog schema and non-finite targets', () => {
    expect(() => validateCatalog({ ...demo, schemaVersion: 2 })).toThrow();
    expect(() => validateCatalog({ ...demo, goals: [{ ...demo.goals[0], title: 4 }] })).toThrow();
    expect(() => validateCatalog({ ...demo, goals: [{ ...demo.goals[0], officialTarget: Infinity }] })).toThrow();
  });
  it('rejects dangling assignment references and duplicate object identities', () => {
    expect(() => validateCatalog({ ...demo, assignments: [{ ...demo.assignments[0], goalId: 'missing-goal' }] })).toThrow();
    expect(() => validateCatalog({ ...demo, goals: [...demo.goals, demo.goals[0]] })).toThrow();
  });
  it('rejects invalid observation values and missing source or goal references', () => {
    const snapshot = snapshots[0];
    expect(() => validateSnapshot({ ...snapshot, sourceId: 'unknown' }, validateCatalog(demo))).toThrow();
    expect(() => validateSnapshot({ ...snapshot, observations: [{ ...snapshot.observations[0], goalId: 'unknown' }] }, validateCatalog(demo))).toThrow();
    expect(() => validateSnapshot({ ...snapshot, observations: [{ ...snapshot.observations[0], value: Infinity }] }, validateCatalog(demo))).toThrow();
  });
  it('keeps configured required metric and participant cohorts', () => {
    const value = structuredClone(demo) as unknown as Record<string, any>;
    value.goals[0].requiredMetricIds = ['one', 'two'];
    value.assignments[0].participantIds = ['participant-one'];
    const catalog = validateCatalog(value);
    expect(catalog.goals[0].requiredMetricIds).toEqual(['one', 'two']);
    expect(catalog.assignments[0].participantIds).toEqual(['participant-one']);
  });
  it('accepts cleared entity links and rejects unsafe source URLs or unknown products', () => {
    const value = structuredClone(demo) as unknown as Record<string, any>;
    value.entities.push({ id: 'binding', type: 'product_leader', name: 'Связь', leaderId: null, productId: null });
    expect(() => validateCatalog(value)).not.toThrow();
    value.entities[value.entities.length - 1].productId = 'unknown-product';
    expect(() => validateCatalog(value)).toThrow();
    value.entities.pop(); value.sources[0].url = 'javascript:alert(1)';
    expect(() => validateCatalog(value)).toThrow();
  });
});
