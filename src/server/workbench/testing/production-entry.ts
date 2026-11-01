/** Trusted native test harness. Never imported by production bootstrap or exposed over HTTP. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPhysicalPath } from '../files';

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return value;
}

export async function prepareEmptyProductionRoot(inputRoot: string) {
  const root = path.resolve(inputRoot);
  await assertPhysicalPath(root, true);
  if ((await readdir(root)).length !== 0) throw Error('Smoke root must already exist and be empty');
  const canonicalRoot = await realpath(root), apiPort = await unusedPort();
  let clientPort = await unusedPort();
  while (clientPort === apiPort) clientPort = await unusedPort();
  await mkdir(path.join(canonicalRoot, 'config'));
  await writeFile(path.join(canonicalRoot, 'config/site.local.json'), JSON.stringify({ port: apiPort, clientPort, autoOpen: false, allowedWorkspaceRoots: [canonicalRoot], roleMode: 'local-preview' }), { flag: 'wx' });
  return { root: canonicalRoot, apiPort, clientPort, baseUrl: `http://127.0.0.1:${apiPort}` };
}

export async function startProductionEntry(input: { root: string; codeRoot: string; env?: NodeJS.ProcessEnv }) {
  const root = await realpath(input.root), codeRoot = await realpath(input.codeRoot);
  const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(codeRoot, 'node_modules/tsx/dist/loader.mjs')).href, path.join(codeRoot, 'src/server/main.ts')], {
    cwd: root, env: { ...process.env, UOR_NO_OPEN: '1', ...input.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', value => { output += value; });
  child.stderr!.on('data', value => { output += value; });
  const stop = () => stopProductionEntry(child, () => output);
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', failed); };
      const message = (value: unknown) => { if (value && typeof value === 'object' && 'type' in value && value.type === 'uor.child-ready') { cleanup(); resolve(); } };
      const exited = () => { cleanup(); reject(Error('Production entry exited before readiness: ' + output)); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(Error('Production entry readiness timed out: ' + output)); }, 25000);
      child.on('message', message); child.once('exit', exited); child.once('error', failed);
    });
    return { child, output: () => output, stop };
  } catch (error) { await stop(); throw error; }
}

async function stopProductionEntry(child: ChildProcess, output: () => string) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const exited = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { child.off('exit', exited); child.kill('SIGTERM'); reject(Error('Production entry shutdown timed out: ' + output())); }, 15000);
    child.once('exit', exited);
    if (child.connected) child.send({ type: 'uor.shutdown' }); else child.kill('SIGTERM');
  });
}
