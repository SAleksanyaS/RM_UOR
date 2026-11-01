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
import { PersonalOkoWorkspace } from '../../features/connectors/workbench/PersonalOkoWorkspace';
import { FolderOpen, ArrowRight } from 'lucide-react';
import { OkoClient } from '../../features/connectors/workbench/client';
import { GlobalContextControls } from './GlobalContextControls';
import '../../features/connectors/workbench/oko.css';
import './production-ui.css';

const defaultClient = new WorkbenchClient();
const defaultPersonal = new OkoClient(undefined, { prefix: 'oko.workflow' });
function Overview() { return <><WorkbenchOverviewPage /><details className="wb-dashboard-disclosure"><summary>Мои дашборды и настройки представления</summary><DashboardView /></details></>; }
function LocalAccess() {
  const { session, client, refreshSession, loading } = useWorkbench();
  const { approveLeave } = useGlobalContext();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [pending, setPending] = useState<CommandRequest | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setPending(null); setError(null); setBusy(false); return () => { generation.current++; }; }, [client, session?.personId]);
  if (session?.policyState !== 'local_preview' || !session.allowedCommands.includes('workbench.role.set')) return null;
  const apply = async (request: CommandRequest) => {
    // A role refresh can remove an editor. Ask before any request, including
    // recovery after the user may have entered more data; retain its same ID.
    if (!approveLeave()) return;
    const current = generation.current; setBusy(true); setError(null); setPending(request);
    try { await client.command(request); if (generation.current !== current) return; await refreshSession(); if (generation.current === current) setPending(null); }
    catch (failure) { if (generation.current === current) { setError(failure); if (failure instanceof WorkbenchApiError && failure.status >= 400 && failure.status < 500 && !['INVALID_RESPONSE', 'COMMAND_INTERRUPTED'].includes(failure.problem.code)) setPending(null); } }
    finally { if (generation.current === current) setBusy(false); }
  };
  return <div className="wb-local-access"><label className="wb-visually-hidden" htmlFor="wb-local-role">Режим работы</label><select id="wb-local-role" value={session.role} disabled={loading || busy || pending !== null} onChange={event => { void apply({ commandId: crypto.randomUUID(), name: 'workbench.role.set', baseRevision: null, payload: { role: event.target.value } }); }}><option value="viewer">Читатель</option><option value="curator">Редактор</option></select><small title="Временные локальные роли; это не банковский допуск">Локальный режим</small>{error !== null && <div role="alert">{workbenchErrorMessage(error)}{pending && <button disabled={busy || loading} type="button" onClick={() => void apply(pending)}>Повторить смену режима</button>}</div>}</div>;
}
function Data({ personalClient }: { personalClient: OkoClient }) {
  const { context, navigate } = useGlobalContext(), { session } = useWorkbench();
  const active = !context || window.location.hash === '#personal-oko' ? 'personal' : 'goals';
  const setTab = (tab: 'goals' | 'personal') => navigate(tab === 'personal' ? '/data#personal-oko' : '/data');
  return <section className="wb-data-workspace" aria-label="Работа с данными"><div className="wb-data-tabs" role="tablist" aria-label="Виды данных"><button id="wb-data-goals-tab" role="tab" aria-controls="wb-data-goals" aria-selected={active === 'goals'} disabled={!context} onClick={() => setTab('goals')}>Данные целей</button><button id="wb-data-personal-tab" role="tab" aria-controls="wb-data-personal" aria-selected={active === 'personal'} onClick={() => setTab('personal')}>Личные выгрузки ОКО</button></div>
    {!context && <p>Общий каталог пока не получен. Личный сценарий ОКО доступен; для данных целей получите опубликованный каталог или восстановите свою копию через обслуживание.</p>}
    {context && active === 'goals' && <div id="wb-data-goals" role="tabpanel" aria-labelledby="wb-data-goals-tab"><WorkbenchDataPage /></div>}
    <div id="wb-data-personal" role="tabpanel" aria-labelledby="wb-data-personal-tab" hidden={active !== 'personal'}><PersonalOkoWorkspace key={session?.personId ?? 'unknown'} client={personalClient} refreshKey={[session?.personId, session?.role, session?.policyState].join(':')} /></div>
  </section>;
}
function Empty({ personalClient }: { personalClient: OkoClient }) {
  const { pathname, navigate } = useGlobalContext();
  return pathname === '/data' ? <Data personalClient={personalClient} /> : <section className="wb-empty-workspace"><span className="wb-empty-icon"><FolderOpen size={34} aria-hidden="true" /></span><span className="wb-eyebrow">Новое рабочее место</span><h2>Пока нет общего каталога</h2><p>Получите опубликованный каталог из main или восстановите свою копию через «Обслуживание рабочего места».</p><p>Личные выгрузки ОКО уже доступны — для них общий каталог не нужен.</p><button type="button" className="wb-primary-button" onClick={() => navigate('/data')}>Открыть личную выгрузку ОКО<ArrowRight size={17} aria-hidden="true" /></button><div className="wb-empty-guide"><p><strong>1. Подключите рабочие данные</strong><span>Обслуживание → получение каталога или восстановление своей копии</span></p><p><strong>2. Выберите область и дату</strong><span>Появятся опубликованные цели, ответственные и основания</span></p><p><strong>3. Начните с очереди внимания</strong><span>Обзор покажет отклонения и следующие действия</span></p></div></section>;
}
export function WorkbenchApp({ client = defaultClient, personalClient = defaultPersonal }: { client?: WorkbenchClient; personalClient?: OkoClient } = {}) {
  const views = useMemo<WorkbenchViewRegistry>(() => ({ overview: Overview, goals: WorkbenchGoalsPage, goalDetail: WorkbenchGoalDetailPage, execution: WorkbenchExecutionPage, data: () => <Data personalClient={personalClient} />, uor: WorkbenchCuratorPanel, search: GlobalSearch, maintenance: MaintenancePanel, access: LocalAccess, context: GlobalContextControls, empty: () => <Empty personalClient={personalClient} /> }), [personalClient]);
  return <WorkbenchProvider client={client}><WorkbenchShell views={views} /></WorkbenchProvider>;
}
