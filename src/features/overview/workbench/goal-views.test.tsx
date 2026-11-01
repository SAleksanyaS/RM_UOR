// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import { WorkbenchOverviewPage } from './OverviewPage';
import { WorkbenchGoalsPage } from './GoalsPage';
import { WorkbenchGoalDetailPage } from './GoalDetailPage';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
import type { CoreGoalDefinition, ObservedFact } from '../../../domain/workbench/entities';
import { createWorkbenchApiHarness } from '../../../app/workbench/testing/api-harness';
import { WorkbenchClient } from '../../../app/workbench/api-client';
import { WorkbenchProvider } from '../../../app/workbench/context';
import { useWorkbench } from '../../../app/workbench/context';
import { WorkbenchShell } from '../../../app/workbench/WorkbenchShell';
import { StrictMode } from 'react';

const closes: Array<() => Promise<void>> = [];
const views = { overview: WorkbenchOverviewPage, goals: WorkbenchGoalsPage, goalDetail: WorkbenchGoalDetailPage };
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); window.history.replaceState(null, '', '/'); });
async function harness(scenario: Parameters<typeof createWorkbenchUiHarness>[0]['scenario']) {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario }, { views }); closes.push(h.close); return h;
}
it('shows_independent_scopes_and_no_false_confirmation', async () => {
  const h = await harness('scope-split');
  await h.open('/goals/' + h.refs.goal.id);
  expect(await screen.findByText('92%')).toBeTruthy();
  expect(await screen.findByText('88%')).toBeTruthy();
  const dit = screen.getByRole('region', { name: 'ДИТ' });
  const cluster = screen.getByRole('region', { name: 'Кластер А' });
  expect(within(dit).getByText(/Порог: ≥ 90%/)).toBeTruthy();
  expect(within(cluster).getByText(/Порог: ≥ 95%/)).toBeTruthy();
  expect(within(dit).getByText('Условие выполнено')).toBeTruthy();
  expect(within(cluster).getByText('Условие не выполнено')).toBeTruthy();
  expect(screen.queryByText('Подтверждено УОР')).toBeNull();
  expect(screen.getAllByText('Подтверждение УОР отсутствует')).toHaveLength(2);
  expect(screen.getAllByText('Время публикации не подтверждено')).toHaveLength(2);
  const sourceLink = new URL((within(dit).getByRole('link', { name: 'Открыть источник и данные' }) as HTMLAnchorElement).href);
  expect(sourceLink.searchParams.get('result')).toBe(h.refs.result.id);
  expect(sourceLink.searchParams.get('resultRevision')).toBe('1');
  expect(sourceLink.searchParams.get('dit')).toBe(fixtureId(100));
  expect(h.requests.filter(r => r.url.includes('/commands')).map(r => r.body?.name)).not.toContain('result.confirm');
});
it('shows_missing_population_without_turning_it_into_zero', async () => {
  const h = await harness('population-gap'); await h.open('/goals/' + h.refs.goal.id);
  expect(await screen.findByText('Продукт B', { selector: 'li' })).toBeTruthy();
  expect(screen.getByText('Предварительный результат')).toBeTruthy();
  expect(screen.getByText('Данные неполны')).toBeTruthy();
  expect(screen.queryByText('0%')).toBeNull(); expect(screen.queryByText('Подтверждено УОР')).toBeNull();
});
it('manual_goal_has_no_numeric_zero', async () => {
  const h = await harness('manual-goal'); await h.open('/goals/' + h.refs.goal.id);
  expect(await screen.findByText('Ручной статус не задан')).toBeTruthy();
  expect(screen.queryByText('0%')).toBeNull(); expect(screen.queryByText('Итоговый балл')).toBeNull();
});
it('shows_cache_date_and_carried_warning', async () => {
  const h = await harness('stale-fallback'); await h.open('/goals/' + h.refs.goal.id);
  expect(await screen.findByText('Данные устарели')).toBeTruthy();
  expect(await screen.findByText(/Дата источника: 2026-10-23T09:00:00Z/)).toBeTruthy();
  expect(screen.getByText('Доставка: Локальный кэш')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'История' }));
  expect(await screen.findByText('Данные не обновлялись')).toBeTruthy();
  expect(screen.getByText(/Исходное измерение: 2026-10-23/)).toBeTruthy();
  const history = h.requests.find(r => r.url.includes('/queries/history.series'));
  expect(history?.body?.filter).toMatchObject({ granularity: 'friday' });
});
it('reads_agreed_without_current_recalculation', async () => {
  const h = await harness('agreed-history');
  const path = '/goals/' + h.refs.goal.id + '?mode=agreed&snapshot=' + h.refs.snapshot.id + '&at=2026-10-28';
  await h.open(path);
  expect(await screen.findByRole('heading', { name: 'Тестовая цель' })).toBeTruthy();
  expect(await screen.findByText('92%')).toBeTruthy();
  expect(screen.queryByText('Сегодняшняя цель')).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'История' }));
  await waitFor(() => expect(h.requests.some(r => r.url.includes('/queries/history.series'))).toBe(true));
  const reads = h.requests.filter(r => /queries\/(goals.detail|history.series|data.lineage)/.test(r.url));
  for (const read of reads) expect(read.body?.context).toMatchObject({ resultMode: 'agreed', snapshotId: h.refs.snapshot.id, scopePath: { ditId: fixtureId(100) } });
  expect(h.requests.filter(r => r.url.includes('/commands')).map(r => r.body?.name)).not.toContain('calculation.prepare');
});
it('drills_from_overview_to_goal_and_switches_to_an_explicit_snapshot_preserving_scope', async () => {
  const h = await harness('agreed-history'); await h.open('/overview');
  fireEvent.click(await screen.findByRole('button', { name: /Открыть цель: Сегодняшняя цель/ }));
  await screen.findByRole('heading', { name: 'Сегодняшняя цель' });
  const scope = new URLSearchParams(window.location.search).get('dit');
  fireEvent.click(screen.getByRole('button', { name: 'Согласованный результат' }));
  const picker = await screen.findByRole('combobox', { name: 'Согласованный срез' });
  expect((picker as HTMLSelectElement).value).toBe('');
  await screen.findByRole('option', { name: /2026-10-23T10:00:00Z/ });
  fireEvent.change(picker, { target: { value: h.refs.snapshot.id } });
  expect(await screen.findByRole('heading', { name: 'Тестовая цель' })).toBeTruthy();
  expect(new URLSearchParams(window.location.search).get('snapshot')).toBe(h.refs.snapshot.id);
  expect(new URLSearchParams(window.location.search).get('dit')).toBe(scope);
  fireEvent.click(screen.getByRole('button', { name: 'Текущий результат' }));
  expect(await screen.findByRole('heading', { name: 'Сегодняшняя цель' })).toBeTruthy();
  expect(new URLSearchParams(window.location.search).has('snapshot')).toBe(false);
});
it('lists_real_goal_rows_and_keeps_source_and_work_drilldowns_in_context', async () => {
  const h = await harness('scope-split'); await h.open('/goals');
  fireEvent.click((await screen.findAllByRole('button', { name: /Открыть цель: Тестовая цель/ }))[0]);
  await screen.findByRole('heading', { name: 'Тестовая цель' });
  fireEvent.click(screen.getByRole('tab', { name: 'Исходные строки' }));
  expect(await screen.findByText('demo_0_0')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Работы и решения' }));
  expect(screen.getByText('Связанных работ и решений нет')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Расчёт' }));
  expect(await screen.findAllByText(/Редакция методики: 1/)).toHaveLength(2);
  expect(h.requests.some(r => r.url.includes('/queries/data.lineage'))).toBe(true);
});
it('prepares_missing_current_results_via_server_without_creating_confirmation', async () => {
  const h = await harness('scope-split');
  const goal = h.repository.readVersion<CoreGoalDefinition>(h.refs.goal)!;
  h.repository.append('core_goal_definition', { ...goal, revision: 2, description: 'Новое текущее основание' }, 1);
  await h.open('/goals/' + h.refs.goal.id);
  expect(await screen.findByText('92%')).toBeTruthy(); expect(await screen.findByText('88%')).toBeTruthy();
  const commands = h.requests.filter(r => r.url.endsWith('/commands')).map(r => r.body?.name);
  expect(commands.filter(name => name === 'calculation.prepare')).toHaveLength(2);
  expect(commands).not.toContain('result.confirm'); expect(commands).not.toContain('snapshot.save');
});
it('shows_query_errors_and_does_not_render_a_false_zero', async () => {
  const h = await harness('scope-split'); await h.open('/goals/' + fixtureId(999999));
  expect((await screen.findByRole('alert')).textContent).toContain('REFERENCE_NOT_FOUND');
  expect(screen.queryByText('0%')).toBeNull();
});
it('ignores_obsolete_goal_response_after_global_scope_changes', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  const client = new WorkbenchClient({ fetch: async (input, init) => {
    const response = await h.fetch(input, init);
    if (String(input).endsWith('/queries/goals.detail') && first) { first = false; started(); await gate; }
    return response;
  } });
  window.history.replaceState(null, '', '/goals/' + h.refs.goal.id);
  render(<WorkbenchProvider client={client}><WorkbenchShell views={views} /></WorkbenchProvider>);
  await dispatched;
  expect(screen.getByText('Загружаем данные…')).toBeTruthy();
  act(() => { window.history.pushState(null, '', window.location.pathname + '?cluster=' + fixtureId(103)); window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(await screen.findByText('88%')).toBeTruthy();
  await act(async () => { release(); await gate; });
  expect(screen.queryByText('92%')).toBeNull();
});
it('uses_explicit_global_scope_selection_for_independent_history', async () => {
  const h = await harness('scope-split'); await h.open('/goals/' + h.refs.goal.id);
  await screen.findByText('92%'); fireEvent.click(screen.getByRole('tab', { name: 'История' }));
  expect(screen.getByText(/У независимых назначений нет единого временного ряда/)).toBeTruthy();
  expect(h.requests.some(r => r.url.includes('/queries/history.series'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'История области: Кластер А' }));
  await waitFor(() => expect(h.requests.some(r => r.url.includes('/queries/history.series'))).toBe(true));
  expect(new URLSearchParams(window.location.search).get('cluster')).toBe(fixtureId(103));
  const read = h.requests.find(r => r.url.includes('/queries/history.series'))!;
  expect(read.body?.context).toMatchObject({ scopePath: { clusterId: fixtureId(103) } });
});
function RefreshSession() { const { refreshSession } = useWorkbench(); return <button type="button" onClick={() => { void refreshSession(); }}>Перечитать контекст</button>; }
it('strict_mode_and_same_context_refresh_prepare_each_missing_assignment_once', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  const goal = h.repository.readVersion<CoreGoalDefinition>(h.refs.goal)!;
  h.repository.append('core_goal_definition', { ...goal, revision: 2, description: 'Новая основа для StrictMode' }, 1);
  window.history.replaceState(null, '', '/goals/' + h.refs.goal.id);
  render(<StrictMode><WorkbenchProvider client={h.client}><RefreshSession /><WorkbenchShell views={views} /></WorkbenchProvider></StrictMode>);
  await screen.findByText('92%'); await screen.findByText('88%');
  const initialContext = window.location.search;
  fireEvent.click(screen.getByRole('button', { name: 'Перечитать контекст' }));
  await screen.findByText('92%'); await screen.findByText('88%');
  const preparations = h.requests.filter(r => r.body?.name === 'calculation.prepare');
  expect(preparations).toHaveLength(2);
  expect(new Set(preparations.map(r => r.body?.commandId)).size).toBe(2);
  expect(window.location.search).toBe(initialContext);
  expect(h.repository.sqlForModule('history').all('SELECT id FROM wb_history_observations')).toHaveLength(2);
  expect(screen.queryByText('Подтверждено УОР')).toBeNull();
});
it('lost_prepare_response_is_not_automatically_retried_with_a_new_command_id', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'stale-fallback' }); closes.push(h.close);
  const goal = h.repository.readVersion<CoreGoalDefinition>(h.refs.goal)!;
  h.repository.append('core_goal_definition', { ...goal, revision: 2, description: 'Новая текущая основа' }, 1);
  let loseResponse = true;
  const client = new WorkbenchClient({ fetch: async (input, init) => {
    const response = await h.fetch(input, init);
    if (String(input).endsWith('/commands') && JSON.parse(String(init?.body)).name === 'calculation.prepare' && loseResponse) { loseResponse = false; throw Error('Synthetic response lost after commit'); }
    return response;
  } });
  window.history.replaceState(null, '', '/goals/' + h.refs.goal.id);
  render(<WorkbenchProvider client={client}><RefreshSession /><WorkbenchShell views={views} /></WorkbenchProvider>);
  await screen.findByRole('alert');
  expect(h.requests.filter(r => r.body?.name === 'calculation.prepare')).toHaveLength(1);
  const context = window.location.search;
  fireEvent.click(screen.getByRole('button', { name: 'Перечитать контекст' }));
  expect(await screen.findByText('92%')).toBeTruthy();
  expect(h.requests.filter(r => r.body?.name === 'calculation.prepare')).toHaveLength(1);
  expect(window.location.search).toBe(context);
  expect(h.repository.sqlForModule('history').all('SELECT id FROM wb_history_observations')).toHaveLength(1);
  expect(h.requests.some(r => ['result.confirm', 'snapshot.save'].includes(String(r.body?.name)))).toBe(false);
});
it('new_fact_revision_in_the_same_context_gets_a_new_derived_result', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'stale-fallback' }); closes.push(h.close);
  const fact = h.repository.getHead<ObservedFact>({ entityType: 'observed_fact', id: fixtureId(10001) })!;
  h.repository.append('observed_fact', { ...fact, revision: 2 }, 1);
  window.history.replaceState(null, '', '/goals/' + h.refs.goal.id);
  render(<WorkbenchProvider client={h.client}><RefreshSession /><WorkbenchShell views={views} /></WorkbenchProvider>);
  await screen.findByText('92%');
  expect(h.requests.filter(r => r.body?.name === 'calculation.prepare')).toHaveLength(1);
  h.repository.append('observed_fact', { ...fact, revision: 3 }, 2);
  fireEvent.click(screen.getByRole('button', { name: 'Перечитать контекст' }));
  await waitFor(() => expect(h.requests.filter(r => r.body?.name === 'calculation.prepare')).toHaveLength(2));
  expect(await screen.findByText('92%')).toBeTruthy();
});
it('client_switch_cannot_prepare_from_the_old_owners_read_model', async () => {
  const a = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(a.close);
  const b = await createWorkbenchApiHarness({ role: 'curator', scenario: 'scope-split' }); closes.push(b.close);
  const goal = a.repository.readVersion<CoreGoalDefinition>(a.refs.goal)!;
  a.repository.append('core_goal_definition', { ...goal, revision: 2 }, 1);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), dispatched = new Promise<void>(resolve => { started = resolve; });
  const client = new WorkbenchClient({ fetch: async (input, init) => {
    const response = await a.fetch(input, init);
    if (String(input).endsWith('/commands') && JSON.parse(String(init?.body)).name === 'calculation.prepare') { started(); await gate; }
    return response;
  } });
  window.history.replaceState(null, '', '/goals/' + a.refs.goal.id);
  const view = render(<WorkbenchProvider client={client}><WorkbenchShell views={views} /></WorkbenchProvider>);
  await dispatched;
  const context = window.location.search;
  view.rerender(<WorkbenchProvider client={b.client}><WorkbenchShell views={views} /></WorkbenchProvider>);
  await screen.findByText('92%'); await screen.findByText('88%');
  await act(async () => { release(); await gate; });
  expect(a.requests.filter(r => r.body?.name === 'calculation.prepare')).toHaveLength(1);
  expect(b.requests.filter(r => r.body?.name === 'calculation.prepare')).toHaveLength(0);
  expect(window.location.search).toBe(context);
});
