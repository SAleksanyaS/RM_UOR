# РМ УОР: завершение редизайна и исправлений

> **For agentic workers:** Use executing-plans and dispatching-parallel-agents for the three independent ownership domains below. No per-button approval or repeated full audit. Checkboxes record verified work.

**Goal:** Выполнить этапы3-6 спецификации после утверждения владельцем визуального эталона.

**Architecture:** Штатные React/Workbench HTTP/SQLite/Git сохраняются. Один общий Git, личные данные и сертификаты на ПК, внешний финальный merge. Дорабатываются существующие feature slices, команды, read models и визуальная система.

**Tech Stack:** TypeScript/React19/Fastify/SQLite/Playwright; проверка Node22.16.0/npm10.9.2.

**Spec:** `../specs/2026-11-01-product-redesign.txt`.

## Авторизация и исходная точка

- Владелец ответил «делай все» после показа трёх экранов и единственного вопроса о визуальном направлении. Это согласование эталона и разрешение этапов3-6 без дополнительных промежуточных согласований.
- Исходный ac299a5; утверждённый reference checkpoint32106a9. Работа продолжается в существующем отдельном worktree codex/uor-redesign-reference.
- Старый журнал reference остаётся свидетельством прошлого этапа. Текущие результаты находятся в docs/validation/redesign-completion.md и журналах отдельных владельцев.

## Global Constraints

- Не заменять пользовательскую Windows-папку preview/.runtime/demo; среда владельца недоступна из текущего Linux workspace.
- Не менять общую модель доступа: читатель получает собственные данные и verified main, редактор предлагает изменения, финальный merge внешний. Локальные роли сохраняются.
- Не добавлять центральный сервер, CRDT, обязательный AI, новый import pipeline или legacy runtime в production.
- Исторические refs/actor/evaluatedAt/имена/байты сохраняются. Неизвестное не равно нулю; результат работы не подтверждает цель.
- Один полный suite после стабилизации. До него - meaningful RED/GREEN и owning tests. Dependency install только после паузы всех test workers; нет audit fix --force и автоматической замены Node.
- Общий CSS принадлежит UI-владельцу; publishing contracts архитектурному владельцу; backend/command authority не дублируется в UI.
- Никаких force-push, merge или заявлений о банковской готовности. Итог - проверенный исходный пакет/патч и инструкции обновления с сохранением данных.

## Review Focus

- Исторический preview после нового факта/переименования/порога свежести; чужой private candidate не влияет на результат (Task2).
- Продвижение main во время проверки, две независимо допустимые capsule, сохранность старой proposal истории (Task2).
- Подтверждённая мутация с неудачным readback; неизвестный N-й шаг compound save; owner switch/перезагрузка/выход с несохранённым вводом (Task3).
- Reader личный ОКО без общих curator полномочий; отказ/отмена/ручной вход и незавершённый download; закрытие owned browser/child (Task4).
- Dark/system theme,320px/200%text, длинные русские имена, большие decimals, недоступные действия с объяснением (Tasks1,5).

## Task1: полный визуальный перенос

**Owner:** product_ui_audit. **Files:** GoalsPage; execution UI/editors; sources WorkbenchDataPage/wizard/mapping/import/lineage; publishing CuratorPanel/PackageDiff/PublishOperation presentation; MaintenancePanel presentation; production-ui.css/workbench.css.

**Interfaces:** existing GoalReadRow, execution/data/package read models, allowedCommands; сохраняются URL/exact refs и callbacks. Root owns goal setup + DashboardView; connector owner owns personal OKO. CSS requests передаются UI-owner.

- [ ] Привести списки, таблицы, формы, notices/empty/loading, диалоги и служебные действия к утверждённой системе без потери функций.
- [ ] Сохранить предметное сравнение и отдельные состояния публикации, human labels/доступное действие, backend errors.
- [ ] Проверить owning behavior tests; для CSS использовать реальные снимки и геометрию, не tests повторяющие markup.
- [ ] Обновить карту использованного/адаптированного/заменённого и проверить light/dark/system.

## Task2: публикация и историческая целостность

**Owner:** architecture_audit. **Files:** publishing/workbench backend/helpers/tests; core schema и repository/archive boundaries только anchor invariant.

**Interfaces:** общий historical input builder использует сохранённую basis; общий candidate validator связывает sourceOid/targetOid/digest. Export signature сообщается root/UI перед потреблением. Внешний enforcement - независимое доказательство.

- [ ] RED/GREEN F03/F04: T0 preview переживает T1/new facts/definition; чужой private fact/capture не участвует, собственные/common разрешены.
- [ ] RED/GREEN F02: та же proposal ветка/PR после движения main, обычный FF push, точный delta/parent, старые capsule неизменны, конфликт требует решения.
- [ ] RED/GREEN F01: весь точный будущий кандидат проверяется до внешнего принятия; перемена target аннулирует доказательство; unsupported gate явно виден.
- [ ] RED/GREEN F15: id!=packageId отвергается schema/repository/restore без частичных записей; старые несовместимые данные диагностируются без переименования.
- [ ] Owning suite и журнал с точными границами; внешний банковский merge не симулируется успешным.

## Task3: квитанции, compound save и несохранённый ввод

**Owner:** root. **Files:** dashboards/workbench/DashboardView + review-fixes; goal-setup/workbench/GoalSetupWizard, draft-session + owning tests; узкий recovery helper при необходимости.

**Interfaces:** WorkbenchClient.command/reconcileCommand, CommandResult.editToken/result, existing server drafts. Receipt является подтверждением записи независимо от следующего GET. Старый commandId сохраняется до разрешения неопределённости.

- [ ] RED F12: successful receipt + failed preferences.get сохраняет подтверждение; retry отправляет GET без второй mutation. Lost mutation response остаётся отдельным состоянием.
- [ ] GREEN F12, owning tests включая owner/unmount guards.
- [ ] RED F13: неизвестный N-й шаг сохраняет ID/ввод/подтверждённый прогресс; recovery применяет реальный receipt и продолжает один раз.
- [ ] GREEN F13 с openEntry/readback, reopen server drafts и защитой ухода с несохранённым вводом; не обещать транзакцию всех шагов.
- [ ] Точные сохранённые значения/пустые данные/формы/ошибки в UI; передать классы UI-owner.

## Task4: личный ОКО и browser reliability

**Owner:** security_ops_audit. **Files:** connectors browser/workflow/UI + owning tests; loader fixture/test; identity command metadata только узкое personal право.

**Interfaces:** personal oko.workflow namespace изолирован от common source.browser; existing provider recovery, parsing/enrichment/immutable download. Shared browser launch требует sandbox; fallback запрещён.

- [ ] RED/GREEN reader own setup/replay/results, foreign owner denied, common curator setup/publication не расширены.
- [ ] Довести первоначальную запись/сопоставление/справочник/исправление/повтор и стабильные failed/cancel/manualauth/unknown состояния через существующие команды.
- [ ] RED/GREEN F11 chromiumSandbox:true; настоящий Chrome/Edge launch где позволяет ОС, точная диагностика platform denial без отключения защиты.
- [ ] RED/GREEN E35 launch rejection и wrapper timeout закрывают только owned child/listener.
- [ ] Owning tests и журнал; реальные банковские SSO/ГОСТ/сертификаты не объявлять проверенными.

## Task5: интеграция, dependencies и системная приёмка

**Owner:** root; agents provide bounded fixes within own domain.

- [ ] Read-only свежий npm audit, таблица reachability prod/dev/unreachable, совместимые updates после остановки параллельных tests. Сохранить совместимость Node22.16.
- [ ] Проверить реальную SQLite version и условия WAL-reset; single-writer lease сохраняется. Обозначить доступную исправленную runtime сборку отдельно от разрешения менять корпоративный Node.
- [ ] Настоящий entrypoint + отдельные synthetic fixtures: все страницы, first setup/daily ОКО, manualauth/error, draft/preview/maintenance; desktop1366 и1440,1024,768,360,320, themes/text scale.
- [ ] Один review всей изменённой ветки с узкими владельцами фиксов; meaningful regression по важным findings. Не повторять широкий audit.
- [ ] Один полный npm test после стабилизации; при отказах исправить причины и повторять затронутое, не весь suite автоматически. npm run build.

## Task6: проверяемая поставка

- [ ] Актуальные MASTER_SPEC/module-map/guides/remaining-work/release notes и журнал результатов.
- [ ] Чистый source ZIP без runtime/secrets/dependencies и локальный git bundle/patch от ac299a5; проверить распаковку и штатный запуск в новой пустой пользовательской папке.
- [ ] Проверить update/restore scenario на отдельной копии синтетической базы, включая сохранение данных и откат, без обращения к Windows preview владельца.
- [ ] Финальные screenshots/video и самостоятельный отчёт с функциями/проверками/ограничениями. Сохранить пользовательские материалы и передать пакет без нового вопроса о продолжении.

## Pre-flight и решения

Ruling: визуальное согласование уже получено фразой «делай все» в ответ на конкретный reference; новый approval flow не нужен. Цена ошибки - нежелательное направление, но предыдущая версия сохранена в32106a9 и пакете.

Ruling: parallel workers реализуют три независимых слоя с фиксированными файлами, root удерживает compound save/integration/release. User spec требует узкой параллельности, поэтому per-task fresh-review cycles не используются.

Ruling: требование полного suite на каждом TDD-шаге из skill не применяется: пользователь явно требует один full run после стабилизации; промежуточные gates адресные.
