// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { SessionView } from '../../../server/workbench/protocol';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
import { okoWorkflowViewSchema, okoWorkspaceViewSchema, type OkoWorkflowView } from '../workbench-workflow-contracts';
import { OkoClient } from './client';
import { PersonalOkoWorkspace } from './PersonalOkoWorkspace';

afterEach(() => { cleanup(); sessionStorage.clear(); });

function workflow(): OkoWorkflowView {
  return okoWorkflowViewSchema.parse({
    workflowId: fixtureId(8101), sourceId: fixtureId(8102), revision: 'recipe:1', title: 'Личный отчёт', reportUrl: 'https://example.invalid/report', marker: null,
    parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' },
    profile: { sourceId: fixtureId(8102), profileId: null, profile: null, revision: null, configured: false, sessionState: 'closed' },
    recording: { recordingId: null, state: 'idle', steps: [], parameterNames: [], problem: null },
    columns: ['Текущий столбец'], sampleRows: [{ 'Текущий столбец': 'Новая выгрузка' }], parameters: {}, mapping: null,
    dictionary: { columns: [], sampleRows: [], mapping: null, origin: 'none', issues: [] }, warnings: [],
    result: {
      resultId: fixtureId(8103), rowCount: 1, unresolvedRows: 1,
      issues: [{ code: 'UNMAPPED_PRODUCT', path: '/canonicalRows/0', message: 'UNMAPPED_PRODUCT', ref: null }],
      previewRows: [{ 'Ключ продукта': 'P-404', 'Сумма': '12345678901234567890.001', 'directory.productLeaderName': 'Значение только из исходного файла' }],
      originalDownload: '/api/v1/oko/results/original', enrichedDownload: '/api/v1/oko/results/enriched', capturedAt: '2026-11-01T06:30:00Z', sourceDate: '2026-11-01',
    },
  });
}

/** Only the HTTP boundary is synthetic; the client, provider and rendered views are real. */
function mount(current: OkoWorkflowView) {
  const session: SessionView = { role: 'viewer', displayName: 'Читатель', personId: fixtureId(8104), policyState: 'local_preview', checkedAt: '2026-11-01T09:00:00Z', allowedCommands: [], csrfToken: 'synthetic-token', defaultContext: null };
  let value = current;
  const client = new OkoClient(async input => {
    if (String(input) === '/api/v1/session') return Response.json({ data: session });
    if (String(input) === '/api/v1/queries/oko.workflow.workspace') {
      const data = okoWorkspaceViewSchema.parse({ workflows: [{ workflowId: value.workflowId, title: value.title, revision: value.revision }], current: value, setup: { hostname: 'synthetic', registryConfigured: true, message: null } });
      return Response.json({ data });
    }
    throw Error('Unexpected request in presentation test: ' + String(input));
  }, { prefix: 'oko.workflow' });
  const view = render(<PersonalOkoWorkspace client={client} refreshKey="recipe:1" />);
  return { replaceRecipe(next: OkoWorkflowView) { value = next; view.rerender(<PersonalOkoWorkspace client={client} refreshKey={next.revision} />); } };
}

it('does not label a raw reserved header as an enriched leader and keeps the saved result after recipe changes', async () => {
  const original = workflow(), view = mount(original);
  const panel = await screen.findByRole('tabpanel', { name: /Данные/ });
  expect(within(panel).queryByRole('columnheader', { name: 'Руководитель продукта' })).toBeNull();
  expect(within(panel).getByRole('columnheader', { name: 'Ключ продукта' })).toBeTruthy();
  expect(within(panel).getByText('12345678901234567890.001')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Все столбцы' }));
  expect(within(panel).getByRole('columnheader', { name: 'directory.productLeaderName' })).toBeTruthy();
  expect(within(panel).getByText('Значение только из исходного файла')).toBeTruthy();

  view.replaceRecipe({ ...original, revision: 'recipe:2', title: 'Сценарий после изменения', columns: ['Новое имя'], sampleRows: [{ 'Новое имя': 'Новый источник' }] });
  await screen.findByRole('heading', { name: 'Сценарий после изменения' });
  expect(within(panel).getByRole('columnheader', { name: 'directory.productLeaderName' })).toBeTruthy();
  expect(within(panel).queryByRole('columnheader', { name: 'Новое имя' })).toBeNull();
  expect(within(panel).getByText('12345678901234567890.001')).toBeTruthy();
  expect((screen.getByRole('link', { name: 'Скачать исходный файл' }) as HTMLAnchorElement).getAttribute('href')).toBe(original.result!.originalDownload);
});

it('keeps colliding raw and escaped derived values separate in all columns', async () => {
  const value = workflow();
  value.result!.previewRows[0]['derived.directory.productLeaderName'] = 'Руководитель из сохранённого справочника';
  value.result!.previewRows[0]['number.value'] = null;
  mount(value);
  await screen.findByRole('tabpanel', { name: /Данные/ });
  fireEvent.click(screen.getByRole('button', { name: 'Все столбцы' }));
  const table = screen.getByRole('table', { name: /^Результат обогащения/ });
  expect(within(table).getByRole('columnheader', { name: 'directory.productLeaderName' })).toBeTruthy();
  expect(within(table).getByRole('columnheader', { name: 'derived.directory.productLeaderName' })).toBeTruthy();
  expect(within(table).getByText('Значение только из исходного файла')).toBeTruthy();
  expect(within(table).getByText('Руководитель из сохранённого справочника')).toBeTruthy();
  expect(within(table).getByText('12345678901234567890.001')).toBeTruthy();
  expect(within(table).queryByText('0')).toBeNull();
});

it('gives an action for UNMAPPED_PRODUCT while retaining unknown messages and technical evidence', async () => {
  const value = workflow();
  value.result!.issues.push({ code: 'NEW_SOURCE_PROBLEM', path: '/rows/0/Amount', message: 'Источник сообщил о дополнительном ограничении', ref: null });
  mount(value);
  fireEvent.click(await screen.findByRole('tab', { name: /Замечания/ }));
  const panel = screen.getByRole('tabpanel', { name: /Замечания/ });
  const items = within(panel).getAllByRole('listitem');
  expect(items[0].querySelector('strong')?.textContent).toMatch(/Продукт.*не найден.*справочник/);
  expect(items[0].textContent).toMatch(/Проверьте.*ключ.*продукта/);
  const evidence = items[0].querySelector('details');
  expect(evidence?.open).toBe(false);
  expect(evidence?.textContent).toContain('UNMAPPED_PRODUCT');
  expect(evidence?.textContent).toContain('/canonicalRows/0');
  expect(items[1].querySelector('strong')?.textContent).toBe('Источник сообщил о дополнительном ограничении');
  expect(items[1].querySelector('details')?.textContent).toContain('NEW_SOURCE_PROBLEM');
  fireEvent.click(within(panel).getByRole('button', { name: 'Открыть сопоставление и справочник' }));
  await waitFor(() => expect(document.getElementById('wb-personal-settings')?.hidden).toBe(false));
});
