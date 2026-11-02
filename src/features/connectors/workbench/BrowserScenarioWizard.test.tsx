// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchBrowserScenarioWizard } from './BrowserScenarioWizard';
const ctx = vi.hoisted(() => ({ current: null as any, session: { role: 'curator', allowedCommands: ['source.browser.record.start'] }, busy: false, job: null, run: vi.fn(), client: { upload: vi.fn() } }));
vi.mock('./WorkbenchProvider', () => ({ useWorkbench: () => ctx }));
afterEach(() => { cleanup(); ctx.run.mockReset(); sessionStorage.clear(); ctx.busy = false; ctx.session.allowedCommands = ['source.browser.record.start']; });
const workflow = () => ({ workflowId: 'own', revision: 'r1', title: 'Отчёт', reportUrl: 'https://oko.example/report', marker: { selector: '#report', label: 'Отчёт' }, parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' }, profile: { configured: true, profile: null }, recording: { state: 'idle', recordingId: null, steps: [], parameterNames: [], problem: null }, columns: ['ID', 'Значение'], sampleRows: [], parameters: {}, mapping: null, dictionary: { columns: [], sampleRows: [], mapping: null, origin: 'none', issues: [] }, result: null, warnings: [] });
it('explicitly selects the recorded export click with its revision and requires a separate replay check', async () => {
  ctx.current = { ...workflow(), recording: { ...workflow().recording, state: 'completed', replayable: false, replayabilityProblem: 'EXPORT_ACTION_NOT_RECORDED', steps: [{ action: 'goto', url: 'https://oko.example/report' }, { action: 'click', locator: { kind: 'role', role: 'button', name: 'Экспорт', exact: true } }] } };
  ctx.run.mockResolvedValue(null);
  const view = render(<WorkbenchBrowserScenarioWizard/>);
  expect(ctx.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Выбрать шаг 2 для выгрузки' }));
  await waitFor(() => expect(ctx.run).toHaveBeenCalledWith('source.browser.export.action.set', { workflowId: 'own', expectedRevision: 'r1', stepIndex: 1 }));
  expect(ctx.run.mock.calls.some(call => call[0] === 'source.browser.record.test')).toBe(false);
  ctx.current = { ...ctx.current, recording: { ...ctx.current.recording, replayabilityProblem: 'EXPORT_ACTION_NEEDS_TEST' } };
  view.rerender(<WorkbenchBrowserScenarioWizard/>);
  expect(screen.getByText(/До успешного получения файла сценарий остаётся непроверенным/)).toBeTruthy();
});
it.each([false,true])('reading an existing recording never auto-submits a finish command (saved=%s)',async(saved)=>{
  ctx.session.role='viewer';ctx.run.mockResolvedValue(null);
  ctx.current={...workflow(),recording:{...workflow().recording,state:'completed',recordingId:'another-tab-recording',steps:saved?[{action:'download',locator:{kind:'css',selector:'#export'}}]:[]}};
  const {rerender}=render(<WorkbenchBrowserScenarioWizard/>);
  await screen.findByText(saved ? 'Запись завершена. Шаги и образец файла получены.' : 'Скачивание завершено. Нажмите «Получить записанные шаги», чтобы принять шаги и столбцы файла.');
  rerender(<WorkbenchBrowserScenarioWizard/>);
  expect(ctx.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Получить записанные шаги'}));
  await waitFor(()=>expect(ctx.run).toHaveBeenCalledWith('source.browser.record.finish',{workflowId:'own',recordingId:'another-tab-recording'}));
});
it('viewer sees own login and result, while preparation controls stay hidden', () => {
  ctx.current = workflow(); ctx.session.role = 'viewer'; ctx.session.allowedCommands = []; render(<WorkbenchBrowserScenarioWizard />);
  expect(screen.getByRole('button', { name: 'Открыть браузер для входа' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Начать запись действий' })).toBeNull();
  expect(screen.queryByText('Сопоставление столбцов')).toBeNull();
  expect(screen.queryByLabelText(/CSS|JSON/i)).toBeNull();
});
// The window must not be closed by UI automation: an automatic `finish` raced the download and
// discarded the file, so the user is the only one who asks for the recorded steps.
it('never finishes a completed download on its own and keeps the recording window open', async () => {
  ctx.session.role = 'curator'; ctx.current = workflow(); ctx.run.mockResolvedValue(null);
  const { rerender } = render(<WorkbenchBrowserScenarioWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Начать запись действий' }));
  ctx.current = { ...ctx.current, recording: { ...ctx.current.recording, state: 'completed', recordingId: 'record-1' } };
  rerender(<WorkbenchBrowserScenarioWizard />);
  rerender(<WorkbenchBrowserScenarioWizard />);
  expect(ctx.run.mock.calls.filter(call => call[0] === 'source.browser.record.finish')).toHaveLength(0);
  expect(screen.getByText(/Скачивание завершено\. Нажмите «Получить записанные шаги»/)).toBeTruthy();
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
