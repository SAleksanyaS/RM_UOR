// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { OverviewPage } from './OverviewPage';

afterEach(cleanup);
const titles = ['Базовые практики модели зрелости', 'Плотность высокоприоритетных дефектов', 'Качество данных без загруженных фактов'];
function fixture(empty = false) {
  const leaders = [{ id: 'leader-a', name: 'Вольнова Т.', teams: [] }, { id: 'leader-b', name: 'Сидоров В.', teams: [] }];
  const goals = titles.map((title, index) => ({ id: `goal-${index}`, title, category: 'process', summary: '', unit: '%', officialTarget: 80, internalTarget: null, direction: 'increase', status: 'active', weight: null, links: [], actions: [] }));
  const evaluation = (leaderId: string | null, actual: number) => ({ id: String(leaderId), goalId: 'goal-0', leaderId, actual, officialTarget: 80, internalTarget: null, official: actual >= 80 ? 'met' : 'not_met', internal: 'unknown', validation: actual >= 80 ? 'pending' : 'not_required', period: '2026-10-02', qualityFlags: ['stale'], coverage: 100, eligibleParticipants: 2, metParticipants: 2, fingerprint: 'fp', snapshotIds: [] });
  return { catalog: { goals: empty ? [] : goals, leaders: empty ? [] : leaders, assignments: empty ? [] : goals.flatMap(goal => leaders.map(leader => ({ id: `${goal.id}-${leader.id}`, goalId: goal.id, leaderId: leader.id, teams: [] }))), sources: [], comments: [], entities: [] }, snapshots: [], evaluations: empty ? [] : [evaluation(null, 91.5), evaluation('leader-a', 100), evaluation('leader-b', 75)] } as unknown as ClientState;
}
function setup(empty = false, override?: ClientState) {
  const onGoal = vi.fn(); const onLeader = vi.fn();
  render(<WorkspaceContext value={{ state: override || fixture(empty), mutate: vi.fn(async () => ({})), refresh: vi.fn(async () => {}), notify: vi.fn() }}><OverviewPage onLeader={onLeader} onGoal={onGoal} onMatrix={vi.fn()} onSources={vi.fn()}/></WorkspaceContext>);
  return { onGoal, onLeader };
}
it('opens on all goals and counts portfolio status in goals rather than assignments', () => {
  setup();
  expect((screen.getByLabelText('Статистика') as HTMLSelectElement).value).toBe('all');
  const hero = screen.getByRole('region', { name: 'Общий статус ДИТ' });
  expect(within(hero).getByText('Подтверждено 0 из 3')).toBeTruthy();
  expect(within(hero).getByText('Осталось 3')).toBeTruthy();
  expect(within(hero).getByText('Оценено 1 из 3 целей')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Все цели по ИТ-лидерам' })).toBeTruthy();
});
it('offers every goal including goals with no facts in the statistics selector', () => {
  setup();
  const options = within(screen.getByLabelText('Статистика')).getAllByRole('option');
  expect(options.map(option => option.textContent)).toEqual(['Все цели', ...titles]);
  expect(within(screen.getByRole('list', { name: 'Реестр целей' })).getAllByRole('listitem')).toHaveLength(3);
});
it('rescopes to the selected goal and keeps its missing facts explicit', () => {
  setup();
  fireEvent.change(screen.getByLabelText('Статистика'), { target: { value: 'goal-2' } });
  const hero = screen.getByRole('region', { name: 'Статус выбранной цели' });
  expect(within(hero).getByRole('heading', { name: titles[2] })).toBeTruthy();
  expect(within(hero).getAllByText('Нет данных').length).toBeGreaterThan(0);
  const chart = screen.getByRole('region', { name: 'Факт выбранной цели по ИТ-лидерам' });
  const leaderRows = within(chart).getAllByRole('button');
  expect(leaderRows).toHaveLength(2);
  leaderRows.forEach(row => expect(within(row).getByText('Нет данных')).toBeTruthy());
  expect(within(screen.getByRole('list', { name: 'Реестр целей' })).getAllByRole('listitem')).toHaveLength(1);
});
it('does not present the numeric maturity result as overall DIT progress', () => {
  setup();
  const hero = screen.getByRole('region', { name: 'Общий статус ДИТ' });
  expect(within(hero).queryByText('91,5%')).toBeNull();
  fireEvent.change(screen.getByLabelText('Статистика'), { target: { value: 'goal-0' } });
  expect(within(screen.getByRole('region', { name: 'Статус выбранной цели' })).getByText('91,5%')).toBeTruthy();
});
it('keeps an empty portfolio unknown without inventing completion', () => {
  setup(true);
  expect(screen.getByText('Пока нет целей в повестке')).toBeTruthy();
  expect(screen.queryByText('100%')).toBeNull();
  expect(screen.getByRole('list', { name: 'Реестр целей' }).children).toHaveLength(0);
});
it('keeps a goal without assignments selectable without displaying zero-of-zero coverage', () => {
  const state = fixture();
  state.catalog.assignments = state.catalog.assignments.filter(assignment => assignment.goalId !== 'goal-2');
  setup(false, state);
  expect(within(screen.getByLabelText('Статистика')).getByRole('option', { name: titles[2] })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Статистика'), { target: { value: 'goal-2' } });
  const hero = screen.getByRole('region', { name: 'Статус выбранной цели' });
  expect(within(hero).getByText('Нет активных назначений')).toBeTruthy();
  expect(screen.queryByText('0/0')).toBeNull();
  expect(screen.queryByText('0 из 0')).toBeNull();
});
it('offers an inactive catalogue goal without adding it to the default active portfolio', () => {
  const state = fixture();
  state.catalog.goals.push({ ...state.catalog.goals[0], id: 'archive', title: 'Архивная цель без активных назначений' });
  state.catalog.assignments.push({ id: 'archive-assignment', goalId: 'archive', leaderId: 'leader-a', teams: [], active: false });
  setup(false, state);
  expect(within(screen.getByRole('region', { name: 'Общий статус ДИТ' })).getByText('Подтверждено 0 из 3')).toBeTruthy();
  expect(within(screen.getByLabelText('Статистика')).getByRole('option', { name: 'Архивная цель без активных назначений' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Статистика'), { target: { value: 'archive' } });
  expect(within(screen.getByRole('region', { name: 'Статус выбранной цели' })).getByText('Нет активных назначений')).toBeTruthy();
});
