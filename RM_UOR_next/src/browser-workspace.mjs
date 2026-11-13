import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { captureCuratorWeeks, curatorWeekView, isReportWeek, validateCuratorWeeks } from './weekly-curators.mjs';
import { parseBrowserScenario, serializeBrowserScenario } from './browser-scenario.mjs';

const maxConnectors = 16;
const maxJobs = 64;
const maxProfiles = 4;
const maxDownloadBytes = 20 * 1024 * 1024;
const maxStateBytes = 8 * 1024 * 1024;
const maxReportLength = 100_000;
const kinds = new Set(['login', 'close', 'collect', 'read']);
const saveFields = new Set(['id', 'expectedRevision', 'name', 'curator', 'url', 'allowedOrigins', 'actions',
  'downloadSelector', 'readySelector', 'reportSelector', 'executablePath']);

const started = {
  login: 'Открываем личный браузер…', close: 'Закрываем личный браузер…',
  collect: 'Получаем файл отчёта…', read: 'Читаем выбранный раздел отчёта…'
};
const succeeded = {
  login: 'Браузер открыт. Выполните вход вручную.', close: 'Личный браузер закрыт.',
  collect: 'Файл добавлен в источники.', read: 'Текст отчёта сохранён на этом компьютере.'
};
const failures = new Map([
  ['BROWSER_RUNTIME', 'Проверьте настройку Playwright и путь к установленному браузеру.'],
  ['BROWSER_LAUNCH', 'Не удалось открыть личный браузер. Проверьте путь и доступность профиля.'],
  ['BROWSER_PRIVATE_DIRECTORY', 'Папка личного браузера должна быть обычным каталогом без ссылок.'],
  ['BROWSER_POLICY', 'Адрес или возможности браузера не соответствуют настройкам источника.'],
  ['BROWSER_BUSY', 'Личный браузер этого источника уже открыт или занят.'],
  ['BROWSER_CLOSED', 'Окно личного браузера закрыто.'],
  ['BROWSER_CANCELLED', 'Операция отменена.'],
  ['BROWSER_TIMEOUT', 'Не дождались отчёта. Проверьте вход и настройки источника.'],
  ['BROWSER_CLOSE', 'Не удалось закрыть окно личного браузера.'],
  ['BROWSER_ACTION', 'Один из шагов получения отчёта не выполнен. Проверьте селекторы.'],
  ['BROWSER_LOGIN_REQUIRED', 'Войдите в источник в открытом окне и повторите получение.'],
  ['BROWSER_INPUT_FORBIDDEN', 'Поля входа используются только вручную в личном браузере.'],
  ['BROWSER_DOWNLOAD_ORIGIN', 'Файл поступил с адреса вне списка разрешённых источников.'],
  ['BROWSER_DOWNLOAD_TOO_LARGE', 'Выгрузка превышает 20 МБ.'],
  ['BROWSER_DOWNLOAD_INVALID', 'Не удалось прочитать выгрузку XLSX. Проверьте настройки отчёта.'],
  ['BROWSER_IMPORT', 'Не удалось добавить файл в рабочее место. Проверьте формат выгрузки.'],
  ['BROWSER_READ_FORBIDDEN', 'Выберите контейнер отчёта вне формы входа.'],
  ['BROWSER_READ_TOO_LARGE', 'Выберите меньший раздел отчёта.'],
  ['BROWSER_READ_EMPTY', 'В выбранном разделе отчёта нет текста.'],
  ['BROWSER_CONFIG', 'Проверьте настройки источника, в том числе селекторы отчёта.']
]);

export class BrowserWorkspaceError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'BrowserWorkspaceError';
    this.code = code;
    this.status = status;
  }
}

const problem = (code, message, status = 400) => new BrowserWorkspaceError(message, code, status);
const invalidConfig = () => problem('INVALID_BROWSER_CONFIG', 'Проверьте название, HTTPS-адрес, разрешённые адреса и шаги источника.');
const busy = () => problem('BROWSER_BUSY', 'Дождитесь завершения операции или закройте окно источника.', 409);
const closed = () => problem('BROWSER_CLOSED', 'Личное рабочее место закрывается.', 503);
const storageError = () => problem('BROWSER_STORAGE', 'Не удалось сохранить или прочитать личные данные браузера.', 500);
const privateDirectoryError = () => problem('BROWSER_PRIVATE_DIRECTORY', 'Папка личного браузера должна быть обычным каталогом без ссылок.', 500);
const canceled = () => problem('BROWSER_CANCELLED', 'Операция отменена.', 409);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function runtimeConfig({ id, url, allowedOrigins, actions, downloadSelector, readySelector, reportSelector, executablePath }) {
  return { id, url, allowedOrigins, actions, downloadSelector, readySelector, reportSelector, executablePath };
}

function connectorName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalidConfig();
  return value.trim();
}

function curatorName(value = '') {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw problem('INVALID_BROWSER_CONFIG', 'Проверьте имя куратора для недельного отчёта.');
  }
  const name = value.trim().replace(/\s+/gu, ' ');
  if (name.length > 120) throw problem('INVALID_BROWSER_CONFIG', 'Имя куратора должно содержать до 120 символов.');
  return name;
}

function curatorKey(value) {
  return value.normalize('NFKC').toLocaleLowerCase('ru-RU').trim().replace(/\s+/gu, ' ');
}

function checkedConnector(input, id, revision, validateConfig) {
  const name = connectorName(input.name);
  const curator = curatorName(input.curator);
  let config;
  try {
    config = validateConfig(runtimeConfig({ ...input, id }));
  } catch {
    throw invalidConfig();
  }
  return { ...runtimeConfig(config), id, name, curator, revision };
}

async function statIfPresent(path) {
  return lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function checkDirectory(path) {
  try {
    const info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink() && relative(path, await realpath(path)) === '') return;
  } catch { /* The caller gets the same safe diagnostic for inaccessible paths. */ }
  throw privateDirectoryError();
}

async function createPrivateDirectory(path) {
  await checkDirectory(dirname(path));
  await mkdir(path, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw privateDirectoryError();
  });
  await checkDirectory(path);
}

function safeFilename(value) {
  return typeof value === 'string' && value.length <= 160 && /\.xlsx$/iu.test(value)
    && !/[\\/<>:"|?*\u0000-\u001f]/u.test(value);
}

function safeReportText(value, limit) {
  if (typeof value !== 'string' || value.length > limit) return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
}

function boundedJobs(jobs) {
  const lastFile = new Map();
  const protectedIds = new Set();
  for (const job of jobs) {
    if (job.state === 'running') protectedIds.add(job.id);
    if (job.kind === 'collect' && job.state === 'success') lastFile.set(job.connectorId, job.id);
  }
  for (const id of lastFile.values()) protectedIds.add(id);
  const budget = maxJobs - protectedIds.size;
  const recent = budget > 0 ? jobs.filter(job => !protectedIds.has(job.id)).slice(-budget) : [];
  for (const job of recent) protectedIds.add(job.id);
  return jobs.filter(job => protectedIds.has(job.id));
}

function checkedStoredState(value, validateConfig) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.connectors)
      || !Array.isArray(value.jobs) || !Array.isArray(value.reports)
      || value.connectors.length > maxConnectors || value.jobs.length > maxJobs
      || value.reports.length > maxConnectors) throw storageError();
  const connectors = value.connectors.map(item => {
    if (!isRecord(item) || typeof item.id !== 'string' || !Number.isSafeInteger(item.revision) || item.revision < 1) throw storageError();
    return checkedConnector(item, item.id, item.revision, validateConfig);
  });
  const ids = new Set(connectors.map(item => item.id));
  if (ids.size !== connectors.length) throw storageError();
  const curators = connectors.map(item => curatorKey(item.curator)).filter(Boolean);
  if (new Set(curators).size !== curators.length) throw storageError();
  const jobs = value.jobs.map(job => {
    if (!isRecord(job) || typeof job.id !== 'string' || !ids.has(job.connectorId) || !kinds.has(job.kind)
        || !['running', 'error', 'success'].includes(job.state) || typeof job.message !== 'string' || job.message.length > 350) throw storageError();
    const { id, connectorId, kind, state, message } = job;
    if (state === 'running') return { id, connectorId, kind, state: 'error', message: 'Операция прервалась при завершении работы.' };
    const result = { id, connectorId, kind, state, message };
    if (kind === 'collect' && state === 'success') {
      if (!safeFilename(job.fileName) || typeof job.sourceId !== 'string' || !/^[a-f0-9]{64}$/u.test(job.sourceId)) throw storageError();
      Object.assign(result, { fileName: job.fileName, sourceId: job.sourceId });
    }
    return result;
  });
  const reports = value.reports.map(report => {
    if (!isRecord(report) || !ids.has(report.connectorId) || typeof report.id !== 'string'
        || !safeReportText(report.text, maxReportLength) || !safeReportText(report.title, 300)
        || typeof report.collectedAt !== 'string' || !Number.isFinite(Date.parse(report.collectedAt))) throw storageError();
    return { id: report.id, connectorId: report.connectorId, name: connectorName(report.name),
      title: report.title, text: report.text, collectedAt: report.collectedAt };
  });
  const curatorWeeks = validateCuratorWeeks(value.curatorWeeks ?? [], ids);
  const savedRecordings = value.recordings ?? [];
  if (!Array.isArray(savedRecordings) || savedRecordings.length > connectors.length) throw storageError();
  const recordings = savedRecordings.map(({ connectorId, ...scenario }) => {
    if (!ids.has(connectorId)) throw storageError();
    const { actions, downloadSelector } = parseBrowserScenario(serializeBrowserScenario(scenario));
    return { connectorId, actions, ...(downloadSelector ? { downloadSelector } : {}) };
  });
  if (new Set(recordings.map(item => item.connectorId)).size !== recordings.length) throw storageError();
  return { schemaVersion: 1, connectors, jobs, reports, curatorWeeks, recordings };
}

async function readState(path, validateConfig) {
  try {
    const file = await statIfPresent(path);
    if (!file) return { schemaVersion: 1, connectors: [], jobs: [], reports: [], curatorWeeks: [], recordings: [] };
    if (!file.isFile() || file.isSymbolicLink() || file.nlink > 1 || file.size > maxStateBytes) throw storageError();
    return checkedStoredState(JSON.parse(await readFile(path, 'utf8')), validateConfig);
  } catch {
    throw storageError();
  }
}

async function writeState(path, next) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await checkDirectory(dirname(path));
    const file = await statIfPresent(path);
    if (file && (!file.isFile() || file.isSymbolicLink() || file.nlink > 1)) throw storageError();
    const bytes = JSON.stringify(next, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > maxStateBytes) throw storageError();
    await writeFile(temporary, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch {
    throw storageError();
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function openBrowserWorkspace({ privateRoot, runtime, validateConfig, importSource }) {
  if (typeof privateRoot !== 'string' || !isAbsolute(privateRoot)) throw privateDirectoryError();
  const root = resolve(privateRoot);
  await createPrivateDirectory(root);
  const path = join(root, 'workspace.json');
  let state = await readState(path, validateConfig);
  let queue = Promise.resolve();
  let stopping = false;
  let stopped;
  const active = new Map();

  function serialized(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }

  async function commit(next) {
    await writeState(path, next);
    state = next;
  }

  function openProfiles() {
    return state.connectors.filter(connector => runtime.isOpen(connector.id)).map(connector => connector.id);
  }

  function getState() {
    const open = openProfiles();
    const recordings = state.connectors.flatMap(connector => {
      const active = open.includes(connector.id) && runtime.isRecording?.(connector.id) === true;
      const saved = state.recordings.find(item => item.connectorId === connector.id);
      return active || saved ? [{ connectorId: connector.id, actions: [], ...saved, active }] : [];
    });
    return structuredClone({ connectors: state.connectors, jobs: state.jobs, reports: state.reports, recordings, openProfiles: open });
  }

  function getCuratorWeek(week) {
    if (!isReportWeek(week)) throw problem('INVALID_REPORT_WEEK', 'Выберите дату начала недели (понедельник).');
    return structuredClone(curatorWeekView(week, state.connectors, state.curatorWeeks, curatorKey));
  }

  function findConnector(id) {
    const connector = state.connectors.find(item => item.id === id);
    if (!connector) throw problem('BROWSER_NOT_FOUND', 'Браузерный источник не найден.', 404);
    return connector;
  }

  async function save(input) {
    if (Object.keys(input).some(key => !saveFields.has(key))) throw invalidConfig();
    const existing = input.id ? findConnector(input.id) : null;
    const expected = input.expectedRevision ?? 0;
    if (expected !== (existing?.revision ?? 0)) throw problem('CONFLICT', 'Настройки источника изменились. Откройте их заново.', 409);
    if (existing && (active.has(existing.id) || runtime.isOpen(existing.id))) throw busy();
    if (!existing && state.connectors.length >= maxConnectors) {
      throw problem('INVALID_BROWSER_CONFIG', `В этой установке можно настроить до ${maxConnectors} браузерных источников.`);
    }
    const connector = checkedConnector({ ...input, curator: input.curator === undefined ? existing?.curator : input.curator },
      existing?.id ?? randomUUID(), expected + 1, validateConfig);
    const key = curatorKey(connector.curator);
    if (key && state.connectors.some(item => item.id !== connector.id && curatorKey(item.curator) === key)) {
      throw problem('CONFLICT', 'У этого куратора уже есть браузерное подключение для недельного отчёта.', 409);
    }
    const connectors = existing ? state.connectors.map(item => item.id === connector.id ? connector : item)
      : [...state.connectors, connector];
    const recordings = existing && existing.url !== connector.url
      ? state.recordings.filter(item => item.connectorId !== connector.id) : state.recordings;
    await commit({ ...state, connectors, recordings });
  }

  async function recording(action, connector) {
    const { id } = connector;
    if (active.has(id)) throw busy();
    if (!runtime.isOpen(id)) throw problem('BROWSER_LOGIN_REQUIRED', 'Откройте окно входа и перейдите на страницу отчёта.');
    let result;
    try {
      if (action === 'record') await runtime.startRecording(runtimeConfig(connector));
      else result = await runtime.stopRecording(id);
    } catch (error) {
      const message = failures.get(error.code) ?? 'Запись недоступна. Откройте страницу отчёта после входа и попробуйте снова.';
      throw problem(error.code ?? 'BROWSER_RECORD', message, 409);
    }
    if (action === 'record') return;
    if (!result?.actions?.length && !result?.downloadSelector) {
      throw problem('BROWSER_RECORD_EMPTY', 'Ни одного шага не записано. Нажимайте элементы на странице отчёта.');
    }
    const { actions, downloadSelector } = parseBrowserScenario(serializeBrowserScenario(result));
    const saved = { connectorId: id, actions, ...(downloadSelector ? { downloadSelector } : {}) };
    const recordings = [...state.recordings.filter(item => item.connectorId !== id), saved];
    await commit({ ...state, recordings });
  }

  async function collect(task, config, signal) {
    const downloaded = await runtime.collect(config, { signal });
    signal.throwIfAborted();
    const { filename, bytes } = downloaded ?? {};
    if (!safeFilename(filename) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxDownloadBytes) {
      throw problem('BROWSER_DOWNLOAD_INVALID', 'Полученный файл не поддерживается.');
    }
    task.importing = true;
    const sourceId = createHash('sha256').update(bytes).digest('hex');
    try {
      const result = await importSource(filename, bytes);
      if (!Array.isArray(result?.sources) || !result.sources.some(source => source.id === sourceId)) throw storageError();
    } catch {
      throw problem('BROWSER_IMPORT', 'Не удалось добавить файл в рабочее место.');
    }
    return { fileName: filename, sourceId };
  }

  async function perform(job, connector, task) {
    const signal = task.controller.signal;
    signal.throwIfAborted();
    const config = runtimeConfig(connector);
    if (job.kind === 'close') {
      await runtime.close(connector.id);
      return {};
    }
    if (job.kind === 'login') {
      await runtime.login(config, { signal });
      signal.throwIfAborted();
      return {};
    }
    if (job.kind === 'collect') return collect(task, config, signal);
    const result = await runtime.read(config, { signal });
    signal.throwIfAborted();
    if (typeof result?.text === 'string' && result.text.length > maxReportLength) throw problem('BROWSER_READ_TOO_LARGE', 'Раздел слишком большой.');
    const text = safeReportText(result?.text, maxReportLength);
    if (!text) throw problem('BROWSER_READ_EMPTY', 'В отчёте нет текста.');
    return { report: { id: randomUUID(), connectorId: connector.id, name: connector.name,
      title: safeReportText(result.title, 300) || connector.name, text, collectedAt: new Date().toISOString() }, connector };
  }

  async function finish(job, task, result, error) {
    return serialized(async () => {
      if (task.controller.signal.aborted && !task.importing) error = canceled();
      const weekly = !error && result.report
        ? captureCuratorWeeks(state.curatorWeeks, result.connector, result.report.text, curatorKey) : null;
      const message = weekly && result.connector.curator
        ? weekly.captured ? `Сохранено недель в отчёте куратора: ${weekly.captured}.`
          : 'Текст сохранён. Для недельной сводки нужен диапазон дат и блоки отчёта в выбранном разделе.'
        : succeeded[job.kind];
      const outcome = error
        ? { ...job, state: 'error', message: failures.get(error.code) ?? 'Операция не завершилась. Проверьте настройки источника и вход.' }
        : { ...job, state: 'success', message,
          ...(result.sourceId ? { sourceId: result.sourceId, fileName: result.fileName } : {}) };
      const jobs = boundedJobs(state.jobs.map(item => item.id === job.id ? outcome : item));
      const reports = !error && result.report
        ? [...state.reports.filter(item => item.connectorId !== job.connectorId), result.report] : state.reports;
      try {
        await commit({ ...state, jobs, reports, curatorWeeks: weekly?.archive ?? state.curatorWeeks });
      } catch {
        state = { ...state, jobs: jobs.map(item => item.id === job.id
          ? { ...job, state: 'error', message: 'Не удалось сохранить состояние операции. Проверьте список источников.' } : item) };
      }
    });
  }

  function launch(kind, connector) {
    if (kind !== 'close' && runtime.isRecording?.(connector.id)) {
      throw problem('BROWSER_BUSY', 'Сначала остановите запись шагов.', 409);
    }
    const previous = active.get(connector.id);
    if (previous && (kind !== 'close' || previous.kind === 'close' || previous.importing)) throw busy();
    if (kind === 'login' && runtime.isOpen(connector.id)) throw busy();
    const occupied = new Set([...active.keys(), ...openProfiles()]);
    if (kind !== 'close' && !occupied.has(connector.id) && occupied.size >= maxProfiles) throw busy();
    if (previous) previous.controller.abort(canceled());

    const job = { id: randomUUID(), connectorId: connector.id, kind, state: 'running', message: started[kind] };
    const task = { kind, controller: new AbortController(), importing: false };
    active.set(connector.id, task);
    state = { ...state, jobs: boundedJobs([...state.jobs, job]) };
    task.done = Promise.resolve().then(async () => {
      let result;
      let error;
      try {
        if (previous) await previous.done;
        result = await perform(job, connector, task);
      } catch (cause) {
        error = cause ?? problem('BROWSER_ACTION', 'Операция прервана.');
      }
      try {
        await finish(job, task, result, error);
      } finally {
        if (active.get(connector.id) === task) active.delete(connector.id);
      }
    });
  }

  function execute(action, input = {}) {
    return serialized(async () => {
      if (stopping) throw closed();
      if (!isRecord(input)) throw invalidConfig();
      if (action === 'save') await save(input);
      else if (action === 'record' || action === 'record-stop') await recording(action, findConnector(input.id));
      else if (kinds.has(action)) launch(action, findConnector(input.id));
      else throw problem('BROWSER_NOT_FOUND', 'Действие браузера не найдено.', 404);
      return getState();
    });
  }

  function shutdown() {
    if (!stopped) {
      stopping = true;
      stopped = serialized(() => [...active.values()]).then(async tasks => {
        for (const task of tasks) if (!task.importing) task.controller.abort(canceled());
        await Promise.allSettled(tasks.map(task => task.done));
        await Promise.allSettled(openProfiles().map(id => runtime.close(id)));
      });
    }
    return stopped;
  }

  return { getState, getCuratorWeek, execute, shutdown };
}
