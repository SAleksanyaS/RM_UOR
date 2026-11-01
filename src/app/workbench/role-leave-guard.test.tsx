// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchApp } from './WorkbenchApp';
import { WorkbenchClient } from './api-client';
import { createWorkbenchRuntime } from '../../server/workbench/bootstrap';
import { createWorkbenchApp } from '../../server/workbench/app';
import { seedGoalReference } from '../../../scripts/design-reference/goal-fixture';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); window.history.replaceState(null, '', '/');
  for (const close of closes.splice(0).reverse()) await close();
});

it('declining a local role switch preserves dashboard input without a mutation, and an accepted retry keeps the same command ID', async () => {
  const temp = await realpath(tmpdir()), root = await mkdtemp(path.join(temp, 'uor-role-guard-'));
  closes.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'));
  await writeFile(path.join(root, 'config/site.local.json'), JSON.stringify({ port: 53963, clientPort: 53964, allowedWorkspaceRoots: [root], roleMode: 'local-preview' }));
  const runtime = await createWorkbenchRuntime({ projectRoot: root, codeRoot: process.cwd(), providers: { clock: { now: () => '2026-11-01T09:00:00.000Z' } } }); closes.push(runtime.close);
  const app = await createWorkbenchApp(runtime.deps); closes.push(() => app.close());
  seedGoalReference(runtime.deps.repository);
  const cookies = new Map<string, string>();
  const requests: Array<{ commandId: string; name: string }> = [];
  let loseFirstRoleResponse = true;
  const client = new WorkbenchClient({ fetch: async (input, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (body?.name === 'workbench.role.set') requests.push(body);
    const url = new URL(String(input), 'http://localhost:53964');
    const headers = new Headers(init?.headers); headers.set('host', 'localhost'); headers.set('origin', 'http://localhost:53964');
    if (cookies.size) headers.set('cookie', [...cookies].map(([name, value]) => name + '=' + value).join('; '));
    const reply = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: url.pathname + url.search, headers: Object.fromEntries(headers), ...(typeof init?.body === 'string' ? { payload: init.body } : {}) });
    for (const cookie of reply.cookies) cookies.set(cookie.name, cookie.value);
    const response = new Response(new Uint8Array(reply.rawPayload), { status: reply.statusCode });
    if (body?.name === 'workbench.role.set' && loseFirstRoleResponse) {
      loseFirstRoleResponse = false;
      expect(response.status).toBe(200);
      throw new TypeError('Synthetic loss after the real role receipt');
    }
    return response;
  } });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  window.history.replaceState(null, '', '/overview');
  render(<WorkbenchApp client={client} />);
  fireEvent.click(await screen.findByText('Мои дашборды и настройки представления'));
  fireEvent.click(await screen.findByRole('button', { name: 'Создать общий дашборд' }));
  const title = await screen.findByLabelText('Название дашборда') as HTMLInputElement;
  await waitFor(() => expect(title.closest('fieldset')?.disabled).toBe(false));
  fireEvent.change(title, { target: { value: 'Несохранённый обзор руководителя' } });
  fireEvent.click(screen.getByRole('button', { name: 'Добавить блок' }));
  const mode = screen.getByLabelText('Режим работы') as HTMLSelectElement;
  fireEvent.change(mode, { target: { value: 'viewer' } });
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(requests).toHaveLength(0);
  expect(title.value).toBe('Несохранённый обзор руководителя');
  expect(screen.getByRole('group', { name: 'Блок: Список целей' })).toBeTruthy();
  expect(mode.value).toBe('curator');

  confirm.mockReturnValue(true);
  fireEvent.change(mode, { target: { value: 'viewer' } });
  const retry = await screen.findByRole('button', { name: 'Повторить смену режима' });
  expect(requests).toHaveLength(1);
  expect((screen.getByLabelText('Название дашборда') as HTMLInputElement).value).toBe('Несохранённый обзор руководителя');
  fireEvent.click(retry);
  await waitFor(() => expect((screen.getByLabelText('Режим работы') as HTMLSelectElement).value).toBe('viewer'));
  await waitFor(() => expect(screen.queryByLabelText('Название дашборда')).toBeNull());
  expect(requests).toHaveLength(2);
  expect(requests[1].commandId).toBe(requests[0].commandId);
  expect((await client.reconcileCommand(requests[0].commandId)).data).toMatchObject({ status: 'completed' });
});
