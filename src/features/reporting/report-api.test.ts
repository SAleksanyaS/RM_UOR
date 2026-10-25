import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync } from 'node:crypto';
import type { CatalogSnapshot } from '../../domain/contracts';
import { createApp } from '../../server/app';
const roots: string[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [];
function catalog(): CatalogSnapshot { return { schemaVersion: 1, id: 'api-demo', name: 'Синтетический каталог', classification: 'demo', importedAt: '2026-10-25T00:00:00Z', goals: [{ id: 'g', title: 'Цель примера', category: 'process', target: '', metric: '', summary: '', status: '', scopeType: '', actions: [], links: [], officialTarget: 80, internalTarget: null, unit: '%', direction: 'increase', baseline: null, weight: null, priority: null, ownerId: null, curatorId: null, dueDate: null, revision: 'r' }], leaders: [], assignments: [], sources: [], entities: [], comments: [] }; }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'uor-report-api-')); roots.push(root);
  const app = await createApp({ projectRoot: root, initialCatalog: catalog(), registry: [{ id: 'demo-curator', name: 'Куратор примера', salt: 'fixture', hash: scryptSync('fixture-pass', 'fixture', 64).toString('hex') }], startupCheck: false }); apps.push(app);
  const state = await app.inject('/api/state'), token = state.json().csrfToken as string, readerCookie = state.headers['set-cookie']!.toString().split(';')[0];
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-uor-token': token }, payload: { role: 'curator', code: 'fixture-pass' } });
  const curatorCookie = login.headers['set-cookie']!.toString().split(';')[0];
  return { app, token, readerCookie, curatorCookie };
}
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
it('exports a frozen reader report with correct formats, CSRF checks and session boundaries', async () => {
  const { app, token, readerCookie, curatorCookie } = await setup(), selection = { goalIds: ['g'], leaderIds: [], period: '2026-10-01' };
  expect((await app.inject({ method: 'POST', url: '/api/reports', headers: { cookie: readerCookie }, payload: selection })).statusCode).toBe(403);
  const generated = await app.inject({ method: 'POST', url: '/api/reports', headers: { cookie: readerCookie, 'x-uor-token': token }, payload: selection });
  expect(generated.statusCode).toBe(200); expect(generated.json().summary.unknown).toBe(1);
  const id = generated.json().id as string;
  const html = await app.inject({ url: `/api/reports/${id}/html`, headers: { cookie: readerCookie } });
  expect(html.statusCode).toBe(200); expect(html.headers['content-type']).toContain('text/html'); expect(html.body).toContain('Цель примера'); expect(html.body).toContain('2026-10-01');
  const pptx = await app.inject({ url: `/api/reports/${id}/pptx`, headers: { cookie: readerCookie } });
  expect(pptx.statusCode).toBe(200); expect(pptx.headers['content-type']).toContain('presentationml.presentation'); expect(pptx.headers['content-disposition']).toContain('uor-report-2026-10-01.pptx'); expect(pptx.rawPayload.subarray(0, 2).toString()).toBe('PK');
  expect((await app.inject({ url: `/api/reports/${id}/html`, headers: { cookie: curatorCookie } })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/api/reports', headers: { cookie: readerCookie, 'x-uor-token': token }, payload: { ...selection, evaluations: [{ official: 'met' }] } })).statusCode).toBe(400);
});
it('enforces decision roles, CSRF, revision and closure validation and blocks generic entity bypasses', async () => {
  const { app, token, readerCookie, curatorCookie } = await setup(), decision = { name: 'Решение примера', owner: 'Ответственный примера', goalId: 'g', dueDate: '2026-11-01', state: 'open', closureComment: '' }, payload = { baseRevision: null, decision }, headers = { cookie: curatorCookie, 'x-uor-token': token };
  expect((await app.inject({ method: 'POST', url: '/api/director/decisions', headers: { cookie: readerCookie, 'x-uor-token': token }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/director/decisions', headers: { cookie: curatorCookie }, payload })).statusCode).toBe(403);
  const created = await app.inject({ method: 'POST', url: '/api/director/decisions', headers, payload }); expect(created.statusCode).toBe(200); const saved = created.json().decision;
  expect((await app.inject({ method: 'POST', url: '/api/director/decisions', headers, payload: { ...payload, id: saved.id } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: '/api/director/decisions', headers, payload: { id: saved.id, baseRevision: saved.revision, decision: { ...decision, state: 'closed' } } })).statusCode).toBe(400);
  const closed = await app.inject({ method: 'POST', url: '/api/director/decisions', headers, payload: { id: saved.id, baseRevision: saved.revision, decision: { ...decision, state: 'closed', closureComment: 'Решение исполнено и проверено' } } }); expect(closed.statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: '/api/entities', headers, payload: { type: 'decision', name: 'Обход' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: `/api/entities/${saved.id}`, headers, payload: { type: 'team', name: 'Обход существующего решения' } })).statusCode).toBe(400);
  const agenda = await app.inject({ url: '/api/director', headers: { cookie: curatorCookie } }); expect(agenda.statusCode).toBe(200); expect(agenda.json().decisions[0].closureComment).toBe('Решение исполнено и проверено');
});
it('allows only curator profile saves and protects saved profiles from generic writes', async () => {
  const { app, token, readerCookie, curatorCookie } = await setup(), payload = { baseRevision: null, profile: { name: 'Состав примера', goalIds: ['g'], leaderIds: [], period: '2026-10-25' } }, headers = { cookie: curatorCookie, 'x-uor-token': token };
  expect((await app.inject({ method: 'POST', url: '/api/reports/profiles', headers: { cookie: readerCookie, 'x-uor-token': token }, payload })).statusCode).toBe(403);
  const result = await app.inject({ method: 'POST', url: '/api/reports/profiles', headers, payload }); expect(result.statusCode).toBe(200);
  expect((await app.inject({ method: 'POST', url: `/api/entities/${result.json().profile.id}`, headers, payload: { type: 'product', name: 'Обход профиля' } })).statusCode).toBe(400);
});
