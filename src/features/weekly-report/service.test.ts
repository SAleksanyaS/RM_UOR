import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { CatalogSnapshot, CuratorSession, Draft } from '../../domain/contracts';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import { listWeeklyReports, saveWeeklyBrief } from './service';
import { readWeeklyBrief, validateWeeklyBriefEntities } from './contracts';
import { registerWeeklyReportRoutes } from './routes';

const roots: string[] = [], contexts: ApplicationContext[] = [];
const curator: CuratorSession = { id: 'session-a', role: 'curator', curatorId: 'curator-a', name: 'Анна — УОР', createdAt: new Date().toISOString() };
const other: CuratorSession = { ...curator, id: 'session-b', curatorId: 'curator-b', name: 'Борис — УОР' };
const catalog: CatalogSnapshot = { schemaVersion: 1, id: 'synthetic', name: 'Синтетический каталог', classification: 'demo', importedAt: '2026-10-25T12:00:00.000Z', goals: [], leaders: [], assignments: [], sources: [], comments: [], entities: [] };
const input = (extra: Record<string, unknown> = {}) => ({ weekStart: '2026-10-19', baseRevision: null, summary: 'Главная сводка', completed: ['Подготовлен план'], attention: ['Нужен ответ владельца'], nextWeek: ['Проверить источник'], ...extra });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'uor-weekly-')); roots.push(root);
  const registry = [curator, other].map(session => ({ id: session.curatorId, name: session.name, salt: 'synthetic', hash: scryptSync('fixture-only', 'synthetic', 64).toString('hex') }));
  const context = await createContext({ projectRoot: root, initialCatalog: structuredClone(catalog), registry }); contexts.push(context); return context;
}
afterEach(async () => { for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('saves an owned weekly entity draft without manufacturing measured data or exposing it to readers and colleagues', async () => {
  const context = await setup(), before = await context.catalogs.read();
  const result = await saveWeeklyBrief(context, curator, input());
  expect(result.record).toMatchObject({ ownerId: 'curator-a', ownerName: 'Анна — УОР', weekStart: '2026-10-19', summary: 'Главная сводка' });
  expect(readWeeklyBrief(context.db.get<Draft>('drafts', result.draftId)!.change.patch as never)).toMatchObject({ id: result.record.id, revision: result.record.revision });
  expect(await context.catalogs.read()).toEqual(before);
  expect(context.db.list('snapshots')).toEqual([]); expect(context.db.list('attestations')).toEqual([]);
  expect((await listWeeklyReports(context, await context.roles.enterReader(), '2026-10-19')).published).toEqual([]);
  const mine = await listWeeklyReports(context, curator, '2026-10-19'); expect(mine.own?.visibility).toBe('local');
  const colleague = await listWeeklyReports(context, other, '2026-10-19'); expect(colleague.own).toBeNull(); expect(colleague.published).toEqual([]);
});

it('uses one stable identity per owner and week, rejects stale/concurrent writes and keeps distinct owners isolated', async () => {
  const context = await setup(), saved = await saveWeeklyBrief(context, curator, input());
  await expect(saveWeeklyBrief(context, curator, input())).rejects.toMatchObject({ statusCode: 409 });
  const outcomes = await Promise.allSettled([
    saveWeeklyBrief(context, curator, input({ baseRevision: saved.record.revision, summary: 'Первый редактор' })),
    saveWeeklyBrief(context, curator, input({ baseRevision: saved.record.revision, summary: 'Второй редактор' })),
  ]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
  const updated = (await listWeeklyReports(context, curator, '2026-10-19')).own!.record;
  expect(updated.id).toBe(saved.record.id); expect(updated.revision).not.toBe(saved.record.revision);
  await expect(saveWeeklyBrief(context, other, input({ baseRevision: updated.revision }))).rejects.toMatchObject({ statusCode: 409 });
  const theirs = await saveWeeklyBrief(context, other, input({ summary: 'Сводка Бориса' }));
  expect(theirs.record.id).not.toBe(saved.record.id); expect(context.db.list('drafts')).toHaveLength(2);
  await expect(saveWeeklyBrief(context, other, input({ ownerId: curator.curatorId }))).rejects.toThrow();
  expect((await listWeeklyReports(context, curator, '2026-10-19')).own!.record.summary).toBe(updated.summary);
});

it('bounds dates and text, validates JSON bodies and rejects duplicate owner/week in imported catalogs', async () => {
  const context = await setup();
  for (const extra of [{ weekStart: '2026-02-30' }, { weekStart: '2026-10-20' }, { summary: ' ' }, { summary: 'я'.repeat(4001) }, { completed: Array(21).fill('Задача') }, { attention: ['я'.repeat(1001)] }, { nextWeek: [''] }, { unexpected: true }]) {
    await expect(saveWeeklyBrief(context, curator, input(extra))).rejects.toThrow();
  }
  const saved = await saveWeeklyBrief(context, curator, input());
  const entity = context.db.get<Draft>('drafts', saved.draftId)!.change.patch;
  expect(() => validateWeeklyBriefEntities({ ...catalog, entities: [entity as never] })).not.toThrow();
  expect(() => validateWeeklyBriefEntities({ ...catalog, entities: [{ ...entity, body: '{broken' } as never] })).toThrow();
  expect(() => validateWeeklyBriefEntities({ ...catalog, entities: [entity as never, { ...entity, id: 'duplicate' } as never] })).toThrow();
});

it('reads only the published catalog, with selected weeks and a clearly separate own draft/release overlay', async () => {
  const context = await setup(), first = await saveWeeklyBrief(context, curator, input());
  const draft = context.db.get<Draft>('drafts', first.draftId)!;
  context.db.set('catalog', 'active', { ...catalog, entities: [draft.change.patch] });
  context.db.set('drafts', draft.id, { ...draft, status: 'published' });
  await saveWeeklyBrief(context, curator, input({ baseRevision: first.record.revision, summary: 'Ещё не опубликованная правка' }));
  await saveWeeklyBrief(context, other, input({ weekStart: '2026-10-26', summary: 'Будущая неделя' }));
  const reader = await context.roles.enterReader(), view = await listWeeklyReports(context, reader, '2026-10-19');
  expect(view.published.map(record => record.summary)).toEqual(['Главная сводка']); expect(view.own).toBeNull(); expect(view.weeks).not.toContain('2026-10-26');
  const mine = await listWeeklyReports(context, curator, '2026-10-19'); expect(mine.published[0].summary).toBe('Главная сводка'); expect(mine.own?.record.summary).toBe('Ещё не опубликованная правка'); expect(mine.own?.visibility).toBe('local');
  expect((await listWeeklyReports(context, reader, '2026-10-26')).published).toEqual([]);
  const local = context.db.list<Draft>('drafts').find(item => item.curatorId === curator.curatorId && item.status === 'local')!;
  context.db.set('drafts', local.id, { ...local, status: 'published' });
  expect((await listWeeklyReports(context, curator, '2026-10-19')).own?.visibility).toBe('release');
});

it('retains and edits a partial local patch rebased over an in-flight release before the entity reaches main', async () => {
  const context = await setup(), saved = await saveWeeklyBrief(context, curator, input());
  const draft = context.db.get<Draft>('drafts', saved.draftId)!;
  const nextBody = JSON.stringify({ ...JSON.parse(String(draft.change.patch.body)), summary: 'Правка во время отправки' });
  // The publisher keeps only changed fields after sending an older revision.
  context.db.set('drafts', draft.id, { ...draft, base: draft.change.patch, change: { ...draft.change, baseRevision: saved.record.revision, patch: { body: nextBody, revision: 'after-send' } } });
  const view = await listWeeklyReports(context, curator, '2026-10-19');
  expect(view.own?.record.summary).toBe('Правка во время отправки'); expect(view.own?.visibility).toBe('local');
  expect((await listWeeklyReports(context, other, '2026-10-19')).own).toBeNull();
  const updated = await saveWeeklyBrief(context, curator, input({ baseRevision: 'after-send', summary: 'Следующая правка' }));
  expect(updated.record.id).toBe(saved.record.id); expect(updated.record.summary).toBe('Следующая правка');
  expect(context.db.list('drafts')).toHaveLength(1);
  expect((await listWeeklyReports(context, await context.roles.enterReader(), '2026-10-19')).published).toEqual([]);
});

it('requires both curator authorization and CSRF for writes while reading remains public', async () => {
  const context = await setup(), app = Fastify(); await app.register(cookie); registerWeeklyReportRoutes(app, context);
  context.db.set('sessions', curator.id, curator);
  app.setErrorHandler((error, _request, reply) => reply.code((error as { statusCode?: number }).statusCode ?? 400).send({ message: (error as Error).message }));
  try {
    expect((await app.inject('/api/weekly-reports?weekStart=2026-10-19')).statusCode).toBe(200);
    expect((await app.inject('/api/weekly-reports?weekStart=2026-10-20')).statusCode).toBe(400);
    for (const headers of [{}, { 'x-uor-token': context.csrfToken }, { cookie: `uor_session=${curator.id}` }]) {
      expect((await app.inject({ method: 'POST', url: '/api/weekly-reports', headers, payload: input() })).statusCode).toBe(403);
    }
    const response = await app.inject({ method: 'POST', url: '/api/weekly-reports', headers: { cookie: `uor_session=${curator.id}`, 'x-uor-token': context.csrfToken }, payload: input() });
    expect(response.statusCode).toBe(200); expect(response.json().record.ownerId).toBe(curator.curatorId);
  } finally { await app.close(); }
});
