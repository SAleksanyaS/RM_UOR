import type { CoreGoalDefinition, DirectoryEntity, DirectoryLink, EvaluationInput, GoalAssignment, MethodVersion, MetricDefinition, ObservedFact, PrepareEvaluationRequest, SourceDefinition, Template } from '../../../domain/workbench/entities';
import type { ActorRef, Clock, EntityRef, Header, ScopeRef, VersionRef } from '../../../domain/workbench/primitives';
import { actorRefSchema, evaluationContextSchema, newUuid, versionRefSchema } from '../../../domain/workbench/primitives';
import { WorkbenchError } from '../../../domain/workbench/errors';
import type { PublicationAnchor } from '../../../domain/workbench/publication';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { selectEvaluationFacts } from './select-facts';

export type OwnEvaluationDefinitions = { read(ref: EntityRef | VersionRef): Header | null; accepts(value: Header, ref: EntityRef): boolean };
export function resolveEvaluationInput(request: PrepareEvaluationRequest, repository: WorkbenchRepository, clock: Clock, actor: ActorRef, own?: OwnEvaluationDefinitions): EvaluationInput {
  const evaluatedAt = clock.now();
  evaluationContextSchema.parse({ evaluatedAt, businessTime: request.businessTime }); actorRefSchema.parse(actor); versionRefSchema.parse(request.assignmentRef);
  if (request.assignmentRef.entityType !== 'goal_assignment') throw new WorkbenchError('BROKEN_REFERENCE', { ref: request.assignmentRef });
  const anchors = new Map<string, PublicationAnchor>();
  const published = <T extends Header>(value: T | null, ref: EntityRef): T => {
    if (!value) throw new WorkbenchError('BROKEN_REFERENCE', { ref });
    const anchor = value.publicationAnchorId === null ? null : repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId });
    if (!anchor || anchor.publicationState !== 'confirmed') { if (own?.accepts(value, ref)) return value; throw new WorkbenchError('REFERENCE_NOT_PUBLISHED', { ref }); }
    anchors.set(anchor.id, anchor); return value;
  };
  const exact = <T extends Header>(ref: VersionRef): T => published((own?.read(ref) as T | null) ?? repository.readVersion<T>(ref), ref);
  const head = <T extends Header>(ref: EntityRef): T => published((own?.read(ref) as T | null) ?? repository.readPublishedHead<T>(ref), ref);
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
    const scopeKey = (scope: ScopeRef) => `${scope.kind}/${scope.id}`;
    const verifyPath = (from: ScopeRef, to: ScopeRef, definitions: DirectoryLink[]): boolean => {
      const edges = new Map<string, string[]>();
      const kinds = { dit_cluster: ['dit', 'cluster'], cluster_product: ['cluster', 'product'], cluster_team: ['cluster', 'team'], product_team: ['product', 'team'] } as const;
      for (const link of definitions) {
        if (link.kind === 'leader') continue;
        const [parent, child] = kinds[link.kind];
        const a = head<DirectoryEntity>(link.from); const b = head<DirectoryEntity>(link.to);
        if (a.kind !== parent || b.kind !== child) throw new WorkbenchError('LINEAGE_SCOPE_MISMATCH');
        const key = `${parent}/${a.id}`; edges.set(key, [...(edges.get(key) ?? []), `${child}/${b.id}`]);
      }
      const reaches = (start: string, target: string): boolean => {
        const pending = [start]; const seen = new Set<string>();
        while (pending.length) { const key = pending.pop()!; if (key === target) return true; if (seen.has(key)) continue; seen.add(key); pending.push(...(edges.get(key) ?? [])); }
        return false;
      };
      // An ancestor/descendant relation in either direction is valid; a shared ancestor does not join sibling scopes.
      return reaches(scopeKey(from), scopeKey(to)) || reaches(scopeKey(to), scopeKey(from));
    };
    const seen = new Set<string>();
    const verifyFact = (fact: ObservedFact) => {
      const id = `${fact.id}/${fact.revision}`; if (seen.has(id)) return; seen.add(id);
      const definitions = fact.lineage.directoryLinkRefs.map(ref => {
        if (ref.entityType !== 'directory_link') throw new WorkbenchError('BROKEN_REFERENCE', { ref });
        const link = exact<DirectoryLink>(ref); links.set(`${ref.id}/${ref.revision}`, ref); return link;
      });
      for (const ref of fact.lineage.inputFactRefs) {
        const child = input.facts.find(f => f.id === ref.id && f.revision === ref.revision);
        if (!child || ref.entityType !== 'observed_fact') continue; // The pure selector reports broken/cyclic lineage.
        if (scopeKey(child.scope) !== scopeKey(fact.scope) && !verifyPath(fact.scope, child.scope, definitions)) throw new WorkbenchError('LINEAGE_SCOPE_MISMATCH');
        verifyFact(child);
      }
    };
    input.facts.filter(f => chosen.has(`${f.id}/${f.revision}`)).forEach(verifyFact);
    input.resolution.directoryLinkRefs = [...links.values()].sort((a, b) => `${a.id}/${a.revision}` < `${b.id}/${b.revision}` ? -1 : 1);
    input.resolution.publicationAnchors = [...anchors.values()];
  }
  return input;
}
