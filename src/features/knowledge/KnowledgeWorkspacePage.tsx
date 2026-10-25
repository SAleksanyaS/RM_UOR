import { useEffect, useState } from 'react';
import { Archive, BookOpen, ExternalLink, Plus, RotateCcw, Search, Settings2, X } from 'lucide-react';
import { useDialog, useWorkspace } from '../../app/AppContext';
import { knowledgeLabels, knowledgeTypes, type KnowledgeInput, type KnowledgeRecord, type KnowledgeResult, type KnowledgeType } from './knowledge-contracts';
import './knowledge.css';

export function KnowledgeWorkspacePage() {
  const { state, mutate, notify } = useWorkspace();
  const [records, setRecords] = useState<KnowledgeRecord[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [search, setSearch] = useState(''), [type, setType] = useState('all'), [archive, setArchive] = useState('active');
  const [selectedId, setSelectedId] = useState<string | null>(null), [editing, setEditing] = useState<KnowledgeRecord | 'new' | null>(null);
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const curator = state.session.role === 'curator', selected = records.find(record => record.id === selectedId);
  useEffect(() => {
    let active = true; const controller = new AbortController(); setLoading(true);
    void fetch('/api/knowledge', { signal: controller.signal }).then(async response => {
      const result = await response.json() as { records?: KnowledgeRecord[]; message?: string };
      if (!response.ok) throw new Error(result.message || 'Не удалось получить базу знаний');
      if (active) { setRecords(result.records ?? []); setError(''); }
    }).catch(failure => { if (active) setError((failure as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [state.catalog.entities, reload]);
  function accept(result: KnowledgeResult) {
    setRecords(current => [...current.filter(record => record.id !== result.record.id), result.record]);
    setSelectedId(result.record.id); setEditing(null); notify('Запись базы знаний сохранена в общий черновик. Её можно отправить в готовящийся выпуск.');
  }
  async function toggleArchive() {
    if (!selected) return; setBusy(true); setError('');
    try { accept(await mutate(`/api/knowledge/${encodeURIComponent(selected.id)}/archive`, { baseRevision: selected.revision, archived: !selected.archivedAt }) as KnowledgeResult); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  const query = search.toLocaleLowerCase('ru');
  const visible = records.filter(record => (type === 'all' || record.type === type || type === 'service' && record.type === 'it_service') && (archive === 'all' || (archive === 'archived') === !!record.archivedAt)
    && `${record.name} ${record.description} ${record.body} ${(record.aliases ?? []).join(' ')}`.toLocaleLowerCase('ru').includes(query))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return <section className="kw-page"><div className="page-heading"><div><div className="eyebrow">ОБЩИЕ ЗНАНИЯ И ОТВЕТСТВЕННОСТЬ</div><h1>База знаний</h1><p>Команды, продукты, ИТ-услуги и понятные правила работы с целями.</p></div>{curator ? <button className="button primary" onClick={() => setEditing('new')}><Plus size={17}/>Добавить запись</button> : <BookOpen size={30}/>}</div>
    <p className="kw-boundary">Справочные связи описывают текущий состав. Они не заменяют историю организационной структуры или измеренные результаты.</p>
    <div className="kw-toolbar"><label className="search-box"><Search size={17}/><input aria-label="Поиск в базе знаний" placeholder="Название, методика или участник" value={search} onChange={event => setSearch(event.target.value)}/></label><label>Тип<select aria-label="Тип записей" value={type} onChange={event => setType(event.target.value)}><option value="all">Все типы</option>{knowledgeTypes.filter(item => item !== 'it_service').map(item => <option value={item} key={item}>{knowledgeLabels[item]}</option>)}</select></label><label>Показать<select aria-label="Активные или архив" value={archive} onChange={event => setArchive(event.target.value)}><option value="active">Действующие</option><option value="archived">Архив</option><option value="all">Все записи</option></select></label><span>{visible.length} записей</span></div>
    {error && <div className="error-inline" role="alert">{error}<button className="text-button" onClick={() => setReload(value => value + 1)}>Обновить записи</button></div>}
    {loading ? <p role="status">Загружаем базу знаний…</p> : <div className="kw-layout"><div className="kw-list" aria-label="Записи базы знаний">{visible.map(record => <button className={`kw-list-item ${record.id === selectedId ? 'selected' : ''}`} key={record.id} onClick={() => { setSelectedId(record.id); setError(''); }} aria-label={record.name}><span className="inline-tag">{knowledgeLabels[record.type]}</span><strong>{record.name}</strong>{record.description && <span>{record.description}</span>}<small>{state.catalog.leaders.find(leader => leader.id === record.leaderId)?.name || 'Общая запись'}{record.archivedAt ? ' · В архиве' : ''}</small></button>)}{!visible.length && <div className="empty-state"><h2>Записей по этому запросу нет</h2><p>Измените поиск или фильтр. Куратор может добавить новую запись.</p></div>}</div>
      <article className="kw-reader">{selected ? <><div className="kw-reader-heading"><div><span className="eyebrow">{knowledgeLabels[selected.type]}{selected.archivedAt ? ' · АРХИВ' : ''}</span><h2>{selected.name}</h2></div>{curator && <div className="kw-record-actions"><button className="button secondary" disabled={busy} onClick={() => setEditing(selected)} aria-label="Изменить запись"><Settings2 size={16}/>Изменить</button><button className="text-button" disabled={busy} onClick={() => void toggleArchive()}>{selected.archivedAt ? <RotateCcw size={16}/> : <Archive size={16}/>} {selected.archivedAt ? 'Восстановить' : 'В архив'}</button></div>}</div>{selected.description && <p className="kw-description">{selected.description}</p>}
        <dl className="kw-relations">{selected.leaderId && <><dt>ИТ-лидер</dt><dd>{state.catalog.leaders.find(leader => leader.id === selected.leaderId)?.name || 'Связь не найдена'}</dd></>}{selected.productId && <><dt>Продукт</dt><dd>{records.find(record => record.id === selected.productId)?.name || state.catalog.entities.find(entity => entity.id === selected.productId)?.name || 'Связь не найдена'}</dd></>}{selected.aliases?.length ? <><dt>Другие названия</dt><dd>{selected.aliases.join(' · ')}</dd></> : null}</dl>
        {selected.body ? <div className="kw-article-body">{selected.body}</div> : <p className="muted">Описание и инструкция пока не добавлены.</p>}
        {selected.goalIds.length > 0 && <div className="kw-linked-goals"><h3>Связанные цели</h3>{selected.goalIds.map(id => <p key={id}>{state.catalog.goals.find(goal => goal.id === id)?.title || 'Цель не найдена'}</p>)}</div>}
        {selected.links.length > 0 && <div className="kw-links"><h3>Материалы и источники</h3>{selected.links.map((link, index) => <a href={/^https?:\/\//i.test(link.url) ? link.url : undefined} target="_blank" rel="noopener noreferrer" key={index}><ExternalLink size={15}/>{link.label}</a>)}</div>}</> : <div className="empty-state"><BookOpen size={36}/><h2>Выберите запись</h2><p>Откройте команду, продукт или методику, чтобы увидеть описание и связанные материалы.</p></div>}</article></div>}
    {editing && <KnowledgeEditor record={editing === 'new' ? null : editing} records={records} onClose={() => setEditing(null)} onSaved={accept}/>}</section>;
}

function KnowledgeEditor({ record, records, onClose, onSaved }: { record: KnowledgeRecord | null; records: KnowledgeRecord[]; onClose: () => void; onSaved: (result: KnowledgeResult) => void }) {
  const { state, mutate } = useWorkspace(); useDialog(onClose);
  const [form, setForm] = useState<KnowledgeInput>({ type: record?.type ?? 'article', name: record?.name ?? '', description: record?.description ?? '', body: record?.body ?? '',
    aliases: record?.aliases ?? [], leaderId: record?.leaderId ?? null, productId: record?.productId ?? null, links: record?.links ?? [], goalIds: record?.goalIds ?? [], ...(record ? { baseRevision: record.revision } : {}) });
  const [aliases, setAliases] = useState((record?.aliases ?? []).join(', ')), [links, setLinks] = useState((record?.links ?? []).map(link => `${link.label} | ${link.url}`).join('\n'));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  function change(patch: Partial<KnowledgeInput>) { setForm(current => ({ ...current, ...patch })); }
  async function save() {
    setBusy(true); setError('');
    try {
      const parsedLinks = links.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const parts = line.split('|'); if (parts.length !== 2 || !parts[0].trim() || !/^https?:\/\//i.test(parts[1].trim())) throw new Error('Ссылки задаются по одной на строке: название | https://адрес'); return { label: parts[0].trim(), url: parts[1].trim() }; });
      const result = await mutate(record ? `/api/knowledge/${encodeURIComponent(record.id)}` : '/api/knowledge', { ...form, productId: form.type === 'product_leader' ? form.productId : null,
        aliases: aliases.split(',').map(value => value.trim()).filter(Boolean), links: parsedLinks }) as KnowledgeResult;
      onSaved(result);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  return <div className="modal-overlay" onClick={() => { if (!busy) onClose(); }}><form className="modal kw-editor" onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); void save(); }}><div className="modal-heading"><h2>{record ? 'Изменить запись' : 'Новая запись'}</h2><button type="button" aria-label="Закрыть редактор" disabled={busy} className="icon-button" onClick={onClose}><X size={20}/></button></div>
    <fieldset disabled={busy}><div className="kw-form-grid"><label className="field">Название<input required maxLength={500} value={form.name} onChange={event => change({ name: event.target.value })}/></label><label className="field">Тип записи<select disabled={!!record} value={form.type} onChange={event => change({ type: event.target.value as KnowledgeType })}>{knowledgeTypes.filter(type => type !== 'it_service' || record?.type === type).map(type => <option value={type} key={type}>{knowledgeLabels[type]}</option>)}</select></label></div>
      <label className="field">Краткое описание<textarea rows={2} maxLength={10000} value={form.description} onChange={event => change({ description: event.target.value })}/></label><label className="field">Текст методики или инструкции<textarea rows={8} maxLength={100000} value={form.body} onChange={event => change({ body: event.target.value })} placeholder="Обычный текст. Опишите порядок действий, правила расчёта и ограничения."/></label>
      <div className="kw-form-grid"><label className="field">ИТ-лидер<select value={form.leaderId ?? ''} onChange={event => change({ leaderId: event.target.value || null })}><option value="">Не связан</option>{state.catalog.leaders.map(leader => <option value={leader.id} key={leader.id}>{leader.name}</option>)}</select></label>{form.type === 'product_leader' && <label className="field">Продукт<select required value={form.productId ?? ''} onChange={event => change({ productId: event.target.value || null })}><option value="">Выберите продукт</option>{records.filter(item => item.type === 'product' && !item.archivedAt).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}</div>
      <label className="field">Другие названия, через запятую<input value={aliases} onChange={event => setAliases(event.target.value)}/></label><label className="field">Ссылки на материалы<textarea rows={3} value={links} onChange={event => setLinks(event.target.value)} placeholder="Название материала | https://example.com"/></label>
      <details><summary>Связанные цели ({form.goalIds.length})</summary><div className="kw-goal-choices">{state.catalog.goals.map(goal => <label key={goal.id}><input type="checkbox" checked={form.goalIds.includes(goal.id)} onChange={() => change({ goalIds: form.goalIds.includes(goal.id) ? form.goalIds.filter(id => id !== goal.id) : [...form.goalIds, goal.id] })}/>{goal.title}</label>)}</div></details>
    </fieldset>{error && <p className="error-inline" role="alert">{error}</p>}<p className="text-hint">Сохраняется общий черновик. Факты, история расчётов и подтверждения не изменяются.</p><div className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Отмена</button><button className="button primary" disabled={busy || !form.name.trim()}>{busy ? 'Сохраняем…' : 'Сохранить черновик'}</button></div></form></div>;
}
