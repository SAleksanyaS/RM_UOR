import type { CanonicalSourceRow, InputReducer } from '../../../domain/workbench/entities';
import type { ExactNumber, VersionRef } from '../../../domain/workbench/primitives';
import { add, compare, divide, multiply, toRational } from '../../../domain/workbench/exact-number';
import { WorkbenchError } from '../../../domain/workbench/errors';
import { canonicalSourceRowSchema, inputReducerSchema } from '../../../domain/workbench/schemas';

export type ReductionInput = { reducer: InputReducer; rows: CanonicalSourceRow[]; unitCode: string; assignmentRef: VersionRef; methodRef: VersionRef; metricRef: VersionRef };
export type ReductionOutcome = { value: ExactNumber | null; sourceRowKeys: string[]; qualityFlags: string[] };

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}';
  return JSON.stringify(value);
}

export function reduceRows(input: ReductionInput): ReductionOutcome {
  const details = { assignmentRef: input.assignmentRef, methodRef: input.methodRef, metricRef: input.metricRef };
  if (!['source_provided_value', 'sum', 'count', 'ratio'].includes(input.reducer.kind)) throw new WorkbenchError('UNSUPPORTED_REDUCER', details);
  const reducer = inputReducerSchema.parse(input.reducer);
  const rows = new Map<string, CanonicalSourceRow>(); const flags = new Set<string>();
  for (const value of input.rows) {
    const row = canonicalSourceRowSchema.parse(value);
    const previous = rows.get(row.rowKey);
    if (previous && stable(previous) !== stable(row)) flags.add('conflicting_row_key');
    else rows.set(row.rowKey, row);
    if (row.unitCode !== input.unitCode) flags.add('incompatible_units');
  }
  const sourceRowKeys = [...rows.keys()].sort();
  const outcome = (value: ExactNumber | null): ReductionOutcome => ({ value: flags.size ? null : value, sourceRowKeys, qualityFlags: [...flags].sort() });
  if (flags.size) return outcome(null);
  if (!rows.size) { flags.add('missing_reducer_component'); return outcome(null); }
  if (reducer.kind === 'count') return outcome(toRational(rows.size.toString()));
  if (reducer.kind === 'source_provided_value' && rows.size !== 1) { flags.add('ambiguous_source_value'); return outcome(null); }
  let sum: ExactNumber = '0'; let denominator: ExactNumber = '0';
  for (const row of rows.values()) {
    const field = reducer.kind === 'ratio' ? reducer.numeratorField : reducer.valueField;
    const value = row.numbers[field];
    const divisor = reducer.kind === 'ratio' ? row.numbers[reducer.denominatorField] : '0';
    if (value === undefined || value === null || divisor === undefined || divisor === null) { flags.add('missing_reducer_component'); continue; }
    sum = add(sum, value); denominator = add(denominator, divisor);
  }
  if (flags.size) return outcome(null);
  if (reducer.kind === 'source_provided_value') return outcome(rows.values().next().value!.numbers[reducer.valueField]);
  if (reducer.kind === 'ratio') {
    if (compare(denominator, '0') === 0) { flags.add('zero_denominator'); return outcome(null); }
    return outcome(multiply(divide(sum, denominator), reducer.multiplier));
  }
  return outcome(toRational(sum));
}
