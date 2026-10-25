import { z } from 'zod';
export const decisionFieldsSchema = z.object({ name: z.string().trim().min(1).max(500), goalId: z.string().min(1).max(500).nullable(),
  owner: z.string().trim().min(1).max(500), dueDate: z.iso.date().nullable(), state: z.enum(['open', 'closed']), closureComment: z.string().trim().max(5000) }).strict().superRefine((value, context) => {
  if (value.state === 'closed' && !value.closureComment) context.addIssue({ code: 'custom', path: ['closureComment'], message: 'Укажите основание закрытия решения' });
});
export const decisionEntitySchema = decisionFieldsSchema.safeExtend({ id: z.string().min(1).max(500), type: z.literal('decision'), revision: z.string().min(1).max(500), updatedAt: z.iso.datetime({ offset: true }), updatedBy: z.string().trim().min(1).max(500) });
export const decisionSaveSchema = z.object({ id: z.string().min(1).max(500).optional(), baseRevision: z.string().min(1).max(500).nullable(), decision: decisionFieldsSchema }).strict();
export type DecisionEntity = z.infer<typeof decisionEntitySchema>;
export type DecisionSaveInput = z.infer<typeof decisionSaveSchema>;
