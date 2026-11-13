import { projectGoalStatuses } from './goal-status.js';

const emptyTotals = () => ({ assigned: 0, assessed: 0, completed: 0, risk: 0, excel: 0, preliminary: 0 });

export function summarizeMap(goals, directory, period, reportRows = []) {
  const leaderIds = new Set(goals.flatMap(goal => (goal.assignments ?? []).map(item => item.leaderId)));
  const leaders = directory.filter(entry => entry.type === 'leader' && leaderIds.has(entry.id)).map(entry => ({
    id: entry.id, name: entry.name, ...emptyTotals(),
  }));
  const byId = new Map(leaders.map(leader => [leader.id, leader]));
  const total = emptyTotals();
  for (const assignment of projectGoalStatuses(goals, directory, { entries: reportRows }, [period])) {
    for (const counts of [byId.get(assignment.scopeId), total]) {
      counts.assigned++;
      if (!assignment.status) continue;
      counts.assessed++;
      counts[assignment.preliminary ? 'preliminary' : 'excel']++;
      if (assignment.status === 'Выполнено') counts.completed++;
      if (assignment.status === 'Под риском') counts.risk++;
    }
  }
  return { leaders, total };
}

function labelsFor(totals) {
  return {
    completed: `Выполнено ${totals.assessed ? totals.completed : '—'} из ${totals.assigned}`,
    risk: `Под риском ${totals.assessed ? totals.risk : '—'}`,
    coverage: totals.assessed < totals.assigned ? `Статус есть у ${totals.assessed} из ${totals.assigned}` : '',
    sources: [totals.excel ? `Связь с Excel подтверждена · ${totals.excel}` : '',
      totals.preliminary ? `Предварительно из Excel · ${totals.preliminary}` : ''].filter(Boolean).join(' · '),
  };
}

function leaderButton(leader, selected, { escape }) {
  const { completed, risk, coverage, sources } = labelsFor(leader);
  const info = leader.assigned ? [completed, risk, coverage, sources] : ['Нет назначенных целей'];
  const label = [leader.name, ...info, 'Открыть цели.'].filter(Boolean).join('. ');
  return `<li><button type="button" class="map-leader" data-action="map-leader" data-id="${escape(leader.id)}" aria-pressed="${leader.id === selected}" aria-label="${escape(label)}">
    <span class="map-leader-name">${escape(leader.name)} <span class="map-leader-arrow" aria-hidden="true">→</span></span>
    ${leader.assigned ? `<span class="map-leader-completed">${completed}</span>
      <span class="map-leader-risk${leader.risk ? ' has-risk' : ''}">${risk}</span>
      ${coverage ? `<span class="map-leader-coverage">${coverage}</span>` : ''}
      ${sources ? `<span class="map-leader-source">${sources}</span>` : ''}` : '<span class="map-leader-coverage">Нет назначенных целей</span>'}
  </button></li>`;
}

function ditValue(value, { escape, numberFormat }) {
  if (value == null || value === '') return '—';
  return escape(typeof value === 'number' ? numberFormat.format(value) : value);
}

function ditTone(status) {
  if (status === 'Выполнено') return 'done';
  if (status === 'Под риском') return 'risk';
  return status ? 'other' : 'unknown';
}

function ditEvidence(entries, { escape }) {
  const rows = Array.isArray(entries) ? entries : [];
  if (!rows.length) return '';
  return `<details class="dit-evidence"><summary>Строки Excel · ${rows.length}</summary><ul>${rows.map(row => {
    const label = row.sourceRow ? `Строка ${row.sourceRow}` : 'Строка Excel';
    return `<li>${row.id ? `<button class="kr-open" type="button" data-action="kr-open" data-id="${escape(row.id)}">${escape(label)}</button>` : `<span>${escape(label)}</span>`}</li>`;
  }).join('')}</ul></details>`;
}

function ditGoal(entry, helpers) {
  const { escape } = helpers;
  const tone = ditTone(entry.status);
  return `<li class="dit-goal">
    <div class="dit-goal-main"><strong>${escape(entry.objective || entry.goalId)}</strong>
      ${entry.goalId ? `<p class="muted small">${escape(entry.goalId)}</p>` : ''}
      ${entry.basis ? `<p class="muted small dit-basis">${escape(entry.basis)}</p>` : ''}
      ${ditEvidence(entry.rows, helpers)}
    </div>
    <dl class="dit-goal-values">
      <div><dt>План</dt><dd>${ditValue(entry.plan, helpers)}</dd></div>
      <div><dt>Факт</dt><dd>${ditValue(entry.fact, helpers)}</dd></div>
      <div><dt>Статус</dt><dd>${entry.status ? `<span class="badge${tone === 'done' ? ' success' : tone === 'risk' ? ' warning' : ''}">${escape(entry.status)}</span>` : '—'}</dd></div>
    </dl>
  </li>`;
}

function ditChart(categories, total) {
  let position = 0;
  const present = categories.filter(item => item.count);
  const bars = present.map(({ count, tone }) => {
    const width = 100 * count / total;
    const bar = `<rect class="dit-track-${tone}" x="${position.toFixed(4)}" y="0" width="${width.toFixed(4)}" height="10"></rect>`;
    position += width;
    return bar;
  }).join('');
  return `<div class="dit-chart"><svg class="dit-track" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">${bars}</svg>
    <ul class="dit-legend" aria-label="Распределение статусов целей ДИТ">${present.map(({ count, label, tone }) => `<li><i class="dit-dot-${tone}" aria-hidden="true"></i>${label} · ${count}</li>`).join('')}</ul>
  </div>`;
}

export function renderDitOverview(entries, period, helpers, visualization = false) {
  if (!Array.isArray(entries)) return '';
  const selected = period || entries[0]?.period;
  const goals = entries.filter(entry => entry.period === selected);
  const counts = { done: 0, risk: 0, other: 0, unknown: 0 };
  for (const goal of goals) counts[ditTone(goal.status)]++;
  const assessed = goals.length - counts.unknown;
  const categories = [
    { tone: 'done', label: 'Выполнено', count: counts.done },
    { tone: 'risk', label: 'Под риском', count: counts.risk },
    { tone: 'other', label: 'Другие статусы', count: counts.other },
    { tone: 'unknown', label: 'Нет статуса', count: counts.unknown },
  ];
  const headingTag = visualization ? 'h2' : 'h3';
  return `<section class="dit-overview${visualization ? ' panel panel-inner' : ''}" aria-labelledby="dit-overview-title">
    <header class="dit-heading"><${headingTag} id="dit-overview-title">Итоги ДИТ</${headingTag}>${selected ? `<span class="muted small">${helpers.escape(selected)}</span>` : ''}
      ${goals.length ? `<button type="button" class="button compact" data-action="dit-statuses" data-period="${helpers.escape(selected)}">Статусы ДИТ</button><a href="#dit-settings" class="dit-settings-link">Редактировать статусы</a>` : ''}</header>
    ${goals.length ? `<div class="dit-counts"><strong>Выполнено ${assessed ? counts.done : '—'} из ${goals.length}</strong><strong${counts.risk ? ' class="dit-risk"' : ''}>Под риском ${assessed ? counts.risk : '—'}</strong>
      ${assessed < goals.length ? `<span class="muted small">Статус есть у ${assessed} из ${goals.length} целей</span>` : ''}</div>
      <p class="muted small">Ручной статус имеет приоритет. Факт ДИТ берётся из итоговой строки Excel.</p>
      ${visualization ? ditChart(categories, goals.length) : ''}
      <details class="dit-details"${goals.length <= 5 ? ' open' : ''}><summary>План и факт по целям ДИТ</summary>
        <ul class="dit-goals">${goals.map(entry => ditGoal(entry, helpers)).join('')}</ul></details>` : '<p class="muted small">Данные ДИТ за выбранный период отсутствуют.</p>'}
  </section>`;
}

export function renderMapOverview({ goals, directory, period, periods, leaderId, register, dit }, helpers) {
  const { escape, option, dateText } = helpers;
  const { leaders, total } = summarizeMap(goals, directory, period, register?.entries);
  const { completed, risk, coverage, sources } = labelsFor(total);
  const bookUsed = total.excel + total.preliminary > 0;
  const source = bookUsed && register?.source?.name ? `${register.source.name} · ${register.asOf ? `срез от ${dateText(register.asOf)}` : 'дата среза не указана'}` : '';
  return `<section class="panel panel-inner map-overview" aria-labelledby="map-overview-title">
    <header class="map-overview-head"><div><h2 id="map-overview-title">Статусы целей</h2>
      <p class="muted small">Цели в карте · ${goals.length} / Лидеры · ${leaders.length}</p></div>
      <label class="field map-overview-period"><span>Период обзора</span><select id="map-overview-period">${periods.map(value => option(value, value, period)).join('')}</select></label>
    </header>
    ${renderDitOverview(dit, period, helpers)}
    <div class="map-overview-total">
      <div class="map-overview-total-stat">
        <p class="muted small">Назначения по всем лидерам</p>
        <div class="map-overview-counts"><strong class="map-overview-completed">${completed}</strong><strong class="map-overview-risk${total.risk ? ' has-risk' : ''}">${risk}</strong></div>
        <div class="map-overview-total-meta">
          ${coverage ? `<p>${coverage} назначений</p>` : ''}
          ${sources ? `<p>${sources}</p>` : '<p>Нет данных о статусах за выбранный период.</p>'}
        </div>
      </div>
      ${leaderId ? '<button type="button" class="button compact" data-action="map-leader" data-id="">Все цели</button>' : ''}
    </div>
    ${source ? `<p class="map-overview-source muted small">${escape(source)}</p>` : ''}
    ${leaders.length ? `<ul class="map-leaders" aria-label="Статусы целей по лидерам">${leaders.map(leader => leaderButton(leader, leaderId, helpers)).join('')}</ul>` : '<p class="muted small">В карте ещё нет назначений по лидерам.</p>'}
    <details class="map-overview-method"><summary>Как считаются статусы</summary>
      <p>Каждая цель учитывается один раз у каждого назначенного лидера. Статус берётся из подтверждённых связей с Excel или из единственного предварительного совпадения. Если связанных строк несколько, явный риск учитывается сразу, а для выполнения нужны выполненные КР во всех строках.</p>
    </details>
  </section>`;
}
