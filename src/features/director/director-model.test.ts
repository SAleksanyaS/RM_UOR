import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CatalogSnapshot, DomainChangeEvent, ExecutionPlan, Session } from '../../domain/contracts';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import { buildDirectorModel } from './director-model';
import { saveDecision } from './decision-service';
import { decisionEntitySchema } from './decision-schema';
const now = '2026-10-25T12:00:00.000Z';
const session: Session = { id: 'curator-session', role: 'curator', curatorId: 'demo-curator', name: 'Куратор примера', createdAt: now };
const plan: ExecutionPlan = { stage: 'in_progress', plannedStartDate: null, targetDate: '2026-10-30', forecastDate: null, nextCheckDate: '2026-10-26', nextAction: 'Проверить доступ', blocker: '', decisionNeeded: 'Назначить ответственного', revision: 'plan-r', updatedAt: now, updatedBy: 'Куратор примера' };
function fixture(): CatalogSnapshot { return { schemaVersion: 1, id: 'director-demo', name: 'Синтетический каталог', classification: 'demo', importedAt: now,
  goals: [{ id: 'g', title: 'Цель синтетического примера', category: 'process', summary: '', target: '', metric: '', status: '', actions: [], links: [], scopeType: '', officialTarget: 80, internalTarget: null, unit: '%', baseline: null, weight: null, direction: 'increase', priority: null, ownerId: null, curatorId: null, revision: 'r', dueDate: '2026-11-01', plan }],
  leaders: [{ id: 'l', name: 'Лидер примера', teams: [] }], assignments: [{ id: 'a', goalId: 'g', leaderId: 'l', teams: [], active: true }], sources: [], comments: [], entities: [] }; }
const roots: string[] = [], contexts: ApplicationContext[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() { const root = await mkdtemp(join(tmpdir(), 'uor-director-')); roots.push(root); const context = await createContext({ projectRoot: root, initialCatalog: fixture(), startupCheck: false }); contexts.push(context); return context; }
it('separates declared commitment and official date, never invents a forecast or inherits DIT plans for a leader', () => {
  const model = buildDirectorModel(fixture(), [], now);
  expect(model.timeline.map(item => [item.kind, item.date])).toEqual([['check', '2026-10-26'], ['commitment', '2026-10-30'], ['official', '2026-11-01']]);
  expect(model.timeline.every(item => item.leaderId === null)).toBe(true); expect(model.timeline[1].officialDate).toBe('2026-11-01'); expect(model.requests).toHaveLength(1);
});
it('uses the exact seven-day journal interval and preserves actual before/after values', () => {
  const event = (id: string, at: string): DomainChangeEvent => ({ id, at, kind: 'goal_updated', objectId: 'g', objectLabel: 'Цель примера', actor: 'Куратор примера', fields: [{ field: 'officialTarget', before: null, after: 80 }] });
  const model = buildDirectorModel(fixture(), [event('before', '2026-10-18T11:59:59.999Z'), event('offset-before', '2026-10-18T14:59:59.999+03:00'), event('start', '2026-10-18T12:00:00.000Z'), event('last', '2026-10-25T11:59:59.999Z'), event('end', now)], now);
  expect(model.digest.events.map(item => item.id)).toEqual(['last', 'start']); expect(model.digest.events[0].fields[0].before).toBeNull();
});
it('requires curator, known goal and closure reason, enforces revision CAS and saves drafts with server authorship', async () => {
  const context = await setup(), decision = { name: 'Согласовать ответственного примера', goalId: 'g', owner: 'Владелец примера', dueDate: '2026-11-01', state: 'open' as const, closureComment: '' };
  await expect(saveDecision(context, { ...session, role: 'reader', curatorId: null }, { baseRevision: null, decision })).rejects.toMatchObject({ statusCode: 403 });
  await expect(saveDecision(context, session, { baseRevision: null, decision: { ...decision, goalId: 'missing' } })).rejects.toMatchObject({ statusCode: 404 });
  await expect(saveDecision(context, session, { baseRevision: null, decision: { ...decision, state: 'closed' } })).rejects.toThrow();
  const first = await saveDecision(context, session, { baseRevision: null, decision });
  expect(first.decision.updatedBy).toBe(session.name); expect(first.decision.revision).toBeTruthy(); expect((await context.catalogs.read()).entities).toHaveLength(0);
  await expect(saveDecision(context, session, { id: first.decision.id, baseRevision: null, decision })).rejects.toMatchObject({ statusCode: 409 });
  const closed = await saveDecision(context, session, { id: first.decision.id, baseRevision: first.decision.revision, decision: { ...decision, state: 'closed', closureComment: 'Ответственный согласован' } });
  expect(closed.draftId).toBe(first.draftId); expect(context.db.list('changes')).toHaveLength(2); expect(decisionEntitySchema.parse((await context.catalogs.readForSession(session)).entities[0]).state).toBe('closed');
  expect(context.db.list('snapshots')).toEqual([]); expect(context.db.list('attestations')).toEqual([]);
});
it('rejects forged server fields, concurrent catalog writes, and rolls back a draft if audit fails', async () => {
  const context = await setup(), decision = { name: 'Решение примера', goalId: null, owner: 'Владелец примера', dueDate: null, state: 'open' as const, closureComment: '' };
  await expect(saveDecision(context, session, { baseRevision: null, decision: { ...decision, updatedBy: 'Подмена' } } as never)).rejects.toThrow();
  const save = context.catalogs.saveDraft.bind(context.catalogs);
  const spy = vi.spyOn(context.catalogs, 'saveDraft').mockImplementation(async (actor, change, options) => {
    const catalog = context.db.get<CatalogSnapshot>('catalog', 'active')!; catalog.goals[0].title = 'Параллельная правка'; context.db.set('catalog', 'active', catalog); return save(actor, change, options);
  });
  await expect(saveDecision(context, session, { baseRevision: null, decision })).rejects.toMatchObject({ statusCode: 409 }); expect(context.db.list('drafts')).toHaveLength(0);
  spy.mockRestore(); vi.spyOn(context.catalogs, 'recordChange').mockImplementation(() => { throw new Error('Audit failure'); });
  await expect(saveDecision(context, session, { baseRevision: null, decision })).rejects.toThrow('Audit failure'); expect(context.db.list('drafts')).toHaveLength(0);
});
