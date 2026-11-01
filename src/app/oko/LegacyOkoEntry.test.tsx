// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createPersonalRuntime } from '../../../tests/fixtures/workbench/personal-runtime';
import { WorkbenchClient } from '../workbench/api-client';
import { LegacyOkoEntry } from './LegacyOkoEntry';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0).reverse()) await close(); });
it('old bookmark enters the combined Data screen after an actual read-only namespace probe', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close); const redirect = vi.fn();
  render(<LegacyOkoEntry client={new WorkbenchClient({ fetch: f.fetcher })} redirect={redirect} />);
  await waitFor(() => expect(redirect).toHaveBeenCalledWith('/data'));
  expect(f.requests.some(request => request.body?.name)).toBe(false);
});
it('standalone entry remains available only after a definite missing combined query', async () => {
  const f = await createPersonalRuntime('source.browser'); closes.push(f.close); const redirect = vi.fn();
  render(<LegacyOkoEntry client={new WorkbenchClient({ fetch: f.fetcher })} redirect={redirect} standalone={<p>Самостоятельная выгрузка</p>} />);
  await screen.findByText('Самостоятельная выгрузка');
  expect(redirect).not.toHaveBeenCalled();
});
it('an unavailable server gives a retry instead of opening the conflicting legacy workflow', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
  render(<LegacyOkoEntry client={new WorkbenchClient({ fetch: fetcher })} redirect={vi.fn()} standalone={<p>Самостоятельная выгрузка</p>} />);
  await screen.findByRole('alert');
  expect(screen.queryByText('Самостоятельная выгрузка')).toBeNull();
  expect(screen.getByRole('button', { name: 'Повторить загрузку' })).toBeTruthy();
});
