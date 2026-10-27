import type { CalculationResult, EvaluationBasis, EvaluationInput } from '../../../domain/workbench/entities';
import type { Header, VersionRef } from '../../../domain/workbench/primitives';
import { newUuid } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { canonicalBasis, digestBasis } from './basis';
import { evaluateAssignment } from './evaluate';

export function prepareEvaluation(input: EvaluationInput, repository: WorkbenchRepository): { basisRef: VersionRef; resultRef: VersionRef | null } {
  const content = canonicalBasis(input); const digest = digestBasis(content);
  return repository.transaction(() => {
    const found = repository.findEvaluationByDigest(digest); if (found) return found;
    const header = (id: string): Header => ({ schemaVersion: 1, id, revision: 1, recordedAt: input.context.evaluatedAt, actor: input.resolution.actor, publicationAnchorId: null });
    const basis: EvaluationBasis = { ...header(input.resolution.basisRef.id), ...content, evaluatedAt: input.context.evaluatedAt, digest };
    const basisRef = repository.append('evaluation_basis', basis, null);
    let resultRef: VersionRef | null = null;
    if (input.goal.mode === 'numeric') {
      const result: CalculationResult = { ...header(newUuid()), ...evaluateAssignment({ ...input, resolution: { ...input.resolution, basisRef } }) };
      resultRef = repository.append('calculation_result', result, null);
    }
    repository.sqlForModule('evaluation').run('INSERT INTO wb_evaluation_digest(digest,basis_id,basis_revision,result_id,result_revision) VALUES(?,?,?,?,?)', [digest, basisRef.id, basisRef.revision, resultRef?.id ?? null, resultRef?.revision ?? null]);
    return { basisRef, resultRef };
  });
}
