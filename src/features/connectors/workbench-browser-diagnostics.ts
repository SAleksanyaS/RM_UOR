import { lstat, constants, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrivateProfile } from './contracts';

export type BrowserEnvironmentReport = {
  executablePath: string | null;
  channel: string | null;
  executable: { exists: boolean; isFile: boolean; executable: boolean; directory: boolean; mode: string | null };
  sandbox: { chromeSandbox: string | null; mode: string | null; setuidRoot: boolean | null };
  profileDirectory: { writable: boolean | null };
  platform: NodeJS.Platform;
  uid: number | null;
  userns: { cloneAllowed: 'unknown' | 'allowed' | 'denied' };
  appArmorChromium: { restricted: 'unknown' | 'yes' | 'no' };
};

export type BrowserLaunchReason = 'SANDBOX_DENIED' | 'EXECUTABLE_NOT_EXECUTABLE' | 'MISSING_DEPENDENCY' | 'PROFILE_LOCKED'
  | 'PROFILE_DIR_NOT_WRITABLE' | 'BROWSER_PROTOCOL_MISMATCH' | 'BROWSER_LAUNCH_FAILED';

const mode = (value: number) => '0' + (value & 0o7777).toString(8);

async function isWritableDirectory(target: string): Promise<boolean | null> {
  try { const entry = await lstat(target); if (!entry.isDirectory()) return null; await access(target, constants.W_OK); return true; }
  catch { return null; }
}

async function readText(file: string): Promise<string | null> {
  try { return (await readFile(file, 'utf8')).trim(); } catch { return null; }
}

/** Read-only host inspection for launch diagnostics; never reads cookies, arguments or the profile contents. */
export async function inspectBrowserEnvironment(browser: NonNullable<PrivateProfile['browser']>): Promise<BrowserEnvironmentReport> {
  const executablePath = browser.executablePath ?? null, chromeSandbox = executablePath ? path.join(path.dirname(executablePath), 'chrome-sandbox') : null;
  let executable: BrowserEnvironmentReport['executable'] = { exists: false, isFile: false, executable: false, directory: false, mode: null };
  if (executablePath) {
    try {
      const entry = await lstat(executablePath);
      let canExecute = false; try { await access(executablePath, constants.X_OK); canExecute = true; } catch { canExecute = false; }
      executable = { exists: true, isFile: entry.isFile(), executable: canExecute, directory: entry.isDirectory(), mode: mode(entry.mode) };
    } catch { /* Missing executable is reported through exists: false. */ }
  }
  let sandbox: BrowserEnvironmentReport['sandbox'] = { chromeSandbox, mode: null, setuidRoot: null };
  if (chromeSandbox) {
    try {
      const entry = await lstat(chromeSandbox);
      sandbox = { chromeSandbox, mode: mode(entry.mode), setuidRoot: entry.uid === 0 && (entry.mode & 0o4000) !== 0 };
    } catch { /* Older Chromium forks rely on the binary itself. */ }
  }
  const usernsFlag = await readText('/proc/sys/kernel/unprivileged_userns_clone');
  const maxUserns = await readText('/proc/sys/user/max_user_namespaces');
  const userns: BrowserEnvironmentReport['userns']['cloneAllowed'] = usernsFlag === '0' || maxUserns === '0' ? 'denied' : usernsFlag === '1' ? 'allowed' : 'unknown';
  const restricted = await readText('/proc/sys/kernel/apparmor_restrict_unprivileged_userns');
  return { executablePath, channel: browser.channel ?? null, executable, sandbox, profileDirectory: { writable: await isWritableDirectory(browser.profileDirectory) }, platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null, userns: { cloneAllowed: userns }, appArmorChromium: { restricted: restricted === '1' ? 'yes' : restricted === '0' ? 'no' : 'unknown' } };
}

const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
const text = (error: unknown) => {
  const value = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  return [value?.name, value?.code, value?.message].filter(item => item !== undefined && item !== null).join(' ');
};

export function safeErrorDetail(error:unknown):string {
  const value=typeof error==='object'&&error!==null?(error as {code?:unknown}):null;
  const code=typeof value?.code==='string'&&/^(?:EACCES|EPERM|ENOENT|EROFS|ECONNRESET|ETIMEDOUT)$/.test(value.code)?value.code:'BROWSER_OPERATION_FAILED';
  // Provider text may contain arbitrary secrets without recognizable syntax. Emit only an allowlisted code.
  return code;
}

export function describeLaunchFailure(error: unknown, env: BrowserEnvironmentReport): { reason: BrowserLaunchReason; detail: string } {
  const value = `${code(error) ?? ''} ${text(error)}`;
  const detail = safeErrorDetail(error);
  if (!env.executable.exists && env.executablePath) return { reason: 'EXECUTABLE_NOT_EXECUTABLE', detail: 'executable_missing' };
  if (env.executable.exists && (!env.executable.isFile || !env.executable.executable)) return { reason: 'EXECUTABLE_NOT_EXECUTABLE', detail: `executable_not_runnable: ${env.executable.mode ?? 'unknown'}` };
  if (/sandbox|no usable sandbox|setuid|namespace|running as root|zygote|seccomp|SUID sandbox helper|chrome-sandbox/i.test(value) || /\bEPERM\b/.test(value)) return { reason: 'SANDBOX_DENIED', detail };
  if (/EACCES|ENOENT.*lib|shared librar|glibc|GLIBC|symbol lookup|error while loading/i.test(value)) return { reason: 'MISSING_DEPENDENCY', detail };
  if (/SingletonLock|profile.*lock|already in use|process singleton/i.test(value)) return { reason: 'PROFILE_LOCKED', detail };
  if (/EROFS|EACCES|permission denied/i.test(value) && /profile|user-data|browser-profiles/i.test(value)) return { reason: 'PROFILE_DIR_NOT_WRITABLE', detail };
  if (/Protocol error|protocol mismatch|websocket|Target page, context or browser has been closed|has been closed|Browser closed/i.test(value)) return { reason: 'BROWSER_PROTOCOL_MISMATCH', detail };
  return { reason: 'BROWSER_LAUNCH_FAILED', detail };
}

export function launchHint(reason: BrowserLaunchReason, env: BrowserEnvironmentReport): string {
  switch (reason) {
    case 'SANDBOX_DENIED': return `Запуск с защитой Chromium отклонён ОС${env.uid === 0 ? ' (процесс работает от root)' : ''}. Проверьте, что chrome-sandbox рядом с браузером принадлежит root и имеет режим 4755, и что unprivileged user namespaces не запрещены. Отключение защиты приложение не выполняет. Диагностика: npm run probe:sberbrowser.`;
    case 'EXECUTABLE_NOT_EXECUTABLE': return 'Укажите путь к исполняемому файлу браузера (не к папке установки), например /opt/Sberbrowser/sberbrowser/sberbrowser, и проверьте право на запуск.';
    case 'MISSING_DEPENDENCY': return 'Браузеру не хватает системных библиотек или прав. Проверьте установку браузера и запуском npm run probe:sberbrowser.';
    case 'PROFILE_LOCKED': return 'Профиль уже используется другим окном. Закройте собственные окна автоматизации и повторите.';
    case 'PROFILE_DIR_NOT_WRITABLE': return 'Нет доступа на запись в папку личного профиля. Проверьте права на .runtime/workbench-browser.';
    case 'BROWSER_PROTOCOL_MISMATCH': return 'Окно или протокол управления браузером закрылись до готовности. Повторите открытие окна; если запуск повторяется — выполните npm run probe:sberbrowser.';
    default: return 'Повторите открытие окна. Если ошибка повторяется, выполните npm run probe:sberbrowser и приложите отчёт.';
  }
}
