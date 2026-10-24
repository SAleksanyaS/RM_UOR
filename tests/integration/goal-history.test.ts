import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Attestation, CatalogSnapshot, LocalSnapshot } from '../../src/domain/contracts';
import { createContext, type ApplicationContext } from '../../src/server/workspace/context';
import { getGoalHistory } from '../../src/features/history/history-service';

const roots: string[] = []; const contexts: ApplicationContext[] = [];
afterEach(async () => { for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function catalog(): CatalogSnapshot {
  return { schemaVersion: 1, id: 'test', name: 'Вымышленная модель', classification: 'demo', importedAt: '2026-10-01T00:00:00Z',
    goals: [{ id: 'g', category: 'process', title: 'Соблюдение инженерных практик', target: '100%', metric: 'Доля команд', status: 'active', summary: '', actions: [], scopeType: 'all', links: [], ownerId: null, curatorId: null, officialTarget: 100, internalTarget: null, unit: '%', direction: 'increase', baseline: 0, weight: null, priority: null, dueDate: null, revision: 'v1', requiredMetricIds: ['m'] }],
    leaders: [{ id: 'l', name: 'Тестовый лидер', teams: [] }], assignments: [{ id: 'a', goalId: 'g', leaderId: 'l', teams: [], participantIds: ['t'] }],
    sources: [{ id: 's', name: 'Вымышленный источник', kind: 'file', goalIds: ['g'], url: null, accessUrl: null, freshnessHours: 168, mode: 'local' }], comments: [], entities: [] };
}
function snapshot(id: string, period: string, value = 100, basis = catalog()): LocalSnapshot {
  const at = `${period}T12:00:00Z`;
  return { id, period, classification: 'demo', sourceId: 's', collectedAt: at, sourceUpdatedAt: at, origin: 'file', dataHash: id, status: 'personal', curatorId: null, curatorName: null, validatedAt: null, limitations: [], evidenceIds: [],
    evaluationBasis: { methodVersion: 'participant-all-applicable-metrics-v1', goal: basis.goals[0], assignments: basis.assignments },
    observations: [{ id: `${id}-r`, goalId: 'g', leaderId: 'l', participantId: 't', participantName: 'Команда', metricId: 'm', metricName: 'Практика', value, target: 80, unit: '%', state: 'numeric', reason: null, period, sourceId: 's', sourceUpdatedAt: at, downloadedAt: at }] };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'uor-history-')); roots.push(root);
  const context = await createContext({ projectRoot: root, initialCatalog: catalog(), startupCheck: false }); contexts.push(context);
  return { context, session: await context.roles.enterReader() };
}
it('returns only real periods and never retires current attestations while reading older facts', async () => {
  const { context, session } = await setup();
  await context.writeSnapshot(snapshot('one', '2026-10-01', 60)); await context.writeSnapshot(snapshot('two', '2026-10-08'));
  const evaluation = context.evaluations(catalog(), context.db.list<LocalSnapshot>('snapshots')).find(item => item.leaderId === null)!;
  const attestation: Attestation = { id: 'ok', goalId: 'g', leaderId: null, fingerprint: evaluation.fingerprint, period: '2026-10-08', curatorId: 'c', curatorName: 'Куратор', confirmedAt: '2026-10-08T13:00:00Z', comment: 'Проверено вручную', evidenceIds: [] };
  context.db.set('attestations', 'ok', attestation);
  const before = context.db.list('last-evaluations');
  const history = await getGoalHistory(context, session, 'g', null);
  expect(history.points.map(point => point.period)).toEqual(['2026-10-01', '2026-10-08']);
  expect(history.points.map(point => point.actual)).toEqual([0, 100]);
  expect(history.points[1].comparableToPrevious).toBe(true);
  expect(history.points[1].historicalConfirmedAt).toBe(attestation.confirmedAt);
  expect(context.db.get('attestations', 'ok')).toEqual(attestation);
  expect(context.db.list('last-evaluations')).toEqual(before);
});
it('does not claim a comparable trend for legacy facts or changed thresholds/cohort', async () => {
  const { context, session } = await setup(); const old = snapshot('old', '2026-10-01'); delete old.evaluationBasis;
  await context.writeSnapshot(old); await context.writeSnapshot(snapshot('next', '2026-10-08'));
  const changed = catalog(); changed.goals[0].officialTarget = 95;
  await context.writeSnapshot(snapshot('changed', '2026-10-16', 100, changed));
  const history = await getGoalHistory(context, session, 'g', 'l');
  expect(history.points[0].qualityFlags).toContain('historical_rules_unknown');
  expect(history.points.every(point => !point.comparableToPrevious)).toBe(true);
  expect(history.points[2].officialTarget).toBe(95);
});
it('selects one revision per period and exposes the changed business facts', async () => {
  const { context, session } = await setup(); const original = snapshot('original', '2026-10-01', 60);
  const edited = snapshot('edited', '2026-10-01', 100); edited.collectedAt = '2026-10-01T14:00:00Z';
  await context.writeSnapshot(original); await context.writeSnapshot(edited);
  const history = await getGoalHistory(context, session, 'g', null);
  expect(history.points).toHaveLength(1); expect(history.points[0].actual).toBe(100);
  expect(history.points[0].snapshotIds).toEqual(['edited']); expect(history.points[0].revisions).toBe(2);
  expect(history.points[0].changes).toEqual({ added: 0, changed: 1, removed: 0 });
});
it('breaks comparability when per-metric thresholds or the expected roster changes', async () => {
  const { context, session } = await setup();
  await context.writeSnapshot(snapshot('one', '2026-10-01'));
  const next = snapshot('two', '2026-10-08'); next.observations[0].target = 90; await context.writeSnapshot(next);
  const changed = catalog(); changed.assignments[0].participantIds = ['t', 'missing'];
  await context.writeSnapshot(snapshot('three', '2026-10-16', 100, changed));
  const history = await getGoalHistory(context, session, 'g', null);
  expect(history.points.every(point => !point.comparableToPrevious)).toBe(true);
  expect(history.points[2].official).toBe('unknown'); expect(history.points[2].coverage).toBe(50);
});
it('does not combine conflicting source methodologies into a historical success', async () => {
  const { context, session } = await setup(); const active = catalog();
  active.sources.push({ ...active.sources[0], id: 'other' }); context.db.set('catalog', 'active', active);
  await context.writeSnapshot(snapshot('one', '2026-10-01'));
  const alternative = snapshot('other', '2026-10-01'); alternative.sourceId = 'other';
  alternative.observations = alternative.observations.map(row => ({ ...row, sourceId: 'other' }));
  alternative.evaluationBasis!.goal.officialTarget = 90;
  await context.writeSnapshot(alternative);
  const history = await getGoalHistory(context, session, 'g', null);
  expect(history.points[0].actual).toBeNull(); expect(history.points[0].official).toBe('unknown');
  expect(history.points[0].qualityFlags).toContain('historical_rules_conflict');
});
