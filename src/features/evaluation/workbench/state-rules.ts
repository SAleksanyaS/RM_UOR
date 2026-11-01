import type { AgreedSnapshot, Attestation, CalculationResult, EvaluationBasis, ManualCorrection, ManualStatusEvent, NumericEvaluation, ObservedFact } from '../../../domain/workbench/entities';
import type { VersionRef } from '../../../domain/workbench/primitives';
import { WorkbenchError } from '../../../domain/workbench/errors';
import { agreedSnapshotSchema, attestationSchema, calculationResultSchema, evaluationBasisSchema, manualCorrectionSchema, manualStatusEventSchema, numericEvaluationSchema } from '../../../domain/workbench/schemas';

const matches = (ref: VersionRef, entity: { id: string; revision: number }, entityType: string): boolean => ref.entityType === entityType && ref.id === entity.id && ref.revision === entity.revision;
function mismatch(): never { throw new WorkbenchError('BASIS_MISMATCH'); }
export function validateManualTransition(previous: ManualStatusEvent | null, next: ManualStatusEvent): void {
  manualStatusEventSchema.parse(next);
  if (previous) {
    manualStatusEventSchema.parse(previous);
    if (previous.assignmentId !== next.assignmentId || next.from !== previous.to || (previous.to === 'completed' && next.to !== 'completed' && next.to !== 'in_progress')) throw new WorkbenchError('INVALID_MANUAL_TRANSITION');
  } else if (next.from !== null) throw new WorkbenchError('INVALID_MANUAL_TRANSITION');
}
export function validateCorrection(correction: ManualCorrection, originals: ObservedFact[]): void {
  manualCorrectionSchema.parse(correction);
  const selected = correction.originalFactRefs.map(ref => originals.find(f => matches(ref, f, 'observed_fact')));
  if (selected.some(f => !f)) throw new WorkbenchError('CORRECTION_ORIGINAL_MISMATCH');
  const first = selected[0]!;
  if (selected.some(f => f!.factKey !== correction.factKey || f!.sourceId !== first.sourceId || f!.metricId !== first.metricId || f!.scope.id !== first.scope.id || f!.scope.kind !== first.scope.kind || f!.unitCode !== first.unitCode || JSON.stringify(f!.businessTime) !== JSON.stringify(first.businessTime))) throw new WorkbenchError('CORRECTION_ORIGINAL_MISMATCH');
}
export function validateAttestation(input: { basis: EvaluationBasis; result: NumericEvaluation; attestation: Attestation }): void {
  evaluationBasisSchema.parse(input.basis); attestationSchema.parse(input.attestation);
  if (input.attestation.basisDigest !== input.basis.digest || !matches(input.result.basisRef, input.basis, 'evaluation_basis')) mismatch();
  if (!input.result.canConfirm) throw new WorkbenchError('CONFIRMATION_NOT_ALLOWED');
  if ('schemaVersion' in input.result) calculationResultSchema.parse(input.result);
  else numericEvaluationSchema.parse(input.result);
}
export function validateAgreedSnapshot(input: { snapshot: AgreedSnapshot; basis: EvaluationBasis; result: CalculationResult | null; manualStatus: ManualStatusEvent | null; attestation: Attestation | null }): void {
  const { snapshot, basis, result, manualStatus, attestation } = input;
  agreedSnapshotSchema.parse(snapshot); evaluationBasisSchema.parse(basis);
  if (!matches(snapshot.basisRef, basis, 'evaluation_basis')) mismatch();
  if (snapshot.numericResult !== null) {
    if (!result || !matches(result.basisRef, basis, 'evaluation_basis')) mismatch();
    const { schemaVersion, id, revision, recordedAt, actor, publicationAnchorId, ...numeric } = result;
    if (JSON.stringify(numericEvaluationSchema.parse(snapshot.numericResult)) !== JSON.stringify(numericEvaluationSchema.parse(numeric))) mismatch();
    if (manualStatus !== null) mismatch();
  } else {
    if (!manualStatus || !snapshot.manualStatusRef || !matches(snapshot.manualStatusRef, manualStatus, 'manual_status_event') || manualStatus.assignmentId !== basis.assignmentRef.id || result !== null) mismatch();
    manualStatusEventSchema.parse(manualStatus);
  }
  if (snapshot.attestationRef !== null) {
    if (!attestation || !matches(snapshot.attestationRef, attestation, 'attestation') || attestation.basisDigest !== basis.digest) mismatch();
    attestationSchema.parse(attestation);
  } else if (attestation !== null) mismatch();
}
