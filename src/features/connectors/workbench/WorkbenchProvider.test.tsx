// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchProvider, useWorkbench } from './WorkbenchProvider';
import { OkoClient, OkoClientError } from './client';
afterEach(() => { cleanup(); sessionStorage.clear(); });
function Probe() { const state = useWorkbench(); return <div>{state.current?.title ?? 'empty'}<span>{state.job?.status}</span>{state.error}</div>; }
it('reattaches an own pending picker after remount and refreshes its workflow on completion', async () => {
  sessionStorage.setItem('uor.oko.pending-job.v1', JSON.stringify({ personId: 'person-1', workflowId: 'workflow-1' }));
  sessionStorage.setItem('uor.oko.pending-job.v1:person-1:workflow-1', JSON.stringify({ personId: 'person-1', workflowId: 'workflow-1', jobId: 'job-1', kind: 'marker' }));
  let completed = false;
  const client = { session: vi.fn().mockResolvedValue({ personId: 'person-1', allowedCommands: [], csrfToken: 'token' }), workspace: vi.fn(async () => ({ current: { workflowId: 'workflow-1', title: completed ? 'Выбран отчёт' : 'Ожидаем выбор', recording: {state:'idle'} }, workflows: [], setup: {} })), job: vi.fn(async () => { completed = true; return { jobId: 'job-1', status: 'succeeded', result: { workflowId: 'workflow-1', title: 'Выбран отчёт' } }; }) };
  render(<WorkbenchProvider client={client as never}><Probe/></WorkbenchProvider>);
  await waitFor(() => expect(client.job).toHaveBeenCalledWith('job-1'));
  await screen.findByText('Выбран отчёт');
  expect(client.workspace).toHaveBeenLastCalledWith('workflow-1');
  expect(sessionStorage.getItem('uor.oko.pending-job.v1')).toBeNull();
});
it('does not restore a remembered operation belonging to a different own person', async () => {
  sessionStorage.setItem('uor.oko.pending-job.v1', JSON.stringify({ personId: 'other', workflowId: 'foreign' }));
  sessionStorage.setItem('uor.oko.pending-job.v1:other:foreign', JSON.stringify({ personId: 'other', workflowId: 'foreign', jobId: 'foreign-job', kind: 'replay' }));
  const client = { session: vi.fn().mockResolvedValue({ personId: 'person-1' }), workspace: vi.fn().mockResolvedValue({ current: null, workflows: [], setup: {} }), job: vi.fn() };
  render(<WorkbenchProvider client={client as never}><Probe/></WorkbenchProvider>);
  await waitFor(() => expect(client.workspace).toHaveBeenCalled());
  expect(client.job).not.toHaveBeenCalled();
});

function ActionProbe({ capture }: { capture(value: ReturnType<typeof useWorkbench>): void }) { const state = useWorkbench(); capture(state); return <Probe/>; }
function boundaryClient() {
  let personId = 'person-1', effects = 0, accepted = false;
  const receipts = new Map<string, unknown>();
  const view = { workflowId: 'workflow-1', title: 'Recovered report', recording: { state: 'idle' } };
  const commands: Array<{ commandId: string; name: string }> = [];
  let lose = true;
  const client = {
    session: async () => ({ personId, csrfToken: 'token', allowedCommands: [] }),
    workspace: async () => ({ current: accepted ? view : null, workflows: accepted ? [view] : [], setup: {} }),
    command: async (name: string, _payload: unknown, commandId: string = crypto.randomUUID()) => { commands.push({ name, commandId }); if (!receipts.has(commandId)) { effects++; accepted = true; receipts.set(commandId, view); } if (lose) { lose = false; throw new OkoClientError('NETWORK_ERROR', 'Response lost'); } return receipts.get(commandId); },
    reconcileCommand: async (commandId: string) => ({ commandId, name: commands.find(c => c.commandId === commandId)?.name ?? null, status: receipts.has(commandId) ? 'completed' : 'not_found', result: receipts.get(commandId) ?? null, job: null }),
    job: vi.fn(),
  };
  return { client, commands, effects: () => effects, setPerson: (value: string) => { personId = value; } };
}
it('recovers a lost accepted create response on retry without creating another workflow', async () => {
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await expect(state.run('source.browser.workflow.open', { title: 'private-title', parameters: { filter: 'private-value' } })).rejects.toThrow('Response lost'); });
  const stored = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join('');
  expect(stored).toContain(f.commands[0].commandId);
  expect(stored).not.toContain('private-title'); expect(stored).not.toContain('private-value');
  await act(async () => { await expect(state.run('source.browser.workflow.open', { title: 'private-title' })).rejects.toMatchObject({ code: 'COMMAND_RECOVERED' }); });
  expect(f.effects()).toBe(1); expect(f.commands).toHaveLength(1);
  expect(state.current?.title).toBe('Recovered report');
});
it('reconciles a lost response after reload using metadata alone', async () => {
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  const first = render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await expect(state.open()).rejects.toThrow('Response lost'); });
  first.unmount();
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  expect(state.current?.title).toBe('Recovered report'); expect(f.effects()).toBe(1); expect(f.commands).toHaveLength(1);
  expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toBeNull();
  expect(f.commands).toHaveLength(1);
});
it('coalesces duplicate in-flight commands before React renders busy state', async () => {
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await Promise.allSettled([state.open(), state.open()]); });
  expect(f.effects()).toBe(1); expect(f.commands).toHaveLength(1);
});
it('clears every foreign pending and login metadata key before querying the new person workspace', async () => {
  sessionStorage.setItem('uor.oko.pending-command.v1', JSON.stringify({ personId: 'other', commandId: 'foreign-command', name: 'source.browser.workflow.open', workflowId: null }));
  sessionStorage.setItem('uor.oko.login.v1:other:foreign', 'foreign-login');
  sessionStorage.setItem('uor.oko.pending-release.v1', JSON.stringify({ personId: 'other', commandId: 'foreign-release', name: 'source.browser.record.cancel', workflowId: 'foreign' }));
  sessionStorage.setItem('uor.oko.pending-job.v1:other:orphan', JSON.stringify({ jobId: 'foreign-job' }));
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  expect(sessionStorage.length).toBe(0); expect(f.commands).toHaveLength(0); expect(state.current).toBeNull();
});


it('reuses the saved identity when the first request never reached acceptance', async () => {
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  let failedId = ''; const accepted = f.client.command;
  f.client.command = async (name, payload, commandId = crypto.randomUUID()) => { if (!failedId) { failedId = commandId; throw new OkoClientError('NETWORK_ERROR', 'Before acceptance'); } return accepted(name, payload, commandId); };
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await expect(state.open()).rejects.toThrow('Before acceptance'); });
  await act(async () => { await expect(state.open()).rejects.toThrow('Response lost'); });
  expect(f.commands[0].commandId).toBe(failedId); expect(f.effects()).toBe(1);
  await act(async () => { await expect(state.open()).rejects.toMatchObject({ code: 'COMMAND_RECOVERED' }); });
  expect(f.effects()).toBe(1); expect(state.current?.title).toBe('Recovered report');
});
it('blocks a new effect while the original command is still pending on the server', async () => {
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  f.client.reconcileCommand = async commandId => ({ commandId, name: 'source.browser.workflow.open', status: 'pending', result: null, job: null });
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await expect(state.open()).rejects.toThrow('Response lost'); });
  await act(async () => { await expect(state.run('source.browser.marker.select', { workflowId: 'workflow-1' })).rejects.toMatchObject({ code: 'COMMAND_PENDING' }); });
  expect(f.effects()).toBe(1); expect(f.commands).toHaveLength(1);
  expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toContain(f.commands[0].commandId);
});
it('keeps a waiting job across native auth opening and retries the same job', async () => {
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  let phase = 0;
  const view = { workflowId: 'workflow-1', title: 'Recovered report', recording: { state: 'idle' } };
  f.client.command = async name => { if (name === 'job.openAuth') phase = 1; if (name === 'job.retry') phase = 2; return { jobId: 'job-auth' } as never; };
  f.client.job.mockImplementation(async id => ({ jobId: id, status: phase === 2 ? 'succeeded' : 'waiting_user', result: phase === 2 ? view : null, nextAction: phase === 0 ? { commandName: 'job.openAuth', label: 'Open own browser' } : { commandName: 'job.retry', label: 'Continue same operation' } }));
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await state.run('source.browser.record.test', { workflowId: 'workflow-1' }); });
  expect(state.job?.nextAction?.commandName).toBe('job.openAuth');
  expect(sessionStorage.getItem('uor.oko.pending-job.v1:person-1:workflow-1')).toContain('job-auth');
  await act(async () => { await state.run('job.openAuth', { jobId: 'job-auth' }); });
  expect(state.job?.nextAction?.commandName).toBe('job.retry');
  expect(sessionStorage.getItem('uor.oko.pending-job.v1:person-1:workflow-1')).toContain('job-auth');
  await act(async () => { await state.run('job.retry', { jobId: 'job-auth' }); });
  expect(state.job?.status).toBe('succeeded'); expect(state.job?.jobId).toBe('job-auth');
  expect(sessionStorage.getItem('uor.oko.pending-job.v1')).toBeNull();
});
it('retains the accepted identity when a later session refresh fails with an authoritative error', async () => {
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  const command = f.client.command; let rejectRefresh = false;
  const session = f.client.session;
  f.client.command = async (...args) => { try { await command(...args); } catch { /* Return the actual committed receipt to isolate a later session failure. */ } rejectRefresh = true; return { workflowId: 'workflow-1', title: 'Recovered report' } as never; };
  f.client.session = async () => { if (rejectRefresh) { rejectRefresh = false; throw new OkoClientError('SESSION_REQUIRED', 'Refresh session'); } return session(); };
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await expect(state.open()).rejects.toMatchObject({ code: 'SESSION_REQUIRED' }); });
  expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toContain(f.commands[0].commandId);
  await act(async () => { await expect(state.open()).rejects.toMatchObject({ code: 'COMMAND_RECOVERED' }); });
  expect(f.effects()).toBe(1); expect(f.commands).toHaveLength(1);
});

it('lets own cancellation reach the accepted job while its original command is polling', async () => {
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  let cancelled = false, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), firstRead = new Promise<void>(resolve => { entered = resolve; });
  const names: string[] = [];
  f.client.command = async name => { names.push(name); if (name === 'job.cancel') { cancelled = true; release(); } return { jobId: 'active-job' } as never; };
  f.client.job.mockImplementation(async id => { entered(); if (!cancelled) await waiting; return { jobId: id, status: 'cancelled', error: null }; });
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => {
    const running = state.run('source.browser.record.test', { workflowId: 'workflow-1' }).catch(failure => { expect(failure).toMatchObject({ code: 'cancelled' }); }); await firstRead;
    await expect(state.run('job.cancel', { jobId: 'active-job' })).rejects.toMatchObject({ code: 'cancelled' });
    await running;
  });
  expect(names).toEqual(['source.browser.record.test', 'job.cancel']); expect(state.busy).toBe(false);
  expect(sessionStorage.getItem('uor.oko.pending-job.v1')).toBeNull(); expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toBeNull();
});
it('keeps the durable identity after actual client receives null data for an accepted command', async () => {
  let state!: ReturnType<typeof useWorkbench>, accepted = false;
  const commandIds: string[] = [], view = { workflowId: 'workflow-1', title: 'Recovered report', recording: { state: 'idle' } };
  const client = new OkoClient((async (url, init) => {
    let data: unknown;
    if (String(url).endsWith('/session')) data = { personId: 'person-1', csrfToken: 'token', allowedCommands: [] };
    else if (String(url).includes('/queries/')) data = { current: accepted ? view : null, workflows: accepted ? [view] : [], setup: {} };
    else if (String(url) === '/api/v1/commands') { const request = JSON.parse(String(init?.body)); commandIds.push(request.commandId); accepted = true; data = null; }
    else data = { commandId: commandIds[0], name: 'source.browser.workflow.open', status: 'completed', result: view, job: null };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch);
  render(<WorkbenchProvider client={client}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await expect(state.open()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', uncertain: true }); });
  expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toContain(commandIds[0]);
  await act(async () => { await expect(state.open()).rejects.toMatchObject({ code: 'COMMAND_RECOVERED' }); });
  expect(commandIds).toHaveLength(1); expect(state.current?.title).toBe('Recovered report');
});
it.each([
  { name: 'source.browser.mapping.save', workflowId: 'workflow-1' },
  { name: 'source.browser.marker.select', workflowId: 'workflow-2' },
])('never reports a recovered earlier action as success for $name in $workflowId', async requested => {
  const f = boundaryClient(); let state!: ReturnType<typeof useWorkbench>;
  const workspace = f.client.workspace;
  f.client.workspace = async (id?: string) => id === 'workflow-2' ? { current: { workflowId: id, title: 'Other report', recording: { state: 'idle' } }, workflows: [], setup: {} } : workspace();
  render(<WorkbenchProvider client={f.client as never}><ActionProbe capture={value => { state = value; }}/></WorkbenchProvider>);
  await waitFor(() => expect(state.loading).toBe(false));
  await act(async () => { await expect(state.run('source.browser.marker.select', { workflowId: 'workflow-1' })).rejects.toThrow('Response lost'); });
  if (requested.workflowId === 'workflow-2') await act(async () => { await state.select('workflow-2'); });
  await act(async () => { await expect(state.run(requested.name, { workflowId: requested.workflowId, parameters: { value: 'still-in-form' } })).rejects.toMatchObject({ code: 'COMMAND_RECOVERED' }); });
  expect(f.commands).toHaveLength(1); expect(f.commands[0].name).toBe('source.browser.marker.select');
  expect(state.current?.workflowId).toBe(requested.workflowId);
  expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toBeNull();
});
