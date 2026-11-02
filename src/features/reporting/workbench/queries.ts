import { z } from 'zod';
import { uuidSchema } from '../../../domain/workbench/primitives';
import { ownQueryRequestSchema } from '../../../server/workbench/protocol';
import type { QueryRegistry } from '../../../server/workbench/query-registry';
import { reportDefinitionSchema, reportSnapshotSchema, exportFormatSchema } from './contracts';
import type { ReportService } from './service';
export function registerReportQueries(registry: QueryRegistry, service: ReportService) {
    const query = <S extends z.ZodType>(filter: S) => ownQueryRequestSchema.extend({ filter, sort: z.array(z.never()).max(0) });
    registry.register({ name: 'reports.recipes', inputSchema: query(z.strictObject({})), outputSchema: z.array(reportDefinitionSchema).max(200), async handler(c) { return service.recipes(c); } });
    registry.register({ name: 'reports.list', inputSchema: query(z.strictObject({})), outputSchema: z.array(z.strictObject({ id: uuidSchema, revision: z.number(), title: z.string(), period: z.string(), createdAt: z.string(), editToken: z.string() })), async handler(c) { return service.list(c); } });
    registry.register({ name: 'reports.prepare', inputSchema: query(z.strictObject({ definition: reportDefinitionSchema })), outputSchema: reportSnapshotSchema, async handler(c, i) { return service.prepare(c, i.filter.definition); } });
    registry.register({ name: 'reports.detail', inputSchema: query(z.strictObject({ id: uuidSchema, revision: z.number().int().positive().optional() })), outputSchema: reportSnapshotSchema, async handler(c, i) { return service.detail(c, i.filter.id, i.filter.revision); } });
    registry.register({ name: 'reports.export', inputSchema: query(z.strictObject({ id: uuidSchema, revision: z.number().int().positive(), format: exportFormatSchema })), outputSchema: z.strictObject({ filename: z.string(), mimeType: z.string(), base64: z.string() }), async handler(c, i) { const result = await service.readExport(c, i.filter.id, i.filter.revision, i.filter.format); return { filename: result.filename, mimeType: result.mimeType, base64: result.bytes.toString('base64') }; } });
}
