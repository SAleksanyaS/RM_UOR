import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { expect, it } from 'vitest';

function runOwnedLoader(options: { args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; started?(child: ChildProcess): void } = {}) {
  return new Promise<{code: number | null; signal: NodeJS.Signals | null; text: string; timedOut: boolean}>((resolve, reject) => {
    // Node --test may own a test worker, which in turn owns a browser process.
    const child = spawn(process.execPath, options.args ?? ['--import', 'tsx', '--test', path.resolve('tests/fixtures/workbench/oko-loader-regression.ts')], { windowsHide: true, detached: process.platform !== 'win32', env: options.env ?? process.env });
    options.started?.(child);
    let text = '', timedOut = false, force: NodeJS.Timeout | undefined;
    const stopOwned = (signal: 'SIGTERM' | 'SIGKILL') => {
      if (!child.pid) return;
      if (process.platform === 'win32') { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); return; }
      try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const timeout = setTimeout(() => {
      timedOut = true; stopOwned('SIGTERM');
      force = setTimeout(() => stopOwned('SIGKILL'), 750);
    }, options.timeoutMs ?? 45000);
    const cleanup = () => { clearTimeout(timeout); if (force) clearTimeout(force); };
    child.stdout.on('data', data => { text += data; }); child.stderr.on('data', data => { text += data; });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); resolve({ code, signal, text, timedOut }); });
  });
}

it('bounded wrapper timeout closes its owned child and listener even when the child ignores termination', async () => {
  let child: ChildProcess | undefined, guard: NodeJS.Timeout | undefined;
  try {
    const output = await Promise.race([
      runOwnedLoader({ timeoutMs: 250, started: value => { child = value; }, args: ['-e', `const server = require('node:http').createServer((_req,res) => res.end('synthetic')); process.on('SIGTERM', () => {}); server.listen(0,'127.0.0.1',()=>console.log('OWNED_PORT='+server.address().port));`] }),
      new Promise<never>((_resolve, reject) => { guard = setTimeout(() => reject(Error('Wrapper did not finish its owned child within its timeout')), 2500); }),
    ]);
    expect(output.timedOut).toBe(true); expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    const port = Number(/OWNED_PORT=(\d+)/.exec(output.text)?.[1]); expect(port).toBeGreaterThan(0);
    const rebound = createServer();
    await new Promise<void>((resolve, reject) => { rebound.once('error', reject); rebound.listen(port, '127.0.0.1', resolve); });
    await new Promise<void>(resolve => rebound.close(() => resolve()));
  } finally { if (guard) clearTimeout(guard); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

it('launch failure closes the picker and recorder fixture listeners without waiting for wrapper termination', async () => {
  const output = await runOwnedLoader({ timeoutMs: 4000, env: { ...process.env, UOR_LOADER_LAUNCH_FAILURE: '1' } });
  expect(output.timedOut, output.text).toBe(false);
  expect(output.code).toBe(1);
  expect(output.text).toContain('UOR_LOADER_CLEANUP picker listener=closed');
  expect(output.text).toContain('UOR_LOADER_CLEANUP recorder listener=closed');
  expect(output.text).toContain('UOR_LOADER_CLEANUP session-continuation listener=closed');
}, 7000);

it('runs picker, recorder and session-only continuation under the actual production Node/tsx loader', async () => {
  const output = await runOwnedLoader();
  expect(output.timedOut, output.text).toBe(false);
  expect(output.code, output.text).toBe(0);
}, 50000);
