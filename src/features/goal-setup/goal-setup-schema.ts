import { z } from 'zod';
import { measurementSchema } from '../evaluation/measurement-schema';
const id = z.string().trim().min(1).max(500);
const text = z.string().max(5000);
const webUrl = z.string().url().refine(value => /^https?:\/\//i.test(value), 'Разрешены HTTP/HTTPS ссылки');
const url = webUrl.nullable();
export const goalSetupInputSchema = z.object({ requestId: id, goalId: id.optional(), baseRevision: id.optional(),
  goal: z.object({ title: id, category: z.enum(['process', 'data', 'architecture', 'security']), officialTarget: z.number().finite().nullable(),
    internalTarget: z.number().finite().nullable(), unit: z.string().max(100), direction: z.enum(['increase', 'decrease']),
    target: text.optional(), metric: text.optional(), summary: text.optional(), scopeType: z.string().max(200).optional(), ownerId: id.nullable().optional(), curatorId: id.nullable().optional(),
    dueDate: z.iso.date().nullable().optional(), baseline: z.number().finite().nullable().optional(), workDirectionId: id.nullable().optional(),
    priority: z.enum(['high', 'normal', 'low']).nullable().optional(), weight: z.number().finite().nonnegative().nullable().optional(),
    links: z.array(z.object({ label: text, url: webUrl, kind: text }).strict()).max(50).optional(), actions: z.array(text).max(50).optional() }).strict(),
  measurement: measurementSchema,
  assignments: z.array(z.object({ leaderId: id, participantIds: z.array(id).min(1).max(5000) }).strict()).max(500),
  source: z.object({ existingSourceId: id.optional(), kind: z.enum(['dashboard', 'attachment', 'manual', 'file', 'demo']).optional(), name: id.optional(),
    url: url.optional(), accessUrl: url.optional(), freshnessHours: z.number().finite().positive().max(876000).optional() }).strict(),
  sample: z.object({ period: z.iso.date(), rows: z.array(z.object({ leaderId: id.nullable(), participantId: id, metricId: id,
    value: z.number().finite().nullable(), state: z.enum(['numeric', 'exception', 'no_events', 'missing']), reason: text.nullable() }).strict()).max(20000) }).strict(),
}).strict().superRefine((input, ctx) => {
  if (input.goal.scopeType === 'global') {
    if (input.assignments.length) ctx.addIssue({ code: 'custom', path: ['assignments'], message: 'Общая цель ДИТ не смешивается с персональными назначениями' });
    if (input.measurement.kind === 'participant_share') ctx.addIssue({ code: 'custom', path: ['measurement'], message: 'Доля команд требует явного состава участников и назначений ИТ-лидеров' });
  } else if (!input.assignments.length) ctx.addIssue({ code: 'custom', path: ['assignments'], message: 'Выберите ИТ-лидеров или общий результат ДИТ' });
});
