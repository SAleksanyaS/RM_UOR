import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { openWorkbook, parseGoalMap } from './imports.mjs';
import { readStatusRegister } from './status-register.mjs';
import { compareStatusSnapshots, registerKey } from './status-snapshots.mjs';
import { validateCards } from './visualization-config.mjs';
import { projectGoalStatuses } from '../public/goal-status.js';
import * as nativeGit from './shared-git.mjs';

export const appVersion = '0.1.0';
export const maxSourceBytes = 20 * 1024 * 1024;

export class WorkspaceError extends Error {
  constructor(message, code = 'INVALID', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const dit = { id: 'dit', name: 'ДИТ OPS', type: 'dit' };
const themes = new Set(['system', 'indigo', 'slate', 'sand', 'forest', 'dark']);
const ditStatusValues = new Set(['', 'Выполнено', 'Под риском', 'В плане', 'Не выполнено', 'Нет методики']);
const excludedDitGoals = new Set(['monitor', 'removed', 'outOfScope']);
const emptyShared = () => ({ revision: null, version: 0, goals: [], ditStatuses: [], history: [], checkedAt: null, error: null });
const blank = () => ({
  schemaVersion: 1,
  profile: { name: '', remote: '', branch: 'main', refreshMinutes: 30, theme: 'indigo', gitExecutable: '', gitAuth: 'system' },
  catalogSourceId: null,
  catalog: [],
  goalEdits: {},
  directory: [dit],
  drafts: {},
  sources: [],
  statusDates: {},
  statusLinks: {},
  ditDrafts: [],
  automations: {},
  runs: {},
  shared: emptyShared()
});

function string(value, limit, field, required = false) {
  if (value == null) value = '';
  if (typeof value !== 'string' || value.trim().length > limit || (required && !value.trim())) {
    throw new WorkspaceError(`Проверьте поле «${field}».`);
  }
  return value.trim();
}

function isoDate(value, label = 'Дата факта') {
  const date = string(value, 10, label, true);
  const parsed = new Date(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) {
    throw new WorkspaceError(`${label} должна быть действительной датой.`);
  }
  return date;
}

function number(value, min, max, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new WorkspaceError(`Проверьте число в поле «${field}».`);
  }
  return value;
}

function integer(value, min, max, field) {
  if (!Number.isInteger(value)) throw new WorkspaceError(`Введите целое число в поле «${field}».`);
  return number(value, min, max, field);
}

function themeValue(value) {
  if (value === 'light') return 'indigo';
  if (!themes.has(value)) throw new WorkspaceError('Выберите одну из доступных тем.');
  return value;
}

function validatedId(value, label) {
  const id = string(value, 200, label, true);
  if (['__proto__', 'prototype', 'constructor'].includes(id) || /[\u0000-\u001f]/.test(id)) {
    throw new WorkspaceError(`Недопустимый идентификатор. Проверьте поле «${label}».`);
  }
  return id;
}

const now = () => new Date().toISOString();
const identity = row => JSON.stringify([row.scopeId, row.period]);
const sameResult = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const safeError = error => error instanceof Error ? error.message : 'Проверьте настройки подключения.';
const byId = entries => new Map(entries.map(entry => [entry.id, entry]));
const ditStatusKey = row => JSON.stringify([row.goalId, row.period]);
const validDitPeriod = period => /^(?:Q[1-4] 20\d{2}|Y\d{2})$/u.test(period);
const publicDitStatus = ({ goalId, period, status, revision }) => ({ goalId, period, status, revision });

function readMap(bytes) {
  const imported = parseGoalMap(bytes);
  for (const goal of imported.goals) validatedId(goal.id, 'Цель');
  return imported;
}

async function activateLegacyMap(state, sourceDir) {
  if (Object.hasOwn(state, 'catalogSourceId')) return state;
  const source = state.sources.findLast(entry => entry.type === 'html');
  if (source && /^[a-f0-9]{64}$/.test(source.id)) {
    try {
      const bytes = await readFile(join(sourceDir, source.id));
      if (createHash('sha256').update(bytes).digest('hex') === source.id) {
        return { ...state, catalogSourceId: source.id, catalog: readMap(bytes).goals };
      }
    } catch {
      // Keep the originals and overlays available so the user can reload the map.
    }
  }
  return { ...state, catalogSourceId: null, catalog: [] };
}

function statusLinkKey(entry) {
  const key = registerKey(entry);
  return key && `${entry.period}:${key}`;
}

function assignedLeader(goal, leaderId) {
  return goal?.assignments?.some(item => item.leaderId === leaderId && item.active !== false) ?? false;
}

function putRow(rows, row) {
  return [...rows.filter(existing => identity(existing) !== identity(row)), row];
}

function publicResult(row) {
  const { scopeId, period, value, status, plan, comment, risk, asOf, author, savedAt, mode } = row;
  return { scopeId, period, value, status, plan, comment, risk, asOf, author, savedAt, mode };
}

function resultFields(input) {
  if (!input || typeof input !== 'object') throw new WorkspaceError('Некорректный результат.');
  return {
    scopeId: validatedId(input.scopeId, 'Участник'),
    period: string(input.period, 60, 'Период', true),
    value: input.value == null ? null : number(input.value, 0, 1000000, 'Процент'),
    status: string(input.status, 80, 'Статус'),
    plan: string(input.plan, 2000, 'План'),
    comment: string(input.comment, 4000, 'Комментарий'),
    risk: string(input.risk, 2000, 'Риск'),
    asOf: isoDate(input.asOf)
  };
}

function normalizeShared(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.goals) || !Array.isArray(snapshot.history)
      || (snapshot.revision !== null && (typeof snapshot.revision !== 'string' || !snapshot.revision))) {
    throw new WorkspaceError('В репозитории нет корректного набора общих данных.', 'INVALID_SHARED', 409);
  }
  const goals = snapshot.goals.map(goal => {
    if (!Array.isArray(goal?.results)) throw new WorkspaceError('В общей версии отсутствуют результаты цели.', 'INVALID_SHARED', 409);
    const results = goal.results.map(row => ({
      ...resultFields(row),
      author: string(row.author, 120, 'Автор'),
      savedAt: string(row.savedAt, 32, 'Время сохранения'),
      mode: row.mode === 'automatic' ? 'automatic' : 'manual'
    }));
    if (new Set(results.map(identity)).size !== results.length) {
      throw new WorkspaceError('В общей версии повторяется результат участника за один период.', 'INVALID_SHARED', 409);
    }
    return { id: validatedId(goal.id, 'Цель'), title: string(goal.title, 400, 'Название цели', true), results };
  });
  const incomingDit = snapshot.ditStatuses === undefined ? [] : snapshot.ditStatuses;
  if (!Array.isArray(incomingDit)) {
    throw new WorkspaceError('В общей версии некорректны статусы ДИТ.', 'INVALID_SHARED', 409);
  }
  const ditStatuses = incomingDit.map(row => {
    if (!row || typeof row.period !== 'string' || !validDitPeriod(row.period) ||
        !ditStatusValues.has(row.status) || typeof row.revision !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row.revision)) {
      throw new WorkspaceError('В общей версии некорректна запись статуса ДИТ.', 'INVALID_SHARED', 409);
    }
    return { ...publicDitStatus(row), goalId: validatedId(row.goalId, 'Цель ДИТ') };
  });
  if (new Set(ditStatuses.map(ditStatusKey)).size !== ditStatuses.length) {
    throw new WorkspaceError('В общей версии повторяется статус цели ДИТ за один период.', 'INVALID_SHARED', 409);
  }
  return {
    revision: snapshot.revision,
    version: integer(snapshot.version, 0, Number.MAX_SAFE_INTEGER, 'Версия'),
    history: snapshot.history.map(entry => ({
      version: integer(entry.version, 1, Number.MAX_SAFE_INTEGER, 'Версия'),
      author: string(entry.author, 120, 'Автор', true),
      at: string(entry.publishedAt ?? entry.at, 32, 'Дата выпуска', true),
      goalIds: Array.isArray(entry.goalIds) ? entry.goalIds.map(id => validatedId(id, 'Цель')) : []
    })),
    goals, ditStatuses,
    checkedAt: now(),
    error: null
  };
}

function hasSharedRollback(previous, next) {
  if (previous.revision === null) return false;
  return next.revision === null || next.version < previous.version
    || (next.version === previous.version && !sameResult(previous.goals, next.goals))
    || (next.version === previous.version && !sameResult(previous.ditStatuses ?? [], next.ditStatuses ?? []))
    || (next.version === previous.version && previous.history.length !== next.history.length)
    || !previous.history.every((entry, index) => sameResult(entry, next.history[index]));
}

function connection(profile, dataDir) {
  if (!profile.remote) throw new WorkspaceError('Укажите репозиторий в разделе «Настройки».', 'NO_REMOTE', 409);
  return {
    remote: profile.remote, branch: profile.branch, cacheDir: join(dataDir, 'git'),
    ...(profile.gitExecutable ? { gitExecutable: profile.gitExecutable } : {})
  };
}

function columnNumber(value) {
  const letter = string(value, 3, 'Столбец', true).toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(letter)) throw new WorkspaceError('Укажите столбец буквами Excel, например A или AA.');
  const index = [...letter].reduce((acc, char) => acc * 26 + char.charCodeAt(0) - 64, 0);
  if (index > 16384) throw new WorkspaceError('Столбец выходит за пределы листа Excel.');
  return { letter, index: index - 1 };
}

function normalizedName(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function scopeLookup(directory, raw) {
  const key = normalizedName(raw);
  const id = directory.find(scope => normalizedName(scope.id) === key);
  if (id) return id;
  const matches = directory.filter(scope => {
    const name = normalizedName(scope.name);
    if (name === key || scope.aliases?.some(alias => normalizedName(alias) === key)) return true;
    const [last, first] = name.split(' ');
    return scope.type === 'leader' && first && key === `${last} ${first[0]}`;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function fromCell(cell, scale, row) {
  const percentText = typeof cell === 'string' && /^\s*\d+(?:[.,]\d+)?\s*%?\s*$/.test(cell);
  if (typeof cell !== 'number' && !percentText) {
    throw new WorkspaceError(`Строка ${row}. Ожидается процент или число.`);
  }
  const numeric = typeof cell === 'number' ? cell : Number(cell.replace('%', '').replace(',', '.').trim());
  const factor = scale === 'fraction' && !(typeof cell === 'string' && cell.includes('%')) ? 100 : 1;
  return number(Math.round(numeric * factor * 1000000) / 1000000, 0, 1000000, `Процент в строке ${row}`);
}

async function saveState(path, next) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function openWorkspace({ dataDir, git = nativeGit }) {
  const sourceDir = join(dataDir, 'sources');
  const statePath = join(dataDir, 'workspace.json');
  await mkdir(sourceDir, { recursive: true });
  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state.schemaVersion !== 1) throw new Error('Неизвестный формат локальных данных.');
    state = await activateLegacyMap(state, sourceDir);
    const { ditStatuses: oldDitStatuses, ...rest } = state;
    state = {
      ...rest,
      profile: { gitExecutable: '', gitAuth: 'system', ...state.profile },
      ditDrafts: state.ditDrafts ?? (oldDitStatuses ?? []).map(row => ({ ...row, base: null, target: null }))
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = blank();
  }

  let queue = Promise.resolve();
  let connectionGeneration = 0;
  let pendingRefresh;
  const registerCache = new Map();
  function serialized(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  }

  async function commit(next) {
    await saveState(statePath, next);
    state = next;
  }

  function catalogGoal(goalId) {
    const id = validatedId(goalId, 'Цель');
    const goal = state.catalog.find(entry => entry.id === id);
    if (!goal) throw new WorkspaceError('Цель не найдена. Загрузите карту в разделе «Источники».', 'NOT_FOUND', 404);
    return { ...goal, ...state.goalEdits?.[id] };
  }

  function scopeEntry(scopeId) {
    const found = state.directory.find(entry => entry.id === scopeId);
    if (!found) throw new WorkspaceError('Участник не найден. Проверьте справочник.');
    return found;
  }

  function sharedRows(goalId, shared = state.shared) {
    return shared.goals.find(goal => goal.id === goalId)?.results ?? [];
  }

  function getState() {
    const goalIds = new Set(state.catalog.map(goal => goal.id));
    const activeDitIds = new Set(state.catalog.filter(goal => !excludedDitGoals.has(goal.status)).map(goal => goal.id));
    const { goals: _published, ditStatuses: sharedDit = [], history, ...shared } = state.shared;
    const ditPublished = sharedDit.filter(row => activeDitIds.has(row.goalId));
    const ditDrafts = state.ditDrafts.filter(row => activeDitIds.has(row.goalId)).map(publicDitStatus);
    const displayedDit = new Map(ditPublished.map(row => [ditStatusKey(row), row]));
    for (const row of ditDrafts) displayedDit.set(ditStatusKey(row), row);
    return structuredClone({
      appVersion,
      profile: state.profile,
      shared: { ...shared, history: history.map(entry => ({ ...entry, goalIds: entry.goalIds.filter(id => goalIds.has(id)) })) },
      catalogSourceId: state.catalogSourceId,
      directory: state.directory,
      sources: state.sources,
      statusSnapshots: datedStatusSources(),
      ditStatuses: [...displayedDit.values()],
      ditPublished, ditDrafts,
      automations: Object.fromEntries(Object.entries(state.automations).filter(([id]) => goalIds.has(id))),
      visualization: state.visualization ?? { revision: null, cards: null },
      goals: state.catalog.map(goal => ({
        description: '', scope: '', method: '', target: '', links: [], curators: [], assignments: [],
        ...goal, ...state.goalEdits?.[goal.id],
        published: sharedRows(goal.id),
        local: (state.drafts[goal.id] ?? []).map(publicResult),
        automatic: state.runs[goal.id]?.rows ?? []
      }))
    });
  }

  function findSource(id) {
    const source = state.sources.find(entry => entry.id === id);
    if (!source) throw new WorkspaceError('Исходник не найден.', 'NOT_FOUND', 404);
    return source;
  }

  async function readOriginal(id) {
    const source = findSource(id);
    return { source, bytes: await readFile(join(sourceDir, source.id)) };
  }

  async function importSource(fileName, bytes) {
    return serialized(async () => {
      const name = string(fileName, 200, 'Имя файла', true);
      if (/[\\/\u0000-\u001f]/.test(name)) throw new WorkspaceError('Недопустимое имя исходника.');
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxSourceBytes) {
        throw new WorkspaceError('Выберите файл размером до 20 МБ.');
      }
      const suffix = extname(name).toLowerCase();
      const extension = suffix === '.htm' ? '.html' : suffix;
      if (!['.html', '.xlsx'].includes(extension)) throw new WorkspaceError('Поддерживаются карта целей HTML и книга XLSX.');
      const id = createHash('sha256').update(bytes).digest('hex');
      const existingSource = state.sources.find(source => source.id === id);
      if (existingSource && extension === '.xlsx') return getState();

      let sheets = [];
      let catalog = state.catalog;
      let catalogSourceId = state.catalogSourceId;
      let directory = state.directory;
      try {
        if (extension === '.xlsx') {
          sheets = openWorkbook(bytes).sheets;
        } else {
          const imported = readMap(bytes);
          catalog = imported.goals;
          catalogSourceId = id;
          const entries = byId(directory);
          for (const entry of imported.directory) {
            if (entry.id !== dit.id && !entries.get(entry.id)?.edited) entries.set(entry.id, entry);
          }
          directory = [...entries.values()];
        }
      } catch (error) {
        throw new WorkspaceError(safeError(error));
      }

      try {
        await writeFile(join(sourceDir, id), bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      await commit({
        ...state, catalog, catalogSourceId, directory,
        sources: existingSource ? state.sources : [...state.sources, { id, name, size: bytes.length, type: extension.slice(1), uploadedAt: now(), sheets }]
      });
      return getState();
    });
  }

  async function readPreview(id, sheet, offset) {
    const { source, bytes } = await readOriginal(id);
    if (source.type !== 'xlsx') throw new WorkspaceError('Предпросмотр таблицы доступен для XLSX.');
    try {
      return openWorkbook(bytes).preview(sheet || undefined, offset, 100);
    } catch (error) {
      throw new WorkspaceError(safeError(error));
    }
  }

  function datedStatusSources(view = state) {
    return view.sources.flatMap(source => {
      const date = view.statusDates?.[source.id];
      return date ? [{ id: source.id, name: source.name, asOf: date.asOf, periods: date.periods }] : [];
    }).sort((left, right) => right.asOf.localeCompare(left.asOf) || left.name.localeCompare(right.name, 'ru'));
  }

  function statusSourceCandidates(sourceId, view) {
    if (sourceId) return [findSource(sourceId)];
    const dated = datedStatusSources(view);
    if (dated.length) {
      if (dated[0].asOf === dated[1]?.asOf) {
        throw new WorkspaceError('У нескольких книг одна дата среза. Выберите книгу для просмотра.', 'STATUS_SOURCE_CHOICE', 409);
      }
      return [findSource(dated[0].id)];
    }
    return view.sources.filter(source => source.type === 'xlsx').reverse();
  }

  async function statusRegister(sourceId, view = state) {
    const candidates = statusSourceCandidates(sourceId, view);
    for (const source of candidates) {
      if (source.type !== 'xlsx') throw new WorkspaceError('Реестр статусов читается из XLSX.');
      if (!registerCache.has(source.id)) {
        let parsed;
        try {
          parsed = readStatusRegister((await readOriginal(source.id)).bytes);
        } catch (error) {
          if (error.code !== 'UNSUPPORTED_STATUS_LAYOUT') throw new WorkspaceError(safeError(error), 'STATUS_REGISTER', 422);
          parsed = null;
        }
        if (registerCache.size >= 3) registerCache.delete(registerCache.keys().next().value);
        registerCache.set(source.id, parsed);
      }
      const register = registerCache.get(source.id);
      if (!register) continue;

      const goals = byId(view.catalog);
      const keys = register.entries.map(statusLinkKey);
      const occurrences = new Map();
      for (const key of keys) occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
      const snapshot = view.statusDates?.[source.id];
      const ditName = normalizedName(view.directory.find(item => item.id === 'dit')?.name || dit.name);
      const ditLabels = new Set([ditName, `итог ${ditName}`, `итого ${ditName}`, `${ditName} (итого)`, `накопительный итог ${ditName}`]);
      const entries = register.entries.map((entry, index) => {
        const key = keys[index];
        const ambiguous = !key || occurrences.get(key) > 1;
        const link = ambiguous ? null : view.statusLinks?.[key];
        const goal = ambiguous ? null : goals.get(link ? link.goalId : entry.goalId);
        const leaderName = normalizedName(entry.leader);
        const matches = !link && leaderName && goal
          ? view.directory.filter(item => item.type === 'leader' && (
            normalizedName(item.name) === leaderName || item.aliases?.some(alias => normalizedName(alias) === leaderName)
          ) && assignedLeader(goal, item.id))
          : [];
        const assigned = link?.scopeId && assignedLeader(goal, link.scopeId)
          && view.directory.some(item => item.id === link.scopeId && item.type === 'leader');
        const ditTotal = goal && !link?.scopeId && ditLabels.has(leaderName);
        const scopeId = assigned ? link.scopeId : ditTotal ? 'dit' : matches.length === 1 ? matches[0].id : null;
        const linkState = ambiguous ? 'ambiguous' : link
          ? (goal ? 'confirmed' : link.goalId === null ? 'unlinked' : 'pending')
          : goal ? 'suggested' : 'pending';
        return { ...entry, goalId: goal?.id ?? null, scopeId, linkState, linkRevision: link?.revision ?? null };
      });
      return {
        ...register, source: { id: source.id, name: source.name }, entries,
        asOf: snapshot?.asOf ?? null, snapshotRevision: snapshot?.revision ?? null
      };
    }
    if (sourceId) throw new WorkspaceError('В книге нет листа с поддерживаемой структурой реестра статусов.', 'STATUS_REGISTER', 422);
    return null;
  }

  async function setStatusDate(input) {
    const sourceId = validatedId(input.sourceId, 'Книга Excel');
    const register = await statusRegister(sourceId);
    const current = state.statusDates?.[sourceId];
    if (input.expectedRevision !== (current?.revision ?? null)) {
      throw new WorkspaceError('Дата среза изменилась. Сверьте её перед сохранением.', 'CONFLICT', 409);
    }
    const asOf = isoDate(input.asOf, 'Дата среза');
    if (current?.asOf === asOf) return;
    const next = { asOf, periods: register.periods, revision: randomUUID(), savedAt: now(), author: state.profile.name };
    await commit({ ...state, statusDates: { ...state.statusDates, [sourceId]: next } });
  }

  async function setStatusLink(input) {
    const sourceId = validatedId(input.sourceId, 'Книга Excel');
    const register = await statusRegister(sourceId);
    const row = register.entries.find(entry => entry.id === input.entryId);
    if (!row) throw new WorkspaceError('Строка реестра не найдена.', 'NOT_FOUND', 404);
    if (row.linkState === 'ambiguous') throw new WorkspaceError('Уточните дублирующиеся или неполные строки в книге.');
    const key = statusLinkKey(row);
    if (input.expectedRevision !== row.linkRevision) {
      throw new WorkspaceError('Связь изменилась. Откройте строку заново и проверьте её.', 'CONFLICT', 409);
    }
    const goalId = input.goalId === null ? null : validatedId(input.goalId, 'Цель');
    const goal = goalId ? state.catalog.find(item => item.id === goalId) : null;
    if (goalId && !goal) throw new WorkspaceError('Выберите цель из загруженной карты.');
    const scopeId = input.scopeId ? validatedId(input.scopeId, 'Руководитель') : null;
    if (scopeId && (!assignedLeader(goal, scopeId) || scopeEntry(scopeId).type !== 'leader')) {
      throw new WorkspaceError('Выберите руководителя, назначенного на эту цель.');
    }
    const next = { goalId, scopeId, revision: randomUUID(), sourceId, sourceRow: row.sourceRow, savedAt: now(), author: state.profile.name };
    await commit({ ...state, statusLinks: { ...state.statusLinks, [key]: next } });
  }

  async function setDitStatuses(input) {
    const period = string(input.period, 12, 'Период', true);
    if (!validDitPeriod(period)) throw new WorkspaceError('Выберите квартал или год.');
    if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 200) {
      throw new WorkspaceError('Выберите от 1 до 200 целей для сохранения статусов.');
    }

    const rows = new Map(state.ditDrafts.map(row => [ditStatusKey(row), row]));
    const published = new Map((state.shared.ditStatuses ?? []).map(row => [ditStatusKey(row), row]));
    const seen = new Set();
    let changed = false;
    for (const change of input.changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change) || typeof change.status !== 'string') {
        throw new WorkspaceError('Проверьте статус цели ДИТ.');
      }
      const goal = catalogGoal(change.goalId);
      if (excludedDitGoals.has(goal.status)) throw new WorkspaceError('Статус доступен для действующей цели ДИТ.');
      if (seen.has(goal.id)) throw new WorkspaceError('Выберите один статус для каждой цели ДИТ.');
      seen.add(goal.id);

      const status = change.status.trim();
      if (!ditStatusValues.has(status)) throw new WorkspaceError('Выберите статус из списка.');
      const row = { goalId: goal.id, period, status };
      const key = ditStatusKey(row);
      const draft = rows.get(key);
      const accepted = published.get(key) ?? null;
      const current = draft ?? accepted;
      if (change.expectedRevision !== (current?.revision ?? null)) {
        throw new WorkspaceError('Статус цели ДИТ изменился. Обновите таблицу и проверьте правки.', 'CONFLICT', 409);
      }
      const { remote, branch } = state.profile;
      const target = remote ? { remote, branch } : null;
      if (status === (current?.status ?? '') && (!draft ||
          (sameResult(draft.base, accepted) && sameResult(draft.target, target)))) continue;
      rows.set(key, { ...row, revision: randomUUID(), base: accepted, target });
      changed = true;
    }
    if (changed) await commit({ ...state, ditDrafts: [...rows.values()] });
  }

  async function statusWeek({ previousId, currentId, period, mapOnly = false }) {
    const view = state;
    const project = register => !mapOnly || !register ? register : {
      ...register,
      entries: projectGoalStatuses(view.catalog, view.directory, register, [period]).map(entry => {
        const row = entry.rows.length === 1 ? entry.rows[0] : null;
        return { ...row, period, objective: entry.goalId, keyResult: entry.objective, leader: entry.leader,
          status: entry.status, goalId: entry.goalId, scopeId: entry.scopeId };
      })
    };
    const current = project(await statusRegister(validatedId(currentId, 'Текущий срез'), view));
    if (!current.asOf) throw new WorkspaceError('Укажите дату текущего среза в разделе «Сверка КР».');
    const previous = previousId ? project(await statusRegister(validatedId(previousId, 'Предыдущий срез'), view)) : null;
    if (previous && !previous.asOf) throw new WorkspaceError('Укажите дату предыдущего среза в разделе «Сверка КР».');
    if (!current.periods.includes(period) || (previous && !previous.periods.includes(period))) {
      throw new WorkspaceError('Выберите общий период для выбранных книг.');
    }
    let comparison = null;
    if (previous) {
      try { comparison = compareStatusSnapshots(previous, current, { period }); }
      catch (error) { throw new WorkspaceError(safeError(error)); }
    }
    const rows = current.entries.filter(entry => entry.period === period);
    return {
      period,
      current: { source: current.source, asOf: current.asOf },
      previous: previous ? { source: previous.source, asOf: previous.asOf } : null,
      baseline: {
        total: rows.length,
        completed: rows.filter(entry => normalizedName(entry.status) === 'выполнено').length,
        risks: rows.filter(entry => ['есть риски', 'под риском'].includes(normalizedName(entry.status))),
        withoutMethod: rows.filter(entry => normalizedName(entry.status).startsWith('нет методики')),
      },
      comparison
    };
  }

  async function readSharedUpdate(flight) {
    let next;
    let error;
    try {
      next = normalizeShared(await git.readShared(flight.config, flight.credentials ? { credentials: flight.credentials } : undefined));
    } catch (cause) {
      error = cause ?? new WorkspaceError('Не удалось проверить общую версию Git.', 'INVALID_SHARED', 409);
    }
    return serialized(async () => {
      try {
        if (flight.generation !== connectionGeneration) {
          throw new WorkspaceError('Подключение изменилось. Проверьте данные нового репозитория.', 'CONFLICT', 409);
        }
        const previous = state.shared;
        if (flight.revision !== previous.revision) return getState();
        if (!error && hasSharedRollback(previous, next)) {
          error = new WorkspaceError('Общая версия исчезла или была откачена. Показана последняя проверенная версия. Сверьте ветку Git перед отправкой.', 'CONFLICT', 409);
        }
        if (error) {
          await commit({ ...state, shared: { ...previous, checkedAt: now(), error: safeError(error) } });
          throw error;
        }
        if (previous.checkedAt && next.revision === previous.revision && next.version === previous.version && !previous.error) {
          state = { ...state, shared: next };
        } else {
          await commit({ ...state, shared: next });
        }
        return getState();
      } finally {
        if (pendingRefresh === flight) pendingRefresh = undefined;
      }
    });
  }

  function publicationCredentials(input, config) {
    const credentials = input.credentials;
    if (credentials === undefined) {
      if (state.profile.gitAuth === 'prompt') {
        throw new WorkspaceError('Для этой операции введите логин и пароль Git.', 'GIT_AUTH_REQUIRED', 409);
      }
      return undefined;
    }
    if (state.profile.gitAuth !== 'prompt' || input.credentialRemote !== config.remote) {
      throw new WorkspaceError('Настройки входа или репозиторий изменились. Откройте вход заново.', 'CONFLICT', 409);
    }
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
        typeof credentials.username !== 'string' || typeof credentials.password !== 'string' ||
        !credentials.username || !credentials.password || !/^https:\/\//iu.test(config.remote)) {
      throw new WorkspaceError('Проверьте учётные данные Git и HTTPS-адрес репозитория.');
    }
    return { username: credentials.username, password: credentials.password };
  }

  async function refresh(input, expectedGeneration) {
    // Only capture and apply state under the write queue. Git I/O stays in the flight promise.
    const flight = await serialized(() => {
      if (expectedGeneration !== undefined && expectedGeneration !== connectionGeneration) {
        throw new WorkspaceError('Подключение изменилось. Откройте новый просмотр публикации.', 'CONFLICT', 409);
      }
      const config = connection(state.profile, dataDir);
      const credentials = publicationCredentials(input, config);
      const { revision } = state.shared;
      if (!credentials && pendingRefresh?.generation === connectionGeneration && pendingRefresh.revision === revision) return pendingRefresh;
      const update = { config, revision, generation: connectionGeneration, credentials };
      update.result = readSharedUpdate(update);
      if (!credentials) pendingRefresh = update;
      return update;
    });
    return flight.result;
  }

  function requireName() {
    if (!state.profile.name) throw new WorkspaceError('Укажите ФИО в разделе «Настройки».', 'NO_PROFILE', 409);
    return state.profile.name;
  }

  function withDraft(goalId, row, drafts = state.drafts) {
    const current = sharedRows(goalId).find(entry => identity(entry) === identity(row)) ?? null;
    const { remote, branch } = state.profile;
    return { ...drafts, [goalId]: putRow(drafts[goalId] ?? [], { ...row, base: current, target: remote ? { remote, branch } : null }) };
  }

  function assertViewRevision(input) {
    if (input.expectedRevision !== state.shared.revision) {
      throw new WorkspaceError('Общая версия обновилась. Проверьте опубликованные значения перед сохранением.', 'CONFLICT', 409);
    }
  }

  async function updateProfile(input) {
    const profile = {
      name: string(input.name ?? state.profile.name, 120, 'ФИО', true),
      remote: string(input.remote ?? state.profile.remote, 500, 'Репозиторий'),
      branch: string(input.branch ?? state.profile.branch, 100, 'Ветка', true),
      refreshMinutes: integer(input.refreshMinutes ?? state.profile.refreshMinutes, 1, 1440, 'Интервал'),
      theme: input.theme == null ? state.profile.theme : themeValue(input.theme),
      gitExecutable: string(input.gitExecutable ?? state.profile.gitExecutable, 1000, 'Путь к Git'),
      gitAuth: input.gitAuth ?? state.profile.gitAuth
    };
    if (/[\u0000-\u001f\u007f<>]/.test(profile.name)) {
      throw new WorkspaceError('Проверьте имя для подписи изменений.');
    }
    if (!['system', 'prompt'].includes(profile.gitAuth)) throw new WorkspaceError('Выберите способ входа в Git.');
    if (profile.gitExecutable && (!isAbsolute(profile.gitExecutable) || /[\u0000-\u001f]/u.test(profile.gitExecutable))) {
      throw new WorkspaceError('Укажите абсолютный путь к Git.');
    }
    if (profile.remote && profile.gitAuth === 'prompt' && !/^https:\/\//iu.test(profile.remote)) {
      throw new WorkspaceError('Для входа по запросу укажите HTTPS-адрес репозитория.');
    }
    if (profile.remote) nativeGit.validateSharedConfig(connection(profile, dataDir));
    const changed = profile.remote !== state.profile.remote || profile.branch !== state.profile.branch;
    const changedAuth = profile.gitAuth !== state.profile.gitAuth || profile.gitExecutable !== state.profile.gitExecutable;
    await commit({ ...state, profile, shared: changed ? emptyShared() : state.shared });
    if (changed || changedAuth) connectionGeneration++;
  }

  function preparePublication(input) {
    const author = requireName();
    const config = connection(state.profile, dataDir);
    const credentials = publicationCredentials(input, config);
    const ditPeriod = input.ditPeriod == null || input.ditPeriod === '' ? null
      : string(input.ditPeriod, 12, 'Период', true);
    if (ditPeriod && !validDitPeriod(ditPeriod)) throw new WorkspaceError('Выберите квартал или год.');
    if (!Array.isArray(input.goalIds) || (!input.goalIds.length && !ditPeriod) || input.goalIds.length > 200) {
      throw new WorkspaceError('Выберите цели с локальными изменениями.');
    }
    const selected = [...new Set(input.goalIds)].map(catalogGoal).sort((a, b) => a.id.localeCompare(b.id));
    const latest = state.shared;
    if (!latest.checkedAt || latest.error) {
      throw new WorkspaceError(latest.error || 'Перед просмотром публикации проверьте общую версию Git.', 'CONFLICT', 409);
    }
    const updates = [];
    const reviewedGoals = [];
    for (const goal of selected) {
      const rows = state.drafts[goal.id] ?? [];
      if (!rows.length) throw new WorkspaceError(`Для цели «${goal.title}» нет сохранённых изменений.`);
      let results = sharedRows(goal.id, latest);
      const changes = [];
      for (const row of rows) {
        if (row.target && (row.target.remote !== config.remote || row.target.branch !== config.branch)) {
          throw new WorkspaceError(`Черновик цели «${goal.title}» создан для другого репозитория или ветки. Проверьте данные и сохраните правку для текущего подключения.`, 'CONFLICT', 409);
        }
        const current = results.find(entry => identity(entry) === identity(row));
        const proposed = publicResult(row);
        changes.push({ before: current ? publicResult(current) : null, after: proposed });
        if (sameResult(current, proposed)) continue;
        if (!sameResult(current, row.base)) {
          throw new WorkspaceError(`Общий результат по цели «${goal.title}» изменился. Сверьте значения и сохраните свою правку повторно.`, 'CONFLICT', 409);
        }
        results = putRow(results, proposed);
      }
      if (changes.some(change => !sameResult(change.before, change.after))) {
        updates.push({ id: goal.id, title: goal.title, results });
      }
      reviewedGoals.push({ id: goal.id, title: goal.title, changes });
    }
    const allowedDitGoals = new Map(state.catalog.filter(goal => !excludedDitGoals.has(goal.status)).map(goal => [goal.id, goal]));
    const ditDrafts = ditPeriod ? state.ditDrafts
      .filter(row => row.period === ditPeriod && allowedDitGoals.has(row.goalId))
      .sort((a, b) => a.goalId.localeCompare(b.goalId)) : [];
    if (ditPeriod && !ditDrafts.length) throw new WorkspaceError('За выбранный период нет сохранённых правок статусов ДИТ.');
    const latestDit = new Map((latest.ditStatuses ?? []).map(row => [ditStatusKey(row), row]));
    const ditChanges = [];
    const ditUpdates = [];
    for (const row of ditDrafts) {
      const title = state.goalEdits?.[row.goalId]?.title ?? allowedDitGoals.get(row.goalId).title;
      if (row.target && (row.target.remote !== config.remote || row.target.branch !== config.branch)) {
        throw new WorkspaceError('Статус цели «' + title + '» сохранён для другого репозитория или ветки. Сверьте и сохраните его для текущего подключения.', 'CONFLICT', 409);
      }
      const before = latestDit.get(ditStatusKey(row)) ?? null;
      const after = publicDitStatus(row);
      ditChanges.push({ goalId: row.goalId, title, period: row.period, before, after });
      if (sameResult(before, after)) continue;
      if (!sameResult(before, row.base)) {
        throw new WorkspaceError('Общий статус цели «' + title + '» изменился. Сверьте его и сохраните свою правку повторно.', 'CONFLICT', 409);
      }
      ditUpdates.push(after);
    }
    const review = { author, remote: config.remote, branch: config.branch, revision: latest.revision, goals: reviewedGoals,
      ...(ditPeriod ? { ditPeriod, ditChanges } : {}) };
    const token = createHash('sha256').update(JSON.stringify({
      review, drafts: selected.map(goal => state.drafts[goal.id]), ditDrafts, generation: connectionGeneration
    })).digest('hex');
    return { config, credentials, latest, updates, ditUpdates, preview: { ...review, token } };
  }

  async function publicationPreview(input) {
    if (input.credentials !== undefined) await refresh(input);
    return serialized(() => preparePublication(input).preview);
  }

  function verifyPublication(input) {
    const stale = () => new WorkspaceError('Черновики или общая версия изменились. Откройте новый просмотр публикации.', 'CONFLICT', 409);
    if (typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) throw stale();
    const prepared = preparePublication(input);
    if (input.token !== prepared.preview.token) throw stale();
    return prepared;
  }

  async function publish(input) {
    const generation = await serialized(() => {
      verifyPublication(input);
      return connectionGeneration;
    });
    await refresh(input, generation);
    return serialized(async () => {
      const { config, credentials, latest, updates, ditUpdates, preview } = verifyPublication(input);
      const shared = updates.length || ditUpdates.length ? normalizeShared(await git.publishShared(config, {
        expectedRevision: latest.revision, goals: updates, author: preview.author,
        ...(ditUpdates.length ? { ditStatuses: ditUpdates } : {}), ...(credentials ? { credentials } : {})
      })) : latest;
      const drafts = { ...state.drafts };
      for (const goal of preview.goals) delete drafts[goal.id];
      const publishedDit = new Set((preview.ditChanges ?? []).map(ditStatusKey));
      const ditDrafts = state.ditDrafts.filter(row => !publishedDit.has(ditStatusKey(row)));
      await commit({ ...state, shared, drafts, ditDrafts });
      return getState();
    });
  }

  async function changeDirectory(input) {
    const id = input.id ? validatedId(input.id, 'Участник') : randomUUID();
    if (id === dit.id) throw new WorkspaceError('ДИТ OPS — общий уровень карты.');
    if (input.id) scopeEntry(id);
    const leaderId = input.leaderId ? validatedId(input.leaderId, 'ИТ-лидер') : undefined;
    if (leaderId && (leaderId === id || scopeEntry(leaderId).type !== 'leader')) {
      throw new WorkspaceError('Выберите ИТ-лидера для участника.');
    }
    const previous = state.directory.find(entry => entry.id === id);
    const aliases = Array.isArray(input.aliases) ? input.aliases.slice(0, 20).map(alias => string(alias, 120, 'Алиас', true))
      : previous?.aliases ?? [];
    const entry = {
      ...previous, id, name: string(input.name, 160, 'Название', true),
      type: string(input.type, 40, 'Тип', true), leaderId, aliases, edited: true
    };
    const entries = byId(state.directory);
    entries.set(id, entry);
    await commit({ ...state, directory: [...entries.values()] });
  }

  async function changeGoal(input) {
    const goal = catalogGoal(input.goalId);
    if (!Array.isArray(input.curators) || input.curators.length > 30) {
      throw new WorkspaceError('Укажите кураторов через запятую.');
    }
    const fields = {
      title: string(input.title, 400, 'Название', true),
      target: string(input.target, 2000, 'Целевое значение'),
      description: string(input.description, 4000, 'Описание'),
      method: string(input.method, 4000, 'Методика'),
      curators: [...new Set(input.curators.map(value => string(value, 120, 'Куратор', true)))]
    };
    await commit({ ...state, goalEdits: { ...state.goalEdits, [goal.id]: fields } });
  }

  async function saveAutomation(input) {
    const goal = catalogGoal(input.goalId);
    const source = findSource(input.sourceId);
    const sheet = string(input.sheet, 80, 'Лист', true);
    if (source.type !== 'xlsx' || !source.sheets.some(entry => entry.name === sheet)) {
      throw new WorkspaceError('Выберите лист загруженной книги Excel.');
    }
    const scopeColumn = columnNumber(input.scopeColumn).letter;
    const valueColumn = columnNumber(input.valueColumn).letter;
    if (scopeColumn === valueColumn) throw new WorkspaceError('Столбцы участника и значения должны различаться.');
    const headerRow = integer(input.headerRow, 1, 1000000, 'Строка перед данными');
    const endRow = input.endRow == null || input.endRow === '' ? null
      : integer(input.endRow, headerRow + 1, 1048576, 'Последняя строка');
    const recipe = {
      sourceId: source.id, sheet, scopeColumn, valueColumn, headerRow, endRow,
      period: string(input.period, 60, 'Период', true),
      asOf: isoDate(input.asOf),
      scale: input.scale === 'fraction' ? 'fraction' : 'percent'
    };
    await commit({ ...state, automations: { ...state.automations, [goal.id]: recipe } });
  }

  async function calculate(input) {
    const goal = catalogGoal(input.goalId);
    const recipe = state.automations[goal.id];
    if (!recipe) throw new WorkspaceError('Сначала настройте источник и столбцы в разделе «Автоматизация».');
    const { bytes } = await readOriginal(recipe.sourceId);
    let table;
    try { table = openWorkbook(bytes).getRows(recipe.sheet); }
    catch (error) { throw new WorkspaceError(safeError(error)); }
    const scopeIndex = columnNumber(recipe.scopeColumn).index;
    const valueIndex = columnNumber(recipe.valueColumn).index;
    const results = new Map();
    const calculatedAt = now();
    for (let rowIndex = recipe.headerRow; rowIndex < Math.min(recipe.endRow ?? table.length, table.length); rowIndex++) {
      const row = table[rowIndex] ?? [];
      const rawScope = row[scopeIndex];
      const rawValue = row[valueIndex];
      if ((rawScope == null || rawScope === '') && (rawValue == null || rawValue === '')) continue;
      const scope = scopeLookup(state.directory, rawScope);
      if (!scope) throw new WorkspaceError(`Строка ${rowIndex + 1}. Сопоставьте участника «${String(rawScope ?? '').slice(0, 100)}» со справочником.`);
      if (results.has(scope.id)) throw new WorkspaceError(`Строка ${rowIndex + 1}. Участник «${scope.name}» указан несколько раз.`);
      results.set(scope.id, {
        scopeId: scope.id, value: fromCell(rawValue, recipe.scale, rowIndex + 1),
        status: '', plan: '', risk: '', comment: '', period: recipe.period, asOf: recipe.asOf,
        mode: 'automatic', savedAt: calculatedAt, author: state.profile.name
      });
    }
    if (!results.size) throw new WorkspaceError('В выбранных строках нет данных для расчёта.');
    await commit({ ...state, runs: { ...state.runs, [goal.id]: { recipe, rows: [...results.values()] } } });
  }

  async function accept(input) {
    assertViewRevision(input);
    const author = requireName();
    const goal = catalogGoal(input.goalId);
    const run = state.runs[goal.id];
    if (!run || JSON.stringify(run.recipe) !== JSON.stringify(state.automations[goal.id])) {
      throw new WorkspaceError('Обновите расчёт с текущими настройками перед принятием.');
    }
    let drafts = state.drafts;
    const savedAt = now();
    for (const row of run.rows) {
      const previous = [...(drafts[goal.id] ?? []), ...sharedRows(goal.id)]
        .find(entry => identity(entry) === identity(row));
      drafts = withDraft(goal.id, {
        ...row, status: previous?.status ?? '', plan: previous?.plan ?? '',
        comment: previous?.comment ?? '', risk: previous?.risk ?? '', author, savedAt
      }, drafts);
    }
    await commit({ ...state, drafts });
  }

  const actions = {
    profile: updateProfile,
    async theme(input) {
      await commit({ ...state, profile: { ...state.profile, theme: themeValue(input.theme) } });
    },
    snapshot: setStatusDate,
    statuslink: setStatusLink,
    'dit-status': setDitStatuses,
    async visualization(input) {
      if (input.expectedRevision !== (state.visualization?.revision ?? null)) {
        throw new WorkspaceError('Компоновка изменилась. Проверьте карточки перед сохранением.', 'CONFLICT', 409);
      }
      let cards;
      try { cards = validateCards(input.cards); }
      catch (error) { throw new WorkspaceError(safeError(error)); }
      await commit({ ...state, visualization: { cards, revision: randomUUID() } });
    },
    async status(input) {
      assertViewRevision(input);
      const author = requireName();
      const goal = catalogGoal(input.goalId);
      const fields = resultFields(input);
      scopeEntry(fields.scopeId);
      const row = { ...fields, author, mode: 'manual', savedAt: now() };
      await commit({ ...state, drafts: withDraft(goal.id, row) });
    },
    goal: changeGoal,
    directory: changeDirectory,
    automation: saveAutomation,
    calculate,
    accept
  };

  async function execute(action, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new WorkspaceError('Некорректные параметры.');
    if (action === 'refresh') return refresh(payload);
    if (action === 'publishpreview') return publicationPreview(payload);
    if (action === 'publish') return publish(payload);
    return serialized(async () => {
      if (!Object.hasOwn(actions, action)) throw new WorkspaceError('Действие не найдено.', 'NOT_FOUND', 404);
      await actions[action](payload);
      return getState();
    });
  }

  async function* backup() {
    const snapshot = state;
    yield `{"format":"rm-uor-workspace-v1","exportedAt":${JSON.stringify(now())},"workspace":${JSON.stringify(snapshot)},"originals":[`;
    let separator = '';
    for (const source of snapshot.sources) {
      const bytes = await readFile(join(sourceDir, source.id));
      yield separator + JSON.stringify({ id: source.id, base64: bytes.toString('base64') });
      separator = ',';
    }
    yield ']}';
  }

  return { getState, execute, importSource, readPreview, statusRegister, statusWeek, readOriginal, backup };
}
