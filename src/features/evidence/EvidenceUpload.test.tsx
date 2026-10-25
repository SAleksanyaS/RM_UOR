// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceContext, type ClientState } from '../../app/AppContext';
import { EvidenceUpload } from './EvidenceUpload';
afterEach(cleanup);
function setup({ role = 'curator', disabled = false, mutate = vi.fn(async () => ({ evidence: { id: 'ev1', name: 'proof.txt', size: 5 } })) } = {}) {
  const onChange = vi.fn(), onUploadingChange = vi.fn();
  render(<WorkspaceContext value={{ state: { session: { role } } as ClientState, mutate, refresh: vi.fn(async () => {}), notify: vi.fn() }}><EvidenceUpload onChange={onChange} onUploadingChange={onUploadingChange} disabled={disabled}/></WorkspaceContext>);
  return { mutate, onChange, onUploadingChange };
}
it('uploads the file, reports evidence IDs and removes only the selection without another server mutation', async () => {
  let accept!: (value: { evidence: { id: string; name: string; size: number } }) => void;
  const mutate = vi.fn(() => new Promise<{ evidence: { id: string; name: string; size: number } }>(resolve => { accept = resolve; }));
  const { onChange, onUploadingChange } = setup({ mutate });
  fireEvent.change(screen.getByLabelText('Прикрепить доказательства'), { target: { files: [new File(['proof'], 'proof.txt')] } });
  await waitFor(() => expect(mutate).toHaveBeenCalledWith('/api/evidence', { name: 'proof.txt', base64: btoa('proof') }));
  expect(screen.getByRole('status').textContent).toContain('proof.txt');
  expect((screen.getByLabelText('Прикрепить доказательства') as HTMLInputElement).disabled).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
  accept({ evidence: { id: 'ev1', name: 'proof.txt', size: 5 } });
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(['ev1']));
  expect(screen.getByText('5 Б')).toBeTruthy(); expect(onUploadingChange.mock.calls).toEqual([[true], [false]]);
  fireEvent.click(screen.getByRole('button', { name: 'Убрать proof.txt из выбора' }));
  expect(onChange).toHaveBeenLastCalledWith([]); expect(screen.queryByText('proof.txt')).toBeNull(); expect(mutate).toHaveBeenCalledTimes(1);
});
it('keeps already attached evidence after a later failure or an oversized file', async () => {
  const mutate = vi.fn().mockResolvedValueOnce({ evidence: { id: 'ev1', name: 'proof.txt', size: 5 } }).mockRejectedValueOnce(new Error('Не удалось сохранить файл'));
  const { onChange } = setup({ mutate });
  fireEvent.change(screen.getByLabelText('Прикрепить доказательства'), { target: { files: [new File(['proof'], 'proof.txt')] } });
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(['ev1']));
  fireEvent.change(screen.getByLabelText('Прикрепить доказательства'), { target: { files: [new File(['other'], 'other.txt')] } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Не удалось сохранить файл'));
  expect(screen.getByText('proof.txt')).toBeTruthy(); expect(onChange).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Прикрепить доказательства'), { target: { files: [new File([new Uint8Array(5_000_001)], 'large.bin')] } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('5 МБ'));
  expect(mutate).toHaveBeenCalledTimes(2); expect(screen.getByText('proof.txt')).toBeTruthy();
});
it('provides no upload control to readers and respects an externally disabled form', () => {
  const reader = setup({ role: 'reader' }); expect(screen.queryByLabelText('Прикрепить доказательства')).toBeNull(); expect(reader.mutate).not.toHaveBeenCalled();
  cleanup(); const curator = setup({ disabled: true }); expect((screen.getByLabelText('Прикрепить доказательства') as HTMLInputElement).disabled).toBe(true); expect(curator.mutate).not.toHaveBeenCalled();
});
