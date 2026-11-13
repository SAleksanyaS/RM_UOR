const statusOptions = [
  ['', 'По Excel / лидерам'],
  ['Выполнено', 'Выполнено'],
  ['Под риском', 'Под риском'],
  ['В плане', 'В плане'],
  ['Не выполнено', 'Не выполнено'],
  ['Нет методики', 'Нет методики'],
];

function valueText(value, { escape, numberFormat }) {
  if (value == null || value === '') return '—';
  return escape(typeof value === 'number' ? numberFormat.format(value) : value);
}

function goalRow(goal, manual, pending, helpers) {
  const { escape, option } = helpers;
  const initial = manual?.status ?? '';
  const title = goal.objective || goal.goalId;
  const status = goal.status || 'Нет статуса';
  const tone = status === 'Выполнено' ? ' success' : status === 'Под риском' ? ' warning' : '';
  return `<li class="dit-settings-row">
    <div class="dit-settings-goal">
      <div class="dit-settings-goal-title"><strong>${escape(title)}</strong><span class="muted small">${escape(goal.goalId)}</span></div>
      <div class="dit-settings-meta">
        <span>План <strong>${valueText(goal.plan, helpers)}</strong></span>
        <span>Факт <strong>${valueText(goal.fact, helpers)}</strong></span>
        <span class="badge${tone}">${escape(status)}</span>
        ${pending ? '<span class="muted small">Черновик</span>' : manual?.status ? '<span class="muted small">Опубликовано</span>' : ''}
      </div>
    </div>
    <label class="field dit-settings-field"><span>Статус ДИТ</span><select name="status" aria-label="Статус ДИТ для цели ${escape(title)}"
        data-dit-goal="${escape(goal.goalId)}" data-revision="${escape(manual?.revision)}" data-initial="${escape(initial)}"${pending ? ' data-pending' : ''}>
      ${statusOptions.map(([value, label]) => option(value, label, initial)).join('')}</select></label>
  </li>`;
}

export function renderDitSettings({ dit = [], manual = [], period, periods = [], pendingCount = 0, pendingGoals = [], remote = '', manualRefresh = false }, helpers) {
  const { escape, heading, option } = helpers;
  const available = [...new Set([...periods, period, ...dit.map(goal => goal.period)].filter(Boolean))];
  const selected = period || available[0] || '';
  const goals = [...new Map(dit.filter(goal => goal.period === selected).map(goal => [goal.goalId, goal])).values()];
  const values = new Map(manual.filter(entry => entry.period === selected).map(entry => [entry.goalId, entry]));
  const title = heading('Статусы ДИТ', 'Задайте статусы целей на уровне ДИТ за выбранный период.',
    remote && manualRefresh ? '<button type="button" class="button" data-action="refresh">Проверить обновления</button>' : '');
  const pending = Number.isSafeInteger(pendingCount) && pendingCount > 0 ? pendingCount : 0;
  const canPublish = pending > 0 && Boolean(remote);
  const publishNote = pending ? `Сохранено локально, ожидают публикации · ${pending}` : 'Изменений для публикации нет.';
  return `${title}<section class="panel panel-inner dit-settings stack" aria-label="Редактирование статусов ДИТ">
    <div class="dit-settings-toolbar">
      <div><h2>Цели ДИТ</h2><p class="muted small">Вариант «По Excel / лидерам» возвращает статус из данных.</p></div>
      <label class="field dit-settings-period"><span>Период</span><select id="dit-settings-period"${available.length ? '' : ' disabled'}>
        ${available.length ? available.map(value => option(value, value, selected)).join('') : option('', 'Нет периодов', '')}</select></label>
    </div>
    <form id="dit-status-form" class="dit-settings-form" data-period="${escape(selected)}">
      ${goals.length ? `<ul class="dit-settings-rows">${goals.map(goal => goalRow(goal, values.get(goal.goalId), pendingGoals.includes(goal.goalId), helpers)).join('')}</ul>` : '<p class="muted small">За выбранный период целей ДИТ нет.</p>'}
      <div class="dit-settings-save toolbar">
        <div class="muted small"><p>${publishNote}</p>${pending && !remote ? '<p>Укажите репозиторий в <a href="#settings">настройках Git</a>.</p>' : ''}</div>
        <button type="submit" class="button primary"${goals.length ? '' : ' disabled'}>Сохранить локально</button>
        <button type="button" class="button" data-action="dit-publish" data-period="${escape(selected)}"${canPublish ? '' : ' disabled'}>Отправить в Git</button>
      </div>
    </form>
  </section>`;
}
