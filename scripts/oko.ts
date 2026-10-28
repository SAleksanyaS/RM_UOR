import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { loadOkoConfiguration } from '../src/server/workbench/oko-config';

const root = process.cwd(), config = await loadOkoConfiguration(root), serve = process.argv.includes('--serve');
if (serve) await access(path.join(root, 'dist', 'oko.html')).catch(() => { throw Error('Интерфейс ещё не собран. Выполните npm run build.'); });
const children: ChildProcess[] = []; let closing = false;
const url = `http://127.0.0.1:${serve ? config.port : config.clientPort}/oko.html`;
const launch = (args: string[], ipc = false) => {
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, windowsHide: true, stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit' });
  children.push(child); child.once('error', error => { console.error(error.message); void close(1); }); child.once('exit', code => { if (!closing) void close(code ?? 1); }); return child;
};
async function close(code = 0) {
  if (closing) return; closing = true;
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timeout = setTimeout(() => { child.kill(); resolve(); }, 15000); timeout.unref();
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    if (child.connected) child.send({ type: 'uor.shutdown' }); else child.kill('SIGTERM');
  })));
  process.exit(code);
}
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close()); process.on('disconnect', () => void close());
launch(['--import', 'tsx', 'src/server/workbench/oko-main.ts'], true);
if (!serve) launch(['node_modules/vite/bin/vite.js', '--config', 'vite.oko.config.ts', '--host', '127.0.0.1']);
let ready = false;
for (let attempt = 0; attempt < 120 && !closing; attempt++) {
  try {
    const [api, page] = await Promise.all([fetch(`http://127.0.0.1:${config.port}/api/v1/session`, { signal: AbortSignal.timeout(1000) }), fetch(url, { signal: AbortSignal.timeout(1000) })]);
    if (api.ok && page.ok) { ready = true; break; }
  } catch { /* Both processes must be ready before opening the interface. */ }
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (!ready) { console.error('Не удалось запустить ОКО. Проверьте порты и сообщения выше.'); await close(1); }
console.log(`\nОКО готово: ${url}\nОстановка: Ctrl+C\n`);
if (config.autoOpen && process.env.UOR_NO_OPEN !== '1') {
  const binary = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(binary, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url], { windowsHide: true, stdio: 'ignore' }).on('error', () => console.log(`Откройте ${url}`));
}
