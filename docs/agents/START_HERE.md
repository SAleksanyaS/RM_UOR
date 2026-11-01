# Начало работы агента · Workbench 0.5.0

Штатный запуск уже использует новую композицию. Сначала прочитать [AGENTS.md](../../AGENTS.md), [README](../../README.md), [действующую спецификацию](../MASTER_SPEC.md), [карту модулей](../architecture/module-map.md), [журнал плана](../superpowers/plans/2026-10-28-uor-workbench/PROGRESS.md), [проверки](../VALIDATION.md) и [оставшуюся работу](../remaining-work.md). Прямые решения владельца имеют приоритет; временные локальные роли разрешены им явно.

## Войти в текущую задачу

Проверить фактическую ветку, состояние файлов и commit. Разработка находится в `codex/uor-workbench-rebuild`; не предполагать, что это main или разрешение на merge. Не перезаписывать чужую работу.

Подробные согласованные форматы: [16 — данные и расчёт](../superpowers/specs/2026-10-28-uor-workbench/16-data-calculation-contract.md), [17 — интерфейс/API](../superpowers/specs/2026-10-28-uor-workbench/17-interface-api-contract.md), [18 — интеграции/операции](../superpowers/specs/2026-10-28-uor-workbench/18-integration-operations-contract.md), [19 — приёмка](../superpowers/specs/2026-10-28-uor-workbench/19-acceptance-delivery-contract.md), [21 — браузерный ОКО](../superpowers/specs/2026-10-28-uor-workbench/21-oko-browser-scenarios.md). Не менять согласованные checksum-файлы ради зелёного теста. Уточнения реализации фиксируются отдельно в [CONTRACTS](../superpowers/plans/2026-10-28-uor-workbench/CONTRACTS.md).

Проверенная среда — Node22.16.0/npm10.9.2. На Windows запуск npm должен разрешать тот же Node через PATH; одного абсолютного пути к npm недостаточно. Для native SQLite/файловых проверок используйте канонический временный каталог. Не подменяйте проверенный runtime глобальным Node другой версии.

```text
npm test -- <затронутые файлы> --fileParallelism --maxWorkers=2
npm run test:workbench:e2e
npm run build
```

Один общий suite нужен после стабилизации объединённой версии; старые числа не являются новой проверкой.

## Точки входа и правила изменения

- `src/server/main.ts` → `createWorkbenchRuntime` → `createWorkbenchApp`; UI — `src/app/main.tsx` → `WorkbenchApp`. Прежние `createApp/createContext` не подключаются к production ради удобства теста.
- `command-registry` определяет полномочия/ownership/эффекты и recovery. Скрытая кнопка не заменяет серверную проверку. Неизвестный ответ требует сверки той же операции, а не нового ID.
- Личный ОКО использует `oko.workflow.*`; общий браузерный источник — `source.browser.*`. Не dispatch по форме payload и не общий sessionStorage для этих режимов.
- Обычный источник может иметь исходный артефакт без браузерного сценария. Нормализация выбирается по подтверждённой конфигурации, не по наличию bytes.
- `publicationAnchorId` не заменяет локальный appliedAt. Узкое присоединение подтверждённого якоря к собственной null-anchor версии не разрешает менять остальные поля или общий строгий импорт.
- Полный архив содержит весь фиксированный typed inventory и файлы. Staged проверка читает staged roots; активные сервисы — активный root. Неизвестный владелец/схема/файл блокирует весь перенос.
- Существующий active pointer с отсутствующей/повреждённой БД требует восстановления; новая пустая база под старой identity недопустима.
- Запуск/обновление/восстановление согласованы с lease и журналом до HTTP admission. Не отбирать блокировку у живого процесса, не удалять приватные папки и не откатывать данные после commitpoint.
- Новый сохраняемый модуль получает owner codecs, ownership и file inventory до UI-подключения. Полный путь расширения — в карте модулей.

## Доказательства и поставка

Покажите trigger до исправления, затем owning regression и реальный пользовательский путь, если он изменён. Для новых связок используйте actual HTTP/SQLite/браузер; fake допускается у внешнего провайдера, но не вместо успешного бизнес-ответа API.

Документы: [куратор](../guides/workbench-curator.md), [читатель](../guides/workbench-reader.md), [восстановление](../guides/workbench-recovery.md), [кандидат](../releases/workbench-candidate.md), [приёмка](../validation/workbench-acceptance.md). Реальные BP/T48/T41 не закрываются Chrome/Edge или флагом в JSON. Default Bitbucket port недоступен до отдельного проверенного binding; неизвестные старые данные не были автоматически перенесены.

Не публиковать `.runtime`, локальные настройки, реестр, cookies/ключи/профили, исходные выгрузки и приватные evidence. Чистый экспорт кода берёт принятую Git revision, а не произвольные незакоммиченные файлы. Архив кода, личная копия данных и архив истории — разные результаты. Merge/tag/rollout не следуют автоматически из завершения проверки.
