import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Bell, Menu, X, ChevronLeft, ChevronRight, Settings2, CircleHelp, Monitor, ArrowUpRight, Search as SearchIcon, Palette } from 'lucide-react';
import { APP_VERSION } from '../../domain/app-version';
import { useGlobalContext, useWorkbench } from './context';
import { CommandRecoveryError } from './command-recovery';
import { WorkbenchApiError } from './api-client';
import { WorkbenchNavigation, hasWorkbenchPreparation, workbenchDestinations } from './WorkbenchNavigation';
import { WelcomeToast } from './WelcomeToast';
import { NotificationCenter } from './NotificationCenter';
import './workbench.css';
import { QuickNavigation } from './QuickNavigation';
import { AppearancePanel } from './AppearancePanel';

export type WorkbenchViewRegistry = {
  overview?: ComponentType; goals?: ComponentType; goalDetail?: ComponentType<{ goalId: string }>;
  execution?: ComponentType; data?: ComponentType; uor?: ComponentType; search?: ComponentType; maintenance?: ComponentType<{ onClose(): void }>;
  knowledge?: ComponentType; reports?: ComponentType; settings?: ComponentType; updates?: ComponentType; maturity?: ComponentType;
  access?: ComponentType; empty?: ComponentType; context?: ComponentType;
};
export function workbenchErrorMessage(error: unknown, operation: 'read' | 'mutation' = 'mutation'): string {
  if (error instanceof CommandRecoveryError) return error.message;
  if (operation === 'mutation' && (!(error instanceof WorkbenchApiError) || error.problem.code === 'INVALID_RESPONSE' || error.status >= 500)) return 'Результат операции неизвестен: запись могла сохраниться. Проверьте текущее состояние перед явным повтором.';
  return error instanceof WorkbenchApiError ? error.problem.message + ' (' + error.problem.code + ')' : 'Не удалось загрузить данные. Проверьте подключение и повторите чтение.';
}
/** Shared navigation shell; production supplies the complete view registry. */
export function WorkbenchShell({ views = {} }: { views?: WorkbenchViewRegistry } = {}) {
  const { session, preferences, loading, error, refreshSession, saveAppearance, appearancePending, appearanceRecovery, recoverAppearance, retryAppearance } = useWorkbench();
  const { pathname, context, warnings, persistenceError } = useGlobalContext();
  const [quickOpen,setQuickOpen]=useState(false);
  const quickOpener=useRef<HTMLButtonElement>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia?.('(max-width: 767px)').matches ?? false);
  const compact = preferences?.values.visual.sidebar === 'compact';
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [appearanceOpen,setAppearanceOpen]=useState(false),[appearanceError,setAppearanceError]=useState<unknown>(null);
  const appearanceOpener=useRef<HTMLButtonElement>(null);
  const closeAppearance=()=>{setAppearanceOpen(false);requestAnimationFrame(()=>appearanceOpener.current?.focus());};
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpener = useRef<HTMLButtonElement>(null), searchContainer = useRef<HTMLDivElement>(null), searchReturnPending = useRef(false);
  const menuOpener = useRef<HTMLButtonElement>(null), navigation = useRef<HTMLElement>(null);
  const menuReturnPending = useRef(false);
  useEffect(() => {
    if (searchOpen && mobile) searchContainer.current?.querySelector<HTMLInputElement>('input')?.focus();
    else if (searchReturnPending.current) { searchReturnPending.current = false; searchOpener.current?.focus(); }
  }, [searchOpen, mobile]);
  const closeSearch = () => { searchReturnPending.current = true; setSearchOpen(false); };
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 767px)');
    if (!media) return;
    const update = () => { setMobile(media.matches); if (!media.matches) setNavigationOpen(false); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (navigationOpen && mobile) navigation.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else if (menuReturnPending.current) { menuReturnPending.current = false; menuOpener.current?.focus(); }
  }, [navigationOpen, mobile]);
  const closeMenu = (returnFocus = true) => { menuReturnPending.current = returnFocus; setNavigationOpen(false); };
  const trapNavigation = (event: KeyboardEvent<HTMLElement>) => {
    if (!mobile || !navigationOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...(navigation.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]') ?? [])];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const opener = useRef<HTMLButtonElement>(null), maintenanceOpener = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null), previousPath = useRef(pathname), destinationFocusPending = useRef(false), maintenanceReturnPending = useRef(false);
  useEffect(() => {
    if (previousPath.current !== pathname) { previousPath.current = pathname; destinationFocusPending.current = true; }
    if (destinationFocusPending.current && !notificationsOpen && !maintenanceOpen && !appearanceOpen && !quickOpen && !navigationOpen && !loading) { heading.current?.focus(); destinationFocusPending.current = false; }
  }, [pathname, notificationsOpen, maintenanceOpen, appearanceOpen, quickOpen, navigationOpen, loading]);
  useEffect(() => {
    if (!maintenanceOpen && maintenanceReturnPending.current) {
      maintenanceReturnPending.current = false;
      (mobile ? menuOpener.current : maintenanceOpener.current)?.focus();
    }
  }, [maintenanceOpen, mobile]);
  const basePath = pathname.startsWith('/goals/') ? '/goals' : pathname;
  const destination = basePath==='/maturity'?{path:'/maturity',label:'Модель зрелости'}:workbenchDestinations.find(item => item.path === basePath);
  const key = basePath.slice(1) as keyof Pick<WorkbenchViewRegistry, 'overview'|'goals'|'execution'|'data'|'uor'|'knowledge'|'reports'|'settings'|'updates'|'maturity'>;
  const Page = views[key]; const Detail = views.goalDetail; const Search = views.search; const Maintenance = views.maintenance; const Access = views.access; const Empty = views.empty; const Context = views.context;
  const goalId = pathname.startsWith('/goals/') ? pathname.slice('/goals/'.length) : null;
  const denied = basePath === '/uor' && !hasWorkbenchPreparation(session?.allowedCommands ?? []);
  const subtitles: Record<string, string> = {
    '/overview': 'Что требует внимания и какое действие нужно дальше',
    '/goals': 'Результат, требование и основание — в одном месте',
    '/execution': 'Следующие шаги, ответственные и необходимые решения',
    '/data': 'Получайте файлы, проверяйте строки и готовьте данные к работе',
    '/knowledge': 'Команды, продукты, связи и общая методика',
    '/reports': 'Сохранённые отчёты и недельная сводка',
    '/settings': 'Личные настройки рабочего места',
    '/updates': 'Принятая версия, обновление и сохранность данных',
    '/uor': 'Проверка изменений и подготовка пакетов',
  };
  const overlayOpen = notificationsOpen || maintenanceOpen || appearanceOpen || quickOpen;
  useEffect(()=>{const onKey=(event:globalThis.KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&session&&!loading&&!overlayOpen&&!navigationOpen){event.preventDefault();setQuickOpen(true);}};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[session,loading,overlayOpen,navigationOpen]);
  const independent = ['/data','/knowledge','/reports','/settings','/updates','/maturity','/uor'].includes(basePath);
  return <div className="wb-shell" data-theme={preferences?.values.visual.theme ?? 'system'} data-ready={preferences!==null} data-density={preferences?.values.visual.density} data-navigation={compact ? 'compact' : 'expanded'}>
    {!preferences&&<div className="wb-bootstrap" role={error!==null?'alert':'status'}>{error!==null?<>{workbenchErrorMessage(error,'read')} <button onClick={()=>void refreshSession()}>Повторить проверку</button></>:'Проверяем рабочее место и личное представление…'}</div>}
    <a className="wb-skip" href="#wb-main">Перейти к содержимому</a>
    <div className="wb-layout">
      {mobile && navigationOpen && <div className="wb-navigation-scrim" onClick={() => closeMenu()} aria-hidden="true" />}
      <aside ref={navigation} id="wb-sidebar" className="wb-sidebar" hidden={mobile && !navigationOpen} inert={overlayOpen}
        role={mobile && navigationOpen ? 'dialog' : undefined} aria-modal={mobile && navigationOpen ? true : undefined}
        aria-label="Навигация рабочего места" onKeyDown={trapNavigation}>
        {mobile && <button className="wb-menu-close wb-icon-button" type="button" aria-label="Закрыть меню" onClick={() => closeMenu()}><X size={20} /></button>}
        <div className="wb-brand">
          <img src="/brand/rm-uor.png" alt="РМ УОР" width={108} height={108} />
          <div className="wb-brand-description">Управление<br />результатами</div>
        </div>
        {session && <WorkbenchNavigation onNavigate={() => { destinationFocusPending.current = true; closeMenu(false); }} />}
        <div className="wb-sidebar-bottom">
          {Maintenance && <button type="button" ref={maintenanceOpener} disabled={!session || loading} aria-label="Обслуживание рабочего места" title="Обслуживание рабочего места" aria-haspopup="dialog" aria-expanded={maintenanceOpen} onClick={() => { closeMenu(false); setMaintenanceOpen(true); }}><Settings2 size={18} aria-hidden="true" /><span className="wb-navigation-label">Обслуживание</span></button>}
          <a href="https://github.com/SAleksanyaS/RM_UOR/blob/main/docs/guides/product-0.6.md" target="_blank" rel="noreferrer" title="Открыть руководство читателя"><CircleHelp size={18} aria-hidden="true" /><span className="wb-navigation-label">Руководство</span><ArrowUpRight size={13} className="wb-navigation-label" aria-hidden="true" /></a>
          <div className="wb-local-status"><Monitor size={15} aria-hidden="true" /><span className="wb-navigation-label">Локальное рабочее место</span><small>v{APP_VERSION}</small></div>
          {!mobile && <button type="button" className="wb-collapse" aria-label={compact ? 'Развернуть меню' : 'Свернуть меню'} aria-expanded={!compact} aria-controls="wb-navigation-items" disabled={loading || appearancePending} onClick={() => {setAppearanceError(null);void saveAppearance({sidebar:compact?'expanded':'compact'}).catch(setAppearanceError);}}>{compact ? <ChevronRight size={18} /> : <><ChevronLeft size={18} /><span>Свернуть меню</span></>}</button>}
        </div>
      </aside>
      <div className="wb-workspace" inert={overlayOpen || mobile && navigationOpen}>
        <header className="wb-header">
          {mobile && <button ref={menuOpener} type="button" className="wb-icon-button" aria-label="Открыть меню" aria-haspopup="dialog" aria-controls="wb-sidebar" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}><Menu size={21} /></button>}
          {mobile && session && context && Search && <button ref={searchOpener} type="button" className="wb-icon-button" aria-label={searchOpen ? 'Закрыть поиск' : 'Открыть поиск'} aria-expanded={searchOpen} aria-controls="wb-header-search" onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true); }}>{searchOpen ? <X size={19} /> : <SearchIcon size={19} />}</button>}
          <div ref={searchContainer} id="wb-header-search" className="wb-header-search" data-mobile-open={searchOpen} onKeyDown={event => { if (mobile && event.key === 'Escape') { event.preventDefault(); closeSearch(); } }}>{session && context && Search ? <Search /> : <span className="wb-service-label">Рабочее место УОР</span>}</div>
          <div className="wb-header-actions">
            <button ref={quickOpener} className="wb-icon-button" aria-label="Быстрый переход" title="Быстрый переход · Ctrl K" disabled={!session||loading} aria-haspopup="dialog" onClick={()=>setQuickOpen(true)}><SearchIcon size={19}/></button>
            <button ref={appearanceOpener} type="button" className="wb-icon-button" aria-label="Внешний вид" title="Внешний вид" aria-haspopup="dialog" disabled={!session || loading} onClick={()=>setAppearanceOpen(true)}><Palette size={19}/></button>
            <button type="button" className="wb-icon-button" ref={opener} disabled={!session || loading} aria-label="Уведомления" title="Уведомления" aria-haspopup="dialog" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(true)}><Bell size={19} /></button>
            {session && Access && <Access />}
          </div>
        </header>
        {session && <WelcomeToast displayName={session.displayName} />}
        <main id="wb-main" tabIndex={-1} className="wb-main" aria-busy={loading}>
          <div className={'wb-page-heading' + (goalId ? ' wb-page-heading-detail' : '')}>
            <div><span className="wb-eyebrow">Рабочая повестка</span><h1 ref={heading} tabIndex={-1}>{destination?.label ?? 'Страница не найдена'}</h1>{!goalId && <p>{subtitles[basePath]}</p>}</div>
          </div>
          {session && context && Context && !['/settings','/updates'].includes(basePath) && <Context key={session.personId ?? 'installation'} />}
          {loading && <p role="status">Загружаем рабочее место…</p>}
          {error !== null && <div className="wb-inline-feedback" role="alert">{workbenchErrorMessage(error, 'read')} <button type="button" onClick={() => { void refreshSession(); }}>Повторить загрузку</button></div>}
          {persistenceError !== null && <p className="wb-inline-feedback" role="alert">Сохранение выбранного контекста не подтверждено. Он остаётся в адресе. {workbenchErrorMessage(persistenceError)}</p>}
          {warnings.map((warning, index) => <p className="wb-inline-feedback" role="status" key={index}>{warning}</p>)}
          {appearanceError!==null&&<div role="alert" className="wb-inline-feedback">{workbenchErrorMessage(appearanceError)}{appearancePending&&<button onClick={()=>void (appearanceRecovery==='not_found'?retryAppearance():recoverAppearance()).then(()=>setAppearanceError(null)).catch(setAppearanceError)}>{appearanceRecovery==='not_found'?'Повторить исходное сохранение меню':'Проверить сохранение меню'}</button>}</div>}
          {session && (denied ? <p role="alert">Недостаточно прав для панели УОР. Требуется действующий допуск куратора.</p> : !context && !independent ? Empty ? <Empty /> : <p>Получите опубликованный каталог из main, затем выберите область. Сейчас область и период не заданы.</p> : !destination ? <p>Выберите экран в основной навигации.</p> : goalId && Detail ? <Detail goalId={goalId} /> : !goalId && Page ? <Page /> : <p className="wb-unavailable">Экран «{goalId ? 'Карточка цели' : destination.label}» ещё не подключён в сборке разработки.</p>)}
        </main>
      </div>
    </div>
    {quickOpen&&<div className="wb-dialog-backdrop wb-quick-backdrop"><QuickNavigation onClose={navigated=>{setQuickOpen(false);if(navigated){destinationFocusPending.current=true;requestAnimationFrame(()=>heading.current?.focus());}else requestAnimationFrame(()=>quickOpener.current?.focus());}}/></div>}
    {appearanceOpen && <div className="wb-dialog-backdrop"><AppearancePanel key={session?.personId??'installation'} onClose={closeAppearance}/></div>}
    {maintenanceOpen && Maintenance && <Maintenance onClose={() => { maintenanceReturnPending.current = true; setMaintenanceOpen(false); }} />}
    {notificationsOpen && <NotificationCenter onClose={options => { if (options?.focusDestination) destinationFocusPending.current = true; setNotificationsOpen(false); }} returnFocus={opener} />}
  </div>;
}
