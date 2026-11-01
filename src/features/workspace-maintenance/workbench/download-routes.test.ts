import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { registerBackupDownloadRoutes } from './download-routes';
import { createWorkspaceArchive } from './workspace-archive';
import { fixture, digest } from './test-fixture';
it('downloads verified own binary bytes with exact metadata and denies foreign/repo/unknown IDs', async () => {
  const f = await fixture('retained'); const app = Fastify(); try {
    const b = await createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps);
    app.setErrorHandler((error, _r, reply) => reply.code(error instanceof WorkbenchHttpError ? error.statusCode : 500).send({ code: error instanceof WorkbenchHttpError ? error.code : 'INTERNAL_ERROR' }));
    registerBackupDownloadRoutes(app, { async backupFile(id) { return f.service.getBackupFile(f.context, id); } }, async () => ({ requestId: randomUUID(), sessionId: randomUUID() }));
    const response = await app.inject({ url: '/api/v1/backups/' + b.backupId + '/file' }); expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toBe('application/zip'); expect(response.headers['content-length']).toBe(String(b.bytes)); expect(response.headers['x-archive-sha256']).toBe(b.archiveSha256); expect(response.headers['content-disposition']).toContain('attachment;'); expect(digest(response.rawPayload)).toBe(b.archiveSha256);
    await expect(f.service.getBackupFile({ ...f.context, installationId: randomUUID() }, b.backupId)).rejects.toMatchObject({ statusCode: 404 });
    expect((await app.inject({ url: '/api/v1/backups/' + randomUUID() + '/file' })).statusCode).toBe(404);
    f.setRepo(); await expect(f.service.getBackupFile(f.context, b.backupId)).rejects.toMatchObject({ statusCode: 404 });
  } finally { await app.close(); await f.dispose(); }
});
it('tampered backup fails integrity verification before binary headers', async () => {
  const f = await fixture('retained'); const app = Fastify(); try {
    const b = await createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps); await writeFile(path.join(f.deps.artifactRoot, 'backups', b.backupId, 'archive.zip'), 'tampered');
    app.setErrorHandler((error, _r, reply) => reply.code(error instanceof WorkbenchHttpError ? error.statusCode : 500).send({ code: error instanceof WorkbenchHttpError ? error.code : 'INTERNAL_ERROR' }));
    registerBackupDownloadRoutes(app, { async backupFile(id) { return f.service.getBackupFile(f.context, id); } }, async () => ({ requestId: randomUUID(), sessionId: randomUUID() }));
    const response = await app.inject({ url: '/api/v1/backups/' + b.backupId + '/file' }); expect(response.statusCode).toBe(422); expect(response.json()).toMatchObject({ code: 'INTEGRITY_MISMATCH' }); expect(response.headers['x-archive-sha256']).toBeUndefined();
  } finally { await app.close(); await f.dispose(); }
});
it('mounts inside the existing /api/v1 guard scope without duplicating its prefix', async () => {
  const f = await fixture('retained'); const app = Fastify(); try {
    const b = await createWorkspaceArchive(f.context, { label: null, includeOriginals: true }, f.deps); let guarded = false;
    await app.register(async api => { api.addHook('onRequest', async () => { guarded = true; }); registerBackupDownloadRoutes(api, { async backupFile(id) { return f.service.getBackupFile(f.context, id); } }, async () => ({ requestId: randomUUID(), sessionId: randomUUID() })); }, { prefix: '/api/v1' });
    const response = await app.inject({ url: '/api/v1/backups/' + b.backupId + '/file' }); expect(response.statusCode).toBe(200); expect(guarded).toBe(true); expect(digest(response.rawPayload)).toBe(b.archiveSha256); expect((await app.inject({ url: '/api/v1/api/v1/backups/' + b.backupId + '/file' })).statusCode).toBe(404);
  } finally { await app.close(); await f.dispose(); }
});
