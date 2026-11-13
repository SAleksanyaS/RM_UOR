import { renderDitOverview } from './map-overview.js';

const kinds = new Map([
  ['bar', 'Столбцы'], ['stacked', 'Состав по статусам'], ['table', 'Таблица'],
]);
const groups = new Map([
  ['status', 'Статус'], ['leader', 'ИТ-лидер'], ['objective', 'Цель'],
]);
const missing = {
  status: 'Нет статуса', leader: 'ИТ-лидер не указан', objective: 'Цель не указана',
};

function raw(value) {
  return typeof value === 'string' ? value : '';
}

function labelFor(group, value, { statusLabel }) {
  if (!value) return missing[group];
  return group === 'status' ? statusLabel?.(value) ?? value : value;
}

function statusTone(status) {
  if (!status) return 'blank';
  const key = status.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  if (key === 'выполнено') return 'done';
  if (key === 'в плане') return 'plan';
  if (key === 'риск принят' || key === 'риски приняты') return 'accepted';
  if (key.includes('риск')) return 'risk';
  if (key.includes('методик')) return 'method';
  if (key.includes('вне ') || key === 'неприменимо') return 'excluded';
  const code = [...key].reduce((total, char) => total + char.codePointAt(0), 0);
  return `other-${code % 4}`;
}

function cardEntries(card, register) {
  if (!card.period) return [];
  return register.entries.filter(entry => entry.period === card.period
    && (!card.status || entry.status === card.status)
    && (!card.leader || entry.leader === card.leader));
}

function buckets(entries, group, helpers) {
  const grouped = new Map();
  for (const entry of entries) {
    const value = raw(entry[group]);
    const id = group === 'objective' ? raw(entry.goalId) : group === 'leader' ? raw(entry.scopeId) : '';
    const key = id || value;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = { id, value, label: labelFor(group, value, helpers), count: 0, statuses: new Map() };
      grouped.set(key, bucket);
    }
    const status = raw(entry.status);
    bucket.count += 1;
    bucket.statuses.set(status, (bucket.statuses.get(status) ?? 0) + 1);
  }
  return [...grouped.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'ru'));
}

function drillButton(label, card, group, value, { escape }, interactive, id = '') {
  if (!interactive || !value) return `<span>${escape(label)}</span>`;
  const status = group === 'status' ? value : card.status;
  const leader = group === 'leader' ? value : card.leader;
  const objective = group === 'objective' ? value : '';
  const identity = id && (group === 'objective' ? ` data-goal-id="${escape(id)}"` : ` data-scope-id="${escape(id)}"`);
  return `<button type="button" class="viz-drill" data-action="viz-drill" data-period="${escape(card.period)}" data-status="${escape(status)}" data-leader="${escape(leader)}" data-objective="${escape(objective)}"${identity}>${escape(label)}</button>`;
}

function track(segments, max) {
  let start = 0;
  const bars = segments.map(({ count, tone }) => {
    const width = count * 100 / max;
    const rectangle = `<rect class="viz-fill viz-tone-${tone}" x="${start.toFixed(4)}" y="0" width="${width.toFixed(4)}" height="10"></rect>`;
    start += width;
    return rectangle;
  }).join('');
  return `<svg class="viz-track" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">${bars}</svg>`;
}

function formatCount(count, { numberFormat }) {
  return numberFormat.format(count);
}

function legend(statuses, card, helpers, interactive) {
  return `<ul class="viz-legend" aria-label="Статусы">${statuses.map(item => `<li>
    <span class="viz-swatch viz-tone-${statusTone(item.value)}" aria-hidden="true"></span>
    ${drillButton(item.label, card, 'status', item.value, helpers, interactive)}
    <span class="viz-legend-count">${formatCount(item.count, helpers)}</span>
  </li>`).join('')}</ul>`;
}

function barChart(rows, card, group, helpers, interactive, statuses = null) {
  const max = rows[0].count;
  return `<div class="viz-chart">
    <ul class="viz-bars" aria-label="Количество назначений целей по группам">${rows.map(row => {
      const segments = statuses
        ? statuses.filter(item => row.statuses.has(item.value)).map(item => ({ count: row.statuses.get(item.value), tone: statusTone(item.value) }))
        : [{ count: row.count, tone: group === 'status' ? statusTone(row.value) : 'accent' }];
      const breakdown = statuses?.filter(item => row.statuses.has(item.value)).map(item => `${item.label} — ${formatCount(row.statuses.get(item.value), helpers)}`);
      return `<li class="viz-bar">
        <div class="viz-bar-label">${drillButton(row.label, card, group, row.value, helpers, interactive, row.id)}<span class="viz-count">${formatCount(row.count, helpers)}</span></div>
        ${track(segments, max)}
        ${statuses?.length > 1 && breakdown?.length ? `<p class="viz-segment-counts">${breakdown.map(helpers.escape).join(' · ')}</p>` : ''}
      </li>`;
    }).join('')}</ul>
    ${statuses ? legend(statuses, card, helpers, interactive) : ''}
  </div>`;
}

function table(rows, card, group, helpers, interactive) {
  return `<div class="table-wrap"><table class="viz-table"><thead><tr><th scope="col">${groups.get(group)}</th><th scope="col">Назначения целей</th></tr></thead>
    <tbody>${rows.map(row => `<tr><th scope="row">${drillButton(row.label, card, group, row.value, helpers, interactive, row.id)}</th><td>${formatCount(row.count, helpers)}</td></tr>`).join('')}</tbody></table></div>`;
}

function visualizationBody(card, model, helpers, interactive) {
  if (model.loading) return '<p class="viz-empty muted">Загружаем назначения и статусы целей…</p>';
  if (!model.register) return '<p class="viz-empty muted">Загрузите карту целей и книгу со статусами.</p>';
  if (!card.period) return '<p class="viz-empty muted">Выберите один период в настройках карточки.</p>';
  const entries = cardEntries(card, model.register);
  if (!entries.length) return '<p class="viz-empty muted">По выбранным условиям нет назначений целей.</p>';
  const group = groups.has(card.group) ? card.group : 'status';
  const rows = buckets(entries, group, helpers);
  const statusGroups = card.kind === 'stacked' ? buckets(entries, 'status', helpers) : null;
  let content;
  if (card.kind === 'table') content = table(rows, card, group, helpers, interactive);
  else if (statusGroups && group === 'status') {
    content = `<div class="viz-chart viz-composition">${track(statusGroups.map(item => ({ count: item.count, tone: statusTone(item.value) })), entries.length)}
      ${legend(statusGroups, card, helpers, interactive)}</div>`;
  } else content = barChart(rows, card, group, helpers, interactive, statusGroups);
  return `<div class="viz-measure"><strong>${formatCount(entries.length, helpers)}</strong><span>Назначения целей</span></div>${content}`;
}

function cardContext(card, helpers) {
  return [card.period, card.leader, card.status ? labelFor('status', card.status, helpers) : ''].filter(Boolean).map(helpers.escape).join(' · ');
}

function cardControls(card, index, length, { escape }) {
  const id = escape(card.id);
  return `<div class="viz-controls actions">
    <button class="button compact" type="button" data-action="viz-edit" data-id="${id}">Настроить</button>
    <button class="button compact" type="button" data-action="viz-move" data-id="${id}" data-direction="up"${index === 0 ? ' disabled' : ''} aria-label="Поднять карточку ${escape(card.title)}">Выше</button>
    <button class="button compact" type="button" data-action="viz-move" data-id="${id}" data-direction="down"${index === length - 1 ? ' disabled' : ''} aria-label="Опустить карточку ${escape(card.title)}">Ниже</button>
    <button class="button compact viz-remove" type="button" data-action="viz-remove" data-id="${id}">Удалить</button>
  </div>`;
}

function renderCard(card, model, helpers, interactive, index) {
  const context = cardContext(card, helpers);
  return `<article class="panel panel-inner viz-card${interactive ? '' : ' viz-card-builder'}">
    <header class="viz-card-heading"><div><h2>${helpers.escape(card.title)}</h2>${context ? `<p class="viz-context muted small">${context}</p>` : ''}</div>
      ${interactive ? '' : `<span class="viz-format muted small">${kinds.get(card.kind) ?? kinds.get('bar')}</span>`}</header>
    ${visualizationBody(card, model, helpers, interactive)}
    ${interactive ? '' : cardControls(card, index, model.cards.length, helpers)}
  </article>`;
}

function sourceSummary(model, { escape, dateText }) {
  const { register } = model;
  if (!register?.source?.name) return '';
  const date = register.asOf ? `на ${escape(dateText(register.asOf))}` : 'дата среза не указана';
  return `<p class="viz-source muted small">${escape(register.source.name)} · ${date}</p>`;
}

function displayError(error, { escape }) {
  return error ? `<p class="inline-error" role="alert">${escape(error)}</p>` : '';
}

export function renderVisualization(model, helpers) {
  const { heading, empty } = helpers;
  const title = heading('Визуализация', 'Статусы назначений целей по периодам и ИТ-лидерам.');
  const error = displayError(model.error, helpers);
  const dit = renderDitOverview(model.dit, model.ditPeriod || model.cards[0]?.period, helpers, true);
  if (!model.cards.length) {
    if (model.loading && !dit) return `${title}<p class="muted loading" role="status">Загружаем визуализацию…</p>`;
    return `${title}<div class="viz-page stack">${error}${dit}${empty(dit ? 'Графики по ИТ-лидерам ещё не настроены' : 'Карточки ещё не настроены', 'Добавьте нужные карточки в разделе «Настройка → Конструктор графиков».')}</div>`;
  }
  return `${title}<div class="viz-page stack">${sourceSummary(model, helpers)}${error}${dit}
    <div class="viz-grid">${model.cards.map((card, index) => renderCard(card, model, helpers, true, index)).join('')}</div>
  </div>`;
}

export function renderVisualizationBuilder(model, helpers) {
  const { heading, empty } = helpers;
  const add = '<button type="button" class="button primary" data-action="viz-add">Добавить карточку</button>';
  const title = heading('Конструктор графиков', 'Настройте вид назначений целей в итогах.', model.cards.length ? add : '');
  const error = displayError(model.error, helpers);
  if (!model.cards.length) {
    if (model.loading) return `${title}<p class="muted loading" role="status">Загружаем настройки…</p>`;
    return title + error + empty('Добавьте первую карточку', 'Например, покажите статусы по ИТ-лидерам за один квартал.', add);
  }
  return `${title}<div class="viz-page stack">${sourceSummary(model, helpers)}${error}
    <div class="viz-grid">${model.cards.map((card, index) => renderCard(card, model, helpers, false, index)).join('')}</div>
  </div>`;
}

function editorOptions(values, current, { option }) {
  return values.map(([value, label]) => option(value, label, current)).join('');
}

function filterValues(entries, key, selected, helpers) {
  const available = [...new Set(entries.map(entry => raw(entry[key])).filter(Boolean))];
  if (key !== 'leader' && selected && !available.includes(selected)) available.push(selected);
  return available.sort((left, right) => left.localeCompare(right, 'ru')).map(value => [value, labelFor(key, value, helpers)]);
}

export function renderVisualizationEditor(model, helpers) {
  const { escape } = helpers;
  const card = model.editingCard ?? {};
  const periods = [...(model.register?.periods ?? [])];
  if (card.period && !periods.includes(card.period)) periods.push(card.period);
  const period = card.period || periods[0] || '';
  const entries = model.register?.entries ?? [];
  const statusOptions = filterValues(entries, 'status', card.status, helpers);
  const leaderOptions = filterValues(entries, 'leader', card.leader, helpers);
  const leader = leaderOptions.some(([value]) => value === card.leader) ? card.leader : '';
  return `<h2 id="dialog-title">${card.id ? 'Настроить карточку' : 'Добавить карточку'}</h2>
    <form id="visualization-form" class="form-grid viz-editor" data-id="${escape(card.id)}" data-revision="${escape(model.revision)}">
      <label class="field wide"><span>Название</span><input name="title" required maxlength="90" value="${escape(card.title)}" placeholder="Например, статусы по ИТ-лидерам"></label>
      <label class="field"><span>Представление</span><select name="kind">${editorOptions([...kinds], card.kind || 'bar', helpers)}</select></label>
      <label class="field"><span>Группировка</span><select name="group">${editorOptions([...groups], card.group || 'status', helpers)}</select></label>
      <label class="field wide"><span>Период</span><select name="period" required>${periods.length ? editorOptions(periods.map(value => [value, value]), period, helpers) : '<option value="" disabled selected>Загрузите карту целей и книгу со статусами</option>'}</select></label>
      <label class="field"><span>Статус</span><select name="status">${editorOptions([['', 'Все статусы'], ...statusOptions], card.status || '', helpers)}</select></label>
      <label class="field"><span>ИТ-лидер</span><select name="leader">${editorOptions([['', 'Все ИТ-лидеры'], ...leaderOptions], leader, helpers)}</select></label>
      <p class="form-caption wide">Каждая пара «цель и ИТ-лидер» считается один раз за выбранный период.</p>
      <div class="actions wide"><button type="button" class="button" data-action="dialog-close">Отмена</button><button type="submit" class="button primary"${periods.length ? '' : ' disabled'}>Сохранить карточку</button></div>
    </form>`;
}
