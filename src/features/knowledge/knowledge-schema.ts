import { z } from 'zod';
import { knowledgeTypes } from './knowledge-contracts';
const id = z.string().trim().min(1).max(500);
export const knowledgeStoredFields = {
  description: z.string().max(10000).optional(), body: z.string().max(100000).optional(),
  links: z.array(z.object({ label: z.string().trim().min(1).max(500), url: z.string().url().refine(value => /^https?:\/\//i.test(value), 'Разрешены HTTP/HTTPS ссылки') }).strict()).max(50).optional(),
  goalIds: z.array(id).max(500).optional(), revision: id.optional(), archivedAt: z.iso.datetime({ offset: true }).nullable().optional(),
};
export const knowledgeInputSchema = z.object({ type: z.enum(knowledgeTypes), name: id, leaderId: id.nullable(), productId: id.nullable(),
  aliases: z.array(id).max(100), description: knowledgeStoredFields.description.nonoptional(), body: knowledgeStoredFields.body.nonoptional(),
  links: knowledgeStoredFields.links.nonoptional(), goalIds: knowledgeStoredFields.goalIds.nonoptional(), baseRevision: id.optional() }).strict();
export const archiveKnowledgeSchema = z.object({ baseRevision: id, archived: z.boolean() }).strict();
