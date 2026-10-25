// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { WeeklyReportPage } from './WeeklyReportPage';
import { currentWeekStart, type WeeklyBriefRecord, type WeeklyReportView } from './contracts';

const week = currentWeekStart(), at = '2026-10-25T12:00:00.000Z';
const record: WeeklyBriefRecord = { id: 'weekly-a', revision: 'opened-revision', schemaVersion: 1, weekStart: week, ownerId: 'a', ownerName: 'Анна — УОР', updatedAt: at,
  summary: '<script>Не HTML, а текст</script>', completed: ['Согласован план'], attention: ['Ждём владельца'], nextWeek: ['Проверить данные'] };
function state(curator = false): ClientState {
  return { catalog: { id: 'synthetic', name: 'Пример', schemaVersion: 1, classification: 'demo', importedAt: at, goals: [], leaders: [], assignments: [], sources: [], comments: [], entities: [] },
    snapshots: [], attestations: [], evaluations: [], session: { id: 'session', role: curator ? 'curator' : 'reader', curatorId: curator ? 'a' : null, name: curator ? 'Анна — УОР' : 'Просмотр', createdAt: at },
    csrfToken: 'token', operations: [], changes: [], drafts: [], version: '', repository: { url: '', publishedBranch: 'main', releaseBranch: 'release/current', publicationMode: 'demo-only' },
    updates: { status: 'current', checkedAt: null, currentCommit: null, remoteCommit: null, message: '', changes: [] } };
}
function show(view: WeeklyReportView, curator = false, mutate = vi.fn(async () => ({})), onPublish = vi.fn()) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => view })));
  render(<WorkspaceContext value={{ state: state(curator), mutate, refresh: vi.fn(async () => {}), notify: vi.fn() }}><WeeklyReportPage onPublish={onPublish}/></WorkspaceContext>);
  return { mutate, onPublish };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows an honest published empty state without reader editing or publication controls', async () => {
  show({ weekStart: week, weeks: [week], published: [], own: null });
  await waitFor(() => expect(screen.getByText('За эту неделю опубликованных сводок пока нет')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Подготовить свою сводку' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'К публикации' })).toBeNull();
  expect(screen.getByText(/Текстовая сводка.*измеренные факты/i)).toBeTruthy();
});

it('renders all four published sections, author and date as safe text and loads the selected week', async () => {
  const previous = new Date(`${week}T00:00:00Z`); previous.setUTCDate(previous.getUTCDate() - 7); const previousWeek = previous.toISOString().slice(0, 10);
  show({ weekStart: week, weeks: [week, previousWeek], published: [record], own: null });
  await waitFor(() => expect(screen.getByText(record.summary)).toBeTruthy());
  for (const title of ['Главная сводка', 'Главные выполненные задачи УОР', 'Требует внимания', 'Планы следующей недели']) expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  expect(screen.getByRole('heading', { name: record.ownerName })).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText('Согласован план')).toBeTruthy(); expect(screen.getByText('25.10.2026')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Отчётная неделя'), { target: { value: previousWeek } });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/weekly-reports?weekStart=${previousWeek}`, expect.anything()));
});

it('edits only its own collapsed draft and preserves opened revision and entered text after a race', async () => {
  const mutation = vi.fn(async () => { throw new Error('Сводка уже изменилась'); });
  show({ weekStart: week, weeks: [week], published: [{ ...record, id: 'other', ownerId: 'b', ownerName: 'Борис — УОР', summary: 'Сводка коллеги' }], own: { record, visibility: 'local' } }, true, mutation);
  await waitFor(() => expect(screen.getByText('Собственный черновик · не опубликован')).toBeTruthy());
  expect(screen.queryByRole('textbox', { name: 'Главная сводка' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Изменить свою сводку' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Главная сводка' }), { target: { value: 'Моя сохранённая в форме правка' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сводка уже изменилась'));
  expect((screen.getByRole('textbox', { name: 'Главная сводка' }) as HTMLTextAreaElement).value).toBe('Моя сохранённая в форме правка');
  expect(mutation).toHaveBeenCalledWith('/api/weekly-reports', expect.objectContaining({ baseRevision: 'opened-revision', summary: 'Моя сохранённая в форме правка', weekStart: week }));
  expect(screen.queryByRole('button', { name: 'Изменить сводку коллеги' })).toBeNull();
});

it('saves four simple fields as a local draft and offers an explicit handoff to publication', async () => {
  const saved = { ...record, summary: 'Новая сводка', revision: 'saved-revision', completed: ['Первая задача', 'Вторая задача'], attention: [], nextWeek: ['Следующий шаг'] };
  const mutation = vi.fn(async () => ({ record: saved, draftId: 'draft-a' }));
  const { onPublish } = show({ weekStart: week, weeks: [week], published: [], own: null }, true, mutation);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Подготовить свою сводку' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Подготовить свою сводку' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Главная сводка' }), { target: { value: 'Новая сводка' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Главные выполненные задачи УОР' }), { target: { value: 'Первая задача\n\nВторая задача' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Планы следующей недели' }), { target: { value: 'Следующий шаг' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить черновик' }));
  await waitFor(() => expect(screen.getByText('Собственный черновик · не опубликован')).toBeTruthy());
  expect(mutation).toHaveBeenCalledWith('/api/weekly-reports', { weekStart: week, baseRevision: null, summary: 'Новая сводка', completed: ['Первая задача', 'Вторая задача'], attention: [], nextWeek: ['Следующий шаг'] });
  expect(screen.getByText(/Директор увидит сводку после публикации руководителем в main/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'К публикации' })); expect(onPublish).toHaveBeenCalledOnce();
});
