const pageSize = 25;
const stateLabels = new Map([
  ['confirmed', 'Подтверждена'],
  ['suggested', 'Предложена'],
  ['unlinked', 'Без связи'],
  ['pending', 'На проверке'],
  ['ambiguous', 'Неоднозначная'],
]);

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim();
}

function display(value, { escape, numberFormat }) {
  if (value == null || value === '') return '—';
  return escape(typeof value === 'number' ? numberFormat.format(value) : value);
}

function dateLabel(asOf, escape) {
  return /^\d{4}-\d{2}-\d{2}$/.test(asOf ?? '') ? escape(asOf.split('-').reverse().join('.')) : '';
}

function goalName(id, model) {
  if (!id) return '';
  const goal = model.goals?.find(item => item.id === id);
  return goal ? `${goal.id} · ${goal.title}` : id;
}

function stateBadge(entry, { escape }) {
  const tone = entry.linkState === 'confirmed' ? ' success' : entry.linkState === 'suggested' ? ' accent'
    : ['pending', 'ambiguous'].includes(entry.linkState) ? ' warning' : '';
  return `<span class="badge${tone}">${escape(stateLabels.get(entry.linkState) ?? 'Без связи')}</span>`;
}

export function statusLinkScopeOptions(goalId, model, { option }, selected = '') {
  const goal = model.goals?.find(item => item.id === goalId);
  const eligible = new Set((goal?.assignments ?? []).filter(item => item.active !== false).map(item => item.leaderId));
  const leaders = (model.directory ?? []).filter(item => item.type === 'leader' && eligible.has(item.id))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
  const value = leaders.some(item => item.id === selected) ? selected : '';
  return [option('', 'Без привязки к руководителю', value), ...leaders.map(item => option(item.id, item.name, value))].join('');
}

function sourcePicker(model, { option }) {
  const selected = model.sourceId || model.register?.source?.id || '';
  return `<label class="field reconcile-source"><span>Книга Excel</span><select id="reconcile-source">${option('', 'Выберите книгу', selected)}
    ${(model.sources ?? []).map(source => option(source.id, source.name, selected)).join('')}</select></label>`;
}

function sourceInfo(register, { escape }) {
  const date = dateLabel(register.asOf, escape);
  const provenance = [register.sheet, register.range].filter(Boolean).map(escape).join(' · ');
  return `<div class="reconcile-source-info stack">
    <p class="muted small kr-source">${provenance}</p>
    <form id="snapshot-date-form" class="toolbar reconcile-date" data-source="${escape(register.source?.id)}" data-revision="${escape(register.snapshotRevision)}">
      <label class="field"><span>Дата среза</span><input name="asOf" type="date" value="${date ? escape(register.asOf) : ''}" required></label>
      <button type="submit" class="button compact">Сохранить дату</button>
    </form>
  </div>`;
}

function reconciliationSummary(entries) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry.linkState, (counts.get(entry.linkState) ?? 0) + 1);
  const confirmed = counts.get('confirmed') ?? 0;
  const unlinked = counts.get('unlinked') ?? 0;
  const countsText = [
    `${entries.length} строк`, `${confirmed} подтверждено`,
    `${entries.length - confirmed - unlinked} требуют сверки`
  ];
  if (unlinked) countsText.push(`${unlinked} оставлено без связи`);
  return `<p class="muted small reconcile-summary">${countsText.join(' · ')}</p>`;
}

function filtersMarkup(model, { option, escape }) {
  const { filters = {}, register } = model;
  const period = filters.period ?? '';
  const mode = filters.mode ?? '';
  const modes = [['', 'Все связи'], ['review', 'Требуют сверки'], ['confirmed', 'Подтверждённые'],
    ['suggested', 'Предложенные'], ['unlinked', 'Без связи'], ['pending', 'На проверке'], ['ambiguous', 'Неоднозначные']];
  return `<div class="kr-filters reconcile-filters">
    <label class="field"><span>Период</span><select id="reconcile-period">${option('', 'Все периоды', period)}${(register.periods ?? []).map(item => option(item, item, period)).join('')}</select></label>
    <label class="field"><span>Связь с целью</span><select id="reconcile-mode">${modes.map(([value, label]) => option(value, label, mode)).join('')}</select></label>
    <label class="field kr-search"><span>Поиск</span><input id="reconcile-search" type="search" value="${escape(filters.query)}" placeholder="Ключевой результат, цель или руководитель"></label>
  </div>`;
}

function tableRow(entry, model, helpers, showPeriod) {
  const { escape } = helpers;
  const goal = goalName(entry.goalId, model);
  const action = entry.linkState === 'confirmed' ? 'Изменить' : entry.linkState === 'ambiguous' ? 'Посмотреть' : 'Сверить';
  return `<tr>
    <td class="kr-key-result"><strong>${escape(entry.keyResult || 'Строка без названия')}</strong>${entry.objective ? `<p class="muted small">${escape(entry.objective)}</p>` : ''}</td>
    <td>${display(entry.leader, helpers)}</td>
    ${showPeriod ? `<td>${display(entry.period, helpers)}</td>` : ''}
    <td>${stateBadge(entry, helpers)}${goal ? `<p class="muted small">${escape(goal)}</p>` : ''}</td>
    <td>${display(entry.sourceRow, helpers)}</td>
    <td><button class="button compact" type="button" data-action="reconcile-open" data-id="${escape(entry.id)}" aria-label="${action} связь строки ${escape(entry.sourceRow)}">${action}</button></td>
  </tr>`;
}

export function renderReconciliationRows(model, helpers) {
  const { register, filters = {} } = model;
  if (!register) return '';
  const query = normalize(filters.query);
  const entries = register.entries.filter(entry => {
    if (filters.period && entry.period !== filters.period) return false;
    if (filters.mode === 'review' && ['confirmed', 'unlinked'].includes(entry.linkState)) return false;
    if (filters.mode && filters.mode !== 'review' && (entry.linkState ?? 'unlinked') !== filters.mode) return false;
    if (!query) return true;
    return normalize([entry.keyResult, entry.objective, entry.leader, entry.curator, goalName(entry.goalId, model), entry.sourceRow].join(' ')).includes(query);
  });
  if (!entries.length) return '<p class="status-empty" role="status">По этим условиям строки не найдены.</p>';
  const lastPage = Math.ceil(entries.length / pageSize) - 1;
  const page = Math.min(Math.max(Number.isInteger(filters.page) ? filters.page : 0, 0), lastPage);
  const start = page * pageSize;
  const shown = entries.slice(start, start + pageSize);
  const showPeriod = !filters.period;
  return `<div class="table-wrap"><table class="kr-table reconcile-table" aria-label="Сверка ключевых результатов"><thead><tr>
      <th scope="col">Ключевой результат</th><th scope="col">Руководитель</th>${showPeriod ? '<th scope="col">Период</th>' : ''}<th scope="col">Связь с целью</th><th scope="col">Строка</th><th scope="col">Действие</th>
    </tr></thead><tbody>${shown.map(entry => tableRow(entry, model, helpers, showPeriod)).join('')}</tbody></table></div>
    <div class="kr-pagination reconcile-pagination toolbar"><span class="muted small" role="status">${start + 1}–${start + shown.length} из ${entries.length}</span>
      ${lastPage ? `<button type="button" class="button compact" data-action="reconcile-page" data-page="${page - 1}"${page === 0 ? ' disabled' : ''}>Назад</button>
        <button type="button" class="button compact" data-action="reconcile-page" data-page="${page + 1}"${page === lastPage ? ' disabled' : ''}>Далее</button>` : ''}</div>`;
}

export function renderReconciliation(model, helpers) {
  const { heading, empty, escape } = helpers;
  const title = heading('Сверка статусов КР', 'Подтвердите, к какой цели относится строка Excel. Подтверждение связи сохраняется отдельно от книги.');
  if (!(model.sources ?? []).length) return title + empty('Загрузите книгу Excel', 'Выберите книгу со статусами КР в разделе «Источники».', '<a href="#sources" class="button">Открыть источники</a>');
  const register = model.register;
  const current = register && (!model.sourceId || model.sourceId === register.source?.id);
  const content = model.loading ? '<p class="muted loading" role="status">Читаем выбранную книгу…</p>'
    : model.error ? `<p class="inline-error" role="alert">${escape(model.error)}</p>`
      : current ? `${sourceInfo(register, helpers)}${reconciliationSummary(register.entries)}${filtersMarkup(model, helpers)}`
        : '<p class="status-empty">В выбранной книге реестр КР не найден.</p>';
  return `${title}<div class="stack reconcile-page">
    <section class="panel panel-inner stack" aria-label="Источник и фильтры">${sourcePicker(model, helpers)}${content}</section>
    ${current && !model.loading && !model.error ? `<section class="panel panel-inner stack" id="reconcile-rows" aria-label="Строки для сверки">${renderReconciliationRows(model, helpers)}</section>` : ''}
  </div>`;
}

function detailItem(label, value, helpers) {
  return `<div><dt>${label}</dt><dd>${display(value, helpers)}</dd></div>`;
}

export function renderStatusLinkDialog(entry, model, helpers) {
  const { escape, option, rowBadge, statusLabel } = helpers;
  const { register } = model;
  const ambiguous = entry.linkState === 'ambiguous';
  const targetGoal = model.goals?.some(goal => goal.id === entry.goalId) ? entry.goalId : '';
  const provenance = [register?.source?.name, register?.sheet, `строка ${entry.sourceRow}`].filter(Boolean).map(escape).join(' · ');
  const date = dateLabel(register?.asOf, escape);
  const status = entry.status ? rowBadge({ status: statusLabel?.(entry.status) ?? entry.status }) : '';
  const goalOptions = (model.goals ?? []).map(goal => option(goal.id, `${goal.id} · ${goal.title}`, targetGoal)).join('');
  return `<h2 id="dialog-title">Сверка связи с целью</h2>
    <div class="stack reconcile-modal"><div><strong>${escape(entry.keyResult || 'Ключевой результат')}</strong>${entry.objective ? `<p class="muted small">${escape(entry.objective)}</p>` : ''}</div>
      <p class="muted small kr-source">${provenance}${date ? ` · на ${date}` : ' · дата среза не указана'}</p>
      <dl class="definition kr-details">
        ${detailItem('Период', entry.period, helpers)}${detailItem('Руководитель', entry.leader, helpers)}
        ${detailItem('План', entry.plan, helpers)}${detailItem('Факт', entry.fact, helpers)}
        ${status ? `<div><dt>Прогноз</dt><dd>${status}</dd></div>` : ''}
        <div><dt>Связь</dt><dd>${stateBadge(entry, helpers)}</dd></div>
      </dl>
    </div>
    ${entry.linkState === 'suggested' ? '<p class="form-caption">Предложение из файла можно подтвердить или изменить.</p>' : ''}
    ${ambiguous ? '<p class="inline-error" role="alert">Связь этой строки нельзя подтвердить. Проверьте неоднозначные строки в источнике.</p>' : ''}
    <form id="status-link-form" class="stack" data-entry="${escape(entry.id)}" data-source="${escape(register?.source?.id)}" data-revision="${escape(entry.linkRevision)}">
      <label class="field"><span>Цель</span><select name="goalId" required${ambiguous ? ' disabled' : ''}>
        <option value="" disabled${targetGoal ? '' : ' selected'}>Выберите цель</option>${option('__unlinked__', 'Оставить без связи', targetGoal)}${goalOptions}</select></label>
      <label class="field"><span>Руководитель в карте</span><select name="scopeId"${ambiguous ? ' disabled' : ''}>${statusLinkScopeOptions(targetGoal, model, helpers, entry.scopeId)}</select></label>
      <div class="actions"><button type="button" class="button" data-action="dialog-close">${ambiguous ? 'Закрыть' : 'Отмена'}</button>
        ${ambiguous ? '' : '<button type="submit" class="button primary">Сохранить связь</button>'}</div>
    </form>`;
}
