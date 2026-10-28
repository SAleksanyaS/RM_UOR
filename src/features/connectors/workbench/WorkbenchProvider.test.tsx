// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchProvider, useWorkbench } from './WorkbenchProvider';
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
