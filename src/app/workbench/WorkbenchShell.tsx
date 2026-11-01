import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useGlobalContext, useWorkbench } from './context';
import { WorkbenchApiError } from './api-client';
import { WorkbenchNavigation, hasWorkbenchPreparation, workbenchDestinations } from './WorkbenchNavigation';
import { WelcomeToast } from './WelcomeToast';
import { NotificationCenter } from './NotificationCenter';
import './workbench.css';

export type WorkbenchViewRegistry = {
  overview?: ComponentType; goals?: ComponentType; goalDetail?: ComponentType<{ goalId: string }>;
  execution?: ComponentType; data?: ComponentType; uor?: ComponentType; search?: ComponentType; maintenance?: ComponentType<{ onClose(): void }>;
  access?: ComponentType; empty?: ComponentType; context?: ComponentType;
};
export function workbenchErrorMessage(error: unknown, operation: 'read' | 'mutation' = 'mutation'): string {
  if (operation === 'mutation' && (!(error instanceof WorkbenchApiError) || error.problem.code === 'INVALID_RESPONSE' || error.status >= 500)) return 'Результат операции неизвестен: запись могла сохраниться. Проверьте текущее состояние перед явным повтором.';
  return error instanceof WorkbenchApiError ? error.problem.message + ' (' + error.problem.code + ')' : 'Не удалось загрузить данные. Проверьте подключение и повторите чтение.';
}
/** Shared navigation shell; production supplies the complete view registry. */
export function WorkbenchShell({ views = {} }: { views?: WorkbenchViewRegistry } = {}) {
  const { session, preferences, loading, error, refreshSession } = useWorkbench();
  const { pathname, context, warnings, persistenceError } = useGlobalContext();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null), maintenanceOpener = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null), previousPath = useRef(pathname), destinationFocusPending = useRef(false), maintenanceReturnPending = useRef(false);
  useEffect(() => {
    if (previousPath.current !== pathname) { previousPath.current = pathname; destinationFocusPending.current = true; }
    if (destinationFocusPending.current && !notificationsOpen && !maintenanceOpen && !loading) { heading.current?.focus(); destinationFocusPending.current = false; }
  }, [pathname, notificationsOpen, maintenanceOpen, loading]);
  useEffect(() => { if (!maintenanceOpen && maintenanceReturnPending.current) { maintenanceReturnPending.current = false; maintenanceOpener.current?.focus(); } }, [maintenanceOpen]);
  const basePath = pathname.startsWith('/goals/') ? '/goals' : pathname;
  const destination = workbenchDestinations.find(item => item.path === basePath);
  const key = basePath.slice(1) as keyof Pick<WorkbenchViewRegistry, 'overview'|'goals'|'execution'|'data'|'uor'>;
  const Page = views[key]; const Detail = views.goalDetail; const Search = views.search; const Maintenance = views.maintenance; const Access = views.access; const Empty = views.empty; const Context = views.context;
  const goalId = pathname.startsWith('/goals/') ? pathname.slice('/goals/'.length) : null;
  const denied = basePath === '/uor' && !hasWorkbenchPreparation(session?.allowedCommands ?? []);
  return <div className="wb-shell" data-theme={preferences?.values.visual.theme} data-density={preferences?.values.visual.density}>
    <div inert={notificationsOpen || maintenanceOpen}>
      <a className="wb-skip" href="#wb-main">Перейти к содержимому</a>
      <header className="wb-header"><strong>Рабочее место УОР</strong>{session && Access && <Access />}{session && context && Search && <Search />}<button type="button" ref={opener} disabled={!session || loading} aria-haspopup="dialog" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(true)}>Уведомления</button>{Maintenance && <button type="button" ref={maintenanceOpener} disabled={!session || loading} aria-haspopup="dialog" aria-expanded={maintenanceOpen} onClick={() => setMaintenanceOpen(true)}>Обслуживание рабочего места</button>}</header>
      {session && context && Context && <Context key={session.personId ?? 'installation'} />}
      {session && <WelcomeToast displayName={session.displayName} />}
      {session && <WorkbenchNavigation />}
      <main id="wb-main" tabIndex={-1} className="wb-main" aria-busy={loading}>
        <h1 ref={heading} tabIndex={-1}>{destination?.label ?? 'Страница не найдена'}</h1>
        {loading && <p>Загружаем рабочее место…</p>}
        {error !== null && <div role="alert">{workbenchErrorMessage(error, 'read')} <button type="button" onClick={() => { void refreshSession(); }}>Повторить загрузку</button></div>}
        {persistenceError !== null && <p role="alert">Сохранение выбранного контекста не подтверждено. Он остаётся в адресе. {workbenchErrorMessage(persistenceError)}</p>}
        {warnings.map((warning, index) => <p role="status" key={index}>{warning}</p>)}
        {session && (denied ? <p role="alert">Недостаточно прав для панели УОР. Требуется действующий допуск куратора.</p> : !context ? Empty ? <Empty /> : <p>Получите опубликованный каталог из main, затем выберите область. Сейчас область и период не заданы.</p> : !destination ? <p>Выберите экран в основной навигации.</p> : goalId && Detail ? <Detail goalId={goalId} /> : !goalId && Page ? <Page /> : <p className="wb-unavailable">Экран «{goalId ? 'Карточка цели' : destination.label}» ещё не подключён в сборке разработки.</p>)}
      </main>
    </div>
    {maintenanceOpen && Maintenance && <Maintenance onClose={() => { maintenanceReturnPending.current = true; setMaintenanceOpen(false); }} />}
    {notificationsOpen && <NotificationCenter onClose={options => { if (options?.focusDestination) destinationFocusPending.current = true; setNotificationsOpen(false); }} returnFocus={opener} />}
  </div>;
}
