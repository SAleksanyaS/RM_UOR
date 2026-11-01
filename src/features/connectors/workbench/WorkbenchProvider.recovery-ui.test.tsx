// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { WorkbenchProvider, useWorkbench } from './WorkbenchProvider';
import { WorkbenchBrowserScenarioWizard } from './BrowserScenarioWizard';
import { OkoClientError } from './client';

afterEach(() => { cleanup(); sessionStorage.clear(); });
function Probe({ capture }: { capture(value: ReturnType<typeof useWorkbench>): void }) { capture(useWorkbench()); return <WorkbenchBrowserScenarioWizard/>; }
const workflow = () => ({ workflowId: 'own', revision: 'r1', title: 'Отчёт', reportUrl: 'https://report.example/', marker: { selector: '#report', label: 'Отчёт' }, parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' }, profile: { configured: true, profile: null }, recording: { state: 'idle', recordingId: null, steps: [], parameterNames: ['region'], problem: null }, columns: ['ID', 'Value'], sampleRows: [], parameters: { region: 'A-private-filter' }, mapping: { rowKeyColumns: ['ID'], productKeyColumn: null, numberColumns: { value: 'Value' }, dimensionColumns: {}, dateColumn: null, unitColumn: null, fixedUnitCode: 'A-unit' }, dictionary: { columns: [], sampleRows: [], mapping: null, origin: 'none', issues: [] }, result: null, warnings: [] });

it('keeps edited mapping B unsaved after recovering lost A and only announces success after a deliberate B save', async () => {
  let view = workflow(), state!: ReturnType<typeof useWorkbench>;
  const sent: Array<{ id: string; payload: any }> = [], receipts = new Map<string, unknown>();
  const client = {
    session: async () => ({ personId: 'person-1', role: 'curator', allowedCommands: ['source.browser.record.start'] }),
    workspace: async () => ({ current: view, workflows: [view], setup: {} }),
    command: async (_name: string, payload: any, id: string) => {
      sent.push({ id, payload }); view = { ...view, revision: `r${sent.length + 1}`, mapping: payload.mapping, parameters: payload.parameters }; receipts.set(id, view);
      if (sent.length === 1) throw new OkoClientError('NETWORK_ERROR', 'Response lost');
      return view;
    },
    reconcileCommand: async (id: string) => ({ commandId: id, name: 'source.browser.mapping.save', status: 'completed', result: receipts.get(id), job: null }),
  };
  render(<WorkbenchProvider client={client as never}><Probe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Сохранить сопоставление и фильтры' }));
  save(); await screen.findByText('Response lost');
  fireEvent.change(screen.getByLabelText('Единица измерения — постоянная'), { target: { value: 'B-unit' } });
  const parameter = screen.getByDisplayValue('A-private-filter'); fireEvent.change(parameter, { target: { value: 'B-private-filter' } });
  save();
  await waitFor(() => expect(state.busy).toBe(false));
  expect(screen.queryByText(/Сопоставление и значения фильтров сохранены/)).toBeNull();
  expect(screen.getByRole('alert').textContent).toMatch(/ещё не сохранены/);
  expect((screen.getByLabelText('Единица измерения — постоянная') as HTMLInputElement).value).toBe('B-unit');
  expect((parameter as HTMLInputElement).value).toBe('B-private-filter');
  expect(sent).toHaveLength(1); expect(view.mapping.fixedUnitCode).toBe('A-unit'); expect(view.parameters.region).toBe('A-private-filter');
  expect(JSON.stringify(sessionStorage)).not.toMatch(/private-filter|A-unit|B-unit/);
  save(); await screen.findByText(/Сопоставление и значения фильтров сохранены/);
  expect(sent).toHaveLength(2); expect(sent[1].id).not.toBe(sent[0].id); expect(sent[1].payload.expectedRevision).toBe('r2');
  expect(view.mapping.fixedUnitCode).toBe('B-unit'); expect(view.parameters.region).toBe('B-private-filter');
});

it.each(['retry', 'reload'])('preserves both uncertain identities and never duplicates a release after %s', async recovery => {
  let state!: ReturnType<typeof useWorkbench>, releaseSeen = false;
  const sent: Array<{ id: string; name: string }> = [], view = workflow();
  const client = {
    session: async () => ({ personId: 'person-1', role: 'curator', allowedCommands: ['source.browser.record.start'] }),
    workspace: async () => ({ current: view, workflows: [view], setup: {} }),
    command: async (name: string, _payload: unknown, id: string) => { sent.push({ name, id }); if (name.endsWith('.cancel')) releaseSeen = true; throw new OkoClientError('NETWORK_ERROR', 'Response lost'); },
    reconcileCommand: async (id: string) => { const command = sent.find(item => item.id === id)!; return { commandId: id, name: command.name, status: command.name.endsWith('.cancel') ? 'completed' : 'pending', result: command.name.endsWith('.cancel') ? view : null, job: null }; },
  };
  const mount = () => render(<WorkbenchProvider client={client as never}><Probe capture={value => { state = value; }}/></WorkbenchProvider>);
  let mounted = mount(); await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await expect(state.run('source.browser.record.start', { workflowId: 'own' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' }); });
  await act(async () => { await expect(state.run('source.browser.record.cancel', { workflowId: 'own' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' }); });
  expect(releaseSeen).toBe(true); expect(sent).toHaveLength(2);
  const metadata = Object.values(sessionStorage).join(''); expect(metadata).toContain(sent[0].id); expect(metadata).toContain(sent[1].id);
  if (recovery === 'retry') await act(async () => { await state.run('source.browser.record.cancel', { workflowId: 'own' }); });
  else { mounted.unmount(); mounted = mount(); await waitFor(() => expect(state.error).toMatch(/ещё выполняется/)); }
  expect(sent).toHaveLength(2); expect(Object.values(sessionStorage).join('')).toContain(sent[0].id); expect(Object.values(sessionStorage).join('')).not.toContain(sent[1].id);
  expect(state.current?.workflowId).toBe('own'); mounted.unmount();
});
