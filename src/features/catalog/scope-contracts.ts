import type { Assignment, KnowledgeEntity } from '../../domain/contracts';

export type ScopeEntityType = 'team' | 'product' | 'it_service' | 'scope';
export interface NewScopeEntity { clientId: string; type: ScopeEntityType; name: string; selected: boolean }
export interface AssignmentScopeInput {
  baseAssignment: Assignment; active: boolean; teams: string[]; participantIds?: string[];
  target: string; summary: string; newEntities?: NewScopeEntity[];
}
export interface AssignmentScopeResult {
  assignmentId: string; assignment: Assignment; createdEntities: { clientId: string; entity: KnowledgeEntity }[]; operationId: string;
}
