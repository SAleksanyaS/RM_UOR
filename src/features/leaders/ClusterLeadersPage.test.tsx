// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { ClusterLeadersPage } from './ClusterLeadersPage';

afterEach(cleanup);
const leader = { id: 'leader-a', name: 'Иванов Иван Иванович', clusterName: 'Кластер А', teams: ['Исходное название'] };
const goals = [{ id: 'g1', title: 'Надёжность', category: 'process' }, { id: 'g2', title: 'Зрелость', category: 'process' }];
function fixture(curator = true, fail = false) {
  const mutate = vi.fn(async () => { if (fail) throw new Error('Сохранение не удалось'); return {}; }), onLeader = vi.fn(), onGoal = vi.fn();
  const state = { session: { role: curator ? 'curator' : 'reader' }, catalog: { leaders: [leader], goals,
    assignments: [{ id: 'a1', leaderId: leader.id, goalId: 'g1' }, { id: 'a2', leaderId: leader.id, goalId: 'g1' }, { id: 'a3', leaderId: leader.id, goalId: 'g2', active: false }] } } as unknown as ClientState;
  render(<WorkspaceContext value={{ state, mutate, notify: vi.fn(), refresh: vi.fn(async () => {}) }}><ClusterLeadersPage onLeader={onLeader} onGoal={onGoal}/></WorkspaceContext>);
  return { mutate, onLeader, onGoal };
}
it('shows a clear read-only leader directory with unique active-goal counts and navigation', () => {
  const f = fixture(false); const row = screen.getByRole('row', { name: /Иванов Иван Иванович/ });
  expect(within(row).getByText('1 цель')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Добавить ИТ-лидера' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Изменить ИТ-лидера/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: leader.name })); expect(f.onLeader).toHaveBeenCalledWith(leader.id);
  fireEvent.click(screen.getByRole('button', { name: 'Надёжность' })); expect(f.onGoal).toHaveBeenCalledWith('g1');
});
it('creates a leader with selected goals through the explicit add action', async () => {
  const f = fixture(); fireEvent.click(screen.getByRole('button', { name: 'Добавить ИТ-лидера' }));
  fireEvent.change(screen.getByLabelText('ФИО ИТ-лидера'), { target: { value: 'Петров Пётр Петрович' } });
  fireEvent.change(screen.getByLabelText('Название кластера'), { target: { value: 'Новый кластер' } });
  fireEvent.click(screen.getByLabelText('Зрелость')); fireEvent.click(screen.getByRole('button', { name: 'Сохранить ИТ-лидера' }));
  await waitFor(() => expect(f.mutate).toHaveBeenCalledWith('/api/leaders', { name: 'Петров Пётр Петрович', clusterName: 'Новый кластер', goalIds: ['g2'] }));
});
it('edits the complete goal membership with its original CAS baseline, retaining input on an error', async () => {
  const f = fixture(true, true); fireEvent.click(screen.getByRole('button', { name: `Изменить ИТ-лидера ${leader.name}` }));
  fireEvent.click(screen.getByLabelText('Надёжность')); fireEvent.click(screen.getByLabelText('Зрелость'));
  fireEvent.change(screen.getByLabelText('Название кластера'), { target: { value: 'Новое название' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить ИТ-лидера' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сохранение не удалось'));
  expect(f.mutate).toHaveBeenCalledWith('/api/leaders/leader-a', { baseLeader: leader, baseGoalIds: ['g1'], name: leader.name, clusterName: 'Новое название', goalIds: ['g2'] });
  expect((screen.getByLabelText('Зрелость') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Название кластера') as HTMLInputElement).value).toBe('Новое название');
});
