import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir,hostname } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { profileLockedByLiveProcess, releaseStaleProfileLocks } from './workbench-browser-profile-locks';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function profile(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'uor-lock-test-'));
  roots.push(root);
  const folder = path.join(root, 'model_zrelosti');
  await mkdir(folder, { recursive: true });
  return folder;
}

it('removes a lock left by a killed browser so the login window can open again', async () => {
  const folder = await profile();
  // PID 2^22 is far outside any reachable pid namespace on a test host.
  await writeFile(path.join(folder,'.uor-browser-lease.json'),JSON.stringify({schemaVersion:1,host:hostname(),pid:4194304,profilePath:folder,token:'abandoned-test-instance'}));
  await symlink(`${hostname()}-4194304`, path.join(folder, 'SingletonLock'));
  await symlink('/tmp/org.chromium.Chromium.abcdef/SingletonSocket', path.join(folder, 'SingletonSocket'));

  expect(await profileLockedByLiveProcess(folder)).toBeNull();
  const released = await releaseStaleProfileLocks(folder);

  expect(released.sort()).toEqual(['SingletonCookie', 'SingletonLock', 'SingletonSocket'].filter(name => released.includes(name)).sort());
  expect(released).toContain('SingletonLock');
  await expect(readFile(path.join(folder, 'SingletonLock'))).rejects.toThrow();
});

it('keeps the lock of a live browser and never disturbs an unsymlinked file', async () => {
  const folder = await profile();
  await symlink(`some-host-${process.pid}`, path.join(folder, 'SingletonLock'));
  await writeFile(path.join(folder, 'SingletonCookie'), 'not-a-link');

  expect(await profileLockedByLiveProcess(folder)).toBe(process.pid);
  const released = await releaseStaleProfileLocks(folder);

  expect(released).not.toContain('SingletonLock');
  expect(await readFile(path.join(folder, 'SingletonLock'), 'utf8').catch(() => null)).toBeNull();
  expect((await import('node:fs/promises')).readlink(path.join(folder, 'SingletonLock')).catch(() => 'gone')).toBeDefined();
});

it('preserves the whole live or foreign-host lock set and never signals a matching process',async()=>{
 const folder=await profile();await symlink(`foreign-host-${process.pid}`,path.join(folder,'SingletonLock'));await symlink('malformed',path.join(folder,'SingletonCookie'));await symlink('/tmp/unknown/SingletonSocket',path.join(folder,'SingletonSocket'));
 expect(await releaseStaleProfileLocks(folder)).toEqual([]);
 const {terminateProfileProcesses}=await import('./workbench-browser-profile-locks');expect(await terminateProfileProcesses(folder)).toEqual([]);
 expect(await (await import('node:fs/promises')).readlink(path.join(folder,'SingletonCookie'))).toBe('malformed');
});
