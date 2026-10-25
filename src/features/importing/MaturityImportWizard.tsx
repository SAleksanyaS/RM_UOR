import { ArrowLeft, ArrowRight, Check, CheckCheck, FileSpreadsheet, LoaderCircle, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDialog, useWorkspace } from '../../app/AppContext';
import { formatDate, formatValue, sourceDisplayName } from '../overview/overview-model';
import type { ImportMatch, MaturityImportInput, MaturityImportPreview, MaturityImportResult } from './import-contracts';
import { canImportMaturityGoal, validateImportFile, validReportingDate } from './import-ui-model';

function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const data = String(reader.result || ''); const divider = data.indexOf(','); if (divider < 0) reject(new Error('Не удалось прочитать файл. Выберите его ещё раз.')); else resolve(data.slice(divider + 1)); };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл. Проверьте, что он доступен.'));
    reader.readAsDataURL(file);
  });
}
export function MaturityImportWizard({ goalId, sourceId, onClose, onSaved }: { goalId?: string; sourceId?: string; onClose: () => void; onSaved?: () => void }) {
  const { state, mutate, notify } = useWorkspace();
  const goals = state.catalog.goals.filter(goal => canImportMaturityGoal(goal, state.catalog.sources, state.snapshots || []));
  const initialGoalId = goals.some(goal => goal.id === goalId) ? goalId! : goals[0]?.id || '';
  const [form, setForm] = useState({ goalId: initialGoalId, sourceId: sourceId || '', period: '', sourceDateKnown: false, sourceUpdatedAt: '' });
  const [file, setFile] = useState<{ name: string; base64: string; size: number } | null>(null);
  const [teamMapping, setTeamMapping] = useState<Record<string, string>>({});
  const [metricMapping, setMetricMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<MaturityImportPreview | null>(null);
  const [recognition, setRecognition] = useState<MaturityImportPreview | null>(null);
  const [parametersOpen, setParametersOpen] = useState(true);
  const [busy, setBusy] = useState<'reading' | 'preview' | 'commit' | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useDialog(() => { if (busy !== 'commit') onClose(); });
  useEffect(() => () => { generation.current++; }, []);
  const sources = state.catalog.sources.filter(source => source.goalIds.includes(form.goalId) && (source.kind === 'file' || source.kind === 'manual'));
  if (state.session.role !== 'curator') return <div role="note">Загрузка доступна куратору УОР</div>;
  function invalidate() { generation.current++; setPreview(null); }
  function changeForm(patch: Partial<typeof form>) { invalidate(); setRecognition(null); setError(''); setForm(current => ({ ...current, ...patch })); if (patch.goalId !== undefined) { setTeamMapping({}); setMetricMapping({}); setForm(current => ({ ...current, sourceId: '' })); } }
  async function chooseFile(selected?: File) {
    if (!selected) return;
    invalidate(); setRecognition(null); setFile(null); setBusy(null); setError(''); setTeamMapping({}); setMetricMapping({});
    const fileError = validateImportFile(selected);
    if (fileError) { setError(fileError); return; }
    const revision = generation.current;
    setBusy('reading');
    try { const base64 = await fileBase64(selected); if (revision === generation.current) setFile({ name: selected.name, size: selected.size, base64 }); }
    catch (failure) { if (revision === generation.current) setError((failure as Error).message); }
    finally { if (revision === generation.current) setBusy(null); }
  }
  const ready = !!file && !!form.goalId && validReportingDate(form.period) && (!form.sourceDateKnown || !!form.sourceUpdatedAt);
  async function recognize() {
    if (!ready || !file) return;
    invalidate(); const revision = generation.current; setBusy('preview'); setError('');
    try {
      const input: MaturityImportInput = { name: file.name, base64: file.base64, goalId: form.goalId, sourceId: form.sourceId || null, period: form.period, sourceUpdatedAt: form.sourceDateKnown ? new Date(form.sourceUpdatedAt).toISOString() : null, teamMapping, metricMapping };
      const result = await mutate('/api/import/maturity/preview', input) as MaturityImportPreview;
      if (revision !== generation.current) return;
      setRecognition(result); setPreview(result); setParametersOpen(false);
    } catch (failure) { if (revision === generation.current) setError((failure as Error).message); }
    finally { if (revision === generation.current) setBusy(null); }
  }
  function chooseMapping(kind: 'team' | 'metric', key: string, value: string) {
    invalidate(); setError('');
    const update = (current: Record<string, string>) => { const next = { ...current }; if (value) next[key] = value; else delete next[key]; return next; };
    if (kind === 'team') setTeamMapping(update); else setMetricMapping(update);
  }
  async function commit() {
    if (!preview?.canCommit || preview.duplicateSnapshotId || busy) return;
    const revision = generation.current; setBusy('commit'); setError('');
    try { const result = await mutate('/api/import/maturity/commit', { previewId: preview.id }) as MaturityImportResult; if (revision !== generation.current) return; notify(result.duplicate ? 'Срез уже загружен. Повторная запись не создана.' : 'Личный срез сохранён. Положительный результат ожидает проверки УОР.'); onSaved?.(); onClose(); }
    catch (failure) { setError((failure as Error).message); setPreview(null); }
    finally { setBusy(null); }
  }
  const unresolvedTeams = recognition?.teamMatches.filter(match => match.status !== 'matched') || [];
  const unresolvedMetrics = recognition?.metricMatches.filter(match => match.status !== 'matched') || [];
  const needsMapping = unresolvedTeams.length + unresolvedMetrics.length > 0;
  return <div className="modal-overlay" onClick={busy === 'commit' ? undefined : onClose}><section className="modal maturity-import-modal" role="dialog" aria-modal="true" aria-label="Загрузить Excel модели зрелости" onClick={event => event.stopPropagation()}><div className="modal-heading"><div><span className="import-overline">ЛОКАЛЬНАЯ ЗАГРУЗКА ДАННЫХ</span><h2>Excel модели зрелости</h2></div><button type="button" className="icon-button" aria-label="Закрыть импорт" onClick={onClose} disabled={busy === 'commit'}><X size={21}/></button></div><div className="import-steps"><span className={parametersOpen ? 'active' : 'done'}><i>{parametersOpen ? '1' : <Check size={12}/>}</i>Файл и даты</span><b/><span className={recognition ? 'active' : ''}><i>2</i>Проверка</span><b/><span className={preview?.canCommit ? 'active' : ''}><i>3</i>Сохранение</span></div>
    <div className="import-scroll-area">{parametersOpen ? <div className="import-parameters"><label className="field">Цель<select disabled={!!busy} value={form.goalId} onChange={event => changeForm({ goalId: event.target.value })}>{goals.length === 0 && <option value="">Нет цели с настроенными показателями</option>}{goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></label><label className="field">Источник<select disabled={!!busy} value={form.sourceId} onChange={event => changeForm({ sourceId: event.target.value })}><option value="">Определить локальный источник для этой цели</option>{sources.map(source => <option key={source.id} value={source.id}>{sourceDisplayName(source, state.catalog)}</option>)}</select></label><label className={`import-file-drop ${file ? 'selected' : ''}`}><input aria-label="Файл XLSX" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={!!busy} onChange={event => { void chooseFile(event.target.files?.[0]); event.target.value = ''; }}/><span className="import-file-icon"><FileSpreadsheet size={26}/></span><span><strong>{file ? file.name : 'Выберите выгрузку XLSX'}</strong><small>{busy === 'reading' ? 'Читаем файл…' : file ? `${(file.size / 1024).toFixed(0)} КБ · нажмите, чтобы заменить` : 'До 10 МБ · исходный файл останется на этом компьютере'}</small></span><Upload size={19}/></label><label className="field">Период данных<input aria-label="Период данных" type="date" disabled={!!busy} value={form.period} onChange={event => changeForm({ period: event.target.value })}/></label><p className="import-date-help">Укажите дату, за которую источник показывает факты. Она не определяется по имени файла или времени загрузки.</p><label className="import-checkbox"><input type="checkbox" checked={form.sourceDateKnown} disabled={!!busy} onChange={event => changeForm({ sourceDateKnown: event.target.checked })}/><span>Известна дата обновления источника</span></label>{form.sourceDateKnown ? <label className="field">Обновление источника<input type="datetime-local" disabled={!!busy} value={form.sourceUpdatedAt} onChange={event => changeForm({ sourceUpdatedAt: event.target.value })}/></label> : <div className="import-unknown-date">Дата обновления источника: не указана</div>}</div> : <div className="import-file-summary"><FileSpreadsheet size={20}/><div><strong>{file?.name}</strong><span>Период: {formatDate(form.period)} · {state.catalog.goals.find(goal => goal.id === form.goalId)?.title}</span></div><button className="text-button" disabled={!!busy} onClick={() => setParametersOpen(true)}>Изменить файл и даты</button></div>}
    {recognition && !parametersOpen && <div className="import-recognition">{needsMapping && <section className="import-mapping-section"><h3>Уточните соответствия</h3><p>Выберите известные команды и показатели. Новые правила не создаются автоматически из файла.</p>{unresolvedTeams.map(match => <MappingField key={`team-${match.key}`} match={match} kind="team" value={teamMapping[match.key] || ''} disabled={!!busy} onChange={value => chooseMapping('team', match.key, value)}/>)}{unresolvedMetrics.map(match => <MappingField key={`metric-${match.key}`} match={match} kind="metric" value={metricMapping[match.key] || ''} disabled={!!busy} onChange={value => chooseMapping('metric', match.key, value)}/>)}</section>}{!preview && <div className="import-recheck-note">Параметры изменены. Повторите проверку перед сохранением.</div>}{preview && <><h3 className="import-preview-title">Предварительный результат</h3><div className="import-preview-totals"><div><strong>{preview.summary.teams}</strong><span>команд</span></div><div><strong>{preview.summary.eligibleMetrics}</strong><span>оцениваемых метрик</span></div><div><strong>{preview.summary.excluded}</strong><span>исключено</span></div><div><strong>{preview.summary.missing}</strong><span>пропусков</span></div></div>{preview.duplicateSnapshotId && <div className="import-duplicate"><CheckCheck size={20}/><div><strong>Срез уже загружен</strong><span>Идентичные факты за этот период уже есть. Новая запись не требуется.</span></div></div>}<section className="import-changes" aria-label="Изменения относительно предыдущего среза">{[{ label: 'Добавлено', count: preview.changes.added }, { label: 'Изменено', count: preview.changes.changed }, { label: 'Не вошло в новый срез', count: preview.changes.removed }, { label: 'Без изменений', count: preview.changes.unchanged }].map(item => <div key={item.label} aria-label={`${item.label}: ${item.count}`}><strong>{item.count}</strong><span>{item.label}</span></div>)}</section>{preview.evaluation && <div className="import-evaluation"><span>Расчётный факт после загрузки</span><strong>{formatValue(preview.evaluation.actual, state.catalog.goals.find(goal => goal.id === form.goalId)?.unit || '%')}</strong><small>Сохранение не подтверждает выполнение цели.</small></div>}{preview.issues.length > 0 && <div className="import-issues">{preview.issues.slice(0, 4).map((issue, index) => <p className={issue.severity === 'error' ? 'error-inline' : 'warning-inline'} key={index}>{issue.rowNumber ? `Строка ${issue.rowNumber}: ` : ''}{issue.message}</p>)}{preview.issues.length > 4 && <details className="detail-accordion"><summary>Все замечания ({preview.issues.length})</summary><div className="accordion-body">{preview.issues.map((issue, index) => <p className="muted" key={index}>{issue.message}</p>)}</div></details>}</div>}<details className="detail-accordion"><summary>Что распознано в файле</summary><div className="accordion-body"><dl className="details-list"><dt>Строк с фактами</dt><dd>{preview.summary.rows}</dd><dt>Не сопоставлены команды</dt><dd>{preview.summary.unmappedTeams}</dd><dt>Не сопоставлены показатели</dt><dd>{preview.summary.unmappedMetrics}</dd><dt>Период</dt><dd>{formatDate(preview.period)}</dd></dl>{preview.sample.length > 0 && <div className="observations-table import-sample-table"><table><thead><tr><th>Команда / показатель</th><th>Факт</th><th>Порог</th></tr></thead><tbody>{preview.sample.slice(0, 10).map((observation, index) => <tr key={observation.id || index}><td><strong>{observation.participantName}</strong><small>{observation.metricName}</small></td><td>{formatValue(observation.value, observation.unit)}</td><td>{formatValue(observation.target, observation.unit)}</td></tr>)}</tbody></table></div>}</div></details></>}</div>}
    {error && <div className="error-inline" role="alert">{error}</div>}</div><div className="import-modal-footer"><span><ShieldCheck size={14}/>Личный срез · без автоматической публикации</span><div><button className="button secondary" disabled={!!busy} onClick={onClose}>{preview?.duplicateSnapshotId ? 'Готово' : 'Отмена'}</button>{preview?.canCommit && !preview.duplicateSnapshotId && !parametersOpen ? <button className="button primary" disabled={!!busy} onClick={() => void commit()}>{busy === 'commit' ? <LoaderCircle size={15} className="spinning"/> : <Check size={16}/>}Сохранить личный срез</button> : !preview?.duplicateSnapshotId && <button className="button primary" disabled={!!busy || !ready} onClick={() => void recognize()}>{busy === 'preview' ? <LoaderCircle size={15} className="spinning"/> : recognition ? <RefreshCw size={15}/> : <ArrowRight size={15}/ >}{recognition ? 'Проверить исправления' : 'Проверить файл'}</button>}</div></div></section></div>;
}
function MappingField({ match, kind, value, disabled, onChange }: { match: ImportMatch; kind: 'team' | 'metric'; value: string; disabled: boolean; onChange: (value: string) => void }) {
  return <label className="field import-mapping-field"><span>{kind === 'team' ? 'Команда' : 'Показатель'}: <strong>{match.name}</strong><small>{match.status === 'ambiguous' ? 'Найдено несколько соответствий' : 'Автоматическое соответствие не найдено'}</small></span><select aria-label={`${kind === 'team' ? 'Сопоставить команду' : 'Сопоставить показатель'}: ${match.name}`} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">Выберите соответствие</option>{match.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>;
}
