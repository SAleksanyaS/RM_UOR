import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import { createApp } from '../../src/server/app';
import type { CatalogSnapshot, Session } from '../../src/domain/contracts';
import { CatalogStore } from '../../src/features/catalog/catalog-store';
import { LocalDatabase } from '../../src/server/storage/database';

const apps: Awaited<ReturnType<typeof createApp>>[] = []; const roots: string[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function catalog(): CatalogSnapshot {
  return { schemaVersion: 1, id: 'test', name: 'Проверка', classification: 'demo', importedAt: '2026-10-24T00:00:00Z',
    goals: [{ id: 'g1', title: 'Тестовая цель', category: 'process', target: '80%', metric: '80%', status: 'active', summary: '', actions: [], scopeType: 'allSystems', links: [], ownerId: null, curatorId: null, officialTarget: 80, internalTarget: null, unit: '%', direction: 'increase', baseline: 0, weight: null, priority: null, dueDate: null, revision: 'base' }],
    leaders: [{ id: 'leader1', name: 'Лидер теста', teams: [] }], assignments: [{ id: 'a1', goalId: 'g1', leaderId: 'leader1', teams: [] }], sources: [], comments: [], entities: [] };
}
async function setup(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'uor-api-')); if (!roots.includes(root)) roots.push(root);
  const app = await createApp({ projectRoot: root, allowedRoots: [root], initialCatalog: catalog(), registry: [{ id: 'curator1', name: 'Куратор теста', salt: 'fixture-salt', hash: scryptSync('fixture-pass', 'fixture-salt', 64).toString('hex') }], startupCheck: false });
  apps.push(app); await app.ready();
  const initial = await app.inject({ method: 'GET', url: '/api/state' });
  const cookie = initial.headers['set-cookie']!.toString().split(';')[0]; const token = initial.json().csrfToken;
  return { app, cookie, token, root };
}
it('denies reader edits at service boundary, and requires local CSRF token', async () => {
  const { app, cookie, token } = await setup();
  expect((await app.inject({ method: 'POST', url: '/api/goals/g1', headers: { cookie, 'x-uor-token': token }, payload: { title: 'Wrong' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/login', headers: { cookie }, payload: { role: 'curator', code: 'fixture-pass' } })).statusCode).toBe(403);
});
it('rejects foreign origins even with a valid request token', async () => {
  const { app, cookie, token } = await setup();
  expect((await app.inject({ method: 'POST', url: '/api/login', headers: { cookie, 'x-uor-token': token, origin: 'https://other.example' }, payload: { role: 'curator', code: 'fixture-pass' } })).statusCode).toBe(403);
});
it('rejects invalid curator code, saves valid draft and keeps it after reopening', async () => {
  const { app, cookie, token, root } = await setup();
  expect((await app.inject({ method: 'POST', url: '/api/login', headers: { cookie, 'x-uor-token': token }, payload: { role: 'curator', code: 'wrong' } })).statusCode).toBe(401);
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { cookie, 'x-uor-token': token }, payload: { role: 'curator', code: 'fixture-pass' } });
  const auth = login.headers['set-cookie']!.toString().split(';')[0];
  const saved = await app.inject({ method: 'POST', url: '/api/goals/g1', headers: { cookie: auth, 'x-uor-token': token }, payload: { title: 'Изменённая цель', weight: 3, ownerId: null, baseRevision: 'base' } });
  expect(saved.statusCode).toBe(200);
  const state = (await app.inject({ method: 'GET', url: '/api/state', headers: { cookie: auth } })).json();
  expect(state.catalog.goals[0].title).toBe('Изменённая цель'); expect(state.drafts).toHaveLength(1);
  expect(JSON.stringify(state.changes)).not.toContain('fixture-pass');
  await app.close(); apps.splice(apps.indexOf(app), 1);
  const reopened = await setup(root); const reader = (await reopened.app.inject({ method: 'GET', url: '/api/state' })).json();
  expect(reader.catalog.goals[0].title).toBe('Тестовая цель');
  const relogin = await reopened.app.inject({ method: 'POST', url: '/api/login', headers: { cookie: reopened.cookie, 'x-uor-token': reopened.token }, payload: { role: 'curator', code: 'fixture-pass' } });
  const state2 = (await reopened.app.inject({ method: 'GET', url: '/api/state', headers: { cookie: relogin.headers['set-cookie']!.toString().split(';')[0] } })).json();
  expect(state2.catalog.goals[0].title).toBe('Изменённая цель');
});
it('keeps an assignment edit in the curator draft without changing the reader scope', async () => {
  const { app, cookie, token } = await setup();
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { cookie, 'x-uor-token': token }, payload: { role: 'curator', code: 'fixture-pass' } });
  const headers = { cookie: login.headers['set-cookie']!.toString().split(';')[0], 'x-uor-token': token };
  const edit = await app.inject({ method: 'POST', url: '/api/assignments/a1', headers, payload: { active: false, teams: ['Группа А'], target: 'Особый ориентир' } });
  expect(edit.statusCode).toBe(200);
  const curator = (await app.inject({ url: '/api/state', headers })).json();
  expect(curator.catalog.assignments[0]).toMatchObject({ active: false, teams: ['Группа А'], target: 'Особый ориентир' });
  expect(curator.drafts[0].change.kind).toBe('assignment');
  const reader = (await app.inject('/api/state')).json();
  expect(reader.catalog.assignments[0].active).not.toBe(false);
});
it('rotates the effective goal revision on each edit and preserves required metrics', async () => {
  const db = new LocalDatabase(':memory:');
  try {
    db.set('catalog', 'active', catalog());
    const store = new CatalogStore(db);
    const session = { role: 'curator', curatorId: 'curator1' } as Session;
    const first = await store.saveDraft(session, { kind: 'goal', id: 'g1', baseRevision: 'base', patch: { weight: 5, requiredMetricIds: ['practice-a', 'practice-b'] } });
    const firstRevision = (await store.readForSession(session)).goals[0].revision;
    expect(firstRevision).not.toBe('base');
    expect(first.change.patch.requiredMetricIds).toEqual(['practice-a', 'practice-b']);
    await store.saveDraft(session, { kind: 'goal', id: 'g1', baseRevision: firstRevision, patch: { weight: 6 } });
    expect((await store.readForSession(session)).goals[0].revision).not.toBe(firstRevision);
  } finally { db.close(); }
});
it('rejects a second HTTP edit based on the previous goal revision', async () => {
  const { app, cookie, token } = await setup();
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { cookie, 'x-uor-token': token }, payload: { role: 'curator', code: 'fixture-pass' } });
  const headers = { cookie: login.headers['set-cookie']!.toString().split(';')[0], 'x-uor-token': token };
  expect((await app.inject({ method: 'POST', url: '/api/goals/g1', headers, payload: { weight: 5, baseRevision: 'base' } })).statusCode).toBe(200);
  const stale = await app.inject({ method: 'POST', url: '/api/goals/g1', headers, payload: { weight: 6, baseRevision: 'base' } });
  expect(stale.statusCode).toBe(409);
});
it('bases the next edit on its sent release overlay while keeping an existing local draft base unchanged', async () => {
  const db = new LocalDatabase(':memory:');
  try {
    db.set('catalog', 'active', catalog());
    const store = new CatalogStore(db);
    const session = { role: 'curator', curatorId: 'curator1' } as Session;
    const sent = await store.saveDraft(session, { kind: 'goal', id: 'g1', baseRevision: 'base', patch: { weight: 5 } });
    db.set('drafts', sent.id, { ...sent, status: 'published' });
    const next = await store.saveDraft(session, { kind: 'goal', id: 'g1', baseRevision: String(sent.change.patch.revision), patch: { weight: 6 } });
    expect(next.base).toMatchObject({ weight: 5, revision: sent.change.patch.revision });
    const revised = await store.saveDraft(session, { kind: 'goal', id: 'g1', baseRevision: String(next.change.patch.revision), patch: { weight: 7 } });
    expect(revised.id).toBe(next.id);
    expect(revised.base).toEqual(next.base);
    expect((await store.readForSession(session)).goals[0].weight).toBe(7);
    expect((await store.read()).goals[0].weight).toBeNull();
  } finally { db.close(); }
});
