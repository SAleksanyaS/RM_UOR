// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Work, WorkDependency, Decision } from '../../../domain/workbench/entities';
import { fixtureId, makeHeader } from '../../../../tests/fixtures/workbench/factories';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import { WorkbenchExecutionPage } from './ExecutionPage';
import { useWorkbench } from '../../../app/workbench/context';
import { WorkbenchApiError, WorkbenchClient } from '../../../app/workbench/api-client';
import { StrictMode } from 'react';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
function TestPage() { const { refreshSession } = useWorkbench(); return <><button onClick={() => { void refreshSession(); }}>Обновить сеанс</button><WorkbenchExecutionPage /></>; }
async function fixture(role: 'viewer' | 'curator' = 'curator', clock?: string, strict = false) {
  const h = await createWorkbenchUiHarness({ role, scenario: 'scope-split', ...(clock ? { clock } : {}) }, { views: { execution: strict ? () => <StrictMode><TestPage /></StrictMode> : TestPage } }); closes.push(h.close);
  const goal = h.repository.getHead({ entityType: h.refs.goal.entityType, id: h.refs.goal.id })!;
  h.repository.transaction(() => { h.repository.append('core_goal_definition', { ...goal, ...makeHeader(350006, { publicationAnchorId: goal.publicationAnchorId }), title: 'Дополнительная цель', mode: 'manual_status', sourceId: fixtureId(350007) } as any, null); h.repository.append('source_definition', { ...makeHeader(350007, { publicationAnchorId: goal.publicationAnchorId }), goalId: fixtureId(350006), kind: 'manual_status', mappingRef: null, publicLocator: null }, null); });
  const header = (id: number) => makeHeader(id, { publicationAnchorId: goal.publicationAnchorId });
  const a: Work = { ...header(350001), title: 'Работа А', goalIds: [goal.id], responsibility: [{ scope: { kind: 'dit', id: fixtureId(100) }, personId: fixtureId(17) }], state: 'planned', dueOn: '2026-11-05', forecastOn: null, nextAction: 'Проверить выгрузку', reason: null, resultDescription: null, evidenceIds: [], risk: null, blocker: null };
  const b: Work = { ...a, ...header(350002), title: 'Работа Б' };
  const dependency: WorkDependency = { ...header(350003), predecessorWorkId: a.id, successorWorkId: b.id, active: true, changeReason: null };
  const decision: Decision = { ...header(350004), workId: a.id, request: 'Согласовать план', requestedFromPersonId: fixtureId(17), dueOn: '2026-11-06', answer: null, answeredAt: null };
  h.repository.transaction(() => { h.repository.append('work', a, null); h.repository.append('work', b, null); h.repository.append('work_dependency', dependency, null); h.repository.append('decision', decision, null); });
  const draft = (type: string, id: string) => {
    const row = h.repository.sqlForModule('drafts').get<{ definition_json: string }>('SELECT definition_json FROM wb_drafts_entries WHERE entity_type=? AND object_id=?', [type, id]);
    return row ? JSON.parse(row.definition_json) as Record<string, unknown> : null;
  };
  return { ...h, a, b, dependency, decision, draft };
}
it('reader sees shared work and decisions without shared editing controls', async () => {
  const h = await fixture('viewer'); await h.open('/execution');
  expect(await screen.findByText('Работа А')).toBeTruthy();
  expect(screen.getByText('Согласовать план')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Изменить работу: Работа А' })).toBeNull();
  expect(h.requests.filter(request => String(request.body?.name).includes('draft'))).toHaveLength(0);
});
it('curator dependency reading never opens a draft', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Зависимости: Работа А' }));
  await screen.findByRole('button', { name: 'Закрыть зависимости' });
  expect((await screen.findAllByText('Затронутые цели: Тестовая цель')).length).toBeGreaterThan(0);
  expect((await screen.findAllByText('Ответственный: demo_curator · ДИТ')).length).toBeGreaterThan(0);
  expect(h.requests.filter(request => request.body?.name === 'draft.open')).toHaveLength(0);
});
it('new work persists an empty partial then completes with public links and one server identity', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Создать работу' }));
  await screen.findByLabelText('Название работы');
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' }));
  await screen.findByText('Черновик сохранён');
  const opened = h.requests.find(request => request.body?.name === 'draft.open')!;
  expect((opened.body?.payload as any).ref).toBeNull();
  const row = () => h.repository.sqlForModule('drafts').get<{ object_id: string; definition_json: string; complete: number }>("SELECT object_id,definition_json,complete FROM wb_drafts_entries WHERE entity_type='work'");
  const id = row()!.object_id; expect(h.draft('work', id)?.title).toBeUndefined();
  fireEvent.change(screen.getByLabelText('Название работы'), { target: { value: 'Новая общая работа' } });
  const goalCheckboxes = screen.getAllByRole('checkbox', { name: /^Цель работы:/ });
  fireEvent.click(goalCheckboxes[0]); if (goalCheckboxes[1]) fireEvent.click(goalCheckboxes[1]);
  fireEvent.change(screen.getByLabelText('Область ответственности'), { target: { value: fixtureId(100) } });
  fireEvent.change(screen.getByLabelText('Ответственный'), { target: { value: fixtureId(17) } });
  fireEvent.click(screen.getByRole('button', { name: 'Добавить ответственного' }));
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' }));
  await waitFor(() => expect(h.draft('work', id)).toMatchObject({ title: 'Новая общая работа', responsibility: [{ scope: { kind: 'dit', id: fixtureId(100) }, personId: fixtureId(17) }] }));
  expect((h.draft('work', id)?.goalIds as string[]).length).toBe(Math.min(2, goalCheckboxes.length));
  expect(h.repository.sqlForModule('drafts').all('SELECT package_id FROM wb_drafts_packages')).toHaveLength(1);
  expect(h.repository.readPublishedHead({ entityType: 'work', id })).toBeNull();
  expect(h.requests.filter(request => request.body?.name === 'draft.open')).toHaveLength(1);
  expect(goalCheckboxes.length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText('Для изменения состояния сначала дополните поля работы.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть редактор' }));
  fireEvent.click(screen.getByRole('button', { name: 'Создать запрос решения' }));
  await screen.findByLabelText('Работа запроса');
  await waitFor(() => expect((screen.getByLabelText('Работа запроса') as HTMLSelectElement).querySelector(`option[value="${id}"]`)).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Работа запроса'), { target: { value: id } });
  fireEvent.change(screen.getByLabelText('Запрос'), { target: { value: 'Решение для новой работы' } });
  fireEvent.change(screen.getByLabelText('Адресат решения'), { target: { value: fixtureId(17) } });
  fireEvent.change(screen.getByLabelText('Срок решения'), { target: { value: '2026-11-10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить решение' })); await screen.findByText('Черновик сохранён');
  const decisionRow = h.repository.sqlForModule('drafts').get<{ definition_json: string }>("SELECT definition_json FROM wb_drafts_entries WHERE entity_type='decision'")!;
  expect(JSON.parse(decisionRow.definition_json)).toMatchObject({ workId: id, request: 'Решение для новой работы' });
});
it('the same published Work id is visible from both linked goals without copying it', async () => {
  const h = await fixture(); await h.client.session();
  const context = (await h.client.session()).data.defaultContext!;
  const options = await h.client.query<any>('context.options', { context, filter: {}, sort: [], page: { limit: 100, cursor: null } });
  const goals = options.data.goals.slice(0, 2).map((goal: any) => goal.id) as string[];
  expect(goals).toHaveLength(2);
  h.repository.append('work', { ...h.a, revision: 2, goalIds: goals }, 1);
  for (const goalId of goals) {
    const response = await h.client.query<any>('execution.list', { context: { ...context, goalId }, filter: { kind: 'work' }, sort: [], page: { limit: 100, cursor: null } });
    expect(response.data.items.filter((item: any) => item.ref.id === h.a.id)).toHaveLength(1);
    expect(response.data.items.find((item: any) => item.ref.id === h.a.id).value.goalIds).toEqual(goals);
  }
});
it('new decision selects real work and recipient and saves server answer time', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Создать запрос решения' }));
  fireEvent.change(await screen.findByLabelText('Запрос'), { target: { value: 'Новый запрос' } });
  await waitFor(() => expect((screen.getByLabelText('Работа запроса') as HTMLSelectElement).querySelector(`option[value="${h.a.id}"]`)).toBeTruthy());
  await waitFor(() => expect((screen.getByLabelText('Адресат решения') as HTMLSelectElement).querySelector(`option[value="${fixtureId(17)}"]`)).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Работа запроса'), { target: { value: h.a.id } });
  fireEvent.change(screen.getByLabelText('Адресат решения'), { target: { value: fixtureId(17) } });
  fireEvent.change(screen.getByLabelText('Срок решения'), { target: { value: '2026-11-10' } });
  fireEvent.change(screen.getByLabelText('Ответ на запрос'), { target: { value: 'Согласовано' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить решение' })); await screen.findByText('Черновик сохранён');
  const row = h.repository.sqlForModule('drafts').get<{ object_id: string }>("SELECT object_id FROM wb_drafts_entries WHERE entity_type='decision'")!;
  expect(h.draft('decision', row.object_id)).toMatchObject({ workId: h.a.id, requestedFromPersonId: fixtureId(17), answer: 'Согласовано', answeredAt: '2026-10-28T09:00:00Z' });
});
it('package selection can load and choose the actual package beyond the first hundred', async () => {
  const h = await fixture(); await h.client.session();
  for (let index = 0; index < 101; index++) await h.client.command({ commandId: crypto.randomUUID(), name: 'draft.open', baseRevision: null, payload: { entityType: 'work', ref: null, packageId: null } });
  const request = { context: (await h.client.session()).data.defaultContext!, filter: {}, sort: [], page: { limit: 100, cursor: null as string | null } };
  const first = await h.client.query<any>('uor.queue', request); const next = await h.client.query<any>('uor.queue', { ...request, page: { limit: 100, cursor: first.data.page.nextCursor } });
  const target = next.data.items[0].packageRef.id as string; const opens = h.requests.filter(request => request.body?.name === 'draft.open').length;
  await h.open('/execution'); fireEvent.click(await screen.findByRole('button', { name: 'Создать работу' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Показать ещё пакеты' }));
  await waitFor(() => expect((screen.getByLabelText('Пакет изменений') as HTMLSelectElement).querySelector(`option[value="${target}"]`)).toBeTruthy());
  expect(h.requests.filter(request => request.body?.name === 'draft.open')).toHaveLength(opens);
  fireEvent.change(screen.getByLabelText('Пакет изменений'), { target: { value: target } }); fireEvent.click(screen.getByRole('button', { name: 'Повторить открытие черновика' }));
  await screen.findByLabelText('Название работы');
  expect((h.requests.filter(request => request.body?.name === 'draft.open').at(-1)?.body?.payload as any).packageId).toBe(target);
}, 20000);
it('forecast_never_changes_planned_deadline_or_published_work', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  const forecast = await screen.findByLabelText('Прогноз');
  expect((screen.getByLabelText('Плановый срок') as HTMLInputElement).value).toBe('2026-11-05');
  fireEvent.change(forecast, { target: { value: '2026-11-12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' }));
  await screen.findByText('Черновик сохранён');
  expect(h.draft('work', h.a.id)).toMatchObject({ dueOn: '2026-11-05', forecastOn: '2026-11-12' });
  expect(h.repository.readPublishedHead({ entityType: 'work', id: h.a.id })).toMatchObject({ dueOn: '2026-11-05', forecastOn: null });
  expect(screen.queryByRole('button', { name: 'Подтвердить цель' })).toBeNull();
});
it('cancel_blocker_requires_reasoned_dependency_resolution_and_keeps_input', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  fireEvent.change(await screen.findByLabelText('Новое состояние'), { target: { value: 'cancelled' } });
  fireEvent.change(screen.getByLabelText('Причина изменения состояния'), { target: { value: 'Изменился план' } });
  fireEvent.click(screen.getByRole('button', { name: 'Изменить состояние' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Причина изменения состояния') as HTMLTextAreaElement).value).toBe('Изменился план');
  fireEvent.click(screen.getByLabelText('Снять зависимость: Работа А → Работа Б'));
  fireEvent.change(screen.getByLabelText('Причина снятия зависимости'), { target: { value: 'Дальнейшая работа независима' } });
  fireEvent.click(screen.getByRole('button', { name: 'Изменить состояние' }));
  await waitFor(() => expect(h.draft('work', h.a.id)?.state).toBe('cancelled'));
  expect(h.draft('work_dependency', h.dependency.id)).toMatchObject({ active: false, changeReason: 'Дальнейшая работа независима' });
  const packages = h.repository.sqlForModule('drafts').all('SELECT package_id FROM wb_drafts_packages'); expect(packages).toHaveLength(1);
  expect(h.repository.readPublishedHead({ entityType: 'work', id: h.a.id })?.revision).toBe(1);
});
it('a corrected rejected transition keeps completed dependency steps and their package CAS', async () => {
  const h = await fixture(); await h.open('/execution'); fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  fireEvent.change(await screen.findByLabelText('Новое состояние'), { target: { value: 'cancelled' } });
  fireEvent.click(screen.getByLabelText('Снять зависимость: Работа А → Работа Б'));
  fireEvent.change(screen.getByLabelText('Причина снятия зависимости'), { target: { value: 'Дальнейшая работа независима' } });
  fireEvent.click(screen.getByRole('button', { name: 'Изменить состояние' })); await screen.findByRole('alert');
  expect(h.draft('work_dependency', h.dependency.id)?.active).toBe(false);
  fireEvent.change(screen.getByLabelText('Причина изменения состояния'), { target: { value: 'Изменился план' } });
  fireEvent.click(screen.getByRole('button', { name: 'Изменить состояние' })); await screen.findByText('Черновик сохранён');
  const transitions = h.requests.filter(request => request.body?.name === 'work.transition');
  expect(transitions).toHaveLength(2); expect(transitions[0].body?.commandId).not.toBe(transitions[1].body?.commandId); expect(transitions[0].body?.baseRevision).toBe(transitions[1].body?.baseRevision);
  expect(h.requests.filter(request => request.body?.name === 'workDependency.draft.save')).toHaveLength(1);
  expect(h.requests.filter(request => request.body?.name === 'draft.open')).toHaveLength(2);
  expect(h.draft('work', h.a.id)?.state).toBe('cancelled');
});
it('reopen_preserves_previous_completion_and_requires_reason', async () => {
  const h = await fixture(); h.repository.append('work', { ...h.a, revision: 2, state: 'completed', resultDescription: 'Выгрузка проверена' }, 1); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  fireEvent.change(await screen.findByLabelText('Новое состояние'), { target: { value: 'in_progress' } });
  fireEvent.click(screen.getByRole('button', { name: 'Изменить состояние' })); await screen.findByRole('alert');
  fireEvent.change(screen.getByLabelText('Причина изменения состояния'), { target: { value: 'Нужна дополнительная проверка' } });
  fireEvent.click(screen.getByRole('button', { name: 'Изменить состояние' }));
  await waitFor(() => expect(h.draft('work', h.a.id)).toMatchObject({ state: 'in_progress', resultDescription: 'Выгрузка проверена' }));
  expect(h.repository.readVersion({ entityType: 'work', id: h.a.id, revision: 2 })).toMatchObject({ state: 'completed', resultDescription: 'Выгрузка проверена' });
});
it('decision answer and answer timestamp are saved together by the real owner', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Ответить на решение: Согласовать план' }));
  fireEvent.change(await screen.findByLabelText('Ответ на запрос'), { target: { value: 'План согласован' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить решение' }));
  await waitFor(() => expect(h.draft('decision', h.decision.id)).toMatchObject({ answer: 'План согласован', answeredAt: '2026-10-28T09:00:00Z' }));
  expect(screen.queryByLabelText('Время ответа')).toBeNull();
});
it('deadline overdue starts at Moscow midnight and never replaces the planned date', async () => {
  const h = await fixture('viewer', '2026-11-05T21:00:00Z'); await h.open('/execution');
  expect((await screen.findAllByText('Просрочено')).length).toBeGreaterThan(0);
  expect(screen.getAllByText('05.11.2026').length).toBeGreaterThan(0);
});
it('same owner access refresh retains dirty work fields and blocks writes during recheck', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  const input = await screen.findByLabelText('Прогноз'); fireEvent.change(input, { target: { value: '2026-11-19' } }); input.focus();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const session = h.client.session.bind(h.client);
  vi.spyOn(h.client, 'session').mockImplementationOnce(async () => { await held; return session(); });
  fireEvent.click(screen.getByRole('button', { name: 'Обновить сеанс' }));
  try { expect(screen.getByRole('dialog')).toBeTruthy(); expect((screen.getByLabelText('Прогноз') as HTMLInputElement).value).toBe('2026-11-19'); expect((screen.getByLabelText('Прогноз') as HTMLInputElement).matches(':disabled')).toBe(true); }
  finally { release(); }
  await waitFor(() => expect((screen.getByLabelText('Прогноз') as HTMLInputElement).matches(':disabled')).toBe(false));
  expect((screen.getByLabelText('Прогноз') as HTMLInputElement).value).toBe('2026-11-19');
});
it('reopening an existing work loads the current own definition instead of the published head', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  fireEvent.change(await screen.findByLabelText('Название работы'), { target: { value: 'Моё новое название' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' })); await screen.findByText('Черновик сохранён');
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть редактор' }));
  fireEvent.click(screen.getByRole('button', { name: 'Изменить работу: Работа А' }));
  expect((await screen.findByLabelText('Название работы') as HTMLInputElement).value).toBe('Моё новое название');
});
it('same owner query refresh preserves dirty decision and does not reopen its draft', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Ответить на решение: Согласовать план' }));
  fireEvent.change(await screen.findByLabelText('Ответ на запрос'), { target: { value: 'Несохранённый ответ' } });
  const opens = h.requests.filter(request => request.body?.name === 'draft.open').length;
  fireEvent.click(screen.getByRole('button', { name: 'Обновить сеанс' }));
  await waitFor(() => expect((screen.getByLabelText('Ответ на запрос') as HTMLTextAreaElement).matches(':disabled')).toBe(false));
  expect((screen.getByLabelText('Ответ на запрос') as HTMLTextAreaElement).value).toBe('Несохранённый ответ');
  expect(h.requests.filter(request => request.body?.name === 'draft.open')).toHaveLength(opens);
});
it('a real goal context change isolates an old dirty work and does not write it', async () => {
  const h = await fixture(); await h.open('/execution'); fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  fireEvent.change(await screen.findByLabelText('Прогноз'), { target: { value: '2026-11-20' } });
  await h.open('/execution?goal=' + fixtureId(350006));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(h.requests.filter(request => request.body?.name === 'work.draft.save')).toHaveLength(0);
});
it('a failed post-save package refresh freezes input until the known receipt is reconciled', async () => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  fireEvent.change(await screen.findByLabelText('Прогноз'), { target: { value: '2026-11-19' } });
  const query = h.client.query.bind(h.client); let fail = true;
  vi.spyOn(h.client, 'query').mockImplementation(async (name, request, options) => { if (name === 'uor.package' && fail) { fail = false; throw Error('Synthetic refresh failure'); } return query(name, request, options); });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' })); await screen.findByRole('alert');
  expect((screen.getByLabelText('Прогноз') as HTMLInputElement).matches(':disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' })); await screen.findByText('Черновик сохранён');
  expect(h.requests.filter(request => request.body?.name === 'work.draft.save')).toHaveLength(1);
  expect((screen.getByLabelText('Прогноз') as HTMLInputElement).matches(':disabled')).toBe(false);
});
it('StrictMode creates one real draft and an immediate repeated save creates one revision', async () => {
  const h = await fixture('curator', undefined, true); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Создать работу' })); await screen.findByLabelText('Название работы');
  fireEvent.change(screen.getByLabelText('Название работы'), { target: { value: 'Единственный черновик' } });
  const command = h.client.command.bind(h.client); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(h.client, 'command').mockImplementationOnce(async request => { await held; return command(request); });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' })); fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' })); release(); await screen.findByText('Черновик сохранён');
  expect(h.repository.sqlForModule('drafts').all('SELECT draft_id FROM wb_drafts_entries')).toHaveLength(1);
  expect(h.requests.filter(request => request.body?.name === 'draft.open')).toHaveLength(1);
  expect(h.requests.filter(request => request.body?.name === 'work.draft.save')).toHaveLength(1);
});
it('closing an editor while a command is pending prevents follow-on package reads or actions', async () => {
  const h = await fixture(); await h.open('/execution'); fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  fireEvent.change(await screen.findByLabelText('Прогноз'), { target: { value: '2026-11-20' } });
  const command = h.client.command.bind(h.client); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(h.client, 'command').mockImplementationOnce(async request => { await held; return command(request); });
  const reads = h.requests.filter(request => request.url.endsWith('/uor.package')).length;
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' })); fireEvent.click(screen.getByRole('button', { name: 'Закрыть редактор' })); release();
  await waitFor(() => expect(h.draft('work', h.a.id)?.forecastOn).toBe('2026-11-20'));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(h.requests.filter(request => request.url.endsWith('/uor.package'))).toHaveLength(reads);
});
it('Escape closes the modal and returns focus even after disabling a saving control moved focus outside', async () => {
  const h = await fixture(); await h.open('/execution'); const opener = await screen.findByRole('button', { name: 'Изменить работу: Работа А' }); opener.focus(); fireEvent.click(opener);
  await screen.findByLabelText('Прогноз');
  // Native browsers move focus to the body when the focused save button becomes disabled.
  (document.activeElement as HTMLElement).blur();
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
});
it('a lost draft-open response waits for an explicit exact retry even when the same session refreshes', async () => {
  const h = await fixture(); await h.open('/execution'); const command = h.client.command.bind(h.client);
  vi.spyOn(h.client, 'command').mockImplementationOnce(async request => { await command(request); throw Error('Synthetic lost open response'); });
  fireEvent.click(await screen.findByRole('button', { name: 'Создать работу' })); await screen.findByRole('alert');
  const pkg = h.repository.sqlForModule('drafts').get<{ package_id: string }>('SELECT package_id FROM wb_drafts_packages')!;
  const query = vi.spyOn(h.client, 'query'); fireEvent.click(screen.getByRole('button', { name: 'Обновить сеанс' }));
  await waitFor(() => expect((screen.getByLabelText('Пакет изменений') as HTMLSelectElement).querySelector(`option[value="${pkg.package_id}"]`)).toBeTruthy());
  expect(query.mock.calls.filter(([name]) => name === 'uor.package')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить открытие черновика' })); await screen.findByLabelText('Название работы');
  const opens = h.requests.filter(request => request.body?.name === 'draft.open'); expect(opens).toHaveLength(2); expect(opens[0].body).toEqual(opens[1].body);
  expect(h.repository.sqlForModule('drafts').all('SELECT draft_id FROM wb_drafts_entries')).toHaveLength(1);
});
it.each(['response', 'readback'] as const)('unknown sole-existing-package open retains its exact original choice after %s loss and session refresh', async failure => {
  const h = await fixture(); await h.client.session();
  await h.client.command({ commandId: crypto.randomUUID(), name: 'draft.open', baseRevision: null, payload: { entityType: 'work', ref: { entityType: 'work', id: h.a.id }, packageId: null } });
  const pkg = h.repository.sqlForModule('drafts').get<{ package_id: string }>('SELECT package_id FROM wb_drafts_packages')!;
  await h.open('/execution');
  if (failure === 'response') { const command = h.client.command.bind(h.client); vi.spyOn(h.client, 'command').mockImplementationOnce(async request => { await command(request); throw Error('Synthetic lost sole-package open response'); }); }
  else { const query = h.client.query.bind(h.client); let packageReads = 0; vi.spyOn(h.client, 'query').mockImplementation(async (name, request, options) => { const result = await query(name, request, options); if (name === 'uor.package' && ++packageReads === 2) throw Error('Synthetic open readback loss'); return result; }); }
  fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' })); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Обновить сеанс' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Создать работу' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Повторить открытие черновика' }));
  await screen.findByLabelText('Название работы');
  const opens = h.requests.filter(request => request.body?.name === 'draft.open').slice(1);
  expect(opens).toHaveLength(failure === 'response' ? 2 : 1);
  expect((opens[0].body?.payload as any).packageId).toBe(pkg.package_id);
  if (failure === 'response') expect(opens[1].body).toEqual(opens[0].body);
  expect(h.repository.sqlForModule('drafts').all('SELECT package_id FROM wb_drafts_packages')).toHaveLength(1);
  expect(h.repository.sqlForModule('drafts').all('SELECT draft_id FROM wb_drafts_entries')).toHaveLength(1);
});
it.each([
  ['work', 'concurrent-read'], ['decision', 'concurrent-read'], ['work', 'failed-read'], ['decision', 'failed-read'],
] as const)('%s readback %s cannot adopt another tab CAS over retained local input', async (kind, failure) => {
  const h = await fixture(); await h.open('/execution');
  const openLabel = kind === 'work' ? 'Изменить работу: Работа А' : 'Ответить на решение: Согласовать план';
  const field = kind === 'work' ? 'Название работы' : 'Ответ на запрос', saveLabel = kind === 'work' ? 'Сохранить поля работы' : 'Сохранить решение';
  const id = kind === 'work' ? h.a.id : h.decision.id, property = kind === 'work' ? 'title' : 'answer', commandName = kind === 'work' ? 'work.draft.save' : 'decision.draft.save';
  fireEvent.click(await screen.findByRole('button', { name: openLabel }));
  fireEvent.change(await screen.findByLabelText(field), { target: { value: 'Мой введённый текст' } });
  const secondTab = new WorkbenchClient({ fetch: h.fetch }), context = (await secondTab.session()).data.defaultContext!;
  const pkgId = h.repository.sqlForModule('drafts').get<{ package_id: string }>('SELECT package_id FROM wb_drafts_packages')!.package_id;
  const request = { context, filter: { packageRef: { entityType: 'publication_package', id: pkgId } }, sort: [], page: { limit: 100, cursor: null } };
  const editInSecondTab = async () => {
    const pkg = (await secondTab.query<any>('uor.package', request)).data, entry = pkg.entries.find((entry: any) => entry.entityRef.id === id);
    const definition = { ...entry.definition, [property]: 'Сохранено в другом окне' }; if (kind === 'decision') delete definition.answeredAt;
    await secondTab.command({ commandId: crypto.randomUUID(), name: commandName, baseRevision: pkg.summary.editToken, payload: { draftId: entry.draftId, definition } });
  };
  const query = h.client.query.bind(h.client); let intercepted = false;
  vi.spyOn(h.client, 'query').mockImplementation(async (name, input, options) => {
    if (name === 'uor.package' && !intercepted) { intercepted = true; if (failure === 'failed-read') throw Error('Synthetic readback lost'); await editInSecondTab(); }
    return query(name, input, options);
  });
  fireEvent.click(screen.getByRole('button', { name: saveLabel }));
  if (failure === 'failed-read') { await screen.findByRole('alert'); await editInSecondTab(); fireEvent.click(screen.getByRole('button', { name: saveLabel })); }
  await waitFor(() => expect(intercepted).toBe(true));
  await waitFor(() => expect(screen.queryByText('Сохраняем черновик…')).toBeNull());
  expect(h.draft(kind, id)?.[property]).toBe('Сохранено в другом окне');
  expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('Мой введённый текст');
  const save = screen.getByRole('button', { name: saveLabel }) as HTMLButtonElement; expect(save.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Обновить сеанс' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Создать работу' }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('Мой введённый текст'); expect(save.disabled).toBe(true);
  const writesBefore = h.requests.filter(request => request.body?.name === commandName).length; fireEvent.click(save);
  expect(h.requests.filter(request => request.body?.name === commandName)).toHaveLength(writesBefore);
  expect(h.draft(kind, id)?.[property]).toBe('Сохранено в другом окне');
  fireEvent.click(screen.getByRole('button', { name: 'Загрузить актуальный черновик вместо введённых данных' }));
  await waitFor(() => expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe('Сохранено в другом окне'));
  fireEvent.change(screen.getByLabelText(field), { target: { value: 'После явной сверки' } }); fireEvent.click(screen.getByRole('button', { name: saveLabel }));
  await waitFor(() => expect(h.draft(kind, id)?.[property]).toBe('После явной сверки'));
});
it.each(['network', 'interrupted'] as const)('lost work-save response %s reuses the exact command instead of creating another draft revision', async failureKind => {
  const h = await fixture(); await h.open('/execution');
  fireEvent.click(await screen.findByRole('button', { name: 'Изменить работу: Работа А' }));
  fireEvent.change(await screen.findByLabelText('Прогноз'), { target: { value: '2026-11-19' } });
  const command = h.client.command.bind(h.client); vi.spyOn(h.client, 'command').mockImplementationOnce(async request => { await command(request); if (failureKind === 'interrupted') throw new WorkbenchApiError({ code: 'COMMAND_INTERRUPTED', message: 'Outcome not confirmed', retryable: true, details: [], operationId: null, provider: null }, 409, fixtureId(350099)); throw Error('Synthetic response loss'); });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' }));
  await screen.findByRole('alert');
  expect(h.draft('work', h.a.id)).toMatchObject({ forecastOn: '2026-11-19' });
  const versions = h.repository.sqlForModule('drafts').all('SELECT revision FROM wb_drafts_revisions');
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить поля работы' })); await screen.findByText('Черновик сохранён');
  const writes = h.requests.filter(request => request.body?.name === 'work.draft.save');
  expect(writes).toHaveLength(2); expect(writes[0].body?.commandId).toBe(writes[1].body?.commandId);
  expect(h.repository.sqlForModule('drafts').all('SELECT revision FROM wb_drafts_revisions')).toEqual(versions);
});
