# Окно входа ОКО: почему «не держится» и что изменено

Дата: 2026-11-01. Основа: рабочая копия `RM_UOR-main` (личные выгрузки ОКО, `oko.workflow.*`). Проверка — на синтетических fixtures + диагностический прогон реального СберБраузера (`npm run probe:sberbrowser`). Пользовательские данные и общий каталог не изменялись.

## Симптом

«Открыть браузер для входа» открывает окно, которое сразу закрывается; результат — `Получение остановлено`, `Не удалось завершить получение`, `OPERATION_FAILED / Operation did not complete` без причины.

## Найденные причины

1. **Потеря причины запуска браузера.** `openBrowser` (`src/features/connectors/browser.ts`) выбрасывал исходную ошибку `launchPersistentContext` (sandbox, зависимости, занятый профиль, несовпадение протокола) и оставлял только общее сообщение — различить их было нельзя.
2. **Причина терялась в задании.** `runAccepted` (`src/server/workbench/command-registry.ts`) и повтор в `jobs.ts` превращали любое исключение, не являющееся `WorkbenchHttpError` (`AbortError`, `TimeoutError`, ошибки Playwright, `ZodError`), в `OPERATION_FAILED / Operation did not complete` без деталей и без записи в журнал.
3. **Массовое закрытие окна.** `loginFinish` вызывал `runtime.closeOwned(owner)` — закрывал **все** окна владельца, а не только окно входа. Достаточно было нажать «Завершить ручной вход» (или отменить другую операцию), чтобы потерять окно записи.
4. **Внешний таймаут короче ручного шага.** `createBrowserRecorderService.selectMarker` ограничивал выбор признака отчёта 120 секундами, хотя сам picker ждёт 15 минут. Вход через SSO дольше двух минут закрывал окно и давал `AbortError`.
5. **Ошибка навигации закрывала окно записи.** `startWorkbenchRecording` выбрасывал ошибку `page.goto(startUrl)` (в том числе `net::ERR_BLOCKED_BY_CLIENT` при переходе на SSO вне разрешённых origins), и окно закрывалось в `finally`.
6. **Окно открывалось на неверный адрес.** `loginOpen` без `reportUrl` открывал первое значение `allowedOrigins` (мог быть SSO-хост), и кнопка выбора признака отчёта была бесполезна.
7. **Нет текстов для новых кодов.** `PersonalOperationStatus` не объяснял `BROWSER_LAUNCH_FAILED`, `BROWSER_WINDOW_CLOSED`, `SOURCE_CANCELLED`.

## Изменения по файлам

| Файл | Что изменено |
| --- | --- |
| `src/features/connectors/workbench-browser-diagnostics.ts` (новый) | Только чтение окружения: исполняемый файл, соседний `chrome-sandbox` (режим, setuid root), unprivileged user namespaces, AppArmor, доступность профиля. `describeLaunchFailure` различает `SANDBOX_DENIED`, `EXECUTABLE_NOT_EXECUTABLE`, `MISSING_DEPENDENCY`, `PROFILE_LOCKED`, `PROFILE_DIR_NOT_WRITABLE`, `BROWSER_PROTOCOL_MISMATCH`, `BROWSER_LAUNCH_FAILED`. `safeErrorDetail` убирает из текста URL и пути; `launchHint` даёт русскую подсказку и ссылку на `npm run probe:sberbrowser`. |
| `src/features/connectors/workbench-browser-diagnostics.test.ts` (новый) | Проверки различения причин, отсутствия путей/URL в деталях, режимов файла. |
| `src/features/connectors/contracts.ts` | Код `browser_launch`; у `ConnectorError` — необязательные `reason` и `detail`. |
| `src/features/connectors/browser.ts` | При отказе запуска — диагностика и `ConnectorError('browser_launch', …, {reason, detail})`. Политика запуска не изменена. |
| `src/features/connectors/workbench-browser-commands.ts` | `browser_launch → BROWSER_LAUNCH_FAILED`, текст ошибки и `details` сохраняются вместо общего «Browser operation did not complete». |
| `src/features/connectors/workbench-browser-source.ts`, `workbench-browser-scenarios.ts` | `browser_launch → BROWSER_LAUNCH_FAILED` в таблицах кодов. |
| `src/server/workbench/problem-from-error.ts` | Единое преобразование исключения в `Problem`: `AbortError → SOURCE_CANCELLED`, `TimeoutError → SOURCE_TIMEOUT`, `ConnectorError → BROWSER_LAUNCH_FAILED/AUTH_REQUIRED/…` с `details: /cause`, «has been closed» → `BROWSER_WINDOW_CLOSED`, `net::ERR_BLOCKED_BY_CLIENT` → `BROWSER_URL_BLOCKED`, исчерпание лицензий Qlik → `BROWSER_SESSION_EXHAUSTED` (retryable), `net::ERR_CERT_*` → `SOURCE_CERTIFICATE_INVALID`, прочее → `OPERATION_FAILED` + запись в журнал без URL (полный стек только при `UOR_OKO_DEBUG_CAUSE=1`). |
| `src/server/workbench/problem-from-error.test.ts` (новый) | Причина не теряется, деталь безопасна, журнал не содержит URL. |
| `src/server/workbench/command-registry.ts`, `src/server/workbench/jobs.ts` | Обе точки отказа задания используют `problemFromError`. |
| `src/server/workbench/routes.ts` | HTTP-статусы для `BROWSER_LAUNCH_FAILED`, `BROWSER_WINDOW_CLOSED`, `BROWSER_URL_BLOCKED`, `REPORT_URL_REQUIRED`, `BROWSER_SESSION_EXHAUSTED` (429), `SOURCE_CERTIFICATE_INVALID` (422). |
| `src/features/connectors/workbench-workflow-service.ts` | `loginFinish` закрывает только своё окно входа (`runtime.cancelRecording` по handle); `loginOpen` без адреса отчёта → `REPORT_URL_REQUIRED`. |
| `src/features/connectors/workbench-browser-recorder.ts` | Выбор признака отчёта: внешний сигнал 15 минут вместо 120 секунд. Ошибка `page.goto` не закрывает окно записи: сохраняется как `problem` (адрес вне origins, таймаут, сеть) и снимается после успешного ручного действия в окне. |
| `src/features/connectors/workbench/PersonalOperationStatus.tsx`, `BrowserScenarioWizard.tsx` | Русские подсказки для новых кодов; в сообщении формы показывается стабильный код ошибки. |
| `src/features/connectors/browser-launch-policy.test.ts` | Ожидает `browser_launch`; по-прежнему проверяет `chromiumSandbox === true` и отсутствие `--no-sandbox`. |
| `scripts/probes/sberbrowser-diagnose.ts` (новый), `package.json` | `npm run probe:sberbrowser` — отчёт окружения и реальный запуск с теми же опциями, что в приложении; временный профиль в `os.tmpdir()`, рабочий профиль не затрагивается. Флаги: `--executable`, `--channel`, `--headed`, `--keep-open-ms`, `--url`. Коды выхода: 0 — запуск успешен, 2 — причина отказа, 1 — аргументы/файл. |

## Как проверить

```bash
cd "/home/work/22229627@sigma.sbrf.ru/RM_UOR-main (2)/RM_UOR-main"
npx tsc --noEmit
npm run probe:sberbrowser -- --executable /opt/Sberbrowser/sberbrowser/sberbrowser
npm run probe:sberbrowser -- --executable /opt/Sberbrowser/sberbrowser/sberbrowser --headed --keep-open-ms 15000
npm test -- src/features/connectors src/server/workbench
npm run dev   # Данные → Личные выгрузки ОКО → «Открыть браузер для входа»
```

Фактический результат прогона на рабочей копии (2026-11-01): `probe:sberbrowser` в headless, headed и с `--url <адрес отчёта ОКО>` — `ok: true`, версия `152.0.7977.120`, навигация отвечает `200`. Движок браузера стартует и окно держится. Тесты, требующие установленного Edge (`testBrowserSelection()` → `channel: 'msedge'`), в этой среде не запускаются без `UOR_TEST_BROWSER_EXECUTABLE`. Чтобы прогнать их через СберБраузер: `UOR_TEST_BROWSER_EXECUTABLE=/opt/Sberbrowser/sberbrowser/sberbrowser npx vitest run src/features/connectors`.

## `ERR_BLOCKED_BY_CLIENT`: блокировал не СберБраузер, а сам перехват приложения

Страница ОКО грузит **семь** разных хостов. Замер по реальному листу:

```
https://oko-qs.sigma.sbrf.ru        — сам отчёт
https://idp02.auth.sigma.sbrf.ru    — вход (ADFS/SSO)
https://alt.idp02.auth.sigma.sbrf.ru
https://swwidgetui.sberbank.ru      — виджеты входа
https://swwidgetapi.sberbank.ru
https://swwidget-listener.sberbank.ru
https://visor.sberbank.ru
```

В личном профиле был только `https://oko-qs.sigma.sbrf.ru`, а `context.route('**/*')` и перехват редиректов резали всё остальное и отвечали `BlockedByClient`. Отсюда страница «Сайт заблокирован… ERR_BLOCKED_BY_CLIENT» — она появлялась внутри нашего же окна, до всякого входа.

Изменения:

| Файл | Изменение |
| --- | --- |
| `src/features/connectors/transport.ts` | `loginUrlAllowed`: в окне ручного входа разрешены отчётные origins **и** корпоративные хосты входа `*.sigma.sbrf.ru` / `*.sberbank.ru` по HTTPS без учётных данных в URL. |
| `src/features/connectors/browser.ts` | `route` и перехват редиректов используют `loginUrlAllowed`; выход на страницу входа по редиректу больше не блокируется. |
| `src/features/connectors/login-origins.test.ts` (новый) | Разрешены отчёт, SSO и виджеты; запрещены чужие хосты, подделка домена, `http://` и учётные данные в URL. |

Что осталось строгим: **выгрузка** и **записанные шаги** по-прежнему требуют точного совпадения с `allowedOrigins` (`checkedUrl`), Service Workers заблокированы, TLS-проверка не ослаблена.

Фактическая проверка через настоящий пайплайн приложения (`openBrowser` → `page.goto` вашего адреса): `title = Qlik Sense`, содержимое отчёта загружается, `ERR_BLOCKED_BY_CLIENT` больше нет. Окно входа: `OPENED in 4917 ms`, живо через 10 секунд.

## Окно входа «открывается и сразу закрывается» — залипшая блокировка профиля

Причина найдена прямым воспроизведением `oko.workflow.login.open` на рабочей копии: в профиле `model_zrelosti` оставались `SingletonLock` / `SingletonSocket` / `SingletonCookie` от **убитого** процесса (`SingletonLock -> <host>-186143`, процесса с таким PID в системе нет). Chromium видит блокировку, считает профиль занятым и выходит сразу после старта — снаружи это выглядит как окно, которое открылось и захлопнулось, а в интерфейсе остаётся невнятное `Действие требует проверки`.

Откуда мусор: предыдущие окна закрывались аварийно (перезапуск `tsx watch`, `Ctrl+C`, таймауты), и Chromium не успевал убрать свои lock-файлы.

Что изменено:

| Файл | Изменение |
| --- | --- |
| `src/features/connectors/workbench-browser-profile-locks.ts` (новый) | `releaseStaleProfileLocks` удаляет `Singleton*` только если процесс-владелец мёртв (`kill(pid, 0)`); `profileLockedByLiveProcess` сообщает PID живого держателя; `pruneOrphanBrowserSockets` убирает брошенные `/tmp/org.chromium.Chromium.*` старше суток. |
| `src/features/connectors/workbench-browser-profile-locks.test.ts` (новый) | Залипший lock мёртвого PID удаляется; lock живого процесса не трогается. |
| `src/features/connectors/browser.ts` | Очистка залипших блокировок перед `launchPersistentContext`; ошибка первого перехода в окне входа больше не закрывает окно — в нём показывается объяснение и текст причины. |

Фактическая проверка: `openLogin` с реальным профилем и `headless: false` — `OPENED open`, окно живо через 8 секунд; первый переход к адресу ОКО отвечает `200`.

Если окно всё равно закрывается — запустите `npm run dev` заново (старый процесс держит прежний код) и посмотрите `npm run logs`.

## Диагноз. Ошибка была на стороне сервера отчёта, не сертификата

Проверка 2026-11-01 прямым запуском СберБраузера (152.0.7977.120, `chromiumSandbox: true`) на ваш адрес ОКО:

- навигация `page.goto` → **HTTP 200**, финальный адрес — тот же лист, `title = Qlik Sense`;
- на экране модальное окно самого Qlik: `Произошла ошибка — Доступ к Qlik Sense невозможен из-за большого количества активных сеансов.` с кнопкой `Обновить`;
- результат не зависит от `ignoreHTTPSErrors`: с `false` и с `true` — одинаковый `200`. Значит TLS-сертификат и корпоративный прокси здесь не причина.
- Для сравнения: `fetch` из Node падает на `SELF_SIGNED_CERT_IN_CHAIN` (прокси банка), но это касается только самого Node. Браузеру он не мешает, и в приложении проверка сертификатов остаётся строгой (`ignoreHTTPSErrors: false`).

Причина — лимит лицензий Qlik Sense (нет свободных engine-сеансов). Обычно он возникает, когда долго живёт окно прошлой записи: каждое окно держит сеанс. Окно записи в приложении живёт до 15 минут и больше не закрывается при неудачной навигации, поэтому сеансы могли накапливаться.

Что делать по шагам:

1. Закрыть все окна и вкладки Qlik Sense (включая оставленные окна СберБраузера из прошлых попыток) или нажать `Обновить` в окне ошибки.
2. Подождать несколько минут, пока истекут серверные сеансы.
3. В приложении: `Данные → Личные выгрузки ОКО → «Открыть браузер для входа»`; если окно уже открыто — работать в нём, не открывая новых.
4. Если ошибка повторяется сразу после первого окна — это уже администраторы Qlik (лицензия исчерпана глобально), а не приложение.

## Как запускать и где смотреть логи

Логи пишутся автоматически при любом штатном запуске — ничего дополнительно настраивать не нужно.

| Команда | Что запускает | Куда пишется лог |
| --- | --- | --- |
| `npm run dev` | основное рабочее место: API `127.0.0.1:4174` + интерфейс `127.0.0.1:5173` | `.runtime/logs/<дата>-dev.log` |
| `npm run dev:oko` | отдельный ОКО (API + Vite) | `.runtime/logs/<дата>-oko.log` |
| `npm run start:oko` | собранный ОКО (`npm run build` заранее) | `.runtime/logs/<дата>-oko-serve.log` |
| `npm run dev:server` | только API (`tsx watch`) | `.runtime/logs/<дата>-api.log` |

В одном файле лежат все процессы с префиксами: `[api]` — служба, `[client]` — Vite, `[oko-api]`/`[oko-ui]` — ОКО. Строки `[stderr]` — предупреждения и ошибки. В начале файла — версия Node, папка запуска и время, в конце — сигнал остановки и коды выхода дочерних процессов. Это те же логи, что нужны при разборе любого сбоя входа/записи (там же будет `BROWSER_LAUNCH_FAILED`, `BROWSER_WINDOW_CLOSED` и причина из `problemFromError`).

Просмотр:

```bash
npm run logs                                  # последние 200 строк самого свежего запуска
npm run logs -- --follow                      # следить в реальном времени
UOR_LOG_LINES=1000 npm run logs               # больше строк
UOR_OKO_DEBUG_CAUSE=1 npm run dev             # плюс стек непредвиденной ошибки в лог
```

Правила хранения: каталог `.runtime/logs` (уже в `.gitignore` вместе с `*.log`, поэтому в репозиторий и в выгрузку не попадает), файл ротируется при 20 МБ, хранятся последние 20 файлов. Содержимое не заменяет сообщения на экране и не содержит паролей: причина ошибки браузера проходит через `safeErrorDetail` (URL и пути вырезаются).

Запуск из Windows-лаунчера (`START_RM_UOR.cmd`) вызывает тот же `npm run dev`, поэтому логи ведутся и там — файл `.runtime\logs\…-dev.log`.

## Известное состояние тестов в этой среде

Нативные браузерные сценарии (`tests/workbench-browser-ui.test.ts`, `…-wizard-recovery`, `…-record-replay`, `…-source-security`, `probe-oko-browser`) в этой среде падают не из-за изменений окна входа, а из-за синтетического стенда:

1. `tests/fixtures/workbench/browser-report.ts` отдаёт разметку с `<label for="period">Период</label>` и `<input id="period">`, но без связи `label → control`, поэтому `getByLabel('Период')` не находит поле (проверено: `byLabel=0`, `byId=0`).
2. После навигации на `/report` фикстура возвращает страницу входа (`Локальный тестовый вход`), хотя `[data-testid="report-ready"]` уже появился.
3. Часть сценариев требует установленного Edge/Chrome (`NATIVE_BROWSER_NOT_READY`) и без `UOR_TEST_BROWSER_EXECUTABLE` не стартует.

Поэтому эти пять сьютов считаются «красными по стенду». Модульные проверки самой правки зелёные: `workbench-browser-diagnostics`, `problem-from-error`, `browser-launch-policy`, `workbench-workflow-service` и `browser-runtime` (64 теста в 6 файлах).

## Что НЕ изменено

- `chromiumSandbox: true` для любого launcher, `--no-sandbox` не добавляется, повторов с ослабленной защитой нет.
- `serviceWorkers: 'block'`, `ignoreHTTPSErrors: false`, точный allow-list origins, ограничения размера выгрузки и запрет полей с паролями/кодами.
- Общая identity policy, общий каталог и pipeline публикации.

## Остаточные границы

- Если в журнале после `npm run dev` остаётся `BROWSER_WINDOW_CLOSED`, окна закрыл перезапуск сервера (`tsx watch`) — во время ручного входа в SSO не перезапускайте сервер.
- `appArmorChromium` может отображаться как `unknown`, если ядро не публикует политику; `SANDBOX_DENIED` тогда определяется по тексту отказа запуска.
- Вход в SSO, сертификат и сам отчёт проверяются только в вашей среде: предпросмотр остаётся локальным, факты и общий источник не создаются.
