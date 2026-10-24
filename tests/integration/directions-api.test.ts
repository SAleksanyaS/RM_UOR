import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import demo from '../../catalog/demo.json';
import type { CatalogSnapshot } from '../../src/domain/contracts';
import { createApp } from '../../src/server/app';
import { createContext, type ApplicationContext } from '../../src/server/workspace/context';
import { getDirections } from '../../src/features/catalog/directions';
const apps: Awaited<ReturnType<typeof createApp>>[] = [], contexts: ApplicationContext[] = [], roots: string[] = [];
const catalog = demo as CatalogSnapshot;
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(root?: string) {
  root ??= await mkdtemp(join(tmpdir(), 'uor-directions-')); if (!roots.includes(root)) roots.push(root);
  const app = await createApp({ projectRoot: root, allowedRoots: [root], initialCatalog: catalog, registry: [{ id: 'demo-curator', name: 'Куратор демо', salt: 'demo-salt', hash: scryptSync('fixture-pass', 'demo-salt', 64).toString('hex') }], startupCheck: false });
  apps.push(app); const state = await app.inject('/api/state');
  const cookie = state.headers['set-cookie']!.toString().split(';')[0], token = state.json().csrfToken;
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { cookie, 'x-uor-token': token }, payload: { role: 'curator', code: 'fixture-pass' } });
  return { root, app, reader: { cookie, 'x-uor-token': token }, headers: { cookie: login.headers['set-cookie']!.toString().split(';')[0], 'x-uor-token': token } };
}
it('denies reader direction mutations and exposes the six-direction legacy view', async () => {
  const f = await setup();
  expect((await f.app.inject('/api/state')).json().catalog.directions).toHaveLength(6);
  expect((await f.app.inject({ method: 'POST', url: '/api/directions', headers: f.reader, payload: { name: 'Forbidden' } })).statusCode).toBe(403);
  expect((await f.app.inject({ method: 'POST', url: '/api/directions/architecture', headers: f.reader, payload: { name: 'Forbidden' } })).statusCode).toBe(403);
});
it('saves curator direction settings and a valid goal association durably without changing reader data', async () => {
  const f = await setup();
  const added = await f.app.inject({ method: 'POST', url: '/api/directions', headers: f.headers, payload: { name: 'Пилот', description: 'Настройка куратора', color: '#123456', order: 7 } });
  expect(added.statusCode).toBe(200);
  const directionId = added.json().draft.change.id;
  expect((await f.app.inject({ method: 'POST', url: `/api/directions/${directionId}`, headers: f.headers, payload: { name: 'Пилот обновлён' } })).statusCode).toBe(200);
  expect((await f.app.inject({ method: 'POST', url: `/api/goals/${catalog.goals[0].id}`, headers: f.headers, payload: { workDirectionId: 'missing' } })).statusCode).toBe(400);
  expect((await f.app.inject({ method: 'POST', url: `/api/goals/${catalog.goals[0].id}`, headers: f.headers, payload: { workDirectionId: directionId } })).statusCode).toBe(200);
  const edited = (await f.app.inject({ url: '/api/state', headers: f.headers })).json();
  expect(edited.catalog.goals[0].workDirectionId).toBe(directionId);
  expect(edited.catalog.directions.find((d: { id: string }) => d.id === directionId).name).toBe('Пилот обновлён');
  expect((await f.app.inject('/api/state')).json().catalog.directions).toHaveLength(6);
  await f.app.close(); apps.splice(apps.indexOf(f.app), 1);
  const reopened = await setup(f.root);
  const restored = (await reopened.app.inject({ url: '/api/state', headers: reopened.headers })).json();
  expect(restored.catalog.goals[0].workDirectionId).toBe(directionId);
  expect(restored.catalog.directions).toHaveLength(7);
});
it('normalizes persisted legacy state without changing its import hash or deleting local sources/custom directions on reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uor-direction-upgrade-')); roots.push(root);
  await mkdir(join(root, 'catalog'), { recursive: true });
  await writeFile(join(root, 'catalog/demo.json'), JSON.stringify(catalog));
  const context = await createContext({ projectRoot: root, allowedRoots: [root] }); contexts.push(context);
  const oldHash = context.db.get<string>('settings', 'importHash');
  const active = { ...catalog, directions: [{ id: 'custom', name: 'Свое', description: '', color: '#123456', order: 1 }], goals: catalog.goals.map(goal => ({ ...goal, workDirectionId: 'custom' })),
    sources: [...catalog.sources, { id: 'manual-local', name: 'Локальный', kind: 'manual' as const, url: null, accessUrl: null, goalIds: [catalog.goals[0].id], freshnessHours: 168, mode: 'local' as const }] };
  context.db.set('settings', 'importHash', oldHash); context.db.set('catalog', 'active', active);
  context.db.close(); contexts.splice(contexts.indexOf(context), 1);
  const reopened = await createContext({ projectRoot: root, allowedRoots: [root] }); contexts.push(reopened);
  expect(reopened.db.get('settings', 'importHash')).toBe(oldHash);
  expect((await reopened.catalogs.read()).sources.some(source => source.id === 'manual-local')).toBe(true);
  expect((await reopened.catalogs.read()).directions?.map(d => d.id)).toEqual(['custom']);
});
it('keeps legacy goal mapping in a fresh checkout containing only a renamed default direction file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uor-direction-clone-')); roots.push(root);
  await mkdir(join(root, 'catalog/directions'), { recursive: true });
  await writeFile(join(root, 'catalog/demo.json'), JSON.stringify(catalog));
  const architecture = getDirections(catalog).find(direction => direction.id === 'architecture')!;
  await writeFile(join(root, 'catalog/directions/architecture.json'), JSON.stringify({ ...architecture, name: 'Архитектура обновлённая' }));
  const context = await createContext({ projectRoot: root, allowedRoots: [root] }); contexts.push(context);
  const result = await context.catalogs.read();
  expect(result.directions?.find(direction => direction.id === 'architecture')?.name).toBe('Архитектура обновлённая');
  expect(result.goals.find(goal => goal.category === 'process')?.workDirectionId).toBe('production');
});
