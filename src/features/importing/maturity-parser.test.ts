import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseMaturityWorkbook } from './maturity-parser';

const headers = ['Блок', 'Трайб', 'Кластер', 'Команда', 'Этап APP', 'Группа практик', 'Метрика', 'Доля команд', 'Команд достигли', 'Всего команд', 'Доля метрик', 'Метрик достигли', 'Всего метрик', 'Значение метрики', 'Цель метрики'];
async function book(fill: (sheet: ExcelJS.Worksheet, workbook: ExcelJS.Workbook) => void) {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Синтетическая зрелость');
  fill(sheet, workbook); return Buffer.from(await workbook.xlsx.writeBuffer());
}
function fact(sheet: ExcelJS.Worksheet, team: string, metric: string, value: ExcelJS.CellValue, target: ExcelJS.CellValue) {
  const row = sheet.addRow([]); row.getCell(4).value = team; row.getCell(7).value = metric;
  row.getCell(14).value = value; row.getCell(15).value = target; return row;
}

describe('maturity XLSX parser', () => {
  it('finds the header after notes, ignores hierarchy totals and reads percentage strings, typed percentages and explicit zero', async () => {
    const bytes = await book(sheet => {
      sheet.addRow(['Вымышленная книга']); sheet.addRow([]); sheet.addRow(headers);
      sheet.addRow(['Итог блока']); const total = sheet.addRow([]); total.getCell(4).value = 'Команда А (DEMO001)';
      fact(sheet, 'Команда А (DEMO001)', 'Полное название первой метрики', '100,0%', '70%');
      const typed = fact(sheet, 'Команда Б (DEMO002)', 'Полное название второй метрики', 0.95, 0.8);
      typed.getCell(14).numFmt = '0.0%'; typed.getCell(15).numFmt = '0%';
      fact(sheet, 'Команда В', 'Третья метрика', 0, '80%');
    });
    const parsed = await parseMaturityWorkbook(bytes);
    expect(parsed.sheetName).toBe('Синтетическая зрелость');
    expect(parsed.rows).toHaveLength(3); expect(parsed.ignoredRows).toBe(2); expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ rowNumber: 6, teamName: 'Команда А', teamCode: 'DEMO001', metricName: 'Полное название первой метрики', value: 100, target: 70, state: 'numeric' });
    expect(parsed.rows[1]).toMatchObject({ value: 95, target: 80 });
    expect(parsed.rows[2]).toMatchObject({ teamCode: null, value: 0, state: 'numeric' });
  });

  it('keeps exceptions, no events, blanks and unknown text distinct from zero', async () => {
    const parsed = await parseMaturityWorkbook(await book(sheet => {
      sheet.addRow(headers);
      for (const value of ['В исключениях', 'Нет Релизов', 'Нет PR', '-', null, 'неизвестно']) fact(sheet, 'Команда А (DEMO001)', `Метрика ${sheet.rowCount}`, value, '80%');
    }));
    expect(parsed.rows.map(row => row.state)).toEqual(['exception', 'no_events', 'no_events', 'missing', 'missing', 'missing']);
    expect(parsed.rows.every(row => row.value === null)).toBe(true);
    expect(parsed.rows[2].reason).toBe('Нет PR');
    expect(parsed.issues).toEqual([expect.objectContaining({ severity: 'error', code: 'unknown_value', rowNumber: 7 })]);
  });

  it('reads an explicit team-code column and reports disagreement with the displayed suffix', async () => {
    const bytes = await book(sheet => {
      sheet.addRow(['Код команды', 'Команда', 'Метрика', 'Значение метрики', 'Цель метрики']);
      sheet.addRow(['team-a', 'Команда А', 'Практика А', 90, 80]);
      sheet.addRow(['team-b', 'Команда Б (OTHER)', 'Практика Б', 90, 80]);
    });
    const parsed = await parseMaturityWorkbook(bytes);
    expect(parsed.rows[0]).toMatchObject({ teamCode: 'team-a', teamName: 'Команда А' });
    expect(parsed.issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'conflicting_team_code', rowNumber: 3 }));
  });

  it('uses cached formula results without calculating formulas and reports absent cached results', async () => {
    const parsed = await parseMaturityWorkbook(await book(sheet => {
      sheet.addRow(headers);
      const cached = fact(sheet, 'Команда А', 'С результатом', { formula: '1-0.05', result: 0.95 }, '80%'); cached.getCell(14).numFmt = '0%';
      fact(sheet, 'Команда А', 'Без результата', { formula: 'WEBSERVICE("https://example.invalid/")' }, '80%');
    }));
    expect(parsed.rows[0].value).toBe(95); expect(parsed.rows[1].state).toBe('missing');
    expect(parsed.issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'formula_without_result', rowNumber: 3 }));
  });

  it('rejects invalid, empty, oversized and ambiguous workbooks', async () => {
    await expect(parseMaturityWorkbook(Buffer.alloc(0))).rejects.toThrow(/пуст/i);
    await expect(parseMaturityWorkbook(Buffer.from('not xlsx'))).rejects.toThrow(/XLSX|ZIP/i);
    await expect(parseMaturityWorkbook(Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow(/10 МБ/);
    const wrongHeaders = await book(sheet => { sheet.addRow(['wrong']); });
    const empty = await book(sheet => { sheet.addRow(headers); });
    await expect(parseMaturityWorkbook(wrongHeaders)).rejects.toThrow(/колон|заголов/i);
    await expect(parseMaturityWorkbook(empty)).rejects.toThrow(/наблюден|строк|данных/i);
    const ambiguous = await book((sheet, workbook) => {
      sheet.addRow(headers); fact(sheet, 'А', 'Метрика', 100, 80);
      const other = workbook.addWorksheet('Вторая'); other.addRow(headers); fact(other, 'Б', 'Метрика', 100, 80);
    });
    await expect(parseMaturityWorkbook(ambiguous)).rejects.toThrow(/несколько|неоднознач/i);
  });

  it('reports out-of-range percentages and malformed thresholds rather than coercing them', async () => {
    const parsed = await parseMaturityWorkbook(await book(sheet => {
      sheet.addRow(headers); fact(sheet, 'А', 'Первая', '101%', '80%'); fact(sheet, 'Б', 'Вторая', '90%', 'ошибка');
    }));
    expect(parsed.issues.map(issue => issue.code)).toEqual(['percentage_out_of_range', 'unknown_target']);
    expect(parsed.rows[0].value).toBeNull(); expect(parsed.rows[0].state).toBe('missing');
    expect(parsed.rows[1].target).toBeNull();
  });

  it('rejects declared ZIP expansion beyond the import limit before loading XML', async () => {
    const bytes = await book(sheet => { sheet.addRow(headers); fact(sheet, 'А', 'Метрика', '90%', '80%'); });
    const modified = Buffer.from(bytes);
    const directory = modified.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(directory).toBeGreaterThan(0); modified.writeUInt32LE(65 * 1024 * 1024, directory + 24);
    await expect(parseMaturityWorkbook(modified)).rejects.toThrow(/64 МБ/);
  });
});
