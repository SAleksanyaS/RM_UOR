import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { useWorkbench } from '../../../app/workbench/context';
import { workbenchErrorMessage } from '../../../app/workbench/WorkbenchShell';
import type { EnvironmentDiagnostics } from './environment-query';

export function DiagnosticDownload() {
  const { client, session } = useWorkbench();
  const [commandId, setCommandId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const owner = useRef(new AbortController());
  useEffect(() => {
    const current = new AbortController(); owner.current = current;
    setBusy(false); setMessage(null); setCommandId('');
    return () => current.abort();
  }, [client, session?.personId]);
  async function download() {
    if (busy) return;
    const signal = owner.current.signal;
    setBusy(true); setMessage(null);
    try {
      const { data } = await client.query<EnvironmentDiagnostics>('environment.diagnostics', {
        context: null, filter: commandId.trim() ? { commandId: commandId.trim() } : {},
        sort: [], page: { limit: 1, cursor: null },
      }, { signal });
      if (signal.aborted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url;
      link.download = 'rm-uor-diagnostics-' + data.generatedAt.slice(0, 10) + '.json';
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('Файл диагностики подготовлен. Проверьте его перед передачей поддержке.');
    } catch (error) { if (!signal.aborted) setMessage(workbenchErrorMessage(error, 'read')); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return <section className="wb-diagnostics" aria-label="Диагностика для поддержки">
    <h3>Помощь с рабочим местом</h3>
    <p>Скачайте версии, состояние среды и, при необходимости, статус выбранной операции. Исходники, адреса, профили, секреты и текст журналов в этот файл не входят.</p>
    <label>Идентификатор команды (необязательно)
      <input value={commandId} onChange={event => setCommandId(event.target.value)} disabled={busy} placeholder="UUID из сообщения о сохранении" autoComplete="off"/>
    </label>
    <button type="button" disabled={busy} onClick={() => void download()}><Download size={16} aria-hidden="true"/>{busy ? 'Собираем диагностику…' : 'Скачать диагностику'}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
