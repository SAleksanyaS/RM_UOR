import { spawn, execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';

export const targetBrowserVersion = '152.0.7977.120';
const execute = promisify(execFile);

async function executableFile(executable) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || /[\r\n\0]/.test(executable)) {
    throw Error('Укажите абсолютный путь установленного СберБраузера.');
  }
  if (!(await stat(executable)).isFile()) throw Error('Путь СберБраузера должен указывать на исполняемый файл.');
  await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
}

/** Provisioning checks an explicitly selected binary, never guesses a bank path. */
export async function inspectSberBrowser(executable) {
  await executableFile(executable);
  const { stdout, stderr } = await execute(executable, ['--version'], {
    timeout: 10000, maxBuffer: 8192, windowsHide: true, shell: false,
  });
  const description = String(stdout || stderr).trim();
  if (!/sber|сбер/i.test(description) || !description.includes(targetBrowserVersion)) {
    throw Error(`Выбранный браузер не подтвердил СберБраузер ${targetBrowserVersion}. Проверьте путь и версию с ИТ.`);
  }
  return { version: targetBrowserVersion };
}

/** Bounded discovery of configured/known Sber launchers; does not inspect user profiles. */
export async function discoverSberBrowsers({ configuredExecutable, searchPath = process.env.PATH ?? '', platform = process.platform, systemCandidates } = {}) {
  const names = platform === 'win32' ? ['sberbrowser.exe', 'sber-browser.exe'] : ['sberbrowser', 'sber-browser'];
  const system = systemCandidates ?? (platform === 'linux' ? ['/opt/Sberbrowser/sberbrowser/sberbrowser'] : []);
  const proposed = [configuredExecutable, ...system, ...searchPath.split(path.delimiter).filter(value => path.isAbsolute(value)).slice(0, 40).flatMap(directory => names.map(name => path.join(directory, name)))];
  const found = [];
  for (const executablePath of [...new Set(proposed.filter(Boolean))]) {
    try { await executableFile(executablePath); found.push(executablePath); } catch { /* Missing candidate is normal. */ }
    if (found.length === 6) break;
  }
  const candidates = await Promise.all(found.map(async executablePath => {
    try { const verified = await inspectSberBrowser(executablePath); return { executablePath, version: verified.version, status: 'compatible' }; }
    catch { return { executablePath, version: null, status: 'unverified' }; }
  }));
  return { targetVersion: targetBrowserVersion, candidates,
    message: candidates.some(candidate => candidate.status === 'compatible') ? 'Найден СберБраузер целевой версии. Вход и доступ к источнику проверяются отдельно.' : candidates.length ? 'Путь найден, но название или версия не подтверждены. Проверьте установку с ИТ.' : 'СберБраузер не найден автоматически. Укажите путь установленного браузера или передайте подготовку ИТ.' };
}

/** Opens only the local workbench in the configured corporate browser. */
export async function openWorkbenchBrowser({ executable, url, notify = console.log }) {
  const address = new URL(url);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port || address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
    throw Error('Автоматическое открытие разрешено только для локального рабочего места.');
  }
  const manual = () => notify(`Откройте ${url} в СберБраузере. Для автоматического открытия ИТ один раз указывает путь браузера при подготовке рабочего места.`);
  if (!executable) { manual(); return false; }
  try {
    await executableFile(executable);
    const child = spawn(executable, [url], { shell: false, stdio: 'ignore', detached: true, windowsHide: false });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return true;
  } catch { manual(); return false; }
}
