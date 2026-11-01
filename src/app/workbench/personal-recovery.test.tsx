// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OkoClient } from '../../features/connectors/workbench/client';
import { WorkbenchProvider, useWorkbench } from '../../features/connectors/workbench/WorkbenchProvider';
import { createPersonalRuntime } from '../../../tests/fixtures/workbench/personal-runtime';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); sessionStorage.clear(); for (const close of closes.splice(0).reverse()) await close(); });
function Probe() { const state = useWorkbench(); return <><p>{state.loading ? 'Загрузка' : 'Готово'}</p><p>{state.current?.title ?? 'Нет отчёта'}</p>{state.error && <p role="alert">{state.error}</p>}<button disabled={state.loading || state.busy} onClick={() => void state.open(undefined, 'Личный отчёт').catch(() => {})}>Создать личный отчёт</button></>; }
it('standalone cleanup also leaves combined pending jobs and logins untouched', async () => {
  const f = await createPersonalRuntime('source.browser'); closes.push(f.close);
  const workflowId = crypto.randomUUID(), jobId = crypto.randomUUID();
  const prefix = 'uor.oko.pending-job.v1:oko.workflow';
  const hints = { [prefix]: JSON.stringify({ personId: f.personId, workflowId }), [prefix + ':' + f.personId + ':' + workflowId]: JSON.stringify({ personId: f.personId, workflowId, jobId, kind: 'replay' }), ['uor.oko.login.v1:oko.workflow:' + f.personId + ':' + workflowId]: crypto.randomUUID() };
  for (const [key, value] of Object.entries(hints)) sessionStorage.setItem(key, value);
  render(<WorkbenchProvider client={new OkoClient(f.fetcher)}><Probe /></WorkbenchProvider>);
  await screen.findByText('Готово');
  for (const [key, value] of Object.entries(hints)) expect(sessionStorage.getItem(key)).toBe(value);
  expect(f.requests.some(request => request.url === '/api/v1/jobs/' + jobId)).toBe(false);
});
it('combined UI leaves standalone pending metadata alone for the same person and never reconciles it', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close);
  const oldId = crypto.randomUUID(), old = JSON.stringify({ personId: f.personId, commandId: oldId, name: 'source.browser.workflow.open', workflowId: null });
  sessionStorage.setItem('uor.oko.pending-command.v1', old);
  render(<WorkbenchProvider client={new OkoClient(f.fetcher, { prefix: 'oko.workflow' })}><Probe /></WorkbenchProvider>);
  await screen.findByText('Готово');
  expect(f.requests.some(request => request.url === '/api/v1/commands/' + oldId)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Создать личный отчёт' }));
  await screen.findByText('Личный отчёт');
  expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toBe(old);
});
it('combined UI restores its own committed response without replaying a mutation after remount', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close); let dropped = false;
  const fetcher: typeof fetch = async (input, init) => { const response = await f.fetcher(input, init); if (!dropped && String(input).endsWith('/commands') && typeof init?.body === 'string' && JSON.parse(init.body).name === 'oko.workflow.open') { dropped = true; throw Error('Synthetic committed response lost'); } return response; };
  const first = render(<WorkbenchProvider client={new OkoClient(fetcher, { prefix: 'oko.workflow' })}><Probe /></WorkbenchProvider>);
  await screen.findByText('Готово'); fireEvent.click(screen.getByRole('button', { name: 'Создать личный отчёт' }));
  await screen.findByRole('alert');
  const command = f.requests.find(request => request.body?.name === 'oko.workflow.open')!.body!;
  await waitFor(() => expect(sessionStorage.getItem('uor.oko.pending-command.v1:oko.workflow')).toContain(String(command.commandId)));
  first.unmount();
  render(<WorkbenchProvider client={new OkoClient(f.fetcher, { prefix: 'oko.workflow' })}><Probe /></WorkbenchProvider>);
  await screen.findByText('Личный отчёт');
  await waitFor(() => expect(sessionStorage.getItem('uor.oko.pending-command.v1:oko.workflow')).toBeNull());
  expect(f.requests.filter(request => request.body?.name === 'oko.workflow.open')).toHaveLength(1);
  expect(f.requests.some(request => request.url === '/api/v1/commands/' + command.commandId)).toBe(true);
  expect((await new OkoClient(f.fetcher, { prefix: 'oko.workflow' }).workspace()).workflows).toHaveLength(1);
});
