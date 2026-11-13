import { renderStatusDetail, renderStatusPage, renderStatusRows } from './status-view.js';
import { renderReconciliation, renderReconciliationRows, renderStatusLinkDialog, statusLinkScopeOptions } from './reconciliation-view.js';
import { renderWeekly } from './weekly-view.js';
import { renderVisualization, renderVisualizationBuilder, renderVisualizationEditor } from './visualization-view.js';
import { renderBrowserConnectors, renderBrowserEditor, renderBrowserReports } from './browser-view.js';
import { renderMapOverview } from './map-overview.js';
import { projectDitGoalStatuses, projectGoalStatuses } from './goal-status.js';
import { renderDitSettings } from './dit-settings-view.js';
import { renderGitAuth } from './git-auth-view.js';

const sections = [
  {
    label: 'Итоги', icon: 'results',
    pages: [['map', 'Карта целей'], ['statuses', 'Статусы целей'], ['weekly', 'Еженедельный отчёт'], ['browser-reports', 'Отчёты из браузера'], ['visualization', 'Визуализация'], ['history', 'История']],
  },
  {
    label: 'Настройка', icon: 'setup',
    pages: [['edit', 'Цели и статусы'], ['dit-settings', 'Статусы ДИТ'], ['sources', 'Источники'], ['connectors', 'Браузерные подключения'], ['reconcile', 'Сверка КР'], ['directory', 'Справочники'], ['automation', 'Автоматизация'], ['visualization-builder', 'Конструктор графиков'], ['settings', 'Профиль и Git']],
  },
];

const icons = {
  results: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M7.5 15.5 11 12l2.5 2.5 3.5-4.5"/>',
  setup: '<path d="M5 7h6m4 0h4M5 17h2m4 0h8"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
  filter: '<path d="M5 7h14M8 12h8m-5 5h2"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  edit: '<path d="m14 6 4 4m-9 9H5v-4L15.5 4.5a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2Z"/>',
  send: '<path d="M4 10.5 20 4l-6.5 16-3.4-6.1L4 10.5Zm6.1 3.4L20 4"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[name]}</svg>`;
}

const categories = { process: 'Производственный процесс', data: 'Данные', architecture: 'Архитектура', security: 'Безопасность' };
const classifications = { active: 'В работе', monitor: 'Мониторинг', clarify: 'Уточняется', methodPending: 'Методика ожидается', outOfScope: 'Вне периметра', removed: 'Снята' };
const directoryTypes = { dit: 'ДИТ', leader: 'Кластер / лидер', team: 'Команда', product: 'Продукт / АС', agent: 'Агент' };
const themeLabels = new Map([
  ['system', 'Системная'], ['indigo', 'Индиго'], ['slate', 'Сланец'],
  ['sand', 'Песочная'], ['forest', 'Лесная'], ['dark', 'Тёмная'],
]);
const statusLabels = new Map([
  ['в плане', 'В плане'], ['выполнено', 'Выполнено'], ['есть риски', 'Есть риски'],
  ['риск принят', 'Риск принят'], ['нет методики', 'Нет методики'],
  ['нет данных', 'Нет данных'], ['неприменимо', 'Неприменимо'],
]);
const main = document.querySelector('main');
const dialog = document.querySelector('dialog');
const notice = document.querySelector('#notice');
const sidebar = document.querySelector('#sidebar');
const navigation = document.querySelector('#navigation');
const menuToggle = document.querySelector('#menu-toggle');
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const numberFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeZone: 'Europe/Moscow' });
const dateInputFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });

let state;
let currentGoalId = '';
let automationGoalId = '';
let currentScopeId = 'dit';
let selectedPeriod = '';
let goalQuery = '';
let categoryFilter = '';
let leaderFilter = '';
let mapOverviewPeriod = '';
let preview;
let directoryEditId = '';
let noticeTimer;
let busy = false;
let onboardingShown = false;
let unsavedForm = false;
let navigationHash;
let register = null;
let registerLoading = true;
let registerError = '';
let registerRequest = 0;
let resultSourceId = '';
let ditSettingsPeriod = '';
let gitOperation;
const krFilters = { period: null, status: '', leader: '', query: '', objective: '', goalId: '', page: 0 };
let reconcileRegister = null;
let reconcileSourceId = '';
let reconcileLoading = false;
let reconcileError = '';
let reconcileRequest = 0;
const reconcileFilters = { period: null, mode: 'review', query: '', page: 0 };
const weekly = { currentId: '', previousId: null, period: '', report: null, loading: false, error: '' };
let weeklyRequest = 0;
const curatorWeekly = { week: '', curatorWeek: null, reportWeeks: [], curatorLoading: true, curatorError: '' };
let curatorWeeklyRequest = 0;
let browserState = { connectors: [], jobs: [], reports: [], openProfiles: [], loading: true, error: '' };
let browserRequest = 0;
let browserChecking = false;
let browserChanging = false;

navigation.innerHTML = sections.map(section => `
  <details class="nav-section">
    <summary class="nav-item">
      <span class="nav-icon">${icon(section.icon)}</span><span>${section.label}</span>${icon('chevron')}
    </summary>
    <ul class="nav-children">${section.pages.map(([id, label]) =>
      `<li><a href="#${id}">${label}</a></li>`
    ).join('')}</ul>
  </details>`).join('');

function dateText(value) {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('.');
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : dateFormat.format(date);
}

function today() {
  const fields = Object.fromEntries(dateInputFormat.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function defaultPeriod() {
  const [year, month] = today().split('-');
  return `Q${Math.ceil(Number(month) / 3)} ${year}`;
}

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim();
}

function url(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '';
  } catch {
    return '';
  }
}

function option(value, label, selectedValue) {
  return `<option value="${escape(value)}"${String(value) === String(selectedValue) ? ' selected' : ''}>${escape(label)}</option>`;
}

function navigate() {
  const name = location.hash.slice(1);
  return sections.some(section => section.pages.some(([id]) => id === name)) ? name : 'map';
}

function sectionFor(page) {
  return sections.find(section => section.pages.some(([id]) => id === page));
}

function updateShell(page = navigate()) {
  const section = sectionFor(page);
  const pageName = section.pages.find(([id]) => id === page)[1];
  document.title = `${pageName} · ДИТ OPS`;
  document.querySelector('#breadcrumb').textContent = section.label;
  for (const [index, group] of [...navigation.children].entries()) {
    const current = sections[index] === section;
    group.classList.toggle('is-current', current);
    if (current && navigationHash !== location.hash && location.hash === `#${page}`) group.open = true;
    for (const link of group.querySelectorAll('a')) {
      if (link.hash === `#${page}`) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }
  navigationHash = location.hash;
  const profile = state?.profile;
  const name = profile?.name || 'Настроить профиль';
  const initials = profile?.name?.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || 'УОР';
  document.querySelector('#top-actions').innerHTML = `
    ${section === sections[1] ? `<a href="#settings" class="profile-button" aria-label="${escape(name)}"><span class="avatar">${escape(initials)}</span><span>${escape(name)}</span></a>`
      : profile?.name ? `<span class="profile-button"><span class="avatar">${escape(initials)}</span><span>${escape(name)}</span></span>` : ''}`;
  const revision = state?.shared?.version;
  document.querySelector('#sidebar-footer').innerHTML = `<p class="local-status"><i aria-hidden="true"></i>Работа на этом компьютере</p>
    <small class="version">${state?.appVersion ? `Версия ${escape(state.appVersion)}` : ''}${revision !== undefined && revision !== null ? ` · данные ${escape(revision)}` : ''}</small>`;
}

function heading(title, description, actions = '') {
  return `<div class="page-heading"><div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}</div>${actions ? `<div class="actions">${actions}</div>` : ''}</div>`;
}

function empty(title, description, action = '') {
  return `<div class="empty page-empty panel"><h2>${title}</h2><p>${description}</p>${action}</div>`;
}

function statusBadge(text, tone = '') {
  if (!text) return '';
  return `<span class="badge${tone ? ` ${tone}` : ''}">${escape(text)}</span>`;
}

function statusLabel(value) {
  const normalized = normalize(value);
  if (normalized.startsWith('нет методики')) return 'Нет методики';
  return statusLabels.get(normalized) ?? value;
}

function rowBadge(row) {
  if (!row?.status) return '';
  const status = normalize(row.status);
  let tone = '';
  if (row.risk || /риск/.test(status)) tone = 'warning';
  else if (status === 'выполнено') tone = 'success';
  else if (status === 'в плане') tone = 'accent';
  else if (status.startsWith('нет методики')) tone = 'danger';
  return statusBadge(statusLabel(row.status), tone);
}

function records(goal, kind) {
  return Array.isArray(goal?.[kind]) ? goal[kind] : [];
}

function directoryName(id) {
  return state.directory.find(item => item.id === id)?.name ?? id;
}

function scopesFor(goal) {
  const scopes = new Map([['dit', directoryName('dit') === 'dit' ? 'ДИТ OPS' : directoryName('dit')]]);
  const add = candidate => {
    const id = typeof candidate === 'string' ? candidate : candidate?.scopeId ?? candidate?.id ?? candidate?.teamId ?? candidate?.leaderId;
    if (!id) return;
    const match = state.directory.find(item => item.id === id || normalize(item.name) === normalize(id));
    if (match) scopes.set(match.id, match.name);
    else if (candidate?.name) scopes.set(id, candidate.name);
    else scopes.set(id, id);
  };
  for (const assignment of goal?.assignments ?? []) {
    if (assignment?.active === false) continue;
    add(assignment?.scopeId ?? assignment?.leaderId ?? assignment?.clusterId ?? assignment);
    for (const participant of assignment?.scopeIds ?? []) add(participant);
  }
  for (const kind of ['published', 'local', 'automatic']) {
    for (const row of records(goal, kind)) add(row.scopeId);
  }
  if (scopes.size === 1) {
    for (const item of state.directory.filter(item => ['leader', 'team', 'product', 'agent'].includes(item.type))) add(item.id);
  }
  return [...scopes];
}

function resultFor(goal, kind, scope, period) {
  return records(goal, kind).find(row => row.scopeId === scope && (!period || row.period === period));
}

function excelEntries(goalId, period, scopeId) {
  return (registerError ? [] : register?.entries ?? []).filter(entry => entry.goalId === goalId && entry.scopeId
    && (!period || entry.period === period)
    && (!scopeId || entry.scopeId === scopeId));
}

function clusterLeaders() {
  const activeIds = new Set(state.goals.flatMap(goal => (goal.assignments ?? [])
    .filter(item => item.active !== false).map(item => item.leaderId)));
  return state.directory.filter(item => item.type === 'leader' && activeIds.has(item.id));
}

function filteredGoals() {
  const needle = normalize(goalQuery);
  return state.goals.filter(goal => {
    if (categoryFilter && goal.category !== categoryFilter) return false;
    if (leaderFilter && !goal.assignments?.some(item => item.leaderId === leaderFilter && item.active !== false)) return false;
    return !needle || normalize([goal.id, goal.title, goal.description, ...(goal.curators ?? [])].join(' ')).includes(needle);
  });
}

function listStatus(goal, assignments, period) {
  if (navigate() === 'edit') {
    const published = resultFor(goal, 'published', leaderFilter || 'dit', period);
    if (published?.status) return rowBadge(published);
    return resultFor(goal, 'local', leaderFilter || 'dit', period) ? statusBadge('Черновик', 'accent') : '';
  }
  const rows = assignments.filter(item => item.goalId === goal.id && (!leaderFilter || item.scopeId === leaderFilter));
  if (leaderFilter) {
    const row = rows[0];
    const facts = row?.rows ?? excelEntries(goal.id, period, leaderFilter);
    const fact = facts.length === 1 && facts[0].fact != null ? `<small>Факт ${escape(factText(facts[0].fact))}</small>` : '';
    return `${rowBadge(row)}${fact}`;
  }
  if (!rows.some(row => row.status)) return '';
  const completed = rows.filter(row => row.status === 'Выполнено').length;
  const risks = rows.filter(row => row.status === 'Под риском').length;
  return `<small>${completed} из ${rows.length} выполнено${risks ? ` · под риском ${risks}` : ''}</small>`;
}

function goalList(goals) {
  const period = navigate() === 'map' ? selectedMapOverviewPeriod() : selectedPeriod || defaultPeriod();
  const assignments = navigate() === 'map'
    ? projectGoalStatuses(goals, state.directory, registerError ? null : register, [period]) : [];
  return goals.length ? goals.map(goal => `
    <button type="button" class="goal-button" data-action="select-goal" data-id="${escape(goal.id)}" aria-pressed="${goal.id === currentGoalId}">
      <span class="goal-button-title">${escape(goal.title)}</span>
      ${listStatus(goal, assignments, period)}
      <small class="muted">${escape(goal.id)}${goal.category ? ` · ${escape(categories[goal.category] ?? goal.category)}` : ''}</small>
    </button>`).join('') : '<p class="muted">По этим условиям целей нет.</p>';
}

function selectCurrent(goals) {
  if (goals.some(goal => goal.id === currentGoalId)) return;
  currentGoalId = (goals.find(goal => goal.id === 'SW26.1') ?? goals[0])?.id ?? '';
  currentScopeId = leaderFilter || 'dit';
  selectedPeriod = navigate() === 'map' ? selectedMapOverviewPeriod() : '';
}

function reading(title, row, kind) {
  const origin = row.mode === 'automatic' ? 'Автоматический расчёт' : 'Ручной ввод';
  return `<section class="reading ${kind}">
    <h3>${title}</h3><strong>${row.value == null ? '—' : `${numberFormat.format(row.value)}%`}</strong>
    ${rowBadge(row)}
    <p class="reading-meta">${[row.author, origin, row.asOf ? `на ${dateText(row.asOf)}` : ''].filter(Boolean).map(escape).join(' · ')}</p>
    ${row.plan ? `<p class="small">План — ${escape(row.plan)}</p>` : ''}
    ${row.comment ? `<p class="small">${escape(row.comment)}</p>` : ''}
    ${row.risk ? `<p class="small">Риск — ${escape(row.risk)}</p>` : ''}
  </section>`;
}

function manualForm(goal, draft, published) {
  const initial = draft ?? published;
  const status = initial?.status || 'В плане';
  const initialDate = initial?.asOf && /^\d{4}-\d{2}-\d{2}/.test(initial.asOf) ? initial.asOf.slice(0, 10) : today();
  return `<details class="status-editor" id="status-editor">
    <summary class="button primary">${icon('edit')}${initial ? 'Изменить статус' : 'Добавить статус'}</summary>
    <form id="status-form" class="form-grid" data-goal="${escape(goal.id)}">
      <label class="field"><span>Период</span><input name="period" required maxlength="60" value="${escape(selectedPeriod)}" placeholder="Q4 2026"></label>
      <label class="field"><span>Дата статуса</span><input name="asOf" type="date" required value="${escape(initialDate)}"></label>
      <label class="field"><span>Факт, %</span><input name="value" type="number" min="0" max="1000000" step="any" value="${escape(initial?.value)}" placeholder="Например, 80"></label>
      <label class="field"><span>Статус</span><input name="status" list="status-options" required maxlength="80" value="${escape(status)}"></label>
      <datalist id="status-options">${[...statusLabels.values()].map(label => `<option>${label}</option>`).join('')}</datalist>
      <details class="status-options wide" id="status-options-details">
        <summary>${icon('chevron')}План, комментарий и риски</summary>
        <div class="form-grid">
          <label class="field wide"><span>План</span><input name="plan" maxlength="1000" value="${escape(initial?.plan)}" placeholder="Что должно быть сделано"></label>
          <label class="field wide"><span>Комментарий</span><textarea name="comment" rows="2" maxlength="2000" placeholder="Что изменилось">${escape(initial?.comment)}</textarea></label>
          <label class="field wide"><span>Риски</span><input name="risk" maxlength="1000" value="${escape(initial?.risk)}" placeholder="Что может помешать выполнению"></label>
        </div>
      </details>
      <div class="actions wide"><button type="submit" class="button primary">Сохранить черновик</button></div>
    </form>
  </details>`;
}

function factText(value) {
  if (value == null || value === '') return '—';
  return typeof value === 'number' ? numberFormat.format(value) : value;
}

function renderExcelStatuses(goalId, period, scopeId) {
  const dit = scopeId === 'dit' ? ditStatuses([period]).find(entry => entry.goalId === goalId) : null;
  const rows = dit?.rows ?? excelEntries(goalId, period, scopeId === 'dit' ? '' : scopeId);
  if (!rows.length && !dit) return '';
  const date = register?.asOf ? `Срез от ${dateText(register.asOf)}` : 'Дата среза не указана';
  const total = dit ? `<section class="reading excel-status">
    <h3>Итог ДИТ</h3>
    <p class="excel-fact"><strong>Факт ${escape(factText(dit.fact))}</strong><span>План ${escape(factText(dit.plan))}</span></p>
    ${rowBadge(dit)}${dit.basis ? `<p class="reading-meta">${escape(dit.basis)}</p>` : ''}
  </section>` : '';
  if (!rows.length) return total;
  if (scopeId !== 'dit' && rows.length === 1) {
    const row = rows[0];
    return `<section class="reading excel-status">
      <h3>Текущий факт</h3><p class="reading-meta">Excel · ${escape(date)}</p>
      <p class="excel-fact"><strong>${escape(factText(row.fact))}</strong><span>План ${escape(factText(row.plan))}</span></p>
      ${rowBadge(row)} <button type="button" class="kr-open" data-action="kr-open" data-id="${escape(row.id)}">Строка ${row.sourceRow} в Excel</button>
    </section>`;
  }
  const leaders = new Map(clusterLeaders().map(item => [item.id, item.name]));
  return `${total}<details class="context-details excel-status"${rows.length <= 8 ? ' open' : ''}>
    <summary>${icon('chevron')}План и факт из Excel · ${rows.length}</summary>
    <div class="context-body">
      <p class="muted small">${escape(date)}${scopeId === 'dit' ? ' · строки по руководителям' : ''}</p>
      <ul class="excel-status-list">${rows.map(row => `<li>
        <button type="button" class="kr-open" data-action="kr-open" data-id="${escape(row.id)}">${escape(scopeId === 'dit' ? leaders.get(row.scopeId) || row.keyResult : row.keyResult)}</button>
        <span>План ${escape(factText(row.plan))} · факт ${escape(factText(row.fact))}</span>${rowBadge(row)}
      </li>`).join('')}</ul>
      <div class="actions"><button type="button" class="button compact" data-action="kr-for-goal" data-id="${escape(goalId)}">Открыть статусы целей</button></div>
    </div>
  </details>`;
}

function goalDetail(goal, editable) {
  if (!goal) return '<div class="panel empty"><h2>Выберите цель</h2><p>Здесь будут показаны статус и детали выбранной цели.</p></div>';
  const leaders = clusterLeaders();
  const scopes = editable ? scopesFor(goal) : [['dit', directoryName('dit')], ...leaders
    .filter(item => goal.assignments?.some(assignment => assignment.leaderId === item.id && assignment.active !== false))
    .map(item => [item.id, item.name])];
  if (!scopes.some(([id]) => id === currentScopeId)) currentScopeId = 'dit';
  const rowsByDate = (editable ? ['published', 'local', 'automatic'] : []).flatMap(kind => records(goal, kind))
    .filter(row => row.scopeId === currentScopeId)
    .sort((left, right) => String(right.asOf ?? '').localeCompare(String(left.asOf ?? '')));
  const excelPeriods = excelEntries(goal.id, '', currentScopeId === 'dit' ? '' : currentScopeId).map(row => row.period);
  const periods = [...new Set([...rowsByDate.map(row => row.period), ...excelPeriods,
    ...(!editable && !registerError ? register?.periods ?? [] : [])].filter(Boolean))];
  if (!selectedPeriod) selectedPeriod = periods[0] ?? defaultPeriod();
  if (!periods.includes(selectedPeriod)) periods.unshift(selectedPeriod);
  const published = resultFor(goal, 'published', currentScopeId, selectedPeriod);
  const draft = resultFor(goal, 'local', currentScopeId, selectedPeriod);
  const automatic = resultFor(goal, 'automatic', currentScopeId, selectedPeriod);
  const links = (goal.links ?? []).map(link => ({ name: link.label, href: url(link.url) })).filter(link => link.href);
  const curators = (goal.curators ?? []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
  const assignment = (goal.assignments ?? []).find(item => item.leaderId === currentScopeId || item.scopeIds?.includes(currentScopeId));
  const targetValue = assignment?.target || goal.target;
  const target = typeof targetValue === 'number' ? `${numberFormat.format(targetValue)}%` : targetValue;
  const metric = assignment?.metric || goal.metric;
  const summary = assignment?.summary || goal.description;
  const actions = assignment?.actions?.length ? assignment.actions : goal.actions;
  const comparisons = [
    ['Опубликовано', published, 'published'],
    ['Локальный статус', draft, 'local'],
    ['Личный расчёт', automatic, 'automatic'],
  ].filter(([, result]) => editable && result);
  const excel = editable ? '' : renderExcelStatuses(goal.id, selectedPeriod, currentScopeId);
  return `<article class="panel panel-inner stack">
    <header class="detail-header">
      <div class="tagline"><span class="muted small">${escape(goal.id)}${goal.category ? ` · ${escape(categories[goal.category] ?? goal.category)}` : ''}</span>${goal.status && goal.status !== 'active' ? statusBadge(classifications[goal.status] ?? goal.status) : ''}</div>
      <h2 id="goal-detail-title" tabindex="-1">${escape(assignment?.title || goal.title)}</h2>
    </header>
    <div class="scope-fields">
      <label class="field"><span>${editable ? 'ДИТ, лидер или команда' : 'ДИТ или ИТ-лидер'}</span><select id="scope-picker">${scopes.map(([id, name]) => option(id, name, currentScopeId)).join('')}</select></label>
      <label class="field"><span>Период</span><select id="period-picker">${periods.map(period => option(period, period, selectedPeriod)).join('')}</select></label>
    </div>
    ${comparisons.length ? `<div class="comparison${comparisons.length === 1 ? ' single' : ''}">${comparisons.map(parts => reading(...parts)).join('')}</div>`
      : excel ? '' : '<p class="status-empty">Статус за этот период ещё не добавлен.</p>'}
    ${excel}
    ${editable ? `<div class="goal-actions-row">
      ${manualForm(goal, draft, published)}
      <div class="actions">
        <button type="button" class="button compact" data-action="open-automation" data-id="${escape(goal.id)}">${state.automations?.[goal.id] ? 'Настройки расчёта' : 'Настроить расчёт'}</button>
        ${state.automations?.[goal.id] ? `<button type="button" class="button compact" data-action="calculate" data-id="${escape(goal.id)}">Пересчитать</button>` : ''}
      </div>
    </div>` : ''}
    <details class="context-details">
      <summary>${icon('chevron')}О цели</summary>
      <div class="context-body stack">
      ${summary ? `<p class="summary">${escape(summary)}</p>` : ''}
      ${goal.outOfScopeReason ? `<p class="summary">${escape(goal.outOfScopeReason)}</p>` : ''}
      ${target || metric || goal.method || curators.length ? `<dl class="definition">
        ${target ? `<div><dt>Цель</dt><dd>${escape(target)}</dd></div>` : ''}
        ${metric && metric !== target ? `<div><dt>Показатель</dt><dd>${escape(metric)}</dd></div>` : ''}
        ${goal.method ? `<div><dt>Методика</dt><dd>${escape(goal.method)}</dd></div>` : ''}
        ${curators.length ? `<div><dt>Кураторы</dt><dd>${curators.map(escape).join(', ')}</dd></div>` : ''}
      </dl>` : ''}
      ${links.length ? `<div class="detail-links">${links.map(link => `<a href="${escape(link.href)}" target="_blank" rel="noopener noreferrer">${escape(link.name || 'Источник')} ↗</a>`).join('')}</div>` : ''}
      ${actions?.length ? `<div class="goal-actions"><h3>Действия по цели</h3><ul>${actions.map(item => `<li>${escape(item)}</li>`).join('')}</ul></div>` : ''}
      ${editable ? `<div class="actions"><button type="button" class="button compact" data-action="edit-goal" data-id="${escape(goal.id)}">${icon('edit')}Изменить описание цели</button></div>` : ''}
      </div>
    </details>
  </article>`;
}

function selectedMapOverviewPeriod() {
  const period = mapOverviewPeriod || defaultPeriod();
  const periods = registerError ? [] : register?.periods ?? [];
  return periods.length && !periods.includes(period) ? periods[0] : period;
}

function mapOverviewMarkup() {
  const period = selectedMapOverviewPeriod();
  const overviewRegister = registerError ? null : register;
  const periods = overviewRegister?.periods?.length ? overviewRegister.periods : [period];
  return renderMapOverview({ goals: state.goals, directory: state.directory, period, periods, leaderId: leaderFilter,
    register: overviewRegister, dit: ditStatuses([period]) }, { escape, option, numberFormat, dateText });
}

function updateMapOverview() {
  const host = document.querySelector('#map-overview');
  if (!host) return;
  const methodOpen = host.querySelector('.map-overview-method')?.open;
  const focusedPeriod = document.activeElement?.id === 'map-overview-period';
  host.innerHTML = mapOverviewMarkup();
  if (methodOpen) host.querySelector('.map-overview-method').open = true;
  if (focusedPeriod) host.querySelector('#map-overview-period').focus({ preventScroll: true });
}

function selectOverviewLeader(id) {
  leaderFilter = id;
  goalQuery = categoryFilter = '';
  currentScopeId = id || 'dit';
  selectedPeriod = selectedMapOverviewPeriod();
  document.querySelector('#goal-search').value = '';
  document.querySelector('#category-filter').value = '';
  document.querySelector('#leader-filter').value = id;
  document.querySelector('.filter-menu').open = Boolean(id);
  renderGoalSelection();
  updateMapOverview();
  const title = document.querySelector('#list-title');
  title?.focus({ preventScroll: true });
  title?.scrollIntoView({ block: 'start' });
}

function renderMap(editable = false) {
  const goals = state.goals;
  const hasDraft = editable && goals.some(goal => records(goal, 'local').length);
  const publishAction = hasDraft ? `<button class="button" type="button" data-action="publish-open">${icon('send')}Отправить данные</button>` : '';
  const title = heading(editable ? 'Цели и статусы' : 'Карта целей', '', publishAction);
  if (!goals.length) return title + empty('Карта пока пуста', 'Загрузите HTML-карту в разделе «Настройка → Источники».', '<a href="#sources" class="button">Открыть источники</a>');
  const filtered = filteredGoals();
  selectCurrent(filtered);
  const categoriesInMap = [...new Set(goals.map(goal => goal.category).filter(Boolean))];
  const leaderOptions = clusterLeaders();
  const detail = goalDetail(goals.find(goal => goal.id === currentGoalId), editable);
  return `${title}
    ${editable ? '' : `<div id="map-overview">${mapOverviewMarkup()}</div>`}
    <div class="split">
      <section class="panel goal-directory" aria-labelledby="list-title">
        <div class="panel-inner"><h2 id="list-title" tabindex="-1">Цели</h2>
          <div class="directory-tools">
            <div class="search-box">${icon('search')}<input type="search" id="goal-search" aria-label="Поиск по целям" placeholder="Название, код или куратор" value="${escape(goalQuery)}"></div>
            <details class="filter-menu"${categoryFilter || leaderFilter ? ' open' : ''}>
              <summary>${icon('filter')}Фильтры${icon('chevron')}</summary>
              <div class="filters">
                <select id="category-filter" aria-label="Направление">${option('', 'Все направления', categoryFilter)}${categoriesInMap.map(category => option(category, categories[category] ?? category, categoryFilter)).join('')}</select>
                <select id="leader-filter" aria-label="ИТ-лидер">${option('', 'Все ИТ-лидеры', leaderFilter)}${leaderOptions.map(leader => option(leader.id, leader.name, leaderFilter)).join('')}</select>
              </div>
            </details>
          </div>
        </div>
        <div class="goal-list" id="goal-list">${goalList(filtered)}</div>
        <p class="list-caption" id="list-caption">Показано ${filtered.length} из ${goals.length}</p>
      </section>
      <div id="goal-detail">${detail}</div>
    </div>`;
}

function renderGoalSelection() {
  const list = document.querySelector('#goal-list');
  if (!list) return;
  const goals = filteredGoals();
  selectCurrent(goals);
  const scrollTop = list.scrollTop;
  const detail = goalDetail(goals.find(goal => goal.id === currentGoalId), navigate() === 'edit');
  list.innerHTML = goalList(goals);
  list.scrollTop = scrollTop;
  document.querySelector('#list-caption').textContent = `Показано ${goals.length} из ${state.goals.length}`;
  document.querySelector('#goal-detail').innerHTML = detail;
}

function dropzone(kind, title, description, accept) {
  return `<label class="dropzone" data-drop="${kind}"><strong>${title}</strong><span>${description}</span>
    <input type="file" aria-label="${title}" data-upload="${kind}" accept="${accept}"></label>`;
}

function fileSize(bytes) {
  return typeof bytes === 'number' ? `${numberFormat.format(Math.round(bytes / 1024))} КБ` : '';
}

function renderPreview() {
  if (!preview) return '';
  const source = state.sources.find(item => item.id === preview.id);
  if (!source) return '';
  const sheet = typeof preview.sheet === 'string' ? preview.sheet : preview.sheet?.name ?? '';
  const offset = Number(preview.offset) || 0;
  const rows = preview.rows ?? [];
  const total = Number(preview.total) || rows.length;
  return `<section class="panel panel-inner stack sheet-preview">
    <div class="headline"><div><h2>${escape(source.name)}</h2><p class="section-note small">Предпросмотр исходного файла</p></div><button type="button" class="button compact" data-action="preview-close">Закрыть</button></div>
    <label class="field scope-control"><span>Лист</span><select id="preview-sheet">${(source.sheets ?? []).map(item => option(item.name, item.name, sheet)).join('')}</select></label>
    <div class="table-wrap"><table aria-label="Предпросмотр листа ${escape(sheet)}"><tbody>
      ${rows.map((row, index) => `<tr><th scope="row">${offset + index + 1}</th>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    ${rows.length ? `<div class="toolbar"><span class="muted small">Строки ${offset + 1}–${offset + rows.length} из ${total}</span>
      <button type="button" class="button compact" data-action="preview-prev"${offset > 0 ? '' : ' disabled'}>Назад</button>
      <button type="button" class="button compact" data-action="preview-next"${offset + rows.length < total ? '' : ' disabled'}>Далее</button></div>` : '<p class="muted">На листе нет строк.</p>'}
  </section>`;
}

function renderSources() {
  const reconcileAction = state.sources.some(source => source.type === 'xlsx')
    ? '<a href="#reconcile" class="button">Перейти к сверке КР</a>' : '';
  return `${heading('Источники', 'Загружайте карту целей и рабочие таблицы. Оригиналы доступны для просмотра и скачивания.', reconcileAction)}
    <div class="stack">
      <div class="source-grid">
        ${dropzone('html', 'Загрузить HTML-карту', 'Выберите или перетащите карту целей', '.html,text/html')}
        ${dropzone('xlsx', 'Загрузить Excel', 'Выберите или перетащите таблицу .xlsx', '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}
      </div>
      <section class="panel panel-inner">
        <h2>Загруженные файлы</h2>
        ${state.sources.length ? state.sources.map(source => `<div class="file-row">
          <div><strong>${escape(source.name)}</strong><p class="muted small">${[source.type?.toUpperCase(), fileSize(source.size), dateText(source.uploadedAt)].filter(Boolean).map(escape).join(' · ')}</p></div>
          <div class="actions">
            ${source.sheets?.length ? `<button type="button" class="button compact" data-action="preview-open" data-id="${escape(source.id)}">Посмотреть</button>` : ''}
            <a class="button compact" href="/api/source/${encodeURIComponent(source.id)}/file" download>Скачать</a>
          </div>
        </div>`).join('') : '<p class="section-note">Файлы ещё не загружены.</p>'}
      </section>
      ${renderPreview()}
    </div>`;
}

function renderDirectory() {
  const selected = state.directory.find(item => item.id === directoryEditId);
  const types = [...new Set([...Object.keys(directoryTypes), ...state.directory.map(item => item.type)])].filter(type => type !== 'dit' || selected?.type === 'dit');
  const leaders = state.directory.filter(item => item.type === 'leader' && item.id !== selected?.id);
  return `${heading('Справочники', 'Названия команд и лидеров используются в карте целей и при сопоставлении строк из Excel.')}
    <div class="stack">
      <section class="panel panel-inner stack" id="directory-editor"><h2>${selected ? 'Изменить запись' : 'Добавить запись'}</h2>
        <form id="directory-form" class="form-grid" data-id="${escape(selected?.id)}">
          <label class="field"><span>Название или ФИО</span><input name="name" required maxlength="160" value="${escape(selected?.name)}"></label>
          <label class="field"><span>Тип</span><select name="type">${types.map(type => option(type, directoryTypes[type] ?? type, selected?.type ?? 'team')).join('')}</select></label>
          <label class="field"><span>ИТ-лидер</span><select name="leaderId">${option('', 'Без привязки', selected?.leaderId ?? '')}${leaders.map(leader => option(leader.id, leader.name, selected?.leaderId)).join('')}</select></label>
          <label class="field"><span>Другие названия, по одному в строке</span><textarea name="aliases" rows="2" placeholder="Например, сокращение из Excel">${escape((selected?.aliases ?? []).join('\n'))}</textarea></label>
          <div class="actions wide"><button type="submit" class="button primary">Сохранить запись</button>${selected ? '<button type="button" class="button" data-action="directory-cancel">Отмена</button>' : ''}</div>
        </form>
      </section>
      <section class="panel panel-inner stack"><div class="headline"><h2>Организационная структура</h2><span class="muted small">${state.directory.length} записей</span></div>
        <div class="table-wrap"><table><thead><tr><th scope="col">Название</th><th scope="col">Тип</th><th scope="col">ИТ-лидер</th><th scope="col">Действия</th></tr></thead><tbody>
          ${state.directory.map(item => `<tr><td>${escape(item.name)}</td><td>${escape(directoryTypes[item.type] ?? item.type)}</td><td>${item.leaderId ? escape(directoryName(item.leaderId)) : '—'}</td><td>${item.id === 'dit' ? '—' : `<button type="button" class="button compact" data-action="directory-edit" data-id="${escape(item.id)}">Изменить</button>`}</td></tr>`).join('')}
        </tbody></table></div>
      </section>
    </div>`;
}

function automationSheetOptions(source, selected) {
  return (source?.sheets ?? []).map(sheet => option(sheet.name, sheet.name, selected)).join('');
}

function renderAutomation() {
  const goals = state.goals;
  if (!goals.length) return heading('Автоматизация', 'У каждой цели может быть собственное правило расчёта.') + empty('Сначала загрузите карту', 'Вы сможете привязать источник и правило расчёта к любой цели из карты.', '<a href="#sources" class="button primary">Перейти к источникам</a>');
  if (!goals.some(goal => goal.id === automationGoalId)) automationGoalId = (goals.find(goal => goal.id === 'SW26.1') ?? goals[0]).id;
  const goal = goals.find(item => item.id === automationGoalId);
  const recipe = state.automations?.[goal.id];
  const sources = state.sources.filter(source => source.sheets?.length);
  const source = sources.find(item => item.id === recipe?.sourceId) ?? sources[0];
  const results = records(goal, 'automatic');
  return `${heading('Автоматизация', 'Настройте расчёт из Excel и проверьте значения по каждому участнику.')}
    <div class="stack">
      <section class="panel panel-inner stack">
        <div class="headline"><h2>Расчёт цели</h2>${recipe ? statusBadge('Правило сохранено', 'accent') : ''}</div>
        <label class="field scope-control"><span>Цель</span><select id="automation-goal">${goals.map(item => option(item.id, `${item.id} · ${item.title}`, goal.id)).join('')}</select></label>
        ${sources.length ? `<form id="automation-form" class="form-grid" data-goal="${escape(goal.id)}">
          <label class="field"><span>Файл-источник</span><select name="sourceId" id="automation-source" required>${sources.map(item => option(item.id, item.name, source?.id)).join('')}</select></label>
          <label class="field"><span>Лист</span><select name="sheet" id="automation-sheet" required>${automationSheetOptions(source, recipe?.sheet)}</select></label>
          <label class="field"><span>Строка перед данными</span><input name="headerRow" type="number" min="1" step="1" required value="${escape(recipe?.headerRow ?? 1)}"></label>
          <label class="field"><span>Последняя строка данных</span><input name="endRow" type="number" min="2" step="1" value="${escape(recipe?.endRow)}" placeholder="До конца листа"></label>
          <label class="field"><span>Столбец с участником</span><input name="scopeColumn" required pattern="[A-Za-z]{1,3}" maxlength="3" value="${escape(recipe?.scopeColumn ?? 'A')}" placeholder="Например, P"></label>
          <label class="field"><span>Столбец со значением</span><input name="valueColumn" required pattern="[A-Za-z]{1,3}" maxlength="3" value="${escape(recipe?.valueColumn ?? 'B')}" placeholder="Например, G"></label>
          <label class="field"><span>Как читать числа</span><select name="scale">${option('percent', 'Проценты (80 = 80%)', recipe?.scale ?? 'percent')}${option('fraction', 'Доли (0,8 = 80%)', recipe?.scale ?? 'percent')}</select></label>
          <label class="field"><span>Период</span><input name="period" required maxlength="60" value="${escape(recipe?.period ?? defaultPeriod())}"></label>
          <label class="field"><span>Дата факта</span><input name="asOf" type="date" required value="${escape((recipe?.asOf ?? today()).slice(0, 10))}"></label>
          <p class="form-caption wide">Введите буквы столбцов из Excel. Справочник помогает сопоставить имя в таблице с командой или лидером. Текстовое значение со знаком % всегда считается процентом.</p>
          <div class="actions wide"><button type="submit" class="button primary">Сохранить правило</button>${recipe ? `<button type="button" class="button" data-action="calculate" data-id="${escape(goal.id)}">Рассчитать по сохранённому правилу</button>` : ''}</div>
        </form>` : '<div class="stack"><p class="muted">Загрузите исходную таблицу Excel, чтобы настроить правило.</p><div class="actions"><a href="#sources" class="button">Загрузить Excel</a></div></div>'}
      </section>
      <section class="panel panel-inner stack">
        <div class="headline"><h2>Последний локальный расчёт</h2>${results.length ? `<button type="button" class="button" data-action="accept-calculation" data-id="${escape(goal.id)}">Принять в черновик</button>` : ''}</div>
        ${results.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Участник</th><th scope="col">Значение</th><th scope="col">Период</th><th scope="col">Дата факта</th></tr></thead><tbody>
          ${results.map(row => `<tr><td>${escape(directoryName(row.scopeId))}</td><td>${row.value == null ? '—' : `${numberFormat.format(row.value)}%`}</td><td>${escape(row.period)}</td><td>${escape(dateText(row.asOf))}</td></tr>`).join('')}
        </tbody></table></div><p class="form-caption">Принятый расчёт появится в черновиках карты целей. Для общей публикации используйте «Отправить данные».</p>` : '<p class="muted">Здесь появятся значения после расчёта.</p>'}
      </section>
      <section class="panel panel-inner stack"><h2>Подключение источника</h2>
        <ol class="automation-steps">
          <li><span class="step-bullet">1</span><div><strong>Получить файл</strong><p class="muted small">В этой версии доступна ручная загрузка Excel. Подключения ОКО и Навигатора пока не настроены.</p></div></li>
          <li><span class="step-bullet">2</span><div><strong>Сопоставить участников</strong><p class="muted small">Проверьте названия команд и лидеров в справочнике.</p></div></li>
          <li><span class="step-bullet">3</span><div><strong>Проверить расчёт</strong><p class="muted small">Сверьте результат со значениями источника и примите его в черновик.</p></div></li>
        </ol>
      </section>
    </div>`;
}

function renderHistory() {
  const shared = state.shared ?? {};
  const history = Array.isArray(shared.history) ? shared.history : [];
  return `${heading('История', 'Общие изменения, авторы и цели, которых коснулась публикация.',
    state.profile.remote ? '<button type="button" class="button" data-action="refresh">Проверить обновления</button>' : '')}
    <div class="stack"><section class="panel panel-inner stack"><h2>Общая версия</h2>
      <dl class="definition"><div><dt>Версия</dt><dd>${escape(shared.version ?? '—')}</dd></div><div><dt>Ревизия</dt><dd>${escape(shared.revision || '—')}</dd></div><div><dt>Проверено</dt><dd>${escape(dateText(shared.checkedAt))}</dd></div></dl>
      ${shared.error ? `<p class="inline-error" role="alert">${escape(shared.error)}</p>` : ''}
      ${!state.profile.remote ? '<p class="form-caption">Общий репозиторий можно указать в <a href="#settings">настройках</a>.</p>' : ''}
    </section>
    <section class="panel panel-inner"><h2>Публикации</h2>
      ${history.length ? [...history].reverse().map(item => `<div class="history-row">
        <div><strong>${item.version != null ? `Версия ${escape(item.version)}` : 'Обновление'}${item.author ? ` · ${escape(item.author)}` : ''}</strong>
        ${item.goalIds?.length ? `<p class="muted small">Цели — ${item.goalIds.map(escape).join(', ')}</p>` : ''}</div>
        <time class="muted small">${escape(dateText(item.at ?? item.publishedAt))}</time>
      </div>`).join('') : '<p class="section-note">Публикаций пока нет.</p>'}
    </section></div>`;
}

const statusHelpers = { escape, heading, empty, option, statusLabel, rowBadge, numberFormat, dateText, icon };

function ditStatuses(periods) {
  return projectDitGoalStatuses(state.goals, state.directory, registerError ? null : register, periods, state.ditStatuses ?? []);
}

function renderDitStatusSettings() {
  const manual = state.ditStatuses ?? [];
  const periods = [...new Set([selectedMapOverviewPeriod(), ...(register?.periods ?? []), ...manual.map(entry => entry.period)])];
  const period = periods.includes(ditSettingsPeriod) ? ditSettingsPeriod : periods[0];
  const pendingGoals = (state.ditDrafts ?? []).filter(entry => entry.period === period).map(entry => entry.goalId);
  return renderDitSettings({ dit: ditStatuses([period]), manual, period, periods, pendingCount: pendingGoals.length,
    pendingGoals, remote: state.profile.remote, manualRefresh: state.profile.gitAuth === 'prompt' }, statusHelpers);
}

function ditStatusChanges(form, includeSaved = false) {
  return [...form.querySelectorAll('[data-dit-goal]')]
    .filter(control => control.value !== control.dataset.initial || (includeSaved && control.hasAttribute('data-pending')))
    .map(control => ({ goalId: control.dataset.ditGoal, status: control.value, expectedRevision: control.dataset.revision || null }));
}

function goalStatusRegister(dit = false) {
  if (dit) {
    const source = registerError ? null : register;
    const periods = [...new Set([selectedMapOverviewPeriod(), ...(source?.periods ?? []),
      ...(state.ditStatuses ?? []).map(entry => entry.period)])];
    return { ...source, periods, entries: ditStatuses(periods) };
  }
  if (!register || registerError) return null;
  return { ...register, entries: projectGoalStatuses(state.goals, state.directory, register) };
}

function statusModel() {
  const projected = goalStatusRegister(krFilters.leader === '@dit');
  const period = krFilters.period || (projected?.periods.includes(selectedMapOverviewPeriod())
    ? selectedMapOverviewPeriod() : projected?.periods[0]);
  return { register: projected, loading: registerLoading, error: registerError, filters: { ...krFilters, period },
    goals: state.goals, leaders: clusterLeaders().map(item => item.name) };
}

function renderStatuses() {
  const snapshots = state.statusSnapshots ?? [];
  const sourcePicker = snapshots.length < 2 ? '' : `<label class="field scope-control snapshot-picker">
    <span>Книга со статусами</span><select id="kr-source-picker">
    ${option('', 'Последний датированный срез', resultSourceId)}
    ${snapshots.map(item => option(item.id, `${dateText(item.asOf)} · ${item.name}`, resultSourceId)).join('')}
    </select></label>`;
  return renderStatusPage({ ...statusModel(), sourcePicker }, statusHelpers);
}

function refreshStatusRows() {
  const results = document.querySelector('#kr-results');
  if (results) results.innerHTML = renderStatusRows(statusModel(), statusHelpers);
}

async function loadStatusRegister() {
  const token = ++registerRequest;
  registerLoading = state.sources.some(source => source.type === 'xlsx');
  registerError = '';
  if (navigate() === 'statuses') render();
  try {
    const query = resultSourceId ? '?' + new URLSearchParams({ source: resultSourceId }) : '';
    const next = registerLoading ? await request('/api/status-register' + query) : null;
    if (token !== registerRequest) return;
    register = next;
    if (krFilters.period && next && !next.periods.includes(krFilters.period)) krFilters.period = next.periods[0] ?? '';
  } catch (error) {
    if (token === registerRequest) {
      registerError = error.message;
      if (error.code === 'STATUS_SOURCE_CHOICE') register = null;
    }
  } finally {
    if (token === registerRequest) {
      registerLoading = false;
      if (['statuses', 'visualization', 'visualization-builder'].includes(navigate()) || (navigate() === 'dit-settings' && !unsavedForm)) render();
      else if (navigate() === 'map') {
        renderGoalSelection();
        updateMapOverview();
      }
    }
  }
}

function reconciliationModel() {
  const names = new Map(clusterLeaders().flatMap(leader => [leader.name, ...(leader.aliases ?? [])]
    .map(name => [normalize(name).replace(/\s+/gu, ' '), leader.name])));
  const source = reconcileRegister && { ...reconcileRegister, entries: reconcileRegister.entries.flatMap(row => {
    const leader = names.get(normalize(row.leader).replace(/\s+/gu, ' '));
    return leader ? [{ ...row, leader }] : [];
  }) };
  return {
    sources: state.sources.filter(source => source.type === 'xlsx'),
    register: source, sourceId: reconcileSourceId,
    loading: reconcileLoading, error: reconcileError, filters: reconcileFilters,
    goals: state.goals, directory: state.directory
  };
}

function refreshReconciliationRows() {
  const rows = document.querySelector('#reconcile-rows');
  if (rows) rows.innerHTML = renderReconciliationRows(reconciliationModel(), statusHelpers);
}

async function loadReconciliation() {
  const token = ++reconcileRequest;
  reconcileLoading = state.sources.some(source => source.type === 'xlsx');
  reconcileError = '';
  if (navigate() === 'reconcile') render();
  try {
    const id = reconcileSourceId || register?.source.id;
    const query = id ? '?' + new URLSearchParams({ source: id }) : '';
    const next = reconcileLoading ? await request('/api/status-register' + query) : null;
    if (token !== reconcileRequest) return;
    reconcileRegister = next;
    if (next && (reconcileFilters.period === null
      || (reconcileFilters.period && !next.periods.includes(reconcileFilters.period)))) reconcileFilters.period = next.periods[0] ?? '';
  } catch (error) {
    if (token === reconcileRequest) reconcileError = error.message;
  } finally {
    if (token === reconcileRequest) {
      reconcileLoading = false;
      if (navigate() === 'reconcile') render();
    }
  }
}

function weeklyModel() {
  return { ...weekly, ...curatorWeekly, week: curatorWeekly.week || weekMonday(today()), snapshots: state.statusSnapshots ?? [] };
}

function showWeekly() {
  if (navigate() !== 'weekly') return;
  const focusedId = document.activeElement?.id;
  render();
  if (focusedId?.startsWith('weekly-')) document.getElementById(focusedId)?.focus();
}

function weekMonday(value, offset = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return '';
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) return '';
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7 + offset * 7);
  return date.toISOString().slice(0, 10);
}

async function loadCuratorWeek(week = curatorWeekly.week || weekMonday(today())) {
  const token = ++curatorWeeklyRequest;
  Object.assign(curatorWeekly, { week, curatorWeek: null, curatorLoading: true, curatorError: '' });
  showWeekly();
  try {
    const report = await request('/api/curator-week?' + new URLSearchParams({ week }));
    if (token === curatorWeeklyRequest) Object.assign(curatorWeekly, { curatorWeek: report, reportWeeks: report.weeks });
  } catch (error) {
    if (token === curatorWeeklyRequest) curatorWeekly.curatorError = error.message;
  } finally {
    if (token === curatorWeeklyRequest) {
      curatorWeekly.curatorLoading = false;
      showWeekly();
    }
  }
}

async function loadWeekly() {
  const token = ++weeklyRequest;
  const snapshots = state.statusSnapshots ?? [];
  const latest = snapshots[0];
  const current = snapshots.find(item => item.id === weekly.currentId)
    ?? (latest?.asOf !== snapshots[1]?.asOf ? latest : null);
  weekly.currentId = current?.id ?? '';
  weekly.report = null;
  weekly.error = '';
  const earlier = current ? snapshots.filter(item => item.asOf < current.asOf) : [];
  if (weekly.previousId === null && current) {
    weekly.previousId = earlier[0]?.asOf !== earlier[1]?.asOf ? earlier[0].id : '';
  }
  const previous = earlier.find(item => item.id === weekly.previousId);
  weekly.previousId = previous?.id ?? (current ? '' : null);
  const periods = current?.periods.filter(period => !previous || previous.periods.includes(period)) ?? [];
  if (!periods.includes(weekly.period)) weekly.period = periods[0] ?? '';
  weekly.loading = Boolean(current && weekly.period);
  showWeekly();
  if (!weekly.loading) return;

  try {
    const query = new URLSearchParams({ current: current.id, previous: weekly.previousId, period: weekly.period, scope: 'map' });
    const report = await request('/api/status-week?' + query);
    if (token === weeklyRequest) weekly.report = report;
  } catch (error) {
    if (token === weeklyRequest) weekly.error = error.message;
  } finally {
    if (token === weeklyRequest) {
      weekly.loading = false;
      showWeekly();
    }
  }
}

function loadRouteData() {
  if (navigate() === 'reconcile') void loadReconciliation();
  if (navigate() === 'weekly') {
    void loadWeekly();
    void loadCuratorWeek();
  }
  if (isBrowserPage()) void loadBrowserState();
}

function defaultVisualizationCards(projected) {
  const period = projected?.periods.includes(selectedMapOverviewPeriod()) ? selectedMapOverviewPeriod() : projected?.periods[0];
  if (!period) return [];
  const rows = projected.entries.filter(entry => entry.period === period);
  const risk = rows.find(entry => entry.status === 'Под риском')?.status;
  const noMethod = rows.find(entry => normalize(entry.status).startsWith('нет методики'))?.status;
  return [
    { id: 'forecast', title: 'Статусы целей', kind: 'bar', group: 'status', period, status: '', leader: '' },
    ...(risk ? [{ id: 'risks', title: 'Цели под риском по ИТ-лидерам', kind: 'bar', group: 'leader', period, status: risk, leader: '' }] : []),
    ...(noMethod ? [{ id: 'methods', title: 'Цели без методики', kind: 'table', group: 'objective', period, status: noMethod, leader: '' }] : []),
    { id: 'leaders', title: 'Статусы целей по ИТ-лидерам', kind: 'stacked', group: 'leader', period, status: '', leader: '' }
  ];
}

function visualizationModel() {
  const projected = goalStatusRegister();
  const names = new Set(clusterLeaders().map(item => item.name));
  const cards = state.visualization?.cards?.map(card => ({ ...card,
    leader: names.has(card.leader) ? card.leader : '',
    status: /^(?:есть риски?|риски? принят[ы]?)$/u.test(normalize(card.status)) ? 'Под риском' : statusLabel(card.status)
  })) ?? defaultVisualizationCards(projected);
  return {
    cards,
    revision: state.visualization?.revision ?? null,
    register: projected, loading: registerLoading, error: registerError,
    dit: ditStatuses([selectedMapOverviewPeriod()]), ditPeriod: selectedMapOverviewPeriod()
  };
}

function isBrowserPage() {
  return ['connectors', 'browser-reports'].includes(navigate());
}

async function applyBrowserState(next) {
  const previous = browserState;
  browserState = { ...next, loading: false, error: '' };
  if (isBrowserPage() && JSON.stringify(browserState) !== JSON.stringify(previous)) render();
  const receivedFile = next.jobs.some(job => job.kind === 'collect' && job.state === 'success' && job.sourceId
    && !previous.jobs.some(before => before.id === job.id && before.state === 'success'));
  if (receivedFile) {
    try {
      const latest = await request('/api/state');
      state = { ...state, sources: latest.sources };
      if (navigate() === 'sources') render();
      void loadStatusRegister();
    } catch {
      showNotice('Выгрузка сохранена. Обновите страницу, чтобы увидеть файл в источниках.');
    }
  }
}

async function loadBrowserState() {
  if (browserChanging || browserChecking) return;
  browserChecking = true;
  const ticket = ++browserRequest;
  try {
    const next = await request('/api/browser');
    if (ticket === browserRequest) await applyBrowserState(next);
  } catch (error) {
    if (ticket === browserRequest && (browserState.loading || browserState.error !== error.message)) {
      browserState = { ...browserState, loading: false, error: error.message };
      if (isBrowserPage()) render();
    }
  } finally {
    browserChecking = false;
  }
}

async function browserAction(action, input, close = false) {
  if (browserChanging) return;
  browserChanging = true;
  ++browserRequest;
  try {
    const next = await post(`browser/${action}`, input);
    if (close && dialog.open) dialog.close();
    await applyBrowserState(next);
    if (action === 'save') showNotice('Подключение сохранено');
    if (action === 'record') showNotice('Запись началась. Нажимайте кнопки в окне отчёта.');
    if (action === 'record-stop') showNotice('Шаги записаны');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    browserChanging = false;
  }
}

function parseBrowserSteps(text) {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => {
    const match = /^(click|wait|fill)\s+(.+)$/.exec(line);
    if (!match) throw new Error(`Проверьте шаг ${index + 1}. Поддерживаются click, wait и fill.`);
    const [, type, command] = match;
    if (type !== 'fill') return { type, selector: command.trim() };
    const divider = command.indexOf('=>');
    if (divider < 1) throw new Error(`Укажите значение в шаге ${index + 1} после =>.`);
    return { type, selector: command.slice(0, divider).trim(), value: command.slice(divider + 2).trim() };
  });
}

function fillBrowserScenario(form, { actions, downloadSelector }) {
  form.elements.actions.value = actions.map(step => `${step.type} ${step.selector}`).join('\n');
  form.elements.downloadSelector.value = downloadSelector ?? '';
  form.elements.actions.closest('details').open = true;
  const feedback = form.querySelector('#browser-scenario-feedback');
  if (feedback) {
    feedback.textContent = 'Сценарий открыт. Проверьте шаги перед сохранением.';
    feedback.hidden = false;
  }
  form.elements.actions.focus();
  unsavedForm = true;
}

async function exportBrowserScenario(form, recording) {
  try {
    if (!form && !recording) return;
    const draft = recording ? { actions: recording.actions, downloadSelector: recording.downloadSelector } : {
      actions: parseBrowserSteps(form.elements.actions.value), downloadSelector: form.elements.downloadSelector.value.trim(),
    };
    const { text } = await post('browser/scenario', { draft });
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'rm-uor-browser-scenario.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showNotice(error.message, true);
  }
}

async function importBrowserScenario(input) {
  const file = input.files[0];
  if (!file) return;
  const form = input.form;
  input.value = '';
  try {
    if (file.size > 16 * 1024) throw new Error('Размер сценария должен быть не больше 16 КБ.');
    const scenario = await post('browser/scenario', { text: await file.text() });
    if (form.isConnected) fillBrowserScenario(form, scenario);
  } catch (error) {
    if (form.isConnected) showNotice(error.message, true);
  }
}

function showVisualizationEditor(id) {
  const model = visualizationModel();
  if (!id && model.cards.length >= 8) {
    showNotice('На экране можно разместить до восьми карточек.', true);
    return;
  }
  const editingCard = model.cards.find(card => card.id === id);
  if (id && !editingCard) return;
  showDialog(renderVisualizationEditor({ ...model, editingCard }, statusHelpers));
}

async function changeVisualizationOrder(id, direction) {
  const { cards, revision } = visualizationModel();
  const updated = [...cards];
  const index = updated.findIndex(card => card.id === id);
  if (index < 0) return;
  if (!direction) updated.splice(index, 1);
  else {
    const target = index + (direction === 'up' ? -1 : 1);
    if (target < 0 || target >= updated.length) return;
    [updated[index], updated[target]] = [updated[target], updated[index]];
  }
  await run(() => post('visualization', { cards: updated, expectedRevision: revision }), 'Компоновка сохранена');
}

function selectedTheme() {
  return themeLabels.has(state.profile.theme) ? state.profile.theme : 'indigo';
}

function renderSettings() {
  const profile = state.profile;
  const theme = selectedTheme();
  const refreshAction = profile.remote ? '<button type="button" class="button" data-action="refresh">Проверить обновления</button>' : '';
  return `${heading('Профиль и Git', 'Подпись автора, цветовая палитра и подключение к общим данным.', refreshAction)}
    <div class="stack">
      <section class="panel panel-inner">
        <fieldset class="theme-picker">
          <legend>Оформление</legend>
          ${[...themeLabels].map(([id, label]) => `<label class="theme-choice" data-theme="${id}">
            <input type="radio" name="theme" value="${id}"${id === theme ? ' checked' : ''}>
            <span class="theme-preview" aria-hidden="true"></span><span>${label}</span>
          </label>`).join('')}
        </fieldset>
      </section>
      <section class="panel panel-inner stack"><h2>Локальный профиль</h2>
        <form id="profile-form" class="form-grid">
          <label class="field"><span>Имя и фамилия</span><input name="name" required maxlength="120" autocomplete="name" value="${escape(profile.name)}"></label>
          <label class="field wide"><span>Адрес общего Git-репозитория</span><input name="remote" maxlength="500" value="${escape(profile.remote)}" placeholder="Адрес репозитория"></label>
          <label class="field"><span>Ветка</span><input name="branch" required maxlength="100" value="${escape(profile.branch || 'main')}"></label>
          <label class="field"><span>Проверять обновления каждые, мин</span><input name="refreshMinutes" type="number" min="1" max="1440" step="1" required value="${escape(profile.refreshMinutes ?? 30)}"></label>
          <label class="field"><span>Вход в Git</span><select name="gitAuth">${option('system', 'Настройки Git на компьютере', profile.gitAuth || 'system')}${option('prompt', 'Спрашивать логин и пароль', profile.gitAuth || 'system')}</select></label>
          <label class="field wide"><span>Путь к Git (необязательно)</span><input name="gitExecutable" maxlength="500" value="${escape(profile.gitExecutable)}" placeholder="C:\\Tools\\PortableGit\\cmd\\git.exe"></label>
          <p class="form-caption wide">Можно указать путь к git.exe из Portable Git. Если поле пустое, приложение ищет установленный Git. В режиме с логином и паролем обновление запускается кнопкой «Проверить обновления».</p>
          <div class="actions wide"><button type="submit" class="button primary">Сохранить настройки</button><button type="button" class="button" data-action="git-check">Проверить Git</button></div>
        </form>
      </section>
      <section class="panel panel-inner stack"><h2>Резервная копия</h2><div class="actions"><a class="button" href="/api/backup" download>Скачать данные</a></div></section>
    </div>`;
}

const pages = {
  map: renderMap,
  statuses: renderStatuses,
  reconcile: () => renderReconciliation(reconciliationModel(), statusHelpers),
  edit: () => renderMap(true),
  'dit-settings': renderDitStatusSettings,
  sources: renderSources,
  directory: renderDirectory,
  automation: renderAutomation,
  history: renderHistory,
  settings: renderSettings,
  weekly: () => renderWeekly(weeklyModel(), statusHelpers),
  visualization: () => renderVisualization(visualizationModel(), statusHelpers),
  'visualization-builder': () => renderVisualizationBuilder(visualizationModel(), statusHelpers),
  connectors: () => renderBrowserConnectors(browserState, statusHelpers),
  'browser-reports': () => renderBrowserReports(browserState, statusHelpers),
};

function render() {
  const page = navigate();
  updateShell(page);
  if (!state) return;
  const excelOpen = page === 'weekly' && document.getElementById('weekly-excel')?.open;
  document.documentElement.dataset.theme = selectedTheme();
  main.innerHTML = pages[page]();
  if (excelOpen) document.getElementById('weekly-excel').open = true;
  unsavedForm = false;
}

function showNotice(message, error = false) {
  clearTimeout(noticeTimer);
  if (error && dialog.open) {
    let issue = dialog.querySelector('[data-form-error]');
    if (!issue) {
      issue = document.createElement('p');
      issue.className = 'inline-error';
      issue.dataset.formError = '';
      issue.setAttribute('role', 'alert');
      dialog.querySelector('form')?.before(issue);
    }
    issue.textContent = message;
    return;
  }
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
  if (!error) noticeTimer = setTimeout(() => { notice.hidden = true; }, 4200);
}

function showDialog(content) {
  dialog.innerHTML = `<div class="dialog-inner">${content}</div>`;
  if (!dialog.open) dialog.showModal();
}

dialog.addEventListener('close', () => { if (!dialog.open) gitOperation = undefined; });

function onboarding() {
  const page = navigate();
  if (state.profile.name || onboardingShown || page !== 'edit') return;
  onboardingShown = true;
  showDialog(`<h2 id="dialog-title">Как подписывать изменения?</h2>
    <p class="muted">Имя будет указано в сохранённых статусах и публикациях.</p>
    <form id="onboarding-form" class="stack">
      <label class="field"><span>Имя и фамилия</span><input name="name" required maxlength="120" autocomplete="name" autofocus placeholder="Введите своё имя"></label>
      <div class="actions"><button type="button" class="button" data-action="dialog-close">Позже</button><button type="submit" class="button primary">Сохранить имя</button></div>
    </form>`);
}

function publishDialog(selectedIds) {
  const draftGoals = state.goals.filter(goal => records(goal, 'local').length);
  if (!draftGoals.length) return;
  showDialog(`<h2 id="dialog-title">Отправить данные</h2>
    <p class="muted">Выберите цели. Их локальные статусы войдут в одну общую публикацию.</p>
    ${!state.profile.remote ? '<p class="inline-error">Адрес общего репозитория ещё не указан. <a href="#settings" data-action="dialog-close">Открыть настройки</a></p>' : ''}
    <form id="publish-form" class="stack">
      <div class="publish-list">${draftGoals.map(goal => `<label class="check-row"><input type="checkbox" name="goalIds" value="${escape(goal.id)}"${(selectedIds ? selectedIds.includes(goal.id) : goal.id === currentGoalId || draftGoals.length === 1) ? ' checked' : ''}><span>${escape(goal.id)} · ${escape(goal.title)} <small class="muted">(${records(goal, 'local').length})</small></span></label>`).join('')}</div>
      <div class="actions"><button type="button" class="button" data-action="dialog-close">Отмена</button><button type="submit" class="button primary"${state.profile.remote ? '' : ' disabled'}>Предпросмотр</button></div>
    </form>`);
}

function previewStatus(row) {
  if (!row) return '<p class="muted small">Статус отсутствует.</p>';
  return `<p><strong>${row.value == null ? '—' : `${numberFormat.format(row.value)}%`}</strong> ${rowBadge(row)}</p>
    <p class="muted small">${[row.asOf && `на ${dateText(row.asOf)}`, row.author, row.mode === 'automatic' ? 'Расчёт' : 'Ручной ввод'].filter(Boolean).map(escape).join(' · ')}</p>
    ${row.plan ? `<p class="small">План — ${escape(row.plan)}</p>` : ''}
    ${row.comment ? `<p class="small">${escape(row.comment)}</p>` : ''}
    ${row.risk ? `<p class="small">Риск — ${escape(row.risk)}</p>` : ''}`;
}

function showPublicationReview(review) {
  showDialog(`<h2 id="dialog-title" tabindex="-1">Предпросмотр публикации</h2>
    <dl class="definition publish-destination">
      <div><dt>Репозиторий</dt><dd>${escape(review.remote)}</dd></div>
      <div><dt>Ветка</dt><dd>${escape(review.branch)}</dd></div>
      <div><dt>Автор</dt><dd>${escape(review.author)}</dd></div>
    </dl>
    <form id="publish-review-form" class="stack" data-token="${escape(review.token)}" data-dit-period="${escape(review.ditPeriod)}">
      <div class="publish-review-list">${review.goals.map(goal => `<section class="stack publish-review-goal">
        <input type="hidden" name="goalIds" value="${escape(goal.id)}">
        <h3>${escape(goal.id)} · ${escape(goal.title)}</h3>
        ${goal.changes.map(({ before, after }) => `<div class="publish-change">
          <p class="muted small">${escape(directoryName(after.scopeId))} · ${escape(after.period)}</p>
          <div class="comparison"><div class="reading"><h3>Опубликовано</h3>${previewStatus(before)}</div>
            <div class="reading published"><h3>Будет отправлено</h3>${previewStatus(after)}</div></div>
        </div>`).join('')}
      </section>`).join('')}${(review.ditChanges ?? []).map(change => `<section class="stack publish-review-goal">
        <h3>${escape(change.goalId)} · ${escape(change.title)}</h3>
        <p class="muted small">ДИТ · ${escape(change.period)}</p>
        <div class="comparison"><div class="reading"><h4>Опубликовано</h4><p>${escape(change.before?.status || 'По Excel / лидерам')}</p></div>
          <div class="reading published"><h4>Будет отправлено</h4><p>${escape(change.after?.status || 'По Excel / лидерам')}</p></div></div>
      </section>`).join('')}</div>
      <div class="actions"><button type="button" class="button" data-action="${review.ditPeriod ? 'dialog-close' : 'publish-back'}">${review.ditPeriod ? 'Отмена' : 'Назад к выбору'}</button><button type="submit" class="button primary">Опубликовать</button></div>
    </form>`);
  dialog.querySelector('#dialog-title')?.focus();
}

async function prepareGitPublication(input, credentials, credentialRemote) {
  let review;
  const ready = await run(async () => {
    let current = state;
    if (!credentials && (!state.shared.checkedAt || state.shared.error)) current = await post('refresh', {});
    review = await post('publishpreview', { ...input, credentials, credentialRemote });
    return current;
  });
  if (ready && dialog.open) {
    gitOperation = credentials ? { mode: 'confirm', credentials, credentialRemote } : undefined;
    showPublicationReview(review);
  }
}

async function beginGitOperation(mode, input) {
  if (busy || !state.profile.remote) return;
  if (state.profile.gitAuth === 'prompt') {
    gitOperation = { mode, input, remote: state.profile.remote };
    showDialog(renderGitAuth({ mode, remote: state.profile.remote }, statusHelpers));
  } else if (mode === 'refresh') {
    await run(() => post('refresh', {}), 'Общая версия проверена');
  } else {
    if (!dialog.open) showDialog('<h2 id="dialog-title">Подготовка публикации</h2><p class="muted">Проверяем изменения…</p><div class="actions"><button type="button" class="button" data-action="dialog-close">Закрыть</button></div>');
    await prepareGitPublication(input);
  }
}

function editGoalDialog(id) {
  const goal = state.goals.find(item => item.id === id);
  if (!goal) return;
  const curators = (goal.curators ?? []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
  showDialog(`<h2 id="dialog-title">Изменить описание цели</h2>
    <p class="muted">Правки будут видны в рабочей карте. Загруженный HTML останется в «Источниках».</p>
    <form id="edit-goal-form" class="stack" data-goal="${escape(goal.id)}">
      <label class="field"><span>Название</span><input name="title" required value="${escape(goal.title)}"></label>
      <label class="field"><span>Цель</span><textarea name="target" rows="2">${escape(goal.target)}</textarea></label>
      <label class="field"><span>Описание</span><textarea name="description" rows="3">${escape(goal.description)}</textarea></label>
      <label class="field"><span>Методика</span><textarea name="method" rows="2">${escape(goal.method)}</textarea></label>
      <label class="field"><span>Кураторы через запятую</span><input name="curators" value="${escape(curators.join(', '))}"></label>
      <div class="actions"><button type="button" class="button" data-action="dialog-close">Отмена</button><button type="submit" class="button primary">Сохранить описание</button></div>
    </form>`);
}

async function request(path, options) {
  const response = await fetch(path, options);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Запрос не выполнен (${response.status})`);
    error.code = result.code;
    throw error;
  }
  return result;
}

function post(path, data) {
  return request(`/api/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rmuor': '1' }, body: JSON.stringify(data),
  });
}

async function saveTheme(control) {
  const choices = [...control.closest('.theme-picker').querySelectorAll('input')];
  const wasFocused = document.activeElement === control;
  const syncTheme = () => {
    const theme = selectedTheme();
    document.documentElement.dataset.theme = theme;
    for (const choice of choices) choice.checked = choice.value === theme;
  };
  if (busy) {
    syncTheme();
    return;
  }
  busy = true;
  choices.forEach(choice => { choice.disabled = true; });
  document.documentElement.dataset.theme = control.value;
  try {
    state = await post('theme', { theme: control.value });
    showNotice('Тема сохранена');
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    syncTheme();
    choices.forEach(choice => { choice.disabled = false; });
    if (wasFocused && control.isConnected && document.activeElement === document.body) control.focus({ preventScroll: true });
    busy = false;
  }
}

async function syncConflictingState() {
  try {
    const next = await request('/api/state');
    const oldForm = document.querySelector('#status-form');
    const typedValues = oldForm ? new FormData(oldForm) : undefined;
    const formWasDirty = unsavedForm;
    const editorWasOpen = document.querySelector('#status-editor')?.open;
    const optionsWereOpen = document.querySelector('#status-options-details')?.open;
    state = next;
    render();
    const newForm = document.querySelector('#status-form');
    if (newForm && oldForm?.dataset.goal === newForm.dataset.goal) {
      document.querySelector('#status-editor').open = Boolean(editorWasOpen);
      document.querySelector('#status-options-details').open = Boolean(optionsWereOpen);
      for (const [name, value] of typedValues) newForm.elements.namedItem(name).value = value;
      unsavedForm = formWasDirty;
    }
    if (navigate() === 'reconcile') await loadReconciliation();
  } catch {
    // Keep the existing form and let the user retry if the local process is unreachable.
  }
}

async function run(action, successMessage, { close = false, silent = false } = {}) {
  if (busy) return false;
  busy = true;
  main.setAttribute('aria-busy', 'true');
  try {
    const next = await action();
    if (next) state = next;
    if (close && dialog.open) dialog.close();
    render();
    if (successMessage && !silent) showNotice(typeof successMessage === 'function' ? successMessage(next) : successMessage);
    return true;
  } catch (error) {
    if (error.code === 'CONFLICT' || error.code === 'STALE_VIEW') await syncConflictingState();
    if (!silent) showNotice(error.message || 'Операция не выполнена', true);
    return false;
  } finally {
    busy = false;
    main.removeAttribute('aria-busy');
  }
}

async function upload(file, kind) {
  if (!file) return;
  const accepted = kind === 'html' ? /\.html$/i : /\.xlsx$/i;
  if (!accepted.test(file.name)) {
    showNotice(kind === 'html' ? 'Выберите файл HTML-карты' : 'Выберите таблицу в формате .xlsx', true);
    return;
  }
  const saved = await run(() => request('/api/source', {
    method: 'POST', headers: { 'x-rmuor': '1', 'x-file-name': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' }, body: file,
  }), kind === 'html' ? 'Карта целей загружена' : 'Excel загружен');
  if (saved && kind === 'xlsx') {
    const item = [...state.sources].reverse().find(source => source.name === file.name && source.sheets?.length);
    if (item) await openPreview(item.id);
  }
  if (saved) void loadStatusRegister();
}

async function openPreview(id, sheet, offset = 0) {
  const source = state.sources.find(item => item.id === id);
  if (!source?.sheets?.length) return;
  const query = new URLSearchParams({ offset });
  if (sheet) query.set('sheet', sheet);
  await run(async () => {
    const result = await request(`/api/source/${encodeURIComponent(id)}/preview?${query}`);
    preview = { ...result, id };
  });
}

function setMenu(open) {
  sidebar.classList.toggle('open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
}

menuToggle.addEventListener('click', () => {
  const open = !sidebar.classList.contains('open');
  setMenu(open);
  if (open) (navigation.querySelector('.is-current summary') ?? navigation.querySelector('summary'))?.focus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !sidebar.classList.contains('open') || dialog.open) return;
  event.preventDefault();
  setMenu(false);
  menuToggle.focus();
});
sidebar.addEventListener('click', event => {
  if (event.target.closest('a[href^="#"]')) setMenu(false);
});
window.addEventListener('hashchange', () => {
  setMenu(false);
  render();
  if (state) {
    onboarding();
    loadRouteData();
  }
  window.scrollTo({ top: 0 });
});

document.addEventListener('click', async event => {
  if (sidebar.classList.contains('open') && !sidebar.contains(event.target) && !menuToggle.contains(event.target)) setMenu(false);
  const trigger = event.target.closest('[data-action]');
  if (!trigger || trigger.disabled || !state) return;
  const { action, id } = trigger.dataset;
  switch (action) {
    case 'map-leader': selectOverviewLeader(id); break;
    case 'select-goal':
      currentGoalId = id;
      currentScopeId = leaderFilter || 'dit';
      selectedPeriod = navigate() === 'map' ? selectedMapOverviewPeriod() : '';
      renderGoalSelection();
      if (window.matchMedia('(max-width: 655px)').matches) {
        document.querySelector('#goal-detail-title')?.focus({ preventScroll: true });
        document.querySelector('#goal-detail')?.scrollIntoView({ block: 'start' });
      } else {
        document.querySelector('.goal-button[aria-pressed="true"]')?.focus({ preventScroll: true });
      }
      break;
    case 'publish-open': publishDialog(); break;
    case 'publish-back':
      gitOperation = undefined;
      publishDialog([...dialog.querySelectorAll('input[name="goalIds"]')].map(input => input.value));
      break;
    case 'dit-publish': {
      const ditPeriod = trigger.dataset.period;
      const changes = ditStatusChanges(trigger.form);
      if (changes.length && !await run(() => post('dit-status', { period: ditPeriod, changes }))) break;
      if (navigate() === 'dit-settings') await beginGitOperation('dit-publish', { goalIds: [], ditPeriod });
      break;
    }
    case 'git-check': {
      try {
        const { version } = await post('gitcheck', { gitExecutable: trigger.form.elements.gitExecutable.value.trim() });
        showNotice(`Git доступен · ${version.replace(/^git version\s+/u, '')}`);
      } catch (error) { showNotice(error.message, true); }
      break;
    }
    case 'edit-goal': editGoalDialog(id); break;
    case 'viz-add': showVisualizationEditor(); break;
    case 'viz-edit': showVisualizationEditor(id); break;
    case 'viz-remove': await changeVisualizationOrder(id); break;
    case 'viz-move': await changeVisualizationOrder(id, trigger.dataset.direction); break;
    case 'viz-drill':
      mapOverviewPeriod = trigger.dataset.period;
      Object.assign(krFilters, {
        period: trigger.dataset.period, status: trigger.dataset.status, leader: trigger.dataset.leader,
        objective: trigger.dataset.goalId ? '' : trigger.dataset.objective ?? '', query: '', goalId: trigger.dataset.goalId ?? '', page: 0
      });
      location.hash = 'statuses';
      break;
    case 'dit-statuses':
      mapOverviewPeriod = trigger.dataset.period;
      Object.assign(krFilters, { period: mapOverviewPeriod, leader: '@dit', status: '', query: '', objective: '', goalId: '', page: 0 });
      location.hash = 'statuses';
      break;
    case 'goal-assignment-open':
      currentScopeId = trigger.dataset.scope;
      leaderFilter = currentScopeId === 'dit' ? '' : currentScopeId;
      currentGoalId = id;
      mapOverviewPeriod = selectedPeriod = trigger.dataset.period;
      goalQuery = categoryFilter = '';
      location.hash = 'map';
      break;
    case 'browser-add':
    case 'browser-edit': {
      const editing = browserState.connectors.find(item => item.id === id);
      if (action === 'browser-add' || editing) showDialog(renderBrowserEditor({ ...browserState, editing }, statusHelpers));
      break;
    }
    case 'browser-login':
    case 'browser-close':
    case 'browser-collect':
    case 'browser-read':
    case 'browser-record':
    case 'browser-record-stop':
      await browserAction(action.slice('browser-'.length), { id });
      break;
    case 'browser-scenario-apply': {
      const editing = browserState.connectors.find(item => item.id === id);
      const recording = browserState.recordings?.find(item => item.connectorId === id && !item.active);
      if (editing && recording) {
        showDialog(renderBrowserEditor({ ...browserState, editing }, statusHelpers));
        fillBrowserScenario(dialog.querySelector('#browser-form'), recording);
      }
      break;
    }
    case 'browser-scenario-export':
      await exportBrowserScenario(trigger.closest('form'), id
        ? browserState.recordings?.find(item => item.connectorId === id && !item.active) : undefined);
      break;
    case 'browser-reload': await loadBrowserState(); break;
    case 'kr-open': {
      const entry = register?.entries.find(row => row.id === id);
      if (entry) showDialog(renderStatusDetail(entry, { ...statusModel(), register }, statusHelpers));
      break;
    }
    case 'reconcile-open': {
      const entry = reconcileRegister?.entries.find(row => row.id === id);
      if (entry) showDialog(renderStatusLinkDialog(entry, reconciliationModel(), statusHelpers));
      break;
    }
    case 'weekly-week-prev':
    case 'weekly-week-next': {
      const week = weekMonday(weeklyModel().week, action === 'weekly-week-prev' ? -1 : 1);
      if (week) await loadCuratorWeek(week);
      break;
    }
    case 'weekly-row': {
      try {
        const book = await request('/api/status-register?' + new URLSearchParams({ source: trigger.dataset.source }));
        const entry = book?.entries.find(row => row.id === id);
        if (entry) showDialog(renderStatusDetail(entry, { ...statusModel(), register: book }, statusHelpers));
      } catch (error) {
        showNotice(error.message, true);
      }
      break;
    }
    case 'reconcile-page':
      reconcileFilters.page = Number(trigger.dataset.page);
      refreshReconciliationRows();
      document.querySelector('.reconcile-pagination button:not(:disabled)')?.focus();
      break;
    case 'kr-filter':
      krFilters.status = trigger.dataset.value;
      krFilters.page = 0;
      document.querySelector('#kr-status').value = krFilters.status;
      refreshStatusRows();
      document.querySelector('.kr-chip[aria-pressed="true"]')?.focus();
      break;
    case 'kr-page':
      krFilters.page = Number(trigger.dataset.page);
      refreshStatusRows();
      document.querySelector('.kr-pagination button:not(:disabled)')?.focus();
      break;
    case 'kr-clear-goal':
      krFilters.goalId = '';
      krFilters.objective = '';
      krFilters.page = 0;
      render();
      document.querySelector('#kr-search')?.focus();
      break;
    case 'kr-for-goal':
      Object.assign(krFilters, { goalId: id, period: selectedPeriod, status: '', leader: currentScopeId === 'dit' ? '@dit' : directoryName(currentScopeId), query: '', objective: '', page: 0 });
      location.hash = 'statuses';
      break;
    case 'kr-goal':
      if (dialog.open) dialog.close();
      currentGoalId = id;
      currentScopeId = trigger.dataset.scope || 'dit';
      selectedPeriod = trigger.dataset.period || '';
      if (selectedPeriod) mapOverviewPeriod = krFilters.period = selectedPeriod;
      goalQuery = categoryFilter = leaderFilter = '';
      if (trigger.dataset.source && register?.source.id !== trigger.dataset.source) {
        resultSourceId = trigger.dataset.source;
        void loadStatusRegister();
      }
      if (navigate() === 'map') render();
      else location.hash = 'map';
      break;
    case 'dialog-close': if (dialog.open) dialog.close(); break;
    case 'open-automation': automationGoalId = id; location.hash = 'automation'; break;
    case 'calculate': await run(() => post('calculate', { goalId: id }), 'Локальный расчёт готов'); break;
    case 'accept-calculation': await run(() => post('accept', { goalId: id, expectedRevision: state.shared.revision }), 'Расчёт сохранён в локальных черновиках'); break;
    case 'refresh': await beginGitOperation('refresh'); break;
    case 'preview-open': await openPreview(id); break;
    case 'preview-close': preview = undefined; render(); break;
    case 'preview-prev': await openPreview(preview.id, preview.sheet, Math.max(0, preview.offset - preview.rows.length)); break;
    case 'preview-next': await openPreview(preview.id, preview.sheet, Number(preview.offset) + preview.rows.length); break;
    case 'directory-edit':
      directoryEditId = id;
      render();
      document.querySelector('#directory-form input')?.focus();
      break;
    case 'directory-cancel': directoryEditId = ''; render(); break;
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'goal-search') {
    goalQuery = event.target.value;
    renderGoalSelection();
  }
  if (event.target.id === 'kr-search') {
    krFilters.query = event.target.value;
    krFilters.page = 0;
    refreshStatusRows();
  }
  if (event.target.id === 'reconcile-search') {
    reconcileFilters.query = event.target.value;
    reconcileFilters.page = 0;
    refreshReconciliationRows();
  }
  if (main.contains(event.target) && event.target.closest('form')) unsavedForm = true;
});

document.addEventListener('change', async event => {
  const control = event.target;
  if (control.matches('.theme-picker input[name="theme"]') && control.checked) {
    await saveTheme(control);
    return;
  }
  if (control.matches('#status-link-form select[name="goalId"]')) {
    const scope = control.form.elements.scopeId;
    const entry = reconcileRegister?.entries.find(row => row.id === control.form.dataset.entry);
    const selected = entry?.goalId === control.value ? entry.scopeId : '';
    scope.innerHTML = statusLinkScopeOptions(control.value, reconciliationModel(), statusHelpers, selected);
    return;
  }
  if (control.dataset.upload) {
    const file = control.files[0];
    control.value = '';
    await upload(file, control.dataset.upload);
    return;
  }
  switch (control.id) {
    case 'dit-settings-period':
      ditSettingsPeriod = control.value;
      render();
      document.querySelector('#dit-settings-period')?.focus();
      break;
    case 'browser-scenario-file': await importBrowserScenario(control); break;
    case 'category-filter': categoryFilter = control.value; renderGoalSelection(); break;
    case 'leader-filter':
      leaderFilter = control.value;
      currentScopeId = leaderFilter || 'dit';
      selectedPeriod = navigate() === 'map' ? selectedMapOverviewPeriod() : '';
      renderGoalSelection();
      updateMapOverview();
      break;
    case 'map-overview-period':
      mapOverviewPeriod = krFilters.period = control.value;
      selectedPeriod = control.value;
      renderGoalSelection();
      updateMapOverview();
      document.querySelector('#map-overview-period')?.focus({ preventScroll: true });
      break;
    case 'scope-picker': currentScopeId = control.value; renderGoalSelection(); document.querySelector('#scope-picker')?.focus({ preventScroll: true }); break;
    case 'period-picker':
      selectedPeriod = control.value;
      if (navigate() === 'map') mapOverviewPeriod = krFilters.period = selectedPeriod;
      renderGoalSelection();
      updateMapOverview();
      document.querySelector('#period-picker')?.focus({ preventScroll: true });
      break;
    case 'preview-sheet': await openPreview(preview.id, control.value); break;
    case 'kr-source-picker':
      resultSourceId = control.value;
      krFilters.page = 0;
      await loadStatusRegister();
      document.querySelector('#kr-source-picker')?.focus();
      break;
    case 'reconcile-source':
      reconcileSourceId = control.value;
      reconcileFilters.period = null;
      reconcileFilters.page = 0;
      await loadReconciliation();
      document.querySelector('#reconcile-source')?.focus();
      break;
    case 'reconcile-period':
    case 'reconcile-mode':
      reconcileFilters[control.id === 'reconcile-period' ? 'period' : 'mode'] = control.value;
      reconcileFilters.page = 0;
      refreshReconciliationRows();
      break;
    case 'weekly-saved-week':
      if (control.value) await loadCuratorWeek(control.value);
      else control.value = curatorWeekly.reportWeeks.includes(curatorWeekly.week) ? curatorWeekly.week : '';
      break;
    case 'weekly-week': {
      const week = weekMonday(control.value);
      if (week) await loadCuratorWeek(week);
      else control.value = weeklyModel().week;
      break;
    }
    case 'weekly-current':
      weekly.currentId = control.value;
      weekly.previousId = null;
      await loadWeekly();
      break;
    case 'weekly-previous':
    case 'weekly-period':
      weekly[control.id === 'weekly-previous' ? 'previousId' : 'period'] = control.value;
      await loadWeekly();
      break;
    case 'kr-period':
      mapOverviewPeriod = krFilters.period = control.value;
      krFilters.status = '';
      krFilters.page = 0;
      render();
      document.querySelector('#kr-period')?.focus();
      break;
    case 'kr-status':
    case 'kr-leader':
      krFilters[control.id === 'kr-status' ? 'status' : 'leader'] = control.value;
      krFilters.page = 0;
      if (control.id === 'kr-leader') {
        krFilters.status = '';
        render();
        document.querySelector('#kr-leader')?.focus();
      } else refreshStatusRows();
      break;
    case 'automation-goal': automationGoalId = control.value; render(); document.querySelector('#automation-goal')?.focus({ preventScroll: true }); break;
    case 'automation-source': {
      const source = state.sources.find(item => item.id === control.value);
      document.querySelector('#automation-sheet').innerHTML = automationSheetOptions(source);
      break;
    }
  }
  if (control.matches('[data-dit-goal]')) {
    const publish = control.form.querySelector('[data-action="dit-publish"]');
    publish.disabled = !state.profile.remote || !ditStatusChanges(control.form, true).length;
  }
});

for (const eventName of ['dragover', 'dragleave', 'drop']) {
  document.addEventListener(eventName, async event => {
    const zone = event.target.closest('[data-drop]');
    if (!zone) return;
    event.preventDefault();
    zone.classList.toggle('dragging', eventName === 'dragover');
    if (eventName === 'drop') await upload(event.dataTransfer.files[0], zone.dataset.drop);
  });
}

document.addEventListener('submit', async event => {
  const form = event.target;
  event.preventDefault();
  const fields = new FormData(form);
  const body = Object.fromEntries(fields);
  switch (form.id) {
    case 'dit-status-form': {
      const changes = ditStatusChanges(form, true);
      if (changes.length) await run(() => post('dit-status', { period: form.dataset.period, changes }), 'Статусы ДИТ сохранены');
      break;
    }
    case 'visualization-form': {
      const { cards } = visualizationModel();
      const id = form.dataset.id || crypto.randomUUID();
      const card = { ...body, id };
      const updated = form.dataset.id ? cards.map(item => item.id === id ? card : item) : [...cards, card];
      await run(() => post('visualization', { cards: updated, expectedRevision: form.dataset.revision || null }), 'Карточка сохранена', { close: true });
      break;
    }
    case 'browser-form': {
      let actions;
      try { actions = parseBrowserSteps(body.actions); }
      catch (error) { showNotice(error.message, true); break; }
      const allowedOrigins = body.allowedOrigins.split('\n').map(value => value.trim()).filter(Boolean);
      await browserAction('save', {
        ...(form.dataset.id ? { id: form.dataset.id, expectedRevision: Number(form.dataset.revision) } : {}),
        name: body.name, curator: body.curator, url: body.url, allowedOrigins, actions, executablePath: body.executablePath,
        downloadSelector: body.downloadSelector, readySelector: body.readySelector, reportSelector: body.reportSelector
      }, true);
      break;
    }
    case 'snapshot-date-form': {
      const saved = await run(() => post('snapshot', {
        sourceId: form.dataset.source, asOf: body.asOf, expectedRevision: form.dataset.revision || null
      }), 'Дата среза сохранена');
      if (saved) {
        reconcileSourceId = form.dataset.source;
        await loadReconciliation();
        void loadStatusRegister();
      }
      break;
    }
    case 'status-link-form': {
      const saved = await run(() => post('statuslink', {
        sourceId: form.dataset.source, entryId: form.dataset.entry, expectedRevision: form.dataset.revision || null,
        goalId: body.goalId === '__unlinked__' ? null : body.goalId, scopeId: body.scopeId || null
      }), 'Связь сохранена', { close: true });
      if (saved) {
        reconcileSourceId = form.dataset.source;
        await loadReconciliation();
        void loadStatusRegister();
      }
      break;
    }
    case 'status-form': {
      const period = body.period.trim();
      if (!period || !body.status.trim()) { showNotice('Укажите период и статус.', true); return; }
      await run(async () => {
        const next = await post('status', { ...body, goalId: form.dataset.goal, scopeId: currentScopeId, expectedRevision: state.shared.revision, period, value: body.value === '' ? null : Number(body.value) });
        selectedPeriod = period;
        return next;
      }, 'Статус сохранён в черновике');
      break;
    }
    case 'profile-form':
      await run(() => post('profile', { ...body, refreshMinutes: Number(body.refreshMinutes) }), 'Настройки сохранены');
      break;
    case 'onboarding-form':
      await run(() => post('profile', { ...state.profile, name: body.name }), 'Имя сохранено', { close: true });
      break;
    case 'edit-goal-form': {
      const curators = body.curators.split(',').map(name => name.trim()).filter(Boolean);
      await run(() => post('goal', { ...body, goalId: form.dataset.goal, curators }), 'Описание цели сохранено', { close: true });
      break;
    }
    case 'directory-form':
      if (await run(async () => {
        const aliases = body.aliases.split('\n').map(alias => alias.trim()).filter(Boolean);
        const next = await post('directory', { ...body, aliases, ...(form.dataset.id ? { id: form.dataset.id } : {}), leaderId: body.leaderId || undefined });
        directoryEditId = '';
        return next;
      }, 'Запись справочника сохранена')) void loadStatusRegister();
      break;
    case 'automation-form':
      await run(() => post('automation', { ...body, goalId: form.dataset.goal, scopeColumn: body.scopeColumn.toUpperCase(), valueColumn: body.valueColumn.toUpperCase(), headerRow: Number(body.headerRow), endRow: body.endRow ? Number(body.endRow) : undefined }), 'Правило расчёта сохранено');
      break;
    case 'publish-form': {
      const goalIds = fields.getAll('goalIds');
      if (!goalIds.length) { showNotice('Выберите хотя бы одну цель.', true); return; }
      await beginGitOperation('publish', { goalIds });
      break;
    }
    case 'git-auth-form': {
      const operation = gitOperation;
      if (!operation || operation.mode !== form.dataset.mode || busy) break;
      const credentials = { username: body.username, password: body.password };
      form.elements.password.value = '';
      if (operation.mode === 'refresh') {
        await run(() => post('refresh', { credentials, credentialRemote: operation.remote }), 'Общая версия проверена', { close: true });
      } else await prepareGitPublication(operation.input, credentials, operation.remote);
      break;
    }
    case 'publish-review-form': {
      const goalIds = fields.getAll('goalIds');
      const { credentials, credentialRemote } = gitOperation ?? {};
      const ditPeriod = form.dataset.ditPeriod || undefined;
      await run(() => post('publish', { goalIds, ditPeriod, credentials, credentialRemote, token: form.dataset.token }),
        'Выбранные статусы опубликованы', { close: true });
      break;
    }
  }
});

async function checkForReceivedUpdates() {
  if (!state?.profile?.remote || document.hidden || busy || dialog.open || unsavedForm) return;
  const previous = state;
  try {
    const next = await request('/api/state');
    if (state !== previous || busy || dialog.open || unsavedForm) return;
    const changed = next.shared.revision !== previous.shared.revision;
    const diagnostic = next.shared.checkedAt !== previous.shared.checkedAt || next.shared.error !== previous.shared.error;
    if (!changed && !diagnostic) return;
    state = next;
    if (changed || navigate() === 'history') render();
    else updateShell();
    if (changed && next.shared.version > previous.shared.version) {
      const publication = next.shared.history.find(item => item.version === next.shared.version);
      showNotice(`Обновлены общие данные · версия ${next.shared.version}${publication?.author ? ` · ${publication.author}` : ''}`);
    }
  } catch {
    // The last displayed data remains available while the local service reconnects.
  }
}

render();
try {
  state = await request('/api/state');
  render();
  onboarding();
  void loadStatusRegister();
  loadRouteData();
  setInterval(checkForReceivedUpdates, 15000);
  setInterval(() => {
    if ((!document.hidden && isBrowserPage()) || browserState.jobs.some(job => job.state === 'running')) void loadBrowserState();
  }, 1600);
} catch (error) {
  main.innerHTML = empty('Рабочее место недоступно', escape(error.message), '<a href="/" class="button">Попробовать ещё раз</a>');
}
