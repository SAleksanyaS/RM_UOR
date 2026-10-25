// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { DirectorPage } from './DirectorPage';
import { buildDirectorModel } from './director-model';
const now = '2026-10-25T12:00:00.000Z';
function state(): ClientState { return { catalog: { id: 'c', name: 'Каталог примера', schemaVersion: 1, classification: 'demo', importedAt: now, goals: [], leaders: [], assignments: [], sources: [], comments: [], entities: [{ id: 'd', type: 'decision', name: 'Решение примера', owner: 'Владелец примера', goalId: null, dueDate: null, state: 'open', closureComment: '', revision: 'first', updatedAt: now, updatedBy: 'Куратор примера' } as never] }, snapshots: [], attestations: [], evaluations: [], session: { id: 'curator', role: 'curator', curatorId: 'demo-curator', name: 'Куратор примера', createdAt: now }, csrfToken: 'token', operations: [], changes: [], drafts: [], version: '', repository: { url: '', publishedBranch: '', releaseBranch: '', publicationMode: '' }, updates: { status: 'current', checkedAt: null, currentCommit: null, remoteCommit: null, message: '', changes: [] } }; }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('keeps the opened revision and entered closure reason after a concurrent decision edit', async () => {
  const current = state(), model = buildDirectorModel(current.catalog, [], now);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => model })));
  const mutate = vi.fn(async (_path: string, _body?: unknown) => { throw new Error('Решение уже изменилось'); });
  render(<WorkspaceContext value={{ state: current, mutate, notify: vi.fn(), refresh: vi.fn(async () => {}) }}><DirectorPage/></WorkspaceContext>);
  await waitFor(() => expect(screen.getByText('Решение примера')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Изменить' }));
  fireEvent.change(screen.getByLabelText('Состояние'), { target: { value: 'closed' } });
  fireEvent.change(screen.getByLabelText('Основание закрытия'), { target: { value: 'Проверенное основание' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить решение' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Решение уже изменилось'));
  expect((screen.getByLabelText('Основание закрытия') as HTMLTextAreaElement).value).toBe('Проверенное основание');
  expect(mutate).toHaveBeenCalledWith('/api/director/decisions', expect.objectContaining({ id: 'd', baseRevision: 'first', decision: expect.objectContaining({ state: 'closed', closureComment: 'Проверенное основание' }) }));
});
it('does not offer decision mutation to a reader', async () => {
  const current = state(); current.session.role = 'reader'; current.session.curatorId = null;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => buildDirectorModel(current.catalog, [], now) })));
  render(<WorkspaceContext value={{ state: current, mutate: vi.fn(), notify: vi.fn(), refresh: vi.fn(async () => {}) }}><DirectorPage/></WorkspaceContext>);
  await waitFor(() => expect(screen.getByText('Решение примера')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Изменить' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Новое решение' })).toBeNull();
});
