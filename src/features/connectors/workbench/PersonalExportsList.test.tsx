// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { SessionView } from '../../../server/workbench/protocol';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
import { okoExportsViewSchema, type OkoExport, type OkoExportsView } from '../workbench-workflow-contracts';
import { OkoClient } from './client';
import { PersonalExportsList } from './PersonalExportsList';
import { WorkbenchProvider } from './WorkbenchProvider';

afterEach(() => { cleanup(); sessionStorage.clear(); });

const exported = (index: number, overrides: Partial<OkoExport> = {}): OkoExport => ({
  exportId: fixtureId(9100 + index), workflowId: fixtureId(9200), title: 'Продажи за неделю',
  fileName: `ОКО_Продажи за неделю_2026-10-2${index}_10-00.csv`, mimeType: 'text/csv', bytes: 2048 * index,
  sha256: 'a'.repeat(64), capturedAt: `2026-10-2${index}T10:00:00Z`, sourceDate: null, rowCount: index * 7,
  origin: 'record', downloadUrl: '/api/v1/browser/exports/' + fixtureId(9100 + index), ...overrides,
});

/** Only the HTTP boundary is synthetic; the client, provider and rendered list are real. */
function mount(initial: OkoExportsView, options: { canHide?: boolean } = {}) {
  const state: { value: OkoExportsView } = { value: initial }, commands: string[] = [];
  const session: SessionView = {
    role: 'viewer', displayName: 'Читатель', personId: fixtureId(9300), policyState: 'local_preview', checkedAt: '2026-11-01T09:00:00Z',
    allowedCommands: options.canHide === false ? [] : ['source.browser.export.delete'], csrfToken: 'synthetic-token', defaultContext: null,
  };
  const client = new OkoClient(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/session')) return Response.json({ data: session });
    if (path.includes('/queries/source.browser.workspace')) return Response.json({ data: { workflows: [], current: null, setup: { hostname: 'synthetic', registryConfigured: true, message: null } } });
    if (path.includes('/queries/source.browser.exports')) return Response.json({ data: okoExportsViewSchema.parse(state.value) });
    if (path.endsWith('/commands') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { commandId: string; name: string; payload: { exportId?: string } };
      commands.push(body.name);
      // The server hides the row; the client then re-reads the list from the same boundary.
      state.value = okoExportsViewSchema.parse({ items: state.value.items.filter(item => item.exportId !== body.payload.exportId), hiddenCount: state.value.hiddenCount + 1 });
      return Response.json({ data: { commandId: body.commandId, result: { hidden: true }, changedRefs: [], editToken: null } });
    }
    throw Error('Unexpected request in exports list test: ' + path);
  }, { prefix: 'source.browser' });
  // The provider owns the confirmation marker, so the list is mounted through it.
  render(<WorkbenchProvider client={client}><PersonalExportsList /></WorkbenchProvider>);
  return { state, commands };
}

it('confirms the saved file once and lists every own export with a readable name and date', async () => {
  const { state } = mount({ items: [exported(2), exported(1)], hiddenCount: 0 });
  const confirmation = await screen.findByText('Файл сохранён');
  expect(confirmation.closest('[role="status"]')?.textContent).toContain('ОКО_Продажи за неделю_2026-10-22_10-00.csv');
  const table = await screen.findByRole('table', { name: 'Сохранённые файлы выгрузок' });
  expect(within(table).getByRole('columnheader', { name: 'Отчёт' })).toBeTruthy();
  expect(within(table).getAllByRole('link').map(link => link.textContent)).toEqual(['ОКО_Продажи за неделю_2026-10-22_10-00.csv', 'ОКО_Продажи за неделю_2026-10-21_10-00.csv']);
  expect(within(table).getByRole('link', { name: 'ОКО_Продажи за неделю_2026-10-22_10-00.csv' }).getAttribute('download')).toBe('ОКО_Продажи за неделю_2026-10-22_10-00.csv');
  expect(within(table).getAllByRole('row')).toHaveLength(3);
  // The newest file is already confirmed, so a re-render must not repeat the marker after a reload of the same list.
  state.value = okoExportsViewSchema.parse({ items: [exported(2), exported(1)], hiddenCount: 0 });
  await waitFor(() => expect(screen.getAllByText('Файл сохранён')).toHaveLength(1));
});

it('hides a row through the soft-delete command and reports how many files stay hidden', async () => {
  const { commands } = mount({ items: [exported(2), exported(1)], hiddenCount: 0 });
  const table = await screen.findByRole('table', { name: 'Сохранённые файлы выгрузок' });
  fireEvent.click(within(table).getAllByRole('button', { name: 'Скрыть' })[1]);
  // The hidden row leaves the list, but the stored bytes and the hidden counter stay visible.
  await waitFor(() => expect(commands).toEqual(['source.browser.export.delete']));
  await waitFor(() => expect(screen.getByText(/Скрытых файлов: 1\. Файлы не удалены и остаются на компьютере\./)).toBeTruthy());
  const rows = within(screen.getByRole('table', { name: 'Сохранённые файлы выгрузок' })).getAllByRole('row');
  expect(rows).toHaveLength(2);
  expect(rows[1].textContent).toContain('ОКО_Продажи за неделю_2026-10-22_10-00.csv');
});

it('offers no hide action without the own write capability and explains an empty list', async () => {
  mount({ items: [], hiddenCount: 0 }, { canHide: false });
  expect(await screen.findByRole('heading', { name: 'Здесь появятся ваши выгрузки' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Скрыть' })).toBeNull();
  expect(screen.getByText('Пока пусто')).toBeTruthy();
});
