// @vitest-environment jsdom
import { File as NativeFile } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createWorkbenchUiHarness } from '../../../app/workbench/testing/ui-harness';
import { WorkbenchDataPage } from './WorkbenchDataPage';
import { dataScenarioFacts, seedDataManualCorrection, setDataCaptureMode } from '../../../server/workbench/testing/data-scenarios';
import type { Capture, SourceDefinition, SourceFieldMapping } from '../../../domain/workbench/entities';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
import { useWorkbench, WorkbenchProvider } from '../../../app/workbench/context';
import { createWorkbenchApiHarness } from '../../../app/workbench/testing/api-harness';
import { render } from '@testing-library/react';
import { useEffect } from 'react';
import { WorkbenchApiError } from '../../../app/workbench/api-client';
import { definitiveDataRejection } from './data-client';

const closes: Array<() => Promise<void>> = [];
beforeEach(async () => {
  // Use the real Node multipart encoder with actual bytes, rather than jsdom's
  // incompatible FormData implementation; HTTP still traverses Fastify routes.
  const native = await new Request('http://localhost', { method: 'POST', body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } }).formData();
  vi.stubGlobal('FormData', native.constructor);
  vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor);
  configure({ asyncUtilTimeout: 5000 });
});
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
async function setup(role: 'viewer' | 'curator' = 'curator') {
  const h = await createWorkbenchUiHarness({ role, scenario: 'partial-file' }, { views: { data: WorkbenchDataPage } });
  closes.push(h.close); await h.open('/data');
  await screen.findByText('Штатный источник: файл'); return h;
}
async function preview(rows = ['A;65', 'B;70', 'C;80', 'D;bad']) {
  const csv = 'ID;Value;Start;End\n' + rows.map(s => s + ';2026-10-01;2026-11-01').join('\n');
  fireEvent.change(screen.getByLabelText('Файл данных'), { target: { files: [new NativeFile([csv], 'indicators.csv', { type: 'text/csv' })] } });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить файл' }));
  await screen.findByRole('region', { name: 'Предпросмотр импорта' });
}
async function apply() {
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать корректные строки' }));
  fireEvent.click(screen.getByRole('button', { name: 'Принять выбранные строки' }));
  await screen.findByText('Принято: 3; не принято: 1');
}
it('accepts_selected_valid_rows_and_keeps_rejections', async () => {
  const h = await setup(); await preview();
  expect(dataScenarioFacts(h.repository)).toHaveLength(0);
  expect((screen.getByRole('button', { name: 'Принять выбранные строки' }) as HTMLButtonElement).disabled).toBe(true);
  await apply();
  expect(screen.getByRole('region', { name: 'Непринятые строки' }).textContent).toContain('INVALID_NUMBER');
  expect(dataScenarioFacts(h.repository)).toHaveLength(3);
  const command = h.requests.find(r => r.body?.name === 'import.apply')!.body!;
  const receipt = await h.client.command(command as never);
  expect(receipt.data).toBeTruthy(); expect(dataScenarioFacts(h.repository)).toHaveLength(3);
  expect(h.requests.filter(r => r.body?.name === 'result.confirm')).toHaveLength(0);
  expect(h.requests.find(r => r.url === '/api/v1/files')?.body?.purpose).toBe('goal-import');
  expect(h.requests.filter(r => r.body?.name === 'import.preview')).toHaveLength(1);
  await preview(['D;90']);
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать корректные строки' }));
  fireEvent.click(screen.getByRole('button', { name: 'Принять выбранные строки' }));
  await screen.findByText('Принято: 1; не принято: 0');
  expect(dataScenarioFacts(h.repository)).toHaveLength(4);
});
it('shows_source_and_enriched_layers_without_mutating_raw', async () => {
  const h = await setup(); await preview(); await apply();
  const captureRef = h.repository.getHead<Capture>({ entityType: 'capture', id: dataScenarioFacts(h.repository)[0].captureId })!;
  const rawBefore = JSON.stringify(captureRef.rawRows);
  expect((await screen.findByRole('region', { name: 'Исходные строки' })).textContent).toContain('bad');
  fireEvent.click(screen.getByRole('button', { name: 'Обогащённые строки' }));
  const enriched = await screen.findByRole('region', { name: 'Обогащённые строки' });
  expect(enriched.textContent).toContain('2026-10-01');
  expect(enriched.textContent).toContain('2026-11-01');
  const scopeUrl = window.location.search;
  fireEvent.click(within(enriched).getAllByRole('button', { name: 'Происхождение' })[0]);
  const lineage = await screen.findByRole('region', { name: 'Происхождение данных' });
  await within(lineage).findByText(/Исходная дата \/ период:.*2026-10-01/);
  expect(window.location.search).toBe(scopeUrl);
  const query = h.requests.find(r => r.url.endsWith('/queries/data.lineage'))!;
  expect((query.body!.context as { goalId: string }).goalId).toBe(h.refs.goal.id);
  expect(JSON.stringify(h.repository.getHead<Capture>({ entityType: 'capture', id: captureRef.id })!.rawRows)).toBe(rawBefore);
});
it('preserves_manual_override_on_file_revision', async () => {
  const h = await setup(); await preview(); await apply();
  const correction = seedDataManualCorrection(h.repository);
  await preview(['A;70']);
  expect(screen.getByRole('region', { name: 'Предпросмотр импорта' }).textContent).toContain('MANUAL_CORRECTION_DISCREPANCY');
  await screen.findByText('Было: 65; станет: 70');
  const changed = screen.getByRole('checkbox', { name: /Принять изменение/ }); fireEvent.click(changed);
  fireEvent.click(screen.getByRole('button', { name: 'Принять выбранные строки' }));
  await screen.findByText('Принято: 1; не принято: 0');
  expect(h.repository.readPublishedHead({ entityType: 'manual_correction', id: correction.id })).toEqual(correction);
  expect(dataScenarioFacts(h.repository).find(f => f.factKey === correction.factKey)?.value).toBe('70');
});
it('saves_explicit_sheet_column_and_parsing_changes_as_drafts', async () => {
  const h = await setup();
  const original = h.repository.readVersion<SourceFieldMapping>(h.refs.mapping)!;
  fireEvent.click(screen.getByRole('button', { name: 'Настроить источник' }));
  const dialog = await screen.findByRole('dialog', { name: 'Настройка источника' });
  fireEvent.change(await within(dialog).findByLabelText('Лист XLSX'), { target: { value: 'Indicators' } });
  fireEvent.change(within(dialog).getByLabelText('Столбец значения demo_value'), { target: { value: 'Result' } });
  fireEvent.change(within(dialog).getByLabelText('Формат даты'), { target: { value: 'dd.mm.yyyy' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить черновик настройки' }));
  await within(dialog).findByText('Настройка сохранена в черновике. Для общего применения включите её в пакет УОР.');
  expect(h.repository.readVersion<SourceFieldMapping>(h.refs.mapping)).toEqual(original);
  const save = h.requests.find(r => r.body?.name === 'fieldMapping.draft.save')!;
  expect((save.body!.payload as { definition: SourceFieldMapping }).definition).toMatchObject({ parsingProfile: { sheetName: 'Indicators', dateFormat: 'dd.mm.yyyy' }, metricFields: [{ fields: { demo_value: 'Result' } }] });
  expect(h.requests.filter(r => r.body?.name === 'package.submit')).toHaveLength(0);
  const ownRequest = { context: { scopePath: { ditId: fixtureId(100), clusterId: null, productId: null, teamId: null }, goalId: h.refs.goal.id, time: { kind: 'period' as const, startInclusive: '2026-10-01', endExclusive: '2026-11-01' }, resultMode: 'current' as const, snapshotId: null }, filter: {}, sort: [], page: { limit: 100, cursor: null } };
  const queue = await h.client.query<{ items: Array<{ packageRef: { entityType: string; id: string } }> }>('uor.queue', ownRequest);
  expect(queue.data.items).toHaveLength(1);
  const pkg = await h.client.query<{ entries: Array<{ entityRef: { entityType: string }; complete: boolean; problems: unknown[] }> }>('uor.package', { ...ownRequest, filter: { packageRef: queue.data.items[0].packageRef } });
  expect(pkg.data.entries.map(entry => entry.entityRef.entityType).sort()).toEqual(['source_definition', 'source_field_mapping']);
  expect(pkg.data.entries.every(entry => entry.complete)).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть настройку' }));
  fireEvent.click(screen.getByRole('button', { name: 'Настроить источник' }));
  await waitFor(() => expect((screen.getByLabelText('Лист XLSX') as HTMLInputElement).value).toBe('Indicators'));
  expect((screen.getByLabelText('Столбец значения demo_value') as HTMLInputElement).value).toBe('Result');
});
it('reader_cannot_import_or_reconfigure_and_qlik_has_no_file_fallback', async () => {
  const h = await setup('viewer');
  expect(screen.queryByLabelText('Файл данных')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Настроить источник' })).toBeNull();
  const source = h.repository.readVersion<SourceDefinition>(h.refs.source)!;
  h.repository.append('source_definition', { ...source, revision: 2, kind: 'qlik' }, 1);
  await act(async () => { await h.open('/data'); });
  fireEvent.click(screen.getByRole('button', { name: 'Обновить список данных' }));
  await screen.findByText('Штатный источник: ОКО');
  expect(screen.queryByLabelText('Файл данных')).toBeNull();
  expect(screen.queryByText(/Excel при ошибке/)).toBeNull();
});
it('keeps_invalid_original_dates_distinct_from_unknown_canonical_dates', async () => {
  const h = await setup();
  const csv = 'ID;Value;Start;End\nA;65;2026-10-01;2026-11-01\nB;70;2026-10-01;2026-11-01\nC;80;2026-10-01;2026-11-01\nD;90;bad-date;2026-11-01';
  fireEvent.change(screen.getByLabelText('Файл данных'), { target: { files: [new NativeFile([csv], 'dates.csv', { type: 'text/csv' })] } });
  fireEvent.click(screen.getByRole('button', { name: 'Проверить файл' }));
  await screen.findByRole('region', { name: 'Предпросмотр импорта' }); await apply();
  expect(screen.getByRole('region', { name: 'Непринятые строки' }).textContent).toContain('INVALID_BUSINESS_DATE');
  expect((await screen.findByRole('region', { name: 'Исходные строки' })).textContent).toContain('bad-date');
  fireEvent.click(screen.getByRole('button', { name: 'Обогащённые строки' }));
  const enriched = await screen.findByRole('region', { name: 'Обогащённые строки' });
  expect(enriched.textContent).toContain('Дата неизвестна');
  expect(dataScenarioFacts(h.repository)).toHaveLength(3);
  const capture = h.repository.getHead<Capture>({ entityType: 'capture', id: dataScenarioFacts(h.repository)[0].captureId })!;
  expect(capture.rawRows.find(r => r.cells.ID.original === 'D')!.cells.Start.original).toBe('bad-date');
  expect(capture.canonicalRows.find(r => r.rowKey === '["D"]')!.businessTime).toEqual({ kind: 'unknown' });
});
it('source_setup_keeps_keyboard_focus_and_returns_it_on_escape', async () => {
  await setup();
  const opener = screen.getByRole('button', { name: 'Настроить источник' }); opener.focus(); fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Настройка источника' });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Настройка источника' })).toBeNull();
  expect(document.activeElement).toBe(opener);
});
it('reader_gets_qlik_through_capture_owner_without_file_fallback', async () => {
  const h = await setup('viewer');
  const source = h.repository.readVersion<SourceDefinition>(h.refs.source)!;
  h.repository.append('source_definition', { ...source, revision: 2, kind: 'qlik' }, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Обновить список данных' }));
  await screen.findByText('Штатный источник: ОКО');
  const capture = screen.getByRole('button', { name: 'Получить данные ОКО' });
  expect((capture as HTMLButtonElement).disabled).toBe(false); fireEvent.click(capture);
  await waitFor(() => expect(dataScenarioFacts(h.repository)).toHaveLength(4));
  await screen.findByRole('region', { name: 'Исходные строки' });
  expect(h.requests.filter(r => r.body?.name === 'source.capture')).toHaveLength(1);
  expect(h.requests.filter(r => r.body?.name === 'import.preview' || r.body?.name === 'result.confirm')).toHaveLength(0);
  expect(screen.queryByLabelText('Файл данных')).toBeNull();
});
it('explicit_retry_after_lost_apply_response_reuses_command_and_keeps_three_facts', async () => {
  const h = await setup(); await preview();
  const original = h.client.command.bind(h.client); let lost = false;
  vi.spyOn(h.client, 'command').mockImplementation(async request => {
    const response = await original(request);
    if (request.name === 'import.apply' && !lost) { lost = true; throw new TypeError('Synthetic response lost after actual server acceptance'); }
    return response;
  });
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать корректные строки' }));
  fireEvent.click(screen.getByRole('button', { name: 'Принять выбранные строки' }));
  await screen.findByText(/Результат операции неизвестен/);
  await waitFor(() => expect(dataScenarioFacts(h.repository)).toHaveLength(3));
  fireEvent.click(screen.getByRole('button', { name: 'Повторить принятие' }));
  await screen.findByText('Принято: 3; не принято: 1');
  const commands = h.requests.filter(r => r.body?.name === 'import.apply');
  expect(commands).toHaveLength(2); expect(commands[0].body).toEqual(commands[1].body);
  expect(dataScenarioFacts(h.repository)).toHaveLength(3);
});
it('opens_exact_result_lineage_from_goal_navigation_with_the_same_scope', async () => {
  const h = await setup(); await preview(); await apply();
  const prepared = await h.client.command<{ commandId: string; result: { resultRef: { entityType: string; id: string; revision: number } }; changedRefs: []; editToken: null }>({ commandId: crypto.randomUUID(), name: 'calculation.prepare', baseRevision: null, payload: { assignmentRef: h.refs.assignment, businessTime: { kind: 'period', startInclusive: '2026-10-01', endExclusive: '2026-11-01' } } });
  if ('jobId' in prepared.data) throw Error('Calculation preparation must be synchronous');
  const reference = prepared.data.result.resultRef;
  const before = new URLSearchParams(window.location.search);
  await h.open('/data' + window.location.search + '&result=' + reference.id + '&resultRevision=' + reference.revision);
  const lineage = await screen.findByRole('region', { name: 'Происхождение данных' });
  await within(lineage).findByText(/Методика:/);
  const query = h.requests.filter(r => r.url.endsWith('/queries/data.lineage')).at(-1)!;
  expect(query.body?.filter).toEqual({ resultRef: reference });
  expect((query.body!.context as { scopePath: { ditId: string }; goalId: string }).scopePath.ditId).toBe(before.get('dit'));
  expect((query.body!.context as { goalId: string }).goalId).toBe(h.refs.goal.id);
});

it('review_422_can_be_corrected_without_losing_other_edits_or_splitting_package', async () => {
  const h = await setup(); fireEvent.click(screen.getByRole('button', { name: 'Настроить источник' }));
  const column = await screen.findByLabelText('Столбец значения demo_value');
  fireEvent.change(screen.getByLabelText('Лист XLSX'), { target: { value: 'KeepSheet' } });
  fireEvent.change(column, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик настройки' }));
  await screen.findByRole('alert');
  expect(column.matches(':disabled')).toBe(false);
  expect(screen.getByRole('alert').textContent).toContain('metricFields');
  fireEvent.change(column, { target: { value: 'CorrectedColumn' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик настройки' }));
  await screen.findByText('Настройка сохранена в черновике. Для общего применения включите её в пакет УОР.');
  const writes = h.requests.filter(r => r.body?.name === 'fieldMapping.draft.save');
  expect(writes).toHaveLength(2); expect(writes[0].body?.commandId).not.toBe(writes[1].body?.commandId);
  expect((writes[1].body!.payload as { definition: SourceFieldMapping }).definition.parsingProfile?.sheetName).toBe('KeepSheet');
  expect(h.repository.sqlForModule('drafts').all('SELECT package_id FROM wb_drafts_packages')).toHaveLength(1);
});

it('review_partial_mapping_reopens_then_completes_without_inventing_omitted_fields', async () => {
  const h = await setup();
  const opened = await h.client.command<any>({ commandId: crypto.randomUUID(), name: 'draft.open', baseRevision: null, payload: { entityType: 'source_field_mapping', ref: { entityType: h.refs.mapping.entityType, id: h.refs.mapping.id }, packageId: null } });
  if ('jobId' in opened.data) throw Error('Expected draft receipt');
  await h.client.command({ commandId: crypto.randomUUID(), name: 'fieldMapping.draft.save', baseRevision: opened.data.result.editToken, payload: { draftId: opened.data.result.draftId, definition: { sourceId: h.refs.source.id, productKeyField: 'ID', metricFields: [{}] } } });
  fireEvent.click(screen.getByRole('button', { name: 'Настроить источник' }));
  const key = await screen.findByLabelText('Столбцы ключа строки (через запятую)');
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик настройки' }));
  await screen.findByText('Черновик неполный. Проверьте обязательные поля в панели УОР.');
  const savedPartial = h.requests.filter(r => r.body?.name === 'fieldMapping.draft.save').at(-1)!;
  const definition = (savedPartial.body!.payload as { definition: Record<string, unknown> }).definition;
  expect(definition).not.toHaveProperty('dimensionFields'); expect(definition).not.toHaveProperty('rowKeyFields');
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройку' })); fireEvent.click(screen.getByRole('button', { name: 'Настроить источник' }));
  fireEvent.change(await screen.findByLabelText('Столбцы ключа строки (через запятую)'), { target: { value: 'ID' } });
  fireEvent.change(screen.getByLabelText('Столбец значения demo_value'), { target: { value: 'Value' } });
  fireEvent.click(screen.getByRole('button', { name: 'Оставить необязательные соответствия пустыми' }));
  fireEvent.click(screen.getByRole('button', { name: 'Задать профиль ISO / UTF-8' }));
  fireEvent.change(screen.getByLabelText('Фиксированная единица'), { target: { value: 'demo_unit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик настройки' }));
  await screen.findByText('Настройка сохранена в черновике. Для общего применения включите её в пакет УОР.');
  expect(screen.queryByText('Черновик неполный. Проверьте обязательные поля в панели УОР.')).toBeNull();
  expect(h.repository.sqlForModule('drafts').all('SELECT package_id FROM wb_drafts_packages')).toHaveLength(1);
  void key;
});

function ReviewRefreshData() {
  const { refreshSession } = useWorkbench();
  useEffect(() => { const refresh = () => { void refreshSession(); }; window.addEventListener('t34-review-refresh', refresh); return () => window.removeEventListener('t34-review-refresh', refresh); }, [refreshSession]);
  return <WorkbenchDataPage />;
}
it('review_same_owner_refresh_preserves_dirty_mapping_parsing_and_focus_and_blocks_save', async () => {
  const h = await createWorkbenchUiHarness({ role: 'curator', scenario: 'partial-file' }, { views: { data: ReviewRefreshData } }); closes.push(h.close); await h.open('/data');
  fireEvent.click(await screen.findByRole('button', { name: 'Настроить источник' }));
  const column = await screen.findByLabelText('Столбец значения demo_value');
  fireEvent.change(column, { target: { value: 'KeepDirty' } }); fireEvent.change(screen.getByLabelText('Лист XLSX'), { target: { value: 'KeepSheet' } }); column.focus();
  let finish!: () => void; const held = new Promise<void>(resolve => { finish = resolve; }); const session = h.client.session.bind(h.client);
  vi.spyOn(h.client, 'session').mockImplementationOnce(async () => { await held; return session(); });
  act(() => window.dispatchEvent(new Event('t34-review-refresh')));
  expect(screen.getByRole('dialog', { name: 'Настройка источника' })).toBeTruthy();
  expect((screen.getByLabelText('Столбец значения demo_value') as HTMLInputElement).value).toBe('KeepDirty');
  expect(document.activeElement).toBe(column);
  expect((screen.getByRole('button', { name: 'Сохранить черновик настройки' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { finish(); await held; });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Сохранить черновик настройки' }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Лист XLSX') as HTMLInputElement).value).toBe('KeepSheet'); expect(document.activeElement).toBe(column);
});
it('review_actual_client_owner_change_isolates_the_dirty_editor', async () => {
  const first = await createWorkbenchApiHarness({ role: 'curator', scenario: 'partial-file' }); const second = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'partial-file' }); closes.push(first.close, second.close);
  window.history.replaceState(null, '', '/data');
  const view = render(<WorkbenchProvider client={first.client}><WorkbenchDataPage /></WorkbenchProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Настроить источник' }));
  fireEvent.change(await screen.findByLabelText('Столбец значения demo_value'), { target: { value: 'ForeignDirty' } });
  view.rerender(<WorkbenchProvider client={second.client}><WorkbenchDataPage /></WorkbenchProvider>);
  await screen.findByText('Штатный источник: файл');
  expect(screen.queryByRole('dialog', { name: 'Настройка источника' })).toBeNull(); expect(screen.queryByDisplayValue('ForeignDirty')).toBeNull();
});
it('review_historical_lineage_displays_only_matching_original_cells_from_its_exact_capture', async () => {
  const h = await setup(); await preview(); await apply();
  const old = dataScenarioFacts(h.repository).find(fact => fact.scope.id === fixtureId(101))!;
  await preview(['A;999']); fireEvent.click(await screen.findByRole('checkbox', { name: /Принять изменение/ })); fireEvent.click(screen.getByRole('button', { name: 'Принять выбранные строки' })); await screen.findByText('Принято: 1; не принято: 0');
  await h.open('/data' + window.location.search + '&fact=' + old.id + '&factRevision=' + old.revision);
  const evidence = await screen.findByRole('region', { name: 'Исходные строки основания' });
  expect(evidence.textContent).toContain('Value: 65'); expect(evidence.textContent).not.toContain('Value: 999'); expect(evidence.textContent).not.toContain('ID: B');
});
async function reviewQlikSetup() {
  const h = await setup('viewer'); const source = h.repository.readVersion<SourceDefinition>(h.refs.source)!;
  h.repository.append('source_definition', { ...source, revision: 2, kind: 'qlik' }, 1);
  fireEvent.click(screen.getByRole('button', { name: 'Обновить список данных' })); await screen.findByText('Штатный источник: ОКО'); return h;
}
it('review_confirmed_failed_capture_allows_explicit_new_acquisition_with_last_good_data_intact', async () => {
  const h = await reviewQlikSetup(); fireEvent.click(screen.getByRole('button', { name: 'Получить данные ОКО' })); await screen.findByRole('region', { name: 'Исходные строки' });
  const before = dataScenarioFacts(h.repository).map(fact => fact.captureId);
  setDataCaptureMode(h.repository, 'failed'); fireEvent.click(screen.getByRole('button', { name: 'Получить данные ОКО' })); await screen.findByText(/SYNTHETIC_SOURCE_UNAVAILABLE/);
  expect(dataScenarioFacts(h.repository).map(fact => fact.captureId)).toEqual(before);
  setDataCaptureMode(h.repository, 'ready'); fireEvent.click(screen.getByRole('button', { name: 'Начать новое получение ОКО' }));
  await waitFor(() => expect(h.requests.filter(r => r.body?.name === 'source.capture')).toHaveLength(3));
  await waitFor(() => expect(new Set(dataScenarioFacts(h.repository).map(fact => fact.captureId)).size).toBe(2));
  const captures = h.requests.filter(r => r.body?.name === 'source.capture'); expect(captures[1].body?.commandId).not.toBe(captures[2].body?.commandId);
});
it('review_waiting_capture_exposes_only_server_permitted_auth_and_cancel_controls', async () => {
  const h = await reviewQlikSetup(); fireEvent.click(screen.getByRole('button', { name: 'Получить данные ОКО' })); await screen.findByRole('region', { name: 'Исходные строки' });
  const before = dataScenarioFacts(h.repository).map(fact => fact.captureId);
  setDataCaptureMode(h.repository, 'waiting'); fireEvent.click(screen.getByRole('button', { name: 'Получить данные ОКО' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Открыть личный вход' }));
  await waitFor(() => expect(h.requests.some(r => r.body?.name === 'job.openAuth')).toBe(true));
  const captureCommand = h.requests.filter(request => request.body?.name === 'source.capture').at(-1)!.body!.commandId as string;
  const pending = h.repository.sqlForModule('jobs').get<{ job_id: string }>('SELECT job_id FROM wb_jobs_heads WHERE command_id=?', [captureCommand])!;
  const actual = await h.client.job(pending.job_id);
  expect(Boolean(screen.queryByRole('button', { name: 'Продолжить получение' }))).toBe(actual.data.retryAvailable);
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить получение' }));
  await screen.findByRole('button', { name: 'Начать новое получение ОКО' });
  expect(dataScenarioFacts(h.repository).map(fact => fact.captureId)).toEqual(before);
});
it('review_unknown_mapping_save_retains_its_exact_request_and_completed_drafts', async () => {
  const h = await setup(); fireEvent.click(screen.getByRole('button', { name: 'Настроить источник' }));
  fireEvent.change(await screen.findByLabelText('Лист XLSX'), { target: { value: 'UnknownSheet' } });
  const original = h.client.command.bind(h.client); let lost = false;
  vi.spyOn(h.client, 'command').mockImplementation(async request => { const response = await original(request); if (request.name === 'fieldMapping.draft.save' && !lost) { lost = true; throw new TypeError('Actual saved receipt response lost'); } return response; });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик настройки' })); await screen.findByText(/Результат операции неизвестен/);
  expect(screen.getByLabelText('Лист XLSX').matches(':disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Повторить сохранение настройки' })); await screen.findByText('Настройка сохранена в черновике. Для общего применения включите её в пакет УОР.');
  const writes = h.requests.filter(r => r.body?.name === 'fieldMapping.draft.save'); expect(writes).toHaveLength(2); expect(writes[0].body).toEqual(writes[1].body);
  expect(h.repository.sqlForModule('drafts').all('SELECT package_id FROM wb_drafts_packages')).toHaveLength(1);
});
it('review_unknown_capture_observes_the_original_command_instead_of_starting_another', async () => {
  const h = await reviewQlikSetup(); const original = h.client.command.bind(h.client); let lost = false;
  vi.spyOn(h.client, 'command').mockImplementation(async request => { const response = await original(request); if (request.name === 'source.capture' && !lost) { lost = true; throw new TypeError('Actual accepted capture response lost'); } return response; });
  fireEvent.click(screen.getByRole('button', { name: 'Получить данные ОКО' }));
  await waitFor(() => expect(h.requests.filter(request => request.body?.name === 'source.capture')).toHaveLength(1));
  await screen.findByText(/Результат операции неизвестен/);
  expect(screen.queryByRole('button', { name: 'Начать новое получение ОКО' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Проверить прежнее получение ОКО' })); await screen.findByRole('region', { name: 'Исходные строки' });
  const writes = h.requests.filter(r => r.body?.name === 'source.capture'); expect(writes).toHaveLength(2); expect(writes[0].body).toEqual(writes[1].body);
  expect(new Set(dataScenarioFacts(h.repository).map(fact => fact.captureId)).size).toBe(1);
});
it('review_same_owner_data_query_refresh_does_not_discard_the_editor', async () => {
  await setup(); fireEvent.click(screen.getByRole('button', { name: 'Настроить источник' }));
  const column = await screen.findByLabelText('Столбец значения demo_value'); fireEvent.change(column, { target: { value: 'KeepOnQueryRefresh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Обновить список данных' }));
  expect(screen.getByRole('dialog', { name: 'Настройка источника' })).toBeTruthy();
  expect((screen.getByLabelText('Столбец значения demo_value') as HTMLInputElement).value).toBe('KeepOnQueryRefresh');
});
it('review_interrupted_command_response_keeps_the_unknown_operation_identity', () => {
  const problem = { code: 'COMMAND_INTERRUPTED', message: 'Previous command requires reconciliation', retryable: false, details: [], operationId: null, provider: null };
  expect(definitiveDataRejection(new WorkbenchApiError(problem, 409, null))).toBe(false);
  expect(definitiveDataRejection(new WorkbenchApiError({ ...problem, code: 'VALIDATION_FAILED' }, 422, null))).toBe(true);
});

it('source setup protects changed mapping on close and stops warning after a confirmed save', async () => {
  await setup(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Настроить источник' }));
  const dialog = await screen.findByRole('dialog', { name: 'Настройка источника' });
  fireEvent.change(await within(dialog).findByLabelText('Лист XLSX'), { target: { value: 'Согласованный лист' } });
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect((within(dialog).getByLabelText('Лист XLSX') as HTMLInputElement).value).toBe('Согласованный лист');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить черновик настройки' }));
  await within(dialog).findByText('Настройка сохранена в черновике. Для общего применения включите её в пакет УОР.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть настройку' }));
  expect(screen.queryByRole('dialog', { name: 'Настройка источника' })).toBeNull();
  expect(confirm).toHaveBeenCalledTimes(1);
});
