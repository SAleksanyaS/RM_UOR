// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createWorkbenchUiHarness } from './testing/ui-harness';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  for (const close of closes.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('mobile_navigation_traps_focus_and_escape_returns_to_its_opener_without_losing_context', async () => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('767px'), media: query, addEventListener() {}, removeEventListener() {} })));
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  await h.open('/overview?cluster=' + fixtureId(103) + '&from=2026-10-20&to=2026-10-29&mode=agreed');
  const original = window.location.search;
  const opener = screen.getByRole('button', { name: 'Открыть меню' });
  opener.focus(); fireEvent.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Навигация рабочего места' });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  const close = within(dialog).getByRole('button', { name: 'Закрыть меню' });
  close.focus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.location.search).toBe(original);
  fireEvent.click(opener);
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Данные' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Данные', level: 1 })));
  expect(window.location.search).toBe(original);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('selecting the current mobile destination returns focus to the visible page heading', async () => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('767px'), media: query, addEventListener() {}, removeEventListener() {} })));
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }); closes.push(h.close);
  await h.open('/overview');
  const original = window.location.href;
  fireEvent.click(screen.getByRole('button', { name: 'Открыть меню' }));
  const dialog = await screen.findByRole('dialog', { name: 'Навигация рабочего места' });
  const current = within(dialog).getByRole('button', { name: 'Обзор' });
  current.focus(); fireEvent.click(current);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Обзор', level: 1 })));
  expect(window.location.href).toBe(original);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('mobile search remains available and returns focus when dismissed', async () => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('767px'), media: query, addEventListener() {}, removeEventListener() {} })));
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }, { views: { search: () => <form role="search"><label>Поиск по рабочему месту<input type="search" /></label></form> } }); closes.push(h.close);
  await h.open('/overview');
  const original = window.location.search;
  const opener = screen.getByRole('button', { name: 'Открыть поиск' });
  opener.focus(); fireEvent.click(opener);
  const input = screen.getByRole('searchbox', { name: 'Поиск по рабочему месту' });
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.keyDown(input, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(opener.getAttribute('aria-expanded')).toBe('false');
  expect(window.location.search).toBe(original);
});
