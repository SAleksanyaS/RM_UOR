import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync } from 'node:crypto';
import type { CatalogSnapshot } from '../../domain/contracts';
import { createApp } from '../../server/app';
it('protects execution routes with curator, CSRF and strict proof metadata and filters reader drafts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uor-execution-api-'));
  const catalog = JSON.parse(await readFile(join(process.cwd(), 'catalog/demo.json'), 'utf8')) as CatalogSnapshot;
  const app = await createApp({ projectRoot: root, initialCatalog: catalog, startupCheck: false, registry: [{ id: 'c', name: 'Анна', salt: 'test', hash: scryptSync('synthetic-test-code', 'test', 64).toString('hex') }] });
  try {
    const reader = await app.inject('/api/execution'); expect(reader.statusCode).toBe(200); expect(reader.json().inbox.some((i: { category: string }) => i.category === 'draft')).toBe(false);
    const token = (await app.inject('/api/state')).json().csrfToken;
    const input = { goalId: catalog.goals[0].id, leaderId: null, baseRevision: null, title: 'Веха API', owner: 'Анна', dueDate: '2026-11-01', weight: 1, effortHours: null, dependencies: [] };
    expect((await app.inject({ method: 'POST', url: '/api/execution/packages', headers: { 'x-uor-token': token }, payload: input })).statusCode).toBe(403);
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-uor-token': token }, payload: { role: 'curator', code: 'synthetic-test-code' } });
    const cookie = login.headers['set-cookie']!.toString().split(';')[0], headers = { cookie, 'x-uor-token': token };
    expect((await app.inject({ method: 'POST', url: '/api/execution/packages', headers: { cookie }, payload: input })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/execution/packages', headers, payload: { ...input, baseline: { at: '2020-01-01T00:00:00Z' } } })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/api/execution/packages', headers, payload: input }); expect(created.statusCode).toBe(200);
    const p = created.json().record, baselinePath = `/api/execution/packages/${p.id}/baseline`;
    expect((await app.inject({ method: 'POST', url: baselinePath, headers, payload: { baseRevision: p.revision, at: '2020-01-01T00:00:00Z' } })).statusCode).toBe(400);
    const based = await app.inject({ method: 'POST', url: baselinePath, headers, payload: { baseRevision: p.revision } }); expect(based.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/execution/packages/${p.id}/completion`, headers, payload: { baseRevision: based.json().record.revision, completed: true, comment: '', evidence: '' } })).statusCode).toBe(400);
    const done = await app.inject({ method: 'POST', url: `/api/execution/packages/${p.id}/completion`, headers, payload: { baseRevision: based.json().record.revision, completed: true, comment: 'Работа проверена', evidence: '' } }); expect(done.statusCode).toBe(200);
    expect(done.json().record.events[0].actor).toBe('Анна');
    expect((await app.inject({ method: 'POST', url: baselinePath, headers, payload: { baseRevision: p.revision } })).statusCode).toBe(409);
    expect((await app.inject('/api/execution')).json().packages).toHaveLength(0);
    expect((await app.inject({ url: '/api/execution', headers: { cookie } })).json().packages.some((item: { id: string }) => item.id === p.id)).toBe(true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
