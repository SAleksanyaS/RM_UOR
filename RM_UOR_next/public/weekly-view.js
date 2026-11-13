const fieldLabels = {
  plan: 'План',
  fact: 'Факт',
  progress: 'Прогресс к плану',
  status: 'Прогноз',
  forecast: 'Код прогноза',
  curatorComment: 'Комментарий куратора',
  leaderComment: 'Комментарий руководителя',
  artifactStatus: 'Наличие артефакта',
};
const curatorGroups = [
  ['achievements', 'Достижения'],
  ['attention', 'В зоне внимания'],
  ['plans', 'Планы'],
  ['insights', 'Инсайты'],
];
const rangeFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function snapshotLabel(snapshot, dateText) {
  return `${dateText(snapshot.asOf)} · ${snapshot.name}`;
}

function filters(model, helpers) {
  const { escape, option, dateText } = helpers;
  const current = model.snapshots.find(snapshot => snapshot.id === model.currentId);
  const earlier = current ? model.snapshots.filter(snapshot => snapshot.asOf < current.asOf) : [];
  const previous = earlier.find(snapshot => snapshot.id === model.previousId);
  const periods = current?.periods.filter(period => !previous || previous.periods.includes(period)) ?? [];
  const options = (snapshots, selected) => snapshots.map(snapshot =>
    option(snapshot.id, snapshotLabel(snapshot, dateText), selected)
  ).join('');
  return `<section class="panel panel-inner stack" aria-label="Срезы и период">
    <div class="kr-filters">
      <label class="field"><span>Текущий срез</span><select id="weekly-current">${current ? '' : option('', 'Выберите книгу', '')}${options(model.snapshots, current?.id)}</select></label>
      <label class="field"><span>Предыдущий срез</span><select id="weekly-previous"${earlier.length ? '' : ' disabled'}>${option('', 'Только текущий срез', previous?.id ?? '')}${options(earlier, previous?.id)}</select></label>
      <label class="field"><span>Период КР</span><select id="weekly-period"${periods.length ? '' : ' disabled'}>
        ${periods.length ? periods.map(period => option(period, period, model.period)).join('') : option('', 'Нет общего периода', '')}
      </select></label>
    </div>
    ${!current ? '<p class="status-empty">У последних книг одинаковая дата. Выберите текущий срез.</p>'
      : periods.length ? '' : '<p class="status-empty">В выбранных книгах нет общего периода. Выберите другой предыдущий срез.</p>'}
    ${model.error ? `<p class="inline-error" role="alert">${escape(model.error)}</p>` : ''}
  </section>`;
}

function evidence(entry, snapshot, helpers) {
  const { escape, dateText } = helpers;
  const labels = [snapshot?.source?.name, snapshot?.asOf ? dateText(snapshot.asOf) : ''].filter(Boolean).map(escape);
  if (snapshot?.source?.id && entry.id && entry.sourceRow) {
    labels.push(`<button class="kr-open" type="button" data-action="weekly-row" data-source="${escape(snapshot.source.id)}" data-id="${escape(entry.id)}">строка ${escape(entry.sourceRow)}</button>`);
  }
  return labels.join(' · ');
}

function statusText(value, { escape, statusLabel }) {
  return value ? escape(statusLabel(value)) : 'Нет прогноза';
}

function sourceRow(entry, snapshot, helpers) {
  const { escape, rowBadge } = helpers;
  return `<div class="history-row">
    <div><strong>${escape(entry.keyResult || 'КР без названия')}</strong>
      ${entry.leader ? `<p class="small muted">${escape(entry.leader)}</p>` : ''}
      <p class="small muted">${evidence(entry, snapshot, helpers)}</p>
    </div>
    ${entry.status ? rowBadge({ status: entry.status }) : ''}
  </div>`;
}

function valueText(name, value, helpers) {
  if (value == null || value === '') return '—';
  if (name === 'status') return statusText(value, helpers);
  if (name === 'progress' && typeof value === 'number') {
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value * 100)}%`;
  }
  return helpers.escape(value);
}

function changeRow(pair, report, helpers, includeFields = false) {
  const { escape } = helpers;
  const entry = pair.current ?? pair.previous;
  const side = (label, row, snapshot) => `<p class="small muted">${label} · ${row
    ? `${statusText(row.status, helpers)} · ${evidence(row, snapshot, helpers)}`
    : 'Строка отсутствует в срезе'} </p>`;
  return `<div class="history-row"><div>
    <strong>${escape(entry.keyResult || 'КР без названия')}</strong>
    ${entry.leader ? `<p class="small muted">${escape(entry.leader)}</p>` : ''}
    ${side('Было', pair.previous, report.previous)}
    ${side('Стало', pair.current, report.current)}
    ${includeFields ? (pair.fields ?? []).map(field => `<p class="small">${escape(fieldLabels[field.name] ?? field.name)}
      · ${valueText(field.name, field.previous, helpers)} → ${valueText(field.name, field.current, helpers)}</p>`).join('') : ''}
  </div></div>`;
}

function group(label, rows, render, expanded = false) {
  return `<details class="context-details weekly-group"${expanded && rows.length ? ' open' : ''}>
    <summary>${label} · ${rows.length}</summary>
    <div class="context-body">${rows.length ? rows.map(render).join('') : '<p class="muted small">Записей нет.</p>'}</div>
  </details>`;
}

function differences(report, helpers) {
  const { comparison } = report;
  if (!comparison) return '';
  const rows = (title, key, expanded) => group(title, comparison[key] ?? [],
    pair => changeRow(pair, report, helpers, key === 'changed'), expanded
  );
  const ambiguous = comparison.ambiguous ?? [];
  const withoutIdentity = comparison.withoutIdentity ?? [];
  return `<section class="panel panel-inner stack">
    <h2>Изменения между срезами</h2>
    ${rows('Новые риски', 'newRisks', true)}
    ${rows('Закрытые риски', 'closedRisks', true)}
    ${rows('Сохраняющиеся риски', 'persistingRisks')}
    ${comparison.missingRisks.length ? rows('Прежние риски без строки в текущем срезе', 'missingRisks') : ''}
    ${comparison.unverifiedRisks.length ? rows('Текущие риски без сопоставимого прогноза в прошлом', 'unverifiedRisks') : ''}
    ${comparison.unresolvedRisks.length ? rows('Прежние риски без определённого прогноза сейчас', 'unresolvedRisks') : ''}
    ${comparison.changed.length ? rows('Изменения плана, факта и статуса', 'changed') : ''}
    ${ambiguous.length ? group('Неоднозначное сопоставление', ambiguous, item => [
      ...(item.previous ?? []).map(entry => sourceRow(entry, report.previous, helpers)),
      ...(item.current ?? []).map(entry => sourceRow(entry, report.current, helpers)),
    ].join('')) : ''}
    ${withoutIdentity.length ? group('Недостаточно данных для сопоставления', withoutIdentity,
      ({ side, entry }) => sourceRow(entry, side === 'previous' ? report.previous : report.current, helpers)) : ''}
  </section>`;
}

function baseline(report, helpers) {
  const { escape } = helpers;
  const { risks, withoutMethod, total, completed } = report.baseline;
  return `<section class="panel panel-inner stack">
    <div class="headline"><h2>Текущий срез</h2><span class="muted small">Выполнено ${escape(completed)} из ${escape(total)} · под риском ${escape(risks.length)}</span></div>
    ${group('Есть риски', risks, entry => sourceRow(entry, report.current, helpers), !report.comparison)}
    ${group('Нет методики', withoutMethod, entry => sourceRow(entry, report.current, helpers), !report.comparison)}
  </section>`;
}

function excelReport(model, helpers) {
  const { escape } = helpers;
  let content;
  if (!(model.snapshots ?? []).length) {
    if (model.loading) content = '<p class="muted small" role="status">Загружаем список срезов…</p>';
    else if (model.error) content = `<p class="inline-error" role="alert">${escape(model.error)}</p>`;
    else content = '<p class="muted">Укажите дату книги со статусами в разделе «Сверка КР».</p><div class="actions"><a class="button" href="#reconcile">Открыть сверку КР</a></div>';
  } else {
    const report = model.loading ? null : model.report;
    content = `${filters(model, helpers)}${model.loading ? '<p class="muted loading" role="status">Собираем отчёт по срезам…</p>' : ''}
      ${report ? differences(report, helpers) + baseline(report, helpers) : ''}`;
  }
  return `<details class="panel panel-inner context-details weekly-excel" id="weekly-excel">
    <summary>Риски и изменения по срезам Excel</summary>
    <div class="context-body stack">${content}</div>
  </details>`;
}

function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function weekRange(week) {
  const start = isoDate(week);
  if (!start) return '';
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return rangeFormat.formatRange(start, end);
}

function weekControls({ week, reportWeeks }, { escape, option }) {
  const range = weekRange(week);
  const savedWeeks = [...new Set(reportWeeks ?? [])].sort().reverse().map(value => [value, weekRange(value)]).filter(([, label]) => label);
  return `<section class="panel panel-inner weekly-weekbar" aria-label="Отчётная неделя">
    <div><span class="muted small">Отчётная неделя</span><p class="weekly-range" id="weekly-range">${escape(range || 'Выберите дату')}</p>
      <p class="muted small weekly-week-rule">Отчёты сгруппированы по дате окончания их периода.</p></div>
    <div class="weekly-period-controls">
      <div class="actions weekly-step-buttons">
        <button class="button" type="button" id="weekly-week-prev" data-action="weekly-week-prev" aria-label="Предыдущая неделя"${range ? '' : ' disabled'}>← <span>Предыдущая</span></button>
        <button class="button" type="button" id="weekly-week-next" data-action="weekly-week-next" aria-label="Следующая неделя"${range ? '' : ' disabled'}><span>Следующая</span> →</button>
      </div>
      <label class="field weekly-date"><span>Перейти к дате</span><input type="date" id="weekly-week" value="${range ? escape(week) : ''}"></label>
      ${savedWeeks.length ? `<label class="field weekly-saved-week"><span>Недели с отчётами</span><select id="weekly-saved-week">
        <option value="">Выбрать неделю</option>${savedWeeks.map(([value, label]) => option(value, label, week)).join('')}
      </select></label>` : ''}
    </div>
  </section>`;
}

function itemsFor(sections, key) {
  return (Array.isArray(sections?.[key]) ? sections[key] : []).filter(item => {
    const text = typeof item === 'string' ? item : item?.text;
    return typeof text === 'string' && Boolean(text.trim());
  });
}

function reportGroup(key, label, items, { escape }, headingTag = 'h3') {
  return `<section class="weekly-report-group weekly-report-${key}"><${headingTag}>${label}</${headingTag}>
    ${items.length ? `<ul>${items.map(item => {
      const text = typeof item === 'string' ? item : item.text;
      const curator = typeof item === 'string' ? '' : item.curator;
      return `<li><span class="weekly-item-text">${escape(text)}</span>${curator ? `<small class="weekly-item-author muted">${escape(curator)}</small>` : ''}</li>`;
    }).join('')}</ul>` : '<p class="muted small">Записей нет</p>'}
  </section>`;
}

function summaryCard(summary, curators, helpers) {
  const received = curators.filter(curator => curator.sections).length;
  return `<section class="panel panel-inner weekly-summary stack"><div class="headline"><h2>Общая сводка</h2>
    ${curators.length ? `<span class="muted small">Отчёты получены · ${received} из ${curators.length}</span>` : ''}</div>
    <div class="weekly-summary-groups">${curatorGroups.map(([key, label]) => reportGroup(key, label, itemsFor(summary, key), helpers)).join('')}</div>
  </section>`;
}

function sourceUrl(value) {
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '';
  } catch {
    return '';
  }
}

function curatorCard(curator, helpers) {
  const { escape } = helpers;
  const groups = curatorGroups.map(([key, label]) => [key, label, itemsFor(curator.sections, key)]);
  const filled = groups.filter(([, , items]) => items.length).length;
  const url = sourceUrl(curator.url);
  const from = isoDate(curator.range?.start);
  const to = isoDate(curator.range?.end);
  const range = from && to && from <= to ? rangeFormat.formatRange(from, to) : '';
  return `<article class="panel panel-inner weekly-curator stack">
    <header class="weekly-curator-heading"><div><h3>${escape(curator.name || 'Куратор')}</h3>
      ${range ? `<p class="muted small weekly-source-range">Период отчёта · ${escape(range)}</p>` : ''}</div>
      ${filled === 0 ? '<span class="badge">Нет данных</span>' : filled < groups.length ? '<span class="badge warning">Заполнено частично</span>' : ''}
    </header>
    ${filled ? `<div class="weekly-curator-groups">${groups.map(([key, label, items]) => reportGroup(key, label, items, helpers, 'h4')).join('')}</div>`
      : '<p class="muted">За выбранную неделю записей нет.</p>'}
    ${url ? `<div><a class="weekly-source" href="${escape(url)}" target="_blank" rel="noopener noreferrer">Открыть источник ↗</a></div>` : ''}
  </article>`;
}

function curatorReport(model, helpers) {
  const { escape } = helpers;
  const report = model.curatorWeek?.week === model.week ? model.curatorWeek : null;
  const error = model.curatorError ? `<p class="inline-error" role="alert">${escape(model.curatorError)}</p>` : '';
  if (!report) {
    if (model.curatorLoading) return `${error}<p class="muted loading" role="status">Загружаем отчёт кураторов…</p>`;
    return `${error}<section class="panel panel-inner weekly-summary stack"><h2>Общая сводка</h2>
      <p class="muted">${model.curatorError ? 'Сводка за выбранную неделю недоступна.' : 'За выбранную неделю пока нет отчётов кураторов.'}</p>
      <div class="actions"><a class="button" href="#connectors">Настроить источники отчётов</a></div></section>`;
  }
  const curators = Array.isArray(report.curators) ? report.curators : [];
  return `${error}${summaryCard(report.summary, curators, helpers)}${curators.length ? `<section class="weekly-curators stack" aria-labelledby="weekly-curators-title">
    <h2 id="weekly-curators-title">Отчёты кураторов</h2>
    <div class="weekly-curator-grid">${curators.map(curator => curatorCard(curator, helpers)).join('')}</div>
  </section>` : '<p class="muted">Источники отчётов можно добавить в <a href="#connectors">браузерных подключениях</a>.</p>'}`;
}

export function renderWeekly(model, helpers) {
  const title = helpers.heading('Еженедельный отчёт', 'Сводка кураторов за выбранную неделю.');
  return `${title}<div class="weekly-page stack">
    ${weekControls(model, helpers)}
    ${curatorReport(model, helpers)}
    ${excelReport(model, helpers)}
  </div>`;
}
