import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import demo from '../../../catalog/demo.json';
import type { CatalogSnapshot, CuratorSession, GoalMeasurement, LocalSnapshot } from '../../domain/contracts';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import { probeTabularImport, previewTabularImport, commitTabularImport } from './service';
import type { TabularImportProfile } from './contracts';
import { previewGoalSetup, commitGoalSetup } from '../goal-setup/goal-setup-service';
import { getGoalHistory } from '../history/history-service';
import { buildPortfolioModel } from '../overview/portfolio-model';
import { buildReport } from '../reporting/report-service';
const actor: CuratorSession = { id: 's', role: 'curator', curatorId: 'curator', name: 'Куратор', createdAt: '2026-10-24T00:00:00Z' };
const roots: string[] = [], contexts: ApplicationContext[] = [];
afterEach(async () => { contexts.splice(0).forEach(c => c.db.close()); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'uor-tabular-')); roots.push(root);
  const catalog = structuredClone(demo) as CatalogSnapshot, goal = catalog.goals[0];
  goal.measurement = { kind: 'participant_share', aggregation: 'average', metrics: [{ id: 'm', name: 'Тестовая метрика', unit: '%', target: 80, direction: 'increase' }] }; goal.requiredMetricIds = ['m'];
  catalog.leaders = [{ id: 'l', name: 'Лидер', teams: [] }]; catalog.assignments = [{ id: 'a', goalId: goal.id, leaderId: 'l', teams: [], participantIds: ['p1', 'p2'] }];
  catalog.entities = [{ id: 'p1', name: 'Команда А', type: 'team', leaderId: 'l' }, { id: 'p2', name: 'Команда Б', type: 'team', leaderId: 'l' }];
  catalog.comments = []; catalog.sources = [{ id: 'file', name: 'Файл', kind: 'file', mode: 'local', url: null, accessUrl: null, freshnessHours: 168, goalIds: [goal.id] }];
  const context = await createContext({ projectRoot: root, allowedRoots: [root], initialCatalog: catalog, startupCheck: false }); contexts.push(context);
  const input = { goalId: goal.id, sourceId: 'file', name: 'f.csv', base64: Buffer.from('Команда;Факт;Состояние;Причина\nА;90;numeric;\nБ;;no_events;Нет событий').toString('base64') };
  const profile: TabularImportProfile = { parser: 'tabular-v1', columns: { participant: 'Команда', value: 'Факт', state: 'Состояние', reason: 'Причина' }, defaults: { period: '2026-10-24', metricId: 'm' }, leaderMapping: {}, participantMapping: { А: 'p1', Б: 'p2' }, metricMapping: {} };
  return { context, input, profile, catalog };
}
it('accepts real table facts for a newly created global DIT goal and keeps state, history and portfolio coherent', async () => {
  const { context } = await fixture();
  const setup = await previewGoalSetup(context, actor, { requestId: 'global-goal', goal: { title: 'Общая цель ДИТ', category: 'data', scopeType: 'global',
    officialTarget: 50, internalTarget: null, unit: 'шт', direction: 'increase', baseline: 0 },
    measurement: { kind: 'scalar', aggregation: 'single', metrics: [{ id: 'global-value', name: 'Общий результат', unit: 'шт', target: 50, direction: 'increase' }] },
    assignments: [], source: { name: 'Глобальные данные', kind: 'file' }, sample: { period: '2026-10-25', rows: [] } });
  const created = await commitGoalSetup(context, actor, setup.previewId);
  await context.catalogs.saveDraft(actor, { kind: 'assignment', id: 'retired-global-assignment', baseRevision: null,
    patch: { id: 'retired-global-assignment', goalId: created.goalId, leaderId: 'l', teams: [], participantIds: ['l'], active: false } });
  const file = { name: 'global.csv', goalId: created.goalId, sourceId: setup.source.id, base64: Buffer.from('Факт\n50').toString('base64') };
  const probe = await probeTabularImport(context, actor, file);
  expect(probe.options.participants).toContainEqual({ id: 'global-dit', name: 'ДИТ в целом' }); expect(probe.options.leaders).toEqual([]);
  const profile: TabularImportProfile = { ...probe.profile, columns: { value: 'Факт' }, defaults: { ...probe.profile.defaults, period: '2026-10-25' } };
  const preview = await previewTabularImport(context, actor, { ...file, profile });
  expect(preview.canCommit, JSON.stringify(preview.issues)).toBe(true);
  expect(preview.sample[0]).toMatchObject({ leaderId: null, participantId: 'global-dit', value: 50 });
  const result = await commitTabularImport(context, actor, preview.id);
  expect(context.db.get<LocalSnapshot>('snapshots', result.snapshotId)?.observations).toHaveLength(1);
  const state = await context.state(actor), evaluations = state.evaluations.filter(item => item.goalId === created.goalId);
  expect(evaluations).toHaveLength(1); expect(evaluations[0]).toMatchObject({ leaderId: null, actual: 50, official: 'met', validation: 'pending', progress: 100 });
  expect((await getGoalHistory(context, actor, created.goalId, null)).points[0]).toMatchObject({ actual: 50, official: 'met' });
  expect(buildPortfolioModel(state).goals.find(item => item.goal.id === created.goalId)?.status).toBe('pending');
  const report = buildReport(state.catalog, state.snapshots, state.attestations, { goalIds: [created.goalId], leaderIds: [], period: '2026-10-25' }, actor.name);
  expect(report.rows[0].evaluation).toMatchObject({ actual: 50, official: 'met', validation: 'pending' });
  expect(report.summary).toMatchObject({ goals: 1, pending: 1, unknown: 0 });
  const wrongScope = await previewTabularImport(context, actor, { ...file, profile: { ...profile, defaults: { ...profile.defaults, leaderId: 'l' } } });
  expect(wrongScope.canCommit).toBe(false);
});
it('probes and previews without changing facts, catalog or attestations, then commits snapshot and reusable profile atomically', async () => {
  const { context, input, profile } = await fixture(); const original = context.db.get('catalog', 'active');
  const before = context.db.list('snapshots'); const attestations = context.db.list('attestations');
  const probe = await probeTabularImport(context, actor, input); expect(probe.columns).toContain('Факт'); expect(probe.options.metrics[0].name).toBe('Тестовая метрика');
  const preview = await previewTabularImport(context, actor, { ...input, profile });
  expect(preview.canCommit, JSON.stringify(preview.issues)).toBe(true); expect(preview.sample[1]).toMatchObject({ state: 'no_events', value: null, reason: 'Нет событий', sourceUpdatedAt: null });
  expect(context.db.get('catalog', 'active')).toEqual(original); expect(context.db.list('snapshots')).toEqual(before); expect(context.db.list('attestations')).toEqual(attestations);
  const result = await commitTabularImport(context, actor, preview.id); expect(result.duplicate).toBe(false);
  expect(context.db.get<LocalSnapshot>('snapshots', result.snapshotId)?.observations).toHaveLength(2);
  expect((await context.catalogs.readForSession(actor)).sources.find(s => s.id === 'file')?.importProfile).toEqual(profile);
  expect(await commitTabularImport(context, actor, preview.id)).toEqual(result);
  const again = await previewTabularImport(context, actor, { ...input, profile }); expect(again.duplicateSnapshotId).toBe(result.snapshotId);
  expect((await commitTabularImport(context, actor, again.id)).duplicate).toBe(true);
});
it('rejects stale previews, other curators, readers and conflicting duplicate facts', async () => {
  const { context, input, profile } = await fixture(); const preview = await previewTabularImport(context, actor, { ...input, profile });
  await expect(commitTabularImport(context, { ...actor, curatorId: 'other' }, preview.id)).rejects.toMatchObject({ statusCode: 403 });
  await expect(probeTabularImport(context, { ...actor, role: 'reader' } as unknown as CuratorSession, input)).rejects.toMatchObject({ statusCode: 403 });
  context.db.set('drafts', 'external', { id: 'external', curatorId: actor.curatorId, status: 'local' });
  await expect(commitTabularImport(context, actor, preview.id)).rejects.toMatchObject({ statusCode: 409 }); expect(context.db.get('snapshots', preview.id)).toBeNull();
  context.db.remove('drafts', 'external');
  const conflicts = await previewTabularImport(context, actor, { ...input, base64: Buffer.from('Команда;Факт;Состояние;Причина\nА;90;numeric;\nА;50;numeric;').toString('base64'), profile });
  expect(conflicts.canCommit).toBe(false); expect(conflicts.issues.some(i => i.code === 'conflicting_duplicate')).toBe(true);
});
it('never infers missing assignment participants from imported rows and rejects unknown mapping or out-of-scope teams', async () => {
  const { context, input, profile, catalog } = await fixture();
  const partial = await previewTabularImport(context, actor, { ...input, base64: Buffer.from('Команда;Факт;Состояние;Причина\nА;90;numeric;').toString('base64'), profile });
  expect(partial.evaluations[0].missing).toBeGreaterThan(0); expect(partial.evaluations[0].official).not.toBe('met');
  const bad = await previewTabularImport(context, actor, { ...input, profile: { ...profile, participantMapping: { А: 'not-a-team', Б: 'p2' } } });
  expect(bad.canCommit).toBe(false);
  catalog.assignments[0].participantIds = ['p2']; context.db.set('catalog', 'active', catalog);
  expect((await previewTabularImport(context, actor, { ...input, profile })).issues.some(i => i.code === 'participant_mapping')).toBe(true);
});
it('rejects expired or changed source facts and rolls back source drafts when audit writing fails', async () => {
  const { context, input, profile } = await fixture();
  const expired = await previewTabularImport(context, actor, { ...input, profile });
  const record = context.db.get<{ preview: { expiresAt: string } }>('tabular-previews', expired.id)!;
  record.preview.expiresAt = '2000-01-01T00:00:00Z'; context.db.set('tabular-previews', expired.id, record);
  await expect(commitTabularImport(context, actor, expired.id)).rejects.toMatchObject({ statusCode: 410 });
  const stale = await previewTabularImport(context, actor, { ...input, profile });
  context.db.set('snapshots', 'other', { id: 'other', sourceId: 'file', classification: 'demo', period: '2026-10-24', collectedAt: '2026-10-24T00:00:00Z', observations: [] });
  await expect(commitTabularImport(context, actor, stale.id)).rejects.toMatchObject({ statusCode: 409 }); context.db.remove('snapshots', 'other');
  const valid = await previewTabularImport(context, actor, { ...input, profile });
  const audit = context.catalogs.recordChange; context.catalogs.recordChange = () => { throw new Error('Synthetic storage failure'); };
  await expect(commitTabularImport(context, actor, valid.id)).rejects.toThrow('Synthetic storage failure'); context.catalogs.recordChange = audit;
  expect(context.db.list('snapshots')).toHaveLength(0); expect(context.db.list('drafts')).toHaveLength(0);
  expect((context.db.get<{ result?: unknown }>('tabular-previews', valid.id))?.result).toBeUndefined();
});
it('requires an explicit global or leader scope for legacy scalar goals and keeps zero as a real fact', async () => {
  const { context, input, catalog } = await fixture(); delete catalog.goals[0].measurement; delete catalog.goals[0].requiredMetricIds; context.db.set('catalog', 'active', catalog);
  const profile: TabularImportProfile = { parser: 'tabular-v1', columns: { value: 'Факт' }, defaults: { period: '2026-10-24', metricId: input.goalId }, leaderMapping: {}, participantMapping: {}, metricMapping: {} };
  const scalar = { ...input, base64: Buffer.from('Факт\n0').toString('base64') };
  expect((await previewTabularImport(context, actor, { ...scalar, profile })).issues.some(i => i.code === 'scalar_scope')).toBe(true);
  const preview = await previewTabularImport(context, actor, { ...scalar, profile: { ...profile, defaults: { ...profile.defaults, leaderId: null } } });
  expect(preview.canCommit).toBe(true); expect(preview.sample[0]).toMatchObject({ leaderId: null, value: 0, state: 'numeric', metricId: input.goalId });
});
it('accepts a manual dashboard export without changing its stub mode or claiming automatic collection', async () => {
  const { context, input, profile, catalog } = await fixture(); catalog.sources[0].kind = 'dashboard'; catalog.sources[0].mode = 'stub'; context.db.set('catalog', 'active', catalog);
  const preview = await previewTabularImport(context, actor, { ...input, profile });
  expect(preview.issues.some(i => i.code === 'manual_dashboard_export')).toBe(true);
  const result = await commitTabularImport(context, actor, preview.id), snapshot = context.db.get<LocalSnapshot>('snapshots', result.snapshotId)!;
  expect(snapshot.origin).toBe('file'); expect(snapshot.limitations.join(' ')).toContain('Ручная выгрузка дашборда');
  expect((await context.catalogs.readForSession(actor)).sources[0].mode).toBe('stub');
});
it('keeps a draft goal and newly created import source private while accepting actual facts', async () => {
  const { context, input, profile, catalog } = await fixture();
  const goal = { ...catalog.goals[0], id: 'draft-goal' }, assignment = { ...catalog.assignments[0], id: 'draft-assignment', goalId: goal.id };
  for (const [kind, object] of [['goal', goal], ['assignment', assignment]] as const) context.db.set('drafts', object.id, { id: object.id, curatorId: actor.curatorId, status: 'local', createdAt: '2026-10-24T00:00:00Z', base: null, change: { kind, id: object.id, baseRevision: null, patch: object }, error: null });
  const preview = await previewTabularImport(context, actor, { ...input, sourceId: undefined, goalId: goal.id, profile });
  const result = await commitTabularImport(context, actor, preview.id); expect(result.duplicate).toBe(false);
  expect((context.db.get<CatalogSnapshot>('catalog', 'active'))?.goals.some(g => g.id === goal.id)).toBe(false);
  expect((context.db.get<CatalogSnapshot>('catalog', 'active'))?.sources.some(s => s.id === preview.sourceId)).toBe(false);
  expect((await context.catalogs.readForSession(actor)).sources.some(s => s.id === preview.sourceId && s.importProfile?.parser === 'tabular-v1')).toBe(true);
});
it('enforces real HTTP reader and CSRF protections and returns malformed file input as a user error', async () => {
  const { catalog, input, profile } = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'uor-tabular-http-')); roots.push(root);
  const { createApp } = await import('../../server/app');
  const app = await createApp({ projectRoot: root, allowedRoots: [root], initialCatalog: catalog, startupCheck: false, registry: [{ id: actor.curatorId, name: actor.name, salt: 'salt', hash: scryptSync('test-only', 'salt', 64).toString('hex') }] });
  try {
    const state = await app.inject('/api/state'), cookie = state.headers['set-cookie']!.toString().split(';')[0], token = state.json().csrfToken;
    expect((await app.inject({ method: 'POST', url: '/api/import/tabular/probe', headers: { cookie, 'x-uor-token': token }, payload: input })).statusCode).toBe(403);
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: { cookie, 'x-uor-token': token }, payload: { role: 'curator', code: 'test-only' } });
    const headers = { cookie: login.headers['set-cookie']!.toString().split(';')[0], 'x-uor-token': token };
    expect((await app.inject({ method: 'POST', url: '/api/import/tabular/probe', headers: { cookie: headers.cookie }, payload: input })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/import/tabular/probe', headers, payload: { ...input, base64: Buffer.from('A,A\nx,y').toString('base64') } })).statusCode).toBe(400);
    const preview = await app.inject({ method: 'POST', url: '/api/import/tabular/preview', headers, payload: { ...input, profile } }); expect(preview.statusCode, preview.body).toBe(200);
    const commit = await app.inject({ method: 'POST', url: '/api/import/tabular/commit', headers, payload: { previewId: preview.json().id } }); expect(commit.statusCode, commit.body).toBe(200);
  } finally { await app.close(); }
});

const leaderMethods: { kind: GoalMeasurement['kind']; value: number; actual: number; aggregation: GoalMeasurement['aggregation']; range?: GoalMeasurement['range']; change?: GoalMeasurement['change'] }[] = [
  { kind: 'scalar', value: 5, actual: 5, aggregation: 'single' },
  { kind: 'binary', value: 1, actual: 1, aggregation: 'single' },
  { kind: 'milestones', value: 1, actual: 100, aggregation: 'average' },
  { kind: 'range', value: 5, actual: 5, aggregation: 'single', range: { min: 4, max: 6 } },
  { kind: 'change', value: 5, actual: 2, aggregation: 'single', change: { mode: 'absolute', baseline: 3 } },
];
it.each(leaderMethods)('imports actual $kind facts after the real setup wizard saves a leader as participant', async method => {
  const { context } = await fixture();
  const measurement: GoalMeasurement = { kind: method.kind, aggregation: method.aggregation, metrics: [{ id: 'new-metric', name: 'Новый показатель', unit: 'шт', target: method.value, direction: 'increase' }], ...(method.range ? { range: method.range } : {}), ...(method.change ? { change: method.change } : {}) };
  const setup = await previewGoalSetup(context, actor, { requestId: `leader-import-${method.kind}`, goal: { title: `Новая ${method.kind}`, category: 'process', officialTarget: method.actual, internalTarget: null, unit: 'шт', direction: 'increase' }, measurement, assignments: [{ leaderId: 'l', participantIds: ['l'] }], source: { kind: 'manual', name: 'Новый ручной источник' }, sample: { period: '2026-10-25', rows: [] } });
  const created = await commitGoalSetup(context, actor, setup.previewId); expect(context.db.list('snapshots')).toHaveLength(0);
  const input = { name: 'new-goal.csv', goalId: created.goalId, sourceId: setup.source.id, base64: Buffer.from(`Участник;Факт\nЛидер;${method.value}`).toString('base64') };
  const probe = await probeTabularImport(context, actor, input);
  expect(probe.options.participants).toContainEqual({ id: 'l', name: 'Лидер' });
  const profile: TabularImportProfile = { ...probe.profile, columns: { participant: 'Участник', value: 'Факт' }, defaults: { period: '2026-10-25', metricId: 'new-metric' } };
  const preview = await previewTabularImport(context, actor, { ...input, profile }); expect(preview.canCommit, JSON.stringify(preview.issues)).toBe(true);
  const result = await commitTabularImport(context, actor, preview.id);
  expect(context.db.get<LocalSnapshot>('snapshots', result.snapshotId)?.observations[0]).toMatchObject({ participantId: 'l', leaderId: 'l', metricId: 'new-metric', value: method.value });
  const state = await context.state(actor);
  expect(state.evaluations.find(e => e.goalId === created.goalId && e.leaderId === null)).toMatchObject({ actual: method.actual, official: 'met', validation: 'pending' });
  expect(state.evaluations.find(e => e.goalId === created.goalId && e.leaderId === 'l')).toMatchObject({ actual: method.actual, official: 'met' });
});
it('requires an explicit participant mapping when two selected leaders have the same name', async () => {
  const { context, catalog, input, profile } = await fixture();
  catalog.leaders = [{ id: 'l', name: 'Одинаковое имя', teams: [] }, { id: 'l2', name: 'Одинаковое имя', teams: [] }];
  catalog.assignments = [{ ...catalog.assignments[0], participantIds: ['l'] }, { id: 'a2', goalId: input.goalId, leaderId: 'l2', teams: [], participantIds: ['l2'] }];
  context.db.set('catalog', 'active', catalog);
  const duplicateName = { ...input, base64: Buffer.from('Участник;Факт\nОдинаковое имя;90').toString('base64'), profile: { ...profile, columns: { participant: 'Участник', value: 'Факт' }, participantMapping: {} } };
  const ambiguous = await previewTabularImport(context, actor, duplicateName);
  expect(ambiguous.canCommit).toBe(false); expect(ambiguous.issues.some(i => i.code === 'participant_mapping')).toBe(true);
  const mapped = await previewTabularImport(context, actor, { ...duplicateName, profile: { ...duplicateName.profile, participantMapping: { 'Одинаковое имя': 'l' } } });
  expect(mapped.canCommit, JSON.stringify(mapped.issues)).toBe(true); expect(mapped.sample[0].participantId).toBe('l');
});
