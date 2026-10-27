import { ZodError } from 'zod';
import type { EvaluationInput, NumericEvaluation } from '../../../domain/workbench/entities';
import type { ExactNumber } from '../../../domain/workbench/primitives';
import { versionRefSchema } from '../../../domain/workbench/primitives';
import { add, compare, divide, multiply } from '../../../domain/workbench/exact-number';
import { methodVersionSchema } from '../../../domain/workbench/schemas';
import { WorkbenchError } from '../../../domain/workbench/errors';
import { normalizeMetric, testCondition } from './conditions';
import { selectEvaluationFacts } from './select-facts';
import type { FactSelection } from './selection-contracts';

const blockingFlags = new Set(['ambiguous_fact_selection', 'partial_applicability_period', 'metric_version_missing', 'incompatible_units', 'conflicting_row_key', 'ambiguous_source_value', 'ambiguous_correction', 'correction_original_fact_missing', 'fact_source_discrepancy', 'unsupported_correction_reduction']);
const isBlocking = (flag: string): boolean => blockingFlags.has(flag) || flag.startsWith('lineage_');

/** Pure calculation: all time, versions and resolved source inputs come from the caller. */
export function evaluateAssignment(input: EvaluationInput): NumericEvaluation {
  const result: NumericEvaluation = { basisRef: input.resolution.basisRef, calculation: 'blocked', achievement: 'unknown', scorePercent: null, preliminaryPercent: null, coveragePercent: null, missingMetricIds: [], missingPopulation: [], complete: false, freshness: 'unknown', qualityFlags: [], canConfirm: false };
  const blocked = (flag: string): NumericEvaluation => ({ ...result, calculation: 'blocked', canConfirm: false, qualityFlags: [...new Set([...result.qualityFlags, flag])].sort() });
  if (input.goal.mode !== 'numeric' || input.method.mode !== 'numeric') return blocked('numeric_method_required');
  if (input.method.formula?.kind !== 'weighted_mean_v1') return blocked('unsupported_formula');
  try { methodVersionSchema.parse(input.method); versionRefSchema.parse(input.resolution.basisRef); }
  catch (error) { if (error instanceof ZodError) return blocked('invalid_method_contract'); throw error; }
  let selected: FactSelection;
  try { selected = selectEvaluationFacts(input); }
  catch (error) {
    if (error instanceof WorkbenchError) return blocked(error.code.toLowerCase());
    if (error instanceof ZodError) return blocked('invalid_source_contract');
    throw error;
  }
  result.missingMetricIds = [...new Set(selected.missingMetricIds)].sort();
  result.missingPopulation = selected.missingPopulation;
  result.complete = selected.complete; result.freshness = selected.freshness; result.qualityFlags = selected.qualityFlags;
  const applicable = selected.metrics.filter(m => m.applicable);
  if (!applicable.length) return { ...result, calculation: 'not_applicable', achievement: 'not_applicable' };
  const rules = input.method.rules;
  let totalWeight: ExactNumber = '0'; let knownWeight: ExactNumber = '0'; let weighted: ExactNumber = '0';
  let knownCount = 0; let mandatoryFailure = false;
  for (const metric of applicable) {
    const rule = rules.find(r => r.metricRef.id === metric.metricRef.id && r.metricRef.revision === metric.metricRef.revision)!;
    totalWeight = add(totalWeight, rule.originalWeight);
    if (metric.value === null) continue;
    const definition = input.metrics.find(m => m.id === rule.metricRef.id && m.revision === rule.metricRef.revision);
    if (!definition) return blocked('metric_version_missing');
    try {
      const normalized = normalizeMetric(metric.value, rule, definition);
      if (normalized === null) continue;
      knownCount++; knownWeight = add(knownWeight, rule.originalWeight); weighted = add(weighted, multiply(rule.originalWeight, normalized));
      if (rule.mandatory && !testCondition(metric.value, rule.condition)) mandatoryFailure = true;
    } catch (error) {
      if (error instanceof WorkbenchError) return blocked(error.code.toLowerCase());
      if (error instanceof ZodError) return blocked('invalid_normalization_contract');
      throw error;
    }
  }
  if (mandatoryFailure) result.achievement = 'not_met';
  if (compare(totalWeight, '0') === 0) return blocked('zero_applicable_weight');
  result.coveragePercent = divide(multiply('100', knownWeight), totalWeight);
  if (selected.qualityFlags.some(isBlocking)) return { ...result, calculation: 'blocked' };
  if (!knownCount) return { ...result, calculation: 'no_data' };
  if (!result.complete) {
    return { ...result, calculation: 'preliminary', preliminaryPercent: compare(knownWeight, '0') > 0 ? divide(weighted, knownWeight) : null };
  }
  result.calculation = 'ready'; result.scorePercent = divide(weighted, totalWeight);
  result.achievement = !mandatoryFailure && testCondition(result.scorePercent, input.method.formula.scoreCondition) ? 'met' : 'not_met';
  result.canConfirm = result.achievement === 'met' && result.freshness === 'fresh';
  return result;
}
