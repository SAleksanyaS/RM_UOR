# Матрица требований и проверок

Это план покрытия, не акт успешного прогона. Все исходные AC из [спецификации19](../../specs/2026-10-28-uor-workbench/19-acceptance-delivery-contract.md) связаны с owning task и конкретным будущим тестовым файлом. T40 проверяет объединённую цепочку, T41 закрывает фактический выпуск. Результаты/commit/runtime записываются в PROGRESS и приватные evidence.

| AC | Что проверяется | Задачи | Основной test path (от корня repo) |
| --- | --- | --- | --- |
| AC-01 | Независимость ДИТ/кластера | T05,T06,T32 | `src/features/evaluation/workbench/evaluate.test.ts` |
| AC-02 | Нулевой план, missing не0 | T04,T06,T32 | `src/features/evaluation/workbench/conditions.test.ts` |
| AC-03 | Точное равенство/включённые границы | T04 | `src/features/evaluation/workbench/conditions.test.ts` |
| AC-04 | Перевыполнение | T04,T32 | `src/features/evaluation/workbench/conditions.test.ts` |
| AC-05 | 96% не компенсируют провал mandatory | T06 | `src/features/evaluation/workbench/evaluate.test.ts` |
| AC-06 | N/A/перераспределение/all N/A | T06,T33 | `src/features/evaluation/workbench/evaluate.test.ts` |
| AC-07 | Предварительность/пропуски | T06,T17,T32 | `src/features/evaluation/workbench/evaluate.test.ts` |
| AC-08 | Давность разных метрик | T05,T07,T19,T32 | `src/features/evaluation/workbench/select-facts.test.ts` |
| AC-09 | Шаблон и standalone | T02,T07,T33 | `src/features/evaluation/workbench/basis.test.ts` |
| AC-10 | Ручное завершение требует результат | T07,T17,T33 | `src/features/evaluation/workbench/state-rules.test.ts` |
| AC-11 | Возврат ручной цели с причиной | T07,T17,T33 | `src/features/evaluation/workbench/state-rules.test.ts` |
| AC-12 | Назначение/оргсвязь от публикации | T02,T16,T26,T32 | `src/features/publishing/workbench/publication-anchor.test.ts` |
| AC-13 | Пятница/carry/original date | T08,T09,T32 | `src/features/evaluation/workbench/friday.test.ts` |
| AC-14 | Архив/возврат без потери истории | T17,T21,T33 | `src/features/catalog/workbench-drafts.test.ts` |
| AC-15 | As-of/period/clock cutoff | T05 | `src/features/evaluation/workbench/select-facts.test.ts` |
| AC-16 | Явный ожидаемый состав | T05,T16,T33 | `src/features/evaluation/workbench/select-facts.test.ts` |
| AC-20 | Direct → local92 → Git88 → unknown | T14,T32,T45 | `src/features/connectors/workbench-source-service.test.ts` |
| AC-21 | Нет скрытого file fallback ОКО | T14,T34,T45 | `src/features/connectors/workbench-source-service.test.ts` |
| AC-22 | Обогащение без правки raw | T16,T34 | `src/features/catalog/workbench-directory.test.ts` |
| AC-23 | 3 valid/1 rejected | T15,T34 | `src/features/tabular-import/workbench-import.test.ts` |
| AC-24 | Дополнение/diff/история | T15,T34 | `src/features/tabular-import/workbench-import.test.ts` |
| AC-25 | Принятый override сохраняется | T07,T15,T34 | `src/features/tabular-import/workbench-import.test.ts` |
| AC-26 | Накопление без PR на autosave | T17,T22,T36 | `src/features/publishing/workbench/package-manifest.test.ts` |
| AC-27 | Потеря ответа create/reconcile | T24,T36 | `src/features/publishing/workbench/proposal-reconciliation.test.ts` |
| AC-28 | Независимые пакеты кураторов | T24,T36 | `src/features/publishing/workbench/bitbucket-contract.test.ts` |
| AC-29 | Единая публикация, разный apply | T26,T32,T38 | `src/features/publishing/workbench/publication-anchor.test.ts` |
| AC-30 | Atomic effect/receipt/retry | T03,T12,T23,T28 | `src/server/workbench/command-registry.test.ts` |
| AC-31 | Native Git auth | T25,T36 | `src/features/publishing/workbench/terminal-runner.test.ts` |
| AC-32 | Cancel/revoke после ожидания | T11,T25,T36 | `src/features/publishing/workbench/pre-transfer-gate.test.ts` |
| AC-33 | Push отдельно от PR auth | T24,T25,T36 | `src/features/publishing/workbench/publishing-commands.test.ts` |
| AC-34 | File revision отдельно от ManualCorrection | T15,T17,T34 | `src/features/tabular-import/workbench-import.test.ts` |
| AC-40 | Hostname-only роли/одинаковая панель | T11,T31,T36 | `src/features/identity/workbench-access-policy.test.ts` |
| AC-41 | Direct HTTP нельзя обойти UI | T10,T11,T13,T39 | `src/server/workbench/routes.test.ts` |
| AC-42 | Свежий допуск перед write | T11,T23,T25 | `src/features/publishing/workbench/pre-transfer-gate.test.ts` |
| AC-43 | Offline drafts без autopush | T11,T17,T36 | `src/features/identity/workbench-access-policy.test.ts` |
| AC-44 | Перенос без роли/сессии | T28,T38 | `src/features/workspace-maintenance/workbench/restore-service.test.ts` |
| AC-45 | Личные настройки не правят УОР | T20,T30,T31 | `src/features/system/workbench-preferences.test.ts` |
| AC-46 | Работы/зависимости/план vs forecast | T18,T35 | `src/features/execution/workbench-execution.test.ts` |
| AC-47 | Москва/рабочий календарь/напоминания | T19,T31,T35 | `src/features/execution/workbench-reminders.test.ts` |
| AC-48 | Поиск/карточка/контекст | T21,T31,T37 | `src/features/catalog/workbench-search.test.ts` |
| AC-49 | No-code настройки | T17,T20,T33,T34,T37 | `src/features/dashboards/workbench/dashboard-ui.test.tsx` |
| AC-50 | Update/restore failpoints | T27,T28,T38 | `src/features/system/workbench/code-update-service.test.ts` |
| AC-51 | Бессрочная история | T03,T09,T21,T37 | `src/features/history/workbench-history.test.ts` |
| AC-52 | Keyboard/320/360/1024px | T30–T38,T40 | `tests/workbench/browser-flow.test.ts` |
| AC-53 | Git-only reader применяет main | T26,T32,T38 | `src/features/publishing/workbench/publication-apply.test.ts` |
| AC-54 | Restore preview/rescue/replace | T28,T38 | `src/features/workspace-maintenance/workbench/restore-service.test.ts` |
| AC-55 | Срез/комментарий/evidence/source commands | T17,T33,T34 | `src/features/catalog/workbench-drafts.test.ts` |
| AC-56 | Viewer identity для notify не даёт роли | T19,T31 | `src/features/execution/workbench-notifications.test.ts` |

## Уточнение ОКО — отдельные сценарии OC

| OC | Критерий | Задачи | Основной test path |
| --- | --- | --- | --- |
| OC-01 | Свой persistent profile, очередь и сохранённая сессия | T42 | `src/features/connectors/workbench-browser-profile.test.ts` |
| OC-02 | Recorder выключен на NSS/SSO/login/OTP границе | T43 | `src/features/connectors/workbench-browser-recorder.test.ts` |
| OC-03 | Записаны фильтры/параметры и один конечный download | T43,T44 | `src/features/connectors/workbench-browser-scenarios.test.ts` |
| OC-04 | Проверка черновика и публикация сценария через PR | T44,T22,T26 | `src/features/connectors/workbench-browser-scenarios.test.ts` |
| OC-05 | Replay ожидает готовность/файл и передаёт bytes в конвейер | T45 | `src/features/connectors/workbench-browser-source.test.ts` |
| OC-06 | Куратор настраивает всё мастером, без JSON | T46 | `src/features/connectors/workbench/BrowserScenarioWizard.test.tsx` |
| OC-07 | Настоящий local browser, другой пользователь и неполная страница | T47 | `tests/workbench-browser-record-replay.test.ts` |
| OC-08 | Настоящий СберБраузер/NSS/SSO/отчёт | T48,BP-03 | `tests/probe-oko-browser.test.ts` + приватный real evidence |

## Дополнительные входы Review Focus

| Вход | Проверяющий владелец |
| --- | --- |
| Clock advance не создаёт новый basis, но запрещает новое подтверждение stale | T07 quality/basis tests, T21 current read model |
| Очень большой Decimal/99.995 display не меняют сравнение порога | T01 exact-number tests, T04 conditions |
| Promise внутри SQLite transaction/сбой второй записи | T03 repository rollback test |
| Source capture после смены опубликованного mapping | T14/T16 version guard test |
| Crash после domain commit до HTTP response | T12 durable receipt и T15 repeat apply |
| Добавлен отдельный статический локальный модуль | T13 modules test: schema/command/search/backup hooks; официальная цель не меняется |

Часть05 определяет реальные BP-профили, команды и доказательства. Файл теста не заменяет запись фактического запуска: колонки статуса/commit/report заполняются исполнителем при проверке.
