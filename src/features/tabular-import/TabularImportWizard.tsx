import { useEffect, useRef, useState } from 'react';
import { X, FileSpreadsheet, Upload, Check, ArrowRight, LoaderCircle } from 'lucide-react';
import { useDialog, useWorkspace } from '../../app/AppContext';
import type { ColumnRole, ImportOption, TabularImportProfile, TabularPreview, TabularProbe, TabularResult } from './contracts';
import './tabular-import.css';

const labels: Record<ColumnRole, string> = { value: 'Значение', period: 'Период', leader: 'ИТ-лидер', participant: 'Участник', metric: 'Показатель', target: 'Порог', state: 'Состояние', reason: 'Причина', sourceUpdatedAt: 'Обновление источника' };
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Не удалось прочитать файл')); reader.readAsDataURL(file); });
}
export function TabularImportWizard({ goalId, sourceId, onClose }: { goalId: string; sourceId?: string; onClose: () => void }) {
  const { state, mutate, refresh, notify } = useWorkspace();
  const goal = state.catalog.goals.find(g => g.id === goalId), sources = state.catalog.sources.filter(s => s.goalIds.includes(goalId) && ['file', 'manual', 'attachment', 'dashboard'].includes(s.kind));
  const [selectedSource, setSource] = useState(sourceId ?? (sources.length === 1 ? sources[0].id : ''));
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null), [probe, setProbe] = useState<TabularProbe | null>(null);
  const [profile, setProfile] = useState<TabularImportProfile | null>(null), [preview, setPreview] = useState<TabularPreview | null>(null);
  const [sourceDate, setSourceDate] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [entryMode, setEntryMode] = useState<'file' | 'paste'>('file'), [pasted, setPasted] = useState('');
  const generation = useRef(0); useEffect(() => () => { generation.current++; }, []);
  useDialog(() => { if (!busy) onClose(); });
  if (state.session.role !== 'curator') return <div role="note">Загрузка доступна куратору УОР</div>;
  const edit = (next: TabularImportProfile) => { generation.current++; setProfile(next); setPreview(null); setError(''); };
  const payload = () => {
    const data = entryMode === 'file' ? file! : { name: 'Вставленная таблица.csv', base64: btoa(Array.from(new TextEncoder().encode(pasted), byte => String.fromCharCode(byte)).join('')) };
    return { ...data, goalId, sourceId: selectedSource || undefined };
  };
  async function choose(file?: File) {
    const token = ++generation.current; setBusy(false); setFile(null); setProbe(null); setProfile(null); setPreview(null); setError('');
    if (!file) return;
    if (!/\.(csv|xlsx)$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024) { setError('Выберите CSV или XLSX размером до 10 МБ'); return; }
    setBusy(true);
    try { const base64 = await readFile(file); if (generation.current === token) setFile({ name: file.name, base64 }); }
    catch (e) { if (generation.current === token) setError((e as Error).message); }
    finally { if (generation.current === token) setBusy(false); }
  }
  async function run(kind: 'probe' | 'preview' | 'commit') {
    const token = ++generation.current; setBusy(true); setError('');
    try {
      if (kind === 'probe') {
        const result = await mutate('/api/import/tabular/probe', payload()) as TabularProbe;
        if (generation.current !== token) return; setProbe(result); setProfile(result.profile); setPreview(null);
      } else if (kind === 'preview') {
        const result = await mutate('/api/import/tabular/preview', { ...payload(), profile, sourceUpdatedAt: sourceDate || null }) as TabularPreview;
        if (generation.current === token) setPreview(result);
      } else {
        const result = await mutate('/api/import/tabular/commit', { previewId: preview!.id }) as TabularResult;
        await refresh(); notify(result.duplicate ? 'Идентичный срез уже сохранён' : 'Личный срез сохранён'); onClose();
      }
    } catch (e) { if (generation.current === token) setError((e as Error).message); }
    finally { if (generation.current === token) setBusy(false); }
  }
  function column(role: ColumnRole, value: string) {
    const columns = { ...profile!.columns }; if (value) columns[role] = value; else delete columns[role];
    edit({ ...profile!, columns });
  }
  const mappingFields: { role: 'leader' | 'participant' | 'metric'; mapping: 'leaderMapping' | 'participantMapping' | 'metricMapping'; options: ImportOption[] }[] = probe ? [{ role: 'leader', mapping: 'leaderMapping', options: probe.options.leaders }, { role: 'participant', mapping: 'participantMapping', options: probe.options.participants }, { role: 'metric', mapping: 'metricMapping', options: probe.options.metrics }] : [];
  return <div className="modal-overlay"><section className="modal tabular-import" role="dialog" aria-modal="true" aria-label="Импорт таблицы"><header className="tabular-header"><div><h2>Импорт таблицы</h2><p>{goal?.title}</p></div><button className="icon-button" aria-label="Закрыть импорт" disabled={busy} onClick={onClose}><X size={20}/></button></header>
    <div className="tabular-body"><p className="muted">Файл → колонки → соответствия → расчёт → принятие. Исходник останется на этом компьютере.</p>
    <label className="field">Источник<select aria-label="Источник таблицы" value={selectedSource} disabled={busy} onChange={event => { generation.current++; setSource(event.target.value); setProbe(null); setProfile(null); setPreview(null); }}><option value="">{sources.length ? 'Выберите источник' : 'Создать локальный файловый источник'}</option>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    {sources.find(s => s.id === selectedSource)?.kind === 'dashboard' && <p className="tabular-warning">Ручная выгрузка дашборда. Вставьте таблицу или загрузите файл; автоматический сбор здесь не выполняется.</p>}
    <div className="tabular-entry-switch" role="group" aria-label="Способ ввода"><button className="button secondary" aria-pressed={entryMode === 'file'} disabled={busy} onClick={() => { generation.current++; setEntryMode('file'); setProbe(null); setProfile(null); setPreview(null); setError(''); }}>Загрузить файл</button><button className="button secondary" aria-pressed={entryMode === 'paste'} disabled={busy} onClick={() => { generation.current++; setEntryMode('paste'); setProbe(null); setProfile(null); setPreview(null); setError(''); }}>Вставить таблицу</button></div>
    {entryMode === 'file' ? <label className="tabular-file"><FileSpreadsheet size={24}/><span><strong>{file?.name ?? 'Выберите CSV или XLSX'}</strong><small>UTF-8 для CSV · один лист XLSX · до 10 МБ</small></span><Upload size={18}/><input aria-label="Файл CSV или XLSX" type="file" accept=".csv,.xlsx" disabled={busy} onChange={event => { void choose(event.target.files?.[0]); event.target.value = ''; }}/></label> : <label className="field">Таблица CSV<textarea aria-label="Таблица CSV" rows={7} disabled={busy} placeholder={'Участник;Значение\nИмя участника;90'} value={pasted} onChange={e => { generation.current++; setPasted(e.target.value); setProbe(null); setProfile(null); setPreview(null); setError(''); }}/><small>Первая строка — названия колонок. Можно вставить строки из Excel с табуляцией или разделителем «;».</small></label>}
    {!probe && <button className="button primary" disabled={busy || (entryMode === 'file' ? !file : !pasted.trim() || new TextEncoder().encode(pasted).length > 10 * 1024 * 1024) || sources.length > 0 && !selectedSource} onClick={() => void run('probe')}><ArrowRight size={15}/>Прочитать колонки</button>}
    <a className="tabular-template" download="sample-facts.csv" href={'data:text/csv;charset=utf-8,' + encodeURIComponent('\uFEFFПериод;ИТ-лидер;Участник;Показатель;Значение;Состояние;Причина\n2026-10-24;имя лидера;имя участника;имя показателя;90;numeric;\n')}>Скачать образец CSV</a>
    {probe && profile && <fieldset disabled={busy} className="tabular-fieldset"><legend>Сопоставьте колонки</legend><p>Поля без колонки берутся из выбранных ниже значений. Даты в файле: YYYY-MM-DD, дата обновления — ISO с часовым поясом.</p><div className="tabular-grid">{(Object.keys(labels) as ColumnRole[]).map(role => <label className="field" key={role}>{labels[role]}{role === 'value' ? ' *' : ''}<select aria-label={`Колонка: ${labels[role]}`} value={profile.columns[role] ?? ''} onChange={e => column(role, e.target.value)}><option value="">{role === 'value' ? 'Выберите колонку' : 'Не используется'}</option>{probe.columns.map(c => <option key={c} value={c}>{c}</option>)}</select></label>)}</div>
      <div className="tabular-grid"><label className="field">Период данных<input aria-label="Период данных" type="date" value={profile.defaults.period} onChange={e => edit({ ...profile, defaults: { ...profile.defaults, period: e.target.value } })}/></label><label className="field">Обновление источника (если известно)<input aria-label="Дата обновления источника" placeholder="2026-10-24T12:00:00+03:00" value={sourceDate} onChange={e => { generation.current++; setSourceDate(e.target.value); setPreview(null); }}/></label>
      {!profile.columns.metric && <label className="field">Показатель для всех строк<select aria-label="Показатель для всех строк" value={profile.defaults.metricId ?? ''} onChange={e => edit({ ...profile, defaults: { ...profile.defaults, metricId: e.target.value || undefined } })}><option value="">Выберите показатель</option>{probe.options.metrics.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
      {!profile.columns.participant && goal?.measurement && <label className="field">Участник для всех строк<select aria-label="Участник для всех строк" value={profile.defaults.participantId ?? ''} onChange={e => edit({ ...profile, defaults: { ...profile.defaults, participantId: e.target.value || undefined } })}><option value="">Выберите участника или колонку</option>{probe.options.participants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      {!profile.columns.leader && <label className="field">Область показателя<select aria-label="Область показателя" value={profile.defaults.leaderId === null ? '__global' : profile.defaults.leaderId ?? ''} onChange={e => { const defaults = { ...profile.defaults }; if (!e.target.value) delete defaults.leaderId; else defaults.leaderId = e.target.value === '__global' ? null : e.target.value; edit({ ...profile, defaults }); }}><option value="">{goal?.measurement || profile.columns.participant ? 'По назначениям участника' : 'Выберите область явно'}</option>{(goal?.scopeType === 'global' || !goal?.measurement && !profile.columns.participant) && <option value="__global">Общий показатель ДИТ</option>}{probe.options.leaders.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}</div>
      {mappingFields.map(({ role, mapping, options }) => profile.columns[role] && <IdentityMapping key={role} label={labels[role]} values={probe.columnValues[profile.columns[role]!] ?? []} options={options} selected={profile[mapping]} onChange={(key, value) => { const next = { ...profile[mapping] }; if (value) next[key] = value; else delete next[key]; edit({ ...profile, [mapping]: next }); }}/>)}</fieldset>}
    {probe && <details className="tabular-raw"><summary>Первые строки файла</summary><div className="tabular-table"><table><thead><tr>{probe.columns.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{probe.rows.map(row => <tr key={row.rowNumber}>{row.cells.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody></table></div></details>}
    {preview && <section className="tabular-preview" aria-label="Предпросмотр фактов"><h3>Ожидаемый результат</h3><p>Строк: {preview.rows} · фактов: {preview.facts} · период: {preview.period}</p>{preview.duplicateSnapshotId && <p className="tabular-warning">Идентичный срез уже сохранён. Повторное принятие не создаст копию.</p>}{preview.evaluations.map(e => <p key={e.id}>{e.leaderId ? probe?.options.leaders.find(l => l.id === e.leaderId)?.name : 'Цель в целом'}: <strong>{e.actual === null ? 'Нет полного расчёта' : e.actual}</strong> · пропусков: {e.missing} · {e.official === 'met' ? 'расчётное выполнение, ожидает УОР' : e.official === 'not_met' ? 'цель не выполнена' : 'недостаточно данных'}</p>)}{preview.issues.map((i, index) => <p key={index} className={i.severity === 'error' ? 'error-inline' : 'tabular-warning'}>{i.rowNumber ? `Строка ${i.rowNumber}: ` : ''}{i.message}</p>)}<div className="tabular-table"><table><thead><tr><th>Участник</th><th>Показатель</th><th>Факт</th><th>Порог</th><th>Причина</th></tr></thead><tbody>{preview.sample.map(o => <tr key={o.id}><td>{o.participantName}</td><td>{o.metricName}</td><td>{o.state === 'numeric' ? o.value : o.state}</td><td>{o.target ?? '—'}</td><td>{o.reason ?? '—'}</td></tr>)}</tbody></table></div><p className="muted">Принятие сохраняет личный срез и профиль. Подтверждение УОР и публикация выполняются отдельно.</p></section>}
    {error && <div className="error-inline" role="alert">{error}</div>}</div>
    <footer className="tabular-footer"><button className="button secondary" disabled={busy} onClick={onClose}>Отмена</button>{probe && <button className="button secondary" disabled={busy || !profile?.columns.value || !profile.defaults.period} onClick={() => void run('preview')}>{busy && <LoaderCircle size={15}/>}Рассчитать предпросмотр</button>}{preview?.canCommit && <button className="button primary" disabled={busy} onClick={() => void run('commit')}><Check size={15}/>Принять факты</button>}</footer>
  </section></div>;
}
function IdentityMapping({ label, values, options, selected, onChange }: { label: string; values: string[]; options: ImportOption[]; selected: Record<string, string>; onChange: (key: string, value: string) => void }) {
  const [filter, setFilter] = useState('');
  const displayed = values.filter(v => v.toLocaleLowerCase('ru').includes(filter.toLocaleLowerCase('ru')));
  return <section className="tabular-identities"><h3>{label}: значения из файла</h3><p>Совпадение по уникальному имени или идентификатору используется автоматически. Для других значений выберите соответствие.</p>{values.length > 30 && <label className="field">Найти значение<input aria-label={`Найти: ${label}`} value={filter} onChange={e => setFilter(e.target.value)}/></label>}{displayed.slice(0, 100).map(value => <label className="field tabular-identity" key={value}><span>{value}</span><select aria-label={`${label}: ${value}`} value={selected[value] ?? ''} onChange={e => onChange(value, e.target.value)}><option value="">По уникальному имени / ID</option>{options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>)}{displayed.length > 100 && <p>Показано 100 из {displayed.length}. Уточните поиск для остальных значений.</p>}</section>;
}
