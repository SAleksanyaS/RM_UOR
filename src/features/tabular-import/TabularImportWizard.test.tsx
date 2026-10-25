// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { TabularImportWizard } from './TabularImportWizard';
afterEach(cleanup);
function setup(role = 'curator') {
  const probe = { sourceId: 'file', columns: ['Команда', 'Факт'], rows: [{ rowNumber: 2, cells: ['Внешняя команда', '90'] }], columnValues: { Команда: ['Внешняя команда'], Факт: ['90'] }, profile: { parser: 'tabular-v1', columns: { value: '' }, defaults: { period: '', metricId: 'm' }, leaderMapping: {}, participantMapping: {}, metricMapping: {} }, options: { leaders: [{ id: 'l', name: 'Лидер' }], participants: [{ id: 'p', name: 'Команда А' }], metrics: [{ id: 'm', name: 'Охват' }] } };
  const preview = { id: 'preview', canCommit: true, duplicateSnapshotId: null, issues: [], sample: [{ id: 'r', participantName: 'Команда А', metricName: 'Охват', value: 90, state: 'numeric', target: 80 }], evaluations: [{ id: 'e', leaderId: null, actual: 100, missing: 0, official: 'met' }], rows: 1, facts: 1, period: '2026-10-24' };
  const mutate = vi.fn(async (path: string) => path.endsWith('/probe') ? probe : path.endsWith('/preview') ? preview : { snapshotId: 'snapshot', duplicate: false });
  const onClose = vi.fn(), refresh = vi.fn(async () => {});
  render(<WorkspaceContext value={{ state: { session: { role }, catalog: { goals: [{ id: 'g', title: 'Цель', measurement: { kind: 'participant_share' } }], sources: [{ id: 'file', name: 'Файл', kind: 'file', goalIds: ['g'] }] } } as unknown as ClientState, mutate, refresh, notify: vi.fn() }}><TabularImportWizard goalId="g" sourceId="file" onClose={onClose}/></WorkspaceContext>);
  return { mutate, onClose, refresh };
}
it('reads a file, requires explicit mapping and period, previews and accepts only on a separate click', async () => {
  const { mutate, onClose, refresh } = setup();
  fireEvent.change(screen.getByLabelText('Файл CSV или XLSX'), { target: { files: [new File(['Команда;Факт\nВнешняя команда;90'], 'f.csv')] } });
  await waitFor(() => expect(screen.getByText('f.csv')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Прочитать колонки' }));
  await waitFor(() => expect(screen.getByLabelText('Колонка: Значение')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Колонка: Значение'), { target: { value: 'Факт' } });
  fireEvent.change(screen.getByLabelText('Колонка: Участник'), { target: { value: 'Команда' } });
  fireEvent.change(screen.getByLabelText('Участник: Внешняя команда'), { target: { value: 'p' } });
  fireEvent.change(screen.getByLabelText('Период данных'), { target: { value: '2026-10-24' } });
  fireEvent.click(screen.getByRole('button', { name: 'Рассчитать предпросмотр' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Принять факты' })).toBeTruthy());
  expect(mutate).toHaveBeenLastCalledWith('/api/import/tabular/preview', expect.objectContaining({ profile: expect.objectContaining({ participantMapping: { 'Внешняя команда': 'p' }, columns: { value: 'Факт', participant: 'Команда' } }), sourceUpdatedAt: null }));
  expect(mutate.mock.calls.some(c => c[0].endsWith('/commit'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Принять факты' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled()); expect(refresh).toHaveBeenCalled();
});
it('hides file and write controls from readers', () => { const { mutate } = setup('reader'); expect(screen.queryByLabelText('Файл CSV или XLSX')).toBeNull(); expect(mutate).not.toHaveBeenCalled(); });
it('allows manual source data through pasted CSV without selecting a file', async () => {
  const { mutate } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Вставить таблицу' }));
  fireEvent.change(screen.getByLabelText('Таблица CSV'), { target: { value: 'Команда;Факт\nВнешняя команда;90' } });
  fireEvent.click(screen.getByRole('button', { name: 'Прочитать колонки' }));
  await waitFor(() => expect(screen.getByLabelText('Колонка: Значение')).toBeTruthy());
  expect(mutate).toHaveBeenLastCalledWith('/api/import/tabular/probe', expect.objectContaining({ name: 'Вставленная таблица.csv', base64: btoa(unescape(encodeURIComponent('Команда;Факт\nВнешняя команда;90'))) }));
});
it('invalidates an existing preview immediately after any mapping change', async () => {
  setup(); fireEvent.change(screen.getByLabelText('Файл CSV или XLSX'), { target: { files: [new File(['x'], 'f.csv')] } });
  await waitFor(() => expect(screen.getByText('f.csv')).toBeTruthy()); fireEvent.click(screen.getByRole('button', { name: 'Прочитать колонки' }));
  await waitFor(() => expect(screen.getByLabelText('Колонка: Значение')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Колонка: Значение'), { target: { value: 'Факт' } });
  fireEvent.change(screen.getByLabelText('Период данных'), { target: { value: '2026-10-24' } });
  fireEvent.click(screen.getByRole('button', { name: 'Рассчитать предпросмотр' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Принять факты' })).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Колонка: Значение'), { target: { value: 'Команда' } });
  expect(screen.queryByRole('button', { name: 'Принять факты' })).toBeNull();
});
