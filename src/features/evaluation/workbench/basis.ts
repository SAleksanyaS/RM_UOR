import { createHash } from 'node:crypto';
import type { EvaluationBasis, EvaluationInput } from '../../../domain/workbench/entities';
import type { Sha256, VersionRef } from '../../../domain/workbench/primitives';
import { selectEvaluationFacts } from './select-facts';

export type BasisContent = Pick<EvaluationBasis, 'assignmentRef' | 'goalRef' | 'methodRef' | 'templateRef' | 'businessTime' | 'expectedPopulation' | 'factRefs' | 'correctionRefs' | 'applicabilityRefs' | 'directoryLinkRefs'>;
const ordered = <T>(values: T[], key: (value: T) => string): T[] => [...new Map(values.map(v => [key(v), v])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, v]) => v);
const refKey = (r: VersionRef) => `${r.entityType}/${r.id}/${r.revision}`;
function normalize(content: BasisContent): BasisContent {
  return { ...content, factRefs: ordered(content.factRefs, refKey), correctionRefs: ordered(content.correctionRefs, refKey), applicabilityRefs: ordered(content.applicabilityRefs, refKey), directoryLinkRefs: ordered(content.directoryLinkRefs, refKey), expectedPopulation: content.expectedPopulation === null ? null : ordered(content.expectedPopulation, s => `${s.kind}/${s.id}`) };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',') + '}';
  return JSON.stringify(value);
}
export function canonicalBasis(input: EvaluationInput): BasisContent {
  const selected = input.goal.mode === 'numeric' ? selectEvaluationFacts(input) : null;
  return normalize({ assignmentRef: { entityType: 'goal_assignment', id: input.assignment.id, revision: input.assignment.revision }, goalRef: { entityType: 'core_goal_definition', id: input.goal.id, revision: input.goal.revision }, methodRef: { entityType: 'method_version', id: input.method.id, revision: input.method.revision }, templateRef: input.resolution.templateRef, businessTime: input.context.businessTime, expectedPopulation: input.assignment.expectedPopulation, factRefs: selected?.factRefs ?? [], correctionRefs: selected?.correctionRefs ?? [], applicabilityRefs: selected?.applicabilityRefs ?? [], directoryLinkRefs: input.resolution.directoryLinkRefs });
}
export function digestBasis(content: BasisContent): Sha256 { return `sha256:${createHash('sha256').update(canonicalJson(normalize(content)), 'utf8').digest('hex')}`; }
