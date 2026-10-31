import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { clearDeadMaintenanceLock, withMaintenanceLock } from './private-storage';

const roots: string[] = []; const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function rootDir() { const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 'uor-lock-review-')); roots.push(root); return root; }
function worker(root: string, mode: string, deadPid?: number) {
  const child = fork(fileURLToPath(new URL('./lock-test-worker.ts', import.meta.url)), [root, mode, String(deadPid)], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.push(child);
  const messages: Array<{ event: string; code?: string }> = []; const waiters: Array<(value: { event: string; code?: string }) => void> = [];
  child.on('message', message => { const value = message as { event: string }; const waiter = waiters.shift(); if (waiter) waiter(value); else messages.push(value); });
  return { child, next: () => messages.length ? Promise.resolve(messages.shift()!) : new Promise<{ event: string; code?: string }>(resolve => waiters.push(resolve)) };
}
it('two reclaiming processes cannot delete a new live owner lock or enter together', async () => {
  const root = await rootDir(); const dead = fork(fileURLToPath(new URL('./lock-test-worker.ts', import.meta.url)), [root, 'crash-creation'], { execArgv: ['--import', 'tsx'], stdio: 'ignore' });
  const deadPid = dead.pid!; await once(dead, 'exit');
  await writeFile(path.join(root, 'maintenance.lock'), JSON.stringify({ pid: deadPid }));
  const a = worker(root, 'pause-reclaim', deadPid); expect((await a.next()).event).toBe('observed-dead-owner');
  const b = worker(root, 'reclaim'); const bResult = await b.next();
  await writeFile(path.join(root, 'continue-reclaim'), 'go'); const aResult = await a.next();
  // B stays inside its action if it entered. A must not then remove B's lock and enter.
  expect([aResult, bResult].filter(result => result.event === 'entered')).toHaveLength(1);
  const loser = [aResult, bResult].find(result => result.event !== 'entered'); expect(loser).toMatchObject({ event: 'denied', code: 'RECOVERY_REQUIRED' });
  if (aResult.event === 'entered') { a.child.send('release'); expect((await a.next()).event).toBe('done'); }
  if (bResult.event === 'entered') { b.child.send('release'); expect((await b.next()).event).toBe('done'); }
});
it('a process crash between exclusive creation and owner metadata remains recoverable', async () => {
  const root = await rootDir(); const child = worker(root, 'crash-creation'); expect((await once(child.child, 'exit'))[0]).toBe(73);
  await expect(clearDeadMaintenanceLock(root)).resolves.toBeUndefined();
  await expect(withMaintenanceLock(root, async () => 'recovered')).resolves.toBe('recovered');
});
