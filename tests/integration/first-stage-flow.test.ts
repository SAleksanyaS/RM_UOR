import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import { createApp } from '../../src/server/app';
import type { CatalogSnapshot, WorkspaceState } from '../../src/domain/contracts';

const roots: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'uor-flow-')); roots.push(root);
  const catalog: CatalogSnapshot = {
    schemaVersion: 1, id: 'flow', name: 'Synthetic flow', classification: 'demo', importedAt: new Date().toISOString(),
    goals: [{ id: 'g1', title: 'Synthetic goal', category: 'process', target: '80%', metric: '80%', status: 'active', summary: '', actions: [], scopeType: 'all', links: [], ownerId: null, curatorId: null, officialTarget: 80, internalTarget: 95, unit: '%', direction: 'increase', baseline: 0, weight: null, priority: null, dueDate: null, revision: 'base' }],
    leaders: ['l1', 'l2'].map(id => ({ id, name: id, teams: [] })),
    assignments: ['l1', 'l2'].map(id => ({ id, goalId: 'g1', leaderId: id, teams: [] })), sources: [], entities: [], comments: []
  };
  const app = await createApp({ projectRoot: root, initialCatalog: catalog, startupCheck: false, registry: [{ id: 'tester', name: 'Synthetic curator', salt: 'salt', hash: scryptSync('flow-pass', 'salt', 64).toString('hex') }] });
  apps.push(app);
  const state = (await app.inject('/api/state')).json<WorkspaceState>();
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-uor-token': state.csrfToken }, payload: { role: 'curator', code: 'flow-pass' } });
  const headers = { 'x-uor-token': state.csrfToken, cookie: login.headers['set-cookie']!.toString().split(';')[0] };
  const read = async () => (await app.inject({ url: '/api/state', headers })).json<WorkspaceState>();
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
  const fact = (leaderId: string, value: number, period = new Date().toISOString().slice(0, 10)) => post('/api/manual', { goalId: 'g1', leaderId, value, period });
  return { app, headers, read, post, fact };
}
it('preserves facts for other leaders and requires a new confirmation after regression', async () => {
  const { read, post, fact } = await setup();
  expect((await fact('l1', 90)).statusCode).toBe(200);
  expect((await fact('l2', 70)).statusCode).toBe(200);
  const evaluation = async (leaderId: string) => (await read()).evaluations.find(e => e.goalId === 'g1' && e.leaderId === leaderId)!;
  expect(await evaluation('l1')).toMatchObject({ actual: 90, official: 'met', internal: 'not_met', validation: 'pending' });
  expect(await evaluation('l2')).toMatchObject({ actual: 70, official: 'not_met' });
  expect((await post('/api/confirm', { goalId: 'g1', leaderId: 'l1', comment: '  ' })).statusCode).toBe(400);
  expect((await post('/api/confirm', { goalId: 'g1', leaderId: 'l1', baseFingerprint: 'outdated', comment: 'Проверено по исходной выгрузке' })).statusCode).toBe(409);
  expect((await post('/api/evidence', { name: 'empty.txt', base64: '' })).statusCode).toBe(400);
  expect((await post('/api/confirm', { goalId: 'g1', leaderId: 'l1', comment: 'Проверен исходный расчёт и состав участников' })).statusCode).toBe(200);
  expect((await evaluation('l1')).validation).toBe('confirmed');
  await fact('l1', 90);
  expect((await evaluation('l1')).validation).toBe('confirmed');
  await fact('l1', 70);
  expect(await evaluation('l1')).toMatchObject({ official: 'not_met', validation: 'not_required' });
  expect((await read()).attestations[0].invalidatedAt).toBeTruthy();
  await fact('l1', 90);
  expect((await evaluation('l1')).validation).toBe('pending');
  const evidence = await post('/api/evidence', { name: 'synthetic-proof.txt', base64: Buffer.from('Synthetic proof').toString('base64') });
  expect(evidence.statusCode).toBe(200);
  expect((await post('/api/confirm', { goalId: 'g1', leaderId: 'l1', evidenceIds: [evidence.json().evidence.id] })).statusCode).toBe(200);
  expect((await evaluation('l1')).validation).toBe('confirmed');
});
it('rejects unknown leader and prevents confirming an old period as current', async () => {
  const { fact, post, read } = await setup();
  expect((await fact('unknown', 100)).statusCode).toBe(400);
  expect((await fact('l1', 100, '2001-01-01')).statusCode).toBe(200);
  expect((await read()).evaluations.find(e => e.leaderId === 'l1')!.qualityFlags).toContain('stale');
  expect((await post('/api/confirm', { goalId: 'g1', leaderId: 'l1', comment: 'Проверено по старому файлу' })).statusCode).toBe(409);
});
it('keeps product links intact on a rejected legacy edit and archives through the versioned knowledge route', async () => {
  const { app, headers, post, read } = await setup();
  const product = await post('/api/entities', { name: 'Synthetic product', type: 'product', leaderId: 'l1' });
  expect(product.statusCode).toBe(200);
  const productId = product.json().draft.change.id;
  const leader = await post('/api/entities', { name: 'Synthetic product owner', type: 'product_leader', productId, leaderId: 'l1' });
  expect(leader.statusCode).toBe(200); const id = leader.json().draft.change.id;
  expect((await read()).catalog.entities.find(e => e.id === id)).toMatchObject({ type: 'product_leader', productId, leaderId: 'l1' });
  // Rich knowledge updates now require its CAS-aware route, including legacy records.
  expect((await post(`/api/entities/${id}`, { name: 'Synthetic product owner', type: 'product_leader', productId: null, leaderId: null })).statusCode).toBe(400);
  expect((await read()).catalog.entities.find(e => e.id === id)).toMatchObject({ productId, leaderId: 'l1' });
  const record = (await app.inject({ url: '/api/knowledge', headers })).json().records.find((item: { id: string }) => item.id === id);
  expect((await post(`/api/knowledge/${id}/archive`, { baseRevision: record.revision, archived: true })).statusCode).toBe(200);
  expect((await read()).catalog.entities.find(e => e.id === id)).toMatchObject({ productId, leaderId: 'l1', archivedAt: expect.any(String) });
});
