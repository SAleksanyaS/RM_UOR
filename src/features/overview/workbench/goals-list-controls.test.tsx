// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import { WorkbenchGoalsPage } from './GoalsPage';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); window.history.replaceState(null, '', '/'); });
async function open() {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }, { views: { goals: WorkbenchGoalsPage } });
  closes.push(h.close); await h.open('/goals');
  await screen.findByText('Показано 2 из 2 назначений на странице');
  return h;
}
it('searches loaded assignments and never presents an unconfirmed calculation as attested', async () => {
  const h = await open();
  const reads = () => h.requests.filter(request => request.url.endsWith('/queries/goals.list'));
  const before = reads().length;
  fireEvent.change(screen.getByRole('searchbox', { name: 'Найти на странице' }), { target: { value: 'Кластер А' } });
  expect(screen.getByText('Показано 1 из 2 назначений на странице')).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Таблица целей' })).queryByText('ДИТ')).toBeNull();
  expect(reads()).toHaveLength(before);
  fireEvent.change(screen.getByRole('combobox', { name: 'Состояние на странице' }), { target: { value: 'confirmed' } });
  expect(screen.getByText('На этой странице нет совпадений')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Сбросить фильтры страницы' }));
  expect(screen.getByText('Показано 2 из 2 назначений на странице')).toBeTruthy();
  expect(h.requests.some(request => request.body?.name === 'result.confirm')).toBe(false);
});
it('sorts through the validated server contract while keeping the empty filter and context', async () => {
  const h = await open();
  fireEvent.change(screen.getByRole('combobox', { name: 'Сортировка всего списка' }), { target: { value: 'scope' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Порядок' }), { target: { value: 'desc' } });
  await waitFor(() => expect(h.requests.some(request => request.url.endsWith('/queries/goals.list') && JSON.stringify(request.body?.sort) === JSON.stringify([{ field: 'scope', direction: 'desc' }]))).toBe(true));
  const read = h.requests.filter(request => request.url.endsWith('/queries/goals.list')).at(-1)!;
  expect(read.body?.filter).toEqual({});
  expect(read.body?.page).toMatchObject({ cursor: null });
  expect(read.body?.context).toMatchObject({ resultMode: 'current' });
  await screen.findByText('Показано 2 из 2 назначений на странице');
});
