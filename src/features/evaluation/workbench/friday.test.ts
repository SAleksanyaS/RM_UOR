import { describe, expect, it, vi } from 'vitest';
import type { BusinessTime } from '../../../domain/workbench/primitives';
import { fixtureId, makeNumericFixture, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { projectFridaySeries } from './friday';

function fixture(date = '2026-10-22', value = '92') {
  const i = makeNumericFixture({ values: [value] }); i.facts[0].businessTime = { kind: 'as_of', date }; i.captures[0].capturedAt = date + 'T12:00:00Z';
  return { assignmentRef: versionRef('goal_assignment', 15), metricRef: versionRef('metric_definition', 201), scope: i.assignment.scope, facts: i.facts, captures: i.captures, fromInclusive: '2026-10-16', toExclusive: '2026-10-31', evaluatedAt: '2026-11-01T00:00:00Z' };
}
describe('Friday projection', () => {
  it('carries_thursday_without_creating_friday_fact', () => {
    const input = fixture(); const before = structuredClone(input);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Hidden system clock'); });
    let points; try { points = projectFridaySeries(input); } finally { clock.mockRestore(); }
    expect(points.map(p => p.friday)).toEqual(['2026-10-16', '2026-10-23', '2026-10-30']);
    expect(points[0]).toMatchObject({ value: null, sourceFactRef: null, sourceBusinessTime: null, sourceCapturedAt: null, carried: false });
    for (const point of points.slice(1)) expect(point).toMatchObject({ value: '92', carried: true, sourceBusinessTime: { kind: 'as_of', date: '2026-10-22' }, sourceCapturedAt: '2026-10-22T12:00:00Z', warning: 'Данные не обновлялись' });
    expect(input).toEqual(before);
  });

  it('keeps_flat_values_and_excludes_future_capture', () => {
    const input = fixture('2026-10-09', '85'); input.fromInclusive = '2026-10-09'; input.toExclusive = '2026-10-24';
    const add = (seed: number, date: string, capturedAt: string, value: string) => { const capture = { ...input.captures[0], id: fixtureId(seed), capturedAt }; input.captures.push(capture); input.facts.push({ ...input.facts[0], id: fixtureId(seed + 1), captureId: capture.id, value, businessTime: { kind: 'as_of', date }, lineage: { ...input.facts[0].lineage, captureId: capture.id } }); };
    add(500, '2026-10-16', '2026-10-16T12:00:00Z', '85');
    add(510, '2026-10-23', '2026-10-24T12:00:00Z', '92');
    add(520, '2026-10-23', '2026-10-23T21:00:00Z', '93');
    const points = projectFridaySeries(input);
    expect(points.map(p => p.value)).toEqual(['85', '85', '85']);
    expect(points.map(p => p.carried)).toEqual([false, false, true]);
    expect(points.map(p => p.warning)).toEqual([null, null, 'Данные не обновлялись']);
    input.facts = [{ ...input.facts[0], businessTime: { kind: 'unknown' } }];
    const unknown = projectFridaySeries(input)[0];
    expect(unknown.sourceBusinessTime).toEqual({ kind: 'unknown' }); expect(unknown.carried).toBe(true);
  });

  it('reports_ambiguous_series_instead_of_converting_units', () => {
    const input = fixture(); input.facts.push({ ...input.facts[0], id: fixtureId(501), value: '93' });
    expect(() => projectFridaySeries(input)).toThrowError(expect.objectContaining({ code: 'AMBIGUOUS_FACT_SELECTION' }));
    input.facts[1].unitCode = 'hours';
    expect(() => projectFridaySeries(input)).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_SERIES_UNITS' }));
    const period = fixture(); const businessTime: BusinessTime = { kind: 'period', startInclusive: '2026-10-01', endExclusive: '2026-10-24' };
    period.facts[0].businessTime = businessTime;
    const points = projectFridaySeries(period);
    expect(points[0].value).toBeNull(); expect(points[1]).toMatchObject({ value: '92', sourceBusinessTime: businessTime, carried: false });
    expect(points[2].carried).toBe(true);
  });
});
