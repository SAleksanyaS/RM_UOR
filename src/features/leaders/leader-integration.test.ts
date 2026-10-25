import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';
import demo from '../../../catalog/demo.json';
import type { CatalogSnapshot, CuratorSession } from '../../domain/contracts';
import type { createApp } from '../../server/app';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import { publishChanges, syncPublished } from '../publishing/application-publishing';
import { saveLeader } from './leader-service';

const execute = promisify(execFile), roots: string[] = [], contexts: ApplicationContext[] = [], apps: Awaited<ReturnType<typeof createApp>>[] = [];
const actor: CuratorSession = { id: 's', role: 'curator', curatorId: 'curator', name: 'Демо-куратор', createdAt: '2026-10-24T00:00:00Z' };
async function git(root: string, ...args: string[]) { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim(); }
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const c of contexts.splice(0)) c.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('enforces real HTTP role/CSRF checks and accepts curator creation and goal-membership edits', async () => {
  const { createApp } = await import('../../server/app');
  const root = await mkdtemp(join(tmpdir(), 'uor-leader-api-')); roots.push(root);
  const app = await createApp({ projectRoot: root, allowedRoots: [root], initialCatalog: demo as CatalogSnapshot, registry: [{ id: actor.curatorId, name: actor.name, salt: 'salt', hash: scryptSync('test-only', 'salt', 64).toString('hex') }], startupCheck: false }); apps.push(app);
  const state = await app.inject('/api/state'), cookie = state.headers['set-cookie']!.toString().split(';')[0], token = state.json().csrfToken;
  const input = { name: 'Лидер HTTP', clusterName: 'Кластер HTTP', goalIds: [demo.goals[0].id] };
  expect((await app.inject({ method: 'POST', url: '/api/leaders', headers: { cookie, 'x-uor-token': token }, payload: input })).statusCode).toBe(403);
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { cookie, 'x-uor-token': token }, payload: { role: 'curator', code: 'test-only' } });
  const headers = { cookie: login.headers['set-cookie']!.toString().split(';')[0], 'x-uor-token': token };
  expect((await app.inject({ method: 'POST', url: '/api/leaders', headers: { cookie: headers.cookie }, payload: input })).statusCode).toBe(403);
  const created = await app.inject({ method: 'POST', url: '/api/leaders', headers, payload: input });
  expect(created.statusCode, created.body).toBe(200); const result = created.json();
  const edit = await app.inject({ method: 'POST', url: `/api/leaders/${result.leader.id}`, headers, payload: { ...input, baseLeader: result.leader, baseGoalIds: result.goalIds, goalIds: [], clusterName: 'Кластер после изменения' } });
  expect(edit.statusCode, edit.body).toBe(200);
  const current = (await app.inject({ url: '/api/state', headers })).json().catalog;
  expect(current.leaders.find((l: { id: string }) => l.id === result.leader.id).clusterName).toBe('Кластер после изменения');
  expect(current.assignments.find((a: { leaderId: string }) => a.leaderId === result.leader.id).active).toBe(false);
  expect((await app.inject('/api/state')).json().catalog.leaders.some((l: { id: string }) => l.id === result.leader.id)).toBe(false);
});

it('publishes a new leader and assignments as a coherent release to another client and a fresh checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uor-leader-release-')); roots.push(root);
  const remote = join(root, 'remote.git'), seed = join(root, 'seed'), writerRoot = join(root, 'writer'), readerRoot = join(root, 'reader');
  await execute('git', ['init', '--bare', '--initial-branch=main', remote]); await execute('git', ['init', '--initial-branch=main', seed]);
  await mkdir(join(seed, 'catalog'), { recursive: true }); await writeFile(join(seed, 'catalog/demo.json'), JSON.stringify(demo)); await writeFile(join(seed, '.gitignore'), '.runtime/\n');
  await git(seed, 'add', 'catalog', '.gitignore'); await git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Synthetic catalog');
  await git(seed, 'remote', 'add', 'origin', remote); await git(seed, 'push', 'origin', 'main');
  await execute('git', ['clone', '--branch', 'main', remote, writerRoot]); await execute('git', ['clone', '--branch', 'main', remote, readerRoot]);
  const writer = await createContext({ projectRoot: writerRoot, allowedRoots: [root], repositoryUrl: remote, startupCheck: false }), reader = await createContext({ projectRoot: readerRoot, allowedRoots: [root], repositoryUrl: remote, startupCheck: false }); contexts.push(writer, reader);
  const existing = (await writer.catalogs.read()).leaders[0];
  const originalGoals = [...new Set(demo.assignments.filter(a => a.leaderId === existing.id && a.active !== false).map(a => a.goalId))];
  await saveLeader(writer, actor, existing.id, { baseLeader: existing, baseGoalIds: originalGoals, name: 'Переименованный лидер', clusterName: 'Уточнённый кластер', goalIds: originalGoals });
  const saved = await saveLeader(writer, actor, null, { name: 'Новый лидер выпуска', clusterName: 'Новый кластер', goalIds: [demo.goals[0].id] });
  const assignmentDraft = (await writer.catalogs.listDrafts(actor)).find(d => d.change.kind === 'assignment')!;
  const incomplete = await writer.operations.start('publish'); await publishChanges(writer, actor, incomplete.id, [assignmentDraft.id]);
  expect((await writer.operations.get(incomplete.id)).status).toBe('failed');
  expect((await writer.operations.get(incomplete.id)).result?.message).toMatch(/ИТ-лидер/);
  const operation = await writer.operations.start('publish'); await publishChanges(writer, actor, operation.id);
  const outcome = await writer.operations.get(operation.id); expect(outcome.status, outcome.result?.message).toBe('completed');
  expect((await reader.catalogs.read()).leaders.some(l => l.id === saved.leader.id)).toBe(false);
  await git(seed, 'fetch', 'origin'); await git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'merge', '--no-ff', 'origin/release/current', '-m', 'Release leaders'); await git(seed, 'push', 'origin', 'main');
  await syncPublished(reader); const released = await reader.catalogs.read();
  expect(released.leaders.find(l => l.id === saved.leader.id)).toEqual(saved.leader);
  expect(released.leaders.find(l => l.id === existing.id)).toMatchObject({ name: 'Переименованный лидер', clusterName: 'Уточнённый кластер' });
  expect(released.assignments.find(a => a.leaderId === saved.leader.id)).toMatchObject({ goalId: demo.goals[0].id, teams: [], active: true });
  expect(released.entities).toEqual(demo.entities);
  const fresh = await createContext({ projectRoot: seed, allowedRoots: [root], repositoryUrl: remote, startupCheck: false }); contexts.push(fresh);
  expect((await fresh.catalogs.read()).leaders.find(l => l.id === saved.leader.id)).toEqual(saved.leader);
  expect((await fresh.catalogs.read()).assignments.find(a => a.leaderId === saved.leader.id)).not.toHaveProperty('participantIds');
}, 90000);
