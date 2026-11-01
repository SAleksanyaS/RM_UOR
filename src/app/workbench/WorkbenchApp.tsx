import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandRequest } from '../../server/workbench/protocol';
import { WorkbenchClient, WorkbenchApiError } from './api-client';
import { WorkbenchProvider, useGlobalContext, useWorkbench } from './context';
import { WorkbenchShell, workbenchErrorMessage, type WorkbenchViewRegistry } from './WorkbenchShell';
import { WorkbenchOverviewPage } from '../../features/overview/workbench/OverviewPage';
import { WorkbenchGoalsPage } from '../../features/overview/workbench/GoalsPage';
import { WorkbenchGoalDetailPage } from '../../features/overview/workbench/GoalDetailPage';
import { WorkbenchExecutionPage } from '../../features/execution/workbench/ExecutionPage';
import { WorkbenchDataPage } from '../../features/sources/workbench/WorkbenchDataPage';
import { WorkbenchCuratorPanel } from '../../features/publishing/workbench/CuratorPanel';
import { DashboardView } from '../../features/dashboards/workbench/DashboardView';
import { GlobalSearch } from '../../features/search/workbench/GlobalSearch';
import { MaintenancePanel } from '../../features/workspace-maintenance/workbench/MaintenancePanel';
import { OkoApp } from '../oko/OkoApp';
import { OkoClient } from '../../features/connectors/workbench/client';
import { GlobalContextControls } from './GlobalContextControls';
import '../../features/connectors/workbench/oko.css';
import './production-ui.css';

const defaultClient = new WorkbenchClient();
const defaultPersonal = new OkoClient(undefined, { prefix: 'oko.workflow' });
function Overview() { return <><WorkbenchOverviewPage /><DashboardView /></>; }
function LocalAccess() {
  const { session, client, refreshSession, loading } = useWorkbench();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [pending, setPending] = useState<CommandRequest | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setPending(null); setError(null); setBusy(false); return () => { generation.current++; }; }, [client, session?.personId]);
  if (session?.policyState !== 'local_preview' || !session.allowedCommands.includes('workbench.role.set')) return null;
  const apply = async (request: CommandRequest) => {
    const current = generation.current; setBusy(true); setError(null); setPending(request);
    try { await client.command(request); if (generation.current !== current) return; await refreshSession(); if (generation.current === current) setPending(null); }
    catch (failure) { if (generation.current === current) { setError(failure); if (failure instanceof WorkbenchApiError && failure.status >= 400 && failure.status < 500 && !['INVALID_RESPONSE', 'COMMAND_INTERRUPTED'].includes(failure.problem.code)) setPending(null); } }
    finally { if (generation.current === current) setBusy(false); }
  };
  return <div className="wb-local-access"><label htmlFor="wb-local-role">Режим работы</label><select id="wb-local-role" value={session.role} disabled={loading || busy || pending !== null} onChange={event => { void apply({ commandId: crypto.randomUUID(), name: 'workbench.role.set', baseRevision: null, payload: { role: event.target.value } }); }}><option value="viewer">Читатель</option><option value="curator">Редактор</option></select><small>Временные локальные роли</small>{error !== null && <div role="alert">{workbenchErrorMessage(error)}{pending && <button disabled={busy || loading} type="button" onClick={() => void apply(pending)}>Повторить смену режима</button>}</div>}</div>;
}
function Data({ personalClient }: { personalClient: OkoClient }) {
  const { context } = useGlobalContext(), { session } = useWorkbench();
  const [tab, setTab] = useState<'goals' | 'personal'>(() => context ? 'goals' : 'personal');
  const active = !context ? 'personal' : tab;
  return <section aria-label="Работа с данными"><div role="tablist" aria-label="Виды данных"><button id="wb-data-goals-tab" role="tab" aria-controls="wb-data-goals" aria-selected={active === 'goals'} disabled={!context} onClick={() => setTab('goals')}>Данные целей</button><button id="wb-data-personal-tab" role="tab" aria-controls="wb-data-personal" aria-selected={active === 'personal'} onClick={() => setTab('personal')}>Личные выгрузки ОКО</button></div>
    {!context && <p>Общий каталог пока не получен. Личный сценарий ОКО доступен; для данных целей получите опубликованный каталог или восстановите свою копию через обслуживание.</p>}
    {context && active === 'goals' && <div id="wb-data-goals" role="tabpanel" aria-labelledby="wb-data-goals-tab"><WorkbenchDataPage /></div>}
    <div id="wb-data-personal" role="tabpanel" aria-labelledby="wb-data-personal-tab" hidden={active !== 'personal'}><OkoApp key={session?.personId ?? 'unknown'} client={personalClient} embedded refreshKey={[session?.personId, session?.role, session?.policyState].join(':')} /></div>
  </section>;
}
function Empty({ personalClient }: { personalClient: OkoClient }) {
  const { pathname, navigate } = useGlobalContext();
  return pathname === '/data' ? <Data personalClient={personalClient} /> : <section><p>Получите опубликованный каталог из main или восстановите свою копию через «Обслуживание рабочего места».</p><button type="button" onClick={() => navigate('/data')}>Открыть личную выгрузку ОКО</button></section>;
}
export function WorkbenchApp({ client = defaultClient, personalClient = defaultPersonal }: { client?: WorkbenchClient; personalClient?: OkoClient } = {}) {
  const views = useMemo<WorkbenchViewRegistry>(() => ({ overview: Overview, goals: WorkbenchGoalsPage, goalDetail: WorkbenchGoalDetailPage, execution: WorkbenchExecutionPage, data: () => <Data personalClient={personalClient} />, uor: WorkbenchCuratorPanel, search: GlobalSearch, maintenance: MaintenancePanel, access: LocalAccess, context: GlobalContextControls, empty: () => <Empty personalClient={personalClient} /> }), [personalClient]);
  return <WorkbenchProvider client={client}><WorkbenchShell views={views} /></WorkbenchProvider>;
}
