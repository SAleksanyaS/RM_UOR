import type { KnowledgeEntity } from '../../domain/contracts';
export const knowledgeTypes = ['team', 'product', 'service', 'it_service', 'cluster', 'scope', 'product_leader', 'article'] as const;
export type KnowledgeType = typeof knowledgeTypes[number];
export const isKnowledgeType = (value: string): value is KnowledgeType => (knowledgeTypes as readonly string[]).includes(value);
export const knowledgeLabels: Record<KnowledgeType, string> = { team: 'Команда', product: 'Продукт', service: 'ИТ-услуга', it_service: 'ИТ-услуга', cluster: 'Кластер', scope: 'Другой объект', product_leader: 'Лидер продукта', article: 'Методика и инструкция' };
export interface KnowledgeRecord extends KnowledgeEntity {
  type: KnowledgeType; description: string; body: string; links: { label: string; url: string }[];
  goalIds: string[]; revision: string; archivedAt: string | null;
}
export interface KnowledgeInput {
  type: KnowledgeType; name: string; leaderId: string | null; productId: string | null; aliases: string[];
  description: string; body: string; links: { label: string; url: string }[]; goalIds: string[]; baseRevision?: string;
}
export interface KnowledgeResult { record: KnowledgeRecord; draftId: string }
