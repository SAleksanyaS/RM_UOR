import { useEffect, useRef, useState, type RefObject } from 'react';
import type { WorkbenchReadModels } from '../../features/catalog/workbench-read-models';
import type { PreferencesRead } from '../../features/system/workbench-preferences-query';
import { useGlobalContext, useWorkbench } from './context';
import { workbenchErrorMessage } from './WorkbenchShell';
import type { WorkbenchClient } from './api-client';

type Notifications = WorkbenchReadModels['notifications.list'];
type Options = WorkbenchReadModels['context.options'];
const ownRequest = { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } } as const;

type DialogOwner = { client: WorkbenchClient; personId: string | null | undefined; generation: number; active: boolean };
export function NotificationCenter({ onClose, returnFocus }: { onClose(options?: { focusDestination?: boolean }): void; returnFocus: RefObject<HTMLButtonElement | null> }) {
  const { client, session, loading: sessionLoading } = useWorkbench(); const { context, navigate } = useGlobalContext();
  // A client belongs to one installation. SessionView deliberately exposes no
  // installation selector; the optional notification recipient is never identity.
  const lifetime = useRef<DialogOwner | null>(null);
  if (lifetime.current?.client !== client || lifetime.current.personId !== session?.personId) {
    const generation = (lifetime.current?.generation ?? 0) + 1;
    if (lifetime.current) lifetime.current.active = false;
    lifetime.current = { client, personId: session?.personId, generation, active: true };
  }
  const owner = lifetime.current;
  const isCurrent = (value: DialogOwner) => value.active && lifetime.current === value;
  const dialog = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null), noticeElement = useRef<HTMLParagraphElement>(null);
  const [dataState, setData] = useState<Notifications | null>(null), [optionsState, setOptions] = useState<Options | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(true), [loading, setLoading] = useState(false), [error, setError] = useState<unknown>(null);
  const [errorOperation, setErrorOperation] = useState<'read' | 'mutation'>('read');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [revision, setRevision] = useState(0);
  const [personId, setPersonId] = useState(''), [preferencesOwner, setPreferencesOwner] = useState<DialogOwner | null>(null), [preferencesRevision, setPreferencesRevision] = useState(0);
  const [goalId, setGoalId] = useState(context?.goalId ?? '');
  const [uiOwner, setUiOwner] = useState(owner);
  const commands = sessionLoading ? [] : session?.allowedCommands ?? [];
  const key = JSON.stringify([owner.generation, context, unreadOnly]); const latestKey = useRef(key); latestKey.current = key;
  const [dataKey, setDataKey] = useState(key);
  const data = dataKey === key ? dataState : null, options = dataKey === key ? optionsState : null;
  const returnToOpener = useRef(true);
  useEffect(() => {
    const opener = returnFocus.current; closeButton.current?.focus();
    return () => { if (returnToOpener.current) opener?.focus(); };
  }, [returnFocus]);
  useEffect(() => {
    owner.active = true; setBusy(false); setError(null); setNotice(''); setUiOwner(owner);
    return () => { owner.active = false; };
  }, [owner]);
  useEffect(() => {
    let active = true; const controller = new AbortController();
    if (!session || session.personId !== null) return;
    // Reopening must read the actual owned value, not the provider's older bootstrap.
    void client.query<PreferencesRead>('preferences.get', { ...ownRequest, sort: [] }, { signal: controller.signal }).then(response => {
      if (active && isCurrent(owner)) { setPersonId(response.data.values.notificationPersonId ?? ''); setPreferencesOwner(owner); }
    }, failure => { if (active && isCurrent(owner)) { setErrorOperation('read'); setError(failure); } });
    return () => { active = false; controller.abort(); };
  }, [client, owner, preferencesRevision]);
  useEffect(() => {
    // Explicit actions may remove/disable the focused button. Keep keyboard users
    // at the acknowledged outcome so Tab/Escape stay within the open dialog.
    if (uiOwner === owner && notice) noticeElement.current?.focus();
  }, [notice, owner, uiOwner]);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setError(null);
    if (dataKey !== key) { setData(null); setOptions(null); setDataKey(key); }
    if (!context || !session) { setLoading(false); return () => { active = false; controller.abort(); }; }
    setLoading(true);
    const request = { context, filter: {}, sort: [], page: { limit: 50, cursor: null } };
    void Promise.all([
      client.query<Notifications>('notifications.list', { ...request, filter: { unreadOnly } }, { signal: controller.signal }),
      client.query<Options>('context.options', request, { signal: controller.signal }),
    ]).then(([notifications, choices]) => { if (active && isCurrent(owner)) { setData(notifications.data); setOptions(choices.data); } }, failure => { if (active && isCurrent(owner)) { setErrorOperation('read'); setError(failure); } }).finally(() => { if (active && isCurrent(owner)) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [client, session, key, revision]);
  async function action(name: string, payload: Record<string, unknown>) {
    if (busy || !commands.includes(name)) return;
    const startedKey = key;
    setBusy(true); setError(null); setNotice('');
    try {
      await client.command({ commandId: crypto.randomUUID(), name, baseRevision: null, payload });
      if (!isCurrent(owner) || latestKey.current !== startedKey) return;
      setNotice(name === 'notifications.markRead' ? 'Уведомление прочитано. Причина остаётся открытой.' : payload.subscribed ? 'Подписка сохранена.' : 'Подписка отключена.');
      setRevision(value => value + 1);
    } catch (failure) { if (isCurrent(owner) && latestKey.current === startedKey) { setErrorOperation('mutation'); setError(failure); } }
    finally { if (isCurrent(owner)) setBusy(false); }
  }
  async function saveRecipient() {
    if (busy || preferencesOwner !== owner || !commands.includes('preferences.set')) return;
    let dispatched = false; setBusy(true); setError(null); setNotice('');
    try {
      const saved = await client.query<PreferencesRead>('preferences.get', { ...ownRequest, sort: [] });
      if (!isCurrent(owner)) return;
      dispatched = true;
      await client.command({ commandId: crypto.randomUUID(), name: 'preferences.set', baseRevision: saved.data.editToken, payload: { values: { ...saved.data.values, notificationPersonId: personId || null } } });
      if (isCurrent(owner)) setNotice('Получатель сохранён. Права доступа не изменены.');
    } catch (failure) { if (isCurrent(owner)) { setErrorOperation(dispatched ? 'mutation' : 'read'); setError(failure); } }
    finally { if (isCurrent(owner)) setBusy(false); }
  }
  async function more() {
    if (!context || busy || !data?.page.nextCursor) return;
    const startedKey = key; setBusy(true); setError(null);
    try {
      const next = await client.query<Notifications>('notifications.list', { context, filter: { unreadOnly }, sort: [], page: { limit: 50, cursor: data.page.nextCursor } });
      if (isCurrent(owner) && latestKey.current === startedKey) setData(current => current ? { items: [...current.items, ...next.data.items], page: next.data.page } : next.data);
    } catch (failure) { if (isCurrent(owner) && latestKey.current === startedKey) { setErrorOperation('read'); setError(failure); } }
    finally { if (isCurrent(owner)) setBusy(false); }
  }
  function openCause(route: string) {
    // Internal routes pass through T30's canonical context adapter. HTTPS causes
    // are rendered as ordinary links below, never as a new local API target.
    returnToOpener.current = false; navigate(route); onClose({ focusDestination: true });
  }
  return <div className="wb-dialog-backdrop"><div className="wb-notifications" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="wb-notifications-title" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),a[href]') ?? []);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === noticeElement.current)) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><h2 id="wb-notifications-title">Уведомления</h2><button ref={closeButton} type="button" aria-label="Закрыть уведомления" onClick={() => onClose()}>Закрыть</button></header>
    {!context ? <p>Получите опубликованный каталог из main, чтобы открыть уведомления в выбранном контексте.</p> : <>
      <label><input type="checkbox" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} />Только непрочитанные</label>
      {loading && <p>Загружаем уведомления…</p>}
      {data?.items.length === 0 && <p>Нет уведомлений по фильтру.</p>}
      <ul>{data?.items.map(item => <li key={item.id}>
        <span>{item.category === 'error' ? 'Ошибка' : item.category === 'reminder' ? 'Напоминание' : 'Новое событие'}: {item.cause.kind}</span> <time dateTime={item.emittedAt}>{item.emittedAt}</time>
        {item.readAt ? <span>Прочитано</span> : <button type="button" disabled={busy || !commands.includes('notifications.markRead')} onClick={() => { void action('notifications.markRead', { notificationIds: [item.id] }); }}>Отметить прочитанным</button>}
        {item.cause.route.startsWith('/') && !item.cause.route.startsWith('//') ? <button type="button" onClick={() => openCause(item.cause.route)}>Открыть причину</button> : <a href={item.cause.route} target="_blank" rel="noopener noreferrer">Открыть причину</a>}
      </li>)}</ul>
      {data?.page.hasMore && <button type="button" disabled={busy} onClick={() => { void more(); }}>Показать ещё</button>}
      <section aria-label="Подписка на цель"><label>Цель для подписки<select value={goalId} onChange={event => setGoalId(event.target.value)}><option value="">Выберите цель</option>{options?.goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label>
        <button type="button" disabled={!goalId || busy || !commands.includes('notifications.subscribe')} onClick={() => { void action('notifications.subscribe', { goalId, subscribed: true }); }}>Подписаться</button>
        <button type="button" disabled={!goalId || busy || !commands.includes('notifications.subscribe')} onClick={() => { void action('notifications.subscribe', { goalId, subscribed: false }); }}>Отписаться</button>
      </section>
      {session?.personId === null && <section aria-label="Получатель уведомлений"><label>Человек для личных уведомлений<select disabled={preferencesOwner !== owner} value={preferencesOwner === owner ? personId : ''} onChange={event => setPersonId(event.target.value)}><option value="">Не выбран</option>{options?.entities.filter(person => person.kind === 'person').map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
        <p>Необязательный выбор для личных уведомлений. Он не меняет роль и доступ.</p><button type="button" disabled={busy || preferencesOwner !== owner || !commands.includes('preferences.set')} onClick={() => { void saveRecipient(); }}>Сохранить получателя</button>
      </section>}
    </>}
    {uiOwner === owner && error !== null && <div role="alert">{workbenchErrorMessage(error, errorOperation)} <button type="button" disabled={busy} onClick={() => { setRevision(value => value + 1); setPreferencesRevision(value => value + 1); }}>{errorOperation === 'mutation' ? 'Проверить текущее состояние' : 'Повторить чтение'}</button></div>}
    {uiOwner === owner && notice && <p role="status" tabIndex={-1} ref={noticeElement}>{notice}</p>}
  </div></div>;
}
