import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

async function bounded<T>(action: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([action, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error(message)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export async function closeOkoLauncherResources(input: { saveEvidence?(): Promise<unknown>; closeBrowser(): Promise<unknown>; stopLauncher(): Promise<unknown>; closeReport(): Promise<unknown>; removeProject(): Promise<unknown> }, primaryError?: unknown) {
  const failures: unknown[] = [];
  // Attempt every owned resource even when an earlier shutdown rejects or stalls.
  for (const [name, action, limit] of [
    ['evidence', input.saveEvidence, 5000], ['browser', input.closeBrowser, 10000], ['launcher', input.stopLauncher, 30000],
    ['report listener', input.closeReport, 5000], ['temporary project', input.removeProject, 10000],
  ] as const) {
    if (!action) continue;
    try { await bounded(Promise.resolve().then(action), limit, `Cleanup timed out: ${name}`); } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    const description = failures.map(error => error instanceof Error ? error.message : String(error)).join('; ');
    throw new AggregateError(failures, `${primaryError instanceof Error ? primaryError.message + '\n' : ''}Harness cleanup failures: ${description}`, primaryError === undefined ? undefined : { cause: primaryError });
  }
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
async function waitExit(child: ChildProcess, timeoutMs: number) {
  if (exited(child)) return;
  await new Promise<void>((resolve, reject) => {
    const remove = () => { clearTimeout(timer); child.off('exit', finish); child.off('error', failed); };
    const finish = () => { remove(); resolve(); }, failed = (error: Error) => { remove(); reject(error); };
    const timer = setTimeout(() => { remove(); reject(Error('Standard launcher shutdown timed out')); }, timeoutMs);
    child.once('exit', finish); child.once('error', failed);
  });
}
export async function stopOkoLauncher(child: ChildProcess | undefined, timeoutMs = 20000) {
  if (!child || exited(child)) return;
  try {
    if (child.connected) child.disconnect(); else child.kill();
    await waitExit(child, timeoutMs); assert.equal(child.exitCode, 0, 'Standard launcher exited unsuccessfully');
  } catch (error) {
    if (!exited(child)) {
      try {
        // Only this spawned child's PID/tree is eligible; never match processes by name.
        assert.ok(child.pid && Number.isSafeInteger(child.pid) && child.pid > 0, 'Missing owned launcher PID');
        if (process.platform === 'win32') {
          const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          try { await waitExit(killer, 3000); } finally { if (!exited(killer)) killer.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
        await waitExit(child, 5000);
      } catch (fallback) { throw new AggregateError([fallback], 'Owned launcher forced shutdown failed', {cause:error}); }
    }
    throw error;
  }
}
