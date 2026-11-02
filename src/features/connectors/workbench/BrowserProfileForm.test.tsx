// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchBrowserProfileForm } from './BrowserProfileForm';
afterEach(cleanup);
it('offers only SberBrowser and fills the single detected compatible installation without copying a session', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const detect = vi.fn().mockResolvedValue({ targetVersion: '152.0.7977.120', message: 'Найден СберБраузер', candidates: [{ executablePath: '/opt/Sberbrowser/sberbrowser/sberbrowser', version: '152.0.7977.120', status: 'compatible' }] });
  render(<WorkbenchBrowserProfileForm workflow={{ profile: { profile: { browser: { channel: 'chrome', profileDirectory: 'own' }, allowedOrigins: ['https://oko.example'] } } } as never} reportUrl="https://oko.example/report" busy={false} onSave={save} onDetect={detect}/>);
  expect(screen.queryAllByRole('option', { name: /Chrome|Edge/ })).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Найти СберБраузер' }));
  await waitFor(() => expect((screen.getByLabelText('Путь к СберБраузеру') as HTMLInputElement).value).toBe('/opt/Sberbrowser/sberbrowser/sberbrowser'));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить личный профиль' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][0].browser).toMatchObject({ channel: undefined, executablePath: '/opt/Sberbrowser/sberbrowser/sberbrowser', profileDirectory: 'own', headless: false });
});
it('saves an own visible profile with exact report and SSO origins, retaining input on failure', async () => {
  const save = vi.fn().mockRejectedValue(new Error('Профиль занят'));
  render(<WorkbenchBrowserProfileForm workflow={{ workflowId: 'own', revision: 'r1', reportUrl: 'https://oko.example/report', profile: { profile: null } } as never} reportUrl="https://oko.example/report" busy={false} onSave={save} />);
  fireEvent.change(screen.getByLabelText('Путь к СберБраузеру'), { target: { value: 'C:\\Browser\\browser.exe' } });
  fireEvent.change(screen.getByLabelText('Дополнительные сайты входа'), { target: { value: 'https://sso.example' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить личный профиль' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][0]).toMatchObject({ allowedOrigins: ['https://oko.example', 'https://sso.example'], browser: { executablePath: 'C:\\Browser\\browser.exe', headless: false } });
  expect((screen.getByLabelText('Путь к СберБраузеру') as HTMLInputElement).value).toBe('C:\\Browser\\browser.exe');
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Профиль занят');
  expect(screen.queryByLabelText(/CSS|JSON|пароль/i)).toBeNull();
});
it.each([
  ['ьт', '', 'Укажите полный адрес отчёта без учётных данных.'],
  ['https://oko.example/report', 'о', 'Для сайтов входа укажите точные адреса вида https://sso.example без пути.'],
])('shows a Russian field message for malformed URL input %s / %s', async (reportUrl, origin, message) => {
  const save = vi.fn();
  render(<WorkbenchBrowserProfileForm workflow={{ profile: { profile: null } } as never} reportUrl={reportUrl} busy={false} onSave={save}/>);
  fireEvent.change(screen.getByLabelText('Путь к СберБраузеру'), { target: { value: '/opt/Sberbrowser/sberbrowser/sberbrowser' } });
  fireEvent.change(screen.getByLabelText('Дополнительные сайты входа'), { target: { value: origin } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить личный профиль' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', message);
  expect(save).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Дополнительные сайты входа') as HTMLTextAreaElement).value).toBe(origin);
});
