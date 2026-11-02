# Карта модулей — актуальная композиция 0.6.0

Входы остаются `src/server/main.ts` → `createWorkbenchRuntime` → `createWorkbenchApp` и `src/app/main.tsx` → `WorkbenchApp`. Ни один новый экран не использует legacy application/database как обход. Ниже — дополнения0.6; последующая исходная карта сохраняет общие доменные контракты.

| Ответственность | Владелец / точка расширения | Сохраняемый контракт |
| --- | --- | --- |
| Личный исходник и повтор ОКО | `connectors/workbench-workflow-*`, `workbench-browser-recorder`, `workbench-raw-acquisition` | Owner/capture/bytes/hash/receipt; raw сохраняется до разбора; `source.browser.*` отдельно от `oko.workflow.*` |
| Передача ручного входа | `workbench-browser-runtime`, `workbench-browser-binding`, `browser`, `workbench-browser-picker` | Одноразовая подготовка в памяти; exact owner/source/profile/revision/URL/marker; сохраняются native context/tab/lease; credentials не экспортируются; личный record.start проходит async waiting_user/retry |
| Обзор таблицы | `tabular-import/workbench-parser`, `sources/workbench/RawFilesPage` | Ограниченный raw-preview; server paging/search/sort; исходник неизменяем |
| Справочники | `knowledge/workbench-*` | Canonical directory/version/relationship; собственный draft и previewDigest; materialsFor учитывает владельца |
| Методика зрелости | `maturity/workbench-evaluate`, `workbench-materials` | Явный ожидаемый состав; source claims отдельно от консервативной оценки |
| Эффективная матрица | `evaluation/workbench/effective-matrix`, `catalog/workbench-dashboard-read` | Точные версии метода/метрики/корректировки и ожидаемые пропуски; ссылки на lineage |
| Отчёты | `reporting/workbench` | Неизменяемый ReportSnapshot/effectiveBases, CAS definition, один semantic projection для UI/OOXML/PDF; archive module reporting |
| Недельная сводка | `weekly-report/workbench`, `connectors/gigachat-browser-*` | Frozen evidence + согласие/id/revision/bindingHash, retained intent/reconcile, actions; archive module weekly |
| Общая настройка | `workspace-maintenance/workbench/setup-package-*` | Типизированный manifest/hash/closure, selected approved bytes, explicit rescue port; archive module setup |
| Кодовые уведомления | `system/workbench/update-channel`, `update-provider` | Owner/release/durable poll/read/snooze/outcome; делегирует inspect/activation каноническому update; archive module updates |
| Среда и запуск | `scripts/local-launcher.mjs`, `install-local.mjs`, `start-rm-uor.mjs`, `system/workbench/environment-query` | Pinned runtime, physical root, create-once config, limited diagnostics; один modern runtime |

`runtime-storage.ts` регистрирует новые codecs на активной и staged БД. `bootstrap.ts` соединяет общий setup с Knowledge/Maturity/Report/Weekly consumers, независимой maintenance rescue, browser assertIdle и notification lifecycle. Изменение только UI без owner/schema/recovery/archive не завершает модуль.

Добавляя adapter/preset, задайте строгую схему, полномочия, владельца, идемпотентность, отмену/неопределённый ответ, reference closure, миграцию/codec и доказанный пользовательский путь. Схема отчёта допускает чтение старых снимков без optional effectiveBases без изменения digest; отсутствие основания помечается явно. Общий пакет не является plugin runtime и не переносит личные сеансы.

[Текущий гайд](../guides/product-0.6.md) · [Проверки](../validation/product-2026-11-02.md)

---

# Сохраняемые общие контракты Workbench

Новый штатный запуск — локальный модульный монолит: React → HTTP v1 → команды/запросы → предметные сервисы → один активный SQLite и принадлежащие ему файлы. Проверенные общие определения распространяются через Git. Доступ, браузерный профиль и внешняя аутентификация остаются локальными.

Завершение редизайна сохраняет эти границы. `app/workbench/use-unsaved-changes.ts` и `context.tsx` обслуживают единый guard; `features/goal-setup/workbench/draft-session.ts` восстанавливает неизвестный шаг по существующим квитанциям. `features/publishing/workbench/publication-validation.ts` переиспользует проверку полного графа для exact Git candidate и применения. `data.lineage` возвращает имена и единицы из точной сохранённой методики; текущий head не подменяет историю. [Результаты и ограничения](../validation/redesign-completion.md).

| Область | Точки входа | Граница |
| --- | --- | --- |
| Штатный запуск | `scripts/dev.mjs`, `src/server/main.ts`, `server/workbench/bootstrap.ts`, `app/main.tsx`, `app/workbench/WorkbenchApp.tsx` | Новая оболочка и только новый API; прежний createApp не регистрируется. |
| HTTP и операции | `server/workbench/app.ts`, `routes.ts`, `application.ts`, `command-registry.ts`, `command-store.ts`, `jobs.ts` | Loopback, точные origins, CSRF, строгие DTO, принадлежность, атомарные эффект и квитанция; неизвестный ответ не означает безопасный повтор. |
| Схемы и модель | `domain/workbench/`, `domain/app-version.ts` | Header, ссылки, десятичные строки, типизированные сущности и отдельные версии форматов. |
| Чистый расчёт | `features/evaluation/workbench/` | Отбор фактов, применимость, reducers, точная арифметика, basis/result, подтверждение, пятничная динамика; без сети и UI. |
| Репозиторий | `server/storage/workbench-repository.ts`, `workbench-runtime-repository.ts`, `workbench-ownership.ts` | Версии/индексы/транзакции; стабильная оболочка следует активному native SQLite; закрытая транзакция не пишет в новый набор. |
| Контекст и оболочка | `app/workbench/context.tsx`, `route-state.ts`, `GlobalContextControls.tsx`, `WorkbenchShell.tsx` | Опубликованная область и время, URL/back с page selector, личные настройки, шесть основных разделов, сворачиваемая sidebar и доступное с клавиатуры мобильное меню, обслуживание и поиск. |
| Цели и черновики | `features/catalog/workbench-drafts.ts`, `workbench-draft-store.ts`, `features/goal-setup/workbench/` | Неполные формы, точный CAS и package closure; пример не создаёт факт, pending ручной переход имеет собственное proof. |
| Запросы и поиск | `features/catalog/workbench-read-models.ts`, `workbench-read-index.ts`, `workbench-search.ts`, `features/search/workbench/` | Подтверждённые общие данные и разрешённая собственная проекция; paging/cursors и канонический контекст. |
| Источники и импорт | `features/connectors/workbench-source-*.ts`, `features/tabular-import/workbench-*.ts`, `features/sources/workbench/` | Получение, нормализация, точное обогащение, принятие, артефакты и lineage разделены; generic adapter не определяется по наличию файла. |
| Общий браузерный источник | `workbench-browser-runtime.ts`, `workbench-browser-recorder.ts`, `workbench-browser-scenarios.ts`, `workbench-browser-source.ts`, `workbench-browser-commands.ts` | Личный профиль, ручной вход, разрешённые origins, запись/повтор, независимое доказательство полного экспорта; canonical `source.browser.*`. |
| Личный ОКО | `workbench-workflow-service.ts`, `workbench-workflow-module.ts`, `workbench-workflow-names.ts`, `features/connectors/workbench/PersonalOkoWorkspace.tsx`, `BrowserScenarioWizard.tsx`, `WorkbenchProvider.tsx` | Ежедневный результат и отдельная настройка внутри Data, prefix `oko.workflow.*` и прежние recovery-ключи. Собственные файлы и справочник, без официальных фактов; `OkoApp` целиком не монтируется. |
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
