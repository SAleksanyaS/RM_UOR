import { createHash } from 'node:crypto';
import type { EvaluationInput } from '../../domain/contracts';
import { businessObservation, normalizeObservations } from './normalize';

/** Versioned business fingerprint; export timestamps, row ids, display names and weights are intentionally excluded. */
export function evaluationFingerprint(input: EvaluationInput): string {
  const normalized = normalizeObservations(input);
  const goal = input.goal;
  const canonical = {
    methodology: 'participant-all-applicable-metrics-v1',
    goal: { id: goal.id, direction: goal.direction, officialTarget: goal.officialTarget,
      internalTarget: goal.internalTarget, baseline: goal.baseline, unit: goal.unit, scopeType: goal.scopeType },
    leaderId: input.leaderId ?? null, period: input.period,
    expectedParticipants: input.expectedParticipants === undefined ? null : [...new Set(input.expectedParticipants)].sort(),
    expectedMetricIds: input.expectedMetricIds === undefined ? null : [...new Set(input.expectedMetricIds)].sort(),
    scopeRevision: input.scopeRevision ?? null,
    observations: normalized.observations.map(businessObservation), conflicts: normalized.conflicts,
  };
  return `evaluation-v1:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}
