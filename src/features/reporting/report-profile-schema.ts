import { z } from 'zod';
export const reportProfileFields = z.object({ name: z.string().trim().min(1).max(500), goalIds: z.array(z.string().min(1).max(500)).min(1).max(500), leaderIds: z.array(z.string().min(1).max(500)).max(500), period: z.iso.date(), baselinePeriod: z.iso.date().optional(), templateId: z.string().uuid().optional() }).strict();
export const reportProfileSchema = reportProfileFields.extend({ id: z.string().min(1).max(500), type: z.literal('report_profile'), revision: z.string().min(1).max(500), updatedAt: z.iso.datetime({ offset: true }), updatedBy: z.string().min(1).max(500) }).strict();
export const reportProfileSaveSchema = z.object({ id: z.string().min(1).max(500).optional(), baseRevision: z.string().nullable(), profile: reportProfileFields }).strict();
export type ReportProfile = z.infer<typeof reportProfileSchema>;
