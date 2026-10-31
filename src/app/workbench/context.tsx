import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ApiSuccess, AnyQueryRequest, CommandResult, GlobalContext, SessionView } from '../../server/workbench/protocol';
import type { PreferencesRead } from '../../features/system/workbench-preferences-query';
import { WorkbenchClient } from './api-client';
import { readRouteState, routeUrl, updateGlobalContext, type ContextPatch, type WorkbenchRouteState } from './route-state';

type WorkbenchValue = { client: WorkbenchClient; session: SessionView | null; preferences: PreferencesRead | null; loading: boolean; error: unknown; refreshSession(): Promise<void> };
type GlobalContextValue = WorkbenchRouteState & { setContext(patch: ContextPatch): Promise<void>; navigate(pathname: string, options?: { replace?: boolean }): void; persistenceError: unknown };
const Workbench = createContext<WorkbenchValue | null>(null);
const Global = createContext<GlobalContextValue | null>(null);
const ownRequest = { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } } as const;
const locationUrl = () => window.location.pathname + window.location.search;
type ProviderLifetime = { client: WorkbenchClient; active: boolean; ready: boolean; refresh: number; writes: Promise<void> };

export function WorkbenchProvider({ client, children }: { client: WorkbenchClient; children: ReactNode }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [preferences, setPreferences] = useState<PreferencesRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [persistenceError, setPersistenceError] = useState<unknown>(null);
  const [route, setRoute] = useState<WorkbenchRouteState>(() => ({ pathname: window.location.pathname, context: null, warnings: [] }));
  const routeRef = useRef(route), defaultRef = useRef<GlobalContext | null>(null);
  const lifetime = useRef<ProviderLifetime | null>(null);
  const currentClient = useRef(client); currentClient.current = client;
  const isCurrent = useCallback((owner: ProviderLifetime | null): owner is ProviderLifetime => owner !== null && owner.active && lifetime.current === owner && currentClient.current === owner.client, []);
  const applyRoute = useCallback((next: WorkbenchRouteState) => { routeRef.current = next; setRoute(next); }, []);
  const persist = useCallback((context: GlobalContext | null): Promise<void> => {
    const owner = lifetime.current;
    if (!isCurrent(owner) || owner.client !== client || !owner.ready) return Promise.resolve();
    // Read the complete current preferences/token at this queue slot. Never invent
    // defaults or retry an unknown mutation after a lost response or CAS conflict.
    const work = owner.writes.catch(() => undefined).then(async () => {
      if (!isCurrent(owner) || !owner.ready) return;
      const response = await client.query<PreferencesRead>('preferences.get', { ...ownRequest, sort: [] });
      if (!isCurrent(owner) || !owner.ready) return;
      const commandId = crypto.randomUUID();
      const result = await client.command<CommandResult>({ commandId, name: 'preferences.set', baseRevision: response.data.editToken, payload: { values: { ...response.data.values, context } } });
      if (!isCurrent(owner)) return;
      if ('jobId' in result.data) throw Error('Preferences require a synchronous receipt');
      setPreferences({ values: { ...response.data.values, context }, editToken: result.data.editToken });
    });
    owner.writes = work;
    return work.then(() => { if (isCurrent(owner)) setPersistenceError(null); }, failure => { if (isCurrent(owner)) setPersistenceError(failure); throw failure; });
  }, [client, isCurrent]);
  const refreshSession = useCallback(async () => {
    const owner = lifetime.current;
    if (!isCurrent(owner) || owner.client !== client) return;
    const current = ++owner.refresh; owner.ready = false;
    setLoading(true); setError(null);
    try {
      const response = await client.session();
      if (!isCurrent(owner) || current !== owner.refresh) return;
      const savedPreferences = await client.query<PreferencesRead>('preferences.get', { ...ownRequest, sort: [] });
      if (!isCurrent(owner) || current !== owner.refresh) return;
      // Session defaultContext is validated by the server. Saved preferences are
      // used by the server to choose it; UI never selects an arbitrary first DIT.
      defaultRef.current = response.data.defaultContext;
      const next = readRouteState(locationUrl(), response.data.defaultContext);
      window.history.replaceState(null, '', routeUrl(next.pathname, next.context));
      applyRoute(next); setSession(response.data); setPreferences(savedPreferences.data); owner.ready = true;
    } catch (failure) { if (isCurrent(owner) && current === owner.refresh) setError(failure); }
    finally { if (isCurrent(owner) && current === owner.refresh) setLoading(false); }
  }, [client, applyRoute, isCurrent]);
  useEffect(() => {
    const owner: ProviderLifetime = { client, active: true, ready: false, refresh: 0, writes: Promise.resolve() };
    lifetime.current = owner; defaultRef.current = null;
    setSession(null); setPreferences(null); setPersistenceError(null);
    applyRoute({ pathname: window.location.pathname, context: null, warnings: [] });
    void refreshSession();
    return () => { owner.active = false; owner.ready = false; owner.refresh++; if (lifetime.current === owner) lifetime.current = null; };
  }, [refreshSession]);
  useEffect(() => {
    const onPopState = () => {
      if (!isCurrent(lifetime.current) || !lifetime.current.ready) return;
      const next = readRouteState(locationUrl(), defaultRef.current); applyRoute(next);
      void persist(next.context).catch(() => undefined);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyRoute, persist, isCurrent]);
  const setContext = useCallback(async (patch: ContextPatch) => {
    if (!isCurrent(lifetime.current) || lifetime.current.client !== client || !lifetime.current.ready) throw Error('Контекст рабочего места ещё загружается');
    const current = routeRef.current;
    if (!current.context) throw Error('Получите опубликованный каталог из main');
    const context = updateGlobalContext(current.context, patch);
    const warnings = JSON.stringify(context.scopePath) !== JSON.stringify(current.context.scopePath) ? ['Вложенная область сброшена после изменения родительской области'] : [];
    window.history.pushState(null, '', routeUrl(current.pathname, context));
    applyRoute({ ...current, context, warnings });
    await persist(context);
  }, [applyRoute, persist, client, isCurrent]);
  const navigate = useCallback((pathname: string, options: { replace?: boolean } = {}) => {
    const current = routeRef.current;
    const url = new URL(routeUrl(pathname, current.context), window.location.origin);
    window.history[options.replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search + url.hash);
    applyRoute({ ...current, pathname: url.pathname });
  }, [applyRoute]);
  return <Workbench.Provider value={{ client, session, preferences, loading, error, refreshSession }}><Global.Provider value={{ ...route, setContext, navigate, persistenceError }}>{children}</Global.Provider></Workbench.Provider>;
}
export function useWorkbench(): WorkbenchValue {
  const value = useContext(Workbench); if (!value) throw Error('WorkbenchProvider is required'); return value;
}
export function useGlobalContext(): GlobalContextValue {
  const value = useContext(Global); if (!value) throw Error('WorkbenchProvider is required'); return value;
}

export type WorkbenchQueryState<T> = { data: T | null; response: ApiSuccess<T> | null; loading: boolean; error: unknown };
/** Both abort and sequence checks are required: a transport can complete after abort. */
export function useWorkbenchQuery<T>(name: string, input: AnyQueryRequest | null): WorkbenchQueryState<T> {
  const { client, session } = useWorkbench();
  const key = JSON.stringify([name, input]);
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
