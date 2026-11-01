import type { Capture, CoreGoalDefinition, EvaluationBasis, EvaluationInput, GoalAssignment, MethodVersion, MetricDefinition, ObservedFact, Template } from '../../../domain/workbench/entities';
import type { EntityRef, Header, VersionRef } from '../../../domain/workbench/primitives';
import type { PublicationAnchor } from '../../../domain/workbench/publication';
import { WorkbenchError } from '../../../domain/workbench/errors';
import { canonicalBytes, hashBytes } from './package-manifest';

export type HistoricalRead = (ref: EntityRef | VersionRef) => Header | PublicationAnchor | null;
const equal = (left: unknown, right: unknown) => hashBytes(canonicalBytes(left)) === hashBytes(canonicalBytes(right));
const exact = <T extends Header>(read: HistoricalRead, ref: VersionRef): T => {
  const value = read(ref);
  if (!value) throw new WorkbenchError('REFERENCE_NOT_FOUND', { ref });
  if (value.id !== ref.id || value.revision !== ref.revision) throw new WorkbenchError('REFERENCE_VERSION_MISMATCH', { ref });
  return value as T;
};

/** Validate the definitions saved with a basis, including legacy bases without a time. */
export function historicalBasisDefinitions(basis: EvaluationBasis, read: HistoricalRead) {
  const assignment = exact<GoalAssignment>(read, basis.assignmentRef), goal = exact<CoreGoalDefinition>(read, basis.goalRef), method = exact<MethodVersion>(read, basis.methodRef);
  const mismatch = () => { throw new WorkbenchError('BASIS_MISMATCH'); };
  if (assignment.goalId !== goal.id || goal.mode !== method.mode || goal.measurementMode !== basis.businessTime.kind || (goal.mode === 'numeric') !== (assignment.expectedPopulation !== null)) mismatch();
  if (assignment.methodBinding.kind === 'standalone') {
    if (basis.templateRef !== null || !equal(assignment.methodBinding.methodRef, basis.methodRef)) mismatch();
  } else if (!basis.templateRef || basis.templateRef.id !== assignment.methodBinding.templateId || !equal(exact<Template>(read, basis.templateRef).methodRef, basis.methodRef)) mismatch();
  return { assignment, goal, method };
}

/** Reconstruct immutable historical input. No clock and no current entity heads. */
export function buildHistoricalEvaluationInput(basis: EvaluationBasis, read: HistoricalRead, anchors: readonly PublicationAnchor[] = []): EvaluationInput {
  if (!basis.evaluatedAt) throw new WorkbenchError('BASIS_EVALUATION_TIME_UNKNOWN');
  const { assignment, goal, method } = historicalBasisDefinitions(basis, read);
  const facts = basis.factRefs.map(ref => exact<ObservedFact>(read, ref));
  // Captures are immutable revision 1 at repository, import and archive boundaries.
  const captures = [...new Map(facts.map(fact => [fact.captureId, exact<Capture>(read, { entityType: 'capture', id: fact.captureId, revision: 1 })])).values()];
  const metrics = method.mode === 'numeric' ? method.rules.map(rule => exact<MetricDefinition>(read, rule.metricRef)) : [];
  const corrections: EvaluationInput['corrections'] = basis.correctionRefs.map(ref => exact(read, ref));
  const applicability: EvaluationInput['applicability'] = basis.applicabilityRefs.map(ref => exact(read, ref));
  basis.directoryLinkRefs.forEach(ref => exact(read, ref));
  const byAnchor = new Map(anchors.map(anchor => [anchor.id, anchor]));
  for (const value of [assignment, goal, method, ...metrics, ...facts, ...captures, ...corrections, ...applicability]) {
    if (!value.publicationAnchorId || byAnchor.has(value.publicationAnchorId)) continue;
    const anchor = read({ entityType: 'publication_anchor', id: value.publicationAnchorId });
    if (anchor && 'publicationState' in anchor) byAnchor.set(anchor.id, anchor);
  }
  return { assignment, goal, method, metrics, facts, captures, corrections, applicability,
    context: { evaluatedAt: basis.evaluatedAt, businessTime: basis.businessTime },
    resolution: { basisRef: { entityType: 'evaluation_basis', id: basis.id, revision: basis.revision }, templateRef: basis.templateRef, directoryLinkRefs: basis.directoryLinkRefs, publicationAnchors: [...byAnchor.values()], actor: basis.actor } };
}
