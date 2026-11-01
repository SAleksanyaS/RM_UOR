import { describe, expect, it } from 'vitest';
import type { CanonicalSourceRow, InputReducer } from '../../../domain/workbench/entities';
import { makeSourceRow, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { reduceRows } from './reducers';

function input(reducer: InputReducer, rows: CanonicalSourceRow[]) { return { reducer, rows, unitCode: 'demo_unit', assignmentRef: versionRef('goal_assignment', 15), methodRef: versionRef('method_version', 14), metricRef: versionRef('metric_definition', 201) }; }
describe('whitelisted reducers', () => {
  it('reduces_unique_rows_and_preserves_missing', () => {
    const a = makeSourceRow('A', { value: '2' }); const b = makeSourceRow('B', { value: '3' });
    const request = input({ kind: 'sum', valueField: 'value' }, [b, a, structuredClone(a)]); const before = structuredClone(request);
    expect(reduceRows(request)).toEqual({ value: { numerator: '5', denominator: '1' }, sourceRowKeys: ['A', 'B'], qualityFlags: [] });
    expect(request).toEqual(before);
    expect(reduceRows(input({ kind: 'count' }, request.rows)).value).toEqual({ numerator: '2', denominator: '1' });
    expect(reduceRows(input({ kind: 'source_provided_value', valueField: 'value' }, [a])).value).toBe('2');
    expect(reduceRows(input({ kind: 'source_provided_value', valueField: 'value' }, [a, b]))).toMatchObject({ value: null, qualityFlags: ['ambiguous_source_value'] });
    const ratio: InputReducer = { kind: 'ratio', numeratorField: 'n', denominatorField: 'd', multiplier: '100' };
    expect(reduceRows(input(ratio, [makeSourceRow('A', { n: '1', d: '2' }), makeSourceRow('B', { n: '2', d: '4' })])).value).toEqual({ numerator: '50', denominator: '1' });
    expect(reduceRows(input(ratio, [makeSourceRow('A', { n: '1', d: '0' })]))).toMatchObject({ value: null, qualityFlags: ['zero_denominator'] });
    expect(reduceRows(input(ratio, [makeSourceRow('A', { n: '1', d: null })]))).toMatchObject({ value: null, qualityFlags: ['missing_reducer_component'] });
    expect(reduceRows(input({ kind: 'sum', valueField: 'value' }, [{ ...a, unitCode: 'hours' }]))).toMatchObject({ value: null, qualityFlags: ['incompatible_units'] });
    expect(reduceRows(input({ kind: 'sum', valueField: 'value' }, [a, { ...a, numbers: { value: '3' } }]))).toMatchObject({ value: null, qualityFlags: ['conflicting_row_key'] });
    expect(reduceRows(input({ kind: 'sum', valueField: 'value' }, []))).toMatchObject({ value: null, qualityFlags: ['missing_reducer_component'] });
    expect(reduceRows(input({ kind: 'sum', valueField: 'value' }, [makeSourceRow('A', {})]))).toMatchObject({ value: null, qualityFlags: ['missing_reducer_component'] });
    const unsupported = { ...input({ kind: 'count' }, [a]), reducer: { kind: 'average' } };
    expect(() => Reflect.apply(reduceRows, undefined, [unsupported])).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_REDUCER', details: expect.objectContaining({ assignmentRef: unsupported.assignmentRef, methodRef: unsupported.methodRef, metricRef: unsupported.metricRef }) }));
  });
});
