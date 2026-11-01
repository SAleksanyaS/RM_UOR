# Журнал завершения РМ УОР

Plan: docs/superpowers/plans/2026-11-01-product-redesign-completion.md.
Spec: docs/superpowers/specs/2026-11-01-product-redesign.txt.
Base ac299a5; approved reference32106a9. User authorization: «делай все».

## Начальное состояние

- Reference37files зафиксирован отдельным localcommit32106a9; исходная копия и baseline чистые.
- Task1 UI: product_ui_audit; Task2 publishing: architecture_audit; Task4 OKO/browser: security_ops_audit; Task3/5/6: root.
- Dependency versions и общий node_modules заморожены до остановки targeted workers.
- Результаты82/82 reference относятся к прошлому этапу и не являются проверкой следующих изменений.
- Новых разрешений на продолжение не требуется; Windows preview/банковская среда недоступны, работа с отдельными synthetic copies.

## Итог реализации

Дата проверки: 1 ноября 2026. Production checkpoint: `93b15e8266a0119d89c36e7c2afad0a3a623d053`. Последующие изменения перед упаковкой допускаются только в документации; точный delivery commit и доказательство совпадения исполняемых файлов находятся в `DISTRIBUTION_MANIFEST.json` и внешних `delivery-verification.json`/`delivery-finalization.json` из evidence-пакета. База изменений — `ac299a5508dba60df7d4f5b8152fb7aaf4655223`.

Согласованные этапы реализованы поверх прежних Workbench/React/Fastify/SQLite/Git. Нет нового центрального сервера, второго импортного конвейера, CRDT или обязательного AI. Общая правда — принятый Git main; частные сценарии, выгрузки и черновики принадлежат человеку. Финальный merge остаётся внешним. `local-preview` не получает возможности внешней отправки или применения main от одного переключения роли.

Визуальный перенос охватывает общий каркас, обзор, цели и карточку, работы/решения, общие данные и lineage, личное ОКО, панель УОР и обслуживание. Подробная судьба прежних возможностей, включая частичные соответствия и отложенные Reports/PPTX, зафиксирована в `redesign-reuse-map.md`; отсутствие отдельного пункта меню не выдаётся за реализацию функции.

## Предметные исправления

| Граница | Реализовано и проверено |
| --- | --- |
| F01 | Проверка полного будущего Git candidate, привязанная к repository/source/target/tree/content; повторное чтение кандидата и отказ провайдеру без `readCandidate`; reader сохраняет last-good при некорректном main. Внешний compare-and-accept остаётся `not-enforced`. |
| F02 | Продолжение той же proposal-ветки после движения main с точными родителями, неизменностью старых capsules и обычным fast-forward push. После полного прогона исправлена классификация гонки создания ref; прежние CAS и ограниченные повторы сохранены. |
| F03/F04 | Сохранённые `evaluatedAt`/VersionRefs/immutable capture; текущая свежесть отдельно. Частные кандидаты принимаются по доверенному ownership binding, без actor-only fallback в пути публикации. |
| F15 | `publication_anchor.id === packageId` в схеме и границах хранения/восстановления. Несовместимая старая запись диагностируется без тихого переименования истории. |
| F12 | Подтверждённая запись остаётся сохранённой при отказе GET; повторяется чтение. Неизвестный исход мутации сверяется по прежнему `commandId`. |
| F13 | Подтверждённые шаги составного сохранения и их CAS/ID удерживаются; повтор продолжает неподтверждённый шаг. `draft.open` receipt переживает отказ readback. Общая транзакция и аварийное сохранение неотправленного ввода не обещаются. |
| Формы и фокус | Общий guard охватывает навигацию, контекст, back/close и смену роли; отказ удерживает форму и не отправляет role mutation. Одно открытие цели даёт одно предупреждение. После restore исчезновение нажатого элемента возвращает фокус внутрь диалога. |
| Личный ОКО | Читатель настраивает только собственный сценарий; личный справочник имеет отдельный purpose и лимит10MiB. Общий импорт и чужие файлы остаются закрыты. Автозавершение записи вооружается только собственным успешным start. |
| Восстановление ОКО | Ручной вход продолжает исходный собственный native context с session-only cookie и прежними job/command ID. Cookie не извлекается и не переносится. Cleanup закрывает точный handle; отказ, отмена и пустой файл сохраняют предыдущий результат. |
| F11/E35 | Native Chromium работает с sandbox; небезопасного fallback нет. Loader/timeout закрывает собственные browser/child/listener. Windows-специфические ветки не объявлены проверенными на Linux. |

## Единственный общий прогон

Команда: `npm test -- --fileParallelism --maxWorkers=2`, на точном `7ef5f9d06f1ed40a0ac3bd780743bf53d9cdbceb`. Среда: Linux, Node22.16.0, npm10.9.2, Vitest4.1.12; native Chrome156.0.8078.79 под пользователем nobody с sandbox. Начало12:24:59UTC, окончание12:34:49UTC; Vitest duration588.85s.

- 276 test files:253PASS /23FAIL.
- 2002 tests:1947PASS /52FAIL /3SKIP; один unhandled rejection; exit1.
- Три пропуска — существующие Windows-only проверки: MAX_PATH и два console режима terminal-native. Они не добавлены ради прохождения кандидата.
- Исходный RED сохранён без изменения: `completion/logs/full-suite.log`, `full-suite-summary.json`, `full-failures.txt`.
- Второго полного прогона не было. Результаты адресных исправлений ниже не превращают этот исходный прогон в GREEN и не складываются в новый общий счётчик.

## Закрытие всех52 отказов адресными проверками

| Группа исходных отказов | Причина / исправление | Фактический последующий результат |
| --- | --- | --- |
| Публикация:10 | Full-candidate fixture должен читать весь граф; Unix IPC fixture получил короткий собственный TMP root; реальная гонка Git `reference already exists` включена в прежний bounded retry. CAS/permission отрицательные проверки сохранены. | 4files:29PASS /2existingWindowsSKIP,14.39s,exit0. `publishing-followup-targeted.log`; commit41824e8. |
| Ownership/store + maintenance:14 | Четыре test fixture используют `node:os.tmpdir()` вместо Windows-only TEMP. Реальный фокус после restore исправлен в MaintenancePanel. | 5files:21/21PASS,13.69s,exit0. `correction-store-maintenance.log`; commitdda5f21. |
| Основной native UI:4 | Устаревшие ожидания reader personal rights, раскрываемого контекста и итоговых колонок; drivers учитывают явно установленный Chrome и корректно завершают waiter при launch rejection. | 4files:5/5PASS,42.27s,exit0. `correction-ui-all.log`; commitdda5f21. |
| Native fixtures:24 | Установленный executable вместо отсутствующих channel paths; headless-адаптация только тестовой среды без X display. Реальные entrypoints, sandbox и проверки argv сохранены. Первоначальный rejected promise наблюдается сразу без подавления финального отказа. | Первый targeted run11files/119tests:116PASS/3FAIL. После исправления только оставшегося connectors.test.ts:18/18PASS,11.02s. Остальные10passedfiles не повторялись; unhandled errors отсутствуют. Commits7967931/88349fb. |

Таким образом каждый из52 исходных отказавших случаев покрыт последующим успешным адресным результатом. Полная карта исходных файлов, промежуточные RED и native argv находятся в `completion/native-fixture-corrections.txt`, `native-corrections-environment.json`, `evidence/native-fixtures` и логах. Тестовые Linux adapters не меняют production политику запуска. Нет новых skip, увеличений timeout, `--no-sandbox` или `--ignore-certificate-errors`.

## Браузер, реальные файлы и визуальная проверка

Основной UI на `7ef5f9d`:43/43 проверки,48 снятых состояний; failed0,unavailable0,browserErrors0. Проверены ширины1440/1366/1024/768/360/320, light/dark/system, dirty forms, реальные draft/save/preview и обслуживание. Отдельный read-only проход:10/10, отправленные команды `[]`.

Последний полный личный ОКО прошёл11/11 на отдельной свежей синтетической базе через production UI/API/SQLite/recorder/native Chrome. Реальные11 native launches,9 source downloads, pending downloads0; browserErrors0, fatalError отсутствует. Сценарий охватывает первый запуск, профиль/маркер, запись со свёрнутой настройкой, справочник и UNMAPPED_PRODUCT, исправление, исходный/enriched CSV, ежедневный повтор, session-only manual login, source schema failure, отмену незавершённого download, пустой файл и потерю реального ответа с reconciliation прежней команды. SHA-256 скачанных файлов записаны в JSON. Видео состоит из79 реально полученных CDP frames; длительные ожидания сокращены.

Финальные ОКО доказательства: `completion/evidence/final-oko/completion-oko.json`,23PNG и четыре CSV; видео `RM_UOR_Redesign_OKO.mp4`. Computed background/border проверены для пяти реально наблюдавшихся статусов: success,waiting_user,failed,running,cancelled. Остальные цвета заданы тем же явным status mapping, но не выдаются за снятые состояния.

На проверке text200 обнаружен и исправлен реальный flex shrink бренда. После `flex:none` обычный блок остался138px, при удвоенном тексте вырос до196.19px и полностью содержит подпись. Адресный повтор:3/3PASS,commands[],page overflow0. Это удвоение computed font-size, а не native zoom200%; reflow683×384/DPR2 также не объявлен сертификацией WCAG. Реальный УОР preview имеет1change,errors[] и отдельный кадр сравнения трёх значений.

Replacement runtime был запущен на `dda5f21`; затем наложен только проверенный brand CSS. `final-ui-source-overlay.json` подтверждает совпадение всех454 non-test production/config файлов с93b15e8; из общего696 manifest совпадают692, четыре отличия — явно перечисленные test-only изменения. Историческая metadata не подменена. После копирования доказательств собственный runtime штатно завершён.

## Сборка, зависимости и независимый review

`npm run build` (`tsc --noEmit && vite build`) на93b15e8 завершилсяexit0:12:48:27–12:49:03UTC. В сборке1766modules; две upstream Zod PURE-comment warnings не являются ошибкой. Лог: `completion/logs/final-build.log`. Full-suite SHA и build SHA намеренно различаются: между ними только зафиксированные адресные исправления и документация.

Версии Node22.16.0/npm10.9.2 сохранены. Vitest обновлён до4.1.12; узкие overrides image-size2.0.4/uuid11.1.1. Свежий audit:14entries →8moderate,0high,0critical. Остаточная ExcelJS/archive цепочка и условия достижимости описаны в `redesign-dependencies.md`; нулевой риск не заявлен. SQLite3.49.1 и WAL-reset рассмотрены там же: single-writer/lease сохранён, WAL не выключен, Node22.22.3/SQLite3.51.3 остаётся отдельным кандидатом согласованного обновления.

Один независимый review выявил и закрыл обход guard при смене роли и двойное предупреждение при открытии цели. Последующие узкие review проверили собственность окончания записи, личный upload purpose, parser422, session-only continuation и exact-handle cleanup. Основной отчёт: `completion/final-review.txt`; дополнение только по post-full изменениям: `completion/final-review-post-full.txt`. Это source review и проверка сохранённых свидетельств, не новый запуск общего suite.

## Чистая поставка и сохранение данных

Проверен чистый экспорт93b15e8:877 ZIP members,876 файлов с подтверждёнными manifest SHA-256; private-path violations0, generatedBaseline=false. Распакован в новую собственную папку. Свежий `npm ci` установил405packages; production build завершилсяexit0. Затем `npm run smoke:workbench -- --root <новая-пустая-папка>` дважды запустил настоящий production main: пустой контекст, local-preview, закрытые legacy routes, та же identity после restart, без самовольного Git/legacy workspace. Исходные файлы и lock не изменились после install/build/smoke.

Binary patch действительно применён к отдельной копии exact ac299a5 и дал exact candidate tree. Incremental bundle проверен и fetched в независимом repo, содержащем только base history; единственная prerequisite — ac299a5. Не делались push, внешний merge или изменения прав. Результаты, команды и exit codes: `completion/delivery-verification.json` и `completion/logs/delivery-*-93b15e8266a0.log`.

Для финального документационного commit действует отдельный gate: допускаются только `docs/**/*.md`; исполняемые файлы, конфигурация и lock должны быть идентичны проверенному93b15e8. Повторяются export/inventory/hash, exact-tree patch и bundle verification; install/build/smoke не объявляются повторными. Receipt различает testedCommit и deliveryCommit.

Синтетические update/restore проверки существующего production пути присутствовали в общем suite: `production-archive-roundtrip.test.ts` и `native-entry.test.ts` прошли без отказов. Адресный personal-browser regression также прошёл реальный UI backup/rescue/restore/restart с проверкой неизменности файлов и сохранности пользовательских значений. Это не миграция реальных данных владельца.

Исходная копия `sources/RM_UOR` осталась чистой на3d8704e; baseline остался чистым наac299a5. Пользовательская Windows-папка `C:/Users/Aleksandr/Documents/Codex/work/RM_UOR-0.5-preview` недоступна из этой среды и не изменялась. Кодовый ZIP не содержит пользовательские `.runtime`, базы, сертификаты, cookies, browser profiles, local config или зависимости.

## Передаваемые материалы и границы готовности

Передаются исходники, binary patch, incremental bundle, инструкция на русском, SHA-256, итоговый PDF, реальные screenshot/JSON/CSV доказательства и короткое видео ОКО. Большие evidence и журналы находятся рядом с кодовой поставкой, а не включены в production repository.

Локальный кандидат реализован и проверен в указанной среде. Не заявлены: внешний Bitbucket enforcement/registry binding; банк/SSO/ГОСТ/smartcard/CA/proxy; Windows/СберБраузер/Office; перенос реального workspace; возвращение всех legacy Reports/PPTX/матрицы в новый UI. BP-01–BP-06, целевой T48 и банковская частьT41 сохраняют `BLOCKED_BANK_INPUT`. Коммерческую ценность следует проверять пилотом с руководителем, читателем и куратором, а не выводить из количества тестов или собственного впечатления от дизайна.
