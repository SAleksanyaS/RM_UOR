import { CommandRecoveryError } from './command-recovery';
import { personalDestinations, defaultNavigation, personalFavoriteKey, type PersonalDestination, type PersonalFavorite } from '../../domain/workbench/entities/preferences';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiSuccess, AnyQueryRequest, CommandResult, CommandReconciliation, GlobalContext, SessionView } from '../../server/workbench/protocol';
import type { PreferencesRead } from '../../features/system/workbench-preferences-query';
import { WorkbenchClient, WorkbenchApiError } from './api-client';
import { canonicalPageTarget, goalContextForPath, readRouteState, routeUrl, updateGlobalContext, type ContextPatch, type WorkbenchRouteState } from './route-state';

export type VisualPreferences = PreferencesRead['values']['visual'];
export type NavigationChange = {kind:'favorite';path:PersonalFavorite} | {kind:'start'|'visit';path:PersonalDestination} | {kind:'move';favorite:PersonalFavorite;offset:-1|1} | {kind:'display';visible:boolean} | {kind:'reset'};
type WorkbenchValue = { client: WorkbenchClient; session: SessionView | null; preferences: PreferencesRead | null; loading: boolean; error: unknown; refreshSession(): Promise<void>; refreshPreferences(): Promise<PreferencesRead>; saveAppearance(patch: Partial<VisualPreferences>): Promise<void>; saveNavigation(change:NavigationChange):Promise<void>; recoverAppearance(): Promise<PreferencesRead | null>; retryAppearance(): Promise<PreferencesRead | null>; appearanceRecovery: CommandReconciliation['status'] | 'unknown' | null; appearancePending: boolean };
type LeaveGuard = () => boolean;
type GlobalContextValue = WorkbenchRouteState & { setContext(patch: ContextPatch): Promise<void>; navigate(pathname: string, options?: { replace?: boolean }): void; registerLeaveGuard(guard: LeaveGuard): () => void; approveLeave(): boolean; persistenceError: unknown };
const Workbench = createContext<WorkbenchValue | null>(null);
const Global = createContext<GlobalContextValue | null>(null);
const ownRequest = { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } } as const;
const locationUrl = () => window.location.pathname + window.location.search + window.location.hash;
export const confirmDiscardChanges = () => window.confirm('Есть несохранённые изменения. Выйти и потерять введённые данные?');
type ProviderLifetime = { client: WorkbenchClient; active: boolean; ready: boolean; refresh: number; writes: Promise<void>; epoch: number };

export function WorkbenchProvider({ client, children }: { client: WorkbenchClient; children: ReactNode }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [preferences, setPreferences] = useState<PreferencesRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const appearanceCommand = useRef<import('../../server/workbench/protocol').CommandRequest | null>(null);
  const [appearancePending, setAppearancePending] = useState(false);
  const [appearanceRecovery, setAppearanceRecovery] = useState<CommandReconciliation['status'] | 'unknown' | null>(null);
  const appearanceStatus = useRef<typeof appearanceRecovery>(null);
  const setRecovery = useCallback((status: typeof appearanceRecovery) => { appearanceStatus.current = status; setAppearanceRecovery(status); }, []);
  const [persistenceError, setPersistenceError] = useState<unknown>(null);
  const [route, setRoute] = useState<WorkbenchRouteState>(() => ({ pathname: window.location.pathname, context: null, warnings: [] }));
  const routeRef = useRef(route), defaultRef = useRef<GlobalContext | null>(null);
  const acceptedUrl = useRef(locationUrl()), leaveGuards = useRef(new Set<LeaveGuard>());
  const registerLeaveGuard = useCallback((guard: LeaveGuard) => { leaveGuards.current.add(guard); return () => { leaveGuards.current.delete(guard); }; }, []);
  const approveLeave = useCallback(() => ![...leaveGuards.current].some(guard => guard()) || confirmDiscardChanges(), []);
  const lifetime = useRef<ProviderLifetime | null>(null);
  const person = useRef<string | null | undefined>(undefined);
  const currentClient = useRef(client); currentClient.current = client;
  const isCurrent = useCallback((owner: ProviderLifetime | null): owner is ProviderLifetime => owner !== null && owner.active && lifetime.current === owner && currentClient.current === owner.client, []);
  const applyRoute = useCallback((next: WorkbenchRouteState) => { acceptedUrl.current = locationUrl(); routeRef.current = next; setRoute(next); }, []);
  const persist = useCallback((context: GlobalContext | null): Promise<void> => {
    const owner = lifetime.current;
    if (!isCurrent(owner) || owner.client !== client || !owner.ready) return Promise.resolve();
    // Read the complete current preferences/token at this queue slot. Never invent
    // defaults or retry an unknown mutation after a lost response or CAS conflict.
    const epoch = owner.epoch;
    const work = owner.writes.catch(() => undefined).then(async () => {
      if (!isCurrent(owner) || !owner.ready || owner.epoch !== epoch) return;
      if (appearanceCommand.current) throw Error('Сначала проверьте сохранение внешнего вида.');
      const response = await client.query<PreferencesRead>('preferences.get', { ...ownRequest, sort: [] });
      if (!isCurrent(owner) || !owner.ready || owner.epoch !== epoch) return;
      const commandId = crypto.randomUUID();
      const result = await client.command<CommandResult>({ commandId, name: 'preferences.set', baseRevision: response.data.editToken, payload: { values: { ...response.data.values, context } } });
      if (!isCurrent(owner) || owner.epoch !== epoch) return;
      if ('jobId' in result.data) throw Error('Preferences require a synchronous receipt');
      setPreferences({ values: { ...response.data.values, context }, editToken: result.data.editToken });
    });
    owner.writes = work;
    return work.then(() => { if (isCurrent(owner)) setPersistenceError(null); }, failure => { if (isCurrent(owner)) setPersistenceError(failure); throw failure; });
  }, [client, isCurrent]);
  // Read back personal settings in the same queue as context writes. A view can
  // unmount after its mutation commits; the current provider still needs the
  // actual saved snapshot, while an obsolete client must never update it.
  const refreshPreferences = useCallback((): Promise<PreferencesRead> => {
    const owner = lifetime.current;
    if (!isCurrent(owner) || owner.client !== client || !owner.ready) return Promise.reject(Error('Дождитесь завершения проверки рабочего места'));
    const work = owner.writes.catch(() => undefined).then(async () => {
      if (!isCurrent(owner) || !owner.ready) throw Error('Сеанс рабочего места изменился');
      const response = await client.query<PreferencesRead>('preferences.get', { ...ownRequest, sort: [] });
      if (!isCurrent(owner) || !owner.ready) throw Error('Сеанс рабочего места изменился');
      setPreferences(response.data);
      return response.data;
    });
    owner.writes = work.then(() => undefined, () => undefined);
    return work;
  }, [client, isCurrent]);
  const appearance = useCallback((update: ((values: PreferencesRead['values']) => PreferencesRead['values']) | null, retry = false): Promise<PreferencesRead | null> => {
    const owner = lifetime.current;
    if (!isCurrent(owner) || !owner.ready) return Promise.reject(Error('Дождитесь завершения проверки рабочего места'));
    const epoch = owner.epoch;
    const active = () => isCurrent(owner) && owner.ready && owner.epoch === epoch;
    const work = owner.writes.catch(() => undefined).then(async () => {
      if (!active()) throw Error('Сеанс рабочего места изменился');
      // A queued edit is not the operation being recovered. Never acknowledge it
      // merely because an older command has a receipt.
      if (appearanceCommand.current && update) throw new CommandRecoveryError('Сначала проверьте предыдущее сохранение. Эти изменения ещё не отправлены.');
      const finishReadback = async () => {
        const read = await client.query<PreferencesRead>('preferences.get', { ...ownRequest, sort: [] });
        if (!active()) return null;
        setPreferences(read.data);
        appearanceCommand.current = null;
        setAppearancePending(false);
        setRecovery(null);
        return read.data;
      };
      if (appearanceCommand.current && !retry) {
        const command = appearanceCommand.current;
        const outcome = await client.reconcileCommand(command.commandId);
        if (!active()) return null;
        if (outcome.data.name !== null && outcome.data.name !== command.name) throw new CommandRecoveryError('Ответ восстановления не соответствует команде.');
        setRecovery(outcome.data.status);
        switch (outcome.data.status) {
          case 'not_found':
            throw new CommandRecoveryError('Команда не найдена. Можно явно повторить исходное сохранение с тем же идентификатором.');
          case 'pending':
          case 'accepted':
            throw new CommandRecoveryError('Предыдущее сохранение ещё выполняется. Повторите проверку состояния.');
          case 'completed':
            return finishReadback();
          case 'interrupted':
            await finishReadback();
            if (active()) throw new CommandRecoveryError('Предыдущее сохранение прервано. Сохранённые настройки прочитаны; проверьте их и сохраните нужные изменения снова.');
            return null;
        }
      }
      if (retry && (!appearanceCommand.current || appearanceStatus.current !== 'not_found')) throw new CommandRecoveryError('Сначала проверьте состояние исходной команды.');
      let command = appearanceCommand.current;
      if (!command) {
        if (!update) return null;
        const read = await client.query<PreferencesRead>('preferences.get', { ...ownRequest, sort: [] });
        if (!active()) return null;
        command = { commandId: crypto.randomUUID(), name: 'preferences.set', baseRevision: read.data.editToken, payload: { values: update(read.data.values) } };
        appearanceCommand.current = command;
      }
      setAppearancePending(true);
      setRecovery('unknown');
      try {
        const response = await client.command<CommandResult>(command);
        if (!active()) return null;
        if ('jobId' in response.data) { setRecovery('accepted'); throw new CommandRecoveryError('Операция принята. Проверьте сохранённое состояние.'); }
        setRecovery('completed');
        if (retry) return await finishReadback();
        const saved = { values: command.payload.values as PreferencesRead['values'], editToken: response.data.editToken };
        setPreferences(saved);
        appearanceCommand.current = null;
        setAppearancePending(false);
        setRecovery(null);
        return saved;
      } catch (failure) {
        if (active()) {
          if (appearanceStatus.current === 'unknown' && failure instanceof WorkbenchApiError && [403, 409, 422].includes(failure.status)) {
            appearanceCommand.current = null;
            setRecovery(null);
          }
          setAppearancePending(appearanceCommand.current !== null);
        }
        throw failure;
      }
    });
    owner.writes = work.then(() => undefined, () => undefined);
    return work;
  }, [client, isCurrent, setRecovery]);
  const saveAppearance = useCallback((patch: Partial<VisualPreferences>) => appearance(values => ({ ...values, visual: { ...values.visual, ...patch } })).then(() => undefined), [appearance]);
  const saveNavigation = useCallback((change: NavigationChange) => {
    if ('path' in change && typeof change.path === 'string' && !personalDestinations.includes(change.path)) return Promise.reject(Error('Недопустимый раздел'));
    return appearance(values => {
      if (change.kind === 'reset') {
        const { rawTableColumns: _columns, ...preserved } = values;
        return { ...preserved, navigation: defaultNavigation(), sorts: {}, visual: { theme: 'system', density: 'comfortable', sidebar: 'expanded' } };
      }
      const nav = values.navigation ?? defaultNavigation();
      if (change.kind === 'move') {
        const favorites = [...nav.favorites], index = favorites.findIndex(item => personalFavoriteKey(item) === personalFavoriteKey(change.favorite));
        const next = index + change.offset;
        if (index >= 0 && next >= 0 && next < favorites.length) [favorites[index], favorites[next]] = [favorites[next], favorites[index]];
        return { ...values, navigation: { ...nav, favorites } };
      }
      if (change.kind === 'display') return { ...values, navigation: { ...nav, showFavorites: change.visible } };
      const patch = change.kind === 'favorite'
        ? { favorites: nav.favorites.some(item => personalFavoriteKey(item) === personalFavoriteKey(change.path)) ? nav.favorites.filter(item => personalFavoriteKey(item) !== personalFavoriteKey(change.path)) : [...nav.favorites, change.path] }
        : change.kind === 'start' ? { startPage: change.path }
          : { recent: [change.path, ...nav.recent.filter(path => path !== change.path)].slice(0, 9) };
      return { ...values, navigation: { ...nav, ...patch } };
    }).then(() => undefined);
  }, [appearance]);
  const recoverAppearance = useCallback(() => appearance(null), [appearance]);
  const retryAppearance = useCallback(() => appearance(null, true), [appearance]);
  const refreshSession = useCallback(async () => {
    const owner = lifetime.current;
    if (!isCurrent(owner) || owner.client !== client) return;
    const current = ++owner.refresh; owner.ready = false;
    setLoading(true); setError(null);
    try {
      const previousPerson = person.current;
      const response = await client.session();
      if (!isCurrent(owner) || current !== owner.refresh) return;
      if (previousPerson !== undefined && previousPerson !== response.data.personId) { owner.epoch++; setPreferences(null); appearanceCommand.current = null; setAppearancePending(false); setRecovery(null); }
      const savedPreferences = await client.query<PreferencesRead>('preferences.get', { ...ownRequest, sort: [] });
      if (!isCurrent(owner) || current !== owner.refresh) return;
      // Session defaultContext is validated by the server. Saved preferences are
      // used by the server to choose it; UI never selects an arbitrary first DIT.
      defaultRef.current = response.data.defaultContext;
      if(locationUrl()==='/'){const start=savedPreferences.data.values.navigation?.startPage;if(start&&personalDestinations.includes(start))window.history.replaceState(null,'',start);}
      const next = readRouteState(locationUrl(), response.data.defaultContext);
      window.history.replaceState(null, '', routeUrl(canonicalPageTarget(locationUrl()), next.context));
      applyRoute(next); person.current = response.data.personId; setSession(response.data); setPreferences(savedPreferences.data); owner.ready = true;
    } catch (failure) { if (isCurrent(owner) && current === owner.refresh) setError(failure); }
    finally { if (isCurrent(owner) && current === owner.refresh) setLoading(false); }
  }, [client, applyRoute, isCurrent]);
  useEffect(() => {
    const owner: ProviderLifetime = { client, active: true, ready: false, refresh: 0, writes: Promise.resolve(), epoch: 0 };
    lifetime.current = owner; defaultRef.current = null;
    setSession(null); setPreferences(null); setPersistenceError(null); appearanceCommand.current = null; setAppearancePending(false); setRecovery(null);
    applyRoute({ pathname: window.location.pathname, context: null, warnings: [] });
    void refreshSession();
    return () => { owner.active = false; owner.ready = false; owner.refresh++; if (lifetime.current === owner) lifetime.current = null; };
  }, [refreshSession]);
  useEffect(() => {
    const onPopState = () => {
      if (!isCurrent(lifetime.current) || !lifetime.current.ready) return;
      if (locationUrl() !== acceptedUrl.current && !approveLeave()) {
        // The browser has already moved its URL. Restore the full accepted
        // location without rendering or persisting the rejected context.
        window.history.pushState(null, '', acceptedUrl.current);
        return;
      }
      const next = readRouteState(locationUrl(), defaultRef.current);
      window.history.replaceState(null, '', routeUrl(canonicalPageTarget(locationUrl()), next.context)); applyRoute(next);
      void persist(next.context).catch(() => undefined);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyRoute, persist, isCurrent, approveLeave]);
  const setContext = useCallback(async (patch: ContextPatch) => {
    if (!isCurrent(lifetime.current) || lifetime.current.client !== client || !lifetime.current.ready) throw Error('Контекст рабочего места ещё загружается');
    const current = routeRef.current;
    if (!current.context) throw Error('Получите опубликованный каталог из main');
    const context = updateGlobalContext(current.context, patch);
    if (JSON.stringify(context) === JSON.stringify(current.context) || !approveLeave()) return;
    const warnings = JSON.stringify(context.scopePath) !== JSON.stringify(current.context.scopePath) ? ['Вложенная область сброшена после изменения родительской области'] : [];
    window.history.pushState(null, '', routeUrl(canonicalPageTarget(locationUrl()), context));
    applyRoute({ ...current, context, warnings });
    await persist(context);
  }, [applyRoute, persist, client, isCurrent, approveLeave]);
  const navigate = useCallback((pathname: string, options: { replace?: boolean } = {}) => {
    const current = routeRef.current;
    const context = goalContextForPath(pathname, current.context);
    const url = new URL(routeUrl(pathname, context), window.location.origin);
    if (url.pathname + url.search + url.hash !== locationUrl() && !approveLeave()) return;
    window.history[options.replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search + url.hash);
    applyRoute({ ...current, pathname: url.pathname, context });
    if (context?.goalId !== current.context?.goalId) void persist(context).catch(() => undefined);
    const destination=personalDestinations.find(path=>path===url.pathname);
    if(destination&&!appearanceCommand.current)void saveNavigation({kind:'visit',path:destination}).catch(failure=>setPersistenceError(failure));
  }, [applyRoute, persist, approveLeave, saveNavigation]);
  return <Workbench.Provider value={{ client, session, preferences, loading, error, refreshSession, refreshPreferences, saveAppearance, saveNavigation, recoverAppearance, retryAppearance, appearanceRecovery, appearancePending }}><Global.Provider value={{ ...route, setContext, navigate, registerLeaveGuard, approveLeave, persistenceError }}>{children}</Global.Provider></Workbench.Provider>;
}
export function useWorkbench(): WorkbenchValue {
  const value = useContext(Workbench); if (!value) throw Error('WorkbenchProvider is required'); return value;
}
export function useGlobalContext(): GlobalContextValue {
  const value = useContext(Global); if (!value) throw Error('WorkbenchProvider is required'); return value;
}
/** Standalone personal-workflow screens also use the local/unload guard. */
export function useWorkbenchLeaveGuard() { return useContext(Global)?.registerLeaveGuard; }

export type WorkbenchQueryState<T> = { data: T | null; response: ApiSuccess<T> | null; loading: boolean; error: unknown };
/** Both abort and sequence checks are required: a transport can complete after abort. */
export function useWorkbenchQuery<T>(name: string, input: AnyQueryRequest | null, refreshKey?: unknown): WorkbenchQueryState<T> {
  const { client, session } = useWorkbench();
  const key = JSON.stringify([name, input, refreshKey]);
  const sequence = useRef(0);
  const [state, setState] = useState<WorkbenchQueryState<T> & { key: string }>({ key, data: null, response: null, loading: false, error: null });
  useEffect(() => {
    const current = ++sequence.current, controller = new AbortController();
    if (!session || input === null) { setState({ key, data: null, response: null, loading: false, error: null }); return () => { sequence.current++; controller.abort(); }; }
    setState({ key, data: null, response: null, loading: true, error: null });
    void client.query<T>(name, input, { signal: controller.signal }).then(response => {
      if (current === sequence.current && !controller.signal.aborted) setState({ key, data: response.data, response, loading: false, error: null });
    }, failure => {
      if (current === sequence.current && !controller.signal.aborted) setState({ key, data: null, response: null, loading: false, error: failure });
    });
    return () => { sequence.current++; controller.abort(); };
    // key represents the complete serializable request, avoiding object-identity refetch loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, session, key]);
  return state.key === key ? state : { data: null, response: null, loading: input !== null && session !== null, error: null };
}
