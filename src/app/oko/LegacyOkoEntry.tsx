import { useEffect, useState, type ReactNode } from 'react';
import { WorkbenchApiError, WorkbenchClient } from '../workbench/api-client';
import { workbenchErrorMessage } from '../workbench/WorkbenchShell';
import { OkoApp } from './OkoApp';

const defaultClient = new WorkbenchClient();
const redirectToData = (url: string) => window.location.replace(url);
/** A saved standalone bookmark must not send its old commands to the combined API. */
export function LegacyOkoEntry({ client = defaultClient, redirect = redirectToData, standalone = <OkoApp /> }: { client?: WorkbenchClient; redirect?: (url: string) => void; standalone?: ReactNode } = {}) {
  const [mode, setMode] = useState<'loading' | 'standalone' | 'redirect'>('loading');
  const [error, setError] = useState<unknown>(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true; setMode('loading'); setError(null);
    void (async () => {
      try {
        await client.session();
        await client.query('oko.workflow.workspace', { context: null, filter: {}, sort: [], page: { limit: 1, cursor: null } });
        if (active) { setMode('redirect'); redirect('/data'); }
      } catch (failure) {
        if (!active) return;
        if (failure instanceof WorkbenchApiError && failure.status === 404 && failure.problem.code === 'QUERY_NOT_FOUND') setMode('standalone');
        else setError(failure);
      }
    })();
    return () => { active = false; };
  }, [client, redirect, revision]);
  if (mode === 'standalone') return standalone;
  return <main><h1>Личная выгрузка ОКО</h1>{error !== null ? <div role="alert">{workbenchErrorMessage(error, 'read')} <button onClick={() => setRevision(value => value + 1)}>Повторить загрузку</button></div> : <p>{mode === 'redirect' ? 'Открываем раздел «Данные»…' : 'Подключаем рабочее место…'}</p>}</main>;
}
