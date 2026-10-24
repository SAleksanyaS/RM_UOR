// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import type { MaturityImportPreview } from './import-contracts';
import { MaturityImportWizard } from './MaturityImportWizard';

afterEach(cleanup);
const preview: MaturityImportPreview = { id: 'preview-1', operationId: 'preview-operation', goalId: 'maturity', sourceId: 'file', period: '2026-10-16', fileName: 'facts.xlsx', fileHash: 'hash', createdAt: '2026-10-24T10:00:00Z', expiresAt: '2026-10-24T11:00:00Z', canCommit: true, duplicateSnapshotId: null, summary: { rows: 12, teams: 3, eligibleMetrics: 10, excluded: 2, missing: 0, unmappedTeams: 0, unmappedMetrics: 0 }, issues: [], teamMatches: [], metricMatches: [], changes: { added: 2, changed: 3, removed: 1, unchanged: 6, baselineSnapshotId: 'previous' }, sample: [], evaluation: null };
function setup(role: 'reader' | 'curator' = 'curator', result = preview) {
  const mutate = vi.fn(async (_path: string, _body?: unknown) => result);
  const state = { session: { role }, catalog: { goals: [{ id: 'maturity', title: 'Базовые практики модели зрелости', requiredMetricIds: ['p1', 'p2'] }], sources: [{ id: 'file', name: 'Локальная выгрузка модели зрелости', kind: 'file', goalIds: ['maturity'] }] } } as unknown as ClientState;
  render(<WorkspaceContext value={{ state, mutate, refresh: vi.fn(async () => {}), notify: vi.fn() }}><MaturityImportWizard onClose={vi.fn()}/></WorkspaceContext>);
  return mutate;
}
async function chooseFile() { fireEvent.change(screen.getByLabelText('Файл XLSX'), { target: { files: [new File(['workbook'], 'facts.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })] } }); await waitFor(() => expect(screen.getByText('facts.xlsx')).toBeTruthy()); }
it('keeps upload controls unavailable to a reader', () => {
  const mutate = setup('reader');
  expect(screen.queryByLabelText('Файл XLSX')).toBeNull();
  expect(screen.getByText('Загрузка доступна куратору УОР')).toBeTruthy();
  expect(mutate).not.toHaveBeenCalled();
});
it('requires an explicit period and invalidates the preview when parameters change', async () => {
  const mutate = setup();
  await chooseFile();
  expect((screen.getByRole('button', { name: 'Проверить файл' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Период данных'), { target: { value: '2026-10-16' } });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить файл' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить личный срез' })).toBeTruthy());
  expect(mutate).toHaveBeenCalledWith('/api/import/maturity/preview', expect.objectContaining({ period: '2026-10-16', sourceUpdatedAt: null, name: 'facts.xlsx' }));
  fireEvent.click(screen.getByRole('button', { name: 'Изменить файл и даты' }));
  fireEvent.change(screen.getByLabelText('Период данных'), { target: { value: '2026-10-17' } });
  expect(screen.queryByRole('button', { name: 'Сохранить личный срез' })).toBeNull();
  expect(screen.getByText('facts.xlsx')).toBeTruthy();
});
it('shows a duplicate and the actual change counts without offering another save', async () => {
  setup('curator', { ...preview, duplicateSnapshotId: 'existing-snapshot' });
  await chooseFile();
  fireEvent.change(screen.getByLabelText('Период данных'), { target: { value: '2026-10-16' } });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить файл' }));
  await waitFor(() => expect(screen.getByText('Срез уже загружен')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Сохранить личный срез' })).toBeNull();
  expect(screen.getByLabelText('Изменено: 3')).toBeTruthy();
  expect(screen.getByLabelText('Не вошло в новый срез: 1')).toBeTruthy();
});
it('does not reuse the previous workbook after selecting an unsupported replacement', async () => {
  setup();
  await chooseFile();
  fireEvent.change(screen.getByLabelText('Период данных'), { target: { value: '2026-10-16' } });
  fireEvent.change(screen.getByLabelText('Файл XLSX'), { target: { files: [new File(['unsupported'], 'replacement.csv')] } });
  expect(screen.getByRole('alert').textContent).toContain('XLSX');
  expect(screen.queryByText('facts.xlsx')).toBeNull();
  expect((screen.getByRole('button', { name: 'Проверить файл' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('Период данных') as HTMLInputElement).value).toBe('2026-10-16');
});
it('requires a fresh preview after correcting an unresolved team and sends its selected mapping', async () => {
  const unresolved = { ...preview, canCommit: false, teamMatches: [{ key: 'team-key', name: 'Команда из файла', matchedId: null, status: 'ambiguous' as const, options: [{ id: 'team-a', name: 'Команда А' }, { id: 'team-b', name: 'Команда Б' }] }, { key: 'known', name: 'Уже известная команда', matchedId: 'team-c', status: 'matched' as const, options: [{ id: 'team-c', name: 'Команда В' }] }] };
  const mutate = setup('curator', unresolved);
  await chooseFile();
  fireEvent.change(screen.getByLabelText('Период данных'), { target: { value: '2026-10-16' } });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить файл' }));
  await waitFor(() => expect(screen.getByLabelText('Сопоставить команду: Команда из файла')).toBeTruthy());
  expect(screen.queryByLabelText('Сопоставить команду: Уже известная команда')).toBeNull();
  fireEvent.change(screen.getByLabelText('Сопоставить команду: Команда из файла'), { target: { value: 'team-b' } });
  expect(screen.queryByRole('button', { name: 'Сохранить личный срез' })).toBeNull();
  mutate.mockResolvedValueOnce(preview);
  fireEvent.click(screen.getByRole('button', { name: 'Проверить исправления' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить личный срез' })).toBeTruthy());
  expect(mutate).toHaveBeenLastCalledWith('/api/import/maturity/preview', expect.objectContaining({ teamMapping: { 'team-key': 'team-b' } }));
});
