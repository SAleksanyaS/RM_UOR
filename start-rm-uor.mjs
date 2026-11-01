import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requiredNode = '22.16.0';
const requiredNpm = '10.9.2';
const root = realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const configFile = path.join(root, 'config', 'site.local.json');

async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error(
      `Порт ${port} недоступен (${error.code ?? error.message}). ` +
      'Если эта копия уже запущена, используйте её окно браузера. ' +
      'Иначе выберите свободные разные port и clientPort в config/site.local.json. ' +
      'Launcher не останавливает другие программы.'
    )));
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Этот launcher предназначен для Windows. Для другой ОС используйте README.md и npm run dev.');
  if (process.versions.node !== requiredNode) throw new Error(`Нужен проверенный Node.js ${requiredNode}; найден ${process.versions.node}. Установите нужную версию обычным способом. Launcher не устанавливает Node.js.`);
  process.chdir(root);
  const nodeDirectory = path.dirname(process.execPath);
  const npmCli = path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error(`Рядом с выбранным Node.js не найден npm CLI. Нужна установка Node.js ${requiredNode} с npm ${requiredNpm}.`);
  const env = { ...process.env, PATH: nodeDirectory + path.delimiter + (process.env.PATH ?? process.env.Path ?? '') };
  // Windows environment keys are case-insensitive; leave one PATH entry.
  for (const key of Object.keys(env)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete env[key];
  const version = spawnSync(process.execPath, [npmCli, '--version'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  if (version.error || version.status !== 0) throw new Error('Не удалось проверить npm. Исправьте установку Node.js/npm и повторите запуск.');
  if (version.stdout.trim() !== requiredNpm) throw new Error(`Нужен проверенный npm ${requiredNpm}; найден ${version.stdout.trim()}. Launcher не меняет системные версии.`);
  if (!existsSync(path.join(root, 'package-lock.json')) || !existsSync(path.join(root, 'scripts', 'dev.mjs'))) throw new Error('Распакуйте весь архив в новую папку. Не запускайте только отдельно скопированный launcher.');

  mkdirSync(path.dirname(configFile), { recursive: true });
  const defaults = { allowedWorkspaceRoots: [root], port: 4174, clientPort: 5173, autoOpen: true, roleMode: 'local-preview', repositoryUrl: '', publishedBranch: 'main' };
  try {
    writeFileSync(configFile, JSON.stringify(defaults, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log('Созданы настройки только для этой распакованной папки.');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log('Существующие config/site.local.json и рабочие данные сохраняются.');
  }
  let site;
  try {
    site = JSON.parse(readFileSync(configFile, 'utf8'));
    if (!site || typeof site !== 'object' || Array.isArray(site)) throw new Error('Invalid configuration object');
  }
  catch { throw new Error('config/site.local.json содержит ошибку или недоступен. Файл сохранён без изменений; исправьте его вручную.'); }
  const apiPort = site.port ?? 4174, clientPort = site.clientPort ?? 5173;
  if (![apiPort, clientPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || apiPort === clientPort) throw new Error('В config/site.local.json нужны разные целые port и clientPort от 1024 до 65535. Файл не изменён.');
  await requireFreePort(apiPort);
  await requireFreePort(clientPort);

  let dependencyEntry;
  try { dependencyEntry = lstatSync(path.join(root, 'node_modules')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!dependencyEntry) {
    console.log('Первый запуск: устанавливаются зависимости npm ci. Нужен доступ к настроенному npm registry.');
    const installed = spawnSync(process.execPath, [npmCli, 'ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: root, env, stdio: 'inherit' });
    if (installed.error || installed.status !== 0) throw new Error('npm ci не завершился. Данные и настройки сохранены. Проверьте сеть/registry; для восстановления неполной установки выполните npm ci --include=dev вручную в этой папке.');
  }
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const requiredPackages = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const missing = requiredPackages.filter(name => !existsSync(path.join(root, 'node_modules', name, 'package.json')));
  if (missing.length) throw new Error('Существующая папка node_modules неполная. Автоматически она не заменяется. Выполните npm ci --include=dev вручную в этой папке, затем снова откройте START_RM_UOR.cmd.');

  console.log(`Рабочая папка: ${root}`);
  console.log(`Запускается штатное приложение; адрес после готовности: http://127.0.0.1:${clientPort}`);
  console.log('Оставьте это окно открытым. Остановка — Ctrl+C. Повторный запуск сохраняет локальные данные.');
  console.log('Новое рабочее место пустое; личный ОКО доступен в разделе «Данные».');
  // npm launches the existing managed dev process. No synthetic fixture is run.
  const child = spawn(process.execPath, [npmCli, 'run', 'dev'], { cwd: root, env, stdio: 'inherit' });
  let interrupted = false;
  const waitForManagedShutdown = () => { interrupted = true; };
  process.on('SIGINT', waitForManagedShutdown);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(interrupted || signal === 'SIGINT' ? 0 : code ?? 1));
    });
  } finally { process.off('SIGINT', waitForManagedShutdown); }
}

main().catch(error => { console.error('\nНе удалось запустить РМ УОР: ' + error.message); process.exitCode = 1; });
