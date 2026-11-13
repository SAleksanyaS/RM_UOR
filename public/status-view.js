const pageSize = 25;

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim();
}

function values(entries, key) {
  return [...new Set(entries.map(entry => entry[key]).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'ru'));
}

function matchesQuery(entry, query) {
  if (!query) return true;
  const text = [entry.objective, entry.leader, entry.goalId, ...(entry.rows ?? []).map(row => row.keyResult)];
  return normalize(text.join(' ')).includes(query);
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function display(value, { escape, numberFormat }) {
  if (!hasValue(value)) return '—';
  return escape(typeof value === 'number' ? numberFormat.format(value) : value);
}

function sourceDate(value, escape) {
  if (!value) return '';
  const date = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return escape(date.split('-').reverse().join('.'));
  return escape(date);
}

function statusName(value, { statusLabel }) {
  return value ? (statusLabel?.(value) ?? value) : 'Нет статуса';
}

function activeGoal(model) {
  const goalId = model.filters?.goalId;
  return goalId ? model.goals?.find(goal => goal.id === goalId)?.title || goalId : '';
}

function overviewFilters(model, helpers) {
  const { escape, option } = helpers;
  const { register, filters = {} } = model;
  const entries = register.entries;
  const periods = register.periods?.length ? register.periods : values(entries, 'period');
  const periodsOptions = periods.map(period => option(period, period, filters.period)).join('');
  const statuses = [...new Set(['Выполнено', 'Под риском', ...values(entries.filter(entry => !filters.period || entry.period === filters.period), 'status')])];
  if (filters.status && !statuses.includes(filters.status)) statuses.push(filters.status);
  const leaders = model.leaders ?? values(entries.filter(entry => entry.scopeId !== 'dit'), 'leader');
  const goal = activeGoal(model);
  const activeGroup = goal || filters.objective;
  return `<div class="kr-filters">
    <label class="field"><span>Период</span><select id="kr-period">${periodsOptions}</select></label>
    <label class="field"><span>Статус</span><select id="kr-status">${option('', 'Все статусы', filters.status ?? '')}${statuses.map(status => option(status, statusName(status, helpers), filters.status)).join('')}</select></label>
    <label class="field"><span>Уровень</span><select id="kr-leader">${option('', 'Все ИТ-лидеры', filters.leader ?? '')}${option('@dit', 'Весь ДИТ', filters.leader)}${leaders.map(leader => option(leader, leader, filters.leader)).join('')}</select></label>
    <label class="field kr-search"><span>Поиск</span><input id="kr-search" type="search" value="${escape(filters.query)}" placeholder="Название цели, код или КР"></label>
  </div>
  ${activeGroup ? `<div class="kr-goal-filter actions"><span class="muted small">Цель · ${escape(activeGroup)}</span><button type="button" class="button compact" data-action="kr-clear-goal">Снять фильтр</button></div>` : ''}`;
}

function statusChips(entries, selected, helpers) {
  const { escape } = helpers;
  if (!entries.length) return '';
  const counts = new Map();
  for (const entry of entries) {
    if (entry.status) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  }
  const keys = ['Выполнено', 'Под риском', ...[...counts.keys()].filter(key => key !== 'Выполнено' && key !== 'Под риском')];
  const chips = [['', entries.length], ...keys.map(key => [key, counts.get(key) ?? 0])];
  const unknown = entries.filter(entry => !entry.status).length;
  return `<div class="kr-chips" role="group" aria-label="Фильтр по статусу">${chips.map(([status, count]) => `
    <button type="button" class="button compact kr-chip" data-action="kr-filter" data-value="${escape(status)}" aria-pressed="${selected === status}">
      ${status ? escape(statusName(status, helpers)) : 'Все'} <span class="kr-chip-count">${count}</span>
    </button>`).join('')}${unknown ? `<span class="muted small">Нет статуса · ${unknown}</span>` : ''}</div>`;
}

function tableRow(entry, helpers) {
  const { escape, rowBadge } = helpers;
  const status = entry.status ? (rowBadge(entry) || escape(statusName(entry.status, helpers))) : '<span class="muted small">Нет статуса</span>';
  const rows = entry.rows ?? [];
  const dit = entry.scopeId === 'dit';
  const evidence = dit ? entry : rows[0];
  const plan = display(evidence?.plan, helpers);
  const fact = display(evidence?.fact, helpers);
  const basis = dit && entry.basis ? escape(entry.basis) : '';
  const details = !dit && rows.length > 1 ? `${rows.length} КР · план и факт в деталях` : '';
  const metrics = details
    ? `<td class="kr-secondary" colspan="2">${details}</td>`
    : `<td class="kr-secondary">${plan}</td><td class="kr-secondary">${fact}${basis ? `<p class="muted small">${basis}</p>` : ''}</td>`;
  const mobileMetrics = details || `План ${plan} · Факт ${fact}${basis ? ` · ${basis}` : ''}`;
  return `<tr>
    <td class="kr-key-result"><button type="button" class="kr-open" data-action="goal-assignment-open" data-id="${escape(entry.goalId)}" data-scope="${escape(entry.scopeId)}" data-period="${escape(entry.period)}">${escape(entry.objective)}</button>
      <p class="muted small">${escape(entry.goalId)}</p><p class="muted small kr-mobile-period">${mobileMetrics}</p></td>
    <td>${dit ? 'Весь ДИТ' : display(entry.leader, helpers)}</td>
    ${metrics}
    <td>${status}</td>
  </tr>`;
}

export function renderStatusRows(model, helpers) {
  const { register, filters = {} } = model;
  if (!register) return '';
  const query = normalize(filters.query);
  const dit = filters.leader === '@dit';
  const matched = register.entries.filter(entry =>
    (!filters.period || entry.period === filters.period)
    && (dit ? entry.scopeId === 'dit' : entry.scopeId !== 'dit' && (!filters.leader || entry.leader === filters.leader))
    && (!filters.goalId || entry.goalId === filters.goalId)
    && (!filters.objective || entry.objective === filters.objective)
    && matchesQuery(entry, query));
  const status = filters.status ?? '';
  const entries = status ? matched.filter(entry => entry.status === status) : matched;
  const chips = statusChips(matched, status, helpers);
  if (!entries.length) return `${chips}<p class="status-empty">По этим условиям ${dit ? 'целей' : 'назначений'} не найдено.</p>`;
  const lastPage = Math.ceil(entries.length / pageSize) - 1;
  const requestedPage = Number.isInteger(filters.page) ? filters.page : 0;
  const page = Math.min(Math.max(requestedPage, 0), lastPage);
  const start = page * pageSize;
  const shown = entries.slice(start, start + pageSize);
  return `${chips}
    <div class="table-wrap"><table class="kr-table" aria-label="Статусы целей ${dit ? 'по ДИТ' : 'по ИТ-лидерам'}"><thead><tr>
      <th scope="col">Цель</th><th scope="col">${dit ? 'Уровень' : 'ИТ-лидер'}</th><th class="kr-secondary" scope="col">План</th><th class="kr-secondary" scope="col">Текущий факт</th><th scope="col">Статус</th>
    </tr></thead><tbody>${shown.map(entry => tableRow(entry, helpers)).join('')}</tbody></table></div>
    <div class="kr-pagination toolbar"><span class="muted small">${start + 1}–${start + shown.length} из ${entries.length}</span>
      ${lastPage ? `<button type="button" class="button compact" data-action="kr-page" data-page="${page - 1}"${page === 0 ? ' disabled' : ''}>Назад</button>
        <button type="button" class="button compact" data-action="kr-page" data-page="${page + 1}"${page === lastPage ? ' disabled' : ''}>Далее</button>` : ''}</div>`;
}

export function renderStatusPage(model, helpers) {
  const { heading, empty, escape } = helpers;
  const { register, loading, error } = model;
  const title = heading('Статусы целей', 'План и факт по целям ДИТ и ИТ-лидеров из Excel.', model.sourcePicker);
  if (!register) {
    if (loading) return `${title}<p class="muted loading" role="status">Читаем статусы из Excel…</p>`;
    if (error) return `${title}<p class="inline-error" role="alert">${escape(error)}</p>`;
    return title + empty('Статусы ещё не загружены', 'Добавьте книгу со статусами целей в разделе «Источники».', '<a class="button primary" href="#sources">Открыть источники</a>');
  }
  const date = sourceDate(register.asOf, escape);
  const source = [register.source?.name, register.sheet, register.range].filter(Boolean).map(escape).join(' · ');
  return `${title}<div class="stack kr-page">
    <section class="panel panel-inner stack" aria-label="Источник и фильтры">
      <p class="muted small kr-source">${source ? `${source}${date ? ` · на ${date}` : ' · дата среза не указана'}` : 'Карта целей'}</p>
      ${error ? `<p class="inline-error" role="alert">${escape(error)}</p>` : ''}
      ${overviewFilters(model, helpers)}
    </section>
    <section class="panel panel-inner stack" id="kr-results" aria-label="Результаты фильтра">${renderStatusRows(model, helpers)}</section>
  </div>`;
}

function detailItem(label, value, helpers) {
  return hasValue(value) ? `<div><dt>${label}</dt><dd>${display(value, helpers)}</dd></div>` : '';
}

function textSection(label, value, helpers) {
  return hasValue(value) ? `<section class="kr-detail-text"><h3>${label}</h3><p>${display(value, helpers)}</p></section>` : '';
}

export function renderStatusDetail(entry, model, helpers) {
  const { escape, rowBadge } = helpers;
  const register = model.register;
  const goal = entry.goalId ? model.goals?.find(item => item.id === entry.goalId) : null;
  const source = [register?.source?.name, register?.sheet, `строка ${entry.sourceRow}`].filter(Boolean).map(escape).join(' · ');
  const status = entry.status ? (rowBadge({ status: statusName(entry.status, helpers) }) || escape(statusName(entry.status, helpers))) : '—';
  const date = sourceDate(register?.asOf, escape);
  const otherComment = entry.comment && ![entry.curatorComment, entry.leaderComment].includes(entry.comment) ? entry.comment : '';
  return `<h2 id="dialog-title">${escape(entry.keyResult || 'Ключевой результат')}</h2>
    ${entry.objective ? `<p class="muted">${escape(entry.objective)}</p>` : ''}
    <p class="muted small kr-source">${source}${date ? ` · на ${date}` : ' · дата среза не указана'}</p>
    <dl class="definition kr-details">
      ${detailItem('Период', entry.period, helpers)}${detailItem('Руководитель', entry.leader, helpers)}${detailItem('Куратор', entry.curator, helpers)}
      ${detailItem('Направление', entry.direction, helpers)}${detailItem('Вес', entry.weight, helpers)}
      <div><dt>План</dt><dd>${display(entry.plan, helpers)}</dd></div><div><dt>Факт</dt><dd>${display(entry.fact, helpers)}</dd></div>
      <div><dt>Прогноз</dt><dd>${status}</dd></div>
      ${detailItem('Код прогноза', entry.forecast, helpers)}${detailItem('Наличие артефакта', entry.artifactStatus, helpers)}
      ${entry.goalId ? detailItem('Цель карты', goal ? `${goal.id} · ${goal.title}` : entry.goalId, helpers) : ''}
    </dl>
    ${textSection('Артефакт', entry.artifact, helpers)}${textSection('Комментарий куратора', entry.curatorComment, helpers)}
    ${textSection('Комментарий руководителя', entry.leaderComment, helpers)}${textSection('Комментарий', otherComment, helpers)}
    <div class="actions">${entry.goalId ? `<button type="button" class="button" data-action="kr-goal" data-id="${escape(entry.goalId)}" data-scope="${escape(entry.scopeId)}" data-period="${escape(entry.period)}" data-source="${escape(register?.source?.id)}">Открыть цель</button>` : ''}
      ${register?.source?.id ? `<a class="button" href="/api/source/${encodeURIComponent(register.source.id)}/file">Скачать Excel</a>` : ''}
      <button type="button" class="button primary" data-action="dialog-close">Закрыть</button></div>`;
}
