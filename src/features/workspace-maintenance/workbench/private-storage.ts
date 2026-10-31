import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertPhysicalPath } from '../../../server/workbench/files';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { physicalArtifactPath } from '../safe-path';

export async function ensurePhysicalDirectory(directory: string): Promise<void> {
  let ancestor = path.resolve(directory);
  for (;;) { try { await assertPhysicalPath(ancestor, true); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; const parent = path.dirname(ancestor); if (parent === ancestor) throw e; ancestor = parent; } }
  await mkdir(directory, { recursive: true, mode: 0o700 }); await assertPhysicalPath(directory, true);
}
export async function privatePath(root: string, relative: string): Promise<string> { await ensurePhysicalDirectory(root); return physicalArtifactPath(root, relative); }
export async function durableWrite(root: string, relative: string, bytes: Uint8Array | string): Promise<void> {
  const target = await privatePath(root, relative); await ensurePhysicalDirectory(path.dirname(target));
  const temporary = await privatePath(root, relative + '.pending-' + randomUUID()); const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await physicalArtifactPath(root, relative); await rename(temporary, target); } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  // Windows does not expose directory fsync; individual files are flushed before atomic rename.
  let directory; try { directory = await open(path.dirname(target), constants.O_RDONLY); await directory.sync(); } catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EISDIR', 'EINVAL'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; } finally { await directory?.close(); }
}
export async function readPrivate(root: string, relative: string, max = 64 * 1024 ** 2): Promise<Buffer> {
  const target = await privatePath(root, relative); await assertPhysicalPath(target, false); const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const s = await handle.stat(); if (!s.isFile() || s.nlink !== 1 || s.size > max) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Stored maintenance artifact is invalid'); const bytes = await handle.readFile(); if (bytes.length !== s.size) throw Error('Read changed'); return bytes; } finally { await handle.close(); }
}
export async function optionalPrivate(root: string, relative: string, max?: number): Promise<Buffer | null> { try { return await readPrivate(root, relative, max); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
const tails = new Map<string, Promise<unknown>>();
// Shared by all services/direct archive entrypoints in this runtime. Persistence may fail.
const recoveryLatches = new Set<string>();
const recoveryKey = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
export function latchRecoveryRequired(root: string): void { recoveryLatches.add(recoveryKey(root)); }
export function isRecoveryRequired(root: string): boolean { return recoveryLatches.has(recoveryKey(root)); }
/** Only successful explicit startup recovery may clear the runtime latch. */
export function clearRecoveryRequired(root: string): void { recoveryLatches.delete(recoveryKey(root)); }
const lockBusy = () => new WorkbenchHttpError(409, 'RECOVERY_REQUIRED', 'Maintenance is active or requires startup recovery');
/** This file is permanent: never unlink/rename it. SQLite owns the OS lock, including on crash.
 * Every metadata read/reclaim/create/release runs under the same exclusive writer reservation.
 * PID metadata is diagnostic/startup state, not the mutual-exclusion primitive.
 */
async function withProcessMutex<T>(root: string, action: () => Promise<T>): Promise<T> {
  const database = new DatabaseSync(await privatePath(root, 'maintenance-mutex.sqlite'));
  let locked = false;
  try {
    try { database.exec('BEGIN IMMEDIATE'); locked = true; }
    catch (error) { if ([5, 6].includes((error as { errcode?: number }).errcode ?? -1)) throw lockBusy(); throw error; }
    return await action();
  } finally { try { if (locked) database.exec('ROLLBACK'); } finally { database.close(); } }
}
/** In-process queue plus a crash-released OS mutex shared with startup reclamation. */
export async function withMaintenanceLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(root); const prior = tails.get(key) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(() => withProcessMutex(root, async () => {
    if (await optionalPrivate(root, 'maintenance.lock', 200)) throw lockBusy();
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
    await durableWrite(root, 'maintenance.lock', owner);
    try { return await action(); }
    finally {
      // The OS mutex prevents another cooperating owner appearing between this check and unlink.
      if ((await optionalPrivate(root, 'maintenance.lock', 200))?.toString() !== owner) throw lockBusy();
      await unlink(await privatePath(root, 'maintenance.lock'));
    }
  })); tails.set(key, run); try { return await run; } finally { if (tails.get(key) === run) tails.delete(key); }
}
export async function clearDeadMaintenanceLock(root: string): Promise<void> {
  return withProcessMutex(root, async () => {
    const bytes = await optionalPrivate(root, 'maintenance.lock', 200); if (!bytes) return;
    // Empty creation left by a crashed old writer has no live OS mutex owner.
    if (!bytes.length) { await unlink(await privatePath(root, 'maintenance.lock')); return; }
    const parsed = JSON.parse(bytes.toString()) as { pid: number }; if (!Number.isSafeInteger(parsed.pid) || parsed.pid < 1) throw Error('Invalid maintenance lock');
    try { process.kill(parsed.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(await privatePath(root, 'maintenance.lock')); return; } throw e; }
    throw lockBusy();
  });
}
export async function assertOwnedWorkspaceRoot(managedRoot: string, target: string): Promise<void> {
  await assertPhysicalPath(managedRoot, true); const relative = path.relative(path.resolve(managedRoot), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length !== 1) throw new WorkbenchHttpError(422, 'INTEGRITY_MISMATCH', 'Workspace activation path is outside its owned root');
  await assertPhysicalPath(target, true); const info = await lstat(target); if (!info.isDirectory()) throw Error('Invalid workspace directory');
}
