import React, { useState } from 'react';
import type { PrivateProfile } from '../contracts';
import type { OkoWorkflowView } from '../workbench-workflow-contracts';

export function WorkbenchBrowserProfileForm({ workflow, reportUrl, busy, onSave }: { workflow: OkoWorkflowView; reportUrl: string; busy: boolean; onSave(profile: PrivateProfile): Promise<unknown> }) {
  const saved = workflow.profile.profile;
  const [kind, setKind] = useState(saved?.browser?.channel === 'msedge' ? 'edge' : saved?.browser?.channel === 'chrome' ? 'chrome' : 'sber');
  const [executable, setExecutable] = useState(saved?.browser?.executablePath ?? '');
  const [directory, setDirectory] = useState(saved?.browser?.profileDirectory ?? 'oko');
  const [origins, setOrigins] = useState((saved?.allowedOrigins ?? []).filter(origin => { try { return origin !== new URL(reportUrl).origin; } catch { return true; } }).join('\n'));
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    try {
      const parseUrl = (value: string, message: string) => { try { return new URL(value); } catch { throw new Error(message); } };
      const reportMessage = 'Укажите полный адрес отчёта без учётных данных.';
      const originMessage = 'Для сайтов входа укажите точные адреса вида https://sso.example без пути.';
      const report = parseUrl(reportUrl, reportMessage); if (!['http:', 'https:'].includes(report.protocol) || report.username || report.password) throw new Error(reportMessage);
      const allowedOrigins = [report.origin, ...origins.split(/[\n,]+/).map(value => value.trim()).filter(Boolean).map(value => { const url = parseUrl(value, originMessage); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error(originMessage); return url.origin; })];
      if (kind === 'sber' && !executable.trim()) throw new Error('Укажите путь к установленному СберБраузеру.');
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(directory)) throw new Error('Имя профиля: латинские буквы, цифры, дефис или подчёркивание.');
      await onSave({ ...saved, allowedOrigins: [...new Set(allowedOrigins)], maxBytes: saved?.maxBytes ?? 10485760, timeoutMs: saved?.timeoutMs ?? 120000, retries: saved?.retries ?? 1, browser: { ...saved?.browser, ...(kind !== 'sber' ? { channel: kind === 'chrome' ? 'chrome' : 'msedge', executablePath: undefined } : { executablePath: executable.trim(), channel: undefined }), profileDirectory: directory, headless: false } });
    } catch (failure) { setError((failure as Error).message); }
  };
  return <form onSubmit={event => void submit(event)} className="oko-form">
    <div className="oko-field"><label htmlFor="browser-kind">Установленный браузер</label><select id="browser-kind" value={kind} onChange={event => setKind(event.target.value)}><option value="sber">СберБраузер</option><option value="chrome">Google Chrome — локальная проверка</option><option value="edge">Microsoft Edge — локальная проверка</option></select></div>
    {kind === 'sber' && <div className="oko-field"><label htmlFor="browser-exe">Путь к СберБраузеру</label><input id="browser-exe" value={executable} onChange={event => setExecutable(event.target.value)} placeholder="C:\…\browser.exe" autoComplete="off" /></div>}
    <div className="oko-field"><label htmlFor="profile-dir">Имя личного профиля</label><input id="profile-dir" value={directory} onChange={event => setDirectory(event.target.value)} /><small>Отдельная сохраняемая сессия на этом рабочем месте. Существующий открытый профиль не копируется.</small></div>
    <div className="oko-field"><label htmlFor="login-origins">Дополнительные сайты входа</label><textarea id="login-origins" value={origins} onChange={event => setOrigins(event.target.value)} placeholder="https://sso.example" rows={2}/><small>Только известные вам адреса SSO, по одному на строку. Сайт отчёта добавится автоматически.</small></div>
    {error && <p role="alert" className="oko-error">{error}</p>}
    <button className="oko-primary" disabled={busy || !reportUrl.trim()} type="submit">Сохранить личный профиль</button>
  </form>;
}
