import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import demo from '../../../catalog/demo.json';
import type { CatalogSnapshot, CuratorSession, Draft } from '../../domain/contracts';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import { saveLeader } from './leader-service';

const roots: string[] = [], contexts: ApplicationContext[] = [];
const actor: CuratorSession = { id: 's', role: 'curator', curatorId: 'curator', name: 'Куратор', createdAt: '2026-10-24T00:00:00Z' };
afterEach(async () => { for (const c of contexts.splice(0)) c.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'uor-leaders-')); if (!roots.includes(root)) roots.push(root);
  const context = await createContext({ projectRoot: root, allowedRoots: [root], initialCatalog: demo as CatalogSnapshot, startupCheck: false }); contexts.push(context); return context;
}
it('creates a durable leader and explicit goal assignments without invented teams or facts, hidden from a reader until release', async () => {
  const context = await fixture(); const goal = (await context.catalogs.read()).goals[0];
  const result = await saveLeader(context, actor, null, { name: '  Новый   ИТ-лидер ', clusterName: 'Кластер А', goalIds: [goal.id, goal.id] });
  expect(result.leader).toMatchObject({ name: 'Новый ИТ-лидер', clusterName: 'Кластер А', teams: [] });
  const catalog = await context.catalogs.readForSession(actor);
  expect(catalog.assignments.filter(a => a.leaderId === result.leader.id)).toEqual([{ id: expect.any(String), leaderId: result.leader.id, goalId: goal.id, active: true, teams: [] }]);
  expect(context.db.list('snapshots')).toEqual([]);
  expect((await context.catalogs.read()).leaders.some(l => l.id === result.leader.id)).toBe(false);
  const root = context.paths.projectRoot; context.db.close(); contexts.splice(contexts.indexOf(context), 1);
  expect((await (await fixture(root)).catalogs.readForSession(actor)).leaders.some(l => l.id === result.leader.id)).toBe(true);
});
it('toggles assignments without losing cohort, targets or plans, rejects stale goal membership and duplicate identities', async () => {
  const context = await fixture(); const catalog = await context.catalogs.readForSession(actor), leader = catalog.leaders[0];
  const existing = catalog.assignments.find(a => a.leaderId === leader.id)!;
  existing.participantIds = ['known-team']; existing.target = 'Своя цель';
  existing.plan = { stage: 'planned', plannedStartDate: null, targetDate: '2026-12-01', forecastDate: null, nextCheckDate: null,
    nextAction: 'Проверить результат', blocker: '', decisionNeeded: '', updatedAt: '2026-10-24T00:00:00Z', updatedBy: 'Куратор', revision: 'original-plan' };
  context.db.set('catalog', 'active', catalog);
  const goalIds = [...new Set(catalog.assignments.filter(a => a.leaderId === leader.id && a.active !== false).map(a => a.goalId))];
  const input = { baseLeader: leader, baseGoalIds: goalIds, name: leader.name, clusterName: 'Новое название кластера', goalIds: [] };
  const saved = await saveLeader(context, actor, leader.id, input);
  const changed = (await context.catalogs.readForSession(actor)).assignments.find(a => a.id === existing.id)!;
  expect(changed).toMatchObject({ participantIds: ['known-team'], target: 'Своя цель', active: false });
  expect(changed.plan).toEqual(existing.plan);
  await expect(saveLeader(context, actor, leader.id, input)).rejects.toMatchObject({ statusCode: 409 });
  await expect(saveLeader(context, actor, null, { name: ` ${saved.leader.name.toUpperCase()} `, clusterName: saved.leader.clusterName ?? null, goalIds: [] })).rejects.toMatchObject({ statusCode: 409 });
  await expect(saveLeader(context, actor, leader.id, { ...input, baseLeader: saved.leader, baseGoalIds: goalIds })).rejects.toMatchObject({ statusCode: 409 });
  await saveLeader(context, actor, leader.id, { baseLeader: saved.leader, baseGoalIds: [], name: saved.leader.name, clusterName: saved.leader.clusterName ?? null, goalIds: [existing.goalId] });
  const restored = (await context.catalogs.readForSession(actor)).assignments.find(a => a.id === existing.id)!;
  expect(restored).toMatchObject({ participantIds: ['known-team'], target: 'Своя цель', active: true, plan: existing.plan });
  expect((await context.catalogs.readForSession(actor)).assignments.filter(a => a.leaderId === leader.id && a.goalId === existing.goalId)).toHaveLength(catalog.assignments.filter(a => a.leaderId === leader.id && a.goalId === existing.goalId).length);
});
it('denies readers and invalid references, and atomically guards concurrent saves after asynchronous stages', async () => {
  const context = await fixture();
  await expect(saveLeader(context, { ...actor, role: 'reader' } as unknown as CuratorSession, null, { name: 'Запрещено', clusterName: null, goalIds: [] })).rejects.toMatchObject({ statusCode: 403 });
  await expect(saveLeader(context, actor, null, { name: 'Неизвестная цель', clusterName: null, goalIds: ['missing'] })).rejects.toMatchObject({ statusCode: 400 });
  const originalStage = context.operations.stage.bind(context.operations);
  vi.spyOn(context.operations, 'stage').mockImplementationOnce(async (...args) => {
    await originalStage(...args);
    context.db.set('drafts', 'concurrent', { id: 'concurrent', curatorId: actor.curatorId, change: { kind: 'leader', id: 'other', baseRevision: null, patch: { id: 'other', name: 'Другой', teams: [] } }, base: null, createdAt: new Date().toISOString(), status: 'local', error: null } satisfies Draft);
  });
  await expect(saveLeader(context, actor, null, { name: 'Отменённое создание', clusterName: null, goalIds: [(await context.catalogs.read()).goals[0].id] })).rejects.toMatchObject({ statusCode: 409 });
  expect(context.db.list<Draft>('drafts')).toHaveLength(1);
  expect(context.db.list('changes')).toHaveLength(0);
});
