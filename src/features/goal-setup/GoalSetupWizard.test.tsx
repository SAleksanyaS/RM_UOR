// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { GoalSetupWizard } from './GoalSetupWizard';
afterEach(cleanup);
const catalog = { goals: [], leaders: [{ id: 'l1', name: 'Лидер кластера', teams: [] }], assignments: [], entities: [], sources: [], directions: [] };
function fixture(reader = false) {
  const mutate = vi.fn(async (path: string, _body: unknown) => path.endsWith('/preview') ? { previewId: 'p1', warnings: [], goal: { title: 'Новая цель' }, assignments: [], source: { name: 'Источник' }, evaluations: [] } : { goalId: 'new-goal', draftIds: ['d1'], operationId: 'op' });
  const onSaved = vi.fn();
  render(<WorkspaceContext value={{ state: { catalog, session: { role: reader ? 'reader' : 'curator', name: 'Куратор', curatorId: 'curator' } } as unknown as ClientState, mutate, refresh: vi.fn(async () => {}), notify: vi.fn() }}><GoalSetupWizard onSaved={onSaved} onClose={vi.fn()}/></WorkspaceContext>);
  return { mutate, onSaved };
}
it('explains curator access to a reader without an editable wizard', () => {
  fixture(true); expect(screen.getByText(/войдите как куратор/i)).toBeTruthy(); expect(screen.queryByLabelText('Полное название цели')).toBeNull();
});
it('creates a goal only after calculation preview and preserves the setup through each step', async () => {
  const f = fixture();
  fireEvent.change(screen.getByLabelText('Полное название цели'), { target: { value: 'Новая цель' } });
  fireEvent.change(screen.getByLabelText('Владелец цели'), { target: { value: 'Владелец' } });
  fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
  fireEvent.change(screen.getByLabelText('Официальное целевое значение'), { target: { value: '90' } });
  fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
  fireEvent.click(screen.getByLabelText('Лидер кластера'));
  fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
  fireEvent.click(screen.getByRole('button', { name: /Далее/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Проверить расчёт' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить цель в черновики' })).toBeTruthy());
  expect(f.mutate.mock.calls[0][0]).toBe('/api/goal-setup/preview');
  expect((f.mutate.mock.calls[0][1] as { sample: { rows: unknown[] } }).sample.rows).toEqual([]);
  const firstRequest = (f.mutate.mock.calls[0][1] as { requestId: string }).requestId;
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  fireEvent.click(screen.getByRole('button', { name: 'Проверить расчёт' }));
  await waitFor(() => expect(f.mutate.mock.calls.length).toBe(2));
  expect((f.mutate.mock.calls[1][1] as { requestId: string }).requestId).toBe(firstRequest);
  fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
  fireEvent.change(screen.getByLabelText('Период примера'), { target: { value: '2026-10-10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить расчёт' }));
  await waitFor(() => expect(f.mutate.mock.calls.length).toBe(3));
  expect((f.mutate.mock.calls[2][1] as { requestId: string }).requestId).not.toBe(firstRequest);
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить цель в черновики' }));
  await waitFor(() => expect(f.onSaved).toHaveBeenCalledWith({ goalId: 'new-goal', draftIds: ['d1'], operationId: 'op' }));
  expect(f.mutate.mock.calls[3]).toEqual(['/api/goal-setup/commit', { previewId: 'p1' }]);
});
