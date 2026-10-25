import { useState } from 'react';
import { useWorkspace } from '../../app/AppContext';
import { reportNumber, reportOfficialTarget, reportStatus, type ReportSnapshot } from './report-contracts';
import { reportProfileSchema } from './report-profile-schema';
import './reporting.css';

export function ReportsPage({ onGoal }: { onGoal?: (goalId: string, leaderId?: string | null) => void }) {
  const { state, mutate, notify } = useWorkspace();
  const [goalIds, setGoalIds] = useState(() => state.catalog.goals.map(goal => goal.id));
  const [leaderIds, setLeaderIds] = useState(() => state.catalog.leaders.map(leader => leader.id));
  const periods = [...new Set(state.snapshots.map(snapshot => snapshot.period))].sort().reverse();
  const [period, setPeriod] = useState(periods[0] ?? new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<ReportSnapshot | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [profileName, setProfileName] = useState('');
  const profiles = state.catalog.entities.flatMap(entity => { const result = reportProfileSchema.safeParse(entity); return result.success ? [result.data] : []; });
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(value => value !== id) : [...values, id];
  async function generate() {
    setBusy(true); setError('');
    try { setReport(await mutate('/api/reports', { goalIds, leaderIds, period }) as ReportSnapshot); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  async function saveProfile() {
    setBusy(true); setError('');
    try { await mutate('/api/reports/profiles', { baseRevision: null, profile: { name: profileName, goalIds, leaderIds, period } }); setProfileName(''); notify('Профиль сохранён в локальный черновик. Опубликуйте его в общем каталоге.'); }
    catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  async function downloadHtml() {
    if (!report) return;
    try {
      const response = await fetch(`/api/reports/${report.id}/html`); if (!response.ok) throw new Error('Не удалось выгрузить HTML');
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a'); link.href = url; link.download = `uor-report-${report.selection.period}.html`; link.click(); URL.revokeObjectURL(url);
    } catch (failure) { setError((failure as Error).message); }
  }
  return <div className="reports-page"><header><h1>Отчёты</h1><p>Выберите состав и период фактов. После формирования снимок сохраняет значения, источники и подтверждения.</p></header>
    <section className="report-controls" aria-label="Состав отчёта"><div className="report-control-row"><label>Период фактов<input type="date" value={period} onChange={event => setPeriod(event.target.value)}/></label><label>Сохранённый состав<select defaultValue="" onChange={event => { const profile = profiles.find(item => item.id === event.target.value); if (profile) { setGoalIds(profile.goalIds); setLeaderIds(profile.leaderIds); setPeriod(profile.period); } }}><option value="">Выбрать профиль</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label></div>
      <div className="report-selections"><fieldset><legend>Цели ({goalIds.length})</legend><button type="button" onClick={() => setGoalIds(goalIds.length === state.catalog.goals.length ? [] : state.catalog.goals.map(item => item.id))}>{goalIds.length === state.catalog.goals.length ? 'Снять все' : 'Выбрать все'}</button><div>{state.catalog.goals.map(goal => <label key={goal.id}><input type="checkbox" checked={goalIds.includes(goal.id)} onChange={() => setGoalIds(toggle(goalIds, goal.id))}/><span>{goal.title}</span></label>)}</div></fieldset>
        <fieldset><legend>ИТ-лидеры ({leaderIds.length})</legend><p>Общий результат ДИТ включается отдельно для каждой цели.</p><button type="button" onClick={() => setLeaderIds(leaderIds.length === state.catalog.leaders.length ? [] : state.catalog.leaders.map(item => item.id))}>{leaderIds.length === state.catalog.leaders.length ? 'Снять всех' : 'Выбрать всех'}</button><div>{state.catalog.leaders.map(leader => <label key={leader.id}><input type="checkbox" checked={leaderIds.includes(leader.id)} onChange={() => setLeaderIds(toggle(leaderIds, leader.id))}/><span>{leader.name}</span></label>)}</div></fieldset></div>
      {state.session.role === 'curator' && <div className="report-control-row"><label>Название нового профиля<input maxLength={500} value={profileName} onChange={event => setProfileName(event.target.value)} placeholder="Состав еженедельного отчёта"/></label><button className="button secondary" disabled={busy || !profileName.trim() || !goalIds.length} onClick={() => void saveProfile()}>Сохранить состав</button></div>}
      <button className="button primary" disabled={busy || !goalIds.length || !period} onClick={() => void generate()}>{busy ? 'Формирование…' : 'Сформировать снимок'}</button>
    </section>{error && <p role="alert" className="report-error">{error}</p>}
    {report && <section className="report-preview"><header><h2>Снимок за {report.selection.period}</h2><p>Сформирован {new Date(report.createdAt).toLocaleString('ru-RU')}. Изменение выбора выше создаст новый отчёт только после нажатия «Сформировать снимок».</p><div className="report-actions"><a className="button secondary" href={`/api/reports/${report.id}/html`} target="_blank" rel="noreferrer">Печать / просмотр</a><button className="button secondary" onClick={() => void downloadHtml()}>Скачать HTML</button><a className="button primary" href={`/api/reports/${report.id}/pptx`}>Скачать PPTX</a></div></header>
      <p>Пересчёт выбранного периода по правилам каталога на дату формирования. Историческая редакция правил может отличаться.</p><p className="report-summary">Целей: <strong>{report.summary.goals}</strong> · Подтверждено: <strong>{report.summary.confirmed}</strong> · Ожидает УОР: <strong>{report.summary.pending}</strong> · Не выполнено: <strong>{report.summary.notMet}</strong> · Нет данных: <strong>{report.summary.unknown}</strong></p>
      <div className="report-table-scroll"><table><thead><tr><th>Цель</th><th>ИТ-лидер / ДИТ</th><th>Факт</th><th>Порог</th><th>Статус</th></tr></thead><tbody>{report.rows.map(row => <tr key={`${row.goalId}:${row.leaderId}`}><td>{onGoal ? <button className="report-goal-link" onClick={() => onGoal(row.goalId, row.leaderId)}>{row.goalTitle}</button> : row.goalTitle}</td><td>{row.leaderName}</td><td>{reportNumber(row.evaluation.actual)} {row.evaluation.actual === null ? '' : row.unit}</td><td>{reportOfficialTarget(row)}</td><td>{reportStatus(row)}</td></tr>)}</tbody></table></div>
      <details><summary>Происхождение и ограничения</summary><p>Шаблон: {report.template.name}, версия {report.template.version}. Снимок: {report.id}.</p><dl>{Object.entries(report.versions).map(([key, value]) => <div key={key}><dt>{({ application: 'Приложение', catalog: 'Каталог', facts: 'Факты', confirmations: 'Подтверждения' })[key]}</dt><dd>{value}</dd></div>)}</dl><ul>{report.limitations.map(item => <li key={item}>{item}</li>)}</ul></details>
    </section>}
  </div>;
}
