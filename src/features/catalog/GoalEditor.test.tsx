// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import type { Assignment, Goal, KnowledgeEntity } from '../../domain/contracts';
import { GoalEditor } from './GoalEditor';
import type { AssignmentScopeInput } from './scope-contracts';

afterEach(cleanup);
const goal = { id: 'g1', title: 'Зрелость', summary: '', officialTarget: null, internalTarget: null, weight: null, priority: null, ownerId: null, curatorId: null, dueDate: null, revision: 'r1', links: [{ label: 'Дашборд', url: 'https://example.com/old', kind: 'dashboard' }] } as unknown as Goal;
const original: Assignment = { id: 'a1', goalId: 'g1', leaderId: 'l1', teams: ['Продукт А'], participantIds: ['team-a'], target: '80%', active: true };
const entities: KnowledgeEntity[] = [
  { id: 'team-a', name: 'Команда А', type: 'team', leaderId: 'l1' }, { id: 'team-b', name: 'Команда Б', type: 'team', leaderId: 'l1' },
  { id: 'foreign-team', name: 'Команда другого лидера', type: 'team', leaderId: 'l2' },
  { id: 'product-b', name: 'Продукт Б', type: 'product', leaderId: 'l1' }, { id: 'service', name: 'ИТ-услуга', type: 'it_service' },
];
function setup(assignments: Assignment[] = [original], implementation?: (path: string, body?: unknown) => Promise<unknown>, review = false) {
  const mutate = vi.fn(implementation ?? (async (path: string, body?: unknown) => {
    if (!path.endsWith('/scope')) return {};
    const { baseAssignment, newEntities: _newEntities, ...patch } = body as AssignmentScopeInput;
    return { assignment: { ...baseAssignment, ...patch }, createdEntities: [] };
  }));
  const onClose = vi.fn(), onPublish = vi.fn();
  const state = { catalog: { assignments, entities, leaders: [{ id: 'l1', name: 'ИТ-лидер' }, { id: 'l2', name: 'Другой лидер' }] } } as unknown as ClientState;
  render(<WorkspaceContext value={{ state, mutate, notify: vi.fn(), refresh: vi.fn(async () => {}) }}><GoalEditor goal={goal} onClose={onClose} onPublish={review ? onPublish : undefined}/></WorkspaceContext>);
  return { mutate, onClose, onPublish };
}
it('locks all goal fields while saving and restores them after an error', async () => {
  let rejectSave!: (error: Error) => void;
  const pending = new Promise((_resolve, reject) => { rejectSave = reject; });
  const { onClose } = setup([original], async () => pending);
  fireEvent.click(screen.getByText('Сохранить черновик'));
  expect(screen.getByLabelText('Название').matches(':disabled')).toBe(true);
  expect(screen.getByLabelText('Описание').matches(':disabled')).toBe(true);
  expect(screen.getByLabelText('Ссылки цели').matches(':disabled')).toBe(true);
  rejectSave(new Error('Синтетическая ошибка сохранения'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Синтетическая ошибка'));
  expect(screen.getByLabelText('Название').matches(':disabled')).toBe(false);
  expect(onClose).not.toHaveBeenCalled();
});
it('saves explicit team and object choices before opening reviewed publication without sending directly', async () => {
  const { mutate, onPublish } = setup([original], undefined, true);
  fireEvent.click(screen.getByLabelText('Применяется: ИТ-лидер'));
  fireEvent.click(screen.getByLabelText('Команда А'));
  fireEvent.click(screen.getByLabelText('Команда Б'));
  fireEvent.click(screen.getByLabelText('Продукт А'));
  fireEvent.click(screen.getByLabelText('Продукт Б'));
  fireEvent.change(screen.getByLabelText('Цель назначения: ИТ-лидер'), { target: { value: '90%' } });
  fireEvent.click(screen.getByText('Сохранить и проверить состав'));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/assignments/a1/scope', expect.objectContaining({ baseAssignment: original, active: false, teams: ['Продукт Б'], participantIds: ['team-b'], target: '90%' })));
  await waitFor(() => expect(onPublish).toHaveBeenCalledOnce());
  expect(mutate.mock.calls.map(call => call[0])).toEqual(['/api/goals/g1', '/api/assignments/a1/scope']);
  expect(screen.queryByLabelText('Команда другого лидера')).toBeNull();
});
it('edits goal links and retains the known source kind', async () => {
  const { mutate } = setup();
  fireEvent.change(screen.getByLabelText('Ссылки цели'), { target: { value: 'Дашборд | https://example.com/old\nМетодика | https://example.com/method' } });
  fireEvent.click(screen.getByText('Сохранить черновик'));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/goals/g1', expect.objectContaining({ links: [{ label: 'Дашборд', url: 'https://example.com/old', kind: 'dashboard' }, { label: 'Методика', url: 'https://example.com/method', kind: 'reference' }] })));
});
it('lets a curator assign a named work direction without entering a technical code', async () => {
  const { mutate } = setup();
  fireEvent.change(screen.getByLabelText('Направление'), { target: { value: 'data' } });
  fireEvent.click(screen.getByText('Сохранить черновик'));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/goals/g1', expect.objectContaining({ workDirectionId: 'data' })));
});

it('does not derive an unknown calculation cohort from legacy object names', async () => {
  const legacy = { ...original }; delete legacy.participantIds;
  const { mutate } = setup([legacy]);
  expect(screen.getByText(/Состав команд для расчёта ещё не задан/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Продукт Б'));
  fireEvent.click(screen.getByText('Сохранить черновик'));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/assignments/a1/scope', expect.objectContaining({ teams: ['Продукт А', 'Продукт Б'] })));
  const body = mutate.mock.calls.find(call => call[0].endsWith('/scope'))![1] as Record<string, unknown>;
  expect(Object.hasOwn(body, 'participantIds')).toBe(false);
});

it('keeps an explicitly emptied calculation cohort distinct from unknown', async () => {
  const { mutate } = setup(); fireEvent.click(screen.getByLabelText('Команда А'));
  fireEvent.click(screen.getByText('Сохранить черновик'));
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/assignments/a1/scope', expect.objectContaining({ participantIds: [] })));
});

it('adds several typed items to the pending list and retains their selections after a save error', async () => {
  const { mutate, onClose } = setup([original], async path => { if (path.endsWith('/scope')) throw new Error('Не удалось сохранить состав'); return {}; });
  fireEvent.change(screen.getByLabelText('Название нового элемента'), { target: { value: 'Новая команда' } });
  fireEvent.click(screen.getByText('Добавить в список'));
  fireEvent.change(screen.getByLabelText('Тип нового элемента'), { target: { value: 'product' } });
  fireEvent.change(screen.getByLabelText('Название нового элемента'), { target: { value: 'Новый продукт' } });
  fireEvent.click(screen.getByText('Добавить в список'));
  expect(mutate).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Новая команда') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByText('Сохранить черновик'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Не удалось сохранить состав'));
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Новый продукт') as HTMLInputElement).checked).toBe(true);
  expect(mutate).toHaveBeenCalledWith('/api/assignments/a1/scope', expect.objectContaining({ newEntities: [
    { clientId: expect.any(String), type: 'team', name: 'Новая команда', selected: true },
    { clientId: expect.any(String), type: 'product', name: 'Новый продукт', selected: true },
  ] }));
});

it('does not recreate saved items when a later assignment fails and the curator retries', async () => {
  const second: Assignment = { id: 'a2', goalId: 'g1', leaderId: 'l2', teams: [], participantIds: [], active: true };
  let secondFailed = false;
  const created: KnowledgeEntity = { id: 'saved-team', type: 'team', name: 'Сохранённая команда', leaderId: 'l1' };
  const { mutate, onClose } = setup([original, second], async (path, body) => {
    if (!path.endsWith('/scope')) return {};
    const { baseAssignment, newEntities, ...patch } = body as AssignmentScopeInput;
    if (path.includes('/a2/') && !secondFailed) { secondFailed = true; throw new Error('Второе назначение пока не сохранено'); }
    return { assignment: { ...baseAssignment, ...patch, ...(path.includes('/a1/') ? { participantIds: ['team-a', created.id] } : {}) },
      createdEntities: newEntities?.length ? [{ clientId: newEntities[0].clientId, entity: created }] : [] };
  });
  fireEvent.change(screen.getAllByLabelText('Название нового элемента')[0], { target: { value: created.name } });
  fireEvent.click(screen.getAllByText('Добавить в список')[0]);
  fireEvent.click(screen.getByLabelText('Применяется: Другой лидер'));
  fireEvent.click(screen.getByText('Сохранить черновик'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Второе назначение'));
  expect((screen.getByLabelText(created.name) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByText('Сохранить черновик'));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mutate.mock.calls.filter(call => call[0] === '/api/assignments/a1/scope')).toHaveLength(1);
  expect(mutate.mock.calls.filter(call => call[0] === '/api/assignments/a2/scope')).toHaveLength(2);
});
