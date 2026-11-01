// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createWorkbenchUiHarness } from './testing/ui-harness';
import { useGlobalContext } from './context';
import { useUnsavedChanges } from './use-unsaved-changes';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const close of closes.splice(0)) await close(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
function Editor() {
  const [value, setValue] = useState(''), [dirty, setDirty] = useState(false), [closed, setClosed] = useState(false);
  const leave = useUnsavedChanges(dirty), { setContext } = useGlobalContext();
  return closed ? <p>Редактор закрыт</p> : <><label>Личный ввод<input value={value} onChange={event => { setValue(event.target.value); setDirty(true); }} /></label><button onClick={() => setDirty(false)}>Зафиксировать ввод</button><button onClick={() => leave(() => setClosed(true))}>Закрыть редактор</button><button onClick={() => void setContext({ time: { kind: 'as_of', date: '2026-10-29' } })}>Изменить дату</button></>;
}
it('retains dirty input and scope when leaving is declined, and leaves on explicit confirmation', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }, { views: { overview: Editor, goals: () => <p>Каталог целей</p> } }); closes.push(h.close);
  await h.open('/overview'); const initial = window.location.href;
  fireEvent.change(screen.getByLabelText('Личный ввод'), { target: { value: 'Несохранённое описание' } });
  fireEvent.click(screen.getByRole('button', { name: 'Цели' }));
  expect(window.location.href).toBe(initial);
  expect((screen.getByLabelText('Личный ввод') as HTMLInputElement).value).toBe('Несохранённое описание');
  fireEvent.click(screen.getByRole('button', { name: 'Изменить дату' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
  expect(window.location.href).toBe(initial);
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть редактор' }));
  expect(screen.queryByText('Редактор закрыт')).toBeNull();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Цели' }));
  await screen.findByText('Каталог целей');
  expect(window.location.pathname).toBe('/goals');
});
it('guards browser history and unload but stops prompting after the form is saved', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const h = await createWorkbenchUiHarness({ role: 'viewer', scenario: 'scope-split' }, { views: { overview: Editor, goals: () => <p>Каталог целей</p> } }); closes.push(h.close);
  await h.open('/overview'); const initial = window.location.href;
  fireEvent.change(screen.getByLabelText('Личный ввод'), { target: { value: 'Сохранить позже' } });
  const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  await act(async () => { window.history.pushState(null, '', '/goals'); window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(window.location.href).toBe(initial);
  expect((screen.getByLabelText('Личный ввод') as HTMLInputElement).value).toBe('Сохранить позже');
  fireEvent.click(screen.getByRole('button', { name: 'Зафиксировать ввод' }));
  const savedUnload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(savedUnload); expect(savedUnload.defaultPrevented).toBe(false);
  confirm.mockClear(); fireEvent.click(screen.getByRole('button', { name: 'Цели' }));
  await screen.findByText('Каталог целей'); expect(confirm).not.toHaveBeenCalled();
});
