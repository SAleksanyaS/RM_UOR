import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace, safeArtifactPath } from '../../src/server/workspace/paths';
import { LocalDatabase } from '../../src/server/storage/database';
import { OperationStore } from '../../src/server/operations/operation-store';

const dirs: string[] = [];
const databases: LocalDatabase[] = [];
afterEach(async () => { databases.splice(0).forEach(db => db.close()); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'uor-test-')); dirs.push(root); return root; }

describe('approved workspace and durable operations', () => {
  it('rejects traversal and resolved junction outside approved root', async () => {
    const root = await fixture(); const approved = join(root, 'approved'); const outside = join(root, 'outside');
    await mkdir(approved); await mkdir(outside);
    await expect(safeArtifactPath(approved, '../outside/key')).rejects.toThrow();
    await symlink(outside, join(approved, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(safeArtifactPath(approved, 'linked/private.json')).rejects.toThrow();
  });
  it('accepts approved paths with spaces and Cyrillic but rejects another workspace', async () => {
    const root = await fixture(); const project = join(root, 'Рабочее место УОР'); await mkdir(project);
    const paths = await resolveWorkspace({ projectRoot: project, allowedRoots: [root] });
    expect(paths.projectRoot).toBe(project); expect(paths.runtimeRoot).toBe(join(project, '.runtime'));
    await expect(resolveWorkspace({ projectRoot: root, allowedRoots: [project] })).rejects.toThrow();
  });
  it('keeps stage times after reopening storage and marks interrupted work on restart', async () => {
    const root = await fixture(); const file = join(root, 'test.db');
    let now = new Date('2026-10-24T09:00:00Z');
    const first = new LocalDatabase(file); const store = new OperationStore(first, () => now);
    const op = await store.start('update', 'Обновление');
    now = new Date('2026-10-24T09:00:03Z'); await store.stage(op.id, { key: 'normalize', label: 'Обработка' });
    first.close();
    const second = new LocalDatabase(file); databases.push(second); const reopened = new OperationStore(second, () => now);
    expect((await reopened.get(op.id)).stageStartedAt).toBe('2026-10-24T09:00:03.000Z');
    now = new Date('2026-10-24T09:00:10Z'); await reopened.recoverInterrupted();
    const recovered = await reopened.get(op.id);
    expect(recovered.status).toBe('interrupted'); expect(recovered.startedAt).toBe('2026-10-24T09:00:00.000Z');
    expect(recovered.finishedAt).toBe('2026-10-24T09:00:10.000Z');
  });
});
