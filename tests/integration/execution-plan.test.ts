import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync } from 'node:crypto';
import type { CatalogSnapshot, CuratorSession } from '../../src/domain/contracts';
import type { PlanInput } from '../../src/features/planning/plan-contracts';
import { saveExecutionPlan } from '../../src/features/planning/plan-service';
import { createContext, type ApplicationContext } from '../../src/server/workspace/context';
import { createApp } from '../../src/server/app';
const contexts: ApplicationContext[] = [], roots: string[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [];
const session: CuratorSession = { id: 'session', role: 'curator', curatorId: 'demo-curator', name: 'Куратор примера', createdAt: '2026-10-24T00:00:00Z' };
const empty: PlanInput = { stage: 'planned', plannedStartDate: null, targetDate: null, forecastDate: null, nextCheckDate: null, nextAction: '', blocker: '', decisionNeeded: '' };
function catalog(): CatalogSnapshot { return { schemaVersion: 1, id: 'plans', name: 'Синтетический каталог', classification: 'demo', importedAt: '2026-10-24T00:00:00Z',
  goals: ['g1', 'g2'].map(id => ({ id, dueDate: '2026-11-01', title: id, category: 'process', target: '', metric: '', summary: '', status: '', scopeType: 'team', actions: [], links: [], officialTarget: 80, internalTarget: null,
    unit: '%', direction: 'increase', baseline: 0, weight: null, priority: null, ownerId: null, curatorId: null, revision: 'goal-one' })),
  leaders: [{ id: 'l1', name: 'Лидер примера', teams: [] }], assignments: [{ id: 'a1', goalId: 'g1', leaderId: 'l1', teams: [], active: true }, { id: 'a2', goalId: 'g2', leaderId: 'l1', teams: [], active: false }], sources: [], entities: [], comments: [] }; }
async function setup() { const root = await mkdtemp(join(tmpdir(), 'uor-plan-')); roots.push(root); const context = await createContext({ projectRoot: root, initialCatalog: catalog(), startupCheck: false }); contexts.push(context); return { context, root }; }
afterEach(async () => { vi.restoreAllMocks(); for (const app of apps.splice(0)) await app.close(); for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('saves distinct global and assignment plans with server metadata, audit and durable local drafts', async () => {
  const { context, root } = await setup();
  const global = await saveExecutionPlan(context, session, { goalId: 'g1', leaderId: null, baseRevision: null, plan: { ...empty, targetDate: '2026-10-30' } });
  const personal = await saveExecutionPlan(context, session, { goalId: 'g1', leaderId: 'l1', baseRevision: null, plan: { ...empty, targetDate: '2026-10-29' } });
  expect(global.plan.updatedBy).toBe(session.name); expect(global.plan.revision).toBeTruthy(); expect(personal.assignmentId).toBe('a1');
  const view = await context.catalogs.readForSession(session);
  expect(view.goals[0]).toMatchObject({ dueDate: '2026-11-01', plan: { targetDate: '2026-10-30' } });
  expect(view.assignments[0].plan?.targetDate).toBe('2026-10-29');
  expect((await context.catalogs.read()).goals[0].plan).toBeUndefined(); expect(context.db.list('changes')).toHaveLength(2);
  context.db.close(); contexts.splice(contexts.indexOf(context), 1);
  const restored = await createContext({ projectRoot: root, initialCatalog: catalog(), startupCheck: false }); contexts.push(restored);
  expect((await restored.catalogs.readForSession(session)).goals[0].plan?.revision).toBe(global.plan.revision);
});

it('rejects stale plan revisions and catalog changes occurring inside the awaited draft save', async () => {
  const { context } = await setup();
  const first = await saveExecutionPlan(context, session, { goalId: 'g1', leaderId: null, baseRevision: null, plan: empty });
  await expect(saveExecutionPlan(context, session, { goalId: 'g1', leaderId: null, baseRevision: null, plan: { ...empty, stage: 'paused' } })).rejects.toMatchObject({ statusCode: 409 });
  const original = context.catalogs.saveDraft.bind(context.catalogs);
  vi.spyOn(context.catalogs, 'saveDraft').mockImplementation(async (actor, change, options) => {
    await Promise.resolve(); const active = context.db.get<CatalogSnapshot>('catalog', 'active')!; active.goals[1].title = 'Параллельная правка'; context.db.set('catalog', 'active', active);
    return original(actor, change, options);
  });
  await expect(saveExecutionPlan(context, session, { goalId: 'g1', leaderId: null, baseRevision: first.plan.revision, plan: { ...empty, stage: 'paused' } })).rejects.toMatchObject({ statusCode: 409 });
  expect((await context.catalogs.readForSession(session)).goals[0].plan?.revision).toBe(first.plan.revision);
  expect(context.db.list('changes')).toHaveLength(1);
});

it('never changes facts or attestations and rolls back a plan if its audit cannot be written', async () => {
  const { context } = await setup();
  context.db.set('snapshots', 'existing-facts', { id: 'existing-facts', value: 90 }); context.db.set('attestations', 'existing-ok', { id: 'existing-ok', fingerprint: 'approved', invalidatedAt: null });
  const facts = context.db.list('snapshots'), attestations = context.db.list('attestations');
  await saveExecutionPlan(context, session, { goalId: 'g1', leaderId: null, baseRevision: null, plan: { ...empty, stage: 'ready_for_review' } });
  expect(context.db.list('snapshots')).toEqual(facts); expect(context.db.list('attestations')).toEqual(attestations);
  vi.spyOn(context.catalogs, 'recordChange').mockImplementation(() => { throw new Error('Synthetic audit failure'); });
  await expect(saveExecutionPlan(context, session, { goalId: 'g2', leaderId: null, baseRevision: null, plan: empty })).rejects.toThrow('Synthetic audit failure');
  expect((await context.catalogs.readForSession(session)).goals[1].plan).toBeUndefined();
});

it('enforces curator, CSRF and active-assignment boundaries while rejecting forged client metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uor-plan-api-')); roots.push(root);
  const app = await createApp({ projectRoot: root, initialCatalog: catalog(), registry: [{ id: session.curatorId, name: session.name, salt: 'fixture', hash: scryptSync('fixture-pass', 'fixture', 64).toString('hex') }], startupCheck: false }); apps.push(app);
  const state = await app.inject('/api/state'), token = state.json().csrfToken;
  const payload = { goalId: 'g1', leaderId: null, baseRevision: null, plan: empty };
  expect((await app.inject({ method: 'POST', url: '/api/plans', headers: { 'x-uor-token': token }, payload })).statusCode).toBe(403);
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-uor-token': token }, payload: { role: 'curator', code: 'fixture-pass' } }); const cookie = login.headers['set-cookie']!.toString().split(';')[0];
  expect((await app.inject({ method: 'POST', url: '/api/plans', headers: { cookie }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/plans', headers: { cookie, 'x-uor-token': token }, payload: { ...payload, plan: { ...empty, updatedBy: 'forged' } } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/goals/g1', headers: { cookie, 'x-uor-token': token }, payload: {
    plan: { ...empty, updatedBy: 'forged', updatedAt: '2026-10-24T00:00:00Z', revision: 'crafted' },
  } })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/state', headers: { cookie } })).json().catalog.goals[0].plan).toBeUndefined();
  expect((await app.inject({ method: 'POST', url: '/api/plans', headers: { cookie, 'x-uor-token': token }, payload: { ...payload, goalId: 'g2', leaderId: 'l1' } })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/api/plans', headers: { cookie, 'x-uor-token': token }, payload })).statusCode).toBe(200);
});
