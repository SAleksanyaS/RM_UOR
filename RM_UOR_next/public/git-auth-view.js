const operations = new Map([
  ['publish', 'Публикация статусов'],
  ['dit-publish', 'Публикация статусов ДИТ'],
  ['push', 'Отправка в Git'],
  ['refresh', 'Обновление общих данных'],
  ['read', 'Получение общих данных'],
  ['fetch', 'Получение общих данных'],
]);

export function renderGitAuth({ mode, remote }, { escape }) {
  const operation = operations.get(mode) ?? 'Подключение к Git';
  return `<h2 id="dialog-title">Вход в Git</h2>
    <p><strong>${operation}</strong>${remote ? `<br><span class="muted small">${escape(remote)}</span>` : ''}</p>
    <p id="git-auth-note" class="muted small">Приложение использует данные входа для этой операции и не сохраняет их.</p>
    <form id="git-auth-form" class="form-grid" data-mode="${escape(mode)}" aria-describedby="git-auth-note" autocomplete="off">
      <label class="field wide"><span>Имя пользователя</span><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label class="field wide"><span>Пароль или токен</span><input name="password" type="password" autocomplete="current-password" required></label>
      <div class="actions wide"><button type="button" class="button" data-action="dialog-close">Отмена</button><button type="submit" class="button primary">Продолжить</button></div>
    </form>`;
}
