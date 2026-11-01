import type { Decimal, Header, VersionRef } from '../primitives';

export type MetricDefinition = Header & { name: string; unit: { code: string; label: string }; domain: 'nonnegative_decimal' | 'nonnegative_integer' | 'signed_decimal' };
export type NumericCondition = { op: 'gte' | 'lte' | 'eq'; target: Decimal } | { op: 'range'; min: Decimal; max: Decimal };
export type Normalization = { kind: 'increase_ratio_v1' } | { kind: 'decrease_ratio_capped_v1'; maxPercent: Decimal } | { kind: 'zero_counter_v1' } | { kind: 'binary_condition_v1' };
export type InputReducer = { kind: 'source_provided_value' | 'sum'; valueField: string } | { kind: 'count' } | { kind: 'ratio'; numeratorField: string; denominatorField: string; multiplier: Decimal };
export type MetricRule = { metricRef: VersionRef; mandatory: boolean; originalWeight: Decimal; condition: NumericCondition; normalization: Normalization; freshness: { maxAgeHours: Decimal; updateEveryHours: Decimal }; reducer: InputReducer };
export type MethodVersion = Header & ({ mode: 'numeric'; rules: MetricRule[]; formula: { kind: 'weighted_mean_v1'; scoreCondition: NumericCondition } } | { mode: 'manual_status' });
