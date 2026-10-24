// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import type { Goal } from '../../domain/contracts';
import { GoalEditor } from './GoalEditor';

afterEach(cleanup);
const goal = { id: 'g1', title: 'Зрелость', summary: '', officialTarget: null, internalTarget: null, weight: null, priority: null, ownerId: null, curatorId: null, dueDate: null, revision: 'r1', links: [{ label: 'Дашборд', url: 'https://example.com/old', kind: 'dashboard' }] } as unknown as Goal;
function setup() {
  const mutate = vi.fn(async (_path: string, _body?: unknown) => ({}));
  const state = { catalog: { assignments: [{ id: 'a1', goalId: 'g1', leaderId: 'l1', teams: ['Продукт А'], target: '80%', active: true }], leaders: [{ id: 'l1', name: 'ИТ-лидер' }] } } as unknown as ClientState;
  render(<WorkspaceContext value={{ state, mutate, notify: vi.fn(), refresh: vi.fn(async () => {}) }}><GoalEditor goal={goal} onClose={vi.fn()}/></WorkspaceContext>);
  return mutate;
}
it('saves changed applicability, scope and local target before publishing', async () => {
  const mutate = setup();
  fireEvent.click(screen.getByLabelText('Применяется: ИТ-лидер'));
  fireEvent.change(screen.getByLabelText('Объекты карты: ИТ-лидер'), { target: { value: 'Продукт Б, Продукт В\nПродукт Б' } });
  fireEvent.change(screen.getByLabelText('Цель назначения: ИТ-лидер'), { target: { value: '90%' } });
  fireEvent.click(screen.getByText('Сохранить и отправить'));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/assignments/a1', expect.objectContaining({ active: false, teams: ['Продукт Б', 'Продукт В'], target: '90%' })));
  expect(mutate.mock.calls.map(call => call[0])).toEqual(['/api/goals/g1', '/api/assignments/a1', '/api/publish']);
});
it('edits goal links and retains the known source kind', async () => {
  const mutate = setup();
  fireEvent.change(screen.getByLabelText('Ссылки цели'), { target: { value: 'Дашборд | https://example.com/old\nМетодика | https://example.com/method' } });
  fireEvent.click(screen.getByText('Сохранить черновик'));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/goals/g1', expect.objectContaining({ links: [{ label: 'Дашборд', url: 'https://example.com/old', kind: 'dashboard' }, { label: 'Методика', url: 'https://example.com/method', kind: 'reference' }] })));
});
it('lets a curator assign a named work direction without entering a technical code', async () => {
  const mutate = setup();
  fireEvent.change(screen.getByLabelText('Направление'), { target: { value: 'data' } });
  fireEvent.click(screen.getByText('Сохранить черновик'));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/goals/g1', expect.objectContaining({ workDirectionId: 'data' })));
});
