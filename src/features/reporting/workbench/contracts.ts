import {effectiveBasisSchema} from '../../evaluation/workbench/effective-matrix';
import { z } from 'zod';
import { globalContextSchema } from '../../../server/workbench/protocol';
import type { WorkbenchReadModels } from '../../catalog/workbench-read-models';
import * as core from '../../../domain/workbench/schemas';
import { versionRefSchema, entityRefSchema } from '../../../domain/workbench/primitives';
import { nextActionSchema } from '../../../server/workbench/protocol';
const sourceIssueSchema = z.strictObject({ code: z.string().min(1), stage: z.string().min(1), retryable: z.boolean(), message: z.string().min(1), rowKeys: z.array(z.string().min(1)), refs: z.array(entityRefSchema) });
import { metricDefinitionSchema, observedFactSchema } from '../../../domain/workbench/schemas';
import { uuidSchema } from '../../../domain/workbench/primitives';
import { maturitySnapshotSchema } from '../../maturity/workbench-contracts';
const goalRow = z.strictObject({ ref: versionRefSchema, goal: core.coreGoalDefinitionSchema, assignment: core.goalAssignmentSchema, scopeName: z.string().nullable(), leader: core.directoryEntitySchema.nullable(), basisRef: versionRefSchema.nullable(), resultRef: versionRefSchema.nullable(), numericResult: core.numericEvaluationSchema.nullable(), manualStatus: core.manualStatusEventSchema.nullable(), needs_calculation: z.boolean(), unavailableReason: z.string().nullable(), displayValue: z.string().nullable(), unit: z.string().nullable(), publication: core.publicationAnchorSchema.nullable(), warnings: z.array(z.string()), attestation: core.attestationSchema.nullable(), snapshot: core.agreedSnapshotSchema.nullable(), nextActions: z.array(nextActionSchema) });
const captureItem = z.strictObject({ ref: versionRefSchema, capture: core.captureSchema, obtainedVia: z.enum(['local-cache', 'git']), issues: z.array(sourceIssueSchema), latestAttemptIncomplete: z.boolean() });
const executionItem = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('work'), ref: entityRefSchema, title: z.string(), value: core.workSchema }), z.strictObject({ kind: z.literal('decision'), ref: entityRefSchema, title: z.string(), value: core.decisionSchema })]);
export const reportGoalDataSchema: z.ZodType<WorkbenchReadModels['goals.detail']> = z.strictObject({ goal: core.coreGoalDefinitionSchema, rows: z.array(goalRow), tabs: z.strictObject({ state: z.array(goalRow), work: z.array(executionItem), method: z.array(core.methodVersionSchema), calculation: z.array(core.evaluationBasisSchema), enriched: z.array(captureItem), raw: z.array(captureItem), history: z.array(core.agreedSnapshotSchema) }) });
export const sectionKindSchema = z.enum(['summary', 'matrix', 'comparison', 'quality']);
export const reportDefinitionSchema = z.strictObject({ template: z.enum(['maturity-management-v1', 'goal-management-v1']), context: globalContextSchema.nullable().default(null), title: z.string().trim().min(1).max(160), comment: z.string().max(4000), period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), teamIds: z.array(uuidSchema).max(1000), sections: z.array(z.strictObject({ kind: sectionKindSchema, title: z.string().trim().min(1).max(120), comment: z.string().max(2000) })).min(1).max(4) }).superRefine((v, c) => { if (new Set(v.sections.map(s => s.kind)).size !== v.sections.length)
    c.addIssue({ code: 'custom', message: 'Duplicate section' }); if (new Set(v.teamIds).size !== v.teamIds.length)
    c.addIssue({ code: 'custom', message: 'Duplicate team' }); });
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export const sectionNames = { summary: 'Итоги', matrix: 'Матрица команд и метрик', comparison: 'Заявления источника по периодам', quality: 'Качество и происхождение' };
export function defaultReportDefinition(period: string): ReportDefinition { return { template: 'maturity-management-v1', context: null, title: 'Модель зрелости ДИТ', comment: '', period, teamIds: [], sections: (Object.keys(sectionNames) as Array<keyof typeof sectionNames>).map(kind => ({ kind, title: sectionNames[kind], comment: '' })) }; }
export const goalSectionNames = { summary: 'Итоги цели', matrix: 'Показатели и принятые значения', comparison: 'Согласованные срезы', quality: 'Качество и происхождение' };
export const reportSnapshotSchema = z.strictObject({ schemaVersion: z.literal(1), id: uuidSchema, revision: z.number().int().positive(), createdAt: z.string(), ownerPersonId: uuidSchema, installationId: uuidSchema, definition: reportDefinitionSchema, maturity: maturitySnapshotSchema.nullable(), goalData: reportGoalDataSchema.nullable(), metrics: z.array(metricDefinitionSchema), facts: z.array(observedFactSchema), effectiveBases: z.array(effectiveBasisSchema).optional(), template: z.strictObject({ id: z.enum(['maturity-management-v1', 'goal-management-v1']), version: z.literal(1), bytesBase64: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), profile: z.strictObject({ kind: z.literal('dit-maturity-2026-10-v1'), name: z.string(), rowsPerSlide: z.number().int(), sourceLayout: z.literal('overview-leaders-eight-details') }).nullable() }), digest: z.string().regex(/^[a-f0-9]{64}$/) });
export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>;
export const reportSaveInputSchema = z.strictObject({ id: uuidSchema.nullable(), definition: reportDefinitionSchema });
export const reportSaveResultSchema = z.strictObject({ id: uuidSchema, revision: z.number().int().positive(), digest: z.string() });
export const exportFormatSchema = z.enum(['xlsx', 'pptx', 'pdf', 'native-pptx']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;
