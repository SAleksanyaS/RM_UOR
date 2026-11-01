// Separate OS process: deterministic scheduling at the real filesystem/PID boundary.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
const [root, mode, deadPid] = process.argv.slice(2);
if (mode === 'pause-reclaim') {
  const kill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid === Number(deadPid)) {
      process.send!({ event: 'observed-dead-owner' });
      const until = Date.now() + 10_000;
      while (!fs.existsSync(path.join(root, 'continue-reclaim'))) {
        if (Date.now() > until) throw Error('Parent did not release reclamation barrier');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return kill(pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
}
if (mode === 'crash-creation') {
  const open = fsp.open;
  fsp.open = (async (filename, ...args) => {
    const handle = await open(filename, ...args);
    if (String(filename).includes('maintenance.lock') && args[0] === 'wx') process.exit(73);
    return handle;
  }) as typeof fsp.open;
  syncBuiltinESMExports();
}
const { clearDeadMaintenanceLock, withMaintenanceLock } = await import('./private-storage');
try {
  if (mode !== 'crash-creation') await clearDeadMaintenanceLock(root);
  await withMaintenanceLock(root, async () => {
    process.send!({ event: 'entered' });
    await new Promise<void>(resolve => process.once('message', () => resolve()));
  });
  process.send!({ event: 'done' });
} catch (error) { process.send!({ event: 'denied', code: (error as { code?: string }).code, message: String(error) }); }
process.disconnect();
