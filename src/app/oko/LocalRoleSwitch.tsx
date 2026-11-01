import React, { useState } from 'react';
import { useWorkbench } from '../../features/connectors/workbench/WorkbenchProvider';

export function LocalRoleSwitch() {
  const { session, run, busy } = useWorkbench(); const [error, setError] = useState('');
  if (session?.policyState !== 'local_preview') return null;
  return <label className="oko-local-role">Режим работы <select aria-label="Режим работы" value={session.role} disabled={busy} onChange={event => { setError(''); void run('source.browser.role.set', { role: event.target.value }).catch(failure => setError((failure as Error).message)); }}><option value="viewer">Читатель</option><option value="curator">Редактор</option></select><small>Временные локальные роли</small>{error && <span role="alert">{error}</span>}</label>;
}
