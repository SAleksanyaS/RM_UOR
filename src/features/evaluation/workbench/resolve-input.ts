import type { CoreGoalDefinition, DirectoryLink, EvaluationInput, GoalAssignment, MethodVersion, MetricDefinition, PrepareEvaluationRequest, SourceDefinition, Template } from '../../../domain/workbench/entities';
import type { ActorRef, Clock, EntityRef, Header, VersionRef } from '../../../domain/workbench/primitives';
import { actorRefSchema, evaluationContextSchema, newUuid, versionRefSchema } from '../../../domain/workbench/primitives';
import { WorkbenchError } from '../../../domain/workbench/errors';
import type { PublicationAnchor } from '../../../domain/workbench/publication';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { selectEvaluationFacts } from './select-facts';

export function resolveEvaluationInput(request: PrepareEvaluationRequest, repository: WorkbenchRepository, clock: Clock, actor: ActorRef): EvaluationInput {
  const evaluatedAt = clock.now();
  evaluationContextSchema.parse({ evaluatedAt, businessTime: request.businessTime }); actorRefSchema.parse(actor); versionRefSchema.parse(request.assignmentRef);
  if (request.assignmentRef.entityType !== 'goal_assignment') throw new WorkbenchError('BROKEN_REFERENCE', { ref: request.assignmentRef });
  const anchors = new Map<string, PublicationAnchor>();
  const published = <T extends Header>(value: T | null, ref: EntityRef): T => {
    if (!value) throw new WorkbenchError('BROKEN_REFERENCE', { ref });
    const anchor = value.publicationAnchorId === null ? null : repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId });
    if (!anchor || anchor.publicationState !== 'confirmed') throw new WorkbenchError('REFERENCE_NOT_PUBLISHED', { ref });
    anchors.set(anchor.id, anchor); return value;
  };
  const exact = <T extends Header>(ref: VersionRef): T => published(repository.readVersion<T>(ref), ref);
  const head = <T extends Header>(ref: EntityRef): T => published(repository.readPublishedHead<T>(ref), ref);
  const assignment = exact<GoalAssignment>(request.assignmentRef);
  const goal = head<CoreGoalDefinition>({ entityType: 'core_goal_definition', id: assignment.goalId });
  const source = head<SourceDefinition>({ entityType: 'source_definition', id: goal.sourceId });
  if (source.goalId !== goal.id || (source.kind === 'manual_status') !== (goal.mode === 'manual_status')) throw new WorkbenchError('GOAL_SOURCE_MISMATCH');
  if (goal.measurementMode !== request.businessTime.kind) throw new WorkbenchError('MEASUREMENT_MODE_MISMATCH');
  const template = assignment.methodBinding.kind === 'template' ? head<Template>({ entityType: 'template', id: assignment.methodBinding.templateId }) : null;
  const methodRef = template?.methodRef ?? (assignment.methodBinding.kind === 'standalone' ? assignment.methodBinding.methodRef : null);
  if (!methodRef || methodRef.entityType !== 'method_version') throw new WorkbenchError('BROKEN_REFERENCE', { ref: methodRef });
  const method = exact<MethodVersion>(methodRef);
  if (goal.mode !== method.mode) throw new WorkbenchError('METHOD_MODE_MISMATCH');
  const metrics: MetricDefinition[] = method.mode === 'numeric' ? method.rules.map(rule => {
    if (rule.metricRef.entityType !== 'metric_definition') throw new WorkbenchError('BROKEN_REFERENCE', { ref: rule.metricRef });
    return exact<MetricDefinition>(rule.metricRef);
  }) : [];
  if (goal.mode === 'numeric' && !assignment.expectedPopulation?.length) throw new WorkbenchError('EXPECTED_POPULATION_REQUIRED');
  const candidates = goal.mode === 'numeric' ? repository.readEvaluationCandidates({ sourceId: source.id, assignmentId: assignment.id, metricIds: metrics.map(m => m.id), scopes: assignment.expectedPopulation!, businessTime: request.businessTime, evaluatedAt }) : { facts: [], captures: [], applicability: [], corrections: [] };
  for (const entity of [...candidates.applicability, ...candidates.corrections]) published(entity, { entityType: 'applicability', id: entity.id });
  const input: EvaluationInput = { assignment, goal, method, metrics, ...candidates, context: { evaluatedAt, businessTime: request.businessTime }, resolution: { basisRef: { entityType: 'evaluation_basis', id: newUuid(), revision: 1 }, templateRef: template ? { entityType: 'template', id: template.id, revision: template.revision } : null, directoryLinkRefs: [], publicationAnchors: [...anchors.values()], actor } };
  if (goal.mode === 'numeric') {
    const selection = selectEvaluationFacts(input);
    const chosen = new Set(selection.factRefs.map(ref => `${ref.id}/${ref.revision}`));
    const links = new Map<string, VersionRef>();
    for (const fact of input.facts.filter(f => chosen.has(`${f.id}/${f.revision}`))) for (const ref of fact.lineage.directoryLinkRefs) {
      if (ref.entityType !== 'directory_link') throw new WorkbenchError('BROKEN_REFERENCE', { ref });
      exact<DirectoryLink>(ref); links.set(`${ref.id}/${ref.revision}`, ref);
    }
    input.resolution.directoryLinkRefs = [...links.values()].sort((a, b) => `${a.id}/${a.revision}` < `${b.id}/${b.revision}` ? -1 : 1);
    input.resolution.publicationAnchors = [...anchors.values()];
  }
  return input;
}
