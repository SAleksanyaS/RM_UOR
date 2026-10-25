import { expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { parseTable } from './parser';

it('reads quoted CSV delimiters, multiline reasons and explicit zero without evaluating text', async () => {
  const table = await parseTable('facts.csv', Buffer.from('Участник;Факт;Причина\r\n"А;Б";0;"нет\nсобытий"'));
  expect(table.columns).toEqual(['Участник', 'Факт', 'Причина']);
  expect(table.rows).toEqual([{ rowNumber: 2, cells: ['А;Б', '0', 'нет\nсобытий'] }]);
});
it('rejects duplicate headers and malformed CSV instead of guessing columns', async () => {
  await expect(parseTable('f.csv', Buffer.from('A,A\nx,y'))).rejects.toThrow(/повтор/i);
  await expect(parseTable('f.csv', Buffer.from('A,B\n"broken,x'))).rejects.toThrow(/кавыч/i);
});
it('reads a selected XLSX sheet and rejects formulas as inert unsupported input', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Данные');
  sheet.addRow(['Факт', 'Дата']); sheet.addRow([0, '2026-10-24']);
  expect((await parseTable('f.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()))).rows[0].cells).toEqual(['0', '2026-10-24']);
  sheet.getCell('A2').value = { formula: '1+1', result: 2 };
  await expect(parseTable('f.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()))).rejects.toThrow(/формул/i);
});
it('bounds size and rejects ambiguous multi-sheet workbooks', async () => {
  await expect(parseTable('f.csv', Buffer.alloc(10 * 1024 * 1024 + 1))).rejects.toThrow(/10 МБ/);
  const workbook = new ExcelJS.Workbook(); for (const name of ['A', 'B']) workbook.addWorksheet(name).addRow(['Факт']);
  await expect(parseTable('f.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()))).rejects.toThrow(/один/i);
});
