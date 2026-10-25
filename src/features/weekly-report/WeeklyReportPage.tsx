import { useEffect, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { useWorkspace } from '../../app/AppContext';
import { currentWeekStart, weekEnd, weeklyBriefSaveSchema, type WeeklyBriefRecord, type WeeklyBriefSaveResult, type WeeklyBriefVisibility, type WeeklyReportView } from './contracts';
import './weekly-report.css';

interface Form { summary: string; completed: string; attention: string; nextWeek: string }
const blank = (): Form => ({ summary: '', completed: '', attention: '', nextWeek: '' });
const dateLabel = (date: string) => new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC' });
const weekLabel = (date: string) => `${dateLabel(date)} — ${dateLabel(weekEnd(date))}`;
const sectionTitles = { completed: 'Главные выполненные задачи УОР', attention: 'Требует внимания', nextWeek: 'Планы следующей недели' } as const;
const visibilityLabel: Record<WeeklyBriefVisibility, string> = { local: 'Собственный черновик · не опубликован', release: 'В готовящемся выпуске · ждёт публикации в main', published: 'Опубликовано' };
const textLines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

export function WeeklyReportPage({ onPublish }: { onPublish?: () => void }) {
  const { state, mutate, notify } = useWorkspace();
  const [week, setWeek] = useState(currentWeekStart), [view, setView] = useState<WeeklyReportView | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false), [form, setForm] = useState<Form>(blank), [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const curator = state.session.role === 'curator' && !!state.session.curatorId;
  useEffect(() => {
    let active = true; const controller = new AbortController(); setLoading(true);
    void fetch(`/api/weekly-reports?weekStart=${encodeURIComponent(week)}`, { signal: controller.signal }).then(async response => {
      const result = await response.json() as WeeklyReportView & { message?: string };
      if (!response.ok) throw new Error(result.message || 'Не удалось прочитать недельные сводки');
      if (active) { setView(result); setLoadError(''); }
    }).catch(failure => { if (active) setLoadError((failure as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [week, state.catalog.entities, state.session.id, reload]);
  useEffect(() => { setEditing(false); setError(''); }, [state.session.id]);

  function moveWeek(days: number) {
    const next = new Date(`${week}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + days); setWeek(next.toISOString().slice(0, 10));
  }
  function begin() {
    const own = view?.own?.record; setBaseRevision(own?.revision ?? null); setError('');
    setForm(own ? { summary: own.summary, completed: own.completed.join('\n'), attention: own.attention.join('\n'), nextWeek: own.nextWeek.join('\n') } : blank()); setEditing(true);
  }
  function change(key: keyof Form, value: string) { setForm(current => ({ ...current, [key]: value })); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!curator || busy) return; setBusy(true); setError('');
    try {
      const parsed = weeklyBriefSaveSchema.safeParse({ weekStart: week, baseRevision, summary: form.summary, completed: textLines(form.completed), attention: textLines(form.attention), nextWeek: textLines(form.nextWeek) });
      if (!parsed.success) throw new Error(parsed.error.issues.map(issue => issue.message).join('; '));
      const result = await mutate('/api/weekly-reports', parsed.data) as WeeklyBriefSaveResult;
      setView(current => current ? { ...current, own: { record: result.record, visibility: 'local' } } : current); setEditing(false);
      notify('Сводка сохранена в собственный черновик. Директор увидит её после публикации руководителем и обновления общих данных.');
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  const weeks = [...new Set([currentWeekStart(), week, ...(view?.weeks ?? [])])].sort().reverse();
  const pendingOwn = curator && view?.own && view.own.visibility !== 'published' ? view.own : null;
  return <section className="weekly-page">
    <header className="page-heading"><div><div className="eyebrow">НЕДЕЛЯ В ФОКУСЕ</div><h1>Еженедельный отчёт</h1><p>Главное в работе УОР, вопросы для решения и следующие шаги.</p></div><FileText size={30} aria-hidden="true"/></header>
    <p className="weekly-boundary">Текстовая сводка описывает объявленные работы. Она не меняет измеренные факты и подтверждения целей.</p>
    <div className="weekly-toolbar"><button className="button secondary" aria-label="Предыдущая неделя" disabled={editing || busy} onClick={() => moveWeek(-7)}><ChevronLeft size={18}/></button>
      <label>Отчётная неделя<select value={week} disabled={editing || busy} onChange={event => setWeek(event.target.value)}>{weeks.map(value => <option key={value} value={value}>{weekLabel(value)}</option>)}</select></label>
      <button className="button secondary" aria-label="Следующая неделя" disabled={editing || busy} onClick={() => moveWeek(7)}><ChevronRight size={18}/></button>
      <span className="weekly-toolbar-note">Понедельник — воскресенье</span>
    </div>
    {loadError && <div role="alert" className="error-inline">{loadError}<button className="text-button" onClick={() => setReload(value => value + 1)}>Обновить сводки</button></div>}
    {loading ? <p role="status">Загружаем недельные сводки…</p> : view && !loadError && <>
      <div className="weekly-published" aria-label="Опубликованные сводки">
        {view.published.length ? view.published.map(record => <BriefCard key={record.id} record={record} visibility="published"/>) : <div className="weekly-empty"><FileText size={30} aria-hidden="true"/><h2>За эту неделю опубликованных сводок пока нет</h2><p>Сводки появятся после публикации руководителем в main и обновления общих данных на этом рабочем месте.</p></div>}
      </div>
      {curator && <section className="weekly-own" aria-label="Моя сводка"><div className="weekly-own-heading"><div><h2>Моя сводка за неделю</h2><p>Вы редактируете только собственный текст за выбранную неделю.</p></div>{!editing && <button className="button secondary" aria-expanded={false} onClick={begin}>{view.own ? 'Изменить свою сводку' : 'Подготовить свою сводку'}</button>}</div>
        {pendingOwn && <BriefCard record={pendingOwn.record} visibility={pendingOwn.visibility}/>}
        {pendingOwn && <div className="weekly-publish-handoff"><p>Директор увидит сводку после публикации руководителем в main и обновления общих данных. {pendingOwn.visibility === 'local' ? 'Отправьте выбранный черновик в готовящийся выпуск release/current.' : 'Сводка уже отправлена в release/current; ожидается выпуск руководителя.'}</p>{onPublish && <button className="button secondary" onClick={onPublish}>К публикации</button>}</div>}
        {editing && <form className="weekly-form" onSubmit={event => void save(event)}><fieldset disabled={busy}><legend>{baseRevision ? 'Изменение своей сводки' : 'Новая сводка'} · {weekLabel(week)}</legend>
          <label>Главная сводка<textarea aria-label="Главная сводка" rows={4} required maxLength={4000} value={form.summary} onChange={event => change('summary', event.target.value)}/><small>До 4000 знаков.</small></label>
          <div className="weekly-form-grid">{(['completed', 'attention', 'nextWeek'] as const).map(key => <label key={key}>{sectionTitles[key]}<textarea aria-label={sectionTitles[key]} rows={5} maxLength={20020} value={form[key]} onChange={event => change(key, event.target.value)}/><small>Один пункт в строке; до 20 пунктов по 1000 знаков. Можно оставить пустым.</small></label>)}</div>
        </fieldset>{error && <p role="alert" className="error-inline">{error} Введённый текст остаётся в форме.</p>}<div className="weekly-form-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>Отмена</button><button className="button primary" type="submit" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить черновик'}</button></div><p className="weekly-form-note">Сохранение создаёт собственный черновик. Для общей версии используйте публикацию каталога.</p></form>}
      </section>}
    </>}
  </section>;
}

function BriefCard({ record, visibility }: { record: WeeklyBriefRecord; visibility: WeeklyBriefVisibility }) {
  return <article className={`weekly-card weekly-card-${visibility}`}><header><div><span className={`weekly-status weekly-status-${visibility}`}>{visibilityLabel[visibility]}</span><h2>{record.ownerName}</h2></div><div className="weekly-metadata"><span>Сохранено <time dateTime={record.updatedAt}>{dateLabel(record.updatedAt)}</time></span><small>Неделя {weekLabel(record.weekStart)}</small></div></header>
    <section className="weekly-summary"><h3>Главная сводка</h3><p>{record.summary}</p></section><div className="weekly-card-grid">{(['completed', 'attention', 'nextWeek'] as const).map(key => <section key={key}><h3>{sectionTitles[key]}</h3>{record[key].length ? <ul>{record[key].map((line, index) => <li key={index}>{line}</li>)}</ul> : <p className="weekly-no-items">Пункты не добавлены.</p>}</section>)}</div>
  </article>;
}
