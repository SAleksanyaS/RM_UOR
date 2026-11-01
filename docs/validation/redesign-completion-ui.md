# Завершение переноса UI

База этапа: утверждённый визуальный эталон `32106a9`. Рабочая ветка: `codex/uor-redesign-reference`. Этот checkpoint — выполненный перенос интерфейса; итоговая интеграционная проверка публикации и браузерная проверка ещё выполняются отдельно.

## Граница изменений

Владелец UI перенёс список целей, работы и решения, общие данные, панель УОР, представление обслуживания и общую систему стилей. Дополнительно подключена защита несохранённого ввода в DashboardBuilder и CustomFieldEditor по поручению координатора. Backend публикации, личный ОКО, общий guard/provider и мастер цели изменяются другими владельцами. Обзор, карточка цели и навигация сохраняют утверждённую структуру; их цвета и вспомогательные подписи используют общие tokens.

Перенос использует действующие v1 read models, exact refs, capability checks, редакторы черновиков и квитанции. Демонстрационные объекты в рабочие данные не добавлены. Дополнительные библиотеки не подключены.

## Карта функций и переноса

| Функция | Текущий файл/экран | Изменено | Сохранено |
| --- | --- | --- | --- |
| Просмотр целей и отдельных назначений | overview/workbench/GoalsPage.tsx | Читаемая таблица, поиск и статус на текущей странице, серверная сортировка по названию/области/ответственному | Текущий/согласованный режим, paging, BasisInspector, подробное состояние и переход к цели |
| Работы и решения | execution/workbench/ExecutionPage.tsx | Таблица с ответственностью, раздельными планом/прогнозом, рисками и следующим действием; поиск среди загруженных объектов | Canonical URL, read-only карточка, create/edit, выбор вида и paging |
| Редактирование работы/ответа | WorkEditor.tsx, DecisionEditor.tsx, execution-ui.tsx | Поля сгруппированы; состояние и причины перехода отделены от полей работы; общий leave guard | Draft owner, CAS, точные command IDs, неизвестный ответ, серверная дата ответа, явное обновление конфликтного черновика |
| Зависимости | execution/workbench/DependencyView.tsx | Связанные работы и их области читаются отдельными блоками | Общая идентичность работы, влияние на цели, причина снятия, серверное изменение только через исходную команду |
| Общий источник и получение | sources/workbench/WorkbenchDataPage.tsx | Выделены общие данные, настройка и принятие наборов; даты получения показаны в МСК | File/ОКО/manual режимы, capability checks, настоящее задание, retry/cancel/native auth, последний сохранённый набор |
| Настройка источника | SourceSetupWizard.tsx, MappingEditor.tsx | Формы и технические ссылки упорядочены; source/mapping защищены одним leave guard | Собственный пакет, частичные черновики, точные refs, обязательные поля, metric hints и запросы с прежними ID |
| Принятие файла | sources/workbench/ImportPreview.tsx | Счётчики выбранных строк/исправлений, локальная прокрутка таблицы | Явный выбор, separate correction diff, повтор известного запроса, исходные даты, неполнота, принятые/непринятые строки |
| Объяснение факта | sources/workbench/LineagePanel.tsx | Читаемая цепочка факт → получение → точные строки → соответствие | Точные исторические refs/редакции, raw bytes/cells, отдельное обогащение, отсутствие подмены последним набором |
| Собственный пакет и сравнение | CuratorPanel.tsx, PackageDiff.tsx | Таблица объектов и готовности, явное чтение очереди, сравнение «исходная / main / предлагается», человеческие названия известных типов | Фильтр только просмотра, весь пакет при отправке, точный preview/expiry/conflict, пояснение влияния, unknown fallback |
| Ход публикации | publishing/workbench/PublishOperation.tsx | Отдельные сообщения о локальном коммите, передаче, PR и принятии; применение на ПК обозначено отдельно | Только подтверждённые этапы, actual retry/cancel/auth, безопасная ссылка PR, внешний финальный merge |
| Копии и обслуживание | workspace-maintenance/workbench/MaintenancePanel.tsx | Единые поверхности; восстановление выделено; недоступность объясняется | Предпросмотр, явное подтверждение, защитная копия, recovery lock, проверка/применение main, download, исходные handlers опасных действий |
| Общий дашборд и описательные поля | dashboards/workbench/DashboardBuilder.tsx, CustomFieldEditor.tsx | Leave guard для формы/родительского close, смены редактируемого поля и значения | Зарегистрированные типы, reorder, validation, поле не участвует в формуле, unknown/CAS протокол |
| Внешний вид всех рабочих экранов | workbench.css, production-ui.css и существующие feature CSS | Одна палитра surfaces/text/semantic states; light/dark/system, локальный table overflow, читаемые формы/диалоги | Родной select, видимый focus, бренд/навигация, без второй библиотеки компонентов |

Пути feature-файлов в таблице относятся к `src/features/`, общие стили — к `src/app/workbench/`.

Поиск и статус списка целей явно названы фильтрами текущей страницы: действующий `goals.list` принимает пустой `filter`. Серверная сортировка применяется ко всему списку до paging. Для поиска по всему рабочему месту сохранён общий поиск. Поиск исполнения обозначен как поиск в загруженных объектах и не меняет серверный kind/context.

Несохранённый ввод сравнивается с последним подтверждённым сохранением. `ExecutionEditorApi.perform` получил необязательный callback после успешного exact readback; запросы, CAS и обработка неизвестного результата не заменены. В SourceSetup после полного подтверждения шагов save одновременно снимается родительский dirty. Это устранило воспроизведённое окно «сохранение уже показано, close ещё предупреждает». Фоновый readback не подменяет локальный ввод.

## Стиль и темы

- Основные поля, содержание новых таблиц, ошибки и пояснения действий — 14 px. Подписи в production-ui/workbench/ОКО — не меньше 12 px.
- Светлая, тёмная и системная темы используют единый набор `--wb-*`: surface, subtle surface, text, muted, border, accent/on-accent, warning/danger/success/info. `color-scheme` согласован с темой для родных полей.
- Старые белые input/header/card правила в goal-setup, data, execution, dashboards, maintenance, browser и ОКО заменены токенами в самих feature CSS. Нового слоя `!important` нет; из ОКО удалены cosmetic `!important`. В общем CSS остаются прежние accessibility reset для hidden/screen-reader/reduced-motion.
- Широкие таблицы находятся в фокусируемых scroll regions. Нажатия Enter/Tab, подписи полей, aria-label существующих действий и рабочие клавиатурные сценарии сохранены.
- Фактические contrast/text scaling/layout на всех размерах ещё требует общего browser QA; статический перенос цветов сам по себе не доказывает полную доступность.

## Проверки и фактический результат

Runtime: закреплённый Node 22.16.0. Только owning files, максимум 2 workers; loopback разрешён для настоящего Fastify/SQLite harness. Полный suite этим владельцем не запускался.

| Проверка | Результат |
| --- | --- |
| goals-list-controls.test.tsx | 2/2 PASS: локальный фильтр, отсутствие ложного подтверждения, server sort/context/filter |
| execution-views.test.tsx | 31/31 PASS после исправлений; create/edit, CAS, unknown retry, date boundary, canonical routes, новый leave guard и поиск |
| data-views.test.tsx | 22/22 PASS: файл, correction, lineage/raw/enriched, partial mapping, новый SourceSetup leave guard |
| dashboard-ui.test.tsx | 16/16 PASS: зарегистрированные блоки, exact typed values, личный вид и серверные команды |
| editor-leave-guard.test.tsx | 2/2 PASS после RED: отмена close, подтверждённое save, независимые dirty поля/значения |
| maintenance-ui.test.tsx | 8/8 PASS: backup/restore/publication state/recovery и исходные ограничения |
| package-diff.test.tsx + publish-operation.test.tsx | 5/5 + 4/4 PASS; сравнение дополнительно проверяет proposed-only имена, точную редакцию ссылки и сохранность дополнительных полей объекта |
| curator-panel.test.tsx до обновления backend F01 | 18/18 PASS; чтение/preview/submit/auth/unknown/zone filters |
| Новый curator queue-loading regression | PASS: задержка чтения не показывается как пустая очередь |
| curator-panel после обновления F01 Git port и корректных synthetic providers | Свежий прогон Vitest4.1.12: 19/19 PASS; прежние6 submit/auth integration failures устранены владельцем Git fixture. Весь совместный прогон с package-diff — 24/24 PASS |
| Родительский goal-setup/recovery run | Координатор сообщил 27/27 PASS, включая numeric same-package mapping и закрытие источника после save |
| TypeScript и diff | Предыдущий полный typecheck PASS до параллельных F01/ОКО изменений. Следующий проход не нашёл ошибок в UI-файлах; в незавершённых файлах других владельцев были exports/Map/pending ошибки. Финальный общий typecheck остаётся интеграционным gate. `git diff --check` PASS; 12 CSS файлов разобраны PostCSS, все используемые --wb tokens определены |

Логи координатора в `completion/logs`: `ui-owning-tests.log`, `ui-guard-queue-green.log`, `ui-checkpoint-typecheck.log`, `wizard-recovery-green.log`. Первые неуспешные прогоны сохранены: типовая проверка заметила старые тесты, которые уходили из грязной формы без решения пользователя; они теперь явно принимают предупреждение. Сохранность при отказе проверяется отдельными новыми тестами.

Дополнение после обновления зависимостей: `ui-publishing-integration-green.log` — package-diff5 + curator19; `package-diff-reference-red.log` сохраняет воспроизведение потери дополнительного бизнес-поля у reference-like объекта. `PackageDiff` теперь разворачивает массивы и составные значения, названия берёт только из exact entries текущего пакета и только для proposed. Для before/main и неизвестных refs показывает «Название не включено в пакет»; точные идентификаторы/редакции остаются в раскрываемых подробностях. Современные имена не подменяют исторические.

Подготовлен `scripts/design-reference/completion-ui-flow.ts`: запускается только с явным `synthetic:true` и loopback URL, использует native Chrome с `chromiumSandbox:true`, общую runtime metadata и действующий production entrypoint. Собирает снимки шести размеров, dark/system, сравнения пакета, реальных dirty dialogs и обслуживания; не вызывает submit/restore/apply. Для содержательного preview один private nextAction сохраняется через настоящий редактор работы и production API. Numeric edge cases используют тот же сохранённый каталог. Эмуляция масштаба 200% отдельно обозначается как 683×384 CSS px с DPR2, не как проверка нативной команды масштабирования.

Первый live read-only проход: 9 проверок представления/данных PASS, 11 viewport и 11 full PNG в `completion/evidence/ui/readonly-*`; все содержательные состояния осмотрены. Значения «15 дней», «7 из 10», «0 инцидентов», «Нет данных» и «Не применимо» получены из действующего API и явно различаются. На 1366/320 нет горизонтального overflow страницы и видимого текста менее 12 px. Отдельный behavioral check RED: вход на общую вкладку Data смонтировал скрытый personal workspace, который при незавершённой записи другого прохода автоматически отправил два `oko.workflow.record.finish`. Передано владельцу ОКО с command IDs; это не объявляется read-only success. После первого снимка найдены и узко исправлены разрывы коротких кнопок и mobile lineage header; в mobile Goals сортировка/порядок размещены рядом. Driver дополнительно ждёт lineage всех строк и закрывает actual WelcomeToast перед основным снимком. Исправления ожидают финального живого подтверждения на стабильном стенде.

Checkpoint перед финальным source sync: повторные package-diff5 + curator19 — 24/24 PASS на Node22.16.0/Vitest4.1.12 (`ui-pre-capture-checkpoint.log`); отдельный strict TypeScript driver — exit0; `git diff --check` — exit0. По указанию координатора commit выполняется до final capture, чтобы общий suite и работающий runtime имели единый production HEAD. Pending: подтвердить последние CSS fixes, все шесть ширин, Work/Source dirty dialogs и focus, actual непустой preview без ошибок, Maintenance, light/dark/system и scale2; осмотреть final PNG. Этот checkpoint не заявляет эти ещё не исполненные проверки пройденными.

## Следующая общая браузерная проверка — рискованные состояния

1. Goals: две области одной цели, большой Decimal/длинное имя; фильтр/сортировка/paging; 320 px и 200% текста; таблица прокручивается локально.
2. Execution: длинный next action + риск/блокировка + решение в одной таблице; WorkEditor dirty close/Escape, failed readback, dependency resolution и возврат фокуса.
3. Общие данные: файл с принятыми/отклонёнными строками и correction; source dialog поверх goal wizard; raw/enriched/lineage; обязательные поля не исчезают при failed save.
4. УОР: неполный пакет, конфликт и устаревший preview; Git отправлен/PR auth pending; неизвестный ответ; длинные сравниваемые значения; отдельное принятие и применение main.
5. Maintenance: restore preview + подтверждение замены + recovery lock; все кнопки и длинные сообщения в диалоге при 320 px.
6. Темы: light/dark/system на Overview, GoalDetail, Data, редакторах цели/источника, УОР, общих дашбордах и обслуживании. Проверить focus/hover/disabled/alert цвета, отсутствие белых вложенных поверхностей.
7. Личный ОКО: initial/recording/manual-auth/failed/empty result в новых состояниях connector owner; новые `wb-operation-actions/progress/details` и `wb-recording-status` уже имеют общий стиль.

Новую копию runtime этот владелец не поднимал. Реальные снимки делаются после согласования общего fixture, без использования пользовательских данных.
