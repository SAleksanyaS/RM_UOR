// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import { WorkbenchBrowserScenarioWizard } from './BrowserScenarioWizard';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
import { WorkbenchSourceSetupWizard } from '../../sources/workbench/SourceSetupWizard';
// app.inject shares this jsdom process with Node parsers; retain Node's native byte realm.
beforeAll(() => vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor));
afterAll(() => vi.unstubAllGlobals());
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); sessionStorage.clear(); });
async function fixture(role: 'curator' | 'viewer' = 'curator', browserFixture: { unconfigured?: boolean; partial?: boolean } = {}, ownSource = false) {
  let f: Awaited<ReturnType<typeof createWorkbenchUiHarness>>;
  let ownProps: import('./SharedBrowserScenarioWizard').SharedBrowserScenarioProps | null = null;
  const saved: string[] = [];
  f = await createWorkbenchUiHarness({ role, scenario: 'scope-split', browserFixture }, { views: { data: () => <WorkbenchBrowserScenarioWizard {...(ownProps ?? { sourceRef: f.refs.source, draftId: null, onDraftSaved: id => saved.push(id) })} /> } });
  cleanup.push(f.close);
  if (ownSource) {
    const session = await f.client.session();
    const open = await f.client.command<import('../../../server/workbench/protocol').CommandResult>({ commandId: crypto.randomUUID(), name: 'draft.open', payload: { entityType: 'source_definition', ref: null, packageId: null }, baseRevision: null });
    if (!('result' in open.data)) throw Error('Expected source draft');
    const draft = open.data.result as { draftId: string };
    const queue = await f.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['uor.queue']>('uor.queue', { context: session.data.defaultContext!, filter: {}, sort: [], page: { limit: 50, cursor: null } });
    const result = await f.client.command<import('../../../server/workbench/protocol').CommandResult>({ commandId: crypto.randomUUID(), name: 'source.draft.save', payload: { draftId: draft.draftId, definition: { goalId: f.refs.goal.id, kind: 'qlik', publicLocator: 'https://report.example.invalid/report', mappingRef: null } }, baseRevision: open.data.editToken });
    if (!('result' in result.data)) throw Error('Expected saved source');
    ownProps = { sourceRef: (result.data.result as { versionRef: import('../../../domain/workbench/primitives').VersionRef }).versionRef, draftId: null, ownDraft: { packageId: queue.data.items[0].packageRef.id, sourceDraftId: draft.draftId, editToken: result.data.editToken! }, onDraftSaved: id => saved.push(id) };
  }
  await f.open('/data');
  await screen.findByRole('heading', { name: 'Сценарий ОКО' });
  return { ...f, saved };
}
async function click(name: string) { const button = await screen.findByRole('button', { name }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(button); }
async function record(f: Awaited<ReturnType<typeof fixture>>) {
  await click('Выбрать признак открытого отчёта');
  await screen.findByText('Признак отчёта: Отчёт');
  await click('Открыть СберБраузер и записать действия');
  await screen.findByRole('button', { name: 'Завершить запись и проверить шаги' });
  f.browserTesting!.completeRecording();
  await click('Завершить запись и проверить шаги');
  await screen.findByLabelText('Значение фильтра «Период»');
  fireEvent.change(screen.getByLabelText('Обязательные столбцы'), { target: { value: 'demo_value' } });
}
it('curator_records_reviews_filters_and_saves_draft_without_json', async () => {
  const f = await fixture(); await record(f);
  expect(screen.queryByRole('textbox', { name: /JSON|CSS|SQL/i })).toBeNull();
  fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-10' } });
  await click('Проверить сценарий');
  await screen.findByText('Принято для предпросмотра: 1; отклонено: 0.');
  expect(screen.getByRole('table', { name: 'Строки проверочной выгрузки' }).textContent).toContain('92');
  await click('Сохранить сценарий в черновик');
  await waitFor(() => expect(f.saved).toHaveLength(1));
  expect(f.requests.filter(r => String(r.body?.name).startsWith('package.submit'))).toHaveLength(0);
  const writes = f.requests.filter(r => r.body?.name === 'source.browserScenario.draft.save');
  expect(writes.length).toBeGreaterThanOrEqual(2);
  expect(writes.at(-1)!.body?.baseRevision).toMatch(/^draft:/);
  expect(await screen.findByRole('link', { name: 'Перейти к пакету УОР' })).toBeTruthy();
});
it('first unpublished source configures own profile and records through its exact private binding', async () => {
  const f = await fixture('curator', { unconfigured: true }, true);
  await screen.findByText('Личный браузер ещё не настроен.');
  fireEvent.change(screen.getByLabelText('Путь к СберБраузеру'), { target: { value: process.execPath } }); await click('Сохранить личный профиль'); await screen.findByText('Личный профиль сохранён.');
  await record(f);
  const request = f.requests.find(r => r.body?.name === 'source.browser.record.start')!.body!;
  expect(request.payload).toMatchObject({ ownDraft: { packageId: expect.any(String), sourceDraftId: expect.any(String), editToken: expect.stringMatching(/^draft:/) } });
  const id = (request.payload as { sourceRef: { id: string } }).sourceRef.id;
  expect(f.repository.readPublishedHead({ entityType: 'source_definition', id })).toBeNull();
  fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-10' } }); await click('Проверить сценарий');
  await screen.findByText(/Полнота выгрузки не подтверждена/); await click('Сохранить сценарий в черновик');
  await screen.findByText('Черновик сохранён с замечаниями. Проверьте пакет УОР.'); expect(f.saved).toHaveLength(1);
});
it('empty installation explains the missing context without inventing a source', async () => {
  const f = await createWorkbenchUiHarness({ role: 'curator', scenario: 'empty' }, { views: { data: () => <WorkbenchBrowserScenarioWizard sourceRef={{ entityType: 'source_definition', id: fixtureId(12), revision: 1 }} draftId={null} onDraftSaved={() => { throw Error('No source'); }} /> } });
  cleanup.push(f.close); await f.open('/data');
  await screen.findByText(/Нет опубликованного контекста. Сначала создайте цель и собственный черновик источника/); expect(screen.queryByRole('button', { name: /записать действия/i })).toBeNull();
});
it('source setup hands its saved exact own source directly to the browser wizard', async () => {
  let f: Awaited<ReturnType<typeof createWorkbenchUiHarness>>;
  f = await createWorkbenchUiHarness({ role: 'curator', scenario: 'scope-split', browserFixture: {} }, { views: { data: () => <WorkbenchSourceSetupWizard sourceRef={{ entityType: 'source_definition', id: f.refs.source.id }} goalRef={{ entityType: 'core_goal_definition', id: f.refs.goal.id }} onClose={() => {}} /> } });
  cleanup.push(f.close); await f.open('/data'); await click('Сохранить черновик настройки');
  await screen.findByRole('heading', { name: 'Сценарий ОКО' });
  await click('Выбрать признак открытого отчёта'); await screen.findByText('Признак отчёта: Отчёт');
  await click('Открыть СберБраузер и записать действия'); await screen.findByRole('button', { name: 'Отменить запись' });
  const request = f.requests.find(r => r.body?.name === 'source.browser.record.start')!.body!;
  expect(request.payload).toMatchObject({ sourceRef: { id: f.refs.source.id }, ownDraft: { packageId: expect.any(String), sourceDraftId: expect.any(String), editToken: expect.stringMatching(/^draft:/) } });
  expect(screen.queryByLabelText(/JSON|CSS|SQL|Engine endpoint|appId|objectId/)).toBeNull();
});
it.each(['PROFILE_IN_USE', 'SOURCE_UNAVAILABLE'])('failed browser start retains the URL and offers an explicit retry: %s', async code => {
  const f = await fixture(); await click('Выбрать признак открытого отчёта'); await screen.findByText('Признак отчёта: Отчёт');
  f.browserTesting!.failStart(code); await click('Открыть СберБраузер и записать действия');
  await screen.findByText(new RegExp(code));
  expect((screen.getByLabelText('Адрес отчёта') as HTMLInputElement).value).toBe('https://report.example.invalid/report');
  f.browserTesting!.failStart(null); await click('Повторить действие'); await screen.findByRole('button', { name: 'Отменить запись' });
});
it('lost source-save response resumes the same command and keeps entered filters', async () => {
  const f = await fixture(); await record(f);
  fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-10' } });
  const command = f.client.command.bind(f.client); let dropped = false;
  f.client.command = async (...args) => { const result = await command(...args); if (args[0].name === 'source.draft.save' && !dropped) { dropped = true; throw Error('Ответ потерян после сохранения'); } return result as never; };
  await click('Проверить сценарий'); await screen.findByText('Ответ потерян после сохранения');
  expect((screen.getByLabelText('Адрес отчёта') as HTMLInputElement).readOnly).toBe(true);
  await click('Повторить действие');
  await screen.findByText('Принято для предпросмотра: 1; отклонено: 0.');
  const writes = f.requests.filter(r => r.body?.name === 'source.draft.save');
  expect(writes).toHaveLength(2); expect(writes[0].body?.commandId).toBe(writes[1].body?.commandId);
  expect((screen.getByLabelText('Значение фильтра «Период»') as HTMLInputElement).value).toBe('2026-10');
});
it('server package CAS rejects saving after a concurrent edit without replacing input', async () => {
  const f = await fixture(); await record(f);
  fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-10' } });
  await click('Проверить сценарий'); await screen.findByText('Принято для предпросмотра: 1; отклонено: 0.');
  const session = await f.client.session();
  const queue = await f.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['uor.queue']>('uor.queue', { context: session.data.defaultContext!, filter: {}, sort: [], page: { limit: 50, cursor: null } });
  await f.client.command({ commandId: crypto.randomUUID(), name: 'draft.open', payload: { entityType: 'metric_definition', ref: null, packageId: queue.data.items[0].packageRef.id }, baseRevision: queue.data.items[0].editToken });
  await click('Сохранить сценарий в черновик'); await screen.findByText(/Пакет изменился/);
  expect(f.saved).toEqual([]); expect((screen.getByLabelText('Значение фильтра «Период»') as HTMLInputElement).value).toBe('2026-10');
});
it('cancel returns keyboard focus to record and does not accept a sample', async () => {
  const f = await fixture(); await click('Выбрать признак открытого отчёта'); await screen.findByText('Признак отчёта: Отчёт');
  await click('Открыть СберБраузер и записать действия');
  expect((screen.getByLabelText('Адрес отчёта') as HTMLInputElement).readOnly).toBe(true);
  await click('Отменить запись');
  await screen.findByText('Запись отменена.');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Открыть СберБраузер и записать действия' })));
  expect(f.saved).toEqual([]);
});
it('viewer_can_login_and_capture_but_cannot_record', async () => {
  const f = await fixture('viewer');
  expect(screen.queryByRole('button', { name: /записать действия/i })).toBeNull();
  await click('Открыть браузер для входа');
  await click('Проверить вход');
  await screen.findByText('Вход подтверждён по открытому отчёту.');
  await click('Обновить данные');
  await screen.findByText(/Получение завершено/);
  expect(screen.getByRole('link', { name: 'Скачать исходную выгрузку' }).getAttribute('href')).toMatch(/^\/api\/v1\/browser\/results\/[a-f0-9-]+\/original$/);
  expect(f.requests.some(r => r.body?.name === 'source.capture')).toBe(true);
  expect(f.requests.some(r => /draft.save|record.start/.test(String(r.body?.name)))).toBe(false);
});
it('reader can cancel its real running capture job without editing shared definitions', async () => {
  const f = await fixture('viewer'); const release = f.browserTesting!.holdReplay();
  await click('Обновить данные');
  await click('Отменить получение'); release();
  await screen.findByText(/cancelled/);
  expect(f.requests.some(r => r.body?.name === 'job.cancel')).toBe(true);
  expect(f.requests.some(r => String(r.body?.name).endsWith('draft.save'))).toBe(false);
});
it('returning to the wizard links the newest accepted own capture from the read model', async () => {
  const f = await fixture('viewer');
  await click('Обновить данные'); await screen.findByText(/Получение завершено/);
  await click('Обновить данные');
  await waitFor(() => expect(f.requests.filter(r => r.body?.name === 'source.capture')).toHaveLength(2));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Обновить данные' }) as HTMLButtonElement).disabled).toBe(false));
  const session = await f.client.session();
  const captures = await f.client.query<import('../../catalog/workbench-read-models').WorkbenchReadModels['data.captures']>('data.captures', { context: { ...session.data.defaultContext!, goalId: f.refs.goal.id }, filter: {}, sort: [], page: { limit: 50, cursor: null } });
  const accepted = captures.data.items.filter(item => item.capture.sourceId === f.refs.source.id && item.capture.result === 'accepted' && item.obtainedVia === 'local-cache' && item.capture.rawArtifactId);
  expect(accepted.length).toBeGreaterThanOrEqual(2);
  await f.open('/overview'); await f.open('/data');
  const link = await screen.findByRole('link', { name: 'Скачать исходную выгрузку' });
  expect(link.getAttribute('href')).toBe(`/api/v1/browser/results/${accepted[0].capture.id}/original`);
});
it('capture continues across navigation and restores its own accepted download links without a second command', async () => {
  const f = await fixture('viewer'); const release = f.browserTesting!.holdReplay();
  await click('Обновить данные'); await screen.findByText(/Задание получения: running/);
  await f.open('/overview'); await f.open('/data'); await screen.findByText(/Задание получения: running/);
  expect((screen.getByRole('button', { name: 'Обновить данные' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => release());
  await screen.findByRole('link', { name: 'Скачать исходную выгрузку' });
  expect(f.requests.filter(r => r.body?.name === 'source.capture')).toHaveLength(1);
  expect(f.requests.some(r => r.body?.name === 'job.cancel')).toBe(false);
});
it('own profile CAS rejection retains the typed local profile name', async () => {
  const f = await fixture('viewer'); await screen.findByLabelText('Имя личного профиля');
  const { data } = await f.client.query<import('../workbench-browser-profile').BrowserProfileView>('source.browser.own', { context: null, filter: { sourceRef: f.refs.source }, sort: [], page: { limit: 50, cursor: null } });
  await f.client.command({ commandId: crypto.randomUUID(), name: 'source.browser.profile.set', baseRevision: null, payload: { sourceId: f.refs.source.id, profileId: data.profileId, expectedRevision: data.revision, profile: { ...data.profile!, timeoutMs: 9000 } } });
  fireEvent.change(screen.getByLabelText('Имя личного профиля'), { target: { value: 'my-other-profile' } }); await click('Сохранить личный профиль');
  await screen.findByText(/REVISION_CONFLICT/);
  expect((screen.getByLabelText('Имя личного профиля') as HTMLInputElement).value).toBe('my-other-profile');
});
it('background_job_preserves_form_and_focus', async () => {
  const f = await fixture(); await record(f);
  const field = screen.getByLabelText('Значение фильтра «Период»');
  fireEvent.change(field, { target: { value: '2026-10' } });
  const release = f.browserTesting!.holdReplay();
  await click('Проверить сценарий');
  field.focus(); fireEvent.change(field, { target: { value: 'Незавершённый ввод' } });
  await act(async () => release());
  await screen.findByText('Принято для предпросмотра: 1; отклонено: 0.');
  expect((field as HTMLInputElement).value).toBe('Незавершённый ввод');
  expect(document.activeElement).toBe(field);
  expect((screen.getByRole('button', { name: 'Сохранить сценарий в черновик' }) as HTMLButtonElement).disabled).toBe(true);
});
it('unconfigured profile and incomplete export may save an explicitly incomplete local draft', async () => {
  const f = await fixture('curator', { unconfigured: true, partial: true });
  await screen.findByText('Личный браузер ещё не настроен.');
  fireEvent.change(screen.getByLabelText('Путь к СберБраузеру'), { target: { value: process.execPath } });
  await click('Сохранить личный профиль');
  await screen.findByText('Личный профиль сохранён.');
  await record(f); fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-10' } });
  await click('Проверить сценарий');
  await screen.findByText(/Полнота выгрузки не подтверждена/);
  await click('Сохранить сценарий в черновик');
  await screen.findByText('Черновик сохранён с замечаниями. Проверьте пакет УОР.');
  expect(f.saved).toHaveLength(1);
  expect(f.requests.some(r => r.body?.name === 'package.submit')).toBe(false);
});
it('profile changed after successful preview invalidates the final save receipt', async () => {
  const f = await fixture(); await record(f); fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-10' } });
  await click('Проверить сценарий'); await screen.findByText('Принято для предпросмотра: 1; отклонено: 0.');
  const { data } = await f.client.query<import('../workbench-browser-profile').BrowserProfileView>('source.browser.own', { context: null, filter: { sourceRef: f.refs.source }, sort: [], page: { limit: 50, cursor: null } });
  await f.client.command({ commandId: crypto.randomUUID(), name: 'source.browser.profile.set', baseRevision: null, payload: { sourceId: f.refs.source.id, profileId: data.profileId, expectedRevision: data.revision, profile: { ...data.profile!, timeoutMs: 9000 } } });
  await click('Сохранить сценарий в черновик');
  await screen.findByText(/SCENARIO_TEST_REQUIRED/); expect(f.saved).toEqual([]);
});
it('review_I1_profile_change_and_filter_edit_can_run_a_fresh_test_and_save', async () => {
  const f = await fixture(); await record(f);
  fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-10' } });
  await click('Проверить сценарий'); await screen.findByText(/Полнота выгрузки подтверждена\./);
  fireEvent.change(screen.getByLabelText('Имя личного профиля'), { target: { value: 'new-own-profile' } });
  await click('Сохранить личный профиль'); await screen.findByText('Личный профиль сохранён.');
  fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-11' } });
  await click('Проверить сценарий');
  await waitFor(() => expect(f.requests.filter(r => r.body?.name === 'source.browser.record.test')).toHaveLength(2));
  await click('Сохранить сценарий в черновик'); await screen.findByText('Сценарий сохранён в собственном черновике.');
  expect(f.saved).toHaveLength(1);
  expect((screen.getByLabelText('Значение фильтра «Период»') as HTMLInputElement).value).toBe('2026-11');
});
it('review_I2_new_url_detaches_completed_review_and_records_again_in_the_same_package', async () => {
  const f = await fixture(); await record(f);
  fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-10' } });
  await click('Проверить сценарий'); await screen.findByText(/Полнота выгрузки подтверждена\./);
  fireEvent.change(screen.getByLabelText('Адрес отчёта'), { target: { value: 'https://report.example.invalid/corrected' } });
  expect(screen.queryByRole('button', { name: 'Отменить запись' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Сохранить сценарий в черновик' })).toBeNull();
  expect(screen.queryByText(/Полнота выгрузки подтверждена\./)).toBeNull();
  await record(f);
  expect((screen.getByLabelText('Адрес отчёта') as HTMLInputElement).value).toBe('https://report.example.invalid/corrected');
  fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-11' } });
  await click('Проверить сценарий'); await screen.findByText(/Полнота выгрузки подтверждена\./);
  await click('Сохранить сценарий в черновик'); await screen.findByText('Сценарий сохранён в собственном черновике.');
  expect(f.saved).toHaveLength(1);
  expect(f.requests.filter(r => r.body?.name === 'source.browser.record.start')).toHaveLength(2);
  expect(f.requests.some(r => r.body?.name === 'source.browser.record.cancel')).toBe(false);
  const stages = f.requests.filter(r => r.body?.name === 'source.browserScenario.draft.save');
  expect(new Set(stages.map(r => (r.body?.payload as { draftId: string }).draftId)).size).toBe(1);
  expect(stages.at(-1)?.body?.payload).toMatchObject({ definition: { startUrl: 'https://report.example.invalid/corrected', parameters: { period: '2026-11' } } });
  expect(stages.at(-1)?.body?.payload).toMatchObject({ definition: { steps: expect.arrayContaining([{ action: 'goto', url: 'https://report.example.invalid/corrected' }]) } });
  expect((await screen.findByLabelText('Имя личного профиля') as HTMLInputElement).value).toBe('own');
});
it('revoked curator retains owned review while shared draft mutation is refused', async () => {
  const f = await fixture();
  await record(f); f.browserTesting!.revoke();
  fireEvent.change(screen.getByLabelText('Значение фильтра «Период»'), { target: { value: '2026-10' } });
  await click('Проверить сценарий');
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Значение фильтра «Период»')).toBeTruthy(); expect(f.saved).toEqual([]);
  expect(f.repository.readPublishedHead({ entityType: 'source_definition', id: fixtureId(12) })!.revision).toBe(2);
});
