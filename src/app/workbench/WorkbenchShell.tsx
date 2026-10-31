import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useGlobalContext, useWorkbench } from './context';
import { WorkbenchApiError } from './api-client';
import { WorkbenchNavigation, hasWorkbenchPreparation, workbenchDestinations } from './WorkbenchNavigation';
import { WelcomeToast } from './WelcomeToast';
import { NotificationCenter } from './NotificationCenter';
import './workbench.css';

export type WorkbenchViewRegistry = {
  overview?: ComponentType; goals?: ComponentType; goalDetail?: ComponentType<{ goalId: string }>;
  execution?: ComponentType; data?: ComponentType; uor?: ComponentType;
};
export function workbenchErrorMessage(error: unknown, operation: 'read' | 'mutation' = 'mutation'): string {
  if (operation === 'mutation' && (!(error instanceof WorkbenchApiError) || error.problem.code === 'INVALID_RESPONSE' || error.status >= 500)) return 'Результат операции неизвестен: запись могла сохраниться. Проверьте текущее состояние перед явным повтором.';
  return error instanceof WorkbenchApiError ? error.problem.message + ' (' + error.problem.code + ')' : 'Не удалось загрузить данные. Проверьте подключение и повторите чтение.';
}
/** Development composition only until T39 supplies every registered page. */
export function WorkbenchShell({ views = {} }: { views?: WorkbenchViewRegistry } = {}) {
  const { session, loading, error, refreshSession } = useWorkbench();
  const { pathname, context, warnings, persistenceError } = useGlobalContext();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null), previousPath = useRef(pathname), destinationFocusPending = useRef(false);
  useEffect(() => {
    if (previousPath.current !== pathname) { previousPath.current = pathname; destinationFocusPending.current = true; }
    if (destinationFocusPending.current && !notificationsOpen && !loading) { heading.current?.focus(); destinationFocusPending.current = false; }
  }, [pathname, notificationsOpen, loading]);
  const basePath = pathname.startsWith('/goals/') ? '/goals' : pathname;
  const destination = workbenchDestinations.find(item => item.path === basePath);
  const key = basePath.slice(1) as keyof Omit<WorkbenchViewRegistry, 'goalDetail'>;
  const Page = views[key]; const Detail = views.goalDetail;
  const goalId = pathname.startsWith('/goals/') ? pathname.slice('/goals/'.length) : null;
  const denied = basePath === '/uor' && !hasWorkbenchPreparation(session?.allowedCommands ?? []);
  return <div className="wb-shell">
    <div inert={notificationsOpen}>
      <a className="wb-skip" href="#wb-main">Перейти к содержимому</a>
      <header className="wb-header"><strong>Рабочее место УОР</strong><button type="button" ref={opener} disabled={!session || loading} aria-haspopup="dialog" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(true)}>Уведомления</button></header>
      {session && <WelcomeToast displayName={session.displayName} />}
      {session && <WorkbenchNavigation />}
      <main id="wb-main" tabIndex={-1} className="wb-main" aria-busy={loading}>
        <h1 ref={heading} tabIndex={-1}>{destination?.label ?? 'Страница не найдена'}</h1>
        {loading && <p>Загружаем рабочее место…</p>}
        {error !== null && <div role="alert">{workbenchErrorMessage(error, 'read')} <button type="button" onClick={() => { void refreshSession(); }}>Повторить загрузку</button></div>}
        {persistenceError !== null && <p role="alert">Сохранение выбранного контекста не подтверждено. Он остаётся в адресе. {workbenchErrorMessage(persistenceError)}</p>}
        {warnings.map((warning, index) => <p role="status" key={index}>{warning}</p>)}
        {session && (denied ? <p role="alert">Недостаточно прав для панели УОР. Требуется действующий допуск куратора.</p> : !context ? <p>Получите опубликованный каталог из main, затем выберите область. Сейчас область и период не заданы.</p> : !destination ? <p>Выберите экран в основной навигации.</p> : goalId && Detail ? <Detail goalId={goalId} /> : !goalId && Page ? <Page /> : <p className="wb-unavailable">Экран «{goalId ? 'Карточка цели' : destination.label}» ещё не подключён в сборке разработки.</p>)}
      </main>
    </div>
    {notificationsOpen && <NotificationCenter onClose={options => { if (options?.focusDestination) destinationFocusPending.current = true; setNotificationsOpen(false); }} returnFocus={opener} />}
  </div>;
}
