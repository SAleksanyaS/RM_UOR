import { describe, expect, it } from 'vitest';
import type { EvaluationInput, MetricRule } from '../../../domain/workbench/entities';
import { fixtureId, makeHeader, makeNumericFixture, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { factFreshness, selectEvaluationFacts } from './select-facts';

const rule = (i: EvaluationInput): MetricRule => { if (i.method.mode !== 'numeric') throw new Error('numeric'); return i.method.rules[0]; };
const ref = (entityType: string, value: { id: string; revision: number }) => ({ entityType, id: value.id, revision: value.revision });
function addObservation(i: EvaluationInput, seed: number, date: string, capturedAt: string, value: string) {
  const capture = { ...i.captures[0], id: fixtureId(seed), operationId: fixtureId(seed + 1), capturedAt, canonicalRows: i.captures[0].canonicalRows.map(row => ({ ...row, businessTime: { kind: 'as_of' as const, date }, numbers: { demo_value: value } })) };
  const fact = { ...i.facts[0], id: fixtureId(seed + 2), captureId: capture.id, businessTime: { kind: 'as_of' as const, date }, value, lineage: { ...i.facts[0].lineage, captureId: capture.id } };
  i.captures.push(capture); i.facts.push(fact); return fact;
}
function na(i: EvaluationInput, metricIndex = 0, start = '2026-10-01', end: string | null = '2026-11-01') {
  return { ...makeHeader(800 + metricIndex, { publicationAnchorId: i.goal.publicationAnchorId }), assignmentId: i.assignment.id, metricId: i.metrics[metricIndex].id, period: { startInclusive: start, endExclusive: end }, kind: 'not_applicable' as const, reason: 'demo exception' };
}

describe('explicit fact selection', () => {
  it('selects_as_of_and_exact_period', () => {
    const i = makeNumericFixture();
    i.facts[0].businessTime = { kind: 'as_of', date: '2026-10-22' };
    const selectedRef = ref('observed_fact', i.facts[0]);
    addObservation(i, 500, '2026-10-22', '2026-10-24T09:00:00Z', '200');
    addObservation(i, 510, '2026-10-24', '2026-10-23T09:00:00Z', '300');
    addObservation(i, 520, '2026-10-23', '2026-10-23T21:00:00Z', '400');
    i.context.evaluatedAt = '2026-10-25T12:00:00Z';
    expect(selectEvaluationFacts(i).factRefs).toEqual([selectedRef]);
    expect(selectEvaluationFacts(i).metrics[0].value).toBe('100');
    const p = makeNumericFixture({ context: { evaluatedAt: '2026-11-02T00:00:00Z', businessTime: { kind: 'period', startInclusive: '2026-10-01', endExclusive: '2026-11-01' } } });
    const periods = [ { kind: 'period' as const, startInclusive: '2026-10-01', endExclusive: '2026-10-20' }, { kind: 'period' as const, startInclusive: '2026-10-15', endExclusive: '2026-11-15' }, { kind: 'period' as const, startInclusive: '2026-11-01', endExclusive: '2026-12-01' }, { kind: 'unknown' as const } ];
    p.facts.push(...periods.map((businessTime, index) => ({ ...p.facts[0], id: fixtureId(900 + index), businessTime })));
    expect(selectEvaluationFacts(p).factRefs).toEqual([ref('observed_fact', p.facts[0])]);
    expect(() => selectEvaluationFacts({ ...p, goal: { ...p.goal, measurementMode: 'as_of' } })).toThrowError(expect.objectContaining({ code: 'MEASUREMENT_MODE_MISMATCH' }));
  });

  it('does_not_guess_ties_or_population', () => {
    const A = { kind: 'product' as const, id: fixtureId(101) }; const B = { kind: 'product' as const, id: fixtureId(102) };
    const i = makeNumericFixture({ expectedPopulation: [A, B], observedPopulation: [A] });
    const selected = selectEvaluationFacts(i);
    expect(selected.missingPopulation).toEqual([{ metricId: i.metrics[0].id, scope: B }]);
    expect(selected.metrics[0].value).toBeNull(); expect(selected.complete).toBe(false);
    const full = makeNumericFixture({ expectedPopulation: [A, B] }); rule(full).reducer = { kind: 'sum', valueField: 'demo_value' };
    full.captures[0].result = 'partial'; full.captures[0].rejectedRows = 1;
    expect(selectEvaluationFacts(full)).toMatchObject({ complete: true, missingPopulation: [] });
    expect(selectEvaluationFacts(full).metrics[0].value).toEqual({ numerator: '200', denominator: '1' });
    const tie = makeNumericFixture(); tie.facts.push({ ...tie.facts[0], id: fixtureId(901), value: '99' });
    for (const facts of [tie.facts, [...tie.facts].reverse()]) expect(selectEvaluationFacts({ ...tie, facts }).qualityFlags).toContain('ambiguous_fact_selection');
    const duplicate = makeNumericFixture(); duplicate.facts.push(structuredClone(duplicate.facts[0]));
    expect(selectEvaluationFacts(duplicate).metrics[0].value).toBe('100');
    expect(selectEvaluationFacts(duplicate).factRefs).toHaveLength(1);
    for (const seed of [910, 920]) duplicate.facts.push({ ...duplicate.facts[0], id: fixtureId(seed), scope: { kind: 'team', id: fixtureId(seed + 1) }, origin: 'reducer', lineage: { ...duplicate.facts[0].lineage, inputFactRefs: [ref('observed_fact', duplicate.facts[0])] } });
    expect(selectEvaluationFacts(duplicate).metrics[0].value).toBe('100');
  });

  it('uses_business_freshness_not_capture_or_correction_clock', () => {
    const i = makeNumericFixture({ values: ['10'] }); const r = rule(i); r.freshness.maxAgeHours = '24';
    const fact = { ...i.facts[0], sourceUpdatedAt: '2026-10-22T12:00:00Z' };
    expect(factFreshness({ fact, rule: r, evaluatedAt: '2026-10-23T12:00:00Z' }).freshness).toBe('fresh');
    expect(factFreshness({ fact, rule: r, evaluatedAt: '2026-10-23T12:00:00.001Z' }).freshness).toBe('stale');
    expect(factFreshness({ fact: { ...fact, sourceUpdatedAt: null }, rule: r, evaluatedAt: '2026-10-23T21:00:00Z' }).freshness).toBe('fresh');
    expect(factFreshness({ fact: { ...fact, sourceUpdatedAt: null }, rule: r, evaluatedAt: '2026-10-23T21:00:00.001Z' }).freshness).toBe('stale');
    expect(factFreshness({ fact: { ...fact, sourceUpdatedAt: null, businessTime: { kind: 'period', startInclusive: '2026-10-01', endExclusive: '2026-10-24' } }, rule: r, evaluatedAt: '2026-10-24T20:59:59.999Z' }).freshness).toBe('fresh');
    expect(factFreshness({ fact: { ...fact, sourceUpdatedAt: '2026-10-24T00:00:00Z' }, rule: r, evaluatedAt: i.context.evaluatedAt })).toMatchObject({ freshness: 'unknown', qualityFlags: ['future_freshness_anchor'] });
    expect(factFreshness({ fact: { ...fact, sourceUpdatedAt: null, businessTime: { kind: 'unknown' } }, rule: r, evaluatedAt: i.context.evaluatedAt }).freshness).toBe('unknown');
    i.facts[0] = fact;
    i.corrections = [{ ...makeHeader(930, { publicationAnchorId: i.goal.publicationAnchorId }), factKey: fact.factKey, originalFactRefs: [ref('observed_fact', fact)], replacement: '12', reason: 'demo correction' }];
    const newer = addObservation(i, 940, '2026-10-23', '2026-10-23T10:00:00Z', '11'); newer.sourceUpdatedAt = '2026-10-23T10:00:00Z';
    const corrected = selectEvaluationFacts(i);
    expect(corrected.metrics[0].value).toBe('12'); expect(corrected.metrics[0].freshness).toBe('fresh');
    expect(corrected.qualityFlags).toContain('correction_source_discrepancy');
    expect(corrected.correctionRefs).toEqual([ref('manual_correction', i.corrections[0])]);
    i.context.evaluatedAt = '2026-10-23T12:00:00.001Z'; expect(selectEvaluationFacts(i).freshness).toBe('stale');
    i.corrections[0].factKey = 'another period/key'; expect(selectEvaluationFacts(i).metrics[0].value).toBe('11');
  });

  it('expires_na_without_removing_original_weights', () => {
    const i = makeNumericFixture(); i.applicability = [na(i, 0, '2026-10-01', '2026-10-24')];
    expect(selectEvaluationFacts(i).metrics[0].applicable).toBe(false);
    expect(rule(i).originalWeight).toBe('100');
    i.context.businessTime = { kind: 'as_of', date: '2026-10-24' };
    expect(selectEvaluationFacts(i).metrics[0].applicable).toBe(true);
    const p = makeNumericFixture({ context: { evaluatedAt: '2026-11-02T00:00:00Z', businessTime: { kind: 'period', startInclusive: '2026-10-01', endExclusive: '2026-11-01' } } });
    p.applicability = [na(p, 0, '2026-10-15', '2026-11-01')];
    expect(selectEvaluationFacts(p).qualityFlags).toContain('partial_applicability_period');
    expect(selectEvaluationFacts(p).metrics[0].value).toBeNull();
    p.applicability[0].assignmentId = fixtureId(999); expect(selectEvaluationFacts(p).metrics[0].applicable).toBe(true);
  });

  it('blocks broken or cyclic lineage and incompatible units', () => {
    const i = makeNumericFixture();
    i.facts[0].lineage.inputFactRefs = [versionRef('observed_fact', 999)];
    expect(selectEvaluationFacts(i).qualityFlags).toContain('lineage_reference_missing');
    i.facts[0].lineage.inputFactRefs = [ref('observed_fact', i.facts[0])];
    expect(selectEvaluationFacts(i).qualityFlags).toContain('lineage_cycle');
    i.facts[0].lineage.inputFactRefs = []; i.facts[0].unitCode = 'hours';
    expect(selectEvaluationFacts(i).qualityFlags).toContain('incompatible_units');
  });

  it('rejects source cells that disagree with the materialized fact and deduplicates equal ties', () => {
    const i = makeNumericFixture();
    i.captures[0].canonicalRows[0].numbers.demo_value = null;
    expect(selectEvaluationFacts(i).metrics[0].value).toBeNull();
    i.captures[0].canonicalRows[0].numbers.demo_value = '99';
    expect(selectEvaluationFacts(i).qualityFlags).toContain('fact_source_discrepancy');
    const equal = makeNumericFixture();
    equal.facts.push({ ...equal.facts[0], id: fixtureId(990) });
    const selected = selectEvaluationFacts(equal);
    expect(selected.metrics[0].value).toBe('100');
    expect(selected.qualityFlags).not.toContain('ambiguous_fact_selection');
    expect(selected.factRefs).toHaveLength(2);
  });

  it('applies a published correction to one logical derived observation', () => {
    const i = makeNumericFixture(); const root = i.facts[0];
    const leaf = { ...root, id: fixtureId(980), factKey: 'demo_leaf', lineage: { ...root.lineage } };
    root.origin = 'reducer'; root.lineage = { ...root.lineage, inputFactRefs: [ref('observed_fact', leaf)] };
    i.facts.push(leaf);
    // The leaf is an earlier input to the selected current root, not an equal-time competing source fact.
    const earlierCapture = { ...i.captures[0], id: fixtureId(981), capturedAt: '2026-10-23T08:00:00Z' };
    i.captures.push(earlierCapture); leaf.captureId = earlierCapture.id; leaf.lineage = { ...leaf.lineage, captureId: earlierCapture.id };
    i.corrections = [{ ...makeHeader(982, { publicationAnchorId: i.goal.publicationAnchorId }), factKey: root.factKey, originalFactRefs: [ref('observed_fact', root)], replacement: '50', reason: 'Demo verified correction' }];
    const selected = selectEvaluationFacts(i);
    expect(selected.metrics[0].value).toBe('50');
    expect(selected.correctionRefs).toEqual([ref('manual_correction', i.corrections[0])]);
    expect(selected.factRefs).toContainEqual(ref('observed_fact', root));
  });
});
