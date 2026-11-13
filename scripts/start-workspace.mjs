import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function exists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function seedWorkspace(dataDir) {
  const seed = join(root, 'seed');
  const initialState = join(seed, 'workspace.json');
  const currentState = join(dataDir, 'workspace.json');
  if (!(await exists(initialState)) || await exists(currentState)) return;
  const sources = join(dataDir, 'sources');
  await mkdir(sources, { recursive: true });
  for (const file of await readdir(join(seed, 'sources'))) {
    if (!/^[a-f0-9]{64}$/u.test(file)) throw new Error('Не удалось прочитать исходные данные комплекта.');
    await copyFile(join(seed, 'sources', file), join(sources, file), constants.COPYFILE_EXCL).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  const staging = await mkdtemp(join(dataDir, '.seed-'));
  try {
    const stateFile = join(staging, 'workspace.json');
    await copyFile(initialState, stateFile);
    await link(stateFile, currentState).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
  } finally {
    await rm(join(staging, 'workspace.json'), { force: true });
    await rmdir(staging);
  }
}

try {
  const dataDir = process.env.RM_UOR_DATA_DIR ? resolve(process.env.RM_UOR_DATA_DIR) : join(root, '.local');
  if (!process.env.RM_UOR_DATA_DIR) await seedWorkspace(dataDir);
  const { server, url } = await startServer({ dataDir, port: Number(process.env.RM_UOR_PORT ?? 4179) });
  console.log(`Рабочее место УОР — ${url}`);
  if (process.platform === 'win32' && process.env.RM_UOR_OPEN_BROWSER !== '0') {
    execFile('explorer.exe', [url], { windowsHide: true }, () => {});
  }
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? 'Рабочее место уже запущено на этом порту.' : error.message);
  process.exitCode = 1;
}
