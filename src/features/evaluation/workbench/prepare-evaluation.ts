import type { CalculationResult, EvaluationBasis, EvaluationInput } from '../../../domain/workbench/entities';
import type { Header, VersionRef } from '../../../domain/workbench/primitives';
import { newUuid } from '../../../domain/workbench/primitives';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { canonicalBasis, digestBasis } from './basis';
import { evaluateAssignment } from './evaluate';

export type EvaluationMaterializationStore = Pick<WorkbenchRepository, 'transaction' | 'findEvaluationByDigest' | 'append'> & {
  remember(digest: EvaluationBasis['digest'], refs: { basisRef: VersionRef; resultRef: VersionRef | null }): void;
};
export function prepareEvaluation(input: EvaluationInput, repository: WorkbenchRepository, local?: EvaluationMaterializationStore): { basisRef: VersionRef; resultRef: VersionRef | null } {
  const content = canonicalBasis(input); const digest = digestBasis(content);
  const storage: EvaluationMaterializationStore = local ?? { ...repository, remember(digest, refs) { repository.sqlForModule('evaluation').run('INSERT INTO wb_evaluation_digest(digest,basis_id,basis_revision,result_id,result_revision) VALUES(?,?,?,?,?)', [digest, refs.basisRef.id, refs.basisRef.revision, refs.resultRef?.id ?? null, refs.resultRef?.revision ?? null]); } };
  return storage.transaction(() => {
    const found = storage.findEvaluationByDigest(digest); if (found) return found;
    const header = (id: string): Header => ({ schemaVersion: 1, id, revision: 1, recordedAt: input.context.evaluatedAt, actor: input.resolution.actor, publicationAnchorId: null });
    const basis: EvaluationBasis = { ...header(input.resolution.basisRef.id), ...content, evaluatedAt: input.context.evaluatedAt, digest };
    const basisRef = storage.append('evaluation_basis', basis, null);
    let resultRef: VersionRef | null = null;
    if (input.goal.mode === 'numeric') {
      const result: CalculationResult = { ...header(newUuid()), ...evaluateAssignment({ ...input, resolution: { ...input.resolution, basisRef } }) };
      resultRef = storage.append('calculation_result', result, null);
    }
    storage.remember(digest, { basisRef, resultRef });
    return { basisRef, resultRef };
  });
}
