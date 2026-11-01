import { describe, expect, it } from 'vitest';
import type { Attestation, CalculationResult, EvaluationBasis, ManualStatusEvent } from '../../../domain/workbench/entities';
import { makeHeader, makeNumericFixture, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { canonicalBasis, digestBasis } from './basis';
import { evaluateAssignment } from './evaluate';
import { validateAgreedSnapshot, validateAttestation, validateCorrection, validateManualTransition } from './state-rules';

function fixture() {
  const i = makeNumericFixture(); const content = canonicalBasis(i);
  const basis: EvaluationBasis = { ...makeHeader(16), ...content, evaluatedAt: i.context.evaluatedAt, digest: digestBasis(content) };
  const result: CalculationResult = { ...makeHeader(20), ...evaluateAssignment(i) };
  const attestation: Attestation = { ...makeHeader(21), basisDigest: basis.digest, comment: 'Done', evidenceIds: [] };
  return { i, basis, result, attestation };
}
describe('manual, correction and confirmation rules', () => {
  it('requires_manual_result_and_preserves_previous_completion', () => {
    const { i } = fixture();
    const completed: ManualStatusEvent = { ...makeHeader(30), assignmentId: i.assignment.id, from: null, to: 'completed', resultDescription: 'Demo completed', reason: null, evidenceIds: [] };
    expect(() => validateManualTransition(null, { ...completed, resultDescription: null })).toThrow();
    expect(() => validateManualTransition(null, completed)).not.toThrow();
    const next: ManualStatusEvent = { ...completed, id: makeHeader(31).id, from: 'completed', to: 'in_progress', resultDescription: null };
    expect(() => validateManualTransition(completed, next)).toThrow();
    expect(() => validateManualTransition(completed, { ...next, reason: 'Demo reopened' })).not.toThrow();
    expect(completed.resultDescription).toBe('Demo completed');
    const correction = { ...makeHeader(32), factKey: i.facts[0].factKey, originalFactRefs: [versionRef('observed_fact', 10001)], replacement: '12', reason: 'Verified' };
    expect(() => validateCorrection(correction, i.facts)).not.toThrow();
    expect(() => validateCorrection({ ...correction, reason: '' }, i.facts)).toThrow();
    expect(() => validateCorrection({ ...correction, factKey: 'different' }, i.facts)).toThrow();
    expect(() => validateCorrection(correction, [{ ...i.facts[0], id: makeHeader(99).id }])).toThrow();
  });
  it('pins_attestation_and_snapshot_to_exact_basis', () => {
    const { basis, result, attestation } = fixture();
    expect(() => validateAttestation({ basis, result, attestation })).not.toThrow();
    expect(() => validateAttestation({ basis, result, attestation: { ...attestation, comment: '' } })).toThrow();
    expect(() => validateAttestation({ basis, result, attestation: { ...attestation, basisDigest: `sha256:${'f'.repeat(64)}` } })).toThrowError(expect.objectContaining({ code: 'BASIS_MISMATCH' }));
    expect(() => validateAttestation({ basis, result: { ...result, canConfirm: false }, attestation })).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_NOT_ALLOWED' }));
    const { schemaVersion, id, revision, recordedAt, actor, publicationAnchorId, ...numericResult } = result;
    const snapshot = { ...makeHeader(40), basisRef: versionRef('evaluation_basis', 16), numericResult, manualStatusRef: null, attestationRef: null };
    expect(() => validateAgreedSnapshot({ snapshot, basis, result, manualStatus: null, attestation: null })).not.toThrow();
    expect(() => validateAgreedSnapshot({ snapshot: { ...snapshot, numericResult: null }, basis, result, manualStatus: null, attestation: null })).toThrow();
    expect(() => validateAgreedSnapshot({ snapshot: { ...snapshot, manualStatusRef: versionRef('manual_status_event', 30) }, basis, result, manualStatus: null, attestation: null })).toThrow();
    expect(() => validateAgreedSnapshot({ snapshot, basis, result: { ...result, basisRef: versionRef('evaluation_basis', 16, 2) }, manualStatus: null, attestation: null })).toThrowError(expect.objectContaining({ code: 'BASIS_MISMATCH' }));
    expect(() => validateAgreedSnapshot({ snapshot: { ...snapshot, attestationRef: versionRef('attestation', 21) }, basis, result, manualStatus: null, attestation })).not.toThrow();
  });
});
