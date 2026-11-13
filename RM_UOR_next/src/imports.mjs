import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const maxFileBytes = 32 * 1024 * 1024;
const maxXmlBytes = 16 * 1024 * 1024;
const maxArchiveBytes = 128 * 1024 * 1024;
const maxWorkbookCells = 500_000;
const maxGridCells = 500_000;
const maxPreviewRows = 200;
const maxPreviewColumns = 256;

const text = value => typeof value === 'string' ? value.trim() : '';
const list = value => Array.isArray(value) ? value : [];
const strings = value => list(value).map(text).filter(Boolean);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..';

function attributes(source) {
  return new Map([...source.matchAll(/([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(([, name, double, single]) => [name, double ?? single]));
}

function resourceLinks(value) {
  const links = [];
  for (const link of list(value)) {
    if (!record(link)) continue;
    const url = text(link.url);
    const parsed = URL.canParse(url) ? new URL(url) : null;
    if (parsed?.protocol !== 'https:' || parsed.username || parsed.password) continue;
    links.push({ label: text(link.label) || parsed.hostname, url, kind: text(link.kind) });
  }
  return links;
}

export function parseGoalMap(input) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
    throw new TypeError('Для карты целей нужен HTML-файл.');
  }
  const html = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
  if (Buffer.byteLength(html) > maxFileBytes) throw new Error('HTML-файл слишком большой.');
  const sections = [];
  const tokens = /<!--[\s\S]*?-->|<script(?=[\s>])((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/gi;
  for (const [, attrs, payload] of html.matchAll(tokens)) {
    if (attrs === undefined) continue;
    const fields = attributes(attrs);
    if (fields.get('id') === 'portal-data' && fields.get('type') === 'application/json') {
      sections.push(payload);
    }
  }
  if (sections.length !== 1) throw new Error('В HTML нужен один JSON-блок portal-data карты целей.');
  let map;
  try {
    map = JSON.parse(sections[0]);
  } catch {
    throw new Error('Блок JSON в карте целей повреждён.');
  }
  if (!record(map) || !Array.isArray(map.goals) || !record(map.leaders)) {
    throw new Error('В карте целей отсутствует список целей или справочник лидеров.');
  }

  const goals = new Map();
  for (const item of map.goals) {
    if (!record(item) || !validId(text(item.id)) || !text(item.title) || goals.has(text(item.id))) {
      throw new Error('В карте целей есть цель без названия или с неверным или повторным кодом.');
    }
    const id = text(item.id);
    const scope = text(item.scopeType);
    const description = text(item.summary);
    goals.set(id, {
      id, title: text(item.title), description, scope, method: text(item.method), target: text(item.target),
      links: resourceLinks(item.links), curators: strings(item.curators), assignments: [],
      category: text(item.category), metric: text(item.metric), status: text(item.status),
      scopeType: scope, summary: description, actions: strings(item.actions),
      outOfScopeReason: text(item.outOfScopeReason),
    });
  }

  const leaders = [];
  const directory = new Map();
  function participant(type, name, leaderId) {
    const id = type + '-' + createHash('sha256').update(JSON.stringify([leaderId, name])).digest('hex').slice(0, 20);
    directory.set(id, { id, name, type, leaderId });
    return id;
  }

  for (const [id, item] of Object.entries(map.leaders)) {
    if (!validId(id) || !record(item) || !text(item.name)) throw new Error('Неверная запись лидера в карте целей.');
    const name = text(item.name);
    const teams = strings(item.teams);
    const assignments = [];
    if (directory.has(id)) throw new Error('Код лидера совпадает с кодом участника.');
    directory.set(id, { id, name, type: 'leader' });
    for (const team of teams) participant('team', team, id);
    for (const entry of list(item.assignments)) {
      if (!record(entry)) throw new Error('Неверное назначение цели в карте.');
      const goalId = text(entry.goalId);
      const goal = goals.get(goalId);
      if (!goal) throw new Error('В назначении лидера указан неизвестный код цели.');
      const assignment = { goalId, leaderId: id, teams: strings(entry.teams) };
      if (Array.isArray(entry.agents)) assignment.agents = strings(entry.agents);
      if (typeof entry.active === 'boolean') assignment.active = entry.active;
      if (typeof entry.allProducts === 'boolean') assignment.allProducts = entry.allProducts;
      for (const key of ['title', 'target', 'summary', 'metric', 'participantType']) {
        if (typeof entry[key] === 'string') assignment[key] = text(entry[key]);
      }
      if (Array.isArray(entry.actions)) assignment.actions = strings(entry.actions);
      const assignedTeams = assignment.allProducts ? teams : assignment.teams;
      assignment.teamIds = [...new Set(assignedTeams.map(team => participant('team', team, id)))];
      assignment.agentIds = [...new Set((assignment.agents ?? []).map(agent => participant('agent', agent, id)))];
      assignment.scopeIds = [...assignment.teamIds, ...assignment.agentIds];
      assignments.push(assignment);
      goal.assignments.push(assignment);
    }
    leaders.push({ id, name, teams, assignments });
  }

  return { goals: [...goals.values()], leaders, directory: [...directory.values()] };
}

// Open only named archive members in memory. Nothing is extracted to a filesystem.
function openZip(input) {
  if (!(input instanceof Uint8Array)) throw new TypeError('Для просмотра нужен файл XLSX.');
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > maxFileBytes) throw new Error('Файл XLSX слишком большой.');
  const corrupt = () => new Error('Архив ZIP в файле XLSX повреждён или не поддерживается.');
  let end = bytes.length - 22;
  const earliestEnd = Math.max(0, end - 65535);
  while (end >= earliestEnd) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
    end--;
  }
  if (end < earliestEnd) throw corrupt();
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const directoryStart = offset;
  const directoryEnd = offset + bytes.readUInt32LE(end + 12);
  if (!count || count > 4096 || directoryEnd !== end || bytes.readUInt32LE(end + 4) !== 0 ||
      bytes.readUInt16LE(end + 8) !== count) throw corrupt();

  const entries = new Map();
  let archiveSize = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directoryEnd || bytes.readUInt32LE(offset) !== 0x02014b50) throw corrupt();
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const disk = bytes.readUInt16LE(offset + 34);
    const local = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    offset = nameStart + nameSize + extraSize + commentSize;
    if (!nameSize || disk !== 0 || offset > directoryEnd || local + 30 > directoryStart) throw corrupt();
    const nameBytes = bytes.subarray(nameStart, nameStart + nameSize);
    const name = nameBytes.toString('utf8');
    if (entries.has(name)) throw corrupt();
    archiveSize += size;
    if (archiveSize > maxArchiveBytes) throw new Error('Распакованный файл XLSX слишком большой.');
    entries.set(name, { nameBytes, flags, method, compressedSize, size, local });
  }
  if (offset !== directoryEnd) throw corrupt();

  return function read(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const { nameBytes, flags, method, compressedSize, size, local } = entry;
    if ((flags & 1) || (method !== 0 && method !== 8) || size > maxXmlBytes ||
        bytes.readUInt32LE(local) !== 0x04034b50 ||
        bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw corrupt();
    const localNameSize = bytes.readUInt16LE(local + 26);
    const start = local + 30 + localNameSize + bytes.readUInt16LE(local + 28);
    if (localNameSize !== nameBytes.length || start + compressedSize > directoryStart ||
        !nameBytes.equals(bytes.subarray(local + 30, local + 30 + localNameSize))) throw corrupt();
    const data = bytes.subarray(start, start + compressedSize);
    let unpacked;
    try {
      unpacked = method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
    } catch {
      throw corrupt();
    }
    if (unpacked.length !== size) throw corrupt();
    return unpacked;
  };
}

function xmlText(value) {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    if (code[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code] ?? entity;
    const isHex = code[1].toLowerCase() === 'x';
    const point = Number.parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : '\ufffd';
  });
}

function readXml(read, name) {
  const bytes = read(name);
  if (!bytes) return null;
  const utf16LE = bytes[0] === 0xff && bytes[1] === 0xfe;
  const utf16BE = bytes[0] === 0xfe && bytes[1] === 0xff;
  const encoding = utf16LE ? 'utf-16le' : utf16BE ? 'utf-16be' : 'utf-8';
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('XML с внешними объявлениями не поддерживается.');
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

function* elements(xml, name) {
  const prefix = '(?:[\\w.-]+:)?';
  const tag = '<' + prefix + name + '(?=[\\s/>])((?:"[^"]*"|\'[^\']*\'|[^\'">])*)>';
  const open = new RegExp(tag, 'g');
  const close = new RegExp('</' + prefix + name + '\\s*>', 'g');
  for (let match; (match = open.exec(xml));) {
    if (/\/\s*$/.test(match[1])) {
      yield [match[1], ''];
    } else {
      const start = open.lastIndex;
      close.lastIndex = start;
      const end = close.exec(xml);
      if (!end) throw new Error('Структура XML в книге XLSX повреждена.');
      yield [match[1], xml.slice(start, end.index)];
      open.lastIndex = close.lastIndex;
    }
  }
}

function first(xml, tag) {
  return elements(xml, tag).next().value;
}

function richText(xml) {
  const phonetics = /<(?:[\w.-]+:)?rPh(?=[\s>])[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?rPh\s*>/g;
  return [...elements(xml.replace(phonetics, ''), 't')].map(([, value]) => xmlText(value)).join('');
}

function relationshipTarget(attrs) {
  if (attrs.get('TargetMode') === 'External') return null;
  let target = xmlText(attrs.get('Target') ?? '');
  if (!target || /[\\:#?]/.test(target)) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (/[\\:#?\0]/.test(target)) return null;
  const path = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.join('xl', target);
  return path.startsWith('xl/') ? path : null;
}

function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^[0-9]+$/.test(value) || parsed > max || parsed < 1) {
    throw new Error('В книге XLSX указан недопустимый номер строки или столбца.');
  }
  return parsed;
}

function address(value) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(value);
  if (!match) throw new Error('В книге XLSX указан неверный адрес ячейки.');
  let column = 0;
  for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  if (column > 16384) throw new Error('В книге XLSX указан недопустимый столбец.');
  return { row: integer(match[2], 1, 1048576), column };
}

function span(value) {
  const [start, end = start] = value.split(':');
  const from = address(start);
  const to = address(end);
  if (to.row < from.row || to.column < from.column || value.split(':').length > 2) {
    throw new Error('В книге XLSX указан недопустимый диапазон ячеек.');
  }
  return { from, to };
}

function cellValue(type, xml, sharedStrings) {
  const cache = first(xml, 'v');
  if (!cache) {
    const inline = type === 'inlineStr' ? first(xml, 'is') : undefined;
    return inline ? richText(inline[1]) : null;
  }
  const value = xmlText(cache[1]);
  if (type === 's') {
    if (!/^\d+$/.test(value) || sharedStrings[Number(value)] === undefined) {
      throw new Error('Ячейка XLSX ссылается на отсутствующую строку.');
    }
    return sharedStrings[Number(value)];
  }
  if (type === 'b') return value === '1' || value === 'true';
  if (type && type !== 'n') return value;
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function readSheet(xml, stringsTable, countCell) {
  const sheetData = first(xml, 'sheetData');
  if (!sheetData) throw new Error('На листе XLSX нет области данных.');
  const grid = new Map();
  const merges = [];
  let rowNumber = 0;
  let rows = 0;
  let columns = 0;
  for (const [rowAttrs, rowXml] of elements(sheetData[1], 'row')) {
    rowNumber = integer(attributes(rowAttrs).get('r'), rowNumber + 1, 1048576);
    let column = 0;
    for (const [cellAttrs, contents] of elements(rowXml, 'c')) {
      countCell();
      const fields = attributes(cellAttrs);
      const ref = fields.get('r');
      const location = ref ? address(ref) : { row: rowNumber, column: column + 1 };
      column = location.column;
      if (location.row !== rowNumber || column > 16384) throw new Error('Положение ячейки XLSX расходится с её строкой.');
      const value = cellValue(fields.get('t'), contents, stringsTable);
      if (value !== null || first(contents, 'f')) {
        rows = Math.max(rows, rowNumber);
        columns = Math.max(columns, column);
      }
      if (value === null) continue;
      if (!grid.has(rowNumber)) grid.set(rowNumber, new Map());
      grid.get(rowNumber).set(column, value);
    }
  }
  const mergeData = first(xml, 'mergeCells');
  if (mergeData) {
    for (const [mergeAttrs] of elements(mergeData[1], 'mergeCell')) {
      const value = attributes(mergeAttrs).get('ref');
      if (!value) continue;
      const parsed = span(value);
      merges.push({ value, ...parsed });
      rows = Math.max(rows, parsed.to.row);
      columns = Math.max(columns, parsed.to.column);
    }
  }
  const filter = first(xml, 'autoFilter');
  const filterRange = filter ? attributes(filter[0]).get('ref') : undefined;
  if (filterRange) {
    const { to } = span(filterRange);
    rows = Math.max(rows, to.row);
    columns = Math.max(columns, to.column);
  }
  return { rows, columns, grid, merges, filterRange };
}

function readRows(data, offset, count, columns) {
  return Array.from({ length: count }, (_, rowIndex) => {
    const row = data.grid.get(offset + rowIndex + 1);
    return Array.from({ length: columns }, (_, colIndex) => row?.get(colIndex + 1) ?? null);
  });
}

export function openWorkbook(bytes) {
  const read = openZip(bytes);
  const workbook = readXml(read, 'xl/workbook.xml');
  const rels = readXml(read, 'xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new Error('В архиве отсутствуют данные книги XLSX.');
  const targets = new Map();
  let sharedStringsPath = 'xl/sharedStrings.xml';
  for (const [raw] of elements(rels, 'Relationship')) {
    const attrs = attributes(raw);
    const target = relationshipTarget(attrs);
    const type = attrs.get('Type') ?? '';
    if (target && type.endsWith('/worksheet')) targets.set(attrs.get('Id'), target);
    if (target && type.endsWith('/sharedStrings')) sharedStringsPath = target;
  }
  const stringsXml = readXml(read, sharedStringsPath);
  const stringsTable = [];
  if (stringsXml) {
    for (const [, value] of elements(stringsXml, 'si')) {
      if (stringsTable.length >= maxWorkbookCells) throw new Error('В книге XLSX слишком много строк текста.');
      stringsTable.push(richText(value));
    }
  }
  const sheetList = first(workbook, 'sheets');
  if (!sheetList) throw new Error('В книге XLSX нет листов.');
  const sheets = [];
  const byName = new Map();
  let cellCount = 0;
  function countCell() {
    cellCount++;
    if (cellCount > maxWorkbookCells) throw new Error('В книге XLSX слишком много ячеек.');
  }
  for (const [raw] of elements(sheetList[1], 'sheet')) {
    const attrs = attributes(raw);
    const id = [...attrs].find(([key]) => key.endsWith(':id'))?.[1];
    const name = xmlText(attrs.get('name') ?? '');
    const path = targets.get(id);
    if (!path) continue;
    if (!name || byName.has(name) || sheets.length >= 128) throw new Error('Недопустимый список листов XLSX.');
    const xml = readXml(read, path);
    if (!xml) throw new Error('В архиве отсутствует лист XLSX.');
    const data = readSheet(xml, stringsTable, countCell);
    byName.set(name, data);
    const hidden = attrs.get('state') === 'hidden' || attrs.get('state') === 'veryHidden';
    sheets.push({ name, rows: data.rows, columns: data.columns, hidden, filterRange: data.filterRange });
  }
  if (!sheets.length) throw new Error('В книге XLSX нет поддерживаемых листов с ячейками.');
  const bookView = first(workbook, 'workbookView');
  const activeTab = Number(bookView ? attributes(bookView[0]).get('activeTab') : 0);
  const selected = sheets[activeTab];
  const defaultSheet = selected && !selected.hidden
    ? selected.name
    : (sheets.find(sheet => !sheet.hidden) ?? sheets[0]).name;

  function getSheet(name) {
    const data = byName.get(name);
    if (!data) throw new Error('Лист XLSX не найден.');
    return data;
  }

  return {
    sheets,
    preview(sheet = defaultSheet, offset = 0, limit = 100) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('Недопустимый диапазон просмотра листа XLSX.');
      }
      const data = getSheet(sheet);
      const count = Math.min(Math.max(0, data.rows - offset), limit, maxPreviewRows);
      const columns = Math.min(data.columns, maxPreviewColumns);
      const merges = data.merges.filter(({ from, to }) =>
        count > 0 && from.row <= offset + count && to.row > offset && from.column <= columns);
      return {
        sheet, rows: readRows(data, offset, count, columns), offset, total: data.rows,
        merges: merges.map(({ value }) => value),
      };
    },
    getRows(sheet = defaultSheet) {
      const data = getSheet(sheet);
      if (data.rows > maxGridCells || data.rows * data.columns > maxGridCells) {
        throw new Error('Полная таблица XLSX слишком большая. Откройте её частями.');
      }
      return readRows(data, 0, data.rows, data.columns);
    },
  };
}
