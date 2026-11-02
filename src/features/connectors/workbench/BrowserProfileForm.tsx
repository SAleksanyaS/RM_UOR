import { SharedBrowserProfileForm, type SharedBrowserProfileProps } from './SharedBrowserProfileForm';
import React, { useEffect, useRef, useState } from 'react';
import type { PrivateProfile } from '../contracts';
import type { OkoWorkflowView } from '../workbench-workflow-contracts';
import { useUnsavedChanges } from '../../../app/workbench/use-unsaved-changes';
import type { BrowserEnvironment } from '../../system/workbench/environment-query';

export function PersonalBrowserProfileForm({ workflow, reportUrl, busy, onSave, onDirtyChange, onDetect }: { workflow: OkoWorkflowView; reportUrl: string; busy: boolean; onSave(profile: PrivateProfile): Promise<unknown>; onDirtyChange?(dirty: boolean): void; onDetect?(): Promise<BrowserEnvironment> }) {
  const saved = workflow.profile.profile;
  const [executable, setExecutable] = useState(saved?.browser?.executablePath ?? '');
  const [directory, setDirectory] = useState(saved?.browser?.profileDirectory ?? 'oko');
  const [origins, setOrigins] = useState((saved?.allowedOrigins ?? []).filter(origin => { try { return origin !== new URL(reportUrl).origin; } catch { return true; } }).join('\n'));
  const [error, setError] = useState('');
  const [discovery, setDiscovery] = useState<BrowserEnvironment | null>(null), [detecting, setDetecting] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const detect = async () => {
    if (!onDetect) return;
    const current = generation.current; setDetecting(true); setError('');
    try {
      const result = await onDetect();
      if (current !== generation.current) return;
      setDiscovery(result);
      const compatible = result.candidates.filter(candidate => candidate.status === 'compatible');
      if (compatible.length === 1) setExecutable(compatible[0].executablePath);
    } catch { if (current === generation.current) setError('Автопоиск недоступен. Укажите путь СберБраузера вручную или проверьте подготовку с ИТ.'); }
    finally { if (current === generation.current) setDetecting(false); }
  };
  const savedOrigins = (saved?.allowedOrigins ?? []).filter(origin => { try { return origin !== new URL(reportUrl).origin; } catch { return true; } }).join('\n');
  const dirty = executable !== (saved?.browser?.executablePath ?? '') || directory !== (saved?.browser?.profileDirectory ?? 'oko') || origins !== savedOrigins;
  useUnsavedChanges(dirty);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    try {
      const parseUrl = (value: string, message: string) => { try { return new URL(value); } catch { throw new Error(message); } };
      const reportMessage = 'Укажите полный адрес отчёта без учётных данных.';
      const originMessage = 'Для сайтов входа укажите точные адреса вида https://sso.example без пути.';
      const report = parseUrl(reportUrl, reportMessage); if (!['http:', 'https:'].includes(report.protocol) || report.username || report.password) throw new Error(reportMessage);
      const allowedOrigins = [report.origin, ...origins.split(/[\n,]+/).map(value => value.trim()).filter(Boolean).map(value => { const url = parseUrl(value, originMessage); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error(originMessage); return url.origin; })];
      if (!executable.trim()) throw new Error('Найдите СберБраузер или укажите путь к установленному браузеру.');
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(directory)) throw new Error('Имя профиля: латинские буквы, цифры, дефис или подчёркивание.');
      await onSave({ ...saved, allowedOrigins: [...new Set(allowedOrigins)], maxBytes: saved?.maxBytes ?? 10485760, timeoutMs: saved?.timeoutMs ?? 120000, retries: saved?.retries ?? 1, browser: { ...saved?.browser, executablePath: executable.trim(), channel: undefined, profileDirectory: directory, headless: false } });
    } catch (failure) { setError((failure as Error).message); }
  };
  return <form onSubmit={event => void submit(event)} className="oko-form">
    <p><strong>СберБраузер</strong> · целевая версия 152.0.7977.120</p>
    {onDetect && <button type="button" disabled={busy || detecting} onClick={() => void detect()}>{detecting ? 'Ищем установленный браузер…' : 'Найти СберБраузер'}</button>}
    {discovery && <div role="status"><p>{discovery.message}</p>{discovery.candidates.length > 1 && <ul>{discovery.candidates.map(candidate => <li key={candidate.executablePath}><code>{candidate.executablePath}</code>{' '}<span>{candidate.version ?? 'Версия не подтверждена'}</span>{candidate.status === 'compatible' && <button type="button" disabled={busy} onClick={() => setExecutable(candidate.executablePath)}>Выбрать этот путь</button>}</li>)}</ul>}</div>}
    <div className="oko-field"><label htmlFor="browser-exe">Путь к СберБраузеру</label><input id="browser-exe" value={executable} onChange={event => setExecutable(event.target.value)} placeholder="Абсолютный путь установленного браузера" autoComplete="off" /><small>Путь можно определить кнопкой выше. Сеанс другого пользователя не копируется.</small></div>
    <div className="oko-field"><label htmlFor="profile-dir">Имя личного профиля</label><input id="profile-dir" value={directory} onChange={event => setDirectory(event.target.value)} /><small>Отдельная сохраняемая сессия на этом рабочем месте. Существующий открытый профиль не копируется.</small></div>
    <div className="oko-field"><label htmlFor="login-origins">Дополнительные сайты входа</label><textarea id="login-origins" value={origins} onChange={event => setOrigins(event.target.value)} placeholder="https://sso.example" rows={2}/><small>Только известные вам адреса SSO, по одному на строку. Сайт отчёта добавится автоматически.</small></div>
    {error && <p role="alert" className="oko-error">{error}</p>}
    <button className="oko-primary" disabled={busy || !reportUrl.trim()} type="submit">Сохранить личный профиль</button>
  </form>;
}

export function WorkbenchBrowserProfileForm(props: SharedBrowserProfileProps | Parameters<typeof PersonalBrowserProfileForm>[0]) { return 'sourceRef' in props ? <SharedBrowserProfileForm {...props} /> : <PersonalBrowserProfileForm {...props} />; }
