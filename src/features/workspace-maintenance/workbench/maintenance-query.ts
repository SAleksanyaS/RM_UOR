import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { QueryRegistry } from '../../../server/workbench/query-registry';
import { ownQueryRequestSchema, pageResultSchema, WorkbenchHttpError } from '../../../server/workbench/protocol';
import type { WorkbenchReadIndex } from '../../catalog/workbench-read-index';
import { backupCreateResultSchema } from './contracts';
import type { MaintenanceService } from './maintenance-service';

export const backupListItemSchema = backupCreateResultSchema.extend({ rescue: z.boolean() });
export const backupsReadSchema = z.strictObject({ items: z.array(backupListItemSchema), page: pageResultSchema });
export type BackupsRead = z.infer<typeof backupsReadSchema>;
/** Personal archive discovery; paths and installation/person/repository coordinates stay server-owned. */
export function registerMaintenanceQueries(registry: QueryRegistry, service: Pick<MaintenanceService, 'listOwnBackups'>, cursors: Pick<WorkbenchReadIndex, 'sealCursor' | 'openCursor'>): void {
  registry.register({
    name: 'backups.list',
    inputSchema: ownQueryRequestSchema.extend({ filter: z.strictObject({}), sort: z.array(z.never()).max(0) }),
    outputSchema: backupsReadSchema,
    async handler(context, request) {
      const own = await service.listOwnBackups(context);
      const items = own.map(value => backupListItemSchema.parse({
        backupId: value.backupId, archiveSha256: value.archiveSha256, bytes: value.bytes,
        createdAt: value.createdAt, sourceStateRevision: value.sourceStateRevision,
        empty: value.empty, omissions: value.omissions, rescue: value.rescue,
      })).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.backupId.localeCompare(b.backupId));
      // The catalog is outside SQLite: include its exact contents in the normal signed cursor binding.
      const binding = { query: 'backups.list', digest: createHash('sha256').update(JSON.stringify(items)).digest('hex'), limit: request.page.limit };
      const offset = request.page.cursor ? cursors.openCursor(request.page.cursor, binding, context) : 0;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw new WorkbenchHttpError(409, 'CURSOR_STALE', 'Обновите список копий: данные изменились');
      const selected = items.slice(offset, offset + request.page.limit), hasMore = offset + selected.length < items.length;
      return { items: selected, page: { hasMore, nextCursor: hasMore ? cursors.sealCursor(offset + selected.length, binding, context) : null } };
    },
  });
}
