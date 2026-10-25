import { afterEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, scryptSync } from 'node:crypto';
import type { Attestation, CatalogSnapshot, CuratorSession, LocalSnapshot, Observation } from '../../src/domain/contracts';
import { createContext, type ApplicationContext } from '../../src/server/workspace/context';
import { createApp } from '../../src/server/app';
import { previewMaturityImport, commitMaturityImport } from '../../src/features/importing/import-service';

const roots: string[] = [], contexts: ApplicationContext[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [];
const period = new Date().toISOString().slice(0, 10), at = new Date().toISOString();
const session: CuratorSession = { id: 'session-one', role: 'curator', curatorId: 'curator-one', name: 'Куратор примера', createdAt: at };
function catalog(withSource = true): CatalogSnapshot {
  return { schemaVersion: 1, id: 'maturity-import-demo', name: 'Синтетическая модель', classification: 'demo', importedAt: at,
    goals: [{ id: 'maturity', title: 'Модель примера', category: 'process', target: '100%', metric: 'Доля команд', status: '', summary: '', actions: [], scopeType: 'team', links: [], ownerId: null, curatorId: null,
      officialTarget: 100, internalTarget: 100, unit: '%', direction: 'increase', baseline: 0, weight: null, priority: null, dueDate: null, revision: 'one', requiredMetricIds: ['metric-a', 'metric-b'] }],
    leaders: [{ id: 'leader-one', name: 'Лидер примера', teams: ['Команда А', 'Команда Б'] }],
    assignments: [{ id: 'assignment-one', goalId: 'maturity', leaderId: 'leader-one', teams: [], participantIds: ['team-a', 'team-b'] }],
    entities: [{ id: 'team-a', type: 'team', name: 'Команда А', leaderId: 'leader-one', aliases: ['Альфа'] }, { id: 'team-b', type: 'team', name: 'Команда Б', leaderId: 'leader-one' }],
    sources: withSource ? [{ id: 'file-one', name: 'Файл модели', kind: 'file', url: null, accessUrl: null, goalIds: ['maturity'], freshnessHours: 100000, mode: 'local' }] : [], comments: [] };
}
function rows(value = 90) { return [['team-a', 'Команда А', 'Практика А', value, 80], ['team-a', 'Команда А', 'Практика Б', 90, 80], ['team-b', 'Команда Б', 'Практика А', 90, 80], ['team-b', 'Команда Б', 'Практика Б', 90, 80]]; }
async function input(values = rows(), extra: Record<string, unknown> = {}) {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Модель');
  sheet.addRow(['Код команды', 'Команда', 'Метрика', 'Значение метрики', 'Цель метрики']);
  for (const row of values) sheet.addRow(row);
  return { name: 'synthetic-maturity.xlsx', base64: Buffer.from(await book.xlsx.writeBuffer()).toString('base64'), goalId: 'maturity', period, sourceUpdatedAt: at, ...extra };
}
function observations(): Observation[] {
  return rows().map(([code, name, metric, value, target], index) => ({ id: `old-${index}`, goalId: 'maturity', leaderId: 'leader-one', participantId: String(code), participantName: String(name),
    metricId: metric === 'Практика А' ? 'metric-a' : 'metric-b', metricName: String(metric), value: Number(value), target: Number(target), unit: '%', state: 'numeric', reason: null,
    period, sourceId: 'file-one', sourceUpdatedAt: at, downloadedAt: at }));
}
async function setup(withSource = true) {
  const root = await mkdtemp(join(tmpdir(), 'uor-maturity-import-')); roots.push(root);
  const context = await createContext({ projectRoot: root, allowedRoots: [root], initialCatalog: catalog(withSource) }); contexts.push(context);
  const snapshot: LocalSnapshot = { id: 'baseline', classification: 'demo', sourceId: 'file-one', period, observations: observations(), collectedAt: at, sourceUpdatedAt: at,
    origin: 'file', dataHash: 'intentionally-untrusted-old-hash', status: 'personal', curatorId: null, curatorName: null, validatedAt: null, limitations: [], evidenceIds: [] };
  if (withSource) context.db.set('snapshots', snapshot.id, snapshot);
  return { context, root, snapshot };
}
afterEach(async () => { vi.restoreAllMocks(); for (const app of apps.splice(0)) await app.close(); for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('maturity import', () => {
  it('previews changed facts without touching current snapshots or attestations', async () => {
    const { context } = await setup();
    context.db.set('attestations', 'saved', { id: 'saved', invalidatedAt: null, fingerprint: 'old' });
    const before = context.db.list('snapshots'); const attestations = context.db.list('attestations');
    const preview = await previewMaturityImport(context, session, await input(rows(10)));
    expect(preview.canCommit).toBe(true); expect(preview.evaluation?.official).toBe('not_met'); expect(preview.changes.changed).toBe(1);
    expect(context.db.list('snapshots')).toEqual(before); expect(context.db.list('attestations')).toEqual(attestations);
    expect(preview.teamMatches.every(match => match.status === 'matched')).toBe(true);
  });

  it('blocks unknown mappings, accepts explicit choices, and shows missing coverage without inventing success', async () => {
    const { context } = await setup();
    const values = [['', 'Неизвестная команда', 'Неизвестная практика', 90, 80]];
    const preview = await previewMaturityImport(context, session, await input(values));
    expect(preview.canCommit).toBe(false); expect(preview.summary.unmappedTeams).toBe(1); expect(preview.summary.unmappedMetrics).toBe(1);
    expect(preview.teamMatches[0].options.some(option => option.name.includes('Команда А'))).toBe(true);
    const fixed = await previewMaturityImport(context, session, await input(values, { teamMapping: { [preview.teamMatches[0].key]: 'team-a' }, metricMapping: { [preview.metricMatches[0].key]: 'metric-a' } }));
    expect(fixed.canCommit).toBe(true); expect(fixed.evaluation?.official).toBe('unknown'); expect(fixed.summary.missing).toBeGreaterThan(0);
    expect(fixed.issues.some(issue => issue.code === 'missing_expected_facts')).toBe(true);
  });

  it('deduplicates canonically identical business facts and preserves a current confirmation', async () => {
    const { context } = await setup();
    const current = (await context.state(session)).evaluations.find(evaluation => evaluation.leaderId === null)!;
    const attestation: Attestation = { id: 'confirmed', goalId: 'maturity', leaderId: null, fingerprint: current.fingerprint, period, curatorId: session.curatorId, curatorName: session.name,
      confirmedAt: at, comment: 'Проверено на синтетическом наборе', evidenceIds: [] };
    context.db.set('attestations', attestation.id, attestation);
    const preview = await previewMaturityImport(context, session, await input([...rows()].reverse()));
    expect(preview.duplicateSnapshotId).toBe('baseline');
    const result = await commitMaturityImport(context, session, preview.id);
    expect(result.duplicate).toBe(true); expect(result.snapshotId).toBe('baseline'); expect(context.db.list('snapshots')).toHaveLength(1);
    expect(context.db.get<Attestation>('attestations', 'confirmed')?.invalidatedAt).toBeFalsy();
    expect(context.db.get<CatalogSnapshot>('catalog', 'active')?.sources[0].importProfile?.parser).toBe('maturity-xlsx-v1');
  });

  it('commits an immutable changed revision and revokes a previous positive confirmation', async () => {
    const { context } = await setup();
    const current = (await context.state(session)).evaluations.find(evaluation => evaluation.leaderId === null)!;
    context.db.set('attestations', 'confirmed', { id: 'confirmed', goalId: 'maturity', leaderId: null, fingerprint: current.fingerprint, period, curatorId: session.curatorId,
      curatorName: session.name, confirmedAt: at, comment: 'Проверено', evidenceIds: [] });
    const preview = await previewMaturityImport(context, session, await input(rows(10)));
    const result = await commitMaturityImport(context, session, preview.id);
    expect(result.duplicate).toBe(false); expect(context.db.list('snapshots')).toHaveLength(2);
    expect(context.db.get<LocalSnapshot>('snapshots', 'baseline')?.observations[0].value).toBe(90);
    expect(context.db.get<Attestation>('attestations', 'confirmed')?.invalidatedAt).toBeTruthy();
    expect(context.db.get<LocalSnapshot>('snapshots', result.snapshotId)?.evaluationBasis?.goal.id).toBe('maturity');
    expect((await commitMaturityImport(context, session, preview.id)).snapshotId).toBe(result.snapshotId);
  });

  it('rejects another curator, expired previews and a changed source baseline without replacing current facts', async () => {
    const { context, snapshot } = await setup(); const preview = await previewMaturityImport(context, session, await input(rows(10)));
    await expect(commitMaturityImport(context, { ...session, curatorId: 'another' }, preview.id)).rejects.toMatchObject({ statusCode: 403 });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
    await expect(commitMaturityImport(context, session, preview.id)).rejects.toMatchObject({ statusCode: 410 }); clock.mockRestore();
    context.db.set('snapshots', 'other-revision', { ...snapshot, id: 'other-revision', observations: [{ ...snapshot.observations[0], value: 5 }], collectedAt: new Date(Date.now() + 1).toISOString() });
    await expect(commitMaturityImport(context, session, preview.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(context.db.list('snapshots')).toHaveLength(2);
  });

  it('rejects changed methodology after preview and creates a needed file source atomically', async () => {
    const { context } = await setup(); const preview = await previewMaturityImport(context, session, await input());
    await context.catalogs.saveDraft(session, { kind: 'goal', id: 'maturity', baseRevision: 'one', patch: { officialTarget: 95 } });
    await expect(commitMaturityImport(context, session, preview.id)).rejects.toMatchObject({ statusCode: 409 }); expect(context.db.list('snapshots')).toHaveLength(1);
    const empty = await setup(false);
    const incoming = await previewMaturityImport(empty.context, session, await input(rows(), { metricMapping: { 'Практика А': 'metric-a', 'Практика Б': 'metric-b' }, sourceUpdatedAt: null }));
    expect(incoming.canCommit).toBe(true); expect(incoming.issues.some(issue => issue.code === 'source_date_unknown')).toBe(true);
    const accepted = await commitMaturityImport(empty.context, session, incoming.id);
    const source = (await empty.context.catalogs.read()).sources.find(item => item.id === incoming.sourceId);
    expect(source?.kind).toBe('file'); expect(empty.context.db.get<LocalSnapshot>('snapshots', accepted.snapshotId)?.sourceUpdatedAt).toBeNull();
    expect((await empty.context.catalogs.listDrafts(session)).some(draft => draft.change.kind === 'source')).toBe(true);
  });

  it('keeps the original preview baseline when source data arrives at an awaited stage', async () => {
    const { context, snapshot } = await setup();
    const original = context.operations.stage.bind(context.operations); let changed = false;
    vi.spyOn(context.operations, 'stage').mockImplementation(async (id, stage) => {
      await original(id, stage);
      if (stage.key === 'match' && !changed) {
        changed = true; context.db.set('snapshots', 'parallel-revision', { ...snapshot, id: 'parallel-revision', collectedAt: new Date(Date.now() + 1).toISOString() });
      }
    });
    const preview = await previewMaturityImport(context, session, await input(rows(10)));
    await expect(commitMaturityImport(context, session, preview.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(context.db.list('snapshots')).toHaveLength(2);
  });

  it('blocks an unowned team assigned to more than one active leader', async () => {
    const { context } = await setup(); const active = await context.catalogs.read();
    active.leaders.push({ id: 'second-leader', name: 'Второй лидер', teams: [] });
    active.assignments.push({ id: 'other-assignment', goalId: 'maturity', leaderId: 'second-leader', teams: [], participantIds: ['team-a'] });
    active.entities.find(entity => entity.id === 'team-a')!.leaderId = null; context.db.set('catalog', 'active', active);
    const preview = await previewMaturityImport(context, session, await input());
    expect(preview.canCommit).toBe(false); expect(preview.issues.some(issue => issue.code === 'ambiguous_team_assignment')).toBe(true);
  });

  it('enforces curator role and the existing CSRF boundary on preview/commit HTTP routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uor-import-api-')); roots.push(root);
    const app = await createApp({ projectRoot: root, allowedRoots: [root], initialCatalog: catalog(), registry: [{ id: 'curator-one', name: 'Куратор', salt: 'fixture', hash: scryptSync('fixture-pass', 'fixture', 64).toString('hex') }], startupCheck: false }); apps.push(app);
    const initial = await app.inject('/api/state'); const cookie = initial.headers['set-cookie']!.toString().split(';')[0], token = initial.json().csrfToken;
    expect((await app.inject({ method: 'POST', url: '/api/import/maturity/preview', headers: { cookie, 'x-uor-token': token }, payload: await input() })).statusCode).toBe(403);
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: { cookie, 'x-uor-token': token }, payload: { role: 'curator', code: 'fixture-pass' } });
    const auth = login.headers['set-cookie']!.toString().split(';')[0];
    expect((await app.inject({ method: 'POST', url: '/api/import/maturity/preview', headers: { cookie: auth }, payload: await input() })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/import/maturity/commit', headers: { cookie: auth, 'x-uor-token': token }, payload: { previewId: randomUUID() } })).statusCode).toBe(404);
    const preview = await app.inject({ method: 'POST', url: '/api/import/maturity/preview', headers: { cookie: auth, 'x-uor-token': token },
      payload: await input(rows(), { metricMapping: { 'Практика А': 'metric-a', 'Практика Б': 'metric-b' } }) });
    expect(preview.statusCode).toBe(200); expect(preview.json().canCommit).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/import/maturity/commit', headers: { cookie: auth, 'x-uor-token': token }, payload: { previewId: preview.json().id } })).statusCode).toBe(200);
    const history = await app.inject({ url: '/api/goals/maturity/history?leaderId=leader-one', headers: { cookie: auth } });
    expect(history.statusCode).toBe(200); expect(history.json().points).toHaveLength(1); expect(history.json().points[0].actual).toBe(100);
  });
});
