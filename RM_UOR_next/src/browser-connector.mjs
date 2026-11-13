import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rm, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openWorkbook } from './imports.mjs';
import { BrowserRecordingError, startBrowserClickRecorder } from './browser-recorder.mjs';

const maxBytes = 20 * 1024 * 1024;
const navigationMs = 40_000;
const actionMs = 15_000;
const runMs = 120_000;
const executableNames = new Set([
  'chrome', 'chrome.exe', 'chromium', 'chromium.exe', 'chromium-browser', 'google chrome',
  'google-chrome', 'google-chrome-stable', 'msedge', 'msedge.exe', 'microsoft edge',
  'sberbrowser', 'sberbrowser.exe', 'sber-browser', 'sber-browser.exe',
]);
const secretKey = /password|passwd|pwd|secret|token|authorization|credential|cookie|saml|otp|(?:^|[_-])code(?:$|[_-])|api[_-]?key/iu;
const authField = /password|passwd|passcode|pwd|secret|credential|username|one.time.code|(?:^|[-_ .#"'[\]])(?:login|otp|email|pin|saml)(?:$|[-_ .#"'[\]])|парол|логин|код входа/iu;
const suspiciousValue = /^(?:bearer|basic)\s|-----BEGIN [A-Z ]+KEY-----|(?:password|token|secret|credential)\s*=/iu;
const configKeys = new Set(['id', 'url', 'allowedOrigins', 'actions', 'downloadSelector', 'executablePath', 'readySelector', 'reportSelector']);

export class BrowserConnectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserConnectorError';
    this.code = code;
  }
}

const fail = (code, message) => new BrowserConnectorError(code, message);
const badConfig = message => fail('BROWSER_CONFIG', message);

function connectorId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(value)) {
    throw badConfig('Укажите код браузерного источника из латинских строчных букв, цифр, дефисов и подчёркиваний.');
  }
  return value;
}

function transportUrl(value, allowHttpLoopback, kind = 'request') {
  try {
    let url = new URL(value);
    if (kind === 'download' && url.protocol === 'blob:') url = new URL(url.pathname);
    if (kind === 'socket' && url.protocol === 'wss:') url.protocol = 'https:';
    if (kind === 'socket' && url.protocol === 'ws:') url.protocol = 'http:';
    if (url.username || url.password) return null;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (allowHttpLoopback && url.protocol === 'http:' && loopback) ? url : null;
  } catch {
    return null;
  }
}

function checkedExecutable(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f]/u.test(value)) {
    throw badConfig('Укажите абсолютный путь к установленному браузеру.');
  }
  if (!executableNames.has(basename(value).toLowerCase())) {
    throw badConfig('Укажите исполняемый файл СберБраузера, Chrome, Chromium или Edge.');
  }
  return resolve(value);
}

function checkedSelector(value) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 220 ||
      /[\u0000-\u001f]|>>|^\s*(?:xpath|text|internal):?=|^\s*\/\//iu.test(value) || authField.test(value)) {
    throw badConfig('Укажите короткий CSS-селектор элемента отчёта. Поля входа используются вручную.');
  }
  return value.trim();
}

export function validateBrowserConfig(config, { allowHttpLoopback = false } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !configKeys.has(key))) throw badConfig('Проверьте настройки браузерного источника.');
  const id = connectorId(config.id);
  const url = typeof config.url === 'string' && config.url.length <= 2500
    ? transportUrl(config.url, allowHttpLoopback)
    : null;
  if (!url) throw badConfig('Укажите HTTPS-адрес отчёта без логина и пароля.');
  if ([...url.searchParams.keys()].some(key => secretKey.test(key)) ||
      /(?:^|[&#?])[^&=]*(?:token|password|secret|saml|credential|code)=/iu.test(url.hash)) {
    throw badConfig('Уберите секретные параметры из адреса отчёта. Вход выполняется в окне браузера.');
  }

  const originList = config.allowedOrigins ?? [];
  if (!Array.isArray(originList) || originList.length > 12) throw badConfig('Укажите до 12 точных origin для отчёта и входа.');
  const origins = new Set([url.origin]);
  for (const item of originList) {
    const origin = typeof item === 'string' ? transportUrl(item, allowHttpLoopback) : null;
    if (!origin || item !== origin.origin) throw badConfig('Укажите точный origin вида https://host без пути и слеша в конце.');
    origins.add(origin.origin);
  }

  const steps = config.actions ?? [];
  if (!Array.isArray(steps) || steps.length > 12) throw badConfig('Укажите не более 12 шагов получения отчёта.');
  const actions = steps.map(step => {
    if (!step || !['click', 'fill', 'wait'].includes(step.type) ||
        Object.keys(step).some(key => !['type', 'selector', 'value'].includes(key))) {
      throw badConfig('Поддерживаются шаги click, fill и wait.');
    }
    const selector = checkedSelector(step.selector);
    if (!selector) throw badConfig('Укажите CSS-селектор для каждого шага.');
    if (step.type !== 'fill') {
      if (step.value !== undefined) throw badConfig('Значение требуется только для шага fill.');
      return { type: step.type, selector };
    }
    if (typeof step.value !== 'string' || step.value.length > 160 ||
        /[\u0000-\u001f]/u.test(step.value) || suspiciousValue.test(step.value)) {
      throw badConfig('Для fill укажите короткое открытое значение фильтра, без секретов.');
    }
    return { type: 'fill', selector, value: step.value };
  });

  const reportSelector = checkedSelector(config.reportSelector);
  if (reportSelector && /^(?:\*|html\b|body\b|form\b|input\b|textarea\b|select\b)/iu.test(reportSelector)) {
    throw badConfig('Укажите конкретный контейнер отчёта.');
  }
  return {
    id, url: url.href, allowedOrigins: [...origins], actions,
    downloadSelector: checkedSelector(config.downloadSelector),
    executablePath: checkedExecutable(config.executablePath),
    readySelector: checkedSelector(config.readySelector), reportSelector,
  };
}

async function privateDirectory(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat = await lstat(current).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) {
      await mkdir(current, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw fail('BROWSER_PRIVATE_DIRECTORY', 'Папка личного браузера должна быть обычным каталогом без ссылок.');
    }
  }
  return realpath(absolute);
}

async function installedLauncher(modulePath) {
  try {
    let module;
    if (modulePath) {
      if (!isAbsolute(modulePath)) throw new Error('absolute path required');
      const resolved = createRequire(import.meta.url).resolve(modulePath);
      module = await import(pathToFileURL(resolved).href);
    } else {
      module = await import('playwright');
    }
    const chromium = module.chromium ?? module.default?.chromium;
    if (typeof chromium?.launchPersistentContext !== 'function') throw new Error('Chromium unavailable');
    return chromium.launchPersistentContext.bind(chromium);
  } catch {
    throw fail('BROWSER_RUNTIME', 'Установите Playwright либо укажите его абсолютный путь в RM_UOR_PLAYWRIGHT.');
  }
}

function permitted(owner, address, kind) {
  const url = transportUrl(address, owner.allowHttpLoopback, kind);
  return url !== null && owner.config.allowedOrigins.includes(url.origin);
}

function xlsxName(name) {
  return typeof name === 'string' && name.length <= 160 && /\.xlsx$/iu.test(name) &&
    !/[\\/<>:"|?*\u0000-\u001f]/u.test(name);
}

function downloadFailure(owner, error) {
  owner.downloadFailure ??= error;
  owner.rejectDownload?.(error);
}

async function protectBrowser(owner) {
  const { context, page } = owner;
  await context.route('**/*', async route => {
    const request = route.request();
    let topFrame = false;
    try {
      const frame = request.frame();
      topFrame = frame.page() === page && frame.parentFrame() === null;
    } catch {
      // The first request of an extra tab or a background request can lack a frame.
    }
    if (topFrame && permitted(owner, request.url())) await route.continue().catch(() => {});
    else await route.abort('blockedbyclient').catch(() => {});
  });
  await context.routeWebSocket('**/*', route => {
    if (permitted(owner, route.url(), 'socket')) route.connectToServer();
    else route.close({ code: 1008, reason: 'Origin not allowed' });
  });
  context.on('page', tab => {
    if (tab !== page) void tab.close().catch(() => {});
  });
  page.on('framenavigated', frame => {
    if (frame.parentFrame() === null && frame.url() !== 'about:blank' && !permitted(owner, frame.url())) {
      owner.abort.abort(fail('BROWSER_POLICY', 'Открыт адрес вне списка разрешённых origin.'));
      void context.close().catch(() => {});
    }
  });

  const cdp = await context.newCDPSession(page);
  owner.cdp = cdp;
  cdp.on('Fetch.requestPaused', event => {
    void (async () => {
      const headers = event.responseHeaders ?? [];
      const location = headers.find(header => header.name.toLowerCase() === 'location')?.value;
      const redirect = location && event.responseStatusCode >= 300 && event.responseStatusCode < 400;
      let allowed = permitted(owner, event.request.url, 'download');
      if (allowed && redirect) {
        try {
          allowed = permitted(owner, new URL(location, event.request.url).href);
        } catch {
          allowed = false;
        }
      }
      const action = allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest';
      const fields = allowed ? {} : { errorReason: 'BlockedByClient' };
      await cdp.send(action, { requestId: event.requestId, ...fields }).catch(() => {});
    })();
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });

  const cancel = guid => cdp.send('Browser.cancelDownload', { guid }).catch(() => {});
  cdp.on('Browser.downloadWillBegin', ({ guid, url, suggestedFilename }) => {
    if (!owner.downloadEnabled) {
      void cancel(guid);
    } else if (!permitted(owner, url, 'download')) {
      downloadFailure(owner, fail('BROWSER_DOWNLOAD_ORIGIN', 'Выгрузка получена с неразрешённого адреса.'));
      void cancel(guid);
    } else if (!xlsxName(suggestedFilename)) {
      downloadFailure(owner, fail('BROWSER_DOWNLOAD_INVALID', 'Получите выгрузку в формате XLSX.'));
      void cancel(guid);
    } else if (owner.downloadGuid && owner.downloadGuid !== guid) {
      downloadFailure(owner, fail('BROWSER_DOWNLOAD_INVALID', 'За один запуск выгрузите один файл XLSX.'));
      void cancel(guid);
    } else {
      owner.downloadGuid = guid;
    }
  });
  cdp.on('Browser.downloadProgress', ({ guid, totalBytes, receivedBytes }) => {
    if (owner.downloadEnabled && (totalBytes > maxBytes || receivedBytes > maxBytes)) {
      downloadFailure(owner, fail('BROWSER_DOWNLOAD_TOO_LARGE', 'Выгрузка превышает 20 МБ.'));
      void cancel(guid);
    }
  });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
}

function sameBrowserSettings(before, after) {
  return before.url === after.url && before.executablePath === after.executablePath &&
    before.allowedOrigins.length === after.allowedOrigins.length &&
    before.allowedOrigins.every(origin => after.allowedOrigins.includes(origin));
}

function recordingError(error) {
  if (error instanceof BrowserConnectorError) return error;
  if (error instanceof BrowserRecordingError) return fail(error.code, error.message);
  return fail('BROWSER_RECORD_FAILED', 'Не удалось записать действия в открытом отчёте.');
}

function reportOrigin(owner) {
  const current = transportUrl(owner.page.url(), owner.allowHttpLoopback);
  if (current?.origin !== new URL(owner.config.url).origin) {
    throw fail('BROWSER_LOGIN_REQUIRED', 'Завершите вход и откройте отчёт на настроенном адресе.');
  }
}

async function performActions(owner) {
  for (const action of owner.config.actions) {
    owner.abort.signal.throwIfAborted();
    reportOrigin(owner);
    const locator = owner.page.locator(action.selector);
    if (action.type === 'wait') await locator.waitFor({ state: 'visible', timeout: actionMs });
    if (action.type === 'click') await locator.click({ timeout: actionMs });
    if (action.type === 'fill') {
      const field = await locator.elementHandle({ timeout: actionMs });
      try {
        const filter = await field?.evaluate((element, pattern) => {
          const input = element instanceof HTMLInputElement && ['text', 'search', 'number'].includes(element.type);
          if (!input && !(element instanceof HTMLTextAreaElement)) return false;
          const labels = [...(element.labels ?? [])].map(label => label.textContent).join(' ');
          const attributes = ['id', 'name', 'type', 'autocomplete', 'aria-label', 'placeholder']
            .map(name => element.getAttribute(name) ?? '').join(' ');
          return !new RegExp(pattern, 'iu').test(labels + ' ' + attributes) &&
            !element.closest('form')?.querySelector('input[type=password], input[autocomplete=one-time-code]');
        }, authField.source);
        if (!filter) throw fail('BROWSER_INPUT_FORBIDDEN', 'Вход выполняется вручную. Для fill выберите поле фильтра отчёта.');
        reportOrigin(owner);
        await field.fill(action.value, { timeout: actionMs });
      } finally {
        await field?.dispose().catch(() => {});
      }
    }
  }
}

function waitForDownload(owner) {
  let stop;
  const promise = new Promise((resolveDownload, reject) => {
    const onDownload = file => resolveDownload(file);
    const onAbort = () => reject(owner.abort.signal.reason);
    stop = () => {
      owner.page.off('download', onDownload);
      owner.abort.signal.removeEventListener('abort', onAbort);
      owner.rejectDownload = null;
    };
    owner.rejectDownload = reject;
    owner.page.on('download', onDownload);
    owner.abort.signal.addEventListener('abort', onAbort, { once: true });
    if (owner.abort.signal.aborted) onAbort();
    if (owner.downloadFailure) reject(owner.downloadFailure);
  });
  promise.catch(() => {});
  return { promise, stop };
}

async function boundedDownload(owner, download) {
  if (owner.downloadFailure) throw owner.downloadFailure;
  const filename = download.suggestedFilename();
  if (!permitted(owner, download.url(), 'download')) {
    await download.cancel().catch(() => {});
    throw fail('BROWSER_DOWNLOAD_ORIGIN', 'Выгрузка получена с неразрешённого адреса.');
  }
  if (!xlsxName(filename)) throw fail('BROWSER_DOWNLOAD_INVALID', 'Получите выгрузку в формате XLSX.');
  let path;
  try {
    path = await download.path();
  } catch {
    if (owner.downloadFailure) throw owner.downloadFailure;
    owner.abort.signal.throwIfAborted();
    throw fail('BROWSER_DOWNLOAD_INVALID', 'Браузер не завершил скачивание XLSX.');
  }
  if (owner.downloadFailure) throw owner.downloadFailure;
  const filePath = await realpath(path);
  const info = await lstat(path);
  if (dirname(filePath) !== owner.downloadDir || dirname(resolve(path)) !== owner.downloadDir ||
      !info.isFile() || info.isSymbolicLink()) {
    throw fail('BROWSER_DOWNLOAD_INVALID', 'Выгрузка не найдена в папке текущего запуска.');
  }
  const file = await open(filePath, 'r');
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw fail('BROWSER_DOWNLOAD_TOO_LARGE', 'Выгрузка превышает 20 МБ.');
    bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      owner.abort.signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fail('BROWSER_DOWNLOAD_INVALID', 'Файл XLSX неполный.');
      offset += bytesRead;
    }
    if ((await file.stat()).size !== bytes.length) throw fail('BROWSER_DOWNLOAD_INVALID', 'Файл XLSX изменился при чтении.');
  } finally {
    await file.close();
  }
  try {
    openWorkbook(bytes);
  } catch {
    throw fail('BROWSER_DOWNLOAD_INVALID', 'Скачанный файл не удалось открыть как книгу XLSX.');
  }
  return { filename, bytes };
}

async function collectReport(owner) {
  await performActions(owner);
  if (owner.config.readySelector) {
    reportOrigin(owner);
    await owner.page.locator(owner.config.readySelector).waitFor({ state: 'visible', timeout: actionMs });
  }
  const watcher = waitForDownload(owner);
  try {
    owner.downloadEnabled = true;
    try {
      await owner.cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName', downloadPath: owner.downloadDir, eventsEnabled: true,
      });
    } catch {
      throw fail('BROWSER_POLICY', 'Браузер не поддерживает безопасную выгрузку XLSX.');
    }
    if (owner.config.downloadSelector) {
      reportOrigin(owner);
      await owner.page.locator(owner.config.downloadSelector).click({ timeout: actionMs });
    }
    const download = await watcher.promise;
    reportOrigin(owner);
    return await boundedDownload(owner, download);
  } finally {
    owner.downloadEnabled = false;
    watcher.stop();
  }
}

async function readReport(owner) {
  await performActions(owner);
  reportOrigin(owner);
  await owner.page.locator(owner.config.readySelector).waitFor({ state: 'visible', timeout: actionMs });
  const report = owner.page.locator(owner.config.reportSelector);
  await report.waitFor({ state: 'visible', timeout: actionMs });
  reportOrigin(owner);
  const result = await report.evaluate((element, pattern) => {
    const denied = 'html, body, form, input, textarea, select, button, script, style';
    if (!(element instanceof HTMLElement) || element.matches(denied) || element.closest('form') ||
        element.querySelector('form, input[type=password], input[autocomplete=one-time-code]') ||
        new RegExp(pattern, 'iu').test([element.id, element.getAttribute('aria-label')].join(' '))) return { forbidden: true };
    if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') return { text: '' };
    const text = element.innerText.trim();
    if (text.length > 100_000) return { tooLong: true };
    return { text, title: document.title.trim().slice(0, 300) };
  }, authField.source);
  reportOrigin(owner);
  if (result.forbidden) throw fail('BROWSER_READ_FORBIDDEN', 'Выберите контейнер отчёта вне формы входа.');
  if (result.tooLong) throw fail('BROWSER_READ_TOO_LARGE', 'Выберите меньший раздел отчёта.');
  if (!result.text) throw fail('BROWSER_READ_EMPTY', 'В выбранном разделе отчёта нет текста.');
  return { title: result.title, text: result.text };
}

export function createBrowserConnector({
  privateRoot, launchPersistentContext, playwrightPath = process.env.RM_UOR_PLAYWRIGHT,
  browserExecutablePath = process.env.RM_UOR_BROWSER, allowHttpLoopback = false,
} = {}) {
  if (typeof privateRoot !== 'string' || !isAbsolute(privateRoot)) {
    throw badConfig('Нужен абсолютный путь к приватной папке браузера.');
  }
  const httpForTests = allowHttpLoopback === true && typeof launchPersistentContext === 'function';
  const sessions = new Map();

  function finish(owner) {
    if (owner.finishing) return owner.finishing;
    owner.finishing = Promise.resolve().then(async () => {
      const recording = owner.recording;
      owner.recording = null;
      if (recording) await recording.pending.then(recorder => recorder.dispose()).catch(() => {});
      if (owner.context && !owner.contextClosed) {
        await owner.context.close().catch(() => {
          if (!owner.contextClosed) throw fail('BROWSER_CLOSE', 'Не удалось закрыть окно личного браузера.');
        });
      }
      try {
        if (owner.downloadDir) {
          const path = await realpath(owner.downloadDir).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (path) {
            if (path !== owner.downloadDir || dirname(path) !== owner.downloadsRoot) {
              throw fail('BROWSER_PRIVATE_DIRECTORY', 'Папка выгрузки изменилась во время работы.');
            }
            await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
          }
        }
      } finally {
        try {
          if (owner.lock) {
            await owner.lock.close();
            await unlink(owner.lockPath);
          }
        } finally {
          sessions.delete(owner.config.id);
        }
      }
    });
    return owner.finishing;
  }

  async function openBrowser(owner) {
    const executablePath = owner.config.executablePath ?? checkedExecutable(browserExecutablePath);
    if (executablePath) {
      const stat = await lstat(executablePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw badConfig('Исполняемый файл браузера не найден или является ссылкой.');
      }
    }
    const launch = launchPersistentContext ?? await installedLauncher(playwrightPath);
    const root = await privateDirectory(privateRoot);
    const profile = await privateDirectory(join(root, 'profiles', owner.config.id));
    const locks = await privateDirectory(join(root, 'locks'));
    owner.lockPath = join(locks, owner.config.id + '.lock');
    owner.lock = await open(owner.lockPath, 'wx', 0o600).catch(error => {
      if (error.code === 'EEXIST') throw fail('BROWSER_BUSY', 'Личный профиль этого источника уже открыт.');
      throw error;
    });
    owner.downloadsRoot = await privateDirectory(join(root, 'downloads'));
    const dir = join(owner.downloadsRoot, randomUUID());
    await mkdir(dir, { mode: 0o700 });
    owner.downloadDir = await privateDirectory(dir);
    owner.abort.signal.throwIfAborted();
    try {
      owner.context = await launch(profile, {
        executablePath, headless: false, chromiumSandbox: true, ignoreHTTPSErrors: false,
        serviceWorkers: 'block', acceptDownloads: true,
        downloadsPath: owner.downloadDir, timeout: navigationMs, args: ['--disable-quic'],
        ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
      });
    } catch {
      throw fail('BROWSER_LAUNCH', 'Не удалось открыть браузер с включённой защитой. Проверьте путь и доступность профиля.');
    }
    owner.context.on('close', () => {
      owner.contextClosed = true;
      if (!owner.finishing) {
        owner.abort.abort(fail('BROWSER_CLOSED', 'Окно браузера закрыто.'));
        if (owner.mode === 'login') void finish(owner).catch(() => {});
      }
    });
    const pages = owner.context.pages();
    owner.page = pages[0] ?? await owner.context.newPage();
    await Promise.all(pages.slice(1).map(page => page.close()));
    try {
      await protectBrowser(owner);
    } catch {
      throw fail('BROWSER_POLICY', 'Браузер не поддерживает проверку запросов и выгрузок. Проверьте версию Playwright и браузера.');
    }
    owner.abort.signal.throwIfAborted();
    await owner.page.goto(owner.config.url, { waitUntil: 'domcontentloaded', timeout: navigationMs });
    if (!permitted(owner, owner.page.url())) throw fail('BROWSER_POLICY', 'Открыт адрес вне списка разрешённых origin.');
  }

  function begin(input, mode, action, signal) {
    const config = validateBrowserConfig(input, { allowHttpLoopback: httpForTests });
    if (mode === 'read' && (!config.readySelector || !config.reportSelector)) {
      throw badConfig('Для чтения отчёта укажите маркер готовности и контейнер с результатом.');
    }
    if (signal?.aborted) throw fail('BROWSER_CANCELLED', 'Получение из браузера отменено.');
    const existing = sessions.get(config.id);
    if (existing) {
      if (mode === 'login' || !existing.idle || existing.recording || !existing.context || existing.contextClosed || existing.finishing) {
        throw fail('BROWSER_BUSY', 'Дождитесь завершения текущей работы браузера.');
      }
      if (!sameBrowserSettings(existing.config, config)) {
        throw fail('BROWSER_BUSY', 'Закройте окно входа и откройте его с текущими настройками источника.');
      }
      reportOrigin(existing);
    }
    const owner = existing ?? { allowHttpLoopback: httpForTests };
    Object.assign(owner, { config, mode, idle: false, abort: new AbortController() });
    const cancel = () => {
      owner.abort.abort(fail('BROWSER_CANCELLED', 'Получение из браузера отменено.'));
      if (owner.context && !owner.contextClosed) void owner.context.close().catch(() => {});
    };
    sessions.set(config.id, owner);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = mode === 'login' ? null : setTimeout(() => {
      owner.abort.abort(fail('BROWSER_TIMEOUT', 'Браузер не успел получить отчёт. Проверьте вход и выбранные элементы.'));
      if (owner.context && !owner.contextClosed) void owner.context.close().catch(() => {});
    }, runMs);
    owner.cancel = cancel;
    owner.done = (async () => {
      let keepOpen = false;
      try {
        owner.abort.signal.throwIfAborted();
        if (!existing) await openBrowser(owner);
        owner.abort.signal.throwIfAborted();
        const result = await action(owner);
        owner.abort.signal.throwIfAborted();
        keepOpen = mode === 'login';
        owner.idle = keepOpen;
        return result;
      } catch (error) {
        if (owner.abort.signal.aborted) throw owner.abort.signal.reason;
        if (owner.downloadFailure) throw owner.downloadFailure;
        if (error instanceof BrowserConnectorError) throw error;
        throw fail('BROWSER_ACTION', 'Браузер не открыл отчёт или не нашёл указанный элемент. Проверьте адрес, вход и настройки.');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (!keepOpen) await finish(owner);
      }
    })();
    return owner.done;
  }

  return {
    isOpen(id) {
      const owner = sessions.get(id);
      return Boolean(owner?.context && !owner.contextClosed && !owner.finishing);
    },
    isRecording(id) {
      const owner = sessions.get(id);
      return Boolean(owner?.recording && !owner.contextClosed && !owner.finishing);
    },
    async login(config, { signal } = {}) {
      return begin(config, 'login', async () => ({ open: true }), signal);
    },
    async close(configOrId) {
      const id = connectorId(typeof configOrId === 'string' ? configOrId : configOrId?.id);
      const owner = sessions.get(id);
      if (owner) {
        owner.cancel();
        await owner.done.catch(() => {});
        await finish(owner);
      }
      return { open: false };
    },
    async collect(config, { signal } = {}) {
      return begin(config, 'collect', collectReport, signal);
    },
    async read(config, { signal } = {}) {
      return begin(config, 'read', readReport, signal);
    },
    async startRecording(input) {
      const config = validateBrowserConfig(input, { allowHttpLoopback: httpForTests });
      const owner = sessions.get(config.id);
      if (!owner?.context || owner.contextClosed || owner.finishing) {
        throw fail('BROWSER_LOGIN_REQUIRED', 'Откройте окно входа и перейдите к отчёту перед записью.');
      }
      if (!owner.idle || owner.recording || !sameBrowserSettings(owner.config, config)) {
        throw fail('BROWSER_BUSY', 'Для записи нужно открытое окно входа с текущими настройками источника.');
      }
      reportOrigin(owner);
      const recording = {};
      owner.recording = recording;
      recording.pending = (async () => {
        if (config.readySelector && !await owner.page.locator(config.readySelector).isVisible()) {
          throw fail('BROWSER_LOGIN_REQUIRED', 'Завершите вход и дождитесь готовности отчёта.');
        }
        reportOrigin(owner);
        return startBrowserClickRecorder(owner.cdp, {
          origin: new URL(config.url).origin,
          authPattern: authField.source,
          validateSelector: checkedSelector,
        });
      })();
      try {
        await recording.pending;
        if (owner.contextClosed || owner.finishing) throw fail('BROWSER_CLOSED', 'Окно браузера закрыто.');
        return { recording: true };
      } catch (error) {
        if (owner.recording === recording) owner.recording = null;
        throw recordingError(error);
      }
    },
    async stopRecording(configOrId) {
      const id = connectorId(typeof configOrId === 'string' ? configOrId : configOrId?.id);
      const owner = sessions.get(id);
      const recording = owner?.recording;
      if (!recording) throw fail('BROWSER_RECORD_NONE', 'Запись действий ещё не начата.');
      if (recording.stopping) throw fail('BROWSER_BUSY', 'Запись уже завершается.');
      recording.stopping = true;
      try {
        const recorder = await recording.pending;
        const result = await recorder.stop();
        if (owner.contextClosed || owner.finishing) throw fail('BROWSER_CLOSED', 'Окно браузера закрыто.');
        return result;
      } catch (error) {
        throw recordingError(error);
      } finally {
        if (owner.recording === recording) owner.recording = null;
      }
    },
  };
}
