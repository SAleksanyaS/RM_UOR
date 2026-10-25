import { z } from 'zod';
export const templateFieldSchema = z.enum(['report.period', 'report.baselinePeriod', 'report.createdAt', 'report.catalogName', 'report.limitations', 'report.summary', 'row.goalTitle', 'row.leaderName', 'row.actual', 'row.target', 'row.status', 'row.dueDate', 'row.nextAction', 'row.decisionNeeded', 'row.comments', 'row.sources', 'row.delta', 'row.changes']);
export type TemplateField = z.infer<typeof templateFieldSchema>;
export const collectionSchema = z.enum(['rows', 'goals', 'leaders']);
const textBinding = z.object({ kind: z.literal('text'), slide: z.number().int().min(1).max(500), shapeId: z.string().min(1).max(100), field: templateFieldSchema, maxChars: z.number().int().min(20).max(10000).optional() }).strict();
const tableBinding = z.object({ kind: z.literal('table'), slide: z.number().int().min(1).max(500), shapeId: z.string().min(1).max(100), collection: collectionSchema, columns: z.array(templateFieldSchema).min(1).max(30), headerRows: z.number().int().min(0).max(10), rowsPerSlide: z.number().int().min(1).max(20), maxChars: z.number().int().min(20).max(10000).optional() }).strict();
export const templateProfileSchema = z.object({ name: z.string().trim().min(1).max(500), bindings: z.array(z.discriminatedUnion('kind', [textBinding, tableBinding])).max(1000), repeats: z.array(z.object({ slide: z.number().int().min(1).max(500), collection: collectionSchema }).strict()).max(500) }).strict();
export const templateSaveSchema = z.object({ id: z.string().uuid().optional(), baseRevision: z.string().uuid().nullable(), base64: z.string().max(28_000_000).optional(), profile: templateProfileSchema }).strict();
export type TemplateProfile = z.infer<typeof templateProfileSchema>;
export interface TemplateShape { id: string; name: string; kind: 'text' | 'table' | 'unsupported'; text: string; tokens: string[]; rows?: number; columns?: number; capacity: number }
export interface TemplateInspection { slides: { number: number; path: string; shapes: TemplateShape[] }[]; warnings: string[]; sha256: string; size: number }
export interface StoredReportTemplate { id: string; revision: string; classification: 'demo' | 'corporate'; createdBy: string; updatedAt: string; profile: TemplateProfile; inspection: TemplateInspection; base64: string; ownerId: string; shared?: boolean }
export type ReportTemplateMetadata = Omit<StoredReportTemplate, 'base64' | 'ownerId'>;
export const templateBundleSchema = z.object({ schemaVersion: z.literal(1), classification: z.enum(['demo','corporate']), id: z.string().uuid(), profile: templateProfileSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), base64: z.string().max(28_000_000) }).strict();
export type ReportTemplateBundle = z.infer<typeof templateBundleSchema>;
