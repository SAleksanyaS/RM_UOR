import type { FastifyInstance, FastifyRequest } from 'fastify';
import { uuidSchema, type UUIDv4 } from '../../../domain/workbench/primitives';
import type { LocalRequest } from '../../../server/workbench/routes';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { rawSha256Schema, type BackupFile } from './contracts';

export type BackupDownloadPort = { backupFile(backupId: UUIDv4, request: LocalRequest): Promise<BackupFile> };
export function registerBackupDownloadRoutes(app: FastifyInstance, application: BackupDownloadPort, readRequest: (request: FastifyRequest) => Promise<LocalRequest>): void {
  const route = app.prefix.endsWith('/api/v1') ? '/backups/:backupId/file' : '/api/v1/backups/:backupId/file';
  app.get(route, async (request, reply) => {
    const local = await readRequest(request); const parsed = uuidSchema.safeParse((request.params as { backupId: string }).backupId);
    if (!parsed.success) throw new WorkbenchHttpError(404, 'BACKUP_NOT_FOUND', 'Backup not found');
    const file = await application.backupFile(parsed.data, local);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !rawSha256Schema.safeParse(file.sha256).success || !/^uor-workspace-[a-f0-9-]{36}\.zip$/.test(file.name)) { file.stream.destroy(); throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Backup download metadata is invalid'); }
    return reply.type('application/zip').header('Content-Disposition', `attachment; filename="${file.name}"`).header('Content-Length', String(file.bytes)).header('X-Archive-Sha256', file.sha256).header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').send(file.stream);
  });
}
