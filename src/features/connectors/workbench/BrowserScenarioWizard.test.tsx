// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchBrowserScenarioWizard } from './BrowserScenarioWizard';
const ctx = vi.hoisted(() => ({ current: null as any, session: { role: 'curator', allowedCommands: ['source.browser.record.start'] }, busy: false, job: null, run: vi.fn(), client: { upload: vi.fn() } }));
vi.mock('./WorkbenchProvider', () => ({ useWorkbench: () => ctx }));
afterEach(() => { cleanup(); ctx.run.mockReset(); sessionStorage.clear(); });
const workflow = () => ({ workflowId: 'own', revision: 'r1', title: 'Отчёт', reportUrl: 'https://oko.example/report', marker: { selector: '#report', label: 'Отчёт' }, parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' }, profile: { configured: true, profile: null }, recording: { state: 'idle', recordingId: null, steps: [], parameterNames: [], problem: null }, columns: ['ID', 'Значение'], sampleRows: [], parameters: {}, mapping: null, dictionary: { columns: [], sampleRows: [], mapping: null, origin: 'none', issues: [] }, result: null, warnings: [] });
it('viewer sees own login and result, while preparation controls stay hidden', () => {
  ctx.current = workflow(); ctx.session.role = 'viewer'; render(<WorkbenchBrowserScenarioWizard />);
  expect(screen.getByRole('button', { name: 'Открыть браузер для входа' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Начать запись действий' })).toBeNull();
  expect(screen.queryByText('Сопоставление столбцов')).toBeNull();
  expect(screen.queryByLabelText(/CSS|JSON/i)).toBeNull();
});
it('auto-finishes completed download once and retains unfinished form through status refresh', async () => {
  ctx.session.role = 'curator'; ctx.current = workflow(); ctx.run.mockResolvedValue(null);
  const { rerender } = render(<WorkbenchBrowserScenarioWizard />);
  fireEvent.change(screen.getByLabelText('Адрес отчёта'), { target: { value: 'https://oko.example/changed' } });
  ctx.current = { ...ctx.current, recording: { ...ctx.current.recording, state: 'completed', recordingId: 'record-1' } }; rerender(<WorkbenchBrowserScenarioWizard />);
  await waitFor(() => expect(ctx.run).toHaveBeenCalledWith('source.browser.record.finish', { workflowId: 'own', recordingId: 'record-1' }));
  rerender(<WorkbenchBrowserScenarioWizard />);
  expect(ctx.run).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText('Адрес отчёта') as HTMLInputElement).value).toBe('https://oko.example/changed');
});
it('saves explicit mapping with the selected unit column taking precedence over an earlier constant', async () => {
  ctx.session.role = 'curator'; ctx.current = workflow(); ctx.run.mockResolvedValue(null);
  render(<WorkbenchBrowserScenarioWizard />);
  fireEvent.click(screen.getByLabelText('ID'));
  fireEvent.change(screen.getByLabelText('Столбец «value»'), { target: { value: 'Значение' } });
  fireEvent.change(screen.getByLabelText('Единица измерения — постоянная'), { target: { value: 'шт' } });
  fireEvent.change(screen.getByLabelText('Единица измерения — столбец'), { target: { value: 'ID' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить сопоставление и фильтры' }));
  await waitFor(() => expect(ctx.run).toHaveBeenCalledWith('source.browser.mapping.save', expect.objectContaining({ workflowId: 'own', expectedRevision: 'r1', mapping: expect.objectContaining({ rowKeyColumns: ['ID'], numberColumns: { value: 'Значение' }, unitColumn: 'ID', fixedUnitCode: null }) })));
});
it('keeps own browser recovery reachable after reloading without a remembered login handle', async () => {
  ctx.session.role = 'viewer'; ctx.current = workflow(); ctx.run.mockResolvedValue(null);
  render(<WorkbenchBrowserScenarioWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть окна браузера и освободить профиль' }));
  await waitFor(() => expect(ctx.run).toHaveBeenCalledWith('source.browser.record.cancel', { workflowId: 'own' }));
});
it('restores the own login handle after switching away and back, and clears it after closing', async () => {
  ctx.session.role = 'viewer'; ctx.current = workflow(); ctx.run.mockResolvedValue({ loginId: 'login-1', windowOpened: true });
  const first = render(<WorkbenchBrowserScenarioWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Открыть браузер для входа' }));
  await screen.findByRole('button', { name: 'Завершить ручной вход' }); first.unmount();
  render(<WorkbenchBrowserScenarioWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Завершить ручной вход' }));
  await waitFor(() => expect(ctx.run).toHaveBeenCalledWith('source.browser.login.finish', { workflowId: 'own', loginId: 'login-1' }));
});
