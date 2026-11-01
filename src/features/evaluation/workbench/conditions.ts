import type { MetricDefinition, MetricRule, NumericCondition } from '../../../domain/workbench/entities';
import type { ExactNumber, Rational } from '../../../domain/workbench/primitives';
import { compare, divide, multiply, toRational } from '../../../domain/workbench/exact-number';
import { WorkbenchError } from '../../../domain/workbench/errors';
import { metricDefinitionSchema, metricRuleSchema, numericConditionSchema } from '../../../domain/workbench/schemas';

export function testCondition(value: ExactNumber, condition: NumericCondition): boolean {
  const c = numericConditionSchema.parse(condition);
  switch (c.op) {
    case 'gte': return compare(value, c.target) >= 0;
    case 'lte': return compare(value, c.target) <= 0;
    case 'eq': return compare(value, c.target) === 0;
    case 'range': return compare(value, c.min) >= 0 && compare(value, c.max) <= 0;
  }
}

export function normalizeMetric(value: ExactNumber | null, rule: MetricRule, metric: MetricDefinition): Rational | null {
  const r = metricRuleSchema.parse(rule); const definition = metricDefinitionSchema.parse(metric);
  const incompatible = () => { throw new WorkbenchError('INCOMPATIBLE_NORMALIZATION', { metricRef: r.metricRef, normalization: r.normalization.kind }); };
  if (r.metricRef.id !== definition.id || r.metricRef.revision !== definition.revision) incompatible();
  const normalization = r.normalization;
  const condition = r.condition;
  if (definition.domain === 'signed_decimal' && normalization.kind !== 'binary_condition_v1') incompatible();
  switch (normalization.kind) {
    case 'increase_ratio_v1': if (condition.op !== 'gte' || compare(condition.target, '0') <= 0) incompatible(); break;
    case 'decrease_ratio_capped_v1': if (condition.op !== 'lte' || compare(condition.target, '0') <= 0 || compare(normalization.maxPercent, '100') <= 0) incompatible(); break;
    case 'zero_counter_v1': if (condition.op !== 'lte' || compare(condition.target, '0') !== 0 || definition.domain !== 'nonnegative_integer') incompatible(); break;
    case 'binary_condition_v1': if (condition.op !== 'eq' && condition.op !== 'range') incompatible(); break;
  }
  if (value === null) return null;
  const number = toRational(value);
  if ((definition.domain !== 'signed_decimal' && compare(number, '0') < 0) || (definition.domain === 'nonnegative_integer' && number.denominator !== '1')) throw new WorkbenchError('INVALID_METRIC_DOMAIN', { metricId: definition.id });
  switch (normalization.kind) {
    case 'increase_ratio_v1': {
      if (condition.op !== 'gte') return incompatible();
      return divide(multiply(number, '100'), condition.target);
    }
    case 'decrease_ratio_capped_v1': {
      if (condition.op !== 'lte') return incompatible();
      if (compare(number, '0') === 0) return toRational(normalization.maxPercent);
      const ratio = divide(multiply(condition.target, '100'), number);
      return compare(ratio, normalization.maxPercent) > 0 ? toRational(normalization.maxPercent) : ratio;
    }
    case 'zero_counter_v1': return toRational(compare(number, '0') === 0 ? '100' : '0');
    case 'binary_condition_v1': return toRational(testCondition(number, condition) ? '100' : '0');
  }
}
