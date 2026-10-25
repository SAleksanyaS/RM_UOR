import type { Evaluation, EvaluationInput, Goal, Observation } from '../../domain/contracts';
import { evaluationFingerprint } from './fingerprint';
import { metricKey, normalizeObservations } from './normalize';
import { evaluateMeasurement } from './measurement';
import { goalProgress } from './progress';
export { goalProgress } from './progress';

const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
const passes = (actual: number, target: number, direction: Goal['direction']) => direction === 'increase' ? actual >= target : actual <= target;

type ParticipantResult = 'met' | 'not_met' | 'unknown' | 'excluded';

export function evaluateGoal(input: EvaluationInput): Evaluation {
  if (input.goal.measurement) return evaluateMeasurement(input);
  const { goal } = input;
  const normalized = normalizeObservations(input);
  const rows = normalized.observations;
  const conflictKeys = new Set(normalized.conflicts.map((entry) => entry.key));
  const flags = new Set<string>();
  if (normalized.conflicts.length) flags.add('conflicting_duplicate_metrics');
  if (normalized.unexpectedParticipants.length) flags.add('unexpected_participants');
  if (goal.officialTarget === null) flags.add('unknown_official_target');
  const scalarRows = rows.filter((row) => row.metricId === goal.id);
  const dimensionalRows = rows.filter((row) => row.metricId !== goal.id);
  const scalar = scalarRows.length > 0 && dimensionalRows.length === 0;
  const mixed = scalarRows.length > 0 && dimensionalRows.length > 0;
  if (mixed) flags.add('mixed_measurement_modes');
  const expected = input.expectedParticipants === undefined
    ? [...new Set(rows.map((row) => row.participantId))]
    : [...new Set(input.expectedParticipants)];
  const absent = expected.filter((id) => !rows.some((row) => row.participantId === id));
  const numericRows = rows.filter((row) => row.state === 'numeric');
  const applicable = rows.filter((row) => row.state === 'numeric' || row.state === 'missing');
  const excluded = rows.length - applicable.length;
  const usable = (row: Observation) => row.state === 'numeric' && finite(row.value)
    && (scalar || finite(row.target)) && !conflictKeys.has(metricKey(row));
  const usableRows = applicable.filter(usable);
  const unknownRows = applicable.filter((row) => !usable(row));
  const missing = unknownRows.length + absent.length;
  if (numericRows.some((row) => row.target === null) && !scalar) flags.add('missing_metric_targets');
  if (missing) flags.add('incomplete_coverage');
  const coverageDenominator = applicable.length + absent.length;
  const coverage = coverageDenominator ? usableRows.length / coverageDenominator * 100 : null;
  const participants = new Map<string, ParticipantResult>();
  for (const id of expected) {
    const participantRows = rows.filter((row) => row.participantId === id);
    const participantApplicable = participantRows.filter((row) => row.state === 'numeric' || row.state === 'missing');
    if (!participantRows.length) { participants.set(id, 'unknown'); continue; }
    if (!participantApplicable.length) { participants.set(id, 'excluded'); continue; }
    const known = participantApplicable.filter(usable);
    if (!scalar && known.some((row) => !passes(row.value!, row.target!, goal.direction))) participants.set(id, 'not_met');
    else if (known.length !== participantApplicable.length || !known.length) participants.set(id, 'unknown');
    else participants.set(id, 'met');
  }
  const eligibleParticipants = [...participants.values()].filter((status) => status !== 'excluded').length;
  const metParticipants = [...participants.values()].filter((status) => status === 'met').length;
  const unknownParticipants = [...participants.values()].filter((status) => status === 'unknown').length;
  let actual: number | null = null;
  if (!mixed && scalar) {
    if (scalarRows.length === 1 && usable(scalarRows[0])) actual = scalarRows[0].value;
    else if (scalarRows.length > 1) flags.add('multiple_scalar_values');
  } else if (!mixed && eligibleParticipants && usableRows.length) actual = metParticipants / eligibleParticipants * 100;
  if (actual === null) flags.add('no_applicable_data');
  const compare = (target: number | null): Evaluation['official'] => {
    if (!finite(target) || actual === null || mixed || (scalar && scalarRows.length !== 1)) return 'unknown';
    if (scalar) return passes(actual, target, goal.direction) ? 'met' : 'not_met';
    // The aggregated metric is a share of successful participants, even when the
    // underlying participant metrics have a decrease direction.
    if (unknownParticipants || normalized.conflicts.length) {
      const upperBound = (metParticipants + unknownParticipants) / eligibleParticipants * 100;
      return upperBound < target ? 'not_met' : 'unknown';
    }
    return passes(actual, target, 'increase') ? 'met' : 'not_met';
  };
  const official = compare(goal.officialTarget);
  const internal = compare(goal.internalTarget);
  const fingerprint = evaluationFingerprint(input);
  const attestation = input.attestation;
  const confirmed = attestation?.fingerprint === fingerprint && attestation.goalId === goal.id
    && attestation.period === input.period && attestation.leaderId === (input.leaderId ?? null);
  return {
    id: `${goal.id}:${input.leaderId ?? 'all'}:${input.period}`, goalId: goal.id, leaderId: input.leaderId ?? null,
    period: input.period, actual,
    progress: goalProgress(actual, goal.officialTarget, scalar ? goal.baseline : 0, scalar ? goal.direction : 'increase', scalar ? goal.unit : '%'),
    officialTarget: goal.officialTarget, internalTarget: goal.internalTarget, official, internal,
    validation: official === 'met' ? confirmed ? 'confirmed' : 'pending' : 'not_required', fingerprint,
    eligibleMetrics: applicable.length,
    metMetrics: scalar ? (official === 'met' ? usableRows.length : 0) : usableRows.filter((row) => passes(row.value!, row.target!, goal.direction)).length,
    eligibleParticipants, metParticipants: scalar ? (official === 'met' ? metParticipants : 0) : metParticipants,
    excluded, missing, coverage, qualityFlags: [...flags].sort(),
  };
}

/** Service-side gate; role/ownership checks belong to the calling command. */
export function validateAchievement(evaluation: Evaluation, comment: string | null | undefined, evidenceIds: string[] = []): void {
  if (evaluation.official !== 'met') throw new Error('Подтвердить можно только рассчитанное выполнение официальной цели.');
  const substantiveComment = (comment?.trim().replace(/\s+/g, ' ').length ?? 0) >= 10;
  if (!substantiveComment && !evidenceIds.some((id) => id.trim()))
    throw new Error('Добавьте содержательный комментарий (не менее 10 символов) или артефакт подтверждения.');
}
