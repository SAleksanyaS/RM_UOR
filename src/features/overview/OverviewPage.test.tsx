// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { OverviewPage } from './OverviewPage';

afterEach(cleanup);
it('keeps the executive landing to one summary, one indicator chart and three actions', () => {
  const leaders = Array.from({ length: 5 }, (_, index) => ({ id: `leader-${index}`, name: `Руководитель ${index + 1}`, teams: [] }));
  const goal = { id: 'goal', title: 'Базовые практики модели зрелости', category: 'process', summary: '', unit: '%', officialTarget: 80 };
  const state = { catalog: { goals: [goal], leaders, assignments: leaders.map(leader => ({ id: leader.id, goalId: goal.id, leaderId: leader.id, teams: [] })), sources: [], comments: [], entities: [] }, snapshots: [], evaluations: leaders.map(leader => ({ goalId: goal.id, leaderId: leader.id, actual: 100, officialTarget: 80, official: 'met', internal: 'unknown', validation: 'pending', period: '2026-10-02', qualityFlags: ['stale'] })) } as unknown as ClientState;
  render(<WorkspaceContext value={{ state, mutate: vi.fn(async () => ({})), refresh: vi.fn(async () => {}), notify: vi.fn() }}><OverviewPage onLeader={vi.fn()} onGoal={vi.fn()} onMatrix={vi.fn()} onSources={vi.fn()}/></WorkspaceContext>);
  expect(screen.getByRole('region', { name: 'Краткая сводка повестки' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Результат по ИТ-лидерам' })).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Ближайшие действия' })).getAllByRole('listitem')).toHaveLength(3);
  expect(screen.queryByText('Статус назначений')).toBeNull();
  expect(screen.queryByText('Полнота управленческой картины')).toBeNull();
  expect(screen.queryByText('Направления')).toBeNull();
});
