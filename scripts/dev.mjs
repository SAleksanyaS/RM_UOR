import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const root = await realpath(process.cwd());
let config = { port: 4174, clientPort: 5173, autoOpen: true, allowedWorkspaceRoots: [root] };
try { config = { ...config, ...JSON.parse(await readFile(path.join(root, 'config/site.local.json'), 'utf8')) }; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!Array.isArray(config.allowedWorkspaceRoots) || !config.allowedWorkspaceRoots.length) throw new Error('Укажите разрешённую папку в config/site.local.json');
const allowed = await Promise.all(config.allowedWorkspaceRoots.map(p => realpath(p)));
if (!allowed.some(p => { const relative = path.relative(p, root); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); })) throw new Error('Приложение запущено вне разрешённой папки');
console.log('\nУОР / DIT Operations\nПоднимаем локальное рабочее место…\n');
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 350).unref();
}
function launch(args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true }); children.push(child);
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => { if (!stopping) stop(code ?? 1); }); return child;
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
launch(['--import', 'tsx', 'src/server/main.ts']);
launch(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(config.clientPort)]);
const url = `http://127.0.0.1:${config.clientPort}`;
for (let i = 0; i < 100; i++) {
  if (stopping) break;
  try {
    const [api, client] = await Promise.all([fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(800) }), fetch(url, { signal: AbortSignal.timeout(800) })]);
    if (api.ok && client.ok) {
      console.log(`\nРабочее место готово: ${url}\nОстановка: Ctrl+C\n`);
      if (config.autoOpen && process.env.UOR_NO_OPEN !== '1') {
        const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
        const opener = spawn(command, args, { stdio: 'ignore', windowsHide: true }); opener.on('error', () => console.log(`Откройте ${url} в браузере`));
      }
      break;
    }
  } catch {}
  if (i === 99) { console.error('Не удалось запустить рабочее место. Проверьте сообщения выше и свободные порты.'); stop(1); }
  await new Promise(resolve => setTimeout(resolve, 250));
}
