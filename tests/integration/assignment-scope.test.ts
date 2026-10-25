import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync } from 'node:crypto';
import type { Attestation, CatalogSnapshot, CuratorSession, Draft } from '../../src/domain/contracts';
import type { AssignmentScopeInput } from '../../src/features/catalog/scope-contracts';
import { createContext, type ApplicationContext } from '../../src/server/workspace/context';
import { createApp } from '../../src/server/app';
import { saveAssignmentScope } from '../../src/features/catalog/assignment-scope';

const contexts: ApplicationContext[] = [], roots: string[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [];
const session: CuratorSession = { id: 'session', role: 'curator', curatorId: 'curator', name: 'Куратор примера', createdAt: new Date().toISOString() };
afterEach(async () => { vi.restoreAllMocks(); for (const app of apps.splice(0)) await app.close(); for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function catalog(): CatalogSnapshot {
  return { schemaVersion: 1, id: 'scope-demo', name: 'Вымышленный каталог', classification: 'demo', importedAt: '2026-10-01T00:00:00Z',
    goals: [{ id: 'g', title: 'Инженерные практики', category: 'process', target: '', metric: '', status: 'active', summary: '', actions: [], scopeType: 'teams', links: [], ownerId: null, curatorId: null, officialTarget: 80, internalTarget: null, unit: '%', direction: 'increase', baseline: 0, weight: null, priority: null, dueDate: null, revision: 'v1', requiredMetricIds: ['m'] }],
    leaders: [{ id: 'l', name: 'Тестовый лидер', teams: [] }, { id: 'other', name: 'Другой лидер', teams: [] }],
    assignments: [{ id: 'a', goalId: 'g', leaderId: 'l', teams: ['Группа из карты'], participantIds: ['t1', 't2'] }],
    entities: [{ id: 't1', type: 'team', name: 'Команда А', leaderId: 'l' }, { id: 't2', type: 'team', name: 'Команда Б', leaderId: 'l' }, { id: 'foreign', type: 'team', name: 'Чужая команда', leaderId: 'other' }], sources: [], comments: [] };
}
const input = (base = catalog().assignments[0]): AssignmentScopeInput => ({ baseAssignment: base, active: true, teams: ['Группа из карты'], participantIds: ['t1'], target: '80%', summary: '' });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'uor-scope-')); roots.push(root);
  const context = await createContext({ projectRoot: root, initialCatalog: catalog(), startupCheck: false }); contexts.push(context); return { context, root };
}
it('saves checked teams and new knowledge records together and restores curator drafts on restart', async () => {
  const { context, root } = await setup();
  const result = await saveAssignmentScope(context, session, 'a', { ...input(), newEntities: [
    { clientId: 'new-team', type: 'team', name: 'Новая команда', selected: true },
    { clientId: 'new-product', type: 'product', name: 'Новый продукт', selected: true },
    { clientId: 'later', type: 'it_service', name: 'Резервная услуга', selected: false }] });
  expect(result.createdEntities).toHaveLength(3);
  const team = result.createdEntities.find(item => item.clientId === 'new-team')!.entity;
  expect(result.assignment.participantIds).toEqual(['t1', team.id]);
  expect(result.assignment.teams).toEqual(['Группа из карты', 'Новый продукт']);
  expect((await context.catalogs.readForSession(session)).entities).toHaveLength(6);
  expect((await context.catalogs.readForSession(await context.roles.enterReader())).entities).toHaveLength(3);
  context.db.close(); contexts.splice(contexts.indexOf(context), 1);
  const reopened = await createContext({ projectRoot: root, initialCatalog: catalog(), startupCheck: false }); contexts.push(reopened);
  expect((await reopened.catalogs.readForSession(session)).assignments[0]).toEqual(result.assignment);
  expect((await reopened.catalogs.listDrafts(session)).filter(draft => draft.change.kind === 'entity')).toHaveLength(3);
});
it('reuses an existing named entity and does not create duplicates on a subsequent save', async () => {
  const { context } = await setup();
  const result = await saveAssignmentScope(context, session, 'a', { ...input(), newEntities: [{ clientId: 'same', type: 'team', name: '  Команда   А ', selected: true }] });
  expect(result.createdEntities[0].entity.id).toBe('t1');
  expect((await context.catalogs.readForSession(session)).entities).toHaveLength(3);
  const next = await saveAssignmentScope(context, session, 'a', { ...input(result.assignment), participantIds: [] });
  expect(next.assignment.participantIds).toEqual([]);
  expect((await context.catalogs.readForSession(session)).entities).toHaveLength(3);
});
it('preserves undefined cohort until explicit selection and does not infer it from legacy labels', async () => {
  const { context } = await setup(); const active = catalog(); delete active.assignments[0].participantIds; context.db.set('catalog', 'active', active);
  const request = input(active.assignments[0]); delete request.participantIds;
  const result = await saveAssignmentScope(context, session, 'a', request);
  expect(result.assignment.participantIds).toBeUndefined();
  expect(result.assignment.teams).toEqual(['Группа из карты']);
});
it('rejects stale forms and invalid team ownership without partially adding knowledge', async () => {
  const { context } = await setup(); const before = context.db.list<Draft>('drafts');
  await expect(saveAssignmentScope(context, session, 'a', { ...input(), participantIds: ['foreign'], newEntities: [{ clientId: 'new', type: 'team', name: 'Не должна сохраниться', selected: true }] })).rejects.toMatchObject({ statusCode: 400 });
  expect(context.db.list('drafts')).toEqual(before);
  const first = await saveAssignmentScope(context, session, 'a', input());
  await expect(saveAssignmentScope(context, session, 'a', input())).rejects.toMatchObject({ statusCode: 409 });
  expect((await context.catalogs.readForSession(session)).assignments[0]).toEqual(first.assignment);
});
it('rolls back all object drafts if a database write fails during acceptance', async () => {
  const { context } = await setup(); const original = context.db.set.bind(context.db);
  vi.spyOn(context.db, 'set').mockImplementation((namespace, id, value) => { if (namespace === 'drafts' && (value as Draft).change.kind === 'assignment') throw new Error('Synthetic disk failure'); original(namespace, id, value); });
  await expect(saveAssignmentScope(context, session, 'a', { ...input(), newEntities: [{ clientId: 'new', type: 'team', name: 'Только атомарно', selected: true }] })).rejects.toThrow('Synthetic disk failure');
  expect(context.db.list('drafts')).toHaveLength(0); expect((await context.catalogs.readForSession(session)).entities).toHaveLength(3);
});
it('immediately retires an old confirmation when the expected cohort changes', async () => {
  const { context } = await setup(); const active = catalog(); const now = new Date().toISOString(), period = now.slice(0, 10);
  active.sources.push({ id: 's', name: 'Пример', kind: 'file', url: null, accessUrl: null, goalIds: ['g'], mode: 'local', freshnessHours: 168 }); context.db.set('catalog', 'active', active);
  await context.writeSnapshot({ id: 's1', classification: 'demo', sourceId: 's', period, collectedAt: now, sourceUpdatedAt: now,
    origin: 'file', dataHash: 'synthetic', status: 'personal', curatorId: null, curatorName: null, validatedAt: null, limitations: [], evidenceIds: [],
    observations: ['t1', 't2'].map(id => ({ id, goalId: 'g', leaderId: 'l', participantId: id, participantName: id, metricId: 'm', metricName: 'Практика', value: 100, target: 80, unit: '%', state: 'numeric', reason: null, period, sourceId: 's', sourceUpdatedAt: now, downloadedAt: now })) });
  const evaluation = (await context.state(session)).evaluations.find(item => item.leaderId === null)!;
  context.db.set<Attestation>('attestations', 'ok', { id: 'ok', goalId: 'g', leaderId: null, period, fingerprint: evaluation.fingerprint, curatorId: session.curatorId, curatorName: session.name, confirmedAt: now, comment: 'Проверено куратором', evidenceIds: [] });
  await saveAssignmentScope(context, session, 'a', input());
  expect(context.db.get<Attestation>('attestations', 'ok')?.invalidatedAt).toBeTruthy();
});
it('enforces reader and CSRF boundaries on the new HTTP action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uor-scope-api-')); roots.push(root);
  const app = await createApp({ projectRoot: root, initialCatalog: catalog(), registry: [{ id: session.curatorId, name: session.name, salt: 'fixture', hash: scryptSync('fixture-pass', 'fixture', 64).toString('hex') }], startupCheck: false }); apps.push(app);
  const initial = await app.inject('/api/state'); const token = initial.json().csrfToken;
  expect((await app.inject({ method: 'POST', url: '/api/assignments/a/scope', headers: { 'x-uor-token': token }, payload: input() })).statusCode).toBe(403);
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { 'x-uor-token': token }, payload: { role: 'curator', code: 'fixture-pass' } }); const cookie = login.headers['set-cookie']!.toString().split(';')[0];
  expect((await app.inject({ method: 'POST', url: '/api/assignments/a/scope', headers: { cookie }, payload: input() })).statusCode).toBe(403);
  const response = await app.inject({ method: 'POST', url: '/api/assignments/a/scope', headers: { cookie, 'x-uor-token': token }, payload: input() });
  expect(response.statusCode).toBe(200); expect(response.json().assignment.participantIds).toEqual(['t1']);
});
