// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import type { ReleasePreview } from './release-contracts';
import { ReleasePage } from './ReleasePage';
const state = (reader = false) => ({ catalog: { goals: [], leaders: [], assignments: [], sources: [], comments: [], entities: [] }, operations: [], drafts: [], session: { role: reader ? 'reader' : 'curator', curatorId: reader ? null : 'c', name: 'Анна' } }) as unknown as ClientState;
function preview(): ReleasePreview { return { id: 'p1', expiresAt: '2099-01-01T00:00:00Z', remoteCommit: 'release-hash', publishedCommit: 'main-hash', publicationAllowed: true, message: 'Проверьте состав.', drafts: [
  { id: 'd1', kind: 'goal', objectId: 'g1', label: 'Цель А', path: 'catalog/goals/g1.json', conflicts: ['/plan/targetDate'], fields: [{ path: '/plan', label: 'План', before: {}, local: { targetDate: '2026-11-01' }, remote: { targetDate: '2026-11-02' }, conflict: true }, { path: '/plan/targetDate', label: 'План / Обязательство', before: null, local: '2026-11-01', remote: '2026-11-02', conflict: true }] },
  { id: 'd2', kind: 'goal', objectId: 'g2', label: 'Цель Б', path: 'catalog/goals/g2.json', conflicts: ['/title'], fields: [{ path: '/title', label: 'Название', before: 'Б', local: 'Моё', remote: 'Коллеги', conflict: true }] },
  ], snapshots: [{ id: 's1', label: 'Срез', detail: '2026-10-25' }], attestations: [{ id: 'a1', label: 'Подтверждение А', detail: 'ДИТ', evidenceIds: ['e1'] }], evidence: [{ id: 'e1', label: 'Обязательный файл', detail: '10 байт' }, { id: 'e2', label: 'Отдельный файл', detail: '20 байт' }], templates: [{ id: 't1', label: 'Шаблон', detail: '3 слайда' }], releaseChanges: [{ id: 'sent', label: 'Уже отправленная запись', detail: 'Ещё не в основном выпуске' }] }; }
afterEach(cleanup);
it('resolves only actual conflict paths, retains failed choices and refreshes signatures before the next conflict', async () => {
  let previews = 0, resolutions = 0; const first = preview();
  const mutate = vi.fn(async (path: string, _body?: unknown) => {
    if (path === '/api/release/preview') { previews++; return { ...first, id: `p${previews}`, drafts: first.drafts.map((d, i) => ({ ...d, conflicts: previews > i + 1 ? [] : d.conflicts })) }; }
    if (path === '/api/release/resolve') { resolutions++; if (resolutions === 1) throw new Error('Выпуск изменился; выбор сохранён'); return {}; }
    return {};
  });
  render(<WorkspaceContext value={{ state: state(), mutate, notify: vi.fn(), refresh: vi.fn(async () => {}) }}><ReleasePage/></WorkspaceContext>);
  await waitFor(() => expect(screen.getByLabelText('Вариант для План / Обязательство')).toBeTruthy());
  expect(screen.getAllByRole('combobox')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Вариант для План / Обязательство'), { target: { value: 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить конфликт Цель А' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Выпуск изменился'));
  expect((screen.getByLabelText('Вариант для План / Обязательство') as HTMLSelectElement).value).toBe('local');
  expect(mutate).toHaveBeenCalledWith('/api/release/resolve', { previewId: 'p1', draftId: 'd1', choices: { '/plan/targetDate': 'local' } });
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить конфликт Цель А' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Разрешить конфликт Цель А' })).toBeNull());
  expect(previews).toBe(2);
  fireEvent.change(screen.getByLabelText('Вариант для Название'), { target: { value: 'remote' } });
  fireEvent.click(screen.getByRole('button', { name: 'Разрешить конфликт Цель Б' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/release/resolve', { previewId: 'p2', draftId: 'd2', choices: { '/title': 'remote' } }));
});
it('makes publication composition explicit, pins required evidence, excludes templates by default and offers no reader mutation', async () => {
  const value = preview(); value.drafts = [{ ...value.drafts[0], conflicts: [], fields: [] }];
  const mutate = vi.fn(async (path: string, _body?: unknown) => path === '/api/release/preview' ? value : { operationId: 'publish-operation' });
  const ctx = { state: state(true), mutate, notify: vi.fn(), refresh: vi.fn(async () => {}) };
  const view = render(<WorkspaceContext value={ctx}><ReleasePage/></WorkspaceContext>);
  expect(screen.queryByRole('button', { name: 'Отправить выбранное в готовящийся выпуск' })).toBeNull(); expect(mutate).not.toHaveBeenCalled();
  view.rerender(<WorkspaceContext value={{ ...ctx, state: state() }}><ReleasePage/></WorkspaceContext>);
  await waitFor(() => expect(screen.getByLabelText('Включить шаблон: Шаблон')).toBeTruthy());
  expect((screen.getByLabelText('Включить шаблон: Шаблон') as HTMLInputElement).checked).toBe(false);
  const required = screen.getByLabelText('Включить доказательство: Обязательный файл') as HTMLInputElement;
  expect(required.checked).toBe(true); expect(required.disabled).toBe(true);
  expect((screen.getByLabelText('Включить доказательство: Отдельный файл') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText('Включить снимок: Срез'));
  fireEvent.click(screen.getByLabelText('Включить доказательство: Отдельный файл'));
  fireEvent.click(screen.getByLabelText('Включить шаблон: Шаблон'));
  fireEvent.click(screen.getByRole('button', { name: 'Отправить выбранное в готовящийся выпуск' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/publish', { previewId: 'p1', draftIds: ['d1'], snapshotIds: [], attestationIds: ['a1'], evidenceIds: ['e1', 'e2'], templateIds: ['t1'] }));
  expect(screen.getByText(/Уже отправлено в готовящийся выпуск/)).toBeTruthy();
  const other = preview(); other.id = 'other-profile'; other.drafts = [{ ...other.drafts[0], label: 'Правка другого профиля', conflicts: [], fields: [] }];
  mutate.mockImplementation(async (path: string, _body?: unknown) => path === '/api/release/preview' ? other : { operationId: 'other-operation' });
  const otherState = state(); otherState.session.curatorId = 'different-curator';
  view.rerender(<WorkspaceContext value={{ ...ctx, state: otherState }}><ReleasePage/></WorkspaceContext>);
  await waitFor(() => expect(screen.getByLabelText('Включить правку: Правка другого профиля')).toBeTruthy());
  expect(screen.queryByLabelText('Включить правку: Цель А')).toBeNull();
  expect((screen.getByLabelText('Включить шаблон: Шаблон') as HTMLInputElement).checked).toBe(false);
});
