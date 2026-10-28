// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchBrowserProfileForm } from './BrowserProfileForm';
afterEach(cleanup);
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
  fireEvent.change(screen.getByLabelText('Установленный браузер'), { target: { value: 'edge' } });
  fireEvent.change(screen.getByLabelText('Дополнительные сайты входа'), { target: { value: origin } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить личный профиль' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', message);
  expect(save).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Дополнительные сайты входа') as HTMLTextAreaElement).value).toBe(origin);
});
