import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { QueryRegistry } from '../../../server/workbench/query-registry';
import type { OwnQueryRequest } from '../../../server/workbench/protocol';
import { createJobStore } from '../../../server/workbench/jobs';
import { createWorkbenchReadIndex } from '../../catalog/workbench-read-index';
import { MaintenanceService } from './maintenance-service';
import { registerMaintenanceQueries } from './maintenance-query';
import { fixture } from './test-fixture';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function setup() {
  const f = await fixture('retained own subject'); closes.push(f.dispose);
  const jobs = createJobStore({ repository: f.deps.repository, clock: f.deps.clock });
  const service = new MaintenanceService({ archive: f.deps, jobs, jobSink: jobs });
  const registry = new QueryRegistry();
  registerMaintenanceQueries(registry, service, createWorkbenchReadIndex(f.deps.repository));
  const request: OwnQueryRequest = { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } };
  return { ...f, service, request, read: (input = request, context = f.context) => registry.execute('backups.list', input, context) as Promise<{ items: Array<Record<string, unknown>>; page: { nextCursor: string | null; hasMore: boolean } }> };
}
it('lists actual own backups through safe metadata without private storage or owner coordinates', async () => {
  const f = await setup();
  const backup = await f.service.createBackup(f.context, { label: 'Copy', includeOriginals: true });
  const before = f.deps.repository.getStateRevision();
  const result = await f.read();
  expect(result.items).toEqual([{ ...backup, rescue: false }]);
  expect(result.page).toEqual({ nextCursor: null, hasMore: false });
  expect(JSON.stringify(result)).not.toContain(f.root);
  expect(JSON.stringify(result)).not.toContain(f.context.installationId);
  expect(JSON.stringify(result)).not.toContain('repo-one');
  expect(f.deps.repository.getStateRevision()).toBe(before);
});
it('keeps backup discovery scoped to the actual installation and current person', async () => {
  const f = await setup();
  await f.service.createBackup(f.context, { label: null, includeOriginals: true });
  expect((await f.read(f.request, { ...f.context, installationId: randomUUID() })).items).toEqual([]);
  const personId = randomUUID();
  expect((await f.read(f.request, { ...f.context, ownAccess: { ...f.context.ownAccess, personId } })).items).toEqual([]);
  await expect(f.read({ ...f.request, filter: { installationId: f.context.installationId } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(f.read({ ...f.request, sort: [{ field: 'path', direction: 'asc' }] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
});
it('pages equal-time backups once and rejects a stale or another-owner cursor', async () => {
  const f = await setup();
  for (let i = 0; i < 3; i++) await f.service.createBackup(f.context, { label: null, includeOriginals: true });
  const first = await f.read({ ...f.request, page: { limit: 2, cursor: null } });
  expect(first.items).toHaveLength(2); expect(first.page.hasMore).toBe(true);
  const nextRequest = { ...f.request, page: { limit: 2, cursor: first.page.nextCursor } };
  const second = await f.read(nextRequest); expect(second.items).toHaveLength(1);
  expect(new Set([...first.items, ...second.items].map(item => item.backupId)).size).toBe(3);
  await expect(f.read(nextRequest, { ...f.context, installationId: randomUUID() })).rejects.toMatchObject({ code: 'CURSOR_STALE' });
  await f.service.createBackup(f.context, { label: null, includeOriginals: true });
  await expect(f.read(nextRequest)).rejects.toMatchObject({ code: 'CURSOR_STALE' });
});
