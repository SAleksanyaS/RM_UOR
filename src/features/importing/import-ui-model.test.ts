import { expect, it } from 'vitest';
import { MAX_IMPORT_FILE_BYTES, validReportingDate, validateImportFile } from './import-ui-model';

it('rejects unsupported, empty and oversized workbooks before sending them', () => {
  expect(validateImportFile({ name: 'facts.xls', size: 100 })).toContain('XLSX');
  expect(validateImportFile({ name: 'facts.xlsx', size: 0 })).toContain('пустой');
  expect(validateImportFile({ name: 'facts.xlsx', size: MAX_IMPORT_FILE_BYTES + 1 })).toContain('10 МБ');
  expect(validateImportFile({ name: 'facts.XLSX', size: 100 })).toBeNull();
});
it('accepts only an explicit real reporting date', () => {
  expect(validReportingDate('')).toBe(false);
  expect(validReportingDate('2026-02-31')).toBe(false);
  expect(validReportingDate('2026-10-16')).toBe(true);
});
