// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import type { ExecutionView } from './execution-contracts';
import { ExecutionPage } from './ExecutionPage';
const now = '2026-10-25T10:00:00Z';
const state = (): ClientState => ({ catalog: { schemaVersion: 1, id: 'c', name: '', classification: 'demo', importedAt: now, goals: [{ id: 'g', title: 'Цель примера', scopeType: 'global', category: 'process', summary: '', target: '', metric: '', status: '', actions: [], links: [], ownerId: null, curatorId: null, officialTarget: 50, internalTarget: null, unit: '%', direction: 'increase', baseline: null, weight: null, priority: null, dueDate: null, revision: 'r' }], leaders: [], assignments: [], sources: [], comments: [], entities: [] }, snapshots: [], evaluations: [], attestations: [], operations: [], drafts: [], changes: [], session: { id: 's', role: 'curator', curatorId: 'c', name: 'Анна', createdAt: now }, csrfToken: '', version: '', repository: { url: '', publishedBranch: '', releaseBranch: '', publicationMode: '' }, updates: { status: 'current', checkedAt: null, currentCommit: null, remoteCommit: null, message: '', changes: [] } });
const model: ExecutionView = { packages: [{ id: 'p', goalId: 'g', leaderId: null, title: 'Проверить документ', owner: 'Анна', dueDate: '2026-11-01', weight: 2, effortHours: 8, dependencies: [], revision: 'original', baseline: null, events: [] }], configs: [], forecasts: [], inbox: [], weighted: { confirmedShare: null, denominator: 0, confirmedWeight: 0, weightedGoals: 0, missingWeight: 1, zeroWeight: 0, unknownWeightedGoals: 0 } };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('preserves an edited milestone and pinned revision after CAS error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => model })));
  const mutate = vi.fn(async () => { throw new Error('Веха уже изменена'); });
  render(<WorkspaceContext value={{ state: state(), mutate, refresh: vi.fn(async () => {}), notify: vi.fn() }}><ExecutionPage/></WorkspaceContext>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Изменить веху Проверить документ' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Изменить веху Проверить документ' }));
  fireEvent.change(screen.getByLabelText('Название вехи'), { target: { value: 'Мой текст документа' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить веху' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Веха уже изменена'));
  expect((screen.getByLabelText('Название вехи') as HTMLInputElement).value).toBe('Мой текст документа');
  expect(mutate).toHaveBeenCalledWith('/api/execution/packages', expect.objectContaining({ id: 'p', baseRevision: 'original', title: 'Мой текст документа' }));
});
it('gives readers the work/fact/confirmation separation and no mutation controls', async () => {
  const current = state(); current.session.role = 'reader'; current.session.curatorId = null;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => model })));
  render(<WorkspaceContext value={{ state: current, mutate: vi.fn(), refresh: vi.fn(async () => {}), notify: vi.fn() }}><ExecutionPage/></WorkspaceContext>);
  await waitFor(() => expect(screen.getByText('Проверить документ')).toBeTruthy());
  expect(screen.getByText('Работы')).toBeTruthy(); expect(screen.getByText('Фактический результат')).toBeTruthy(); expect(screen.getByText('Подтверждение УОР')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Новая веха' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Изменить веху/ })).toBeNull();
});
it('pins completion proof to its opened version across a background refresh', async () => {
  let responseModel = structuredClone(model);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => responseModel })));
  const mutate = vi.fn(async () => { throw new Error('Конфликт события'); });
  render(<WorkspaceContext value={{ state: state(), mutate, refresh: vi.fn(async () => {}), notify: vi.fn() }}><ExecutionPage/></WorkspaceContext>);
  await waitFor(() => expect(screen.getByText('Проверить документ')).toBeTruthy());
  fireEvent.change(screen.getByLabelText('Основание изменения: Проверить документ'), { target: { value: 'Документ проверен мною' } });
  responseModel = { ...responseModel, packages: [{ ...responseModel.packages[0], revision: 'newer' }] };
  fireEvent.click(screen.getByRole('button', { name: 'Обновить данные' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'Зафиксировать завершение вехи' }));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/execution/packages/p/completion', expect.objectContaining({ baseRevision: 'original', comment: 'Документ проверен мною' })));
});
