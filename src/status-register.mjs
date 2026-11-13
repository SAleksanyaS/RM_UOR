import { openWorkbook } from './imports.mjs';
import { statusGoalAlias } from './status-goal-aliases.mjs';

const quarterlyColumns = { keyResult: 4, plan: 5, fact: 6, progress: 7, artifact: 8, forecast: 18, status: 19 };
const annualColumns = { keyResult: 9, plan: 10, fact: 11, progress: 12, artifact: 13, forecast: 20, status: 21 };
const maturityKeyResult = 'доля команд исполняют практики начального (гигиенического минимума) по модели зрелости';
const explicitGoalCode = /(?<![\p{L}\p{N}_.])(?:OB26|SW26(?:\.\d+)?|SD\d{2}\.\d{2}|AR26\.\d+|ITZ26|MT26|IZT26|LOCAL_[A-Z0-9_]+)(?![\p{L}\p{N}_]|\.\d)/giu;
const contextMerge = /^([BCD])([1-9]\d*):\1([1-9]\d*)$/i;

const fixedHeaders = new Map([
  [1, 'название цели'], [2, 'вес целей, %'], [3, 'направление и #'],
  [4, 'ключевой результат (кр)'], [5, 'план'], [6, 'факт'],
  [7, 'прогресс выполнения цели'], [8, 'артефакт'],
  [9, 'ключевой результат (кр)'], [10, 'план'], [11, 'факт'],
  [12, 'прогресс выполнения цели'], [13, 'артефакт'],
  [14, 'куратор'], [15, 'фио руководителя - исполнителя'],
  [20, 'прогноз выполнения y'], [21, 'легенда y'], [22, 'наличие артефакта'],
]);

function cell(value) {
  return typeof value === 'string' ? value.trim() || null : value ?? null;
}

function label(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLowerCase().replace(/[ё]/g, 'е').replace(/\s*[-–—]\s*/gu, ' - ').replace(/\s+/gu, ' ').trim()
    : '';
}

function layoutFor(workbook, sheet) {
  const range = /^B([1-9]\d*):W([1-9]\d*)$/i.exec(sheet.filterRange ?? '');
  if (!range) return null;
  const headerRow = Number(range[1]);
  const endRow = Number(range[2]);
  if (headerRow < 2 || endRow <= headerRow || endRow - headerRow > 20_000) return null;

  const [periodLabels, headings] = workbook.preview(sheet.name, headerRow - 2, 2).rows;
  if (!periodLabels || !headings) return null;
  const quarterPeriod = cell(periodLabels[quarterlyColumns.keyResult]);
  const annualPeriod = cell(periodLabels[annualColumns.keyResult]);
  const quarter = /^Q([1-4])\s+(20\d{2})$/i.exec(quarterPeriod ?? '');
  const year = /^Y(\d{2})$/i.exec(annualPeriod ?? '');
  if (!quarter || !year || !quarter[2].endsWith(year[1])) return null;
  if ([...fixedHeaders].some(([index, expected]) => label(headings[index]) !== expected)) return null;
  if (!/^комментарии куратора(?:[:\s]|$)/u.test(label(headings[16])) ||
      !/^комментарий руководителя - исполнителя(?:[:\s]|$)/u.test(label(headings[17])) ||
      label(headings[18]) !== 'прогноз выполнения ' + quarter[1] + 'q' ||
      label(headings[19]) !== 'легенда ' + quarter[1] + 'q') return null;

  return { sheet: sheet.name, range: sheet.filterRange, headerRow, endRow, quarterPeriod, annualPeriod };
}

function tableRows(workbook, layout) {
  const rows = [];
  const merges = new Set();
  for (let offset = layout.headerRow; offset < layout.endRow;) {
    const preview = workbook.preview(layout.sheet, offset, Math.min(200, layout.endRow - offset));
    if (!preview.rows.length) throw new Error('Диапазон реестра выходит за пределы листа.');
    rows.push(...preview.rows);
    for (const merge of preview.merges) merges.add(merge);
    offset += preview.rows.length;
  }

  const firstRow = layout.headerRow + 1;
  for (const merge of merges) {
    const span = contextMerge.exec(merge);
    if (!span) continue;
    const column = span[1].toUpperCase().charCodeAt(0) - 65;
    const from = Number(span[2]);
    const to = Math.min(layout.endRow, Number(span[3]));
    if (from < firstRow || from >= to) continue;
    const anchor = cell(rows[from - firstRow]?.[column]);
    if (anchor === null) continue;
    for (let rowNumber = from + 1; rowNumber <= to; rowNumber++) {
      const row = rows[rowNumber - firstRow];
      if (cell(row[column]) === null) row[column] = anchor;
    }
  }
  return rows;
}

function goalCandidate({ objective, direction, keyResult, period, plan }) {
  const matches = new Set();
  for (const field of [objective, direction, keyResult]) {
    if (typeof field !== 'string') continue;
    for (const [code] of field.matchAll(explicitGoalCode)) matches.add(code.toUpperCase());
  }
  if (label(keyResult) === maturityKeyResult) matches.add('SW26.1');
  const alias = statusGoalAlias({ objective, direction, keyResult, period, plan });
  if (alias) matches.add(alias);
  return matches.size === 1 ? matches.values().next().value : null;
}

function artifactLinks(artifact) {
  if (typeof artifact !== 'string') return [];
  const matches = artifact.match(/https:\/\/[^\s<>"«»]+/giu) ?? [];
  const links = [];
  for (const raw of new Set(matches.map(url => url.replace(/[.,;:)\]]+$/u, '')))) {
    if (!URL.canParse(raw)) continue;
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) links.push({ label: raw, url: raw });
  }
  return links;
}

export function readStatusRegister(bytes, { sheet } = {}) {
  const workbook = openWorkbook(bytes);
  const candidates = workbook.sheets.filter(tab => sheet ? tab.name === sheet : !tab.hidden);
  const layouts = candidates.map(tab => layoutFor(workbook, tab)).filter(Boolean);
  if (layouts.length !== 1) {
    const error = new Error(layouts.length
      ? 'В книге несколько листов со структурой реестра. Выберите лист.'
      : 'В книге нет листа с поддерживаемой структурой реестра статусов.');
    error.code = layouts.length ? 'AMBIGUOUS_STATUS_LAYOUT' : 'UNSUPPORTED_STATUS_LAYOUT';
    throw error;
  }
  const layout = layouts[0];
  const periods = [layout.quarterPeriod, layout.annualPeriod];
  const rows = tableRows(workbook, layout);
  const entries = [];
  for (const [index, row] of rows.entries()) {
    const sourceRow = layout.headerRow + index + 1;
    const objective = cell(row[1]);
    const weight = cell(row[2]);
    const direction = cell(row[3]);
    const curator = cell(row[14]);
    const leader = cell(row[15]);
    const curatorComment = cell(row[16]);
    const leaderComment = cell(row[17]);
    const artifactStatus = cell(row[22]);
    const comment = [curatorComment, leaderComment].filter(value => value !== null).join('\n') || null;

    for (const [period, columns] of [[periods[0], quarterlyColumns], [periods[1], annualColumns]]) {
      const keyResult = cell(row[columns.keyResult]);
      if (keyResult === null) continue;
      const artifact = cell(row[columns.artifact]);
      const plan = cell(row[columns.plan]);
      entries.push({
        id: sourceRow + ':' + period,
        sourceRow, period, objective, weight, direction, keyResult, leader, curator,
        plan, fact: cell(row[columns.fact]), progress: cell(row[columns.progress]),
        status: cell(row[columns.status]), forecast: cell(row[columns.forecast]),
        artifact, artifactStatus, curatorComment, leaderComment, comment,
        links: artifactLinks(artifact), goalId: goalCandidate({ objective, direction, keyResult, period, plan }),
      });
    }
  }

  return { sheet: layout.sheet, range: layout.range, asOf: null, periods, entries };
}
