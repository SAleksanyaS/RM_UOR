// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceContext, type ClientState, type WorkspaceContextValue } from '../../app/AppContext';
import type { ExecutionPlan, Goal } from '../../domain/contracts';
import { ExecutionPlanPanel } from './ExecutionPlanPanel';
import { PlanningPage } from './PlanningPage';

afterEach(cleanup);
const goal = (id: string, title: string): Goal => ({ id, title, category: 'process', summary: '', target: '', metric: '', status: '', actions: [], scopeType: '', links: [], ownerId: null, curatorId: null, officialTarget: 80, internalTarget: null, unit: '%', direction: 'increase', baseline: null, weight: null, priority: null, dueDate: '2026-12-31', revision: 'goal-1' });
const plan = (patch: Partial<ExecutionPlan> = {}): ExecutionPlan => ({ stage: 'blocked', plannedStartDate: '2026-10-01', targetDate: '2026-11-20', forecastDate: '2026-11-25', nextCheckDate: '2026-11-01', nextAction: 'Согласовать доступ', blocker: 'Не выданы права', decisionNeeded: 'Назначить владельца доступа', updatedBy: 'Куратор УОР', updatedAt: '2026-10-24T12:00:00Z', revision: 'plan-1', ...patch });
function fixture(curator = true): ClientState {
  return { catalog: { schemaVersion: 1, id: 'catalog', name: '', classification: 'demo', importedAt: '', goals: [goal('g1', 'Базовые практики модели зрелости'), goal('g2', 'Качество данных')], leaders: [{ id: 'l1', name: 'Вольнова Т.', teams: [] }, { id: 'l2', name: 'Сидоров В.', teams: [] }], assignments: [{ id: 'a1', goalId: 'g1', leaderId: 'l1', teams: [], active: true }, { id: 'a2', goalId: 'g2', leaderId: 'l2', teams: [], active: true }], sources: [], comments: [], entities: [] }, snapshots: [], attestations: [], evaluations: [], session: { id: 'session', role: curator ? 'curator' : 'reader', name: 'Куратор УОР', curatorId: curator ? 'curator' : null, createdAt: '' }, csrfToken: 'token', operations: [], changes: [], drafts: [], updates: { status: 'current', checkedAt: null, currentCommit: null, remoteCommit: null, message: '', changes: [] }, version: '', repository: { url: '', publishedBranch: '', releaseBranch: '', publicationMode: '' } };
}
function context(state: ClientState, mutate: WorkspaceContextValue['mutate'] = vi.fn(async (_path: string, _body?: unknown) => ({}))): WorkspaceContextValue { return { state, mutate, notify: vi.fn(), refresh: vi.fn(async () => {}) }; }

it('keeps missing plans explicit for readers and does not offer an inactive assignment editor', () => {
  const state = fixture(false); const ctx = context(state);
  const view = render(<WorkspaceContext value={ctx}><ExecutionPlanPanel goalId="g1" leaderId={null}/></WorkspaceContext>);
  expect(screen.getByText('План не задан')).toBeTruthy();
  expect(screen.getByText('Прогноз не задан')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /план/i })).toBeNull();
  state.session.role = 'curator'; state.catalog.assignments[0].active = false;
  view.rerender(<WorkspaceContext value={{ ...ctx, state }}><ExecutionPlanPanel goalId="g1" leaderId="l1"/></WorkspaceContext>);
  expect(screen.getByText('Нет активного назначения')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /план/i })).toBeNull();
});

it('saves a deliberately selected work stage and keeps commitment and forecast separate from the official deadline', async () => {
  const ctx = context(fixture());
  render(<WorkspaceContext value={ctx}><ExecutionPlanPanel goalId="g1" leaderId="l1"/></WorkspaceContext>);
  fireEvent.click(screen.getByRole('button', { name: 'Настроить план' }));
  expect((screen.getByLabelText('Этап работ') as HTMLSelectElement).value).toBe('');
  expect(screen.getByText('31.12.2026')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Этап работ'), { target: { value: 'ready_for_review' } });
  fireEvent.change(screen.getByLabelText('Обязательство по сроку'), { target: { value: '2026-11-20' } });
  fireEvent.change(screen.getByLabelText('Прогноз завершения'), { target: { value: '2026-11-25' } });
  fireEvent.change(screen.getByLabelText('Следующий шаг'), { target: { value: 'Предъявить артефакты' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить план' }));
  await waitFor(() => expect(ctx.mutate).toHaveBeenCalledWith('/api/plans', { goalId: 'g1', leaderId: 'l1', baseRevision: null, plan: { stage: 'ready_for_review', plannedStartDate: null, targetDate: '2026-11-20', forecastDate: '2026-11-25', nextCheckDate: null, nextAction: 'Предъявить артефакты', blocker: '', decisionNeeded: '' } }));
  expect(screen.queryByText('Цель выполнена')).toBeNull();
});

it('pins the opened revision and preserves entered text after a concurrent-edit conflict', async () => {
  const state = fixture(); state.catalog.goals[0].plan = plan();
  const mutate = vi.fn(async (_path: string, _body?: unknown) => { throw new Error('План изменён другим куратором. Обновите данные.'); });
  const ctx = context(state, mutate);
  const view = render(<WorkspaceContext value={ctx}><ExecutionPlanPanel goalId="g1" leaderId={null}/></WorkspaceContext>);
  fireEvent.click(screen.getByRole('button', { name: 'Изменить план' }));
  fireEvent.change(screen.getByLabelText('Следующий шаг'), { target: { value: 'Мой незавершённый текст' } });
  const newer = structuredClone(state); newer.catalog.goals[0].plan = plan({ revision: 'plan-2', nextAction: 'Чужой текст' });
  view.rerender(<WorkspaceContext value={{ ...ctx, state: newer }}><ExecutionPlanPanel goalId="g1" leaderId={null}/></WorkspaceContext>);
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить план' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('План изменён другим куратором'));
  expect((screen.getByLabelText('Следующий шаг') as HTMLTextAreaElement).value).toBe('Мой незавершённый текст');
  expect(mutate).toHaveBeenCalledWith('/api/plans', expect.objectContaining({ baseRevision: 'plan-1' }));
});

it('locks every plan field and cancellation while a save is running and unlocks on an error', async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const ctx = context(fixture(), vi.fn(async () => pending));
  render(<WorkspaceContext value={ctx}><ExecutionPlanPanel goalId="g1" leaderId={null}/></WorkspaceContext>);
  fireEvent.click(screen.getByRole('button', { name: 'Настроить план' }));
  fireEvent.change(screen.getByLabelText('Этап работ'), { target: { value: 'planned' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить план' }));
  expect(screen.getByLabelText('Этап работ').matches(':disabled')).toBe(true);
  expect(screen.getByLabelText('Что требуется от директора').matches(':disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Отмена' }).matches(':disabled')).toBe(true);
  reject(new Error('Не удалось сохранить'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Не удалось сохранить'));
  expect(screen.getByLabelText('Этап работ').matches(':disabled')).toBe(false);
});

it('puts real decisions first and filters the work list to a named leader without inheriting the DIT plan', () => {
  const state = fixture(false); state.catalog.goals[0].plan = plan({ nextAction: 'Общий шаг ДИТ' });
  state.catalog.assignments[0].plan = plan({ stage: 'in_progress', decisionNeeded: '', blocker: '', nextAction: 'Проверить команды' });
  const onGoal = vi.fn();
  render(<WorkspaceContext value={context(state)}><PlanningPage onGoal={onGoal}/></WorkspaceContext>);
  const queue = screen.getByRole('region', { name: 'Требуется решение директора' });
  expect(within(queue).getByText('Назначить владельца доступа')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('ИТ-лидер'), { target: { value: 'l1' } });
  const list = screen.getByRole('region', { name: 'Список планов' });
  expect(within(list).getByText('Проверить команды')).toBeTruthy();
  expect(within(list).queryByText('Общий шаг ДИТ')).toBeNull();
  expect(within(list).queryByText('Качество данных')).toBeNull();
  fireEvent.click(within(list).getByRole('button', { name: 'Базовые практики модели зрелости' }));
  expect(onGoal).toHaveBeenCalledWith('g1', 'l1');
  fireEvent.change(screen.getByLabelText('Состояние работ'), { target: { value: 'blocked' } });
  expect(within(list).getByText('По выбранным условиям планов нет')).toBeTruthy();
});
