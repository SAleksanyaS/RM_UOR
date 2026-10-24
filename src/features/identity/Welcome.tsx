import { ArrowRight, KeyRound, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { useDialog, useWorkspace } from '../../app/AppContext';

export function Welcome({ onClose }: { onClose: () => void }) {
  useDialog(onClose);
  const { mutate, notify } = useWorkspace();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function login() { setBusy(true); setError(''); try { await mutate('/api/login', { role: 'curator', code }); notify('Добро пожаловать в рабочее место куратора УОР'); onClose(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }
  return <div className="modal-overlay" onClick={onClose}><form className="modal welcome-modal" onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void login(); }}><div className="modal-heading"><span className="welcome-emblem"><ShieldCheck size={29}/></span><button className="icon-button" type="button" aria-label="Закрыть" onClick={onClose}><X size={20}/></button></div><span className="eyebrow">УПРАВЛЕНИЕ ОБЕСПЕЧЕНИЯ РАЗВИТИЯ</span><h2>Вы куратор УОР?</h2><p>Войдите по персональному коду, чтобы редактировать цели, проверять результаты и публиковать общие данные.</p><label className="field">Персональный код<div className="code-input"><KeyRound size={17}/><input autoFocus type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} placeholder="Введите код куратора"/></div></label>{error && <div className="error-inline" role="alert">{error}</div>}<button className="button primary full" disabled={busy || !code.trim()}>{busy ? 'Проверяем…' : 'Войти как куратор'}<ArrowRight size={16}/></button><button type="button" className="reader-button" onClick={onClose}>Я читатель — продолжить просмотр</button><small>Права записи в Git определяются отдельным доступом к репозиторию.</small></form></div>;
}
