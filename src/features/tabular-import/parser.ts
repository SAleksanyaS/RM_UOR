import ExcelJS from 'exceljs';
import { checkArchive } from '../importing/maturity-parser';
import type { ParsedTable } from './contracts';
const MAX_BYTES = 10 * 1024 * 1024, MAX_ROWS = 20_000, MAX_COLUMNS = 100;

function csvRows(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0];
  // Count delimiters outside quotes; a delimiter inside a quoted header is data.
  const counts = new Map([[';', 0], [',', 0], ['\t', 0]]); let quote = false;
  for (let i = 0; i < firstLine.length; i++) { const c = firstLine[i]; if (c === '"') { if (quote && firstLine[i + 1] === '"') i++; else quote = !quote; } else if (!quote && counts.has(c)) counts.set(c, counts.get(c)! + 1); }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] && ranked[0][1] === ranked[1][1]) throw new Error('Неоднозначный разделитель CSV. Используйте запятую, точку с запятой или табуляцию.');
  const delimiter = ranked[0][0], rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
  const finishCell = () => { row.push(cell); cell = ''; closed = false; if (row.length > MAX_COLUMNS) throw new Error('В таблице больше 100 колонок'); };
  const finishRow = () => { finishCell(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > MAX_ROWS + 1) throw new Error('В таблице больше 20000 строк'); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; }
    else if (c === delimiter) finishCell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; finishRow(); }
    else if (c === '"') { if (cell || closed) throw new Error('Неверные кавычки CSV'); quoted = true; }
    else { if (closed) throw new Error('Лишний текст после кавычек CSV'); cell += c; }
    if (cell.length > 10000) throw new Error('Слишком длинная ячейка таблицы');
  }
  if (quoted) throw new Error('Не закрыты кавычки CSV');
  if (cell || row.length || closed) finishRow(); return rows;
}

/** Reads data only. Formula cells are rejected, never evaluated or fetched. */
export async function parseTable(name: string, bytes: Buffer): Promise<ParsedTable> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Размер файла должен быть от 1 байта до 10 МБ');
  let data: string[][];
  if (/\.csv$/i.test(name)) {
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { throw new Error('Сохраните CSV в кодировке UTF-8'); }
    if (text.includes('\0')) throw new Error('CSV содержит неподдерживаемые символы'); data = csvRows(text);
  } else if (/\.xlsx$/i.test(name)) {
    checkArchive(bytes); const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes as never);
    const sheets = book.worksheets.filter(sheet => sheet.rowCount > 0);
    if (sheets.length !== 1) throw new Error('Оставьте один непустой лист XLSX для импорта');
    const sheet = sheets[0]; if (sheet.rowCount > MAX_ROWS + 1 || sheet.columnCount > MAX_COLUMNS) throw new Error('Превышен размер таблицы: 20000 строк и 100 колонок');
    data = [];
    for (let r = 1; r <= sheet.rowCount; r++) {
      const row: string[] = [];
      for (let c = 1; c <= sheet.columnCount; c++) {
        const cell = sheet.getRow(r).getCell(c), value = cell.value;
        if (value && typeof value === 'object') throw new Error(`Строка ${r}: формулы, ссылки и сложные ячейки не поддерживаются. Сохраните значения и даты текстом ISO.`);
        const text = typeof value === 'number' ? String(value * (cell.numFmt?.replace(/"[^"]*"/g, '').replace(/\\%/g, '').includes('%') ? 100 : 1)) : value === null || value === undefined ? '' : String(value);
        if (text.length > 10000) throw new Error('Слишком длинная ячейка таблицы'); row.push(text);
      }
      data.push(row);
    }
  } else throw new Error('Выберите файл CSV или XLSX');
  const columns = (data.shift() ?? []).map(value => value.trim());
  if (!columns.length || columns.some(value => !value)) throw new Error('Первая строка должна содержать названия всех колонок');
  if (new Set(columns.map(value => value.normalize('NFKC').toLocaleLowerCase('ru'))).size !== columns.length) throw new Error('Названия колонок повторяются');
  const rows = data.map((cells, index) => ({ rowNumber: index + 2, cells })).filter(row => row.cells.some(value => value.trim()));
  if (rows.some(row => row.cells.length !== columns.length)) throw new Error('Количество ячеек строки отличается от заголовка');
  if (!rows.length) throw new Error('В таблице нет строк данных');
  return { columns, rows };
}
