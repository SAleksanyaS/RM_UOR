// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { WorkbenchProvider } from '../../../app/workbench/context';
import { createWorkbenchApiHarness } from '../../../app/workbench/testing/api-harness';
import { RawTableArrangement } from './RawTableArrangement';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); for (const close of closes.splice(0))
    await close(); });
it('saves a personal raw-column order and reopens it from preferences without changing source columns', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'empty' });
    closes.push(h.close);
    const columns = [{ key: 'A', label: 'Первый' }, { key: 'B', label: 'Второй' }];
    const page = () => <WorkbenchProvider client={h.client}><RawTableArrangement sha256={'a'.repeat(64)} columns={columns}>{ordered => <p aria-label="Порядок">{ordered.map(c => c.key).join(',')}</p>}</RawTableArrangement></WorkbenchProvider>;
    const view = render(page());
    const move = await screen.findByRole('button', { name: 'Влево: Второй' });
    await waitFor(() => expect(move.matches(':disabled')).toBe(false));
    fireEvent.click(move);
    expect(screen.getByLabelText('Порядок').textContent).toBe('B,A');
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить личные столбцы' }));
    await screen.findByText('Личный порядок столбцов сохранён');
    view.unmount();
    render(page());
    await waitFor(() => expect(screen.getByLabelText('Порядок').textContent).toBe('B,A'));
    expect(columns.map(c => c.key)).toEqual(['A', 'B']);
});
