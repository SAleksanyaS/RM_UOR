import type { Evaluation, EvaluationInput, GoalMeasurement, Observation } from '../../domain/contracts';
import { evaluationFingerprint } from './fingerprint';
import { metricKey, normalizeObservations } from './normalize';
import { measurementSchema } from './measurement-schema';
import { goalProgress } from './progress';

/** Stable business rules shared by confirmation fingerprints and historical comparability. */
export function measurementRules(measurement: GoalMeasurement) {
  return { kind: measurement.kind, aggregation: measurement.aggregation,
    metrics: measurement.metrics.map(({ id, unit, target, direction }) => ({ id, unit, target, direction })).sort((a, b) => a.id.localeCompare(b.id)),
    range: measurement.range ?? null, change: measurement.change ?? null };
}
const passes = (value: number, target: number, direction: 'increase' | 'decrease') => direction === 'increase' ? value >= target : value <= target;
export function evaluateMeasurement(input: EvaluationInput): Evaluation {
  const goal = input.goal, method = goal.measurement!;
  const validMethod = measurementSchema.safeParse(method).success;
  const flags = new Set<string>();
  if (!validMethod) flags.add('invalid_measurement');
  const metricIds = method.metrics?.map(metric => metric.id) ?? [];
  const normalized = normalizeObservations({ ...input, expectedMetricIds: metricIds });
  const expected = [...new Set(input.expectedParticipants ?? [])];
  const conflictKeys = new Set(normalized.conflicts.map(item => item.key));
  if (!expected.length) flags.add('unknown_coverage');
  if (normalized.conflicts.length) flags.add('conflicting_duplicate_metrics');
  if (normalized.unexpectedParticipants.length) flags.add('unexpected_participants');
  const rows = normalized.observations.filter(row => metricIds.includes(row.metricId));
  if (normalized.observations.some(row => !metricIds.includes(row.metricId))) flags.add('unexpected_metrics');
  const binary = method.kind === 'binary' || method.kind === 'milestones';
  const usable = (row: Observation) => row.state === 'numeric' && row.value !== null && Number.isFinite(row.value)
    && (!binary || row.value === 0 || row.value === 1) && !conflictKeys.has(metricKey(row));
  // Explicit exemptions apply only to participant-share methodology. A defined
  // milestone or aggregate input cannot disappear from its denominator.
  const applicable = rows.filter(row => row.state === 'numeric' || row.state === 'missing' || method.kind !== 'participant_share' || !row.reason?.trim());
  const known = applicable.filter(usable);
  const missing = applicable.length - known.length;
  const excluded = rows.length - applicable.length;
  if (missing) flags.add('incomplete_coverage');
  const complete = validMethod && expected.length > 0 && !missing && !normalized.conflicts.length
    && !flags.has('unexpected_metrics') && !flags.has('unexpected_participants');
  const eligible = expected.filter(id => applicable.some(row => row.participantId === id));
  const metParticipants = eligible.filter(id => {
    const values = applicable.filter(row => row.participantId === id);
    return values.length > 0 && values.every(row => {
      const metric = method.metrics.find(metric => metric.id === row.metricId)!;
      return usable(row) && passes(row.value!, metric.target, metric.direction);
    });
  }).length;
  let actual: number | null = null;
  if (complete && known.length) {
    if (method.kind === 'participant_share') actual = eligible.length ? metParticipants / eligible.length * 100 : null;
    else if (method.kind === 'milestones') actual = known.filter(row => row.value === 1).length / known.length * 100;
    else if (method.aggregation !== 'single' || known.length === 1) {
      actual = method.aggregation === 'single' ? known[0].value! : known.reduce((sum, row) => sum + row.value!, 0) / (method.aggregation === 'average' ? known.length : 1);
      if (method.kind === 'change') actual = method.change!.mode === 'percent'
        ? (actual - method.change!.baseline) / Math.abs(method.change!.baseline) * 100 : actual - method.change!.baseline;
    } else flags.add('multiple_scalar_values');
  }
  if (actual !== null && !Number.isFinite(actual)) { actual = null; flags.add('invalid_aggregate'); }
  if (actual === null) flags.add('no_applicable_data');
  const compare = (target: number | null): Evaluation['official'] => {
    if (actual === null) return 'unknown';
    if (method.kind === 'range') return actual >= method.range!.min && actual <= method.range!.max ? 'met' : 'not_met';
    if (target === null || !Number.isFinite(target)) return 'unknown';
    return passes(actual, target, ['participant_share', 'milestones'].includes(method.kind) ? 'increase' : goal.direction) ? 'met' : 'not_met';
  };
  const official = compare(goal.officialTarget), internal = goal.internalTarget === null ? 'unknown' : compare(goal.internalTarget);
  const fingerprint = evaluationFingerprint(input), attestation = input.attestation;
  const confirmed = attestation && !attestation.invalidatedAt && attestation.fingerprint === fingerprint && attestation.goalId === goal.id
    && attestation.period === input.period && attestation.leaderId === (input.leaderId ?? null);
  const progress = actual === null ? null : method.kind === 'range' || method.kind === 'binary' ? official === 'unknown' ? null : official === 'met' ? 100 : 0
    : ['participant_share', 'milestones'].includes(method.kind) ? goalProgress(actual, goal.officialTarget, 0, 'increase', '%')
      : goalProgress(actual, goal.officialTarget, method.kind === 'change' ? 0 : goal.baseline, goal.direction, goal.unit);
  return { id: `${goal.id}:${input.leaderId ?? 'all'}:${input.period}`, goalId: goal.id, leaderId: input.leaderId ?? null, period: input.period,
    actual, progress, officialTarget: goal.officialTarget, internalTarget: goal.internalTarget, official, internal,
    validation: official === 'met' ? confirmed ? 'confirmed' : 'pending' : 'not_required', fingerprint,
    eligibleMetrics: applicable.length, metMetrics: known.filter(row => { const metric = method.metrics.find(metric => metric.id === row.metricId)!; return passes(row.value!, metric.target, metric.direction); }).length,
    eligibleParticipants: eligible.length, metParticipants, excluded, missing,
    coverage: applicable.length ? known.length / applicable.length * 100 : null, qualityFlags: [...flags].sort() };
}
