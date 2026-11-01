// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createWorkbenchApiHarness } from '../../../app/workbench/testing/api-harness';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import { WorkbenchClient } from '../../../app/workbench/api-client';
import { WorkbenchProvider, useGlobalContext, useWorkbench, useWorkbenchQuery } from '../../../app/workbench/context';
import { WorkbenchShell } from '../../../app/workbench/WorkbenchShell';
import type { PreferencesRead } from '../../system/workbench-preferences-query';
import type { AgreedSnapshot, CalculationResult, CoreGoalDefinition, EvaluationBasis, MethodVersion } from '../../../domain/workbench/entities';
import { fixtureId, makeHeader, versionRef } from '../../../../tests/fixtures/workbench/factories';
import { validateAgreedSnapshot } from '../../evaluation/workbench/state-rules';
import { goalRequest } from './goal-view-utils';
import { WorkbenchOverviewPage } from './OverviewPage';
import { WorkbenchGoalsPage } from './GoalsPage';
import { WorkbenchGoalDetailPage } from './GoalDetailPage';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); window.history.replaceState(null, '', '/'); });
function Refresh() { const { refreshSession } = useWorkbench(); return <button onClick={() => { void refreshSession(); }}>Обновить контекст</button>; }
function Jump({ goalId }: { goalId: string }) { const { navigate } = useGlobalContext(); const { loading } = useWorkbench(); return <button disabled={loading} onClick={() => navigate('/goals/' + goalId)}>Прямой переход по карточке</button>; }
function Destination() {
  const { context } = useGlobalContext();
  const query = useWorkbenchQuery('execution.list', context ? goalRequest(context) : null);
  return <><output>Цель перехода: {context?.goalId ?? 'не выбрана'}</output>{query.data !== null && <p>Переход прочитан сервером</p>}</>;
}
const views = { overview: WorkbenchOverviewPage, goals: WorkbenchGoalsPage, goalDetail: WorkbenchGoalDetailPage, data: Destination, execution: Destination };
type ApiHarness = Awaited<ReturnType<typeof createWorkbenchApiHarness>>;
function mount(h: ApiHarness, client = h.client) { window.history.replaceState(null, '', '/goals/' + h.refs.goal.id); return render(<WorkbenchProvider client={client}><Refresh /><WorkbenchShell views={views} /></WorkbenchProvider>); }
function makeMissing(h: ApiHarness) { const goal = h.repository.readVersion<CoreGoalDefinition>(h.refs.goal)!; h.repository.append('core_goal_definition', { ...goal, revision: 2, description: 'Основа изменена' }, 1); }
function unrelatedWrite(h: ApiHarness) { h.repository.append('directory_entity', { ...makeHeader(950, { publicationAnchorId: fixtureId(2) }), kind: 'person', name: 'Другой человек', externalKeys: [] }, null); }

it('review1_pending_second_assignment_keeps_one_command_id_after_first_commit_and_refresh', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close); makeMissing(h);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), blocked = new Promise<void>(resolve => { started = resolve; });
  const ids: string[] = [];
  const client = new WorkbenchClient({ fetch: async (input, init) => {
    if (String(input).endsWith('/commands')) { const body = JSON.parse(String(init?.body)); if (body.name === 'calculation.prepare' && body.payload.assignmentRef.id === h.refs.clusterAssignment.id) { ids.push(body.commandId); started(); await gate; } }
    return h.fetch(input, init);
  } });
  mount(h, client); await blocked;
  fireEvent.click(screen.getByRole('button', { name: 'Обновить контекст' }));
  await waitFor(() => expect(h.requests.filter(r => r.url.endsWith('/queries/goals.detail')).length).toBeGreaterThanOrEqual(2));
  await act(async () => { release(); await gate; }); await screen.findByText('88%');
  expect(ids).toHaveLength(1); expect(new Set(ids).size).toBe(1);
});
it('review1_unknown_prepare_is_not_reissued_after_an_unrelated_write', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'stale-fallback' }); closes.push(h.close); makeMissing(h);
  const ids: string[] = [];
  const client = new WorkbenchClient({ fetch: async (input, init) => {
    if (String(input).endsWith('/commands')) { const body = JSON.parse(String(init?.body)); if (body.name === 'calculation.prepare') { ids.push(body.commandId); throw Error('Unknown dispatch outcome'); } }
    return h.fetch(input, init);
  } });
  mount(h, client); await screen.findByRole('alert'); unrelatedWrite(h);
  fireEvent.click(screen.getByRole('button', { name: 'Обновить контекст' }));
  await waitFor(() => expect(h.requests.filter(r => r.url.endsWith('/queries/goals.detail')).length).toBeGreaterThanOrEqual(2));
  await screen.findByRole('alert'); expect(ids).toHaveLength(1);
  expect(screen.getByRole('alert').textContent).toContain('запись могла сохраниться');
});
it.each([null, fixtureId(800)])('review2_direct_goal_path_is_real_global_goal_with_saved_%s', async saved => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }, { views }); closes.push(h.close);
  if (saved) {
    const goal = h.repository.readVersion<CoreGoalDefinition>(h.refs.goal)!;
    h.repository.transaction(() => { h.repository.append('core_goal_definition', { ...goal, id: saved, title: 'Цель A', mode: 'manual_status', sourceId: fixtureId(801) }, null); h.repository.append('source_definition', { ...makeHeader(801, { publicationAnchorId: goal.publicationAnchorId }), goalId: saved, kind: 'manual_status', mappingRef: null, publicLocator: null }, null); });
    const session = await h.client.session();
    const preferences = await h.client.query<PreferencesRead>('preferences.get', { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } });
    await h.client.command({ commandId: crypto.randomUUID(), name: 'preferences.set', baseRevision: preferences.data.editToken, payload: { values: { ...preferences.data.values, context: { ...session.data.defaultContext!, goalId: saved } } } });
  }
  await h.open('/goals/' + h.refs.goal.id + '?at=2026-10-28'); await screen.findByText('92%');
  expect(new URLSearchParams(window.location.search).get('goal')).toBe(h.refs.goal.id);
  const link = screen.getAllByRole('link', { name: 'Открыть источник и данные' })[0];
  fireEvent.click(link); expect(await screen.findByText('Цель перехода: ' + h.refs.goal.id)).toBeTruthy();
  await screen.findByText('Переход прочитан сервером');
  const read = h.requests.filter(r => r.url.endsWith('/queries/execution.list')).at(-1)!;
  expect(read.body?.context).toMatchObject({ goalId: h.refs.goal.id, time: { kind: 'as_of', date: '2026-10-28' }, scopePath: { ditId: fixtureId(100) } });
});
it('review2_in_session_goal_navigation_preserves_explicit_scope_time_mode_and_snapshot', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'agreed-history' }); closes.push(h.close);
  const goal = h.repository.readVersion<CoreGoalDefinition>(h.refs.goal)!;
  h.repository.transaction(() => { h.repository.append('core_goal_definition', { ...goal, id: fixtureId(800), title: 'Цель A', mode: 'manual_status', sourceId: fixtureId(801) }, null); h.repository.append('source_definition', { ...makeHeader(801, { publicationAnchorId: goal.publicationAnchorId }), goalId: fixtureId(800), kind: 'manual_status', mappingRef: null, publicLocator: null }, null); });
  window.history.replaceState(null, '', `/overview?dit=${fixtureId(100)}&goal=${fixtureId(800)}&mode=agreed&snapshot=${h.refs.snapshot.id}&at=2026-10-28`);
  render(<WorkbenchProvider client={h.client}><Jump goalId={h.refs.goal.id} /><WorkbenchShell views={views} /></WorkbenchProvider>);
  const jump = screen.getByRole('button', { name: 'Прямой переход по карточке' }) as HTMLButtonElement;
  await waitFor(() => expect(jump.disabled).toBe(false)); fireEvent.click(jump);
  await screen.findByRole('heading', { name: 'Тестовая цель' });
  const params = new URLSearchParams(window.location.search);
  expect(params.get('goal')).toBe(h.refs.goal.id); expect(params.get('dit')).toBe(fixtureId(100)); expect(params.get('at')).toBe('2026-10-28'); expect(params.get('mode')).toBe('agreed'); expect(params.get('snapshot')).toBe(h.refs.snapshot.id);
  fireEvent.click(screen.getByRole('tab', { name: 'Работы и решения' })); fireEvent.click(screen.getByRole('link', { name: 'Все работы и решения' }));
  await screen.findByText('Цель перехода: ' + h.refs.goal.id); await screen.findByText('Переход прочитан сервером');
  expect(h.requests.filter(r => r.url.endsWith('/queries/execution.list')).at(-1)?.body?.context).toMatchObject({ goalId: h.refs.goal.id, resultMode: 'agreed', snapshotId: h.refs.snapshot.id });
});
function addSnapshots(h: ApiHarness, count: number) {
  const original = h.repository.readVersion<AgreedSnapshot>(h.refs.snapshot)!;
  const values: AgreedSnapshot[] = [];
  h.repository.transaction(() => { for (let i = 0; i < count; i++) { const snapshot = { ...original, id: fixtureId(1000 + i), recordedAt: new Date(Date.UTC(2026, 9, 28, 10, 0, i)).toISOString() }; h.repository.append('agreed_snapshot', snapshot, null); values.push(snapshot); } });
  return values;
}
it('review3_snapshot_picker_loads_real_cursor_pages_and_resets_after_scope_change', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'agreed-history' }, { views }); closes.push(h.close);
  const snapshots = addSnapshots(h, 65), last = snapshots.at(-1)!;
  await h.open('/goals/' + h.refs.goal.id + '?mode=agreed');
  fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё срезы' }));
  await screen.findByRole('option', { name: new RegExp(last.recordedAt.replaceAll('.', '\\.')) });
  const picker = screen.getByRole('combobox', { name: 'Согласованный срез' }); fireEvent.change(picker, { target: { value: last.id } });
  expect(await screen.findByRole('heading', { name: 'Тестовая цель' })).toBeTruthy(); expect((picker as HTMLSelectElement).value).toBe(last.id);
  expect(h.requests.some(r => r.url.endsWith('/queries/snapshots.list') && (r.body?.page as { cursor: unknown }).cursor !== null)).toBe(true);
  await h.open('/goals/' + h.refs.goal.id + '?mode=agreed&cluster=' + fixtureId(103));
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Согласованный срез' }) as HTMLSelectElement).options.length).toBe(1));
});
it('review3_direct_snapshot_outside_first_page_keeps_its_real_label_visible', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'agreed-history' }, { views }); closes.push(h.close);
  const last = addSnapshots(h, 65).at(-1)!;
  await h.open(`/goals/${h.refs.goal.id}?mode=agreed&snapshot=${last.id}`);
  await screen.findByRole('heading', { name: 'Тестовая цель' });
  const picker = screen.getByRole('combobox', { name: 'Согласованный срез' }) as HTMLSelectElement;
  expect(picker.value).toBe(last.id); expect(picker.selectedOptions[0].textContent).toContain(last.recordedAt);
});
it('review4_history_metric_change_uses_exact_ref_and_resets_real_pagination', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'population-gap' }, { views }); closes.push(h.close);
  const goal = h.repository.readVersion<CoreGoalDefinition>(h.refs.goal)!;
  h.repository.append('core_goal_definition', { ...goal, revision: 2, measurementMode: 'period' }, 1);
  await h.open(`/goals/${h.refs.goal.id}?from=2024-01-01&to=2026-11-01`); await screen.findByRole('heading', { name: 'Тестовая цель' });
  fireEvent.click(screen.getByRole('tab', { name: 'История' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Следующая страница истории' }));
  await waitFor(() => expect(h.requests.some(r => r.url.endsWith('/queries/history.series') && (r.body?.page as { cursor: unknown }).cursor !== null)).toBe(true));
  fireEvent.change(screen.getByRole('combobox', { name: 'Показатель истории' }), { target: { value: fixtureId(202) + '/1' } });
  await waitFor(() => expect(h.requests.filter(r => r.url.endsWith('/queries/history.series')).at(-1)?.body?.filter).toMatchObject({ metricRef: versionRef('metric_definition', 202) }));
  expect(h.requests.filter(r => r.url.endsWith('/queries/history.series')).at(-1)?.body?.page).toMatchObject({ cursor: null });
});
function freezeTwoMetricResult(h: ApiHarness) {
  const sourceBasis = h.repository.readVersion<EvaluationBasis>(h.refs.basis)!, sourceResult = h.repository.readVersion<CalculationResult>(h.refs.result)!;
  const basis = { ...sourceBasis, id: fixtureId(1300), publicationAnchorId: fixtureId(2) }, basisRef = versionRef('evaluation_basis', 1300);
  const result = { ...sourceResult, id: fixtureId(1301), basisRef, publicationAnchorId: fixtureId(2) };
  const { schemaVersion, id, revision, actor, recordedAt, publicationAnchorId, ...numericResult } = result;
  const snapshot = { ...makeHeader(1302, { publicationAnchorId: fixtureId(2) }), basisRef, numericResult, manualStatusRef: null, attestationRef: null };
  validateAgreedSnapshot({ basis, result, snapshot, manualStatus: null, attestation: null });
  h.repository.transaction(() => { h.repository.append('evaluation_basis', basis, null); h.repository.append('calculation_result', result, null); h.repository.append('agreed_snapshot', snapshot, null); });
  return snapshot;
}
it('review4_agreed_metric_picker_uses_frozen_method_refs_after_current_method_changes', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'population-gap' }, { views }); closes.push(h.close);
  const snapshot = freezeTwoMetricResult(h), method = h.repository.readVersion<MethodVersion>(h.refs.method)!;
  if (method.mode !== 'numeric') throw Error('Numeric fixture required');
  h.repository.append('method_version', { ...method, revision: 2, rules: [method.rules[0]] }, 1);
  await h.open(`/goals/${h.refs.goal.id}?mode=agreed&snapshot=${snapshot.id}`); await screen.findByRole('heading', { name: 'Тестовая цель' });
  fireEvent.click(screen.getByRole('tab', { name: 'История' }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Показатель истории' }), { target: { value: fixtureId(202) + '/1' } });
  await waitFor(() => expect(h.requests.filter(r => r.url.endsWith('/queries/history.series')).at(-1)?.body?.filter).toMatchObject({ metricRef: versionRef('metric_definition', 202) }));
  expect(h.requests.some(r => r.body?.name === 'calculation.prepare')).toBe(false);
});
it('review5_list_and_persistent_header_keep_independent_facts_requirements_and_states', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }, { views }); closes.push(h.close); await h.open('/goals');
  expect(await screen.findByText('92%')).toBeTruthy(); expect(await screen.findByText('88%')).toBeTruthy();
  expect(screen.getByText('Порог: ≥ 90%')).toBeTruthy(); expect(screen.getByText('Порог: ≥ 95%')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Открыть цель: Тестовая цель' })[0]); await screen.findByRole('heading', { name: 'Тестовая цель' });
  fireEvent.click(screen.getByRole('tab', { name: 'История' }));
  const summary = screen.getByRole('region', { name: 'Сводка состояния цели' });
  expect(await within(summary).findByText('92%')).toBeTruthy(); expect(await within(summary).findByText('88%')).toBeTruthy();
  expect(within(summary).getByText('Порог: ≥ 90%')).toBeTruthy(); expect(within(summary).getByText('Условие не выполнено')).toBeTruthy();
});
it('review5_manual_summary_remains_visible_across_tabs_without_numeric_zero', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'manual-goal' }, { views }); closes.push(h.close);
  await h.open('/goals/' + h.refs.goal.id); await screen.findByText('Ручной статус не задан'); fireEvent.click(screen.getByRole('tab', { name: 'Методика' }));
  expect(within(screen.getByRole('region', { name: 'Сводка состояния цели' })).getByText('Ручной статус не задан')).toBeTruthy(); expect(screen.queryByText('0%')).toBeNull();
});
it('review6_actual_read_failure_does_not_claim_a_possible_write', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  const client = new WorkbenchClient({ fetch: async (input, init) => { const response = await h.fetch(input, init); if (String(input).endsWith('/queries/goals.detail')) throw Error('Synthetic read connection lost'); return response; } });
  mount(h, client); const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Не удалось загрузить данные'); expect(alert.textContent).not.toContain('запись могла сохраниться');
  expect(h.requests.some(r => r.url.endsWith('/queries/goals.detail'))).toBe(true); expect(h.requests.some(r => r.body?.name === 'calculation.prepare')).toBe(false);
});
