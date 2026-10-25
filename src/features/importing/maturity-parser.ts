import ExcelJS from 'exceljs';
import type { ImportIssue, ParsedMaturityRow, ParsedMaturityWorkbook } from './import-contracts';

const MAX_BYTES = 10 * 1024 * 1024, MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_ROWS = 25_000, MAX_FACTS = 20_000, MAX_COLUMNS = 100;
const REQUIRED = ['команда', 'метрика', 'значение метрики', 'цель метрики'] as const;

/** Bounded ZIP central-directory inspection before ExcelJS expands workbook XML. */
export function checkArchive(bytes: Buffer): void {
  if (!bytes.length) throw new Error('Загружен пустой файл');
  if (bytes.length > MAX_BYTES) throw new Error('Файл превышает допустимый размер 10 МБ');
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Ожидается книга XLSX в формате ZIP');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('Повреждён ZIP-контейнер XLSX');
  const entries = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directory = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== entries
    || !entries || entries > 4096 || directory === 0xffffffff || directorySize === 0xffffffff || directory + directorySize > end) {
    throw new Error('Неподдерживаемый или слишком большой ZIP-контейнер XLSX');
  }
  let cursor = directory, expanded = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > directory + directorySize || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Повреждён каталог ZIP-контейнера XLSX');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const length = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28);
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (next > directory + directorySize || flags & 1 || ![0, 8].includes(method)) throw new Error('Зашифрованная или повреждённая книга XLSX не поддерживается');
    expanded += length;
    if (expanded > MAX_EXPANDED) throw new Error('Распакованные данные XLSX превышают 64 МБ');
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (names.has(name)) throw new Error('В ZIP-контейнере XLSX повторяются файлы');
    names.add(name); cursor = next;
  }
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new Error('ZIP-файл не содержит книгу XLSX');
}

function cachedValue(cell: ExcelJS.Cell, report?: (code: string, message: string) => void): unknown {
  const value = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    if (!('result' in value) || value.result === undefined || value.result === null) {
      report?.('formula_without_result', 'У формулы отсутствует сохранённый результат. Пересчитайте книгу в доверенном редакторе и сохраните.');
      return null;
    }
    return value.result;
  }
  return value;
}
function plainText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map(part => typeof part?.text === 'string' ? part.text : '').join('').trim();
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
  }
  return '';
}
const normalized = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');

function percentage(cell: ExcelJS.Cell, role: 'value' | 'target', report: (code: string, message: string) => void): { number: number | null; text: string } {
  const raw = cachedValue(cell, report), text = plainText(raw);
  if (raw === null || raw === undefined || text === '-' || typeof raw === 'string' && !text) return { number: null, text };
  let number: number;
  if (typeof raw === 'number') number = raw * (cell.numFmt?.replace(/"[^"]*"/g, '').replace(/\\%/g, '').includes('%') ? 100 : 1);
  else if (typeof raw === 'string' && /^[+-]?\d+(?:[.,]\d+)?\s*%?$/.test(text)) number = Number(text.replace('%', '').replace(',', '.').trim());
  else {
    report(`unknown_${role}`, `Не распознано ${role === 'value' ? 'значение' : 'целевое значение'}: ${text || 'неподдерживаемый тип ячейки'}`);
    return { number: null, text };
  }
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    report('percentage_out_of_range', 'Процентное значение должно находиться в диапазоне от 0 до 100.');
    return { number: null, text };
  }
  return { number, text };
}

/** Parses inert workbook data only: no formulas, macros, links or external requests are executed. */
export async function parseMaturityWorkbook(bytes: Buffer): Promise<ParsedMaturityWorkbook> {
  checkArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as never); } catch { throw new Error('Не удалось прочитать книгу XLSX: файл повреждён или имеет неподдерживаемый формат'); }
  const candidates: { sheet: ExcelJS.Worksheet; rowNumber: number; columns: Map<string, number> }[] = [];
  if (workbook.worksheets.length > 32) throw new Error('В книге XLSX слишком много листов');
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS) throw new Error(`Лист «${sheet.name}» превышает допустимый размер: ${MAX_ROWS} строк и ${MAX_COLUMNS} колонок`);
    for (let rowNumber = 1; rowNumber <= Math.min(20, sheet.rowCount); rowNumber++) {
      const columns = new Map<string, number>(); const duplicates = new Set<string>();
      sheet.getRow(rowNumber).eachCell((cell, column) => {
        const name = normalized(plainText(cachedValue(cell)));
        if (columns.has(name)) duplicates.add(name); else columns.set(name, column);
      });
      if (REQUIRED.every(name => columns.has(name))) {
        if (REQUIRED.some(name => duplicates.has(name))) throw new Error('Обязательные колонки в заголовке XLSX повторяются');
        candidates.push({ sheet, rowNumber, columns });
      }
    }
  }
  if (!candidates.length) throw new Error('В первых 20 строках не найдены обязательные колонки: Команда, Метрика, Значение метрики, Цель метрики');
  if (candidates.length > 1) throw new Error('Найдено несколько таблиц модели зрелости. Выберите книгу с одним целевым листом.');
  const { sheet, rowNumber: header, columns } = candidates[0];
  const rows: ParsedMaturityRow[] = [], issues: ImportIssue[] = [];
  let ignoredRows = 0;
  for (let rowNumber = header + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const report = (code: string, message: string) => { issues.push({ severity: 'error', code, message, rowNumber }); };
    const team = plainText(cachedValue(row.getCell(columns.get('команда')!), report));
    const metricName = plainText(cachedValue(row.getCell(columns.get('метрика')!), report));
    if (!team || !metricName) { ignoredRows++; continue; }
    const code = team.match(/\s*\(([A-Za-z0-9][A-Za-z0-9_.-]{1,99})\)\s*$/);
    const codeColumn = columns.get('код команды');
    const explicitCode = codeColumn ? plainText(cachedValue(row.getCell(codeColumn), report)) : '';
    if (explicitCode && code?.[1] && explicitCode !== code[1]) report('conflicting_team_code', 'Код команды в отдельной колонке отличается от кода в её названии.');
    const valueCell = row.getCell(columns.get('значение метрики')!);
    const raw = cachedValue(valueCell), valueText = plainText(raw), stateText = normalized(valueText);
    let state: ParsedMaturityRow['state'] = 'numeric';
    let value: number | null = null, reason: string | null = null;
    if (stateText === 'в исключениях') { state = 'exception'; reason = valueText; }
    else if (stateText === 'нет релизов' || stateText === 'нет pr') { state = 'no_events'; reason = valueText; }
    else {
      value = percentage(valueCell, 'value', report).number;
      if (value === null) { state = 'missing'; reason = valueText || 'Значение отсутствует или не распознано'; }
    }
    const target = percentage(row.getCell(columns.get('цель метрики')!), 'target', report).number;
    rows.push({ rowNumber, teamName: code ? team.slice(0, code.index).trim() : team, teamCode: explicitCode || code?.[1] || null, metricName, value, target, state, reason });
    if (rows.length > MAX_FACTS) throw new Error(`В XLSX больше ${MAX_FACTS} наблюдений`);
  }
  if (!rows.length) throw new Error('В книге XLSX нет строк наблюдений с командой и метрикой');
  return { sheetName: sheet.name, rows, ignoredRows, issues };
}
