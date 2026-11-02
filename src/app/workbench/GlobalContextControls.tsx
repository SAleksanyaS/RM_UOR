import { useEffect, useState } from 'react';
import { CalendarDays, ChevronDown, SlidersHorizontal, Building2 } from 'lucide-react';
import type { WorkbenchReadModels } from '../../features/catalog/workbench-read-models';
import type { ContextPatch } from './route-state';
import { businessTimeFromRange } from './route-state';
import { useGlobalContext, useWorkbench, useWorkbenchQuery } from './context';
import { workbenchErrorMessage } from './WorkbenchShell';

type Options = WorkbenchReadModels['context.options'];
export function GlobalContextControls() {
  const { session, loading: checking, refreshSession } = useWorkbench();
  const { context, setContext, pathname } = useGlobalContext();
  // The response is the whole published catalog. Scope edits need not discard
  // the controls or their keyboard focus while personal preferences are saved.
  const options = useWorkbenchQuery<Options>('context.options', session?.defaultContext ? { context: session.defaultContext, filter: {}, sort: [], page: { limit: 200, cursor: null } } : null);
  const [error, setError] = useState<unknown>(null), [saving, setSaving] = useState(0);
  const [mode, setMode] = useState<'as_of' | 'period'>('as_of');
  const [date, setDate] = useState(''), [start, setStart] = useState(''), [end, setEnd] = useState('');
  const timeKey = JSON.stringify(context?.time);
  useEffect(() => {
    if (!context) return;
    setMode(context.time.kind);
    if (context.time.kind === 'as_of') setDate(context.time.date);
    else { setStart(context.time.startInclusive); setEnd(context.time.endExclusive); }
    setError(null);
  }, [timeKey, session?.personId]);
  if (!context || pathname === '/data' && window.location.hash !== '#goal-data' && !new URLSearchParams(window.location.search).has('fact') && !new URLSearchParams(window.location.search).has('result')) return null;
  const apply = async (patch: ContextPatch) => {
    setError(null); setSaving(value => value + 1);
    try { await setContext(patch); } catch (failure) { setError(failure); }
    finally { setSaving(value => value - 1); }
  };
  const data = options.data, path = context.scopePath;
  const entities = (kind: 'block' | 'tribe' | 'dit' | 'cluster' | 'product' | 'team', parent: string | null, relation?: 'block_tribe' | 'tribe_cluster' | 'dit_cluster' | 'cluster_product' | 'cluster_team' | 'product_team') => (data?.entities ?? []).filter(entity => {
    if (entity.kind !== kind) return false;
    if (!relation) return true;
    const parents = (data?.links ?? []).filter(link => link.kind !== 'leader' && link.kind === relation && link.to.id === entity.id);
    return parent !== null && parents.length === 1 && parents[0].kind !== 'leader' && parents[0].from.id === parent;
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.id.localeCompare(b.id));
  const choices = (kind: 'block' | 'tribe' | 'dit' | 'cluster' | 'product' | 'team', parent: string | null, relation?: 'block_tribe' | 'tribe_cluster' | 'dit_cluster' | 'cluster_product' | 'cluster_team' | 'product_team') => entities(kind, parent, relation).map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>);
  const rootKind=path.rootKind??'dit',directTeams=rootKind!=='dit';
  const rootChoices=(data?.entities??[]).filter(e=>['dit','block','tribe'].includes(e.kind)).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  const clusters=rootKind==='block'?(data?.entities??[]).filter(e=>e.kind==='cluster'&&(data?.links??[]).some(l=>l.kind==='tribe_cluster'&&'from'in l&&l.to.id===e.id&&(data?.links??[]).some(p=>p.kind==='block_tribe'&&'from'in p&&p.from.id===path.ditId&&p.to.id===l.from.id))):entities('cluster',path.ditId,rootKind==='tribe'?'tribe_cluster':'dit_cluster');
  const disabled = checking || !data;
  const nameFor = (id: string | null) => data?.entities.find(entity => entity.id === id)?.name;
  const scopeLabel = nameFor(path.teamId ?? path.productId ?? path.clusterId ?? path.ditId) ?? 'Выбранная область';
  const timeLabel = context.time.kind === 'as_of'
    ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(context.time.date + 'T12:00:00Z'))
    : `${context.time.startInclusive} — ${context.time.endExclusive} (не включая)`;
  return <section className="wb-context-controls" aria-label="Область и время">
    <details className="wb-context-disclosure">
      <summary><span className="wb-context-current"><Building2 size={16} aria-hidden="true" /><strong>{scopeLabel}</strong><ChevronDown size={14} aria-hidden="true" /></span><span className="wb-context-date"><CalendarDays size={16} aria-hidden="true" />{timeLabel}</span><span className="wb-context-filter"><SlidersHorizontal size={15} aria-hidden="true" />Область и период</span></summary>
      <div className="wb-context-expanded">
    {options.loading && <p role="status">Загружаем опубликованные области…</p>}
    {options.error !== null && <p role="alert">{workbenchErrorMessage(options.error, 'read')} <button type="button" onClick={() => void refreshSession()}>Обновить области</button></p>}
    <div className="wb-context-scopes">
      <div><label htmlFor="wb-context-dit">Область</label><select id="wb-context-dit" value={path.ditId} disabled={disabled} onChange={event => {const selected=rootChoices.find(e=>e.id===event.target.value);void apply({scopePath:{ditId:event.target.value,rootKind:selected?.kind==='block'?'block':selected?.kind==='tribe'?'tribe':undefined}});}}><option value="" disabled>Выберите область</option>{rootChoices.map(e=><option key={e.id} value={e.id}>{e.name} · {e.kind==='dit'?'ДИТ':e.kind==='block'?'Блок':'Трайб'}</option>)}</select></div>
      <div><label htmlFor="wb-context-cluster">Кластер</label><select id="wb-context-cluster" value={path.clusterId ?? ''} disabled={disabled} onChange={event => void apply({ scopePath: { clusterId: event.target.value || null } })}><option value="">Все кластеры области</option>{clusters.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
      {!directTeams&&<div><label htmlFor="wb-context-product">Продукт</label><select id="wb-context-product" value={path.productId ?? ''} disabled={disabled || !path.clusterId} onChange={event => void apply({ scopePath: { productId: event.target.value || null } })}><option value="">Все продукты кластера</option>{choices('product', path.clusterId, 'cluster_product')}</select></div>}
      <div><label htmlFor="wb-context-team">Команда</label><select id="wb-context-team" value={path.teamId ?? ''} disabled={disabled || !(directTeams?path.clusterId:path.productId)} onChange={event => void apply({ scopePath: { teamId: event.target.value || null } })}><option value="">{directTeams?'Все команды кластера':'Все команды продукта'}</option>{choices('team',directTeams?path.clusterId:path.productId,directTeams?'cluster_team':'product_team')}</select></div>
    </div>
    <form className="wb-context-time" onSubmit={event => {
      event.preventDefault();
      try { const time = businessTimeFromRange(mode === 'as_of' ? { at: date } : { from: start, to: end }); void apply({ time }); }
      catch { setError('Укажите существующую дату или период, в котором конец позже начала. Конец периода не включается.'); }
    }}>
      <div><label htmlFor="wb-context-time-mode">Режим времени</label><select id="wb-context-time-mode" value={mode} disabled={checking} onChange={event => setMode(event.target.value as 'as_of' | 'period')}><option value="as_of">На дату</option><option value="period">За период</option></select></div>
      {mode === 'as_of' ? <div><label htmlFor="wb-context-date">Дата результата</label><input id="wb-context-date" type="date" required value={date} disabled={checking} onChange={event => setDate(event.target.value)} /></div> : <>
        <div><label htmlFor="wb-context-from">Начало периода — включительно</label><input id="wb-context-from" type="date" required value={start} disabled={checking} onChange={event => setStart(event.target.value)} /></div>
        <div><label htmlFor="wb-context-to">Конец периода — не включается</label><input id="wb-context-to" type="date" required value={end} disabled={checking} onChange={event => setEnd(event.target.value)} /></div>
      </>}
      <button type="submit" disabled={checking || saving > 0}>Применить время</button>
    </form>
      </div>
    </details>
    {saving > 0 && <p role="status">Сохраняем выбранный контекст…</p>}
    {error !== null && <p role="alert">{typeof error === 'string' ? error : workbenchErrorMessage(error)}</p>}
  </section>;
}
