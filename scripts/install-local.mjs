import { spawn } from 'node:child_process';
import { access, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLocalLaunch, writeDesktopShortcut, npmForNode } from './local-launcher.mjs';
import { inspectSberBrowser } from './open-workbench-browser.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function run(file, args, env) {
  const child = spawn(file, args, { cwd: root, env, stdio: 'inherit', shell: false, windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw Error('Подготовка зависимостей не завершилась. Существующие данные сохранены.');
}
async function main() {
  let install = false, desktop, browserExecutable;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--install-dependencies') install = true;
    else if (process.argv[i] === '--desktop-directory' && process.argv[i + 1]) desktop = process.argv[++i];
    else if (process.argv[i] === '--browser-executable' && process.argv[i + 1]) browserExecutable = process.argv[++i];
    else throw Error('Используйте --install-dependencies, --desktop-directory <абсолютная папка> и/или --browser-executable <абсолютный путь СберБраузера>.');
  }
  const runtime = await npmForNode(process.execPath);
  if (install) {
    try { await access(path.join(root, 'node_modules')); throw Error('Папка зависимостей уже существует. Автоматическая замена не выполняется; сначала проверьте установку.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await run(runtime.nodeExecutable, [runtime.npmCli, 'ci', '--include=dev', '--no-audit', '--no-fund', '--strict-ssl=true'], { ...process.env, PATH: path.dirname(runtime.nodeExecutable) + path.delimiter + (process.env.PATH ?? '') });
  }
  const prepared = await prepareLocalLaunch({ root });
  if (browserExecutable) {
    await inspectSberBrowser(browserExecutable);
    const filename = path.join(root, 'config/site.local.json');
    const original = await readFile(filename, 'utf8');
    const settings = { ...JSON.parse(original), browserExecutable };
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (await readFile(filename, 'utf8') !== original) throw Error('Настройки изменились во время подготовки. Повторите выбор браузера.');
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  if (desktop) console.log('Создан ярлык: ' + await writeDesktopShortcut({ root, directory: desktop, nodeExecutable: prepared.nodeExecutable }));
  console.log('Рабочее место подготовлено. Ежедневный запуск — ярлык РМ УОР или START_RM_UOR.sh. Windows: START_RM_UOR.cmd.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
