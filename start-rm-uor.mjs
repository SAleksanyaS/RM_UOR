import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLocalLaunch, pinnedRuntime } from './scripts/local-launcher.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
async function freePort(port) {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', error => reject(Error(`Порт ${port} занят или недоступен (${error.code ?? 'ошибка'}). Если рабочее место уже открыто, используйте его окно. Другие программы не останавливаются.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}
async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some(value => !['--check', '--no-open'].includes(value))) throw Error('Допустимы только --check и --no-open.');
  const prepared = await prepareLocalLaunch({ root });
  if (args.has('--check')) { console.log(JSON.stringify({ ready: true, node: pinnedRuntime.node, npm: pinnedRuntime.npm, platform: process.platform, port: prepared.config.port, clientPort: prepared.config.clientPort })); return; }
  await freePort(prepared.config.port); await freePort(prepared.config.clientPort);
  console.log('РМ УОР · запускаем рабочее место. Оставьте это окно открытым. Для остановки нажмите Ctrl+C.');
  const child = spawn(prepared.nodeExecutable, ['scripts/dev.mjs'], { cwd: prepared.root, env: { ...prepared.environment, ...(args.has('--no-open') ? { UOR_NO_OPEN: '1' } : {}) }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; if (child.connected) child.send({ type: 'uor.shutdown' }, () => {}); else if (child.exitCode === null) child.kill('SIGTERM'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  process.on('disconnect', stop);
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (stopping && signal === 'SIGTERM' ? 0 : 1))); }); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('disconnect', stop); }
}
main().catch(error => { console.error('Не удалось запустить РМ УОР: ' + error.message); process.exitCode = 1; });
