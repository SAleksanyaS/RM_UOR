// @vitest-environment jsdom
import { it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { WorkbenchProvider } from '../../../app/workbench/context';
import { createWorkbenchApiHarness } from '../../../app/workbench/testing/api-harness';
import { FileImport } from './WorkbenchDataPage';
import { File as NativeFile } from 'node:buffer';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of closes.splice(0))
    await close(); });
it('stages saved bytes into existing import preview and accepts only explicit reviewed rows', async () => {
    const native = await new Request('http://localhost', { method: 'POST', body: '', headers: { 'content-type': 'application/x-www-form-urlencoded' } }).formData();
    vi.stubGlobal('FormData', native.constructor);
    vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor);
    const h = await createWorkbenchApiHarness({ role: 'curator', scenario: 'partial-file' });
    closes.push(h.close);
    const session = await h.client.session();
    const goalId = session.data.defaultContext!.goalId!;
    const upload = await h.client.upload(new NativeFile(['ID;Value;Start;End\nA;65;2026-10-01;2026-11-01'], 'saved.csv', { type: 'text/csv' }) as any, 'goal-import');
    const original = h.client.command.bind(h.client);
    let staged = 0;
    vi.spyOn(h.client, 'command').mockImplementation(async (request) => { if (request.name === 'raw.file.stageForImport') {
        staged++;
        return { ...session, data: { commandId: request.commandId, result: upload.data, changedRefs: [], editToken: null } } as any;
    } return original(request); });
    render(<WorkbenchProvider client={h.client}><FileImport goalId={goalId} rawFileId="10000000-0000-4000-8000-000000000099" onApplied={() => { }}/></WorkbenchProvider>);
    const check = await screen.findByRole('button', { name: 'Проверить файл' });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(check);
    await screen.findByRole('region', { name: 'Предпросмотр импорта' }, { timeout: 5000 });
    expect(staged).toBe(1);
    expect(h.requests.filter(r => r.body?.name === 'import.apply')).toHaveLength(0);
    expect(screen.queryByLabelText('Файл данных')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Выбрать корректные строки' }));
    fireEvent.click(screen.getByRole('button', { name: 'Принять выбранные строки' }));
    await screen.findByText('Принято: 1; не принято: 0', {}, { timeout: 5000 });
    expect(h.requests.filter(r => r.body?.name === 'import.apply')).toHaveLength(1);
});
