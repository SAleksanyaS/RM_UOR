import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CatalogSnapshot, CuratorSession, Draft } from '../../domain/contracts';
import { createContext, type ApplicationContext } from '../../server/workspace/context';
import { publishChanges, syncPublished } from '../publishing/application-publishing';
import { previewRelease } from '../release/release-service';
import { listWeeklyReports, saveWeeklyBrief } from './service';

const execute = promisify(execFile), roots: string[] = [], contexts: ApplicationContext[] = [];
const curator: CuratorSession = { id: 'synthetic-session', curatorId: 'synthetic-owner', role: 'curator', name: 'Синтетический куратор', createdAt: new Date().toISOString() };
async function git(root: string, ...args: string[]) { return (await execute('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim(); }
afterEach(async () => { for (const context of contexts.splice(0)) context.db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('roundtrips through reviewed release/current, chief main publication and shared catalog refresh without an early reader leak', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uor-weekly-release-')); roots.push(root);
  const remote = join(root, 'remote.git'), seed = join(root, 'seed'), chief = join(root, 'chief');
  const catalog: CatalogSnapshot = { schemaVersion: 1, id: 'synthetic', name: 'Синтетический каталог', classification: 'demo', importedAt: '2026-10-25T12:00:00.000Z', goals: [], leaders: [], assignments: [], sources: [], comments: [], entities: [] };
  await execute('git', ['init', '--bare', '--initial-branch=main', remote], { windowsHide: true });
  await execute('git', ['init', '--initial-branch=main', seed], { windowsHide: true });
  await mkdir(join(seed, 'catalog')); await writeFile(join(seed, 'catalog/demo.json'), JSON.stringify(catalog)); await writeFile(join(seed, '.gitignore'), '.runtime/\n');
  await git(seed, 'add', '.'); await git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Synthetic baseline'); await git(seed, 'remote', 'add', 'origin', remote); await git(seed, 'push', 'origin', 'main');
  const context = await createContext({ projectRoot: seed, initialCatalog: catalog, repositoryUrl: remote, startupCheck: false }); contexts.push(context);
  const reader = await context.roles.enterReader(), saved = await saveWeeklyBrief(context, curator, { weekStart: '2026-10-19', baseRevision: null, summary: 'Недельная сводка для выпуска', completed: ['Проверен план'], attention: [], nextWeek: ['Собрать вопросы'] });
  const preview = await previewRelease(context, curator);
  expect(preview.drafts.some(draft => draft.id === saved.draftId)).toBe(true);
  const operation = await context.operations.start('publish');
  await publishChanges(context, curator, operation.id, [saved.draftId], { previewId: preview.id, snapshotIds: [], attestationIds: [], evidenceIds: [], templateIds: [] });
  expect((await context.operations.get(operation.id)).status).toBe('completed');
  expect(context.db.get<Draft>('drafts', saved.draftId)?.status).toBe('published');
  expect((await listWeeklyReports(context, curator, '2026-10-19')).own?.visibility).toBe('release');
  await syncPublished(context);
  expect((await listWeeklyReports(context, reader, '2026-10-19')).published).toEqual([]);
  await execute('git', ['clone', remote, chief], { windowsHide: true });
  await git(chief, 'fetch', 'origin', 'release/current'); await git(chief, 'merge', '--ff-only', 'origin/release/current'); await git(chief, 'push', 'origin', 'main');
  expect((await listWeeklyReports(context, reader, '2026-10-19')).published).toEqual([]);
  await syncPublished(context);
  const published = (await listWeeklyReports(context, reader, '2026-10-19')).published;
  expect(published).toHaveLength(1); expect(published[0]).toMatchObject({ id: saved.record.id, summary: 'Недельная сводка для выпуска', ownerId: curator.curatorId });
  expect(context.db.get('drafts', saved.draftId)).toBeNull();
  expect(context.db.list('snapshots')).toEqual([]); expect(context.db.list('attestations')).toEqual([]);
}, 90000);
