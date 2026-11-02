// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkbenchClient } from './api-client';
import { OkoClient } from '../../features/connectors/workbench/client';
import { createPersonalRuntime } from '../../../tests/fixtures/workbench/personal-runtime';
import { WorkbenchApp } from './WorkbenchApp';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); vi.restoreAllMocks(); sessionStorage.clear(); window.history.replaceState(null, '', '/'); for (const close of closes.splice(0).reverse()) await close(); });
it('empty new runtime exposes a real personal OKO path without inventing an organization or goal', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close);
  window.history.replaceState(null, '', '/data#personal-oko');
  render(<WorkbenchApp client={new WorkbenchClient({ fetch: f.fetcher })} personalClient={new OkoClient(f.fetcher, { prefix: 'oko.workflow' })} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Создать первый сценарий' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Создать сценарий' }));
  await screen.findByRole('heading', { name: 'Новый отчёт ОКО' });
  expect(f.repository.readPublishedCatalog()).toEqual([]);
  expect(f.requests.filter(request => request.body?.name === 'oko.workflow.open')).toHaveLength(1);
  expect(f.requests.some(request => request.body?.name === 'source.browser.workflow.open')).toBe(false);
  for (const name of ['Обзор', 'Цели', 'Работы и решения', 'Данные', 'Панель УОР']) expect(screen.getByRole('button', { name })).toBeTruthy();
  expect(screen.queryByRole('banner', { name: 'ОКО' })).toBeNull();
});
it('local mode switch keeps one person and refreshes embedded personal permissions without losing typed title', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close);
  window.history.replaceState(null, '', '/data#personal-oko');
  render(<WorkbenchApp client={new WorkbenchClient({ fetch: f.fetcher })} personalClient={new OkoClient(f.fetcher, { prefix: 'oko.workflow' })} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Новый сценарий' }));
  fireEvent.change(screen.getByLabelText('Название отчёта'), { target: { value: 'Сохранённый ввод' } });
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
  fireEvent.change(screen.getByLabelText('Режим работы'), { target: { value: 'viewer' } });
  expect((screen.getByLabelText('Режим работы') as HTMLSelectElement).value).toBe('curator');
  expect((screen.getByLabelText('Название отчёта') as HTMLInputElement).value).toBe('Сохранённый ввод');
  confirm.mockReturnValue(true);
  fireEvent.change(screen.getByLabelText('Режим работы'), { target: { value: 'viewer' } });
  await waitFor(() => expect((screen.getByLabelText('Режим работы') as HTMLSelectElement).value).toBe('viewer'));
  await screen.findByRole('button', { name: 'Новый сценарий' });
  expect((await new OkoClient(f.fetcher, { prefix: 'oko.workflow' }).session()).personId).toBe(f.personId);
  fireEvent.change(screen.getByLabelText('Режим работы'), { target: { value: 'curator' } });
  await screen.findByRole('button', { name: 'Новый сценарий' });
  expect((screen.getByLabelText('Название отчёта') as HTMLInputElement).value).toBe('Сохранённый ввод');
  expect(f.requests.some(request => request.body?.name === 'package.submit')).toBe(false);
});
