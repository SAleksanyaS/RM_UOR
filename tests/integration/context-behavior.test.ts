import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type ApplicationContext } from '../../src/server/workspace/context';
import type { CatalogSnapshot, LocalSnapshot } from '../../src/domain/contracts';

const contexts: ApplicationContext[] = []; const roots: string[] = [];
afterEach(async () => { for (const c of contexts.splice(0)) c.db.close(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
function catalog(): CatalogSnapshot {
  return { schemaVersion: 1, id: 'test', name: 'Synthetic catalog', classification: 'demo', importedAt: new Date().toISOString(),
    goals: [{ id: 'g1', title: 'Synthetic goal', category: 'process', target: '100%', metric: 'Share of teams', status: 'active', summary: '', actions: [], scopeType: 'all', links: [], ownerId: null, curatorId: null, officialTarget: 100, internalTarget: null, unit: '%', direction: 'increase', baseline: 0, weight: null, priority: null, dueDate: null, revision: 'base', requiredMetricIds: ['m1', 'm2'] }],
    leaders: ['l1', 'l2'].map(id => ({ id, name: id, teams: [] })), assignments: ['l1', 'l2'].map((id, index) => ({ id, leaderId: id, goalId: 'g1', teams: [], participantIds: [`t${index + 1}`] })),
    sources: [{ id: 'src', name: 'Synthetic file', kind: 'file', url: null, accessUrl: null, goalIds: ['g1'], freshnessHours: 24, mode: 'local' }], comments: [], entities: [] };
}
function snapshot(overrides: Partial<LocalSnapshot> = {}): LocalSnapshot {
  const now = new Date().toISOString(); const period = now.slice(0, 10);
  return { id: 's1', classification: 'demo', sourceId: 'src', period, collectedAt: now, sourceUpdatedAt: now, origin: 'file', dataHash: 'test', status: 'personal', curatorId: null, curatorName: null, validatedAt: null, limitations: [], evidenceIds: [],
    observations: ['t1', 't2'].flatMap((participantId, index) => ['m1', 'm2'].map(metricId => ({ id: `${participantId}:${metricId}`, goalId: 'g1', leaderId: `l${index + 1}`, participantId, participantName: participantId, metricId, metricName: metricId, value: 100, target: 80, unit: '%', state: 'numeric' as const, reason: null, period, sourceId: 'src', sourceUpdatedAt: now, downloadedAt: now }))), ...overrides };
}
async function setup(initialCatalog: CatalogSnapshot | null = catalog(), root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'uor-context-')); if (!roots.includes(root)) roots.push(root);
  const c = await createContext({ projectRoot: root, initialCatalog: initialCatalog ?? undefined, startupCheck: false }); contexts.push(c); return { c, root };
}
it('detects missing teams and missing metrics against the declared cohort', async () => {
  const { c } = await setup(); const reader = await c.roles.enterReader();
  const data = snapshot();
  await c.writeSnapshot({ ...data, observations: data.observations.filter(row => row.participantId === 't1') });
  let result = (await c.state(reader)).evaluations.find(e => e.leaderId === null)!;
  expect(result.official).toBe('unknown'); expect(result.coverage).toBe(50); expect(result.missing).toBe(2);
  await c.writeSnapshot({ ...data, id: 's2', collectedAt: new Date(Date.now() + 1000).toISOString(), observations: data.observations.slice(0, 3) });
  result = (await c.state(reader)).evaluations.find(e => e.leaderId === null)!;
  expect(result.official).toBe('unknown'); expect(result.coverage).toBe(75); expect(result.missing).toBe(1);
});
it('excludes inactive assignments from the global evaluation and fingerprints their scope', async () => {
  const { c } = await setup(); await c.writeSnapshot(snapshot()); const curator = await c.roles.enterReader();
  const before = (await c.state(curator)).evaluations.find(e => e.leaderId === null)!;
  const active = await c.catalogs.read(); active.assignments[1].active = false; c.db.set('catalog', 'active', active);
  const after = (await c.state(curator)).evaluations.find(e => e.leaderId === null)!;
  expect(after.eligibleParticipants).toBe(1); expect(after.fingerprint).not.toBe(before.fingerprint);
});
it('does not present positive dimensional results as confirmable when cohort is unconfigured', async () => {
  const initial = catalog(); delete initial.assignments[0].participantIds;
  const { c } = await setup(initial); await c.writeSnapshot(snapshot());
  const result = (await c.state(await c.roles.enterReader())).evaluations.find(e => e.leaderId === null)!;
  expect(result.official).toBe('unknown'); expect(result.qualityFlags).toContain('unknown_coverage');
});
it('keeps a configured scalar cohort incomplete when one assigned participant is missing', async () => {
  const initial = catalog();
  initial.goals[0].measurement = { kind: 'scalar', aggregation: 'sum', metrics: [{ id: 'g1', name: 'Показатель', target: 100, unit: '%', direction: 'increase' }] };
  initial.goals[0].requiredMetricIds = ['g1'];
  initial.entities = [{ id: 't1', type: 'team', name: 'Команда 1', leaderId: 'l1' }, { id: 't2', type: 'team', name: 'Команда 2', leaderId: 'l2' }];
  const { c } = await setup(initial); const data = snapshot();
  data.observations = [{ ...data.observations[0], metricId: 'g1', value: 110 }];
  await c.writeSnapshot(data);
  const result = (await c.state(await c.roles.enterReader())).evaluations.find(e => e.leaderId === null)!;
  expect(result.official).toBe('unknown'); expect(result.missing).toBe(1); expect(result.coverage).toBe(50);
});
it('loads released per-object content and shared snapshots on a fresh local clone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uor-clone-')); roots.push(root); const base = catalog();
  await mkdir(join(root, 'catalog/goals'), { recursive: true }); await mkdir(join(root, 'published/snapshots/src/shared'), { recursive: true });
  await writeFile(join(root, 'catalog/demo.json'), JSON.stringify(base));
  await writeFile(join(root, 'catalog/goals/g1.json'), JSON.stringify({ ...base.goals[0], title: 'Released title' }));
  const data = snapshot({ id: 'shared', status: 'validated', curatorId: 'curator', curatorName: 'Synthetic curator', validatedAt: new Date().toISOString() });
  const { observations, ...manifest } = data;
  await writeFile(join(root, 'published/snapshots/src/shared/manifest.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'published/snapshots/src/shared/observations.json'), JSON.stringify(observations));
  const { c } = await setup(null, root); const state = await c.state(await c.roles.enterReader());
  expect(state.catalog.goals[0].title).toBe('Released title'); expect(state.snapshots[0].curatorName).toBe('Synthetic curator');
  expect(state.evaluations.find(e => e.leaderId === null)?.official).toBe('met');
});
