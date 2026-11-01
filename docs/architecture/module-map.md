# Карта модулей Workbench 0.5.0

Новый штатный запуск — локальный модульный монолит: React → HTTP v1 → команды/запросы → предметные сервисы → один активный SQLite и принадлежащие ему файлы. Проверенные общие определения распространяются через Git. Доступ, браузерный профиль и внешняя аутентификация остаются локальными.

| Область | Точки входа | Граница |
| --- | --- | --- |
| Штатный запуск | `scripts/dev.mjs`, `src/server/main.ts`, `server/workbench/bootstrap.ts`, `app/main.tsx`, `app/workbench/WorkbenchApp.tsx` | Новая оболочка и только новый API; прежний createApp не регистрируется. |
| HTTP и операции | `server/workbench/app.ts`, `routes.ts`, `application.ts`, `command-registry.ts`, `command-store.ts`, `jobs.ts` | Loopback, точные origins, CSRF, строгие DTO, принадлежность, атомарные эффект и квитанция; неизвестный ответ не означает безопасный повтор. |
| Схемы и модель | `domain/workbench/`, `domain/app-version.ts` | Header, ссылки, десятичные строки, типизированные сущности и отдельные версии форматов. |
| Чистый расчёт | `features/evaluation/workbench/` | Отбор фактов, применимость, reducers, точная арифметика, basis/result, подтверждение, пятничная динамика; без сети и UI. |
| Репозиторий | `server/storage/workbench-repository.ts`, `workbench-runtime-repository.ts`, `workbench-ownership.ts` | Версии/индексы/транзакции; стабильная оболочка следует активному native SQLite; закрытая транзакция не пишет в новый набор. |
| Контекст и оболочка | `app/workbench/context.tsx`, `route-state.ts`, `GlobalContextControls.tsx`, `WorkbenchShell.tsx` | Опубликованная область и время, URL/back, личные настройки, пять экранов, обслуживание. |
| Цели и черновики | `features/catalog/workbench-drafts.ts`, `workbench-draft-store.ts`, `features/goal-setup/workbench/` | Неполные формы, точный CAS и package closure; пример не создаёт факт, pending ручной переход имеет собственное proof. |
| Запросы и поиск | `features/catalog/workbench-read-models.ts`, `workbench-read-index.ts`, `workbench-search.ts`, `features/search/workbench/` | Подтверждённые общие данные и разрешённая собственная проекция; paging/cursors и канонический контекст. |
| Источники и импорт | `features/connectors/workbench-source-*.ts`, `features/tabular-import/workbench-*.ts`, `features/sources/workbench/` | Получение, нормализация, точное обогащение, принятие, артефакты и lineage разделены; generic adapter не определяется по наличию файла. |
| Общий браузерный источник | `workbench-browser-runtime.ts`, `workbench-browser-recorder.ts`, `workbench-browser-scenarios.ts`, `workbench-browser-source.ts`, `workbench-browser-commands.ts` | Личный профиль, ручной вход, разрешённые origins, запись/повтор, независимое доказательство полного экспорта; canonical `source.browser.*`. |
| Личный ОКО | `workbench-workflow-service.ts`, `workbench-workflow-module.ts`, `workbench-workflow-names.ts`, `features/connectors/workbench/`, `app/oko/OkoApp.tsx` | Встроенный инструмент в Data с prefix `oko.workflow.*` и отдельными recovery-ключами. Собственные файлы и справочник, без официальных фактов. |
| Исполнение | `features/execution/workbench-execution*.ts`, `workbench-notification*.ts`, `features/execution/workbench/` | Работы, зависимости, решения, причины/результаты, прогноз отдельно от плана, история уведомлений. |
| Публикация | `features/publishing/workbench/` | Preview/reservation/manifest, проверка свежего допуска, native Git/auth, PR/reconciliation, verified main, отдельный local appliedAt; merge вне приложения. |
| Конструкторы | `features/dashboards/workbench/`, `features/knowledge/workbench-fields.ts`, `features/system/workbench-preferences.ts` | Зарегистрированные блоки/поля, личные настройки; дополнительные поля не становятся формулами. |
| Доказательства | `features/evidence/workbench-evidence.ts` | Точное владение, hash/bytes/MIME и файл по активным метаданным; никакого произвольного статического пути. |
| Архив и восстановление | `features/workspace-maintenance/workbench/`, `server/workbench/runtime-storage.ts`, `runtime-layout-adoption.ts`, `runtime-lease.ts` | Фиксированные typed owners, весь inventory/история/файлы, проверка владельца, staged root, rescue/journal/recovery, один писатель. |
| Обновление кода | `scripts/code-update-runtime.mjs`, `server/workbench/launcher.ts`, `code-update-recovery.ts`, `features/system/workbench/code-update-service.ts` | Native launcher, quiesce, backup, старый процесс завершён до кандидата, IPC commitpoint, проверенный возврат только до принятия. |
| Совместимость | Прежние `server/app.ts`, `workspace/context.ts`, `storage/database.ts`, старые feature routes | Сохраняются для миграционных/исторических тестов. Managed workspace не открывается через вторую прежнюю базу. |

## Добавить сохраняемый модуль

1. Объявить зарегистрированные schema/entity types, точные ссылки и границу чистой модели. Не принимать Header или SQL от формы/архива.
2. Зарегистрировать команды и запросы с capability, ownership, effect, execution и recovery policy. На последнем шаге перед внешним эффектом повторно проверить допуск и точную конфигурацию.
3. Использовать стабильный repository и активный файловый resolver. Команда и её квитанция коммитятся вместе в одном предметном SQLite.
4. Добавить фиксированный owner в `createSubjectArchiveOwners` или `createSourceArchiveOwners`: все версии, неполные формы, proof/digest, связи, владельцы, каждый нужный файл и явные пропуски. Проверять весь inventory, не отфильтровывать неподходящие строки.
5. Пройти actual RestoreService на чистой другой установке того же человека: stage-bound re-export, canonical equality, исходные байты, restart, чужой владелец/нет файла/плохой hash/неподдержанный формат. Профиль, роль и исполняемые задания из архива не являются полномочиями.
6. Подключить действующий UI через registry без дополнительных обходных production entrypoints. Проверить клавиатуру,320/360/1024px, пустое место и неизвестный результат команды.
7. Обновить [контракты исполнения](../superpowers/plans/2026-10-28-uor-workbench/CONTRACTS.md), owning tests, руководства и [матрицу приёмки](../validation/workbench-acceptance.md).

## Проверки и среда

`tests/workbench/` запускает новую production composition с настоящими HTTP/SQLite/Chrome; синтетическими могут быть только внешние провайдеры и исходные данные. `server/workbench/native-entry.test.ts` проверяет actual main и штатный launcher, закрытый кандидат и возврат. `smoke:workbench` принимает только собственную пустую папку.

Стандартный Bitbucket-провайдер без проверенного банковского binding недоступен. Настоящие СберБраузер/SSO/ГОСТ/smartcard/прокси и корпоративный перенос подтверждаются отдельно; [локальная проверка](../VALIDATION.md) их не заменяет.
