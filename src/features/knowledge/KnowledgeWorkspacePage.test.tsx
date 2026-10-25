// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { KnowledgeWorkspacePage } from './KnowledgeWorkspacePage';
import type { KnowledgeRecord } from './knowledge-contracts';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const article: KnowledgeRecord = { id: 'article', type: 'article', name: 'Методика расчёта', description: 'Как проверять', body: 'Шаг один\n<script>alert(1)</script>',
  links: [{ label: 'Справочник', url: 'https://example.com/rules' }], leaderId: null, productId: null, aliases: [], goalIds: [], revision: 'v1', archivedAt: null };
function setup(role = 'reader') {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ records: [article] }) })));
  const mutate = vi.fn(async (_path: string, _body?: unknown) => { throw new Error('Запись уже изменилась. Обновите версию.'); });
  render(<WorkspaceContext value={{ state: { catalog: { entities: [], leaders: [], goals: [] }, session: { role } } as unknown as ClientState,
    mutate, refresh: vi.fn(async () => {}), notify: vi.fn() }}><KnowledgeWorkspacePage/></WorkspaceContext>);
  return { mutate };
}
it('lets readers open an article as safe text without editing controls', async () => {
  setup(); fireEvent.click(await screen.findByRole('button', { name: 'Методика расчёта' }));
  expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Добавить запись' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Изменить запись' })).toBeNull();
});
it('preserves the edited article and explains a conflict without silently closing the form', async () => {
  const { mutate } = setup('curator'); fireEvent.click(await screen.findByRole('button', { name: 'Методика расчёта' }));
  fireEvent.click(screen.getByRole('button', { name: 'Изменить запись' }));
  fireEvent.change(screen.getByLabelText('Текст методики или инструкции'), { target: { value: 'Мой важный новый текст' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('изменилась'));
  expect((screen.getByLabelText('Текст методики или инструкции') as HTMLTextAreaElement).value).toBe('Мой важный новый текст');
  expect((mutate.mock.calls[0][1] as { baseRevision: string }).baseRevision).toBe('v1');
});
