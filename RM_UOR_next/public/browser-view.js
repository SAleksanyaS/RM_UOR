const actionsLabel = new Map([
  ['login', 'Открытие окна входа'], ['close', 'Закрытие окна'], ['collect', 'Получение XLSX'], ['read', 'Чтение отчёта'],
]);
const reportTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });

function reportLocation(value) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value;
  }
}

function flow() {
  return `<ol class="browser-flow" aria-label="Порядок подключения">
    <li><span class="browser-step" aria-hidden="true">1</span><div><strong>Укажите отчёт</strong><p>Сохраните адрес страницы с выгрузкой.</p></div></li>
    <li><span class="browser-step" aria-hidden="true">2</span><div><strong>Войдите на сайте</strong><p>Введите данные входа в браузере и дождитесь отчёта.</p></div></li>
    <li><span class="browser-step" aria-hidden="true">3</span><div><strong>Получите данные</strong><p>Книги сохраняются в «Источниках», прочитанные отчёты — в «Итогах».</p></div></li>
  </ol>`;
}

function jobMessage(job, { escape }) {
  if (!job) return '';
  const label = actionsLabel.get(job.kind) ?? 'Подключение';
  const message = job.message || (job.state === 'running' ? 'Выполняется…' : job.state === 'success' ? 'Готово' : 'Операция не завершилась');
  const tone = job.state === 'running' ? ' running' : job.state === 'error' ? ' error' : '';
  return `<div class="browser-job${tone}" role="${job.state === 'error' ? 'alert' : 'status'}"><strong>${escape(label)}</strong><p>${escape(message)}</p></div>`;
}

function lastOutput(job, { escape }) {
  if (!job) return '';
  const name = job.fileName || 'Книга XLSX';
  return `<div class="browser-output">
    <div><p class="muted small">Последняя выгрузка</p><strong>${escape(name)}</strong></div>
    <a class="button compact" href="#sources"${job.sourceId ? ` data-source="${escape(job.sourceId)}"` : ''}>Открыть источники</a>
  </div>`;
}

function reportsByTime(reports = []) {
  return [...reports].sort((left, right) => (Date.parse(right.collectedAt) || 0) - (Date.parse(left.collectedAt) || 0));
}

function reportTitle(report) {
  return report.title || report.name || 'Отчёт без названия';
}

function reportTimestamp(value, escape) {
  const date = new Date(value ?? '');
  return Number.isNaN(date.valueOf()) ? '<span>Время получения не указано</span>'
    : `<time datetime="${escape(date.toISOString())}">${escape(reportTime.format(date))}</time>`;
}

function lastReport(report, { escape }) {
  if (!report) return '';
  return `<div class="browser-output">
    <div><p class="muted small">Последний отчёт</p><strong>${escape(reportTitle(report))}</strong></div>
    <a class="button compact" href="#browser-reports">Открыть отчёты</a>
  </div>`;
}

function connectorCard(connector, model, helpers) {
  const { escape } = helpers;
  const id = escape(connector.id);
  const jobs = (model.jobs ?? []).filter(job => job.connectorId === connector.id);
  const running = jobs.findLast(job => job.state === 'running');
  const latest = running ?? jobs.at(-1);
  const output = jobs.findLast(job => job.kind === 'collect' && job.state === 'success' && (job.sourceId || job.fileName));
  const report = reportsByTime(model.reports?.filter(item => item.connectorId === connector.id))[0];
  const open = (model.openProfiles ?? []).includes(connector.id);
  const recording = (model.recordings ?? []).find(item => item.connectorId === connector.id);
  const recordingActive = Boolean(recording?.active);
  const recorded = !recordingActive && Boolean(recording?.actions?.length || recording?.downloadSelector);
  const collectingBlocked = running || recordingActive ? ' disabled' : '';
  const canRead = Boolean(connector.readySelector && connector.reportSelector);
  const scripted = Boolean(connector.downloadSelector || connector.actions?.length);
  return `<article class="panel panel-inner browser-card">
    <header class="browser-card-heading"><div><h2>${escape(connector.name)}</h2><p class="muted small browser-address">${escape(reportLocation(connector.url))}</p></div>
      ${open ? '<span class="badge success">Окно открыто</span>' : ''}</header>
    ${connector.curator ? `<p class="muted small">Куратор недельного отчёта · ${escape(connector.curator)}</p>` : ''}
    <p class="browser-mode muted small">${scripted ? 'Выгрузка по сценарию' : 'Ручная выгрузка'}</p>
    <div class="actions browser-actions">
      ${open || (running && running.kind !== 'close') ? `<button type="button" class="button" data-action="browser-close" data-id="${id}"${running?.kind === 'close' ? ' disabled' : ''}>${recordingActive ? 'Отменить и закрыть' : running && running.kind !== 'close' ? 'Остановить' : 'Закрыть окно'}</button>`
        : `<button type="button" class="button" data-action="browser-login" data-id="${id}"${running ? ' disabled' : ''}>Открыть окно входа</button>`}
      ${recordingActive ? `<button type="button" class="button primary" data-action="browser-record-stop" data-id="${id}">Остановить запись</button>`
        : open && !running ? `<button type="button" class="button" data-action="browser-record" data-id="${id}">Записать клики</button>` : ''}
      <button type="button" class="button${recordingActive ? '' : ' primary'}" data-action="browser-collect" data-id="${id}"${collectingBlocked}>Получить XLSX</button>
      ${canRead ? `<button type="button" class="button" data-action="browser-read" data-id="${id}"${collectingBlocked}>Прочитать отчёт</button>` : ''}
      ${recorded ? `<button type="button" class="button" data-action="browser-scenario-apply" data-id="${id}">Открыть записанные шаги</button>` : ''}
      ${recorded ? `<button type="button" class="button compact" data-action="browser-scenario-export" data-id="${id}">Скачать JSON</button>` : ''}
      <button type="button" class="button compact ghost" data-action="browser-edit" data-id="${id}"${running || open ? ' disabled' : ''}>Настроить</button>
    </div>
    ${recordingActive ? '<p class="form-caption" role="status">Нажимайте элементы отчёта в браузере. Затем остановите запись и проверьте шаги.</p>'
      : open && !running ? '<p class="form-caption">После входа в отчёт можно записать клики или запустить получение.</p>' : ''}
    ${running?.kind === 'collect' && !connector.downloadSelector ? '<p class="form-caption">Нажмите кнопку выгрузки в открытом окне браузера.</p>' : ''}
    ${recordingActive ? '' : jobMessage(latest, helpers)}${lastOutput(output, helpers)}${lastReport(report, helpers)}
  </article>`;
}

export function renderBrowserConnectors(model, helpers) {
  const { escape, heading, empty } = helpers;
  const connectors = model.connectors ?? [];
  const add = '<button type="button" class="button primary" data-action="browser-add">Добавить подключение</button>';
  const reload = '<button type="button" class="button" data-action="browser-reload">Обновить</button>';
  const title = heading('Браузерные подключения', 'Загружайте книги XLSX и читайте отчёты со страниц браузера.', connectors.length ? add + reload : '');
  const error = model.error ? `<div class="browser-error stack"><p class="inline-error" role="alert">${escape(model.error)}</p>${connectors.length ? '' : `<div class="actions">${reload}</div>`}</div>` : '';
  if (model.loading && !connectors.length) return `${title}<p class="muted loading" role="status">Загружаем подключения…</p>`;
  const content = connectors.length
    ? `<div class="browser-grid">${connectors.map(connector => connectorCard(connector, model, helpers)).join('')}</div>`
    : empty('Добавьте первый отчёт', 'Для ручной выгрузки достаточно названия и адреса страницы.', add);
  return `${title}<div class="browser-page stack">${error}${flow()}${content}</div>`;
}

function actionsText(actions) {
  return (actions ?? []).map(action => {
    if (action.type === 'fill') return `fill ${action.selector} => ${action.value ?? ''}`;
    return `${action.type} ${action.selector}`;
  }).join('\n');
}

export function renderBrowserEditor(model, { escape }) {
  const connector = model.editing ?? {};
  const origins = (connector.allowedOrigins ?? []).join('\n');
  const scenario = actionsText(connector.actions);
  const open = (model.openProfiles ?? []).includes(connector.id);
  return `<h2 id="dialog-title">${connector.id ? 'Настроить подключение' : 'Добавить подключение'}</h2>
    <form id="browser-form" class="form-grid browser-editor" data-id="${escape(connector.id)}" data-revision="${escape(connector.revision)}">
      <label class="field wide"><span>Название отчёта</span><input name="name" required maxlength="120" value="${escape(connector.name)}" placeholder="Например, модель зрелости"></label>
      <label class="field wide"><span>Адрес страницы отчёта</span><input name="url" type="url" required maxlength="1500" value="${escape(connector.url)}" placeholder="https://reports.example.com/report"></label>
      <label class="field wide"><span>Куратор для недельного отчёта (необязательно)</span><input name="curator" maxlength="120" value="${escape(connector.curator)}" aria-describedby="browser-curator-hint"></label>
      <p class="form-caption wide" id="browser-curator-hint">Для недельной сводки укажите куратора. В выбранном блоке отчёта должны быть даты периода, например 10.10.2026–17.10.2026, и разделы «Топ-3 достижения», «Топ-3 требует внимания», «Топ-3 плана» и «Топ-3 инсайта».</p>
      <label class="field wide"><span>Дополнительные адреса сайтов</span><textarea name="allowedOrigins" rows="2" placeholder="https://sso.example.com">${escape(origins)}</textarea></label>
      <p class="form-caption wide">Укажите по одному адресу сайта на строку, если вход или выгрузка открывают другой сайт. Вводите данные входа только в окне браузера.</p>
      <details class="browser-advanced wide"${scenario || connector.downloadSelector || connector.executablePath || connector.readySelector || connector.reportSelector ? ' open' : ''}>
        <summary>Браузер и сценарий отчёта</summary>
        <div class="stack">
          <label class="field"><span>Путь к браузеру</span><input name="executablePath" maxlength="500" value="${escape(connector.executablePath)}" placeholder="Оставьте пустым для выбора браузера"></label>
          <label class="field"><span>Шаги на странице</span><textarea name="actions" class="browser-code" rows="4" spellcheck="false" placeholder="click #filters&#10;wait #report&#10;fill #period =&gt; Q4 2026">${escape(scenario)}</textarea></label>
          <label class="field"><span>Селектор кнопки скачивания</span><input name="downloadSelector" class="browser-code" maxlength="500" spellcheck="false" value="${escape(connector.downloadSelector)}" placeholder="Например, #download-xlsx"></label>
          <p class="form-caption">Один шаг на строку. Для ручной выгрузки оставьте шаги и селектор пустыми.</p>
          <div class="browser-read-settings stack">
            <h3>Перенос сценария</h3>
            <label class="field"><span>Импортировать сценарий JSON</span><input id="browser-scenario-file" name="scenarioFile" type="file" accept=".json,application/json" aria-describedby="browser-scenario-hint"></label>
            <div class="actions"><button type="button" class="button compact" data-action="browser-scenario-export">Скачать сценарий JSON</button></div>
            <p class="form-caption" id="browser-scenario-hint">Файл переносит клики и ожидания. После импорта проверьте шаги перед сохранением. При запуске браузер выполнит их от вашего имени.</p>
            <p class="form-caption" id="browser-scenario-feedback" role="status" hidden></p>
          </div>
          <div class="browser-read-settings stack">
            <h3>Чтение видимого отчёта</h3>
            <label class="field"><span>Селектор готовности отчёта</span><input name="readySelector" class="browser-code" maxlength="500" spellcheck="false" value="${escape(connector.readySelector)}" placeholder="Например, #report-ready"></label>
            <label class="field"><span>Селектор блока отчёта</span><input name="reportSelector" class="browser-code" maxlength="500" spellcheck="false" value="${escape(connector.reportSelector)}" placeholder="Например, #report-results"></label>
            <p class="form-caption">Заполните оба поля, чтобы прочитать текст отдельного видимого блока после загрузки данных.</p>
          </div>
        </div>
      </details>
      ${open ? '<p class="form-caption wide">Закройте окно браузера перед сохранением подключения.</p>' : ''}
      <div class="actions wide"><button type="button" class="button" data-action="dialog-close">Отмена</button><button type="submit" class="button primary">Сохранить подключение</button></div>
      ${model.openProfiles?.includes(connector.id) ? '<p class="form-caption wide">Чтобы сохранить изменения подключения, сначала закройте окно источника.</p>' : ''}
    </form>`;
}

export function renderBrowserReports(model, { heading, empty, escape }) {
  const title = heading('Отчёты из браузера', 'Текст отчётов, полученный из настроенных блоков страниц.');
  const reports = reportsByTime(model.reports);
  const error = model.error ? `<p class="inline-error" role="alert">${escape(model.error)}</p>` : '';
  if (!reports.length) {
    if (model.loading) return `${title}<p class="muted loading" role="status">Загружаем отчёты…</p>`;
    return title + error + empty('Сохранённых отчётов пока нет', 'Откройте браузерные подключения в настройках и прочитайте отчёт.');
  }
  return `${title}<div class="browser-reports stack">${error}${reports.map(report => {
    const name = reportTitle(report);
    return `<details class="panel browser-report">
      <summary><span class="browser-report-label"><strong>${escape(name)}</strong><small class="muted">${report.name && report.name !== name ? `${escape(report.name)} · ` : ''}${reportTimestamp(report.collectedAt, escape)}</small></span></summary>
      ${typeof report.text === 'string' && report.text.trim() ? `<pre class="browser-report-text">${escape(report.text)}</pre>` : '<p class="browser-report-text muted">Текст отчёта отсутствует.</p>'}
    </details>`;
  }).join('')}</div>`;
}
