import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
export const pinnedRuntime = { node: '22.16.0', npm: '10.9.2' };
async function physicalDirectory(directory, create = false) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Папка рабочего места не должна проходить через ссылки.');
  }
}
export async function npmForNode(nodeExecutable) {
  if (!path.isAbsolute(nodeExecutable)) throw Error('Нужен абсолютный путь установленного Node.js.');
  const node = await realpath(nodeExecutable);
  const version = spawnSync(node, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (version.status !== 0 || version.stdout.trim() !== 'v' + pinnedRuntime.node) throw Error(`Нужен Node.js ${pinnedRuntime.node}. Используйте подготовленный ИТ дистрибутив.`);
  const directory = path.dirname(node);
  const candidates = [path.join(directory, 'node_modules/npm/bin/npm-cli.js'), path.resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js')];
  let npmCli;
  for (const candidate of candidates) { try { await access(candidate); npmCli = candidate; break; } catch {} }
  if (!npmCli) throw Error(`Рядом с Node.js не найден npm ${pinnedRuntime.npm}. Требуется подготовка ИТ.`);
  const npmVersion = spawnSync(node, [npmCli, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (npmVersion.status !== 0 || npmVersion.stdout.trim() !== pinnedRuntime.npm) throw Error(`Нужен npm ${pinnedRuntime.npm} из проверенного дистрибутива Node.js.`);
  return { nodeExecutable: node, npmCli };
}
export async function prepareLocalLaunch({ root, nodeExecutable = process.execPath, requireDependencies = true }) {
  if (!['linux', 'win32'].includes(process.platform)) throw Error('Этот запуск рассчитан на Linux и Windows.');
  await physicalDirectory(root);
  root = await realpath(root);
  const runtime = await npmForNode(nodeExecutable);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'uor-dit-operations') throw Error('Распакуйте полный дистрибутив РМ УОР в отдельную папку.');
  await access(path.join(root, 'scripts/dev.mjs'));
  await access(path.join(root, 'package-lock.json'));
  if (requireDependencies) {
    const missing = [];
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      try { await access(path.join(root, 'node_modules', name, 'package.json')); } catch { missing.push(name); }
    }
    if (missing.length) throw Error('Рабочее место ещё не подготовлено: отсутствуют зависимости. Передайте папку ИТ для установки; ежедневный запуск не меняет зависимости.');
  }
  const directory = path.join(root, 'config');
  try { await physicalDirectory(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(directory, { mode: 0o700 }); }
  const filename = path.join(directory, 'site.local.json');
  const defaults = { allowedWorkspaceRoots: [root], port: 4174, clientPort: 5173, autoOpen: true, roleMode: 'local-preview', repositoryUrl: '', publishedBranch: 'main' };
  try { await writeFile(filename, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536) throw Error('Файл настроек должен быть обычным локальным файлом.');
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  if (!saved || Array.isArray(saved) || typeof saved !== 'object') throw Error('Не удалось прочитать настройки рабочего места. Исходный файл сохранён.');
  const config = { ...defaults, ...saved };
  if (![config.port, config.clientPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || config.port === config.clientPort) throw Error('Порты приложения должны быть разными числами от 1024 до 65535.');
  if (!Array.isArray(config.allowedWorkspaceRoots) || !config.allowedWorkspaceRoots.length) throw Error('В настройках не задана разрешённая папка.');
  const allowed = await Promise.all(config.allowedWorkspaceRoots.map(value => realpath(value)));
  if (!allowed.some(base => { const relative = path.relative(base, root); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); })) throw Error('Эта папка не входит в разрешённые. После переноса рабочей папки обновите настройку через ИТ.');
  const environment = { ...process.env, npm_execpath: runtime.npmCli, PATH: path.dirname(runtime.nodeExecutable) + path.delimiter + (process.env.PATH ?? process.env.Path ?? '') };
  for (const key of Object.keys(environment)) if (key !== 'PATH' && key.toUpperCase() === 'PATH') delete environment[key];
  return { root, config, ...runtime, environment };
}
/** IT provisioning writes a shortcut only on explicit request; daily launch never installs it. */
export async function writeDesktopShortcut({ root, directory, nodeExecutable = process.execPath }) {
  if (!path.isAbsolute(root) || !path.isAbsolute(directory) || [root, directory, nodeExecutable].some(value => /[\r\n\0]/.test(value))) throw Error('Для ярлыка нужны абсолютные однострочные пути.');
  await physicalDirectory(directory, true);
  const quote = value => '"' + value.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&') + '"';
  const file = path.join(directory, 'RM-UOR.desktop');
  await writeFile(file, ['[Desktop Entry]', 'Type=Application', 'Version=1.0', 'Name=РМ УОР', 'Comment=Рабочие данные, цели и недельная сводка', `Exec=${quote(nodeExecutable)} ${quote(path.join(root, 'start-rm-uor.mjs'))}`, 'Terminal=true', 'Categories=Office;', 'StartupNotify=false', ''].join('\n'), { flag: 'wx', mode: 0o700 });
  return file;
}
