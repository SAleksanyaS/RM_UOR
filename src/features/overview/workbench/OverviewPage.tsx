import { useState } from 'react';
import { ArrowRight, CircleAlert, ClipboardCheck, Database, Check, Clock3 } from 'lucide-react';
import { useGlobalContext, useWorkbenchQuery } from '../../../app/workbench/context';
import type { GoalReadRow, WorkbenchReadModels } from '../../catalog/workbench-read-models';
import { useGoalRead } from './use-goal-read';
import { ContextLink, GoalOpenButton, goalRequest, QueryFeedback, ResultModeSelector } from './goal-view-utils';

type Attention = { kind: 'result' | 'data' | 'confirmation'; label: string; explanation: string };
function attention(row: GoalReadRow): Attention | null {
  const result = row.numericResult;
  if (row.unavailableReason) return { kind: 'data', label: 'Основание недоступно', explanation: 'Откройте цель и проверьте доступность выбранного среза.' };
  if (row.needs_calculation) return { kind: 'data', label: 'Нужен расчёт', explanation: 'Результат появится после проверки текущего основания.' };
  if (row.goal.mode === 'numeric') {
    if (!result || ['no_data', 'blocked', 'preliminary'].includes(result.calculation) || !result.complete) return { kind: 'data', label: 'Неполные данные', explanation: 'Проверьте источник и недостающие значения. Выполнение пока нельзя оценить.' };
    if (result.freshness !== 'fresh') return { kind: 'data', label: result.freshness === 'stale' ? 'Данные устарели' : 'Уточните актуальность', explanation: 'Обновите источник перед решением по результату.' };
    if (result.achievement === 'not_met') return { kind: 'result', label: 'Условие не выполнено', explanation: 'Сверьте факт с требованием и определите следующий шаг.' };
    if (result.achievement === 'unknown') return { kind: 'data', label: 'Результат не определён', explanation: 'Проверьте методику и основание расчёта.' };
    if (result.achievement === 'not_applicable') return null;
  } else {
    if (!row.manualStatus) return { kind: 'data', label: 'Ручной статус не задан', explanation: 'Откройте цель и уточните фактическое состояние работы.' };
    if (row.manualStatus.to === 'not_started') return { kind: 'result', label: 'Работа не начата', explanation: 'Определите первый шаг и срок начала работы.' };
    if (row.manualStatus.to === 'in_progress') return { kind: 'result', label: 'Работа продолжается', explanation: 'Проверьте следующий шаг и срок завершения.' };
  }
  return row.attestation ? null : { kind: 'confirmation', label: 'Ожидает подтверждения', explanation: row.goal.mode === 'manual_status' ? 'Работа завершена. УОР ещё не подтвердил это основание.' : 'Условие выполнено. УОР ещё не подтвердил это основание.' };
}
const shortDate = (value: string | null) => value ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z')) : 'Срок не задан';

export function WorkbenchOverviewPage() {
  const { context } = useGlobalContext();
  const [kind, setKind] = useState<'all' | Attention['kind']>('all');
  const query = useGoalRead('overview', context ? goalRequest(context) : null);
  const catalog = useWorkbenchQuery<WorkbenchReadModels['context.options']>('context.options', context?.resultMode === 'current' ? goalRequest(context) : null);
  const names = new Map(catalog.data?.entities.map(entity => [entity.id, entity.name]) ?? []);
  const data = query.data;
  const pending = (data?.goals ?? []).flatMap(row => { const reason = attention(row); return reason ? [{ row, reason }] : []; });
  const rank = { result: 0, data: 1, confirmation: 2 };
  const selected = pending.filter(item => kind === 'all' || item.reason.kind === kind).sort((a, b) => rank[a.reason.kind] - rank[b.reason.kind]);
  const openDecisions = data?.execution.filter(item => item.kind === 'decision' && item.value.answer === null) ?? [];
  const works = data?.execution.filter(item => item.kind === 'work') ?? [];
  const met = data?.goals.filter(row => row.numericResult?.achievement === 'met' || row.goal.mode === 'manual_status' && row.manualStatus?.to === 'completed').length ?? 0;
  const dataIssues = pending.filter(item => item.reason.kind === 'data').length;
  return <section className="wb-overview" aria-label="Ситуация в выбранной области">
    <div className="wb-result-toolbar"><ResultModeSelector /><span className="wb-toolbar-note">{context?.resultMode === 'agreed' ? 'Основание выбранного среза' : 'По доступным данным выбранной области'}</span></div>
    <QueryFeedback loading={query.loading} error={query.error} operation={query.errorOperation} />
    {data && <>
      <div className="wb-overview-metrics" aria-label="Сводка области">
        <div><span>Активные назначения</span><strong>{data.counts.goals}</strong><small>В выбранной области</small></div>
        <div><span><Check size={14} aria-hidden="true" />Условие выполнено</span><strong>{met}<small> / {data.counts.goals}</small></strong><small>Подтверждение — отдельно</small></div>
        <div><span><Database size={14} aria-hidden="true" />Нужна проверка данных</span><strong>{dataIssues}</strong><small>Это ещё не отклонение цели</small></div>
        <div><span><ClipboardCheck size={14} aria-hidden="true" />Ожидают решения</span><strong>{openDecisions.length}</strong><small>Открытые запросы</small></div>
      </div>
      <div className="wb-overview-grid">
        <section className="wb-attention-panel" aria-labelledby="wb-attention-heading">
          <header className="wb-section-header"><div><h2 id="wb-attention-heading">Требуют внимания <span className="wb-count">{pending.length}</span></h2></div><ContextLink path="/goals" label="Все цели" /></header>
          <div className="wb-filter-tabs" aria-label="Фильтр очереди внимания">{([['all', 'Все'], ['result', 'Результат'], ['data', 'Данные'], ['confirmation', 'Подтверждение']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</div>
          <div className="wb-attention-list">{selected.map(({ row, reason }) => <article className={'wb-attention-item wb-attention-' + reason.kind} key={row.ref.id}>
            <div className="wb-attention-marker" aria-hidden="true">{reason.kind === 'data' ? <Database size={17} /> : reason.kind === 'confirmation' ? <ClipboardCheck size={17} /> : <CircleAlert size={17} />}</div>
            <div className="wb-attention-body"><div className="wb-item-labels"><span className={'wb-badge wb-badge-' + reason.kind}>{reason.label}</span><span>{row.scopeName ?? 'Имя области не сохранено'}</span></div><h3>{row.goal.title}</h3><p>{reason.explanation}</p><div className="wb-item-meta"><span className="wb-person"><span className="wb-avatar" aria-hidden="true">{row.leader?.name.split(' ').map(part => part[0]).slice(0, 2).join('') ?? '—'}</span>{row.leader?.name ?? (row.snapshot ? 'Историческое имя не сохранено' : 'Ответственный не назначен')}</span><span><Clock3 size={13} aria-hidden="true" />{shortDate(row.assignment.officialDueOn)}</span></div></div>
            <div className="wb-item-open"><GoalOpenButton goalId={row.goal.id} title={row.goal.title} compact /><ArrowRight size={15} aria-hidden="true" /></div>
          </article>)}</div>
          {!selected.length && <div className="wb-content-empty"><Check size={24} aria-hidden="true" /><h3>В этом разделе нет задач для проверки</h3><p>Смените фильтр или откройте полный список целей.</p></div>}
        </section>
        <aside className="wb-overview-aside">
          <section className="wb-decision-panel" aria-labelledby="wb-decisions-heading"><div className="wb-aside-heading"><ClipboardCheck size={18} aria-hidden="true" /><h2 id="wb-decisions-heading">Нужно решение</h2></div>
            {openDecisions.length ? openDecisions.slice(0, 2).map(item => item.kind === 'decision' && <article key={item.ref.id}><span className="wb-eyebrow">Запрос решения</span><h3>{item.title}</h3><p>Ответственный: <strong>{names.get(item.value.requestedFromPersonId) ?? 'Имя недоступно'}</strong></p><p className="wb-decision-due"><Clock3 size={14} aria-hidden="true" />До {shortDate(item.value.dueOn)}</p><ContextLink path={'/execution?ref=decision/' + item.ref.id} label="Открыть запрос" /></article>) : <p>Открытых запросов нет.</p>}
            {openDecisions.length > 2 && <ContextLink path="/execution" label="Все запросы решений" />}
          </section>
          <section className="wb-data-health"><Database size={19} aria-hidden="true" /><div><h3>{dataIssues ? 'Проверка данных' : 'Источники и данные'}</h3><p>{dataIssues ? `Назначений без надёжной оценки: ${dataIssues}. Проверьте полноту и актуальность источников.` : 'Проверьте исходные строки и время получения перед подтверждением результата.'}</p><ContextLink path="/data" label="Перейти к данным" /></div></section>
        </aside>
      </div>
      <section className="wb-next-actions" aria-labelledby="wb-next-actions-heading"><header className="wb-section-header"><div><h2 id="wb-next-actions-heading">Ближайшие действия</h2><p>Работы, связанные с целями выбранной области</p></div><ContextLink path="/execution" label="Все работы и решения" /></header><div className="wb-table-scroll"><table><thead><tr><th scope="col">Работа / следующий шаг</th><th scope="col">Ответственный</th><th scope="col">Срок</th><th scope="col">Состояние</th></tr></thead><tbody>{works.map(item => item.kind === 'work' && <tr key={item.ref.id}><td><ContextLink path={'/execution?ref=work/' + item.ref.id} label={item.title} /><small>{item.value.nextAction || 'Следующий шаг не задан'}</small></td><td>{item.value.responsibility.map(owner => names.get(owner.personId) ?? 'Имя недоступно').join(', ') || 'Не назначен'}</td><td>{shortDate(item.value.dueOn)}</td><td><span className="wb-badge wb-badge-neutral">{({ planned: 'Запланирована', in_progress: 'В работе', paused: 'Приостановлена', completed: 'Завершена', cancelled: 'Отменена' })[item.value.state]}</span></td></tr>)}</tbody></table></div>{!works.length && <p className="wb-table-empty">Связанных работ нет.</p>}</section>
    </>}
  </section>;
}
