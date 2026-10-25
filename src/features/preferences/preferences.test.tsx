// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import type { CatalogSnapshot } from '../../domain/contracts';
import { categories, type OverviewModel } from '../overview/overview-model';
import { MatrixPage } from '../overview/MatrixPage';
import { GoalLeaderMatrix } from '../overview/GoalLeaderMatrix';
import { preferenceStorageKey, readLocalPreference, writeLocalPreference, resetLocalPreferences, useLocalPreference } from './useLocalPreference';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
function model(goalCount = 1000, leaderCount = 40): OverviewModel {
  const leaders = Array.from({ length: leaderCount }, (_, i) => ({ id: `l${i + 1}`, name: `Лидер ${i + 1}`, teams: [] }));
  const goals = Array.from({ length: goalCount }, (_, i) => {
    const goal = { id: `g${i + 1}`, title: `Цель ${String(i + 1).padStart(4, '0')}`, category: 'process' as const, target: '', metric: '', status: '', summary: '', actions: [], scopeType: 'team', links: [], ownerId: null, curatorId: null, officialTarget: null, internalTarget: null, unit: '%', direction: 'increase' as const, baseline: null, weight: null, priority: null, dueDate: null, revision: 'r' };
    const leader = leaders[i % leaderCount], assignment = { id: `a${i}`, goalId: goal.id, leaderId: leader.id, teams: [], active: true };
    return { goal, cells: [{ goal, leader, assignment, status: 'unknown' as const, stale: false }] };
  });
  return { goals, leaders, cells: goals.flatMap(g => g.cells), groups: [{ category: 'process', ...categories.process, rows: goals }], totals: { goals: goalCount, assignments: goalCount, confirmed: 0, pending: 0, not_met: 0, unknown: goalCount } };
}
it('persists only approved preference keys and validates corrupt stored values without storing arbitrary payloads', () => {
  expect(writeLocalPreference('reader', 'matrix.search', 'Цель')).toBe(true);
  expect(readLocalPreference('reader', 'matrix.search', '')).toBe('Цель');
  expect(writeLocalPreference('reader', 'token' as never, 'secret' as never)).toBe(false);
  expect(writeLocalPreference('reader', 'matrix.density', 'other' as never)).toBe(false);
  localStorage.setItem(preferenceStorageKey('reader', 'matrix.status')!, JSON.stringify({ observations: [100] }));
  expect(readLocalPreference('reader', 'matrix.status', 'all')).toBe('all');
  expect([...Array(localStorage.length)].map((_, i) => localStorage.key(i)).some(k => k?.includes('token'))).toBe(false);
  writeLocalPreference('curator:a', 'matrix.density', 'compact'); localStorage.setItem('unrelated', 'retained');
  expect(resetLocalPreferences('reader')).toBe(true); expect(readLocalPreference('reader', 'matrix.search', '')).toBe('');
  expect(readLocalPreference('curator:a', 'matrix.density', 'comfortable')).toBe('compact'); expect(localStorage.getItem('unrelated')).toBe('retained');
});
it('isolates profiles and keeps UI usable when local storage refuses a write', () => {
  function Probe({ profile }: { profile: string }) { const [value, setValue, failed] = useLocalPreference(profile, 'matrix.density', 'comfortable'); return <><span>{value}</span><button onClick={() => setValue('compact')}>Изменить</button>{failed && <p>Не сохранено в браузере</p>}</>; }
  const view = render(<Probe profile="curator:a"/>); fireEvent.click(screen.getByRole('button', { name: 'Изменить' })); expect(screen.getByText('compact')).toBeTruthy();
  view.rerender(<Probe profile="curator:b"/>); expect(screen.getByText('comfortable')).toBeTruthy();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota'); });
  fireEvent.click(screen.getByRole('button', { name: 'Изменить' })); expect(screen.getByText('compact')).toBeTruthy(); expect(screen.getByText('Не сохранено в браузере')).toBeTruthy();
  expect(readLocalPreference('curator:a', 'matrix.density', 'comfortable')).toBe('compact');
  expect(readLocalPreference('curator:b', 'matrix.density', 'comfortable')).toBe('comfortable');
});
it('restores personal matrix filters and hidden columns without hiding their goal rows', () => {
  const fixture = model(8, 8), catalog = { schemaVersion: 1, id: 'c', name: 'Пример', classification: 'demo', importedAt: '', goals: fixture.goals.map(g => g.goal), leaders: fixture.leaders, assignments: fixture.cells.map(c => c.assignment), sources: [], comments: [], entities: [] } satisfies CatalogSnapshot;
  const current = { catalog, evaluations: [], snapshots: [], session: { role: 'curator', curatorId: 'personal-curator' } } as unknown as ClientState;
  const onGoal = vi.fn(), ctx = { state: current, mutate: vi.fn(async () => ({})), refresh: vi.fn(async () => {}), notify: vi.fn() };
  const app = () => <WorkspaceContext value={ctx}><MatrixPage onGoal={onGoal} onLeader={vi.fn()}/></WorkspaceContext>;
  const first = render(app()); fireEvent.change(screen.getByLabelText('Поиск целей и ИТ-лидеров'), { target: { value: 'Цель 0001' } });
  fireEvent.change(screen.getByLabelText('Категория исходной карты'), { target: { value: 'process' } }); fireEvent.change(screen.getByLabelText('Статус цели'), { target: { value: 'unknown' } });
  fireEvent.click(screen.getByRole('button', { name: 'Внутренние цели' })); fireEvent.click(screen.getByRole('button', { name: 'Плотность матрицы' }));
  fireEvent.click(screen.getByText(/Настроить столбцы ИТ-лидеров/)); fireEvent.click(screen.getByLabelText('Столбец: Лидер 1'));
  first.unmount(); render(app());
  expect((screen.getByLabelText('Поиск целей и ИТ-лидеров') as HTMLInputElement).value).toBe('Цель 0001'); expect((screen.getByLabelText('Категория исходной карты') as HTMLSelectElement).value).toBe('process'); expect((screen.getByLabelText('Статус цели') as HTMLSelectElement).value).toBe('unknown');
  expect(screen.getByRole('button', { name: 'Внутренние цели' }).getAttribute('aria-pressed')).toBe('true'); expect(screen.getByRole('button', { name: 'Плотность матрицы' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('button', { name: /Лидер 1.*назначений/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Цель 0001/ })); expect(onGoal).toHaveBeenCalledWith('g1');
});
it('renders at most 50 of 1000 goal rows and 16 leader columns with explicit independent paging', () => {
  const onGoal = vi.fn(); render(<GoalLeaderMatrix model={model()} density="compact" onGoal={onGoal} onLeader={vi.fn()}/>);
  const table = screen.getByRole('table', { name: 'Матрица целей и ИТ-лидеров' });
  expect(table.querySelectorAll('tbody .matrix-goal')).toHaveLength(50); expect(within(table).getAllByRole('columnheader')).toHaveLength(17);
  expect(screen.getByText('Цели 1–50 из 1000')).toBeTruthy(); expect(screen.queryByText('Цель 0051')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Следующие цели' })); expect(screen.getByText('Цели 51–100 из 1000')).toBeTruthy(); expect(screen.getByText('Цель 0051')).toBeTruthy(); expect(screen.queryByText('Цель 0001')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Следующие ИТ-лидеры' })); expect(screen.getByText('Столбцы ИТ-лидеров 17–32 из 40')).toBeTruthy(); expect(within(table).getAllByRole('columnheader')).toHaveLength(17);
  fireEvent.click(screen.getByRole('button', { name: /Цель 0051/ })); expect(onGoal).toHaveBeenCalledWith('g51');
});
it('shows all eight leaders by default and keeps scope totals and goals when a column is hidden', () => {
  const fixture = model(8, 8), onGoal = vi.fn(); const view = render(<GoalLeaderMatrix model={fixture} density="comfortable" onGoal={onGoal} onLeader={vi.fn()}/>);
  const table = screen.getByRole('table', { name: 'Матрица целей и ИТ-лидеров' }); expect(within(table).getAllByRole('columnheader')).toHaveLength(9);
  view.rerender(<GoalLeaderMatrix model={fixture} density="comfortable" hiddenLeaderIds={['l1']} onGoal={onGoal} onLeader={vi.fn()}/>);
  expect(within(table).getAllByRole('columnheader')).toHaveLength(8); expect(screen.getByText('Цели 1–8 из 8')).toBeTruthy(); expect(screen.getByText(/Назначений в фильтре: 8/)).toBeTruthy();
  expect(table.querySelectorAll('tbody .matrix-goal')).toHaveLength(8);
});
