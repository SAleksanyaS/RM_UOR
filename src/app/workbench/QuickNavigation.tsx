import { useEffect, useRef, useState } from 'react';
import { Search, X, ArrowRight, Star, Target, Users, FileText, ChevronUp, ChevronDown, type LucideIcon } from 'lucide-react';
import { useGlobalContext, useWorkbench, type NavigationChange } from './context';
import { hasWorkbenchPreparation, workbenchDestinations } from './WorkbenchNavigation';
import { defaultNavigation, personalFavoriteKey, type PersonalDestination, type PersonalFavorite, type PersonalObjectFavorite } from '../../domain/workbench/entities/preferences';
import type { WorkbenchReadModels } from '../../features/catalog/workbench-read-models';
import type { KnowledgeItem } from '../../features/knowledge/workbench-contracts';
import type { ReportSnapshot } from '../../features/reporting/workbench/contracts';
import type { WorkbenchClient } from './api-client';

type FavoriteTarget = { label: string; path: string | null };
const names = { goal: 'Цель', team: 'Команда', report: 'Отчёт' };
const icons = { goal: Target, team: Users, report: FileText };
const ownRequest = (filter: Record<string, unknown>) => ({ context: null, filter, sort: [], page: { limit: 100, cursor: null } });
const unavailable = (item: PersonalObjectFavorite) => ({ label: `${names[item.kind]} недоступ${item.kind === 'report' ? 'ен' : 'на'} · ${item.id}${item.kind === 'report' ? ' · v' + item.revision : ''}`, path: null });

/** No cached title is trusted across an owner/client change or a lost authorization. */
function useFavoriteTargets(favorites: PersonalObjectFavorite[]) {
  const { client, session, loading } = useWorkbench(), { context } = useGlobalContext();
  const key = JSON.stringify([favorites, context, session?.personId, session?.role, session?.allowedCommands]);
  const [state, setState] = useState<{ client: WorkbenchClient; key: string; items: Record<string, FavoriteTarget> } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (loading || !session || !favorites.length) return () => controller.abort();
    const catalog = favorites.some(item => item.kind === 'goal') && context
      ? client.query<WorkbenchReadModels['context.options']>('context.options', { ...ownRequest({}), context }, { signal: controller.signal }).then(value => value.data.goals, () => [])
      : Promise.resolve([]);
    void Promise.all(favorites.map(async item => {
      let target: FavoriteTarget = unavailable(item);
      try {
        if (item.kind === 'goal') {
          const goal = (await catalog).find(goal => goal.id === item.id);
          if (goal) target = { label: 'Цель · ' + goal.title, path: '/goals/' + goal.id };
        } else if (item.kind === 'team') {
          const result = await client.query<{ item: KnowledgeItem }>('knowledge.detail', ownRequest({ id: item.id, packageId: null }), { signal: controller.signal });
          if (result.data.item.value.kind === 'team') target = { label: 'Команда · ' + result.data.item.value.name, path: '/knowledge?object=' + item.id };
        } else if (item.kind === 'report' && session.allowedCommands.includes('report.save')) {
          const result = await client.query<ReportSnapshot>('reports.detail', ownRequest({ id: item.id, revision: item.revision }), { signal: controller.signal });
          target = { label: 'Отчёт · ' + result.data.definition.title + ' · v' + item.revision, path: '/reports?report=' + item.id + '&reportRevision=' + item.revision };
        }
      } catch { /* Missing or inaccessible targets remain removable without their former title. */ }
      return [personalFavoriteKey(item), target] as const;
    })).then(entries => { if (!controller.signal.aborted) setState({ client, key, items: Object.fromEntries(entries) }); });
    return () => controller.abort();
    // key includes every request selector and the authoritative session identity/capabilities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, loading]);
  return !loading && state?.client === client && state.key === key ? state.items : {};
}

export function QuickNavigation({ onClose }: { onClose: (navigated?: boolean) => void }) {
  const { navigate } = useGlobalContext();
  const { client, session, loading, preferences, saveNavigation, recoverAppearance, retryAppearance, appearanceRecovery, appearancePending } = useWorkbench();
  const [text, setText] = useState(''), [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [announcement, setAnnouncement] = useState('');
  const input = useRef<HTMLInputElement>(null), dialog = useRef<HTMLDivElement>(null);
  const destinations = useRef<Array<HTMLButtonElement | null>>([]);
  const ownerIdentity = JSON.stringify([session?.personId, session?.role, session?.allowedCommands, loading]);
  const actionOwner = useRef({ client, identity: ownerIdentity });
  if (actionOwner.current.client !== client || actionOwner.current.identity !== ownerIdentity) actionOwner.current = { client, identity: ownerIdentity };
  const restoreFocus = useRef<{ owner: typeof actionOwner.current; editor: HTMLDivElement; control: HTMLElement; key: string | null } | null>(null);
  useEffect(() => { restoreFocus.current = null; setBusy(false); setError(''); setAnnouncement(''); }, [client, ownerIdentity]);
  useEffect(() => {
    if (busy || !restoreFocus.current) return;
    const intent = restoreFocus.current; restoreFocus.current = null;
    // Native browsers blur a disabled/removed control. Preserve intentional focus
    // moves and never focus a dialog on behalf of an obsolete client or person.
    if (intent.owner !== actionOwner.current || intent.editor !== dialog.current || document.activeElement !== document.body) return;
    const original = intent.control.isConnected && intent.editor.contains(intent.control) && !intent.control.matches(':disabled') ? intent.control : null;
    const destination = intent.key ? [...intent.editor.querySelectorAll<HTMLButtonElement>('button[data-navigation-key]')].find(button => button.dataset.navigationKey === intent.key) : null;
    (original ?? destination ?? input.current)?.focus();
  }, [busy, appearancePending, client, ownerIdentity]);
  const nav = preferences?.values.navigation ?? defaultNavigation(), shown = nav.showFavorites !== false;
  const targets = useFavoriteTargets(shown ? nav.favorites.filter((item): item is PersonalObjectFavorite => typeof item !== 'string') : []);
  const allowed = workbenchDestinations.filter(item => item.path !== '/uor' || hasWorkbenchPreparation(session?.allowedCommands ?? []));
  type Item = FavoriteTarget & { key: string; favorite: PersonalFavorite; icon: LucideIcon; group: string };
  const ordered: Item[] = [], seen = new Set<string>();
  const add = (favorite: PersonalFavorite, group: string) => {
    const key = personalFavoriteKey(favorite); if (seen.has(key)) return;
    if (typeof favorite === 'string') {
      const item = allowed.find(item => item.path === favorite); if (!item) return;
      ordered.push({ key, favorite, path: item.path, label: item.label, icon: item.icon, group });
    } else ordered.push({ key, favorite, ...(targets[key] ?? unavailable(favorite)), icon: icons[favorite.kind], group });
    seen.add(key);
  };
  if (shown) nav.favorites.forEach(item => add(item, 'Избранное'));
  nav.recent.forEach(item => add(item, 'Недавние'));
  allowed.forEach(item => add(item.path, 'Все разделы'));
  const items = ordered.filter(item => item.label.toLocaleLowerCase('ru').includes(text.toLocaleLowerCase('ru')));
  useEffect(() => { input.current?.focus(); }, []);
  const go = (path: string | null) => { if (path) { navigate(path); onClose(true); } };
  const focusDestination = (index: number) => {
    const button = destinations.current[index]; if (!button) return;
    button.focus(); button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  const save = async (change: NavigationChange | null) => {
    if (busy) return;
    const owner = actionOwner.current, editor = dialog.current, focused = document.activeElement;
    const current = () => actionOwner.current === owner && dialog.current === editor && !!editor?.isConnected;
    if (editor && focused instanceof HTMLElement && editor.contains(focused)) restoreFocus.current = { owner, editor, control: focused, key: change?.kind === 'move' ? personalFavoriteKey(change.favorite) : change?.kind === 'favorite' ? personalFavoriteKey(change.path) : null };
    setBusy(true); setError(''); setAnnouncement('');
    try {
      if (change) await saveNavigation(change);
      else if (appearanceRecovery === 'not_found') await retryAppearance();
      else await recoverAppearance();
      if (!current()) return;
      if (change?.kind === 'move') setAnnouncement('Порядок избранного сохранён');
      if (change?.kind === 'reset') setAnnouncement('Стандартный личный вид восстановлен');
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : 'Не удалось сохранить настройки'); }
    finally { if (current()) setBusy(false); }
  };
  return <div className="wb-quick-nav wb-surface" role="dialog" aria-modal="true" aria-label="Быстрый переход" ref={dialog} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    const focused = document.activeElement, rowIndex = destinations.current.findIndex(button => button === focused);
    if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && rowIndex >= 0 && items[rowIndex]?.group === 'Избранное') {
      event.preventDefault(); if (!busy && !appearancePending) void save({ kind: 'move', favorite: items[rowIndex].favorite, offset: event.key === 'ArrowUp' ? -1 : 1 }); return;
    }
    if (event.key === 'ArrowDown' && (focused === input.current || rowIndex >= 0)) { event.preventDefault(); focusDestination(focused === input.current ? 0 : Math.min(rowIndex + 1, items.length - 1)); }
    if (event.key === 'ArrowUp' && (focused === input.current || rowIndex >= 0)) { event.preventDefault(); if (rowIndex === 0) input.current?.focus(); else focusDestination(focused === input.current ? items.length - 1 : rowIndex - 1); }
    if (event.key === 'Enter' && focused === input.current && items[active]) { event.preventDefault(); go(items[active].path); }
    if (event.key === 'Tab') {
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),summary') ?? [])].filter(control => !control.closest('details:not([open])') || control.tagName === 'SUMMARY'), first = controls[0], last = controls.at(-1);
      if (event.shiftKey && focused === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && focused === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header className="wb-section-header"><h2>Быстрый переход</h2><button className="wb-icon-button" aria-label="Закрыть быстрый переход" onClick={() => onClose()}><X size={20} /></button></header>
    <div className="wb-object-content">
      <label className="wb-field"><span><Search size={16} />Найти раздел</span><input ref={input} type="search" value={text} onChange={event => { setText(event.target.value); setActive(0); }} aria-describedby="wb-quick-help" placeholder="Раздел, избранная цель, команда или отчёт" /></label>
      <p id="wb-quick-help" className="wb-muted">↑ ↓ — выбрать · Enter — открыть · Alt ↑ ↓ — порядок избранного · Tab — действия · Escape — закрыть</p>
      <label className="wb-quick-display"><input type="checkbox" checked={shown} disabled={busy || appearancePending} onChange={event => void save({ kind: 'display', visible: event.target.checked })} />Показывать избранное</label>
      {!text && shown && !ordered.some(item => item.group === 'Избранное') && <section aria-label="Избранное"><h3 className="wb-navigation-caption">Избранное</h3><p className="wb-muted">Нажмите звезду рядом с разделом, в карточке цели или команды либо у сохранённой версии отчёта.</p></section>}
      {!text && !ordered.some(item => item.group === 'Недавние') && <section aria-label="Недавние"><h3 className="wb-navigation-caption">Недавние</h3><p className="wb-muted">Здесь появятся открытые разделы. Избранные показаны выше.</p></section>}
      <div className="wb-quick-results">
        {items.map((item, index) => {
          const favoriteIndex = nav.favorites.findIndex(favorite => personalFavoriteKey(favorite) === item.key), selected = favoriteIndex >= 0;
          return <div key={item.key}>
            {(!index || items[index - 1].group !== item.group) && <h3 className="wb-navigation-caption">{item.group}</h3>}
            <div className="wb-quick-row">
              <button data-navigation-key={item.key} ref={button => { destinations.current[index] = button; }} className={index === active ? 'wb-quick-selected' : ''} aria-disabled={!item.path || undefined} onFocus={() => setActive(index)} onClick={() => go(item.path)}>
                <item.icon size={18} aria-hidden="true" /><span>{item.label}</span>{item.path && <ArrowRight size={16} aria-hidden="true" />}
              </button>
              <button className="wb-quick-favorite" disabled={busy || appearancePending} aria-label={(selected ? 'Убрать из избранного: ' : 'В избранное: ') + item.label} aria-pressed={selected} onClick={() => void save({ kind: 'favorite', path: item.favorite })}><Star size={18} aria-hidden="true" fill={selected ? 'currentColor' : 'none'} /></button>
              {item.group === 'Избранное' && <div className="wb-quick-order" role="group" aria-label={'Порядок: ' + item.label}>
                <button aria-label={'Выше: ' + item.label} disabled={busy || appearancePending || favoriteIndex === 0} onClick={() => void save({ kind: 'move', favorite: item.favorite, offset: -1 })}><ChevronUp size={16} aria-hidden="true" />Выше</button>
                <button aria-label={'Ниже: ' + item.label} disabled={busy || appearancePending || favoriteIndex === nav.favorites.length - 1} onClick={() => void save({ kind: 'move', favorite: item.favorite, offset: 1 })}><ChevronDown size={16} aria-hidden="true" />Ниже</button>
              </div>}
            </div>
          </div>;
        })}
      </div>
      {!items.length && <p role="status">Подходящих разделов или избранных объектов нет. Попробуйте другое название.</p>}
      <label className="wb-field">Стартовый раздел<select value={nav.startPage} disabled={busy || appearancePending} onChange={event => void save({ kind: 'start', path: event.target.value as PersonalDestination })}>{allowed.map(item => <option key={item.path} value={item.path}>{item.label}</option>)}</select></label>
      <p className="wb-muted">Открывается при запуске без прямой ссылки. Избранное и история сохраняются в вашем профиле рабочего места. Недоступный объект можно убрать из избранного.</p>
      <details><summary>Стандартный личный вид</summary><p>Сбрасывает избранное, недавние разделы, стартовый раздел, тему, плотность, боковую панель, сортировки и выбор столбцов. Выбранные область, период и получатель уведомлений сохраняются. Данные и права доступа сохраняются.</p><button disabled={busy || appearancePending} onClick={() => void save({ kind: 'reset' })}>Восстановить стандартный вид</button></details>
      <p role="status">{busy ? 'Сохраняем навигацию…' : announcement}</p>
      {error && <p role="alert">{error}</p>}
      {appearancePending && <button disabled={busy} onClick={() => void save(null)}>{appearanceRecovery === 'not_found' ? 'Повторить исходное сохранение настроек' : 'Проверить сохранение настроек'}</button>}
    </div>
  </div>;
}
