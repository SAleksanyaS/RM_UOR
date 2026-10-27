import type { EvaluationInput, NumericEvaluation } from '../../../domain/workbench/entities';
import { evaluateAssignment } from './evaluate';

const timeFlags = new Set(['stale_data', 'unknown_freshness_anchor', 'future_freshness_anchor']);
/** Ephemeral current quality: agreed results and stored mathematical values remain frozen. */
export function projectEvaluationQuality(stored: NumericEvaluation, input: EvaluationInput): NumericEvaluation {
  const current = evaluateAssignment({ ...input, resolution: { ...input.resolution, basisRef: stored.basisRef } });
  return { ...stored, freshness: current.freshness, canConfirm: stored.achievement === 'met' && stored.complete && stored.calculation === 'ready' && current.canConfirm, qualityFlags: [...new Set([...stored.qualityFlags.filter(flag => !timeFlags.has(flag)), ...current.qualityFlags.filter(flag => timeFlags.has(flag))])].sort() };
}
