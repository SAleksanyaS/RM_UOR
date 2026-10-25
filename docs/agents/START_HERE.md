# Начало работы GigaCode / AI-PDLC

Рабочее место УОР ДИТ Operations. УОР — управление обеспечения развития. Этот файл даёт агенту порядок входа, конкретные точки расширения и критерии завершения. Он не заменяет прямое поручение человека, `AGENTS.md` и доменную спецификацию. Карта исходного кода — [module-map](../architecture/module-map.md).

## Прочитать до изменения поведения

1. Корневые [AGENTS.md](../../AGENTS.md), [GIGACODE.md](../../GIGACODE.md), [README](../../README.md), [AI_PDLC_HANDOFF](../AI_PDLC_HANDOFF.md).
2. [Действующую мастерспеку](../MASTER_SPEC.md), [руководство пользователя](../USER_GUIDE.md) и [карту модулей](../architecture/module-map.md).
3. [remaining-work](../remaining-work.md) и [remaining-by-environment](../remaining-by-environment.md). Исторический план не является актуальным перечнем ограничений.
4. Гайд затронутого сценария в `docs/guides`, исходный код и соседние tests. Для источников — [BANK_CONNECTORS_RUNBOOK](../BANK_CONNECTORS_RUNBOOK.md); для обновления — [code-update](../guides/code-update.md) и `config/update-protocol.json`. Если текущая задача имеет отдельный согласованный план, учитывать именно его.
5. Результаты проверки текущей поставки в [AI_PDLC_HANDOFF](../AI_PDLC_HANDOFF.md). Старый счётчик passing tests не переносить на новую ревизию. Прежние датированные планы и журналы — история в отдельной архивной ветке/bundle; реквизиты — в [ARCHIVE](../ARCHIVE.md). Они не обязательная навигация для продолжения разработки.

Обозначения «этап v0.7», версия приложения и версии форматов — разные вещи. Прочитать `package.json` и `src/domain/app-version.ts`, не выводить миграцию из номера этапа. Ветка и точный commit определяются по фактическому checkout; не предполагать `main` или имя ветки из старого плана.

## Первый локальный проход

Работать из разрешённой папки. Проверить `git status --short`, текущую ветку и локальные правки перед изменениями; не перезаписывать чужую незавершённую работу. Node соответствует `package.json` (целевая связка: Node.js 22.16.0 и npm 10.9.2), npm и Git доступны. Python 3.13.5 можно оставить: приложение его не использует. Перед обновлением зависимостей прочитайте docs/guides/runtime-versions.md и сохраняйте проверку требований всех платформенных пакетов.

```text
npm ci
npm run setup:workspace -- --mode empty
npm run dev
```

`setup:workspace` выполняется только для новой установки; повторный запуск приложения не требует подготовки заново. `--mode demo` вместо `empty` выбирает синтетические примеры явно. `npm run dev` запускает штатный launcher `scripts/dev.mjs`; `dev:server`/`dev:client` полезны для разработки, но обходят полный сценарий обновления launcher. Служба локальная, стандартно API 4174 и UI 5173; реальные значения — `config/site.local.json`.

В новой корпоративной установке подготовить локальный `config/site.local.json` по `config/site.example.json`: разрешённые корни, утверждённый внутренний repository URL, published/release ветки и publicationMode. Парольный реестр кураторов создаётся защищённым локальным provision по [гайду ролей](../guides/roles-and-accounts.md). Не копировать чужие `.runtime`, cookies, browser profile, сертификат или приватный ключ ради запуска. Проверить возможности импорта переносимого набора отдельно по [гайду обслуживания](../guides/workspace-maintenance.md).

Синтетический каталог и fixtures допустимы для проверки кода. Корпоративные карты, факты, доказательства, bytes шаблона и готовые отчёты остаются приватными; включать их в общий выпуск можно только при явном выборе и в разрешённом внутреннем репозитории. `demo-only` должен их отклонять. Наличие URL или настройки профиля не доказывает реальные права, авторизацию или свежесть факта.

## Доменный минимум для любой задачи

- Официальная цель, внутренний ориентир, измеренный факт, объявленная работа и подтверждение УОР — разные данные. Завершённая веха, комментарий удержания или прогноз не создают наблюдение и не подтверждают цель.
- Ноль применимых данных, неизвестная применимость и неполнота дают «неизвестно», а не успех. Ожидаемые participants/metrics объявлены методикой и назначениями; полученные строки не определяют полноту сами.
- Положительный расчёт ожидает отдельного подтверждения по **точному fingerprint**. Новые факты/правила/состав не наследуют старое подтверждение; измеренный регресс лишает его силы.
- Цель ДИТ и назначения лидеров не взаимозаменяемы. Общая работа не становится личным обязательством каждого лидера. Несопоставимые показатели не усредняются. Весовой портфель — документированная доля подтверждённых целей по положительным весам с отдельным охватом.
- Официальный срок, обязательство, ручной прогноз и статистическая экстраполяция хранятся и показываются отдельно. Прогноз требует сравнимых периодов и поддержанной методики.
- `evaluationBasis` сохраняется при принятии фактов с методикой, составом и организацией. Для старого среза нельзя захватить текущую организацию задним числом. Отсутствующее прошлое имя/владелец/правило остаётся неизвестным.
- Исторические проекции используют чистый `evaluateGoal` и сохранённую основу. `ApplicationContext.state/evaluations` меняет текущие подтверждения и не является историческим read API.
- Preview не является принятым фактом. Ошибка, отмена, устаревшая база или неудачный сбор сохраняют предыдущий принятый набор. Загрузка старого файла не равна успешному новому сбору.
- Отчёт — неизменяемый снимок, включая выбранные template bytes/profile. Новый экспорт старого отчёта не должен подхватить сегодняшние значения или новую редакцию шаблона. Полные выбранные названия сохраняются, длинный материал продолжается.
- Доказательство с прежним id не может начать ссылаться на другие bytes/hash. Shared `relativePath` не принимается как destination. Файлы выдаются проверенными attachments.
- Роль приложения не выдаёт права Git. Публикация данных, обновление кода и перенос станции — отдельные сценарии с разными проверками и точками восстановления.

## Как добавить страницу или самостоятельную feature

Новый сценарий размещать в `src/features/<feature>/`: `contracts.ts` для DTO, Zod schema на границе входа, чистая `model.ts` для расчёта/проекции, `service.ts` для сценария, `routes.ts` с `register<Feature>Routes(app, context)`, `<Feature>Page.tsx` и локальный CSS. Это рекомендуемая форма; существующие модули используют и более подробные имена. Не создавать файл ради пустого слоя.

1. Определить вход/выход и владельца данных. Для чистого представления передавать явный DTO, а не весь `ApplicationContext`. Повторно использовать `Goal`, `ReportSnapshot` и существующие модели вместо копирования правил.
2. Сервис читает каталог через `context.catalogs.readForSession(session)`. Если нужны локальные снимки, применять `canReadSnapshot` и classification. Запись общего каталога идёт через сценарий черновика, `CatalogStore.saveDraft` и `recordChange`; не обновлять shared definitions скрыто из страницы.
3. Вход маршрута валидировать строгой схемой. Проверять сессию, роль и ownership до выдачи приватных данных; перед commit повторно проверить base revision/signature после любого `await`. `LocalDatabase.transaction(() => ...)` принимает синхронную работу: парсинг, сеть и подготовку файлов завершить заранее.
4. Подключить `register<Feature>Routes` в `src/server/app.ts`. Общие Host/Origin/CSRF/maintenance hooks уже здесь. Новые mutation endpoints по умолчанию требуют curator через `requiresCuratorForApi`; допустимое читателю действие добавлять в whitelist намеренно и проверять тестом. GET по умолчанию не означает приватную защиту: у него тоже нужны проверки доступа к ресурсу.
5. Добавить lazy import, ключ `Page`, пункт `navigation` и render branch в `src/app/App.tsx`. Добавить ключ в нужную группу `src/app/Sidebar.tsx` и разрешённый набор `src/features/identity/permissions.ts`. Страница и меню должны иметь одинаковый role guard.
6. Использовать `useWorkspace()` из `AppContext.tsx`, его `mutate` для CSRF-запросов и refresh, `useDialog` для modal/focus/Escape. Показать loading/error/empty/unknown; не заменять неизвестное фиктивным нулём. Личные настройки — `useLocalPreference`, привязанные к профилю.
7. Проверить компонент и API для reader/curator, отсутствие чужого/приватного содержимого, мобильный и компактный Sidebar. Для новой сохранённой сущности пройти lifecycle ниже.

Общая оболочка не является registry модулей: добавления одного файла Page недостаточно. Не переносить доменный расчёт в JSX. При параллельной работе назначать одного владельца для общих `server/app.ts`, `App.tsx`, `domain/contracts.ts` и `permissions.ts`; независимые feature директории можно разрабатывать отдельно.

## Как добавить источник, парсер или методику

Начать с существующих `http`, `confluence`, `qlik`, `browser` и сохранённого mapping: для другого адреса или набора колонок новый adapter часто не требуется. Точные технические контракты — в [карте модулей](../architecture/module-map.md#получение-и-принятие-фактов).

1. Новому протоколу нужен локальный метод получения `Downloaded` (`bytes`, `name`, `contentType`) с `AbortSignal`. Подключить его к `collectConfiguredSource`, расширив одновременно `SourceCollection`, `collectionSchema`, конфигурационный UI и при необходимости private profile schema/editor.
2. Пользоваться `checkedUrl`, `tlsOptions`, `download`/очередью профиля по назначению. Сохранить точный origin allowlist, проверяемый TLS, конечные таймаут/размер/повторы и закрытие browser/socket при завершении. Секретные значения не попадают в SourceCollection/scenario, операции, отчёт или лог.
3. Новый формат переводит bytes в `Observation[]` по объявленному mapping. Стабильные goal/participant/metric IDs должны быть подтверждены справочником; неоднозначность — явная ошибка. Явно задать period, state/reason, unit/target, sourceUpdatedAt. Excel формулы/макросы не исполняются.
4. Сохранить общий pipeline: полная проверка рядов и дубликатов → проверка источника/методики/состава после I/O → `captureEvaluationBasis` → проверка `LocalSnapshot` → атомарное принятие. Не писать первый ряд, пока не проверена остальная выгрузка.
5. Проверить успех, повторный identical input, несовпадение периода/метрики/участника, неполноту, ошибку TLS/прав/формата, превышение лимита, отмену в очереди и в работе, изменение базы во время загрузки. Старые факты должны сохраниться.

`SourceAdapter` из `sources/source-adapter.ts` не подключается автоматически: production dispatch находится в `connectors/service.ts`. Не создавать второй независимый accept pipeline только ради этого интерфейса.

Для новой методики сначала проверить, не выражается ли она существующими шестью kinds в `GoalMeasurement` и `measurementSchema`. Новое kind меняет схему/расчёт, fingerprint/comparability, редактор цели, import validation, историю и отчёт. Нужна общая синтетическая матрица preview/current/history/report, включая missing/excluded/zero applicable/changed scope. Банковские формулы ущерба и значения справочников нельзя придумывать.

## Как добавить отчёт или PPTX-пресет

1. Переиспользовать `buildReport(catalog, snapshots, attestations, selection, actor, now)` из `reporting/report-service.ts`. Он не пишет БД и не инвалидирует текущие подтверждения. Для недельных изменений использовать `ReportSnapshot.comparison` и его `comparable/actualDelta/reason/changes`, а не повторный расчёт из текущего UI state.
2. `generateReport` уже проверяет selection, ownership снимков и classification шаблона, затем замораживает report и template bytes/profile. Если нужен самостоятельный новый отчёт, определить, хранится ли он как existing report или как новая сущность, и проверить её transfer/retention.
3. Для обычного PPTX загрузить шаблон через `TemplateManager`, использовать text/table/repeat bindings. Новое поле требует `templateFieldSchema`, value resolver в `ooxml.ts`, выбора в UI и тестов покрытия названий. Не обновлять статические даты/проценты по догадке.
4. Специальный preset нужен для структуры, которую нельзя выразить общими bindings. Добавить свой `kind`, strict schema, структурное распознавание, замороженный payload и renderer. Явно расширить `checkTemplate`, `assertTemplateCoverage`, `renderTemplate`, `generateReport`, template UI и validator переноса; сейчас они знают `dit-maturity-v1`. Нельзя посылать новый preset в maturity renderer только из-за наличия `profile.preset`.
5. Сохранять domain unknown, full goal/leader names, continuation и неподставляемые статические объекты. Отдельно проверять отсутствие данных, отсутствие baseline, несовместимую методику/состав, длинные названия, превышение ёмкости/числа слайдов и unsafe OOXML.
6. Сверить данные и ZIP/XML, отрендерить результат и осмотреть страницы. Принятие в целевом Office/шрифтах — отдельное свидетельство; успешный XML test его не заменяет. Личные исходники и готовые корпоративные PPTX в Git не добавлять.

Недельная управленческая сводка — отдельный модуль `features/weekly-report`: `listWeeklyReports` и `saveWeeklyBrief` работают с объявленным текстом `weekly_brief` через черновики/выпуск. Она не является автоматическим расчётным `ReportSnapshot.comparison` и не должна производить факты из текста. При расширении сохранять один профиль/неделю, CAS revision и запрет выдачи чужих личных черновиков; общий validator вызывает `validateWeeklyBriefEntities`.

## Чистая передача программы

После принятия итоговой ревизии и при отсутствии изменений tracked-файлов:

```text
npm run export:clean -- --output .runtime/exports/RM_UOR-clean.zip
```

`exportCleanDistribution` из `scripts/clean-distribution.mjs` берёт HEAD, фильтрует paths до записи, создаёт ZIP кода/текущих документов и manifest с commit/version/SHA-256. В архиве нет `.git`, рабочей `.runtime`, локальных config, зависимостей, исходных корпоративных артефактов и старых датированных планов. Пустой `catalog/catalog.json` включается всегда: допустимый исходный проходит строгую проверку отсутствия записей; если он заполнен или отсутствует, экспорт создаёт безопасный пустой baseline и отмечает `generatedBaseline` в manifest. `config/curators.example.json` допускается только с публичным placeholder; реальный пароль в нём блокирует экспорт. Файлы из незакоммиченной рабочей директории не становятся поставкой.

При уже разрешённом переносе локальных учётных записей добавить `--with-local-accounts`: появится отдельный `*.private-local-accounts.zip` с проверенным реестром salted hashes и PRIVATE manifest/инструкцией. Архив кода остаётся без учётных записей. Input с открытыми паролями, сессии, browser profile и сертификаты не включаются. Не перезаписывать существующий реестр на принимающей станции автоматически; следовать утверждённой процедуре администратора из [инструкции передачи](../guides/corporate-transfer.md).

ZIP чистой программы, перенос рабочего набора из UI, архив локального видимого журнала (`npm run history:archive`) и архив истории разработки Git — разные результаты. Выбирать сценарий по поручению; не очищать историю или данные автоматически при обычной установке/передаче.

## Если появляются новые сохраняемые данные

В описании задачи явно заполнить этот контракт; пункт может иметь ответ «не применяется» с причиной.

| Вопрос | Где искать существующий механизм |
|---|---|
| Схема, версия, стабильная идентичность и отношения | `domain/contracts.ts`, feature schema, `publishing/validate-version.ts` |
| Кто читает и меняет; curator/session/installation ownership | `identity/permissions.ts`, `reader-projection.ts`, feature service/routes |
| Черновик и конфликт редакций | `CatalogStore.saveDraft`, `Draft.base`, feature CAS |
| Нужно ли включать в общий выпуск | `release-service.ts`, `application-publishing.ts`, `GitCliProvider`, compatibility manifest |
| Допустим ли перенос на другую станцию | `workspace-maintenance/bundle-service.ts`: allowlisted namespaces, schema/reference validation, явный rebind |
| Какие файлы и ссылки защищены от очистки | `workspace-maintenance/storage-service.ts`, evidence/template hashes, report/snapshot links |
| Поведение при restore/прерванной операции/закрытии | `backup-service.ts`, `workspace-maintenance/recovery.ts`, `OperationStore.recoverInterrupted`, `trackBackground`/close hooks |
| Исторические данные и повторный экспорт | `SnapshotEvaluationBasis`, `buildReport`, frozen report/template |

Не хранить credential/session IDs в доменных заметках. Не добавлять автоматический namespace export. `execution_journal` неизменяем и читается с полной linked chain: generic entity editor не должен менять архив, а release/restore не должны терять ссылки.

## Проверка и результат передачи

Сначала адресные проверки изменённой области. Примеры фильтров Vitest:

```text
npm test -- src/features/evaluation src/features/snapshots tests/integration/goal-history.test.ts
npm test -- src/features/reporting src/features/report-templates
npm test -- src/features/connectors/connectors.test.ts tests/integration/update-order.test.ts
npm test -- src/features/workspace-maintenance src/features/system/restore-safety.test.ts
npm test -- src/features/system/clean-distribution.test.ts src/features/system/workspace-bootstrap.test.ts
```

Некоторые connector tests открывают установленный Microsoft Edge и проверяют настоящее скачивание/recorder на локальном синтетическом стенде. На другой ОС требуется согласованный executable/channel; отсутствие браузера фиксировать как непроверенное окружение, а не объявлять успешным корпоративным сбором. Tests по умолчанию используют Node environment; UI tests выбирают jsdom в своих файлах. Настройки — `vitest.config.ts`.

После объединения изменений проверить итоговую ревизию:

```text
npm test
npm run build
```

Для UI дополнить реальным браузером: reader/curator, пустой и наполненный контекст, длинные полные имена, ошибка, modal focus, compact/expanded и мобильное меню. Для переноса/обслуживания проверить повреждённый input и восстановление после сбоя; для публикации — два куратора и stale preview; для обновления кода — launcher lifecycle/commitpoint. Расширять проверки по реальному риску изменения; не перепроверять всё бесконечно после неизменённого passing результата.

В отчёте о выполнении указать: что изменилось для пользователя, какие файлы/контракты затронуты, реальные команды и окружение, результат, оставшиеся ограничения и необходимые действия банка. Для нового сохранённого формата обновить handoff, remaining-work и совместимость/миграцию по необходимости. Доказательства должны относиться к итоговому combined commit; не прикладывать private bytes, реальные адреса, токены или снимки авторизации.

Перед корпоративной передачей отдельно проходят утверждённые Git-права/registry/CA/proxy, реальный HTTP/Confluence/Qlik/browser источник, OS/SSO/ГОСТ/smartcard, целевой Office, восстановление и нагрузку. [BANK_CONNECTORS_RUNBOOK](../BANK_CONNECTORS_RUNBOOK.md) и [remaining-by-environment](../remaining-by-environment.md) задают границу локального доказательства. Эти средовые проверки нельзя заменить демонстрационным стендом или словами «готово на 100%».
