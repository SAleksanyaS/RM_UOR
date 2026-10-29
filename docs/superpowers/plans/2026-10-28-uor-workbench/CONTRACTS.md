# Общие соглашения реализации целевой версии

Это карта имён и границ для частей плана, не новый код. Пути ниже относительны корню RM_UOR. Согласованные предметные схемы берутся из [спецификации 16](../../specs/2026-10-28-uor-workbench/16-data-calculation-contract.md), транспорт — из [17](../../specs/2026-10-28-uor-workbench/17-interface-api-contract.md), публикация и восстановление — из [18](../../specs/2026-10-28-uor-workbench/18-integration-operations-contract.md).

## Базовое состояние

- Репозиторий разработки: https://github.com/SAleksanyaS/RM_UOR.
- Отдельная ветка: `codex/uor-workbench-rebuild`, создана от `3d8704e4a6ff2195af4f2c0602ed11bff5d38f4b`.
- Среда продукта: Node.js **22.16.0**, npm **10.9.2**, Python **3.13.5** для соответствующего адаптера.
- Корпоративный Bitbucket в продукте и GitHub-репозиторий разработки — разные контуры. Банковские данные/учётные сведения не публикуются в GitHub.
- Промышленный код пока не меняется: текущая поставка — документация и план.

## Имена и владение файлами

| Владелец | Целевые файлы / папка | Публичные имена для соседних задач |
| --- | --- | --- |
| T01–T02 | `src/domain/workbench/primitives.ts`, `entities.ts`, `schemas.ts`, `index.ts` | Типы 16: UUIDv4, Decimal, Rational, EntityRef, VersionRef, Header, GoalAssignment, CoreGoalDefinition, EvaluationContext, NumericEvaluation, EvaluationBasis, CalculationResult и остальные перечисленные сущности. `index.ts` переэкспортирует уже реализованные контракты; никаких заглушек будущих функций. |
| T03 | `src/server/storage/workbench-repository.ts` | `WorkbenchRepository`, `createWorkbenchRepository(options)`; append-only редакции, синхронные транзакции, индексированные чтения и stateRevision. Существующая `LocalDatabase` не переосмысляется молча как новая модель. |
| T04–T08 | `src/features/evaluation/workbench/` | Чистые `evaluateAssignment(input)`, `selectEvaluationFacts(input)`, `projectFridaySeries(input)`; сохранение производных refs — отдельное `prepareEvaluation(input,repository)`. |
| T09 | `src/features/history/workbench-history.ts` | `queryHistorySeries(input,repository)`; сохранённые основания и доступ к бессрочной истории. |
| T10 | `src/server/workbench/protocol.ts`, `session.ts`, `routes.ts` | Типы/схемы 17: CommandRequest, CommandResult, QueryRequest, ApiSuccess, Problem, GlobalContext, JobSnapshot; `registerWorkbenchRoutes(app,application)`. |
| T11 | `src/features/identity/workbench-access-policy.ts` | `AccessPolicyService`, `resolveOwnAccess()`, `assertCommandAllowed(commandName)`, `assertFreshPublishAllowed(operationId)`. Hostname получает сервер; аккаунт Bitbucket не сопоставляется. |
| T12–T13 | `src/server/workbench/command-registry.ts`, `jobs.ts`, `modules.ts`, `application.ts` | `CommandRegistry`, `QueryRegistry`, `CommandContext`, `Clock`, `createWorkbenchApplication(deps)`. Регистрация команд отдельна от их исполнения. |
| T14–T21 | Существующие feature slices с новыми файлами `workbench-*` | Источники, нормализация, обогащение, черновики, работы/решения, уведомления, поля/дашборды и read models. Не переносить всё в ApplicationContext. |
| T22–T26 | `src/features/publishing/workbench/` | `PublishingService`, `registerPublishingCommands(registry,service)`; PackageRevision, PublicationAnchor и состояния 18. |
| T27–T29 | `src/features/system/workbench/`, `src/features/workspace-maintenance/workbench/`, `src/features/migration/workbench/` | `MaintenanceService`, `registerMaintenanceCommands(registry,service)`, миграционный протокол и probes. |
| T30–T41 | `src/app/workbench/` и UI соответствующих feature slices | `WorkbenchClient`, `WorkbenchProvider`, `WorkbenchShell`; страницы вызывают только публичный API 17. |

Номера T закреплены в главном плане. Внутри отведённых файлов допустимы небольшие вспомогательные файлы с одной ответственностью, если это отражено в журнале задачи; соседний публичный контракт не переименовывается без синхронного изменения плана и потребителей.

## K01. Репозиторий

`createWorkbenchRepository(options:{filename:string,artifactRoot:string}):WorkbenchRepository`.

Обязательные операции: `getHead<T extends Header>(ref:EntityRef):T|null`, `readVersion<T extends Header>(ref:VersionRef):T|null`, `append<T extends Header>(entityType:string,value:T,expectedHead:number|null):VersionRef`, `transaction<T>(action:()=>T):T`, `getStateRevision():string`, `close():void`.

append проверяет зарегистрированную схему, ссылки и optimistic revision; предыдущая редакция не заменяется. Async/Promise внутри transaction запрещён. Специализированные запросы истории/поиска добавляются в owning module с индексом и тестом; вызов list() всей истории не становится стандартным API.

T03 добавляет `sqlForModule(moduleId:string):WorkbenchSql` для доверенных серверных адаптеров модулей на том же SQLite-соединении/транзакции. `WorkbenchSql`: `get<T>(sql,params):T|null`, `all<T>(sql,params):T[]`, `run(sql,params):{changes:number}`, `execMigration(id:string,ddl:string):void`; параметры — SqlValue[] (string/number/bigint/null/Uint8Array). Только статический SQL owning module для его `wb_<module>_*` индексов/журналов. Писать историю сущностей в обход append нельзя. Этот интерфейс недоступен пользовательскому API или конструктору формул.

PublicationAnchor не имеет общего Header, поэтому T03 предоставляет отдельные типизированные `readPublicationAnchor(ref)` и `appendPublicationAnchor(anchor,expectedHead)` с той же неизменяемостью/CAS. T03/T07/T09 закрепляют точные дополнительные порты разрешения опубликованной основы и индексного чтения; их сигнатуры описаны в части 01, не заменяются сканированием list().

У anchor поле wire `revision` означает принятую **ревизию пакета**, а VersionRef.revision/expectedHead этого специального repository-порта — внутреннюю редакцию сохранённых метаданных. При уточнении времени merge row version увеличивается, anchor.revision/contentHash/mainCommit прежней публикации не меняются. Эти счётчики не присваивать друг другу.

## K02. Чистый расчёт и материализация

`EvaluationInput={assignment:GoalAssignment,goal:CoreGoalDefinition,method:MethodVersion,facts:ObservedFact[],captures:Capture[],metrics:MetricDefinition[],applicability:Applicability[],corrections:ManualCorrection[],context:EvaluationContext,resolution:{basisRef:VersionRef,templateRef:VersionRef|null,directoryLinkRefs:VersionRef[],publicationAnchors:PublicationAnchor[],actor:ActorRef}}`.

`evaluateAssignment(input:EvaluationInput):NumericEvaluation`; `selectEvaluationFacts(input:EvaluationInput):FactSelection`; тип FactSelection с выбранными refs, пропусками и quality flags определяет T05.

`prepareEvaluation(input:EvaluationInput,repository:WorkbenchRepository):{basisRef:VersionRef,resultRef:VersionRef|null}`. Одинаковая смысловая основа использует прежние refs. Источник данных, измерение и подтверждение этим не создаются.

T07 также определяет серверный `resolveEvaluationInput(request:PrepareEvaluationRequest,repository:WorkbenchRepository,clock:Clock,actor:ActorRef):EvaluationInput`, где request содержит assignmentRef и доменный businessTime. Он разрешает опубликованные/выбранные точные редакции и передаёт их чистому движку; браузер не назначает resolution.basisRef, actor и evaluatedAt.

basisDigest исключает generated Header и evaluatedAt; сам запуск часов не порождает новую основу. `projectEvaluationQuality(stored:NumericEvaluation,input:EvaluationInput):NumericEvaluation` пересчитывает только freshness/canConfirm/qualityFlags на текущие серверные часы, сохраняя числа и refs. Текущие read models и команда подтверждения используют эту проекцию; согласованный срез остаётся неизменяемым. Тест перемещения часов fresh → stale требует прежних refs и отсутствия новых фактов/основ.

`projectFridaySeries(input:FridaySeriesInput):WeeklyPoint[]`; input и WeeklyPoint следуют 16, оцениваемые часы подставляет сервер. DTO оснований не принимается от браузера как доверенный результат.

## K03. Платформа

`Clock={now():UtcInstant}` объявляется в primitives T01 и переэкспортируется платформой; production clock возвращает UTC, тестовый имеет фиксированное значение.

`CommandContext={requestId:UUIDv4,commandId:UUIDv4,installationId:UUIDv4,actor:ActorRef,repository:WorkbenchRepository,clock:Clock,ownAccess:OwnAccessProfile}`. actor задаётся сервером по фактическому hostname/установке/своему профилю, не по автору назначения. OwnAccessProfile определяет T11 по 15; поле не является Bitbucket-идентичностью.

`CommandOutcome<R>={result:R,changedRefs:EntityRef[],editToken:RevisionToken|null}`. `CommandRegistry.register(descriptor)` принимает имя, input/output schema, capability, sync/async, handler `(context:CommandContext,payload)=>Promise<CommandOutcome<R>>`; outputSchema проверяет result. `execute(request:CommandRequest,context:CommandContext)` добавляет commandId и возвращает CommandResult либо принятое задание по 17. Типы конкретного payload/result определяет owning module; unknown не является разрешением пропускать валидацию. Локальный commit эффекта и durable receipt атомарны по T12, иначе повтор после crash мог бы продублировать действие.

`QueryRegistry.register(descriptor)` принимает имя, input/output schema и read handler. `execute(name,request,context)` возвращает зарегистрированную read model. GET/queries не вызывают источник и не создают Attestation.

T12 queued recovery is explicit: only an asynchronous local descriptor with `queuedRecovery: 'restart-safe-local'` may opt in. Acceptance persists that policy alongside the original command/job IDs and resource key. Legacy/unknown policies, external/shared effects, running/retry-wait work, checkpoints and irreversible stages are not automatically replayed. `CommandRegistry.recoverPending(installationId, resolveContext)` runs once after module registration and scopes every recovery read/write to that trusted installation; foreign job lifecycles remain unchanged. The trusted server resolver reconstructs the current hostname/profile context at the actual bounded queue slot, and the registry repeats access/capability gates. Recovery decisions commit atomically before scheduling; a durable atomic receipt reconciles the existing job without repeating its effect, including after a lost handler response. The checkpoint lookup uses a job-id index without trimming history. T13 calls this startup hook from the isolated `createWorkbenchApp`; no local session or old grant is restored.

`createWorkbenchApplication(deps)` получает repository, clock, accessPolicy, command/query registries, job store и зарегистрированные модули. Необязательный до реализации порт не заменяется фальшивым успешным обработчиком; отсутствующая возможность имеет явный unsupported-сценарий.

### T16: предложения назначений новой команды

`proposeTeamAssignments(input:TeamAssignmentProposalInput):GoalAssignmentProposal[]` использует строгую `teamAssignmentProposalInputSchema`: team, clusterRef, links, assignments, templates и обязательный `teamTemplateBindings:{goalId,templateId}[]`. Это явное дополнение интерфейса плана: Template не содержит goalId/уровень, поэтому командный шаблон нельзя вывести из имени, порядка или методики кластера. Caller T17 передаёт проверенный текущий inventory и собственные локальные изменения; pure-функция не определяет опубликованность по доступности ID.

Каждая ещё не назначенная команде цель указанного кластера получает отдельный reserved id и `methodBinding:{kind:'template',templateId}`. Существующие назначения не заменяются; их expectedPopulation не меняется. Неоднозначные назначения/шаблоны, отсутствующий default и смена кластера дают явную ошибку. `GoalAssignmentProposal` содержит id/goalId/scope/methodBinding, `officialDueOn:null`, `expectedPopulation:null`, `publicationPending:true`, `pendingLinks:TeamClusterLinkProposal[]`; публикационный Header не создаётся. Срок и состав соседней области не наследуются (16 §4); numeric population должен явно заполнить куратор до превращения предложения в валидное назначение. Для manual_status null сохраняет смысл контракта.

`TeamClusterLinkProposal={id,kind:'cluster_team',from:EntityRef,to:EntityRef}`: один reserved link общий для всего нового графа; существующий локальный link переиспользуется. Дополнительный `confirmedLinkRefs?:VersionRef[]` (по умолчанию пустой) получает только точные refs из проверенного текущего DirectoryStore: лишь такой существующий link исключается из pendingLinks. Непустой publicationAnchorId сам по себе не доказывает публикацию: это может быть локальный неподтверждённый пакет. Несовпадающая/отсутствующая/повторная версия либо null anchor в confirmation refs отклоняются. IT-service/product-team связи не создаются. Возвращённые объекты не разделяют изменяемые ссылки. T17 обязан атомарно сохранять граф/IDs и переиспользовать его при повторах; отдельный вызов pure-функции не является идемпотентной командой. До T26 подтверждённой main-публикации граф не активен; ручного effectiveAt нет. Уже сохранённые основания и старые редакции остаются неизменны.

### T15: выборочный приём файла и редакции исходных фактов

`createImportService({repository,store:ImportStore,sources:SourceStore,files:FileStore,jobs,clock,recheckGuard})` реализует точные `import.preview` / `import.apply` из17. Обе команды — async/local, capability `uor.prepare`, ownership person. FileHandle проверяется по installation/person/purpose; preview не создаёт Capture/ObservedFact. Mapping и форматы берутся только из опубликованного SourceFieldMapping. Источник цели обязан явно иметь kind=file; ошибка ОКО не открывает файловый fallback.

Непрозрачный previewToken связывает приватный input hash, mapping/directory/context configurationRevision, исходные факты и опубликованные ManualCorrection. Применение перечитывает файл и текущую основу, затем повторяет gate до короткой транзакции. Чужие/повторяющиеся IDs отклоняются; кандидат редакции нельзя принять как обычную новую строку. Невыбранные исправления остаются непринятыми. Повтор того же выбора, в том числе с новым commandId или после перезапуска, возвращает сохранённый результат; другой выбор уже применённого preview даёт конфликт.

Preview row представляет одну неделимую группу исходных строк для конкретного metric/reducer/scope/businessTime/dimensions. `proposedFact.lineage.sourceRowKeys` перечисляет все её исходные строки; координата указывает первую. Для обычного source_provided_value это одна строка. Несколько строк одного такого ключа дают явную неоднозначность; sum/count/ratio используют существующий точный reducer. Выбор группы не пересчитывает формулу по произвольной части её слагаемых. Технические счётчики Capture относятся к уникальным физическим строкам текущего файла; при неизменном факте старая lineage сохраняется, а новый выбор учитывается по своим raw keys.

Ошибочный компонент блокирует всю reducer-группу, а независимые группы остаются доступными для частичного приёма. Приватный журнал групп сохраняет известные raw keys неуспешной части принятой попытки; последующая отправка одного исправленного слагаемого требует всю группу (`IMPORT_GROUP_INCOMPLETE`), не выдаёт обрезанную сумму за полную. Журнал входит в digest предпросмотра и ту же транзакцию. Повтор прежней группы с теми же нормализованными компонентами может сохранить старый факт при изменившихся физических ключах; изменённые компоненты ratio/sum требуют явной редакции даже при том же итоговом числе. Допустимость значения проверяется существующим normalizeMetric, включая неотрицательность/целочисленность, до разрешения выбора.

В расчёте rowKey квалифицируется captureId только в рабочей копии входа reducer. Исходные RawSourceRow, CanonicalSourceRow, lineage и сохранённые основания не переписываются; совпадающие ключи разных файлов больше не смешивают разные строки. Опубликованная поправка к логическому sum-агрегату заменяет весь его вклад ровно один раз, включая агрегат из нескольких raw строк; другие продуктовые вклады сохраняются.

`WorkbenchRepository.readImportFactState({sourceId,metricIds,scopes,businessTime,factKeys})` возвращает текущие fact heads нужного периода/ключей и опубликованные коррекции через существующие индексы и JSON-параметры. SourceStore.commitCapture принимает `retainedFactRefs?` и append-only редакции ObservedFact с CAS. Capture, новая редакция факта, history projection, последний результат/указатель и receipt сохраняются одной транзакцией. Ошибка строки не удаляет старый факт; исправленный файл дополняет тот же период. ManualCorrection не создаётся и не отменяется импортом, расхождение видно отдельно. Partial/latestAttempt остаётся явным входом запрета подтверждения для T17/T21.

## K04. UI

### Current implementation rulings: source ingestion and OKO priority

The user has prioritized browser recording/replay and a real OKO download, then enrichment, ahead of the remaining general platform/interface tasks. Recording learns filters/actions from interaction and ends automatically only after a completed, bounded, nonempty download. The approved browser scenario wire and personal-profile boundary remain in force. T42 may use its own private profile service before the generic T20 preferences implementation; this does not imply shared publication, T39 cutover or corporate SberBrowser verification.

The browser runtime owns handles/profile directories by installation + profile person. Its personal CAS revision covers both profile content and source bindings. `closeOwned` cancels queued opens and active downloads before releasing the profile, while a successfully auto-completed recording retains an idempotent own review result. `BrowserRuntimePort` adds `waitForCompletion({handleId,owner})` and owner-only `screenshot({recordingId,handleId,owner})`; no private filesystem path is returned. The trusted launcher seam accepts a third Playwright launch-options argument so injected native-browser fixtures preserve the same downloads/TLS/service-worker options. Those options never come from a browser request.

`createBrowserRecorderService` also requires the private `BrowserProfileService` explicitly: a portable business repository cannot resolve a personal browser profile. Its source lookup projects a VersionRef to EntityRef, then checks the current published revision separately. Recording requires preparation capability, a unique visible authenticated marker and no visible auth UI in main/visible report frames. Fill/select steps retain parameter names only. Exact role/label/CSS locators and same-origin frame paths are resolved uniquely; unsupported/ambiguous targets fail explicitly.

T15 exports `normalizeParsedWorkbenchTable({table,mapping})`, using declared row-key tuples, exact lexical numbers and the actual parser workbook epoch. It returns unchanged raw originals, canonical rows and issues without persistence. `validateBrowserExport` / `createBrowserExportPreview` check expected format/required columns and hash the original download. Neither table parsing nor file existence establishes complete population coverage.

T16's pure enrichment additionally requires the explicit `mapping:SourceFieldMapping`, since arbitrary canonical dimension names cannot identify a product key. Its capture input is the validated `SourceRowsForEnrichment=Pick<Capture,'sourceId'|'mappingRef'|'rawRows'|'canonicalRows'>`; no fabricated Capture Header/ID is needed before commit. Directory reads take explicit version-ref inventories and current/snapshot/at modes through existing indexed repository lookups. Proposal creation/activation and actual T14/T45 production bindings remain separate unfinished work.

T14 exposes `createFileStore` with owned, purpose-bound handles and verified readback; the `/api/v1/files` endpoint accepts one streamed multipart file plus purpose, after local session/origin/CSRF and capability checks. Staging does not guess CSV encoding or delimiter. The bounded passive-XLSX gate validates decoded coordinates and namespace local names after a linear pre-allocation XML structure check. Other evidence remains opaque; this is not a malware scanner or PDF renderer.

Source adapters return the strict `RawBatch`; normalize/enrich remain injected separate ports. `createSourceStore` uses explicit trusted published bindings and saved own context, not a guessed first assignment. The accepted job resource key is checked again before collection/commit. Immutable raw, capture, fact revisions, history, current pointer and receipt commit together. Synthetic adapters demonstrate the contract only.

`SourceFallback.coverage` describes retained delivered data. `latestAttempt` and `warnings` separately expose the current own goal/context/source attempt, including a partial capture with no accepted facts. **T17/T21 must combine this latest attempt's completeness/issues with calculation completeness before claiming current completeness or enabling confirmation.** The existing fact selector can otherwise combine valid new A with retained old B and still calculate a complete result. This checkpoint does not implement those future consumers. An inapplicable local capture falls through to independently verified Git data, with original dates and no fallback writes.

`WorkbenchClient.query<T>(name:string,input:QueryRequest):Promise<ApiSuccess<T>>`; `WorkbenchClient.command<T>(input:CommandRequest):Promise<ApiSuccess<T|JobAccepted>>`; `WorkbenchClient.job(id:UUIDv4):Promise<ApiSuccess<JobSnapshot>>`.

Constructor клиента получает `{fetch?:typeof fetch,baseUrl?:string}`; `.session()` возвращает SessionView, `.upload(file,purpose)` использует purpose goal-import/evidence/workspace-restore. CSRF header — `X-CSRF-Token`, значение из SessionView.csrfToken. Старое x-uor-token не является новым протоколом.

ApiSuccess, JobAccepted, JobSnapshot и поля QueryRequest имеют единственный wire 17. API client не вычисляет формулы повторно, не принимает на себя роль сервера и не передаёт hostname/роль из формы.

T13 экспортирует test-only createWorkbenchTestApplication со stable refs goal/ditAssignment/clusterAssignment/productA/productB/source/method. T30 api-harness использует app.inject; T31 ui-harness добавляет open(path) и React Provider/Shell. Ни один seed не является production bootstrap.

## K05. Публикация и эксплуатация

### Исправления личного пути ОКО после аудита (2026-10-29)

`GET /api/v1/commands/:commandId` — собственное read-only восстановление команды. Ответ: `{commandId,name,status,job,result}`, где status — `not_found|pending|accepted|completed|interrupted`, completed содержит только результат receipt, accepted — исходный JobAccepted. Исходные payload/digest не возвращаются. Чужая личность и старый installation-only intent недоступны; fresh session/person и стандартный локальный HTTP boundary обязательны. Started intent без активного выполнения после перезапуска обозначается interrupted, не воспроизводится вслепую.

UI не выдаёт восстановленный receipt за успешное сохранение новых значений той же формы: `COMMAND_RECOVERED` оставляет текущие изменения несохранёнными до явной новой отправки. Только идентификаторы собственной операции хранятся в sessionStorage. Освобождение браузера обходит ожидание отменяемой команды и имеет отдельные pending/in-flight metadata; завершение одной операции очищает только её идентификатор. Ни исходная команда, ни release не теряют восстановление при одновременном завершении или перезагрузке.

`CommandDescriptor.manualAuthRecovery:true` допускается только для явно выбранных локальных async-команд. Retry возвращается через исходные input/owner/capability/CAS/output/receipt проверки под тем же command/job; это не общий повтор внешних эффектов. `registerControl` объединяет независимые cancel/retry/openAuth controls. Ошибка manual_login_required переводит браузерное задание в waiting_user; пользователь открывает личный вход, затем явно продолжает то же задание.

Загрузка личного справочника CSV и XLSX использует один проверенный parser. В производном CSV исходные столбцы не заменяются служебными: при конфликте служебное имя получает повторяемый префикс `derived.`. Итоговая дата берётся из canonical данных, не из одноимённого raw столбца. Исходное вложение побайтно неизменно; нейтрализация формул применяется только к производному CSV.

Освобождение браузера сохраняет готовый сценарий и последний результат. Отмена активной операции охватывает очередь, проверку доступа и чтение профиля до открытия окна. Если разрешённая запись приватного профиля уже завершилась, парное обновление URL/revision доводится до согласованного состояния под тем же mutation slot. Recorder/picker browser callbacks самодостаточны под штатным Node22/tsx loader; helper из транспилятора не требуется в странице.

По уточнению владельца реальное банковское подключение сейчас недоступно. Приёмочный аналог работает в установленном Chrome и следует открытому пути выгрузки Qlik (меню → данные → готовая ссылка XLSX). Он проверяет реальный отдельный `scripts/oko.ts --serve`, compiled UI и настоящие файлы, а не подменяет production bootstrap импортом test application. Это подтверждает локальную совместимость, но не банк/СберБраузер/корпоративный SSO.

### Уточнение владельца: временный доступ и личный путь ОКО (2026-10-28)

По прямому указанию владельца изолированный запуск `npm run dev:oko` / `npm run start:oko` использует временный переключатель «Читатель / Редактор» без hostname-реестра. Его состояние — `policyState: local_preview`, а не `verified`; локальная личность установки сохраняется при переключении. Команда `source.browser.role.set` принимает только `viewer|curator`. Публикация общих данных и роль chief недоступны. Будущий режим `roleMode: registry` сохранён отдельно; общий производственный entry не переключён.

`source.browser.workspace` принимает отдельный `OwnQueryRequest` с `context:null`; предметные queries по-прежнему требуют полный контекст. Личные команды/receipts/jobs связываются с installation + person до возврата кеша и при повторном выполнении. Новые upload handles также получают server-derived person; scoped handle без совпадающего person не читается.

`createOkoWorkflowService` владеет личными профилями, записью, mapping, справочником и результатом. Мутации одного workflow сериализуются по installation/person/id до private write и CAS. После длительных операций повторно проверяются capability и person. Query читает статус записи без завершения/сохранения; явная finish-команда получает и разбирает полностью скачанный образец. UI вызывает её автоматически после completed. Marker выбирается кликом в управляемом браузере, без CSS/JSON. Вход выполняется вручную вне recorder.

Разбор/нормализация/дообогащение переиспользуют проверенные чистые ядра. Личный CSV/XLSX справочник требует явные UUID из файла и проходит общую проверку графа; он не становится опубликованным справочником. Строки не размножаются по командам. `GET /api/v1/browser/results/:resultId/original|enriched` отдаёт проверенное вложение только своей личности через локальный session/origin boundary. Исходник сохраняется без изменения; производный CSV нейтрализует формулы. Preview ограничен, выгрузка содержит все строки. Ошибка сохраняет предыдущий результат.

Это завершает личное получение и дообогащение файлов в отдельном интерфейсе; production SourceAdapter, принятие фактов, публикация сценария и общий переход T39 остаются отдельными задачами. Инструкция: [OKO_WORKFLOW](../../../OKO_WORKFLOW.md). Синтетический Edge fixture не подтверждает банковский SSO/СберБраузер.

`PublishingService.preview(context,input)`, `submit(context,input)`, `refreshStatus(context,packageId)`, `checkPublication(context)`, `applyPublication(context,mainCommit)` реализуют payload/result зарегистрированных команд 17 и моделей 18; context имеет тип CommandContext. Конкретные экспортируемые типы закреплены частью 03 плана; эти имена не меняются между задачами.

`MaintenanceService` реализует `backup.create`, `backup.restore.preview`, `backup.restore.apply` и безопасное обновление кода. Регистраторы связывают сервисы с CommandRegistry; второй HTTP API не создаётся.

Реальный Bitbucket/Qlik адаптер подключается только после соответствующего probe. Синтетический адаптер доказывает локальный контракт, а не корпоративную работоспособность. Пробам запрещено превращать отсутствие параметров в успешный результат.
