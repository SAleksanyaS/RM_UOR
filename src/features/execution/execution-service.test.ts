import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CatalogSnapshot, CuratorSession, LocalSnapshot } from '../../domain/contracts';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import { baselinePackage, checkRetention, completePackage, getExecutionView, saveExecutionConfig, saveWorkPackage } from './execution-service';
import type { PackageInput } from './execution-contracts';
import { readWorkPackage, validateExecutionEntities } from './execution-schema';
import { getGoalHistory } from '../history/history-service';
const contexts: ApplicationContext[] = [], roots: string[] = [];
const curator: CuratorSession = { id: 's', role: 'curator', curatorId: 'c', name: 'Анна', createdAt: '2026-10-25T10:00:00Z' };
const catalog: CatalogSnapshot = { schemaVersion: 1, id: 'demo', name: 'Demo', classification: 'demo', importedAt: '2026-10-25T10:00:00Z', goals: ['g', 'h'].map(id => ({ id, title: id, category: 'process', scopeType: 'global', target: '', metric: '', status: '', summary: '', actions: [], links: [], ownerId: null, curatorId: null, officialTarget: 10, internalTarget: null, unit: '', direction: 'increase', baseline: null, weight: 1, priority: null, dueDate: null, revision: 'r' })), leaders: [], assignments: [], sources: [], comments: [], entities: [] };
const input: PackageInput = { goalId: 'g', leaderId: null, baseRevision: null, title: 'Документ', owner: 'Владелец', dueDate: '2026-11-01', weight: 2, effortHours: 8, dependencies: [] };
async function setup() { const root = await mkdtemp(join(tmpdir(), 'uor-execution-')); roots.push(root); const ctx = await createContext({ projectRoot: root, initialCatalog: catalog, startupCheck: false }); contexts.push(ctx); return ctx; }
afterEach(async () => { vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) ctx.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('CAS retains drafts, immutable baseline, audit, and facts/attestations across real completion', async () => {
  const ctx = await setup(), first = await saveWorkPackage(ctx, curator, input), id = first.record.id;
  await expect(saveWorkPackage(ctx, curator, { ...input, id })).rejects.toMatchObject({ statusCode: 409 });
  const based = await baselinePackage(ctx, curator, id, first.record.revision);
  const edited = await saveWorkPackage(ctx, curator, { ...input, id, baseRevision: based.record.revision, weight: 20, dueDate: '2026-12-01' });
  expect((edited.record as ReturnType<typeof readWorkPackage>).baseline).toMatchObject({ weight: 2, dueDate: '2026-11-01' });
  await expect(baselinePackage(ctx, curator, id, edited.record.revision)).rejects.toMatchObject({ statusCode: 409 });
  ctx.db.set('snapshots', 'facts', { id: 'facts', custom: 'unchanged' }); ctx.db.set('attestations', 'att', { id: 'att', custom: 'unchanged' });
  await expect(completePackage(ctx, curator, id, { baseRevision: edited.record.revision, completed: true, comment: '', evidence: '' })).rejects.toThrow();
  const done = await completePackage(ctx, curator, id, { baseRevision: edited.record.revision, completed: true, comment: 'Документ утверждён', evidence: '' });
  expect((done.record as ReturnType<typeof readWorkPackage>).events[0]).toMatchObject({ actor: curator.name, completed: true, comment: 'Документ утверждён' });
  expect(ctx.db.list('snapshots')).toEqual([{ id: 'facts', custom: 'unchanged' }]); expect(ctx.db.list('attestations')).toEqual([{ id: 'att', custom: 'unchanged' }]);
  expect(ctx.db.list('drafts')).toHaveLength(1); expect(ctx.db.list('changes')).toHaveLength(4);
  expect((await ctx.catalogs.read()).entities).toHaveLength(0);
});
it('rejects cross-goal cycles, unfinished dependencies, inactive scopes, reader writes and audit failure atomically', async () => {
  const ctx = await setup(), a = await saveWorkPackage(ctx, curator, input), b = await saveWorkPackage(ctx, curator, { ...input, goalId: 'h', dependencies: [a.record.id] });
  await expect(saveWorkPackage(ctx, curator, { ...input, id: a.record.id, baseRevision: a.record.revision, dependencies: [b.record.id] })).rejects.toThrow(/цикл/);
  await expect(completePackage(ctx, curator, b.record.id, { baseRevision: b.record.revision, completed: true, comment: 'Работа готова', evidence: '' })).rejects.toMatchObject({ statusCode: 409 });
  await expect(saveWorkPackage(ctx, { ...curator, role: 'reader' }, input)).rejects.toMatchObject({ statusCode: 403 });
  await expect(saveWorkPackage(ctx, curator, { ...input, leaderId: 'absent' })).rejects.toMatchObject({ statusCode: 404 });
  vi.spyOn(ctx.catalogs, 'recordChange').mockImplementation(() => { throw new Error('audit unavailable'); });
  await expect(saveWorkPackage(ctx, curator, { ...input, id: a.record.id, baseRevision: a.record.revision, title: 'Failed change' })).rejects.toThrow('audit unavailable');
  expect(readWorkPackage((await ctx.catalogs.readForSession(curator)).entities.find(e => e.id === a.record.id)!).title).toBe(input.title);
});
it('captures substantive retention checks, next date and explicit metadata without confirming goal', async () => {
  const ctx = await setup();
  const config = await saveExecutionConfig(ctx, curator, { goalId: 'g', leaderId: null, baseRevision: null, cadenceDays: 7, nextCheckDate: '2026-10-20', capacityHours: 40, capacityPeriod: 'За неделю', criticalService: 'Сервис А', product: 'Продукт Б', mandatoryRequirement: 'Требование В' });
  expect((await getExecutionView(ctx, curator)).inbox.some(i => i.category === 'retention' && i.overdue)).toBe(true);
  await expect(checkRetention(ctx, curator, config.record.id, { baseRevision: config.record.revision, result: 'stable', comment: '', evidence: '' })).rejects.toThrow();
  const checked = await checkRetention(ctx, curator, config.record.id, { baseRevision: config.record.revision, result: 'regression', comment: 'По проверке нужно загрузить отрицательные факты', evidence: '' });
  expect(checked.record).toMatchObject({ checks: [{ result: 'regression', actor: curator.name }], capacityHours: 40, criticalService: 'Сервис А' });
  expect(ctx.db.list('attestations')).toEqual([]); expect(ctx.db.list('snapshots')).toEqual([]);
  const reader = await getExecutionView(ctx, { ...curator, role: 'reader', curatorId: null }); expect(reader.inbox.some(i => i.category === 'draft')).toBe(false); expect(reader.configs).toEqual([]);
});
it('rejects tampered shared execution bodies and stale concurrent catalog save', async () => {
  const ctx = await setup(), a = await saveWorkPackage(ctx, curator, input), current = await ctx.catalogs.readForSession(curator);
  const altered = structuredClone(current); altered.entities[0].goalIds = ['h']; expect(() => validateExecutionEntities(altered)).toThrow(/соответствует/);
  const original = ctx.catalogs.saveDraft.bind(ctx.catalogs);
  vi.spyOn(ctx.catalogs, 'saveDraft').mockImplementation(async (session, change, options) => { const latest = ctx.db.get<CatalogSnapshot>('catalog', 'active')!; latest.name = 'Concurrent'; ctx.db.set('catalog', 'active', latest); return original(session, change, options); });
  await expect(saveWorkPackage(ctx, curator, { ...input, id: a.record.id, baseRevision: a.record.revision, title: 'Conflicting' })).rejects.toMatchObject({ statusCode: 409 });
});
it('restores shared drafts after restart and filters private latest source diagnostics', async () => {
  const ctx = await setup(), saved = await saveWorkPackage(ctx, curator, input);
  const root = ctx.paths.projectRoot; ctx.db.close(); contexts.splice(contexts.indexOf(ctx), 1);
  const restored = await createContext({ projectRoot: root, initialCatalog: catalog, startupCheck: false }); contexts.push(restored);
  expect((await getExecutionView(restored, curator)).packages[0].revision).toBe(saved.record.revision);
  restored.db.set('connector-diagnostics', 'mine', { ownerSessionId: curator.id, sourceId: 's', status: 'access_denied', at: '2026-10-25T10:00:00Z', message: 'Нет прав' });
  restored.db.set('connector-diagnostics', 'other', { ownerSessionId: 'someone-else', sourceId: 'private', status: 'certificate', at: '2026-10-25T10:00:00Z', message: 'Private detail' });
  const view = await getExecutionView(restored, curator); expect(view.inbox.filter(i => i.category === 'source')).toHaveLength(1); expect(JSON.stringify(view.inbox)).not.toContain('Private detail');
  restored.db.set('connector-diagnostics', 'mine', { ownerSessionId: curator.id, sourceId: 's', status: 'accepted', at: '2026-10-25T10:30:00Z', message: 'Принято' });
  expect((await getExecutionView(restored, curator)).inbox.filter(i => i.category === 'source')).toEqual([]);
});
it('does not extrapolate comparable older facts into a different current methodology', async () => {
  const ctx = await setup(), current = structuredClone(catalog);
  current.goals[0].measurement = { kind: 'scalar', aggregation: 'single', metrics: [{ id: 'm', name: 'Метрика', unit: '', target: 10, direction: 'increase' }] };
  current.sources = [{ id: 'source', name: 'Источник', goalIds: ['g'], url: null, accessUrl: null, kind: 'file', mode: 'local', freshnessHours: 1000 }];
  ctx.db.set('catalog', 'active', current);
  for (const index of [1, 2, 3]) {
    const period = `2026-10-0${index}`, at = `${period}T12:00:00Z`;
    const snapshot: LocalSnapshot = { id: `point-${index}`, classification: 'demo', sourceId: 'source', period, collectedAt: at, sourceUpdatedAt: at, origin: 'file', dataHash: `h${index}`, status: 'personal', curatorId: null, curatorName: null, validatedAt: null, limitations: [], evidenceIds: [], evaluationBasis: { methodVersion: 'explicit-measurement-v1', goal: structuredClone(current.goals[0]), assignments: [] }, observations: [{ id: `o${index}`, goalId: 'g', leaderId: null, participantId: 'global-dit', participantName: 'ДИТ', metricId: 'm', metricName: 'Метрика', value: index, target: 10, unit: '', state: 'numeric', reason: null, period, sourceId: 'source', sourceUpdatedAt: at, downloadedAt: at }] };
    snapshot.evaluationBasis!.organization = { leaders: [], entities: [], directions: [], comments: [], sources: current.sources };
    await ctx.writeSnapshot(snapshot);
  }
  const history = await getGoalHistory(ctx, curator, 'g', null);
  expect(history.points.map(p => ({ actual: p.actual, flags: p.qualityFlags }))).toEqual([1, 2, 3].map(actual => ({ actual, flags: [] })));
  expect((await getExecutionView(ctx, curator)).forecasts.find(f => f.goalId === 'g')?.forecast).toMatchObject({ date: '2026-10-10' });
  current.goals[0].measurement!.aggregation = 'sum'; ctx.db.set('catalog', 'active', current);
  expect((await getExecutionView(ctx, curator)).forecasts.find(f => f.goalId === 'g')?.forecast).toMatchObject({ date: null, reason: expect.stringContaining('Текущая методика') });
});
