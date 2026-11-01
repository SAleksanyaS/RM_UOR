import { describe, expect, it } from 'vitest';
import type { EvaluationInput } from '../../../domain/workbench/entities';
import { fixtureId, makeHeader, makeNumericFixture } from '../../../../tests/fixtures/workbench/factories';
import { evaluateAssignment } from './evaluate';

const R = (numerator: string, denominator = '1') => ({ numerator, denominator });
function na(input: EvaluationInput, index: number) { return { ...makeHeader(800 + index, { publicationAnchorId: input.goal.publicationAnchorId }), assignmentId: input.assignment.id, metricId: input.metrics[index].id, kind: 'not_applicable' as const, period: { startInclusive: '2026-10-01', endExclusive: '2026-11-01' }, reason: 'demo exception' }; }

describe('exact assignment evaluator', () => {
  it('keeps_scope_results_independent', () => {
    const dit = makeNumericFixture({ scope: { kind: 'dit', id: fixtureId(100) }, values: ['92'], targets: ['90'] });
    const cluster = makeNumericFixture({ scope: { kind: 'cluster', id: fixtureId(102) }, values: ['88'], targets: ['95'] });
    expect(evaluateAssignment(dit)).toMatchObject({ achievement: 'met', scorePercent: R('920', '9'), canConfirm: true });
    expect(evaluateAssignment(cluster)).toMatchObject({ achievement: 'not_met', canConfirm: false });
    expect(dit.facts[0].value).toBe('92'); expect(cluster.facts[0].value).toBe('88');
  });
  it('known_mandatory_failure_overrides_score', () => {
    const result = evaluateAssignment(makeNumericFixture({ values: ['80', '100'], weights: ['20', '80'], mandatory: [true, false], scoreTarget: '95' }));
    expect(result).toMatchObject({ scorePercent: R('96'), coveragePercent: R('100'), complete: true, achievement: 'not_met', canConfirm: false });
  });
  it('renormalizes_na_and_keeps_partial_score_separate', () => {
    const i = makeNumericFixture({ values: ['100', '100', null], weights: ['60', '20', '20'] }); i.applicability = [na(i, 2)];
    const before = structuredClone(i);
    expect(evaluateAssignment(i)).toMatchObject({ calculation: 'ready', scorePercent: R('100'), coveragePercent: R('100'), complete: true, achievement: 'met' });
    expect(i).toEqual(before);
    i.applicability = [na(i, 0), na(i, 1), na(i, 2)];
    expect(evaluateAssignment(i)).toMatchObject({ calculation: 'not_applicable', achievement: 'not_applicable', scorePercent: null, preliminaryPercent: null, coveragePercent: null, canConfirm: false });
    const partial = evaluateAssignment(makeNumericFixture({ values: ['80', null], weights: ['50', '50'] }));
    expect(partial).toMatchObject({ calculation: 'preliminary', scorePercent: null, preliminaryPercent: R('80'), coveragePercent: R('50'), complete: false, achievement: 'unknown', canConfirm: false });
    expect(evaluateAssignment(makeNumericFixture({ values: ['80', null], weights: ['100', '0'] }))).toMatchObject({ scorePercent: null, coveragePercent: R('100'), complete: false, canConfirm: false });
    expect(evaluateAssignment(makeNumericFixture({ values: ['80', null], weights: ['50', '50'], mandatory: [true, false] })).achievement).toBe('not_met');
  });
  it('never_turns_absent_or_zero_weight_into_success', () => {
    expect(evaluateAssignment(makeNumericFixture({ values: [null] }))).toMatchObject({ calculation: 'no_data', scorePercent: null, preliminaryPercent: null, coveragePercent: R('0'), canConfirm: false });
    const zero = makeNumericFixture({ values: ['100', '100'], weights: ['100', '0'] }); zero.applicability = [na(zero, 0)];
    expect(evaluateAssignment(zero)).toMatchObject({ calculation: 'blocked', scorePercent: null, qualityFlags: ['zero_applicable_weight'], canConfirm: false });
    const stale = makeNumericFixture(); stale.context.evaluatedAt = '2026-11-23T12:00:00Z';
    expect(evaluateAssignment(stale)).toMatchObject({ scorePercent: R('100'), complete: true, freshness: 'stale', canConfirm: false });
    const unknown = makeNumericFixture(); unknown.facts[0].sourceUpdatedAt = '2026-11-01T00:00:00Z';
    expect(evaluateAssignment(unknown)).toMatchObject({ scorePercent: R('100'), complete: true, freshness: 'unknown', canConfirm: false });
    const missing = makeNumericFixture({ expectedPopulation: [{ kind: 'product', id: fixtureId(101) }, { kind: 'product', id: fixtureId(102) }], observedPopulation: [{ kind: 'product', id: fixtureId(101) }] });
    expect(evaluateAssignment(missing)).toMatchObject({ scorePercent: null, complete: false, canConfirm: false });
    const unsupported = makeNumericFixture();
    expect(Reflect.apply(evaluateAssignment, undefined, [{ ...unsupported, method: { ...unsupported.method, formula: { kind: 'unknown' } } }])).toMatchObject({ calculation: 'blocked', qualityFlags: ['unsupported_formula'], canConfirm: false });
    const absentMetric = makeNumericFixture(); absentMetric.metrics = [];
    expect(evaluateAssignment(absentMetric)).toMatchObject({ calculation: 'blocked', canConfirm: false });
    const wrongUnit = makeNumericFixture(); wrongUnit.metrics[0].unit.code = 'hours';
    expect(evaluateAssignment(wrongUnit)).toMatchObject({ calculation: 'blocked', canConfirm: false });
  });

  it('blocks a result built from another metric through lineage', () => {
    const input = makeNumericFixture({ values: ['80', '100'] });
    input.facts[0].lineage.inputFactRefs = [{ entityType: 'observed_fact', id: input.facts[1].id, revision: 1 }];
    const result = evaluateAssignment(input);
    expect(result.calculation).toBe('blocked');
    expect(result.qualityFlags).toContain('lineage_metric_mismatch');
    expect(result.canConfirm).toBe(false);
  });
});
