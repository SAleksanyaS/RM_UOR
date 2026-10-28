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

`PublishingService.preview(context,input)`, `submit(context,input)`, `refreshStatus(context,packageId)`, `checkPublication(context)`, `applyPublication(context,mainCommit)` реализуют payload/result зарегистрированных команд 17 и моделей 18; context имеет тип CommandContext. Конкретные экспортируемые типы закреплены частью 03 плана; эти имена не меняются между задачами.

`MaintenanceService` реализует `backup.create`, `backup.restore.preview`, `backup.restore.apply` и безопасное обновление кода. Регистраторы связывают сервисы с CommandRegistry; второй HTTP API не создаётся.

Реальный Bitbucket/Qlik адаптер подключается только после соответствующего probe. Синтетический адаптер доказывает локальный контракт, а не корпоративную работоспособность. Пробам запрещено превращать отсутствие параметров в успешный результат.
