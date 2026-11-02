// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createPersonalRuntime } from '../../../../tests/fixtures/workbench/personal-runtime';
import { fixtureId } from '../../../../tests/fixtures/workbench/factories';
import { jobSnapshotSchema, type JobSnapshot, type SessionView } from '../../../server/workbench/protocol';
import { okoWorkflowViewSchema, type OkoWorkflowView } from '../workbench-workflow-contracts';
import { OkoClient } from './client';
import { PersonalOkoWorkspace } from './PersonalOkoWorkspace';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });

it('reader can complete the first personal setup without changing to editor', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close);
  const client = new OkoClient(f.fetcher, { prefix: 'oko.workflow' }); await client.session();
  await client.command('source.browser.role.set', { role: 'viewer' });
  render(<PersonalOkoWorkspace client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Создать первый сценарий' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Создать сценарий' }));
  await screen.findByLabelText('Адрес отчёта');
  // The setup panel opens after the own workspace refresh that follows the accepted create.
  await waitFor(() => expect(document.getElementById('wb-personal-settings')?.hidden).toBe(false));
  expect(screen.getByRole('button', { name: 'Начать запись действий' })).toBeTruthy();
  expect(screen.queryByText(/выберите режим «Редактор»/)).toBeNull();
  expect(f.requests.filter(request => request.body?.name === 'oko.workflow.open')).toHaveLength(1);
});

it('explicit recovery reads the original receipt after a lost response without sending a second mutation', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close); let dropped = false;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await f.fetcher(input, init);
    if (!dropped && String(input).endsWith('/commands') && typeof init?.body === 'string' && JSON.parse(init.body).name === 'oko.workflow.open') { dropped = true; throw Error('Synthetic committed response lost'); }
    return response;
  };
  render(<PersonalOkoWorkspace client={new OkoClient(fetcher, { prefix: 'oko.workflow' })} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Создать первый сценарий' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Создать сценарий' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Проверить сохранённое состояние' }));
  await waitFor(() => expect(f.requests.some(request => /\/commands\/[\da-f-]+$/.test(request.url))).toBe(true));
  await waitFor(() => expect(JSON.stringify(sessionStorage)).not.toContain('pending-command'));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(f.requests.filter(request => request.body?.name === 'oko.workflow.open')).toHaveLength(1);
  expect(f.requests.some(request => /\/commands\/[\da-f-]+$/.test(request.url))).toBe(true);
  expect(JSON.stringify(sessionStorage)).not.toContain('pending-command');
});

it('keeps unsaved personal setup when the owner declines switching to another workflow', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close);
  const client = new OkoClient(f.fetcher, { prefix: 'oko.workflow' }); await client.session();
  await client.command('source.browser.workflow.open', { title: 'Первый отчёт' });
  await client.command('source.browser.workflow.open', { title: 'Второй отчёт' });
  render(<PersonalOkoWorkspace client={client} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Настроить' }));
  const select = screen.getByLabelText('Сохранённый отчёт') as HTMLSelectElement, original = select.value;
  const other = [...select.options].find(option => option.value !== original)!.value;
  fireEvent.change(screen.getByLabelText('Имя личного профиля'), { target: { value: 'unsaved-profile' } });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.change(select, { target: { value: other } });
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(select.value).toBe(original);
  expect((screen.getByLabelText('Имя личного профиля') as HTMLInputElement).value).toBe('unsaved-profile');
  confirm.mockReturnValue(true); fireEvent.change(select, { target: { value: other } });
  await waitFor(() => expect(select.value).toBe(other));
});

const personId = fixtureId(8201), jobId = fixtureId(8202);
function readyWorkflow(): OkoWorkflowView {
  return okoWorkflowViewSchema.parse({
    workflowId: fixtureId(8203), sourceId: fixtureId(8204), revision: 'own:1', title: 'Личный отчёт', reportUrl: 'https://report.example.invalid/report', marker: { selector: '#ready', label: 'Отчёт' },
    parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' },
    profile: { sourceId: fixtureId(8204), profileId: 'own', revision: 'profile:1', configured: true, sessionState: 'closed', profile: { allowedOrigins: ['https://report.example.invalid'], browser: { channel: 'msedge', profileDirectory: 'own' } } },
    recording: { recordingId: null, state: 'completed', steps: [{ action: 'download', locator: { kind: 'css', selector: '#export' } }], parameterNames: [], problem: null },
    columns: ['ID', 'Значение'], sampleRows: [{ ID: 'P1', 'Значение': '12.5' }], parameters: {},
    mapping: { rowKeyColumns: ['ID'], productKeyColumn: null, dimensionColumns: {}, numberColumns: { value: 'Значение' }, dateColumn: null, unitColumn: null, fixedUnitCode: 'шт' },
    dictionary: { columns: [], sampleRows: [], mapping: null, origin: 'none', issues: [] }, warnings: [],
    result: { resultId: fixtureId(8205), rowCount: 1, unresolvedRows: 0, issues: [], previewRows: [{ ID: 'P1', 'Значение': '12.5' }], originalDownload: '/api/v1/browser/results/previous/original', enrichedDownload: '/api/v1/browser/results/previous/enriched', capturedAt: '2026-11-01T06:30:00Z', sourceDate: '2026-11-01' },
  });
}
function snapshot(patch: Partial<JobSnapshot>): JobSnapshot {
  return jobSnapshotSchema.parse({ jobId, commandId: fixtureId(8206), status: 'waiting_user', stage: 'browser.auth', progress: { completed: 0, total: null, unit: 'items' }, cancelAvailable: true, retryAvailable: false, result: null, error: null, warnings: [], nextAction: null, startedAt: '2026-11-01T09:00:00Z', finishedAt: null, ...patch });
}
/** Saved job/result snapshots cross the HTTP boundary; the client, provider and UI are unchanged. */
function mountedJob(initial: JobSnapshot | null, initialWorkflow = readyWorkflow()) {
  let job = initial, value = initialWorkflow;
  const sent: Array<{ name: string; commandId: string; payload: Record<string, unknown> }> = [];
  const session: SessionView = { personId, role: 'viewer', displayName: 'Читатель', policyState: 'local_preview', checkedAt: '2026-11-01T09:00:00Z', defaultContext: null, csrfToken: 'synthetic-token', allowedCommands: ['oko.workflow.open', 'oko.workflow.record.start', 'oko.workflow.record.finish', 'oko.workflow.record.test', 'oko.workflow.record.cancel', 'job.cancel', 'job.openAuth', 'job.retry'] };
  if (job) {
    const key = 'uor.oko.pending-job.v1:oko.workflow';
    sessionStorage.setItem(key, JSON.stringify({ personId, workflowId: value.workflowId }));
    sessionStorage.setItem(`${key}:${personId}:${value.workflowId}`, JSON.stringify({ personId, workflowId: value.workflowId, jobId, kind: 'replay' }));
  }
  const client = new OkoClient(async (input, init) => {
    const url = String(input), body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (url.endsWith('/session')) return Response.json({ data: session });
    if (url.endsWith('/queries/oko.workflow.workspace')) return Response.json({ data: { workflows: [{ workflowId: value.workflowId, title: value.title, revision: value.revision }], current: value, setup: { hostname: 'synthetic', registryConfigured: true, message: null } } });
    if (url.endsWith('/queries/oko.workflow.exports')) return Response.json({ data: { items: [], hiddenCount: 0 } });
    if (url.endsWith('/jobs/' + jobId)) return Response.json({ data: job });
    if (url.endsWith('/commands')) {
      sent.push(body);
      if (body.name === 'job.openAuth') job = snapshot({ retryAvailable: true, nextAction: { commandName: 'job.retry', payload: { jobId }, route: null, label: 'Вход выполнен — продолжить', enabled: true, disabledReason: null } });
      else if (body.name === 'job.cancel') job = snapshot({ status: 'cancelled', stage: 'cancelled', cancelAvailable: false, finishedAt: '2026-11-01T09:01:00Z' });
      else if (body.name === 'job.retry') job = snapshot({ status: 'succeeded', stage: 'completed', cancelAvailable: false, result: value, finishedAt: '2026-11-01T09:01:00Z' });
      else if (body.name === 'oko.workflow.record.start') value = { ...value, revision: 'own:start', recording: { ...value.recording, state: 'recording', recordingId: fixtureId(8210), steps: [] } };
      else if (body.name === 'oko.workflow.record.finish') value = { ...value, revision: 'own:2', columns: ['ID', 'Значение'], recording: { ...value.recording, state: 'completed', steps: [{ action: 'download', locator: { kind: 'css', selector: '#export' } }] } };
      else throw Error('Unexpected synthetic command ' + body.name);
      return Response.json({ data: { commandId: body.commandId, result: body.name.startsWith('job.') ? { jobId } : value, changedRefs: [], editToken: null } });
    }
    throw Error('Unexpected synthetic request ' + url);
  }, { prefix: 'oko.workflow' });
  const mounted = render(<PersonalOkoWorkspace client={client} refreshKey="own:1" />);
  return { sent, replace(next: OkoWorkflowView) { value = next; mounted.rerender(<PersonalOkoWorkspace client={client} refreshKey={next.revision} />); } };
}

it('failed acquisition shows its real progress, readable recovery and previous file outside collapsed setup', async () => {
  mountedJob(snapshot({ status: 'failed', stage: 'source.normalize', progress: { completed: 3, total: 5, unit: 'rows' }, cancelAvailable: false, error: { code: 'SOURCE_SCHEMA_CHANGED', message: 'Mapped column is absent', retryable: false, details: [], operationId: jobId, provider: null } }));
  await screen.findByText('Получение остановлено');
  expect(screen.getByText(/3 из 5 строк/)).toBeTruthy();
  expect(screen.getByText(/Изменились столбцы или формат выгрузки/)).toBeTruthy();
  expect(screen.getByText('Разбор и нормализация файла')).toBeTruthy();
  expect(document.getElementById('wb-personal-settings')?.hidden).toBe(true);
  expect(screen.getByRole('link', { name: 'Скачать исходный файл' }).getAttribute('href')).toContain('previous/original');
});

it('manual authentication resumes the same owned job and cancellation retains the previous result', async () => {
  const fixture = mountedJob(snapshot({ nextAction: { commandName: 'job.openAuth', payload: { jobId }, route: null, label: 'Войти в ОКО', enabled: true, disabledReason: null } }));
  fireEvent.click(await screen.findByRole('button', { name: 'Войти в ОКО' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Вход выполнен — продолжить' }));
  await screen.findByText('Получение завершено');
  expect(fixture.sent.map(command => [command.name, command.payload.jobId])).toEqual([['job.openAuth', jobId], ['job.retry', jobId]]);
  cleanup(); sessionStorage.clear();
  const cancellation = mountedJob(snapshot({ status: 'running', stage: 'running' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить получение' }));
  await screen.findByText('Операция отменена');
  expect(cancellation.sent.map(command => command.name)).toEqual(['job.cancel']);
  expect(screen.getByRole('link', { name: 'Скачать исходный файл' }).getAttribute('href')).toContain('previous/original');
});

it('an empty saved file remains explicitly empty instead of suggesting data coverage', async () => {
  const value = readyWorkflow(); value.result = { ...value.result!, rowCount: 0, unresolvedRows: 0, previewRows: [] };
  mountedJob(null, value);
  expect(await screen.findByText('В файле нет строк данных')).toBeTruthy();
  expect(screen.getByText(/Проверьте период и фильтры/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Скачать исходный файл' })).toBeTruthy();
});

it('cancelled first acquisition never claims that a previous successful result exists', async () => {
  const value = readyWorkflow(); value.result = null;
  mountedJob(snapshot({ status: 'cancelled', stage: 'cancelled', cancelAvailable: false }), value);
  await screen.findByText('Операция отменена');
  expect(screen.queryByText(/Предыдущий результат сохранён/)).toBeNull();
  expect(screen.getByText(/Новый результат не подтверждён/)).toBeTruthy();
});

it('collapsed personal setup preserves edits and requires explicit acceptance after download', async () => {
  const value = readyWorkflow(); value.recording = { ...value.recording, state: 'idle', recordingId: null, steps: [] }; value.columns = [];
  const f = mountedJob(null, value);
  fireEvent.click(await screen.findByRole('button', { name: 'Настроить' }));
  fireEvent.click(screen.getByRole('button', { name: 'Начать запись действий' }));
  await waitFor(() => expect(f.sent.filter(command => command.name === 'oko.workflow.record.start')).toHaveLength(1));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Получить записанные шаги' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('Адрес отчёта'), { target: { value: 'https://report.example.invalid/unsaved' } });
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть настройки' }));
  f.replace({ ...value, revision: 'download-completed', recording: { ...value.recording, state: 'completed', recordingId: fixtureId(8210) } });
  await waitFor(() => expect(screen.getByText(/Скачивание завершено. Нажмите/)).toBeTruthy());
  expect(f.sent.filter(command=>command.name==='oko.workflow.record.finish')).toHaveLength(0);
  expect(document.getElementById('wb-personal-settings')?.hidden).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Настроить' }));
  expect((screen.getByLabelText('Адрес отчёта') as HTMLInputElement).value).toBe('https://report.example.invalid/unsaved');
  fireEvent.click(screen.getByRole('button',{name:'Получить записанные шаги'}));
  await waitFor(()=>expect(f.sent.filter(command=>command.name==='oko.workflow.record.finish')).toHaveLength(1));
  expect(f.sent.filter(command => command.name === 'oko.workflow.record.finish')).toHaveLength(1);
});

it('creates a Confluence recipe with explicitly entered provenance and no guessed version',async()=>{
 const f=await createPersonalRuntime();closes.push(f.close);const client=new OkoClient(f.fetcher,{prefix:'oko.workflow'});
 render(<PersonalOkoWorkspace client={client}/>);fireEvent.click(await screen.findByRole('button',{name:'Создать первый сценарий'}));
 fireEvent.change(screen.getByLabelText('Источник сценария'),{target:{value:'confluence'}});
 fireEvent.change(screen.getByLabelText('Название отчёта'),{target:{value:'Вложение знаний'}});
 fireEvent.change(screen.getByLabelText('URL страницы'),{target:{value:'https://wiki.example.org/pages/viewpage.action?pageId=123'}});
 fireEvent.change(screen.getByLabelText('Идентификатор вложения'),{target:{value:'456'}});
 fireEvent.change(screen.getByLabelText('Версия вложения'),{target:{value:'7'}});
 fireEvent.click(screen.getByRole('button',{name:'Создать сценарий'}));await screen.findByLabelText('Адрес отчёта');
 expect(f.requests.find(r=>r.body?.name==='oko.workflow.open')?.body?.payload).toMatchObject({title:'Вложение знаний',sourceKind:'confluence',sourceMetadata:{pageUrl:'https://wiki.example.org/pages/viewpage.action?pageId=123',attachmentId:'456',version:7}});
});
