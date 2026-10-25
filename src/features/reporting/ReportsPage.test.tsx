// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { ReportsPage } from './ReportsPage';
import type { ReportRow, ReportSnapshot } from './report-contracts';
afterEach(cleanup);
function state(): ClientState { return { catalog: { id: 'c', name: 'Каталог примера', schemaVersion: 1, classification: 'demo', importedAt: '', goals: [{ id: 'g', title: 'Цель примера', category: 'process', metric: '', target: '', summary: '', status: '', actions: [], links: [], scopeType: '', ownerId: null, curatorId: null, officialTarget: 80, internalTarget: null, unit: '%', direction: 'increase', baseline: null, weight: null, priority: null, dueDate: null, revision: 'r' }], leaders: [{ id: 'l', name: 'Лидер примера', teams: [] }], assignments: [], sources: [], comments: [], entities: [] }, snapshots: [], attestations: [], evaluations: [], session: { id: 'reader', role: 'reader', curatorId: null, name: 'Просмотр', createdAt: '' }, csrfToken: 'token', operations: [], changes: [], drafts: [], version: '', repository: { url: '', publishedBranch: '', releaseBranch: '', publicationMode: '' }, updates: { status: 'current', checkedAt: null, currentCommit: null, remoteCommit: null, message: '', changes: [] } }; }
it('lets a reader choose report scope and keeps generated exports fixed when selection changes', async () => {
  const report: ReportSnapshot = { id: 'frozen', createdAt: '2026-10-25T10:00:00Z', createdBy: 'Просмотр', selection: { goalIds: ['g'], leaderIds: ['l'], period: '2026-10-20' }, template: { id: 'builtin', version: '1', name: 'Встроенный' }, versions: { application: '1', catalog: 'c', facts: 'f', confirmations: 'a' }, catalogName: 'Каталог', classification: 'demo', rows: [], limitations: [], summary: { goals: 1, confirmed: 0, pending: 1, notMet: 0, unknown: 0 } };
  report.rows = [{ goalId: 'g', goalTitle: 'Цель примера', leaderId: null, leaderName: 'ДИТ', unit: 'мс', officialTargetLabel: '10–20 мс', officialDueDate: null, evaluation: { actual: 15, officialTarget: null, official: 'met', validation: 'pending' } as ReportRow['evaluation'], comments: [], plan: null, sources: [], confirmation: null, availablePeriods: [] }];
  const mutate = vi.fn(async (_path: string, _body?: unknown) => report);
  render(<WorkspaceContext value={{ state: state(), mutate, notify: vi.fn(), refresh: vi.fn(async () => {}) }}><ReportsPage/></WorkspaceContext>);
  expect(screen.queryByText('Сохранить состав')).toBeNull();
  fireEvent.change(screen.getByLabelText('Период фактов'), { target: { value: '2026-10-20' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сформировать снимок' }));
  await waitFor(() => expect(screen.getByRole('link', { name: 'Скачать PPTX' }).getAttribute('href')).toBe('/api/reports/frozen/pptx'));
  expect(mutate).toHaveBeenCalledWith('/api/reports', { goalIds: ['g'], leaderIds: ['l'], period: '2026-10-20' });
  expect(screen.getByText('10–20 мс')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Период фактов'), { target: { value: '2026-10-21' } });
  fireEvent.click(screen.getByLabelText('Лидер примера'));
  expect(mutate).toHaveBeenCalledTimes(1); expect(screen.getByText('Снимок за 2026-10-20')).toBeTruthy(); expect(screen.getByRole('link', { name: 'Скачать PPTX' }).getAttribute('href')).toBe('/api/reports/frozen/pptx');
});
