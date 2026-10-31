// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createWorkbenchUiHarness } from './testing/ui-harness';
import { WorkbenchShell } from './WorkbenchShell';
import { WorkbenchClient } from './api-client';
import { WorkbenchProvider, useWorkbench } from './context';
import { createWorkbenchApiHarness } from './testing/api-harness';
import { createNotificationStore } from '../../features/execution/workbench-notification-store';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
it('reader_sees_common_navigation_without_curator_mutation', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  await h.open('/overview');
  for (const name of ['Обзор', 'Цели', 'Работы и решения', 'Данные', 'Панель УОР']) expect(screen.getByRole('button', { name })).toBeTruthy();
  const panel = screen.getByRole('button', { name: 'Панель УОР' }) as HTMLButtonElement;
  expect(panel.disabled).toBe(true); expect(document.getElementById(panel.getAttribute('aria-describedby')!)?.textContent).toContain('куратор');
  expect(screen.queryByRole('button', { name: 'Отправить пакет в Bitbucket' })).toBeNull();
  expect(h.requests.some(r => JSON.stringify(r.body).includes('password'))).toBe(false);
  expect(screen.getByText(/Экран «Обзор» ещё не подключён/)).toBeTruthy();
  await h.open('/uor'); expect(screen.getByRole('alert').textContent).toContain('Недостаточно прав');
  expect(h.requests.some(r => r.url.includes('/queries/uor.'))).toBe(false);
});
it('returns_focus_and_preserves_context', async () => {
  function Overview() { return <label>Незавершённая заметка<input /></label>; }
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }, { views: { overview: Overview } }); closes.push(h.close);
  await h.open('/overview?cluster=' + fixtureId(103) + '&product=' + fixtureId(101) + '&from=2026-10-20&to=2026-10-29&mode=agreed');
  const original = window.location.search;
  const input = screen.getByRole('textbox', { name: 'Незавершённая заметка' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Сохранить текст' } });
  const opener = screen.getByRole('button', { name: 'Уведомления' }); opener.focus(); fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Уведомления' });
  expect(dialog.contains(document.activeElement)).toBe(true);
  const close = within(dialog).getByRole('button', { name: 'Закрыть уведомления' });
  close.focus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener); expect(input.value).toBe('Сохранить текст');
  fireEvent.click(screen.getByRole('button', { name: 'Данные' })); expect(window.location.search).toBe(original);
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Данные', level: 1 }));
  await h.open('/overview' + original); expect(window.location.search).toBe(original);
});
it('notification_identity_does_not_grant_role', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close); await h.open('/overview');
  fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
  const picker = await screen.findByLabelText('Человек для личных уведомлений');
  await screen.findByRole('option', { name: 'demo_curator' });
  fireEvent.change(picker, { target: { value: fixtureId(17) } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить получателя' }));
  await screen.findByText('Получатель сохранён. Права доступа не изменены.');
  expect(document.activeElement?.textContent).toBe('Получатель сохранён. Права доступа не изменены.');
  expect((await h.client.session()).data.role).toBe('viewer');
  expect((screen.getByRole('button', { name: 'Панель УОР' }) as HTMLButtonElement).disabled).toBe(true);
  const request = h.requests.filter(r => r.body?.name === 'preferences.set').at(-1)!;
  expect(request.body?.payload).toMatchObject({ values: { notificationPersonId: fixtureId(17), visual: { theme: 'system', density: 'comfortable' } } });
  expect(JSON.stringify(request.body)).not.toMatch(/"role"|"hostname"/);
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть уведомления' }));
  fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
  await screen.findByRole('option', { name: 'demo_curator' });
  await waitFor(() => expect((screen.getByLabelText('Человек для личных уведомлений') as HTMLSelectElement).value).toBe(fixtureId(17)));
});
it('marks_real_notifications_read_and_subscribes_to_a_published_goal', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  const owner = { installationId: fixtureId(1), profilePersonId: null };
  const store = createNotificationStore({ repository: h.repository });
  store.record(owner, 'shell-cause', { provider: 'fixture', objectRef: { entityType: 'core_goal_definition', id: h.refs.goal.id }, sourceVersion: 'v1', kind: 'error', recipientPersonIds: [], route: '/goals/' + h.refs.goal.id }, 'error', '2026-10-28T09:00:00Z');
  await h.open('/overview'); fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отметить прочитанным' }));
  await waitFor(() => expect(store.list(owner)[0].readAt).toBe('2026-10-28T09:00:00Z'));
  await waitFor(() => expect(document.activeElement?.textContent).toBe('Уведомление прочитано. Причина остаётся открытой.'));
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' }); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Закрыть уведомления' }));
  fireEvent.change(screen.getByLabelText('Цель для подписки'), { target: { value: h.refs.goal.id } });
  fireEvent.click(screen.getByRole('button', { name: 'Подписаться' }));
  await waitFor(() => expect(store.isSubscribed(owner, h.refs.goal.id)).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Отписаться' })); await waitFor(() => expect(store.isSubscribed(owner, h.refs.goal.id)).toBe(false));
  expect(h.requests.filter(r => r.body?.name === 'notifications.markRead')).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Только непрочитанные' }));
  await screen.findByRole('button', { name: 'Открыть причину' });
  fireEvent.click(screen.getByRole('button', { name: 'Открыть причину' })); expect(window.location.pathname).toBe('/goals/' + h.refs.goal.id); expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Цели', level: 1 }));
});
it.each(['curator', 'chief'] as const)('offers_the_same_panel_for_%s', async role => {
  const h = await createWorkbenchUiHarness({ role, scenario: 'scope-split' }, { views: { uor: () => <p>Общая панель подготовки</p> } }); closes.push(h.close);
  await h.open('/overview'); const panel = screen.getByRole('button', { name: 'Панель УОР' }) as HTMLButtonElement; expect(panel.disabled).toBe(false); fireEvent.click(panel);
  expect(screen.getByText('Общая панель подготовки')).toBeTruthy(); expect(screen.queryByText(/merge|пароль/i)).toBeNull();
});
it('uses_server_allowed_commands_even_when_a_role_label_is_stale', async () => {
  const h = await createWorkbenchApiHarness({ role: 'curator', scenario: 'scope-split' }); closes.push(h.close);
  const client = new WorkbenchClient({ fetch: async (input, init) => { const response = await h.fetch(input, init); if (!String(input).endsWith('/session')) return response; const body = await response.json(); body.data.allowedCommands = ['preferences.set']; return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); } });
  render(<WorkbenchProvider client={client}><WorkbenchShell /></WorkbenchProvider>);
  await screen.findByRole('button', { name: 'Данные' }); expect((screen.getByRole('button', { name: 'Панель УОР' }) as HTMLButtonElement).disabled).toBe(true);
});
it('announces_a_lost_mutation_response_without_retry_or_losing_the_selected_recipient', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  const client = new WorkbenchClient({ fetch: async (input, init) => { const response = await h.fetch(input, init); if (String(input).endsWith('/commands')) throw Error('Synthetic lost response'); return response; } });
  render(<WorkbenchProvider client={client}><WorkbenchShell /></WorkbenchProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Уведомления' }).then(async button => { await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); return button; }));
  await screen.findByRole('option', { name: 'demo_curator' }); const select = screen.getByLabelText('Человек для личных уведомлений') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: fixtureId(17) } }); fireEvent.click(screen.getByRole('button', { name: 'Сохранить получателя' }));
  const error = await screen.findByRole('alert'); expect(error.textContent).toContain('Результат операции неизвестен'); expect(error.textContent).toContain('Проверьте текущее состояние'); expect(error.textContent).not.toContain('повторите явно'); expect(select.value).toBe(fixtureId(17));
  expect(h.requests.filter(r => r.body?.name === 'preferences.set')).toHaveLength(1);
  const saved = await h.client.query<{ values: { notificationPersonId: string | null } }>('preferences.get', { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } }); expect(saved.data.values.notificationPersonId).toBe(fixtureId(17));
  expect((await h.client.session()).data.role).toBe('viewer');
});
it('isolates_an_open_dialog_on_authoritative_owner_change_and_ignores_late_old_actions', async () => {
  window.history.replaceState(null, '', '/overview');
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  createNotificationStore({ repository: h.repository }).record({ installationId: fixtureId(1), profilePersonId: null }, 'owner-cause', { provider: 'fixture', objectRef: { entityType: 'core_goal_definition', id: h.refs.goal.id }, sourceVersion: 'v1', kind: 'Событие прежнего владельца', recipientPersonIds: [], route: '/goals/' + h.refs.goal.id }, 'error', '2026-10-28T09:00:00Z');
  let personId: string | null = null, release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), dispatched = new Promise<void>(resolve => { started = resolve; });
  const client = new WorkbenchClient({ fetch: async (input, init) => {
    const response = await h.fetch(input, init);
    if (String(input).endsWith('/session')) { const body = await response.json(); body.data.personId = personId; return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }
    if (personId !== null && String(input).endsWith('/queries/notifications.list')) throw Error('Synthetic new owner read failure');
    if (String(input).endsWith('/commands')) { started(); await held; }
    return response;
  } });
  let refresh!: () => Promise<void>;
  function Overview() { const workbench = useWorkbench(); refresh = workbench.refreshSession; return <label>Фоновая заметка<input /></label>; }
  render(<WorkbenchProvider client={client}><WorkbenchShell views={{ overview: Overview }} /></WorkbenchProvider>);
  const opener = await screen.findByRole('button', { name: 'Уведомления' }); await waitFor(() => expect((opener as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(opener);
  fireEvent.click(await screen.findByRole('button', { name: 'Отметить прочитанным' })); await dispatched;
  personId = fixtureId(17); await act(async () => { await refresh(); });
  await screen.findByRole('alert'); const staleContentVisible = screen.queryByText(/Событие прежнего владельца/) !== null;
  await act(async () => { release(); });
  expect(staleContentVisible).toBe(false); expect(screen.queryByText('Уведомление прочитано. Причина остаётся открытой.')).toBeNull(); expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  const input = screen.getByRole('textbox', { name: 'Фоновая заметка' }); input.focus();
  await act(async () => { await refresh(); }); expect(document.activeElement).toBe(input);
});
it('keeps_null_context_explicit_without_business_queries_or_invented_scope', async () => {
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'empty' }); closes.push(h.close); await h.open('/overview');
  expect(screen.getByText(/Получите опубликованный каталог из main/)).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Уведомления' }));
  expect(h.requests.some(r => r.url.includes('/queries/') && !r.url.endsWith('/preferences.get'))).toBe(false); expect(window.location.search).toBe('');
});
it('greets_without_stealing_focus_and_closes_after_five_seconds_or_explicitly', async () => {
  const sentinel = document.createElement('input'); document.body.append(sentinel); sentinel.focus();
  const h = await createWorkbenchUiHarness({ role: 'curator', scenario: 'scope-split' }); closes.push(h.close);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await h.open('/overview'); expect(screen.getByRole('status').textContent).toContain('Тестовый куратор'); expect(document.activeElement).toBe(sentinel);
  act(() => { vi.advanceTimersByTime(4999); }); expect(screen.getByRole('status')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(1); }); expect(screen.queryByText(/Здравствуйте/)).toBeNull();
  await h.close(); vi.useRealTimers(); sentinel.remove();
  const second = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(second.close); await second.open('/overview'); fireEvent.click(screen.getByRole('button', { name: 'Закрыть приветствие' })); expect(screen.queryByText(/Здравствуйте/)).toBeNull();
});
