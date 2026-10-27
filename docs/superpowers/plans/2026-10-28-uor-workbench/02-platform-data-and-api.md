# Платформа, данные и API рабочего места УОР — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Если skill/tool недоступен, выполнить те же шаги последовательно обычными npm/Git; отсутствие Codex не блокирует исполнение.

**Goal:** Реализовать проверяемые локальные команды, API и предметные сервисы пяти экранов, сохранив различия между получением, черновиком, подтверждением и публикацией.

**Architecture:** Новая платформа собирается рядом с действующим API и получает узкие порты через dependency injection. Владельцы feature slices регистрируют схемы, команды и индексированные read models; маршрутизатор не становится владельцем предметных правил. До T39 действующий launcher продолжает использовать прежний `createApp`.

**Tech Stack:** Node.js **22.16.0**, npm **10.9.2**, Python **3.13.5** только для проверенного адаптера; React 19, TypeScript 5, Vite 7, Fastify 5, Zod 4, `node:sqlite`, ExcelJS 4.4.0, Vitest 3. Зависимости автоматически не обновлять.

**Spec:** [15 — допуск](../../specs/2026-10-28-uor-workbench/15-access-policy.md), [16 — данные](../../specs/2026-10-28-uor-workbench/16-data-calculation-contract.md), [17 — API](../../specs/2026-10-28-uor-workbench/17-interface-api-contract.md), [18 — интеграции](../../specs/2026-10-28-uor-workbench/18-integration-operations-contract.md), [19 — приёмка](../../specs/2026-10-28-uor-workbench/19-acceptance-delivery-contract.md); решения 05 и архитектура 11. Общие имена — [CONTRACTS.md](CONTRACTS.md). Базовый checkout: `RM_UOR`, ветка `codex/uor-workbench-rebuild`, исходный commit `3d8704e4a6ff2195af4f2c0602ed11bff5d38f4b`.

## Global Constraints

- Один локальный процесс, loopback API `/api/v1`; основной repo один, закрытый служебный repo — исключение D-120, переключателя пространств нет.
- UUIDv4, Decimal/Rational, Header и все предметные типы принадлежат T01–T02; репозиторий K01 — T03; evaluator/materialization K02 — T04–T09. Не создавать вторую модель этих типов.
- Чтение не вызывает сеть источника, не пишет предметные данные, не создаёт Attestation/Capture/PR. Нужный расчёт явно обозначается `needs_calculation` и запускается командой.
- `viewer` может `source.capture`, `calculation.prepare`, personal preferences/tools, apply main и backup/restore своего места. Импорт файла и подготовка УОР требуют curator/chief; у chief та же обычная панель.
- D-123: hostname читает Node, account binding и пароль куратора отсутствуют; реальную Git/Bitbucket-авторизацию не выдаёт локальный профиль.
- Общие изменения — собственный draft → проверка пакета → PR → main; offline draft разрешён только по ранее проверенному собственному профилю. Сеть сама ничего не отправляет.
- D-125: verified commit/hash confirmed main активирует текущие назначения и связи при unknown mergedAt; только точная историческая временная граница блокируется `EFFECTIVE_TIME_UNVERIFIED`.
- Нет данных ≠ 0 ≠ N/A ≠ manual status; file correction — ObservedFact revision, официальный override — отдельный ManualCorrection через PR.
- Сеть/разбор до короткой синхронной транзакции; ревизии и guard повторяются перед commit. История бессрочна, lifetime caps/TTL пользовательских данных нет.
- Registry/cache/session/secrets отделены от переносимых данных; публичные тесты только синтетические, runtime/банк/вложения не добавлять в Git.
- Этот документ — план. Команды тестов/commit выполняются при реализации, сейчас продуктовый код и Git не меняются.
- Уточнение основного ОКО-пути: [часть 06](06-oko-browser-scenarios.md), T42–T48 реализуют запись/воспроизведение Сбербраузера поверх существующего Node helper. Реальное browser binding зависит от T45+BP-03; обязательный Engine API discovery не требуется, синтетический T14 adapter остаётся проверкой локального порта.

## Review Focus

1. Незнакомый hostname, spoofed role и чужой origin: ноль эффектов и приватных полей; закрепляет T10 `rejects_spoofed_session_origin_and_extra_keys`, T11 `normalizes_host_and_rejects_ambiguous_registry`.
2. Остановка процесса между записью результата и ответом: повтор возвращает прежний job/result, а неопределённый внешний эффект сначала сверяется; T12 `recovers_interrupted_without_reexecuting_effect`.
3. Формула/Excel date/слишком точное число: исходник сохранён, потери точности и выполнения кода нет; T15 `rejects_formula_and_preserves_decimal_and_unknown_date`.
4. Новая команда и many-to-many product/team: нет join-дубликата факта или скрытого изменения expectedPopulation; T16 `new_team_does_not_expand_other_population`.
5. Старый cursor, archived object, agreed без snapshot и неизвестное merge time: нет тихого latest-wins/подмены текущим; T21 `rejects_stale_cursor_and_reads_frozen_agreed_basis`.

---

## Карта файлов и порядок

Проверены существующие `src/server/app.ts` (`createApp`, legacy hooks/routes), `src/server/workspace/context.ts` (`ApplicationContext.state/evaluations`, legacy sessions), `src/server/storage/database.ts`, `src/server/operations/operation-store.ts`; их прежние list/caps/побочные записи не используются как новая платформа. Проверены identity `role-service.ts`, `permissions.ts`, `reader-projection.ts`; connectors `service.ts`, `qlik.ts`; tabular-import `parser.ts`, `service.ts`; execution `execution-service.ts`. Новые файлы остаются в этих feature slices, существующие имена не переопределяются молча.

| Задача | Новая ответственность | Зависимости |
| --- | --- | --- |
| T10 | Wire/session/CSRF/HTTP errors | T01–T02 |
| T11 | Hostname access policy и приватный cache | T10 |
| T12 | Durable commands/jobs/idempotency | T03, T10–T11 |
| T13 | Static modules/query registry/isolated HTTP composition | T12 |
| T14 | Staged upload/source capture pipeline | T03, T13 |
| T15 | Mapping/import preview/partial upsert | T14 |
| T16 | Directory enrichment и новые команды | T15 |
| T17 | Partial drafts/comment/evidence/calculation/confirmation/snapshot | T08, T13–T16 |
| T18 | Работы/решения/зависимости | T17 |
| T19 | Calendar/notifications/subscriptions | T18 |
| T20 | Fields/dashboard schemas/preferences | T17, T19 |
| T21 | Indexed read models/search пяти экранов | T09, T14–T20, T22 read ports |

Все пути ниже относительно `RM_UOR`. Перед задачей прочитать её Interfaces и зависимости, затем `git status --short`, `git branch --show-current`, `git rev-parse HEAD`; не затрагивать `RM_UOR-compat-22.16.0`. Указанный исходный commit — база всей серии, не требование сбрасывать последующие task commits.

Тесты используют Vitest, temp directories (`mkdtemp`/`afterEach`), реальный K01 SQLite и фиксированные часы; `app.inject()` не открывает listening socket. Fixture IDs выдавать `randomUUID()` либо валидными синтетическими UUIDv4. В приведённых тестах `f` — локальная fixture указанного тестового файла, её setup создаётся в Step 1 из перечисленных портов; assertions обязательны, полные тела fixture не копировать в production.

### T10: Строгий wire, локальная сессия и CSRF

**Deps / AC:** T01–T02; AC-30, AC-41, AC-45, AC-55. Spec 17 §§2,7–10. Independently testable: Fastify injection над fake application port.

**Files:** Create `src/server/workbench/protocol.ts`, `src/server/workbench/session.ts`, `src/server/workbench/routes.ts`; Test `src/server/workbench/protocol.test.ts`, `src/server/workbench/routes.test.ts`. Existing `src/server/app.ts`/workspace context пока не изменять.

**Interfaces:** Export строгие Zod schemas/types `GlobalContext`, `QueryRequest`, `CommandRequest`, `CommandResult`, `ApiSuccess<T>`, `Problem`, `FieldProblem`, `RevisionToken`, `SessionView`, `JobAccepted`, `JobSnapshot`, `NextAction` ровно wire 17. `createLocalSessionStore({clock:Clock}):LocalSessionStore`; `LocalSessionStore.issue():{id:UUIDv4,csrfToken:string}` и `get(id:string):LocalSession|null`, `invalidateAll():void`. `registerWorkbenchRoutes(app:FastifyInstance,application:WorkbenchHttpPort):Promise<void>`; `WorkbenchHttpPort={session(request:LocalRequest):Promise<SessionView>,refreshSession(request:LocalRequest):Promise<SessionView>,query(name:string,input:QueryRequest,request:LocalRequest):Promise<ApiSuccess<unknown>>,command(input:CommandRequest,request:LocalRequest):Promise<ApiSuccess<CommandResult|JobAccepted>>,job(id:UUIDv4,request:LocalRequest):Promise<ApiSuccess<JobSnapshot>>}`. `LocalRequest={requestId:UUIDv4,sessionId:UUIDv4}`; `Clock={now():string}` импортировать из T01 `src/domain/workbench/index.ts`, не объявлять второй. Upload route добавит T14. Точное имя CSRF-header — `X-CSRF-Token` (`x-csrf-token` в Node), значение из SessionView.csrfToken.

Route registration consumes typed Fastify decorator `workbenchTransport:{allowedOrigins:readonly string[],sessions:LocalSessionStore}`; T10 test sets it, T13 app.ts sets it from deps before registration. Route establishes/validates cookie then constructs LocalRequest, never accepts sessionId from JSON. LocalSession=`{id:UUIDv4,csrfToken:string}`; sessions are process-local and absent from K01/bundles. Thus route guards do not need legacy ApplicationContext or a second auth mechanism.

- [ ] **Step 1: Write failing tests** `rejects_spoofed_session_origin_and_extra_keys`, `uses_exact_envelope_and_cookie`, `validates_context_dates_and_job_invariants`. Fixture создаёт Fastify/cookie, session store, spy port; разрешён origin `http://127.0.0.1:5173`.

```ts
expect((await f.post('/commands', { ...f.command, role: 'chief' })).statusCode).toBe(422);
expect((await f.post('/commands', f.command, { origin: 'https://other.invalid' })).statusCode).toBe(403);
expect((await f.postWithoutCsrf('/commands', f.command)).statusCode).toBe(403);
expect(f.commandSpy).not.toHaveBeenCalled();
const r = await f.get('/session');
expect(r.headers['set-cookie']).toMatch(/HttpOnly.*SameSite=Strict/i);
expect(r.headers['cache-control']).toBe('no-store');
expect(r.json()).toMatchObject({ apiVersion: '1', data: { defaultContext: null } });
expect(r.headers['x-request-id']).toBe(r.json().requestId);
expect(f.parseContext({ productId: f.productId, clusterId: null }).success).toBe(false);
expect(f.parseJob({ status: 'partial', result: {}, error: f.problem }).success).toBe(false);
```

- [ ] **Step 2:** Run `npm test -- src/server/workbench/protocol.test.ts src/server/workbench/routes.test.ts`; expected FAIL missing protocol/routes exports. Confirm failure precedes any handler call.
- [ ] **Step 3:** Implement exact Interfaces. Use strict schemas, JSON Pointer field paths, UTC/date validation from T01. Cookie session only identifies local process access; derive role later server-side. Validate loopback host and configured exact origin, then session/CSRF for mutations including personal commands; `/session/refresh` also requires CSRF. POST read queries require session/origin but no business mutation. Return 401 missing session, 403 CSRF/origin, 404 unknown route/name, 422 schema errors; malformed JSON 400. Unexpected errors get safe message/operationId, never stack. GET session establishes cookie; request ID generated by server.
- [ ] **Step 4:** Same test command → PASS; `npm run build` → exit 0. Assert error envelope has `error` only, successful envelope `data` only; jobs states/progress/nextAction match 17, failed/partial/result invariants enforced.
- [ ] **Step 5: Commit**

```text
git add src/server/workbench/protocol.ts src/server/workbench/session.ts src/server/workbench/routes.ts src/server/workbench/protocol.test.ts src/server/workbench/routes.test.ts
git commit -m "feat: define workbench protocol and local session guards"
```

### T11: Политика hostname и непереносимый собственный cache

**Deps / AC:** T10; AC-40–AC-44, AC-56. Spec 15 полностью, D-120–D-123. Deliverable: policy decisions independent of real registry repo.

**Files:** Create `src/features/identity/workbench-access-policy.ts`, `src/features/identity/workbench-policy-cache.ts`; Test `src/features/identity/workbench-access-policy.test.ts`. Не заменять legacy `RoleService` до T39.

**Interfaces:** Export `Capability='business.read'|'capture.local'|'calculation.local'|'personal.write'|'uor.prepare'|'package.submit'|'publication.apply'|'workspace.backup'`; `OwnAccessProfile={role:'viewer'|'curator'|'chief',displayName:string|null,personId:UUIDv4|null,policyState:'verified'|'offline_cached'|'unavailable'|'revoked'|'invalid',checkedAt:UtcInstant|null}`. `AccessPolicyService.resolveOwnAccess():Promise<OwnAccessProfile>`, `.assertCommandAllowed(commandName:string):Promise<OwnAccessProfile>`, `.assertFreshPublishAllowed(operationId:UUIDv4):Promise<OwnAccessProfile>`. Factory `createAccessPolicyService({hostname:()=>string,registry:RegistryReadPort,cache:OwnPolicyCache,installationId:UUIDv4,mainRepositoryId:string,serviceRepositoryId:string,clock:Clock,capabilityFor:(name:string)=>Capability}):AccessPolicyService`. Registry port `.readAccepted():Promise<{commit:string,value:unknown}>`; distinguish typed transient/auth-expired/forbidden/invalid outcomes. Cache `.read():OwnPolicyCacheValue|null`, `.write(value):void`, `.invalidate():void`; stored only private external policy area, outside K01/backup.

`OwnPolicyCacheValue={hostname:string,personId:UUIDv4,displayName:string,role:'curator'|'chief',enabled:true,installationId:UUIDv4,mainRepositoryId:string,serviceRepositoryId:string,registryCommit:string,checkedAt:UtcInstant}`; cache omits other profiles/account credentials. `RegistryReadError` carries `kind:'network'|'timeout'|'auth_expired'|'forbidden'|'invalid'`; this discriminator, not a message match, distinguishes offline fallback from revocation. Export `createOwnPolicyCache({directory:string}):OwnPolicyCache` from policy-cache.ts, validate path/symlink and permissions in adapter; directory configuration server-only. Production hostname getter is `os.hostname`, fixture getter test-only.

- [ ] **Step 1: Write failing tests** `normalizes_host_and_rejects_ambiguous_registry`, `allows_cached_drafts_but_rechecks_every_external_write`, `restore_cannot_activate_old_grant`. Fixture registry read spy returns schema 15, hostname function is mutable, cache bound to installation/main/service IDs.

```ts
expect((await f.policy.resolveOwnAccess()).role).toBe('curator'); // host " DEMO-CURATOR-02 "
f.registry.setDuplicateNormalizedHost();
expect((await f.policy.resolveOwnAccess()).policyState).toBe('invalid');
f.registry.setActive('chief'); await f.policy.resolveOwnAccess(); f.registry.setTimeout();
expect((await f.policy.assertCommandAllowed('goal.draft.save')).policyState).toBe('offline_cached');
await expect(f.policy.assertFreshPublishAllowed(f.operationId)).rejects.toMatchObject({ code: 'ACCESS_RECHECK_REQUIRED' });
f.registry.setDisabled();
await expect(f.policy.assertFreshPublishAllowed(f.operationId)).rejects.toMatchObject({ statusCode: 403 });
expect(f.externalWrites).toHaveLength(0);
f.hostname.set('other-laptop'); f.registry.setTimeout();
expect((await f.policy.resolveOwnAccess()).role).toBe('viewer');
expect(JSON.stringify(await f.sessionView())).not.toContain('profiles');
```

- [ ] **Step 2:** `npm test -- src/features/identity/workbench-access-policy.test.ts` → FAIL missing service.
- [ ] **Step 3:** Implement exact service/cache signatures; normalize hostname trim+lowercase, reject conflicting duplicates globally, validate strict schema/version/role/Boolean/person UUID. Unknown/disabled/explicit Read forbidden revoke cached preparation; expired auth/network permits only own previously verified local preparation. Invalid schema gives viewer/invalid. Fresh gate reads `os.hostname()` adapter and accepted registry every call, never reuses queued permit; no account ID in schemas. Registry access binding awaits BP-02, absence returns unavailable and never fake curator. Record only own projection/check time; cache includes normalized host, installation/repo IDs and registry commit. Cache API has no export/restore hook.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Additional table test verifies viewer local capture/prefs/apply/backup allowed and viewer imports/UOR denied, chief/curator same set, missing account has no effect. Simulate explicit revocation after offline cache and confirm preserved drafts remain readable only to owner.
- [ ] **Step 5: Commit**

```text
git add src/features/identity/workbench-access-policy.ts src/features/identity/workbench-policy-cache.ts src/features/identity/workbench-access-policy.test.ts
git commit -m "feat: enforce hostname policy with private offline cache"
```

### T12: Durable command registry, задания и идемпотентность

**Deps / AC:** T03, T10–T11; AC-30–AC-33, AC-42. Spec 17 §§9–10, 18 §7. Deliverable: restart-safe dispatcher with synthetic handlers; external intent/reconciliation belongs to T22–T26.

**Files:** Create `src/server/workbench/command-registry.ts`, `src/server/workbench/jobs.ts`, `src/server/workbench/command-store.ts`; Test `src/server/workbench/command-registry.test.ts`, `src/server/workbench/jobs.test.ts`.

**Interfaces:** K03 `CommandContext={requestId:UUIDv4,commandId:UUIDv4,installationId:UUIDv4,repository:WorkbenchRepository,clock:Clock,ownAccess:OwnAccessProfile,actor:ActorRef}`. `CommandOutcome<R>={result:R,changedRefs:EntityRef[],editToken:RevisionToken|null}`. `CommandDescriptor<P,R>={name:string,inputSchema:ZodType<P>,outputSchema:ZodType<R>,capability:Capability,effect:'local'|'sharedDraft'|'external',execution:'sync'|'async',handler:(context:CommandContext,payload:P)=>Promise<CommandOutcome<R>>}`. `CommandRegistry.register<P,R>(descriptor:CommandDescriptor<P,R>):void`; `.execute(request:CommandRequest,context:CommandContext):Promise<CommandResult|JobAccepted>`. Factory `createCommandRegistry({repository,jobs,accessPolicy}):CommandRegistry`. `createJobStore({repository,clock}):JobStore`; `.create(commandId:UUIDv4,installationId:UUIDv4,name:string):JobAccepted`, `.get(jobId:UUIDv4,installationId:UUIDv4):JobSnapshot|null`, `.findByCommand(commandId:UUIDv4,installationId:UUIDv4):JobSnapshot|null`, `.update(jobId:UUIDv4,patch:JobPatch):void`, `.recoverInterrupted():void`. `JobPatch=Partial<Omit<JobSnapshot,'jobId'|'commandId'>>`; stage must be registered. `JobSink={stage(jobId:UUIDv4,stage:string,progress:JobSnapshot['progress']):void,checkpoint(jobId:UUIDv4,value:Record<string,unknown>):void,complete(jobId:UUIDv4,result:unknown,warnings:Problem[]):void,fail(jobId:UUIDv4,error:Problem):void}`; outputSchema validates outcome.result before public response. Services resolve operationId through findByCommand, not commandId=jobId.

**Atomic local receipt:** Export `commitCommandEffect<R>(context:CommandContext,action:()=>CommandOutcome<R>):CommandOutcome<R>` from command-store.ts. It runs one synchronous repository.transaction, validates/appends local domain changes, and records durable typed outcome under installation+commandId before commit; when receipt already exists, returns it without action. Feature services T14–T20 use this helper for the final local commit after their async preparation; they return its `.result`, and registrars return the same stored outcome. Registry finds receipt after crash before redispatch. This avoids Promise inside SQLite transaction and the gap «effect committed, response not recorded». Async external stages use T22 effect journal; this helper does not pretend to make network exactly-once.

- [ ] **Step 1: Write failing tests** `replays_same_command_and_conflicts_on_changed_payload`, `recovers_interrupted_without_reexecuting_effect`, `guards_retry_cancel_and_auth_stage`. Fixture closes/reopens real temp SQLite, installs handler counter and fake effect checkpoint; never starts network.

```ts
const first = await f.execute(f.command);
expect(await f.execute(f.command)).toEqual(first);
expect(f.handlerCalls()).toBe(1);
await expect(f.execute({ ...f.command, payload: { value: '2' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
await f.interruptAt('external.intent'); await f.reopen();
expect(f.jobs.get(f.jobId, f.installationId)?.status).toBe('interrupted');
expect(f.handlerCalls()).toBe(1);
expect(f.jobs.get(f.jobId, f.otherInstallationId)).toBeNull();
await expect(f.cancelAfterIrreversible()).rejects.toMatchObject({ statusCode: 409 });
expect(f.snapshot('waiting_user')).toMatchObject({ result: null, nextAction: { commandName: 'job.openAuth' } });
```

- [ ] **Step 2:** `npm test -- src/server/workbench/command-registry.test.ts src/server/workbench/jobs.test.ts` → FAIL missing registry/store.
- [ ] **Step 3:** Implement exact interfaces; canonical digest validated typed request including name/baseRevision/payload, keyed by installation+commandId. Durable intent precedes scheduling, same transaction records local effect/result where sync service commits. Restore `running` to interrupted; queued recovery explicitly schedules only eligible local work, never blindly repeats unknown external writes. Persist full append-only job transitions/checkpoints, no `slice(0,50)` recovery cap. Store queue resource keys and bounded per-source/repo concurrency. Default no retry on auth/schema failure, bounded configurable read retry with backoff. Register job.cancel/retry/openAuth descriptors; source operation owns guard and irreversible/cancel/auth/reconcile callbacks; retries receive original commandId/jobId and fresh access gate.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Fault-inject before/after local commit and after external intent; assert one logical result or explicit interrupted/REMOTE_STATE_UNKNOWN. Same ID under concurrent calls schedules one job; no both result/error. Failed has error; partial has result/warnings; jobId=operationId. Logging redacts secrets and correlates requestId/commandId/jobId.
- [ ] **Step 5: Commit**

```text
git add src/server/workbench/command-registry.ts src/server/workbench/jobs.ts src/server/workbench/command-store.ts src/server/workbench/command-registry.test.ts src/server/workbench/jobs.test.ts
git commit -m "feat: persist command idempotency and recoverable jobs"
```

### T13: Статические модули, запросы и изолированная сборка v1

**Deps / AC:** T12; AC-30, AC-41, AC-45, AC-48–AC-49. Spec 17 §12. Deliverable: real route dispatcher with injected ports and no legacy startup change.

**Files:** Create `src/server/workbench/query-registry.ts`, `src/server/workbench/modules.ts`, `src/server/workbench/application.ts`, `src/server/workbench/app.ts`, `src/server/workbench/testing/test-application.ts`; Modify `src/server/workbench/routes.ts` (application port binding); Test `src/server/workbench/modules.test.ts`, `src/server/workbench/application.test.ts`.

**Interfaces:** `QueryContext={requestId:UUIDv4,installationId:UUIDv4,repository:WorkbenchRepository,clock:Clock,ownAccess:OwnAccessProfile}`. `QueryDescriptor<P extends QueryRequest,R>={name:string,inputSchema:ZodType<P>,outputSchema:ZodType<R>,handler:(context:QueryContext,input:P)=>Promise<R>}`; `QueryRegistry.register<P,R>(descriptor):void`, `.execute(name:string,request:QueryRequest,context:QueryContext):Promise<unknown>`. `PlatformModule` uses exact fields/version/hooks/schema ownership of 17 §12. `validateModules(modules:PlatformModule[]):void`. `WorkbenchApplicationDeps={hostname:()=>string,repository:WorkbenchRepository,clock:Clock,accessPolicy:AccessPolicyService,commands:CommandRegistry,queries:QueryRegistry,jobs:JobStore,modules:PlatformModule[],sessions:LocalSessionStore,allowedOrigins:string[],installationId:UUIDv4}`; `createWorkbenchApplication(deps:WorkbenchApplicationDeps):WorkbenchHttpPort`; `createWorkbenchApp(deps:WorkbenchApplicationDeps):Promise<FastifyInstance>` in `app.ts` creates isolated injectable app. Feature services receive their own deps; descriptors never receive ApplicationContext/SQL.

**Test-only public fixture:** `createWorkbenchTestApplication(options:{role:'viewer'|'curator'|'chief',scenario:'empty'|'scope-split'|'population-gap'|'stale-fallback'|'manual-goal'|'partial-file'|'publication-ready'|'offline-draft',clock?:string}):Promise<{app:FastifyInstance,repository:WorkbenchRepository,refs:Record<string,VersionRef>,close():Promise<void>}>` in `testing/test-application.ts`. Seed with T02 `makeNumericFixture`/`makeEntityGraph` and T03 `seedGraph`, real new modules/API, synthetic network ports only; no production seed. T13 implements empty/scope-split; T14–T21/T22 add own remaining seed cases when their module exists. Unknown/unavailable scenario before owning task throws explicit test setup error. Stable refs keys `goal`, `ditAssignment`, `clusterAssignment`, `productA`, `productB`, `source`, `method`; title «Тестовая цель», cluster «Кластер А». Scope-split uses independent DIT/cluster requirements, never implied child rollup. UI T30 imports this function to inject fetch over `app.inject`.

- [ ] **Step 1: Write failing tests** `rejects_cycles_ownership_and_unknown_schemas`, `query_has_no_capture_or_draft_effect`, `registered_local_tool_is_personal_only`. Test fixture includes synthetic `test-tool` module with strict `{note:string}` command `test-tool.local.save`, owner-specific store and backup hook; not a new product service.

```ts
expect(() => validateModules(f.cyclicModules)).toThrow(/depend/i);
expect(() => validateModules(f.overlappingOwners)).toThrow(/owner/i);
expect(() => f.validatePayload('unknown.schema', 1, {})).toThrowError(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
const before = f.repository.getStateRevision(); await f.query('overview');
expect(f.repository.getStateRevision()).toBe(before); expect(f.captureSpy).not.toHaveBeenCalled();
expect((await f.commandAsViewer('test-tool.local.save', { note: 'личное' })).statusCode).toBe(200);
expect((await f.commandAsViewer('test-tool.local.unregistered', {})).statusCode).toBe(404);
expect(f.sharedChanges()).toEqual([]);
```

- [ ] **Step 2:** `npm test -- src/server/workbench/modules.test.ts src/server/workbench/application.test.ts` → FAIL missing composition.
- [ ] **Step 3:** Implement exact interfaces. Validate manifest id, SemVer, contract=1, dependency graph, unique namespace/entity owner/query/command/navigation route/label and schemaId/version pairs. Only build-time imported modules; no eval/dynamic executable uploads. Register default navigation overview/goals/execution/data/uor with viewer-disabled UOR reason. Resolve session/access server-side, derive context.actor from actual hostname/installation/registry profile; execute schemas/guards/revision before handlers; metadata clock/stateRevision/publishedCommit from server. Call T09 `installHistoryIndex(repository):void` from `src/features/history/workbench-history-index.ts` once before seeding/loading modules, including test app; T03 `registerProjection(name,project)` executes own indexes after staged refs validation before same sync COMMIT. Optional unbound source/publishing ports expose unsupported/unavailable diagnostics; never successful stub. No edits to `src/server/main.ts`, `src/server/app.ts`, `src/server/workspace/context.ts` until T39 composition/cutover.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Inject session/queries/commands/jobs routes end-to-end without listening; all query schemas/outputs strict. Assert foreign tool owner 404, backup hook only declares personal owned data, unsupported manifest preserves DB and returns SCHEMA_UNSUPPORTED.
- [ ] **Step 5: Commit**

```text
git add src/server/workbench/query-registry.ts src/server/workbench/modules.ts src/server/workbench/application.ts src/server/workbench/app.ts src/server/workbench/testing/test-application.ts src/server/workbench/routes.ts src/server/workbench/modules.test.ts src/server/workbench/application.test.ts
git commit -m "feat: compose static workbench modules and v1 API"
```

### T14: Приватные uploads и источник → raw → normalize → capture

**Deps / AC:** T03, T13; AC-20–AC-22, AC-26, AC-30, AC-41. Spec 16 §7, 18 §§2–7. Deliverable: source pipeline with synthetic Qlik; corporate Qlik binding depends only on BP-03/P-01.

**Files:** Create `src/server/workbench/files.ts`, `src/features/connectors/workbench-source-contracts.ts`, `src/features/connectors/workbench-source-service.ts`, `src/features/connectors/workbench-source-store.ts`, `src/features/connectors/workbench-demo-source.ts`; Modify `src/server/workbench/routes.ts` (POST files), `src/server/workbench/application.ts` (inject file port); Test `src/server/workbench/files.test.ts`, `src/features/connectors/workbench-source-service.test.ts`.

**Interfaces:** Export source DTOs of 18 §2 `CaptureRequest`, `RawBatch`, `SourceIssue`; `SourceAdapter={check(request:CaptureRequest):Promise<SourceCheck>,collect(request:CaptureRequest,signal:AbortSignal):Promise<RawBatch>}`. `RawBatch` carries goal/source/config refs, operationId, capturedAt/sourceUpdatedAt, rawRows/artifact/hash and coverage proof. `createSourceService({repository,store:SourceStore,adapters:Map<string,SourceAdapter>,normalizer:NormalizerPort,enricher:EnricherPort,jobs:JobSink,clock}):SourceService`; `.capture(context:CommandContext,input:{goalId:UUIDv4}):Promise<CaptureResult>`; `registerSourceCommands(registry:CommandRegistry,service:SourceService):void`. `CaptureResult={captureRef:VersionRef,acceptedRows:number,rejectedRows:number,duplicate:boolean}`. `FileStore.stage(input:{installationId:UUIDv4,purpose:'goal-import'|'evidence'|'workspace-restore',name:string,mediaType:string,stream:AsyncIterable<Uint8Array>}):Promise<FileHandleView>` and `.read(handle:UUIDv4,installationId:UUIDv4,purpose:FilePurpose):Promise<StagedFile>`; StagedFile is server-only bytes/hash/metadata, no client path. File handle view exactly 17; app deps gains `files:FileStore`.

Новые source DTO конкретизировать в том же workbench-source-contracts.ts:

- `CaptureRequest={operationId:UUIDv4,goalRef:VersionRef,sourceRef:VersionRef,mappingRef:VersionRef,businessTime:BusinessTime,context:GlobalContext,configurationRevision:RevisionToken,profileRef:string|null}`; profileRef остаётся локальным adapter input, не package/API DTO.
- `SourceCheck={status:'ready'|'auth_required'|'unavailable'|'unsupported'|'invalid_configuration',issues:SourceIssue[]}`.
- `SourceIssue={code:string,stage:string,retryable:boolean,message:string,rowKeys:string[],refs:EntityRef[]}`.
- `RawBatch={operationId:UUIDv4,sourceRef:VersionRef,mappingRef:VersionRef,capturedAt:UtcInstant,sourceUpdatedAt:UtcInstant|null,rawRows:RawSourceRow[],artifact:FileArtifactRef|null,payloadHash:Sha256,coverage:{complete:boolean,expectedRows:number|null,receivedRows:number,evidence:string[]},issues:SourceIssue[]}`.
- `NormalizerPort.normalize(input:{raw:RawBatch,mapping:SourceFieldMapping}):{rows:CanonicalSourceRow[],issues:SourceIssue[]}`; `EnricherPort.enrich(input:{rows:CanonicalSourceRow[],directoryRevision:RevisionToken}):EnrichmentResult`; T16 enrichSourceRows builds its Capture view from the same rows.
- `FilePurpose='goal-import'|'evidence'|'workspace-restore'`; `FileHandleView={fileHandle:UUIDv4,name:string,mediaType:string,bytes:number,sha256:string}`; `StagedFile=FileHandleView&{purpose:FilePurpose,installationId:UUIDv4,bytesValue:Uint8Array}` server-only. read returns verified immutable bytes, never a client-writable path.

`FileStore`, `FilePurpose`, `FileHandleView`, `StagedFile` экспортировать из `src/server/workbench/files.ts`, чтобы T17/T27 читали один resolver. `createFileStore({directory:string,limits:FileLimits}):FileStore`; limits — численные профильные значения Step 3, не параметры браузера. `CaptureRequest.context` сервер восстанавливает из опубликованного назначения/сохранённого допустимого контекста, отсутствующий клиентский context не заменяется выдуманным ditId. source.capture command payload остаётся только `{goalId}`.

T14 extends WorkbenchHttpPort with `upload(input:Omit<Parameters<FileStore['stage']>[0],'installationId'>,request:LocalRequest):Promise<ApiSuccess<FileHandleView>>`; application supplies installationId/guards by purpose, routes stream multipart and wrap 201. Do not expose FileStore directly as an unauthenticated route helper. `FileLimits={goalImportBytes:number,evidenceBytes:number,restoreBytes:number,restoreExpandedBytes:number}`; hard parser row/column/cell/archive limits also apply before full allocation.

- [ ] **Step 1: Write failing tests** `viewer_capture_preserves_raw_and_does_not_confirm`, `failed_collection_keeps_last_success`, `rejects_cross_owner_handle_and_client_path`. Fixture adapter returns a complete 2-product synthetic batch, then truncated/error/cancelled batches; file test streams bytes without a real listener.

```ts
const result = await f.captureAs('viewer');
expect(result.acceptedRows).toBe(2); expect(f.rawCell('demo_value')).toBe('92.00');
expect(f.factValue()).toBe('92'); expect(f.attestations()).toHaveLength(0);
expect(f.publications()).toHaveLength(0); const accepted = f.lastSuccessfulRef();
f.source.fail('SOURCE_SCHEMA_CHANGED'); await expect(f.captureAs('viewer')).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_CHANGED' });
expect(f.lastSuccessfulRef()).toEqual(accepted);
expect(f.fallback()).toMatchObject({ obtainedVia: 'local-cache', sourceDate: '2026-10-27' });
await expect(f.files.read(f.handle, f.otherInstallation, 'evidence')).rejects.toMatchObject({ statusCode: 404 });
expect((await f.upload({ path: 'C:\\private\\input.xlsx' })).statusCode).toBe(422);
```

- [ ] **Step 2:** `npm test -- src/server/workbench/files.test.ts src/features/connectors/workbench-source-service.test.ts` → FAIL missing ports/service.
- [ ] **Step 3:** Implement exact interfaces; raw immutable storage, normalization separate from acquisition, no Number for Decimal. Upload consumes one multipart file and purpose with stream/resource limits: profile `goal-import` CSV/XLSX 10 MiB, 20,000 rows, 100 cols; evidence 32 MiB, restore archive 64 MiB compressed/256 MiB expanded from existing maintenance safety profile. Size limits are technical profile, not 2,000-row truncation. Reject path/traversal/symlink, unsupported MIME/content, extra fields; hash stream, private staging, atomic finalize. source.capture uses published setting only, reader own local captures; reject manual/file as Qlik fallback. Collection full-coverage proof mandatory, duplicate operationId idempotent; recheck config revision/guard before short transaction. Persist Capture/facts/history/last-success pointer atomically; failure never replaces pointer. Direct → latest successful local → Git → no data with original business date. Demo adapter explicitly synthetic; основной реальный ОКО browser adapter подключает T45 после BP-03 проверки executable/SSO/full export. Inspected `collectQlik` Engine adapter не требуется для этого пути и остаётся только отдельной явно проверенной возможностью.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Abort before commit leaves no fact, repeated operation returns same ref, new real capture may retain same numeric value with new capture. No file switching for Qlik; no credentials/source settings in read DTO. Check direct/local/Git dates remain unchanged and unknown stays unknown.
- [ ] **Step 5: Commit**

```text
git add src/server/workbench/files.ts src/features/connectors/workbench-source-contracts.ts src/features/connectors/workbench-source-service.ts src/features/connectors/workbench-source-store.ts src/features/connectors/workbench-demo-source.ts src/server/workbench/routes.ts src/server/workbench/application.ts src/server/workbench/files.test.ts src/features/connectors/workbench-source-service.test.ts
git commit -m "feat: stage private files and capture local source facts"
```

### T15: CSV/XLSX mapping, partial import и редакции исходных фактов

**Deps / AC:** T14; AC-21, AC-23–AC-25, AC-30, AC-34, AC-49, AC-55. Spec 16 §7, 18 §§3–5. Deliverable: selected partial upserts independent of publication.

**Files:** Create `src/features/tabular-import/workbench-parser.ts`, `src/features/tabular-import/workbench-import.ts`, `src/features/tabular-import/workbench-import-store.ts`; Test `src/features/tabular-import/workbench-parser.test.ts`, `src/features/tabular-import/workbench-import.test.ts`. Read existing `parser.ts` for quoted CSV/archive safety; legacy `parseTable` unchanged because it converts numbers to float and rejects multiple sheets.

**Interfaces:** `parseWorkbenchTable(input:{bytes:Uint8Array,name:string,sheet:string|null}):Promise<ParsedSourceTable>` preserves RawCell originals/coordinates. `ImportService.preview(context:CommandContext,input:{goalId:UUIDv4,fileHandle:UUIDv4}):Promise<ImportPreviewResult>`; `.apply(context:CommandContext,input:{previewToken:string,acceptedRowIds:UUIDv4[],acceptedCorrectionIds:UUIDv4[]}):Promise<ImportApplyResult>`; `registerImportCommands(registry,service):void`. `ImportPreviewResult={previewToken:string,rows:ImportPreviewRow[],corrections:FileFactCorrectionCandidate[],issues:FieldProblem[],complete:boolean}`; `ImportPreviewRow={id:UUIDv4,rowKey:string,coordinate:{sheet:string|null,row:number},acceptable:boolean,proposedFact:ObservedFact|null,problems:FieldProblem[]}`. `FileFactCorrectionCandidate={id:UUIDv4,kind:'file_fact_revision',beforeFactRef:VersionRef,afterFact:ObservedFact}` exactly 18. `ImportApplyResult={captureRef:VersionRef,acceptedRowIds:UUIDv4[],acceptedCorrectionIds:UUIDv4[],rejectedRowIds:UUIDv4[],complete:boolean}`. Persist mapping as SourceFieldMapping via T17 commands, not hidden parser settings.

Согласованное addendum: T02 `SourceFieldMapping.parsingProfile?:{sheetName:string|null,csvDelimiter:','|';'|'\t',csvEncoding:'utf8'|'windows1251',dateFormat:'iso'|'dd.mm.yyyy'|'excel-serial',decimalSeparator:'.'|',',groupSeparator:'none'|'space'|'nbsp'|'comma'|'dot'}`; absent uses explicit ISO/default profile. Final parser signature replaces `sheet` with `parsingProfile:NonNullable<SourceFieldMapping['parsingProfile']>`; mapping preview/save uses that same schema. Reject equal decimal/group separator, ambiguous `01/02/26`, invalid Excel serial date/epoch, absent sheet, undecodable file; no guessing. Add assertions `expect(f.parseDate('31.10.2026','dd.mm.yyyy')).toBe('2026-10-31')`, `expect(f.parseNumber('1 234,50',f.commaSpaceProfile)).toBe('1234.5')`, `expect(()=>f.parseDate('01/02/26','iso')).toThrow()` to parser test.

- [ ] **Step 1: Write failing tests** `accepts_three_rows_and_keeps_one_rejection`, `supplements_period_and_requires_selected_correction`, `rejects_formula_and_preserves_decimal_and_unknown_date`. Create CSV bytes inline and XLSX via ExcelJS in temp memory, no bank file.

```ts
const p = await f.previewCsv('A;65\nB;70\nC;80\nD;bad');
expect(p.rows.filter(r => r.acceptable)).toHaveLength(3); expect(p.complete).toBe(false);
const a = await f.apply(p, { acceptValidRows: true });
expect(a.complete).toBe(false); expect(f.facts()).toHaveLength(3);
expect(await f.repeatSameApply()).toEqual(a); expect(f.facts()).toHaveLength(3);
const correction = await f.previewReplacement('A', '70');
expect(correction.corrections[0].kind).toBe('file_fact_revision');
await f.applySelected(correction); expect(f.factHistory('A').map(x => x.value)).toEqual(['65', '70']);
expect(f.manualCorrections()).toHaveLength(0);
f.seedPublishedCorrection('A', '72'); await f.importReplacement('A', '71');
expect(f.effectiveValue('A')).toBe('72'); expect(f.discrepancy('A')).toBe(true);
expect((await f.parseCell('12345678901234567890.001')).numbers.demo_value).toBe('12345678901234567890.001');
await expect(f.previewFormulaWorkbook()).rejects.toMatchObject({ code: 'UNSUPPORTED_CELL' });
expect((await f.parseWithoutDate()).businessTime).toEqual({ kind: 'unknown' });
```

- [ ] **Step 2:** `npm test -- src/features/tabular-import/workbench-parser.test.ts src/features/tabular-import/workbench-import.test.ts` → FAIL missing parser/import API.
- [ ] **Step 3:** Implement exact signatures; parser profile explicit sheet/date/number mapping, reject missing saved column as SOURCE_SCHEMA_CHANGED, archive bombs/macros/formula/external links; do not execute values. For XLSX numeric cells inspect OOXML numeric lexical text before ExcelJS float conversion; reject unsupported conversion rather than invent precision/date. Normalize permitted formats to canonical Decimal via T01, no hidden locale guesses. Preview binds input hash/mapping/directory/fact-head revisions and owner; mutates no facts. Apply verifies token and selected IDs, no duplicates/foreign IDs; stale preview → PREVIEW_STALE. Changed factKey retains entity ID and increments ObservedFact revision, raw lineage remains. Unselected correction not applied with new rows. Missing/error rows do not delete known facts; later fixed rows supplement same period. New imports never create ManualCorrection, preserve official override and discrepancy. Commit Capture/history/result/pointer together after parsing/recheck.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Add file source guard against Qlik/manual goals, empty selection, duplicate row keys, preview changed after mapping/main/fact update, retry new commandId for same preview/file no duplicate. Assert acceptedRowIds/acceptedCorrectionIds UUIDv4 and partial does not permit result.confirm.
- [ ] **Step 5: Commit**

```text
git add src/features/tabular-import/workbench-parser.ts src/features/tabular-import/workbench-import.ts src/features/tabular-import/workbench-import-store.ts src/features/tabular-import/workbench-parser.test.ts src/features/tabular-import/workbench-import.test.ts
git commit -m "feat: preview and partially upsert mapped source files"
```

### T16: Версионное обогащение и назначения новой команды

**Deps / AC:** T15; AC-02, AC-12, AC-16, AC-22, AC-53. Spec 16 §§6–7, D-039–D-040/D-125. Deliverable: pure enrichment plus draft assignment proposals; activation owned by T26.

**Files:** Create `src/features/catalog/workbench-directory.ts`, `src/features/catalog/workbench-directory-store.ts`; Test `src/features/catalog/workbench-directory.test.ts`.

**Interfaces:** `enrichSourceRows(input:{capture:Capture,directoryEntities:DirectoryEntity[],directoryLinks:DirectoryLink[]}):EnrichmentResult`; `EnrichmentResult={rows:EnrichedRow[],issues:FieldProblem[],directoryLinkRefs:VersionRef[]}`, EnrichedRow retains raw rowKey/canonical fields and resolved ScopeRef/VersionRefs, no copy per join. `proposeTeamAssignments(input:{team:DirectoryEntity,clusterRef:EntityRef,links:DirectoryLink[],assignments:GoalAssignment[],templates:Template[]}):GoalAssignmentProposal[]`; proposals contain reserved entity IDs, template method bindings and publication-pending links, no fabricated published Header. `validateDirectoryChanges(input:{entities:DirectoryEntity[],links:DirectoryLink[]}):FieldProblem[]`. T17 consumes these pure functions; source service receives EnricherPort using exact enrichment function.

- [ ] **Step 1: Write failing tests** `retains_raw_and_reports_required_unmapped_product`, `new_team_does_not_expand_other_population`, `confirmed_unknown_time_enables_current_links`. Fixture two products share optional team; frozen old basis stored separately.

```ts
const enriched = enrichSourceRows(f.unmappedInput);
expect(enriched.rows[0].rowKey).toBe(f.raw.rowKey); expect(f.raw.cells).toEqual(f.originalCells);
expect(enriched.issues[0]).toMatchObject({ code: 'UNMAPPED_PRODUCT' });
expect(enrichSourceRows(f.manyToManyInput).rows).toHaveLength(f.manyToManyInput.capture.canonicalRows.length);
const proposed = proposeTeamAssignments(f.newTeamInput);
expect(proposed).toHaveLength(1); expect(proposed[0].methodBinding.kind).toBe('template');
expect(f.originalAssignment.expectedPopulation).toEqual(f.originalPopulation);
expect(f.activeBeforeMerge(proposed)).toHaveLength(0);
expect(f.currentAfterConfirmedUnknownTime(proposed)).toHaveLength(1);
expect(f.oldBasis.directoryLinkRefs).toEqual(f.oldLinks);
expect(validateDirectoryChanges(f.crossClusterMove)).toContainEqual(expect.objectContaining({ code: 'TEAM_CLUSTER_MOVE_UNSUPPORTED' }));
```

- [ ] **Step 2:** `npm test -- src/features/catalog/workbench-directory.test.ts` → FAIL missing functions.
- [ ] **Step 3:** Implement exact interfaces; lookup exact external key/source pair, ambiguous names/keys produce queue issue, never invent directory IDs. Scope graph verifies parent links and one leader per cluster/product; optional teams not a completeness error. New team proposes cluster goals with team templates only, no auto IT-service relationships, no cluster reassignment. Proposal remains local until publication; no manual effectiveAt input. Current uses confirmed main identity even unknown time; historical exact-time request delegates publication anchor guard, saved basis always its refs. Materialization uses indexed directory versions, preserving source originals and previous enrichments.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Cover no-team product complete, duplicate normalized external key blocks, old agreed digest unchanged after directory revision, source rows counted once regardless of number of product-team links.
- [ ] **Step 5: Commit**

```text
git add src/features/catalog/workbench-directory.ts src/features/catalog/workbench-directory-store.ts src/features/catalog/workbench-directory.test.ts
git commit -m "feat: version directory enrichment and team assignments"
```

### T17: Незавершённые черновики, evidence и точное подтверждение/срез

**Deps / AC:** T08, T13–T16; AC-09–AC-11, AC-14, AC-25–AC-26, AC-34, AC-43, AC-49, AC-55. Spec 16 §§4–9, 17 §9. Deliverable: every definition/confirmation binding operates locally; publication consumed by T22.

**Files:** Create `src/features/catalog/workbench-drafts.ts`, `src/features/catalog/workbench-draft-store.ts`, `src/features/catalog/workbench-draft-commands.ts`, `src/features/evidence/workbench-evidence.ts`; Modify `src/server/workbench/routes.ts` (typed artifact read route), `src/server/workbench/application.ts` (inject evidence read port); Test `src/features/catalog/workbench-drafts.test.ts`, `src/features/evidence/workbench-evidence.test.ts`, `src/features/evidence/workbench-artifact-routes.test.ts`.

**Interfaces:** Export `PartialDraftInput<T>` recursively optional **business fields**, never Header; `DraftEntry={draftId:UUIDv4,entityRef:EntityRef,baseRef:VersionRef|null,definition:Record<string,unknown>,complete:boolean,problems:FieldProblem[]}`; `DraftPackageView={packageId:UUIDv4,ownerPersonId:UUIDv4,revision:number,baseCommit:string|null,entries:DraftEntry[]}`; `DraftValidation={complete:boolean,problems:FieldProblem[],changedRefs:EntityRef[]}`. `createDraftService({repository,store:DraftStore,clock,files:FileStore,prepareEvaluation:typeof prepareEvaluation,directory}):DraftService`. `.open(context:CommandContext,input:DraftOpenInput):Promise<DraftOpenResult>`, `.saveDefinition(context,input:DraftSaveInput):Promise<DraftSaveResult>`, `.validateDraftPackage(packageId:UUIDv4):DraftValidation`, `.readDraftPackage(packageId:UUIDv4):DraftPackageView`; `registerDraftCommands(registry,service):void`. Input/result aliases exactly typed payload/results 17 §9, not open-ended CRUD. `EvidenceService.fromHandle(context,{draftId,fileHandle}):Promise<Evidence>` verifies size/hash and assigns FileArtifactRef server-side.

**Artifact read extension:** `EvidenceService.readArtifactForContext(context:QueryContext,artifactId:UUIDv4):Promise<ArtifactReadResult>`; `ArtifactReadResult={stream:Readable,name:string,mimeType:string,bytes:number,sha256:string}` (`Readable` from node:stream; sha256 raw 64 lowercase hex). It resolves only an accessible saved own local Evidence record or verified published Evidence, not staging handles, screenshots, policy/profile artifacts or a filesystem path. `WorkbenchHttpPort.artifact(artifactId:UUIDv4,request:LocalRequest):Promise<ArtifactReadResult>` creates the trusted QueryContext and delegates. Register `GET /api/v1/artifacts/:artifactId` in routes.ts with local session/exact-origin/UUID/ownership guards. Successful response is binary stream, **not ApiSuccess JSON**: exact Content-Type/Content-Length, `X-Content-SHA256`, Content-Disposition attachment with sanitized UTF-8 filename, Cache-Control no-store and X-Content-Type-Options nosniff. Unavailable/foreign artifact is 404 with ordinary Problem envelope; integrity failure before headers is INTEGRITY_MISMATCH. No generic filesystem GET or client path parameter.

Типовые aliases объявить в workbench-drafts.ts; no open unknown definition escapes owner validators:

- `DraftOpenInput={entityType:string,ref:EntityRef|null,packageId:UUIDv4|null}`; entityType restricted to registered owner types.
- `DraftOpenResult={draftId:UUIDv4,objectId:UUIDv4,entityRef:EntityRef,editToken:RevisionToken}`.
- `DraftSaveInput={draftId:UUIDv4,definition:PartialDraftInput<WorkbenchEntity>}` is internal discriminated dispatch by reserved entityRef.entityType; each public command schema binds its concrete entity business type.
- `DraftSaveResult={draftId:UUIDv4,entityRef:EntityRef,complete:boolean,problems:FieldProblem[]}`; registry obtains editToken from atomic receipt, not trusted definition input.
- Actor/profile comes from server context; no caller-supplied Header. Package-wide immutable view includes full reserved graph so publisher can validate cross-linked source/goal definitions before serialization.
- Method/template/assignment changes resolve K02 input through `resolveEvaluationInput(request,repository,clock,context.actor)` from `src/features/evaluation/workbench/resolve-input.ts`; input contains captures/metrics and `resolution:{basisRef,templateRef,directoryLinkRefs,publicationAnchors,actor}`; do not reconstruct evaluator input from flattened stale legacy catalog.

- [ ] **Step 1: Write failing tests** `reserves_source_goal_refs_and_keeps_partial_form`, `comment_and_snapshot_never_create_attestation`, `confirmation_requires_exact_confirmable_basis`, `manual_reopen_retains_completion`; HTTP `streams_owned_or_published_evidence_and_hides_private_paths`. Fixture T08 evaluator and real repository; count stored entity types before/after. Artifact fixture seeds saved own evidence, foreign local evidence, verified published evidence and a private-profile sentinel; requests use real Fastify app.inject, no listening socket.

```ts
const goal = await f.open('core_goal_definition'); const source = await f.open('source_definition');
const saved = await f.save(goal, { title: 'Новая цель', sourceId: source.objectId });
expect(saved.complete).toBe(false); expect(saved.problems.some(p => p.path === '/mode')).toBe(true);
expect(f.readDraft(goal.draftId).definition).not.toHaveProperty('mode');
await expect(f.save(goal, { actor: f.actor })).rejects.toMatchObject({ statusCode: 422 });
expect(f.validatePackage().complete).toBe(false);
const ready = await f.prepare(); expect(await f.prepare()).toEqual(ready);
await f.saveComment('Проверено'); await f.saveSnapshot(ready);
expect(f.count('attestation')).toBe(0); expect(f.count('capture')).toBe(f.initialCaptures);
await expect(f.confirm(f.staleResultRef)).rejects.toMatchObject({ code: 'BASIS_NOT_CONFIRMABLE' });
await expect(f.reopenManual('')).rejects.toMatchObject({ statusCode: 422 });
await f.reopenManual('Нужно дополнение'); expect(f.manualHistory().map(x => x.to)).toEqual(['completed', 'in_progress']);
const artifact = await f.viewerGetArtifact(f.publishedArtifactId);
expect(artifact.statusCode).toBe(200); expect(artifact.rawPayload).toEqual(f.evidenceBytes);
expect(artifact.headers['content-type']).toBe(f.mimeType);
expect(artifact.headers['content-length']).toBe(String(f.evidenceBytes.length));
expect(artifact.headers['x-content-sha256']).toBe(f.evidenceSha256);
expect(artifact.headers['cache-control']).toBe('no-store');
expect((await f.ownerGetArtifact(f.ownSavedArtifactId)).statusCode).toBe(200);
expect((await f.viewerGetArtifact(f.foreignLocalArtifactId)).statusCode).toBe(404);
expect((await f.viewerGetArtifact(f.unsavedStagingHandle)).statusCode).toBe(404);
for (const url of ['/api/v1/artifacts/%2e%2e%2fprivate-profile', '/api/v1/artifacts?path=C%3A%5Cprivate', '/api/v1/browser-profiles/session.json']) {
  const denied = await f.app.inject({method:'GET',url,headers:f.sessionHeaders});
  expect(denied.statusCode).toBeGreaterThanOrEqual(400);
  expect(denied.body).not.toContain(f.privateProfileSentinel);
}
```

- [ ] **Step 2:** `npm test -- src/features/catalog/workbench-drafts.test.ts src/features/evidence/workbench-evidence.test.ts src/features/evidence/workbench-artifact-routes.test.ts` → FAIL missing services/commands/artifact route (successful published read initially 404).
- [ ] **Step 3:** Implement exact interfaces and bind `draft.open`; goal/assignment/method/template/source/fieldMapping/na/organization `.draft.save`; manualGoal.transition; fact.correct; result.confirm; snapshot.save; comment/evidence `.draft.save`; goal.archive/restore; calculation.prepare. Own package/person/installation guards and editToken CAS before write. Recursive partial schema preserves absent versus null; unknown keys/Header rejected, present values strictly checked, cross-refs reserved within same package. Full validation happens package preview/submit, never coercion of incomplete values. calculation.prepare loads exact published/own accessible refs with server clock and invokes K02; same semantic basis reuses refs, manual resultRef=null, no new observation. fact.correct requires originals/reason and changes only proposal. Confirm requires exact current basisDigest, fresh/complete/met canConfirm and comment; evidence IDs validated. Snapshot copies server numericResult or exact manualStatusRef, one branch, matching optional attestation digest; snapshot does not confirm. Comment nonempty; URL absolute HTTP(S) no userinfo; evidence handle own purpose/hash/bytes, no client artifact/path. Archive/restore creates draft event and leaves works/history. Return typed results/editToken; all shared activity remains local package.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Test completed requires result, reopened event preserves previous description, file optional; stale token 409 retains prior input, other curator draft 404, snapshot stale/mismatched basis 422, URL credentials 422, file hash mismatch INTEGRITY_MISMATCH. Test fully completed cross-linked source/goal package validates and still has no public activation. For artifact reads verify saved accessible Evidence linkage/visibility first, then size/hash on the immutable opened artifact before streaming from that same handle; no bytes released for integrity failure, foreign/orphan/staging handle or private path. Missing local session 401, external origin 403; binary payload is not wrapped/re-encoded as JSON and arbitrary query parameters cannot select a path.
- [ ] **Step 5: Commit**

```text
git add src/features/catalog/workbench-drafts.ts src/features/catalog/workbench-draft-store.ts src/features/catalog/workbench-draft-commands.ts src/features/evidence/workbench-evidence.ts src/server/workbench/routes.ts src/server/workbench/application.ts src/features/catalog/workbench-drafts.test.ts src/features/evidence/workbench-evidence.test.ts src/features/evidence/workbench-artifact-routes.test.ts
git commit -m "feat: bind partial drafts evidence and exact result snapshots"
```

### T18: Работы, решения и ацикличные зависимости

**Deps / AC:** T17; AC-10–AC-11, AC-14, AC-46, AC-55. Spec 16 §8a, D-044–D-061. Deliverable: work/decision commands do not affect goal measurement.

**Files:** Create `src/features/execution/workbench-execution.ts`, `src/features/execution/workbench-execution-store.ts`; Test `src/features/execution/workbench-execution.test.ts`. Existing legacy `execution-service.ts`/journals stay readable until migration, not reused as Work schema.

**Interfaces:** `createExecutionService({repository,drafts:DraftService,store:ExecutionStore,clock}):ExecutionService`; `.saveWork(context:CommandContext,input:WorkDraftSaveInput):Promise<DraftSaveResult>`, `.saveDecision(context,input:DecisionDraftSaveInput):Promise<DraftSaveResult>`, `.transition(context,input:WorkTransitionInput):Promise<{draftId:UUIDv4,entityRef:EntityRef}>`; `registerExecutionCommands(registry,service):void` binds work.draft.save/decision.draft.save/work.transition и необходимую typed API extension workDependency.draft.save (зафиксирована в addenda главного плана). `WorkDraftSaveInput={draftId:UUIDv4,definition:PartialDraftInput<Work>}`; `WorkDependencyDraftSaveInput={draftId:UUIDv4,definition:PartialDraftInput<WorkDependency>}` для workDependency.draft.save; зависимости — отдельные draft entities, не неизвестные поля внутри Work. IDs/Header назначает сервер. `projectExecution(input:{works:Work[],dependencies:WorkDependency[],decisions:Decision[],now:UtcInstant}):ExecutionProjection` is pure, exposes risk/overdue without rewriting dueOn.

- [ ] **Step 1: Write failing tests** `rejects_cycles_and_cancellation_without_dependency_resolution`, `reopen_preserves_completion_and_forecast_does_not_shift_due`, `one_work_links_multiple_goals_without_facts`.

```ts
await expect(f.saveDependencies(['A->B', 'B->A'])).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
await expect(f.cancelPredecessor({ reason: 'Отмена' })).rejects.toMatchObject({ code: 'DEPENDENCY_RESOLUTION_REQUIRED' });
await f.removeDependency({ reason: 'Заменено новой работой' }); await f.cancelPredecessor({ reason: 'Отмена' });
await expect(f.reopenCompleted('')).rejects.toMatchObject({ statusCode: 422 });
await f.reopenCompleted('Нужна доработка'); expect(f.completionEvents()).toHaveLength(1);
await f.changeForecast('2026-11-05'); expect(f.work().dueOn).toBe('2026-10-30');
await f.linkWorkToGoals(2); expect(f.work().goalIds).toHaveLength(2);
expect(f.count('observed_fact')).toBe(f.initialFactCount); expect(f.count('attestation')).toBe(0);
```

- [ ] **Step 2:** `npm test -- src/features/execution/workbench-execution.test.ts` → FAIL missing service/projection.
- [ ] **Step 3:** Implement exact service/projection signatures. Validate self/cyclic/foreign refs using package+published graph, keep active/inactive link revisions with reasons. Work completed requires result, paused/cancelled reason, completed→in_progress reason and previous completion event preserved. Blocking predecessor cancellation requires explicit replacement or inactive dependency with reason in same package. Never auto-shift plan or recalculate goal fact from work. Decision answer/answeredAt paired; server time only for newly supplied answer, missing answer no synthetic timestamp. Work may refer to multiple goals, responsibility scope/person refs validated. Incomplete work/decision definitions use T17 partial save, state transitions stay strict; output available to execution query via read port.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Add completed without evidence allowed, target completed while active unfinished dependency rejected, dangling person/work refs block package validation, goal archive keeps work and completion history. Confirm independent due/forecast/risk/state fields and revision conflict handling.
- [ ] **Step 5: Commit**

```text
git add src/features/execution/workbench-execution.ts src/features/execution/workbench-execution-store.ts src/features/execution/workbench-execution.test.ts
git commit -m "feat: manage work decisions and dependency revisions"
```

### T19: Московский календарь, адресные уведомления и личные подписки

**Deps / AC:** T18; AC-08, AC-47, AC-56. Spec 16 §8a, 18 §17, 17 notifications commands. Deliverable: deterministic notification pump, no external messages.

**Files:** Create `src/features/execution/workbench-reminders.ts`, `src/features/execution/workbench-notifications.ts`, `src/features/execution/workbench-notification-store.ts`; Test `src/features/execution/workbench-reminders.test.ts`, `src/features/execution/workbench-notifications.test.ts`.

**Interfaces:** `resolveNotificationRecipient(input:{ownAccess:OwnAccessProfile,preferences:PersonalPreferences}):UUIDv4|null` uses registry person first, optional preference second. `planReminder(input:{now:UtcInstant,calendar:BusinessCalendar,settings:ReminderSettings,lastSentAt:UtcInstant|null,cause:NotificationCause}):ReminderPlan|null`; plan one current event only. `NotificationService.pump(context:QueryContext):Promise<void>` is explicit background application lifecycle action, not query side effect; `.markRead(context:CommandContext,input:{notificationIds:UUIDv4[]}):Promise<{notificationIds:UUIDv4[]}>`, `.subscribe(context,input:{goalId:UUIDv4,subscribed:boolean}):Promise<{goalId:UUIDv4,subscribed:boolean}>`. `registerNotificationCommands(registry,service):void` binds exact 17 names and reminders.draft.save through DraftService. `NotificationCause={provider:string,objectRef:EntityRef,sourceVersion:string,kind:string,recipientPersonIds:UUIDv4[],route:string}`; local event dedup key provider+typed object+version+kind+recipient/owner.

- [ ] **Step 1: Write failing tests** `overdue_starts_at_moscow_midnight_and_reminds_at_nine`, `missed_workdays_emit_one_current_reminder`, `anonymous_subscriptions_do_not_change_author_or_acl`.

```ts
expect(f.decisionOverdue('2026-10-30T20:59:59Z')).toBe(false);
expect(f.decisionOverdue('2026-10-30T21:00:00Z')).toBe(true);
expect(planReminder(f.inputAt('2026-11-02T05:59:59Z'))).toBeNull();
expect(planReminder(f.inputAt('2026-11-02T06:00:00Z'))).toMatchObject({ localDate: '2026-11-02' });
await f.resumeAfterFiveWorkdays(); await f.pumpAgain(); expect(f.unreadEvents()).toHaveLength(1);
await f.subscribeAsViewer(); await f.markRead(); expect(f.causeOpen()).toBe(true);
expect(resolveNotificationRecipient(f.noRegistryWithPreference)).toBe(f.preferencePersonId);
expect(f.actor.profilePersonId).toBeNull(); expect(f.role()).toBe('viewer');
expect(f.sharedChanges()).toHaveLength(0);
```

- [ ] **Step 2:** `npm test -- src/features/execution/workbench-reminders.test.ts src/features/execution/workbench-notifications.test.ts` → FAIL missing functions.
- [ ] **Step 3:** Implement exact interfaces; BusinessCalendar/ReminderSettings shared drafts through PR, default dailyAt="09:00", repeatEveryWorkdays=1, Europe/Moscow; exception overrides weekday, duplicate date/invalid HH:mm rejected. Due date ends at next local midnight even on nonworking date, never shifted. Pump runs while app open with bounded polling/backoff and cancellation, recipients deduplicated, current cause per key, not a backlog of missed reminders. Differentiate new event/daily reminder/error; markRead personal read state only, subscription works without person identity. Source freshness issue, work/decision, PR/main/job event ingestion uses typed cause versions; repeated poll one event, errors preserve last state. Full registry never consulted by viewer endpoint; personal preference does not change Header.actor or grant. Restart keeps dedup/read state.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Test weekend deadline unchanged, configured working exception, no-recipient subscription routes, duplicate person from multiple assignments one event, other installation notification mark/read denied, offline polling neither merged nor declined. No Slack/email/network sender.
- [ ] **Step 5: Commit**

```text
git add src/features/execution/workbench-reminders.ts src/features/execution/workbench-notifications.ts src/features/execution/workbench-notification-store.ts src/features/execution/workbench-reminders.test.ts src/features/execution/workbench-notifications.test.ts
git commit -m "feat: add calendar based local notifications and subscriptions"
```

### T20: Схемы полей/дашбордов и личные предпочтения

**Deps / AC:** T17, T19; AC-45, AC-49, AC-55–AC-56. Spec 16 §8a, 17 §§4/4a. Deliverable: same registered schemas power forms/table/filter/dashboard; preferences remain personal.

**Files:** Create `src/features/knowledge/workbench-fields.ts`, `src/features/knowledge/workbench-dashboards.ts`, `src/features/system/workbench-preferences.ts`; Test `src/features/knowledge/workbench-fields.test.ts`, `src/features/knowledge/workbench-dashboards.test.ts`, `src/features/system/workbench-preferences.test.ts`.

**Interfaces:** `validateCustomFieldValue(definition:CustomFieldDef,value:CustomFieldValue['value']):void`; `describeWorkbenchForm(input:{formKind:string,ref:EntityRef|null},context:QueryContext):FormDescription` returns field schemas/enums/help/actions/editToken with no executable expressions. `validateDashboard(input:DashboardDef,resolver:DashboardReferencePort):void`; `createPreferencesService({repository,installationId,clock}):PreferencesService`; `.set(context:CommandContext,input:{values:PersonalPreferences}):Promise<{values:PersonalPreferences}>`, `.get(installationId:UUIDv4):PersonalPreferences`; `registerConfigurationCommands(registry,{drafts,preferences}):void` binds dashboard/customField.draft.save and preferences.set. PersonalPreferences type is T02 (context/sort/visual settings/optional notificationPersonId); no role/actor/registry settings.

Typed API extension approved in root addenda: `customFieldValue.draft.save` payload `{draftId:UUIDv4,definition:PartialDraftInput<CustomFieldValue>}`, effect sharedDraft/capability uor.prepare/sync, output DraftSaveResult. Full publication validation resolves exact fieldRef and objectRef in package/main, and invokes validateCustomFieldValue. No value is saved as an unknown property of Work/CoreGoalDefinition. Extend workbench-fields.ts registrar and field test with `await expect(f.saveValue(f.enumDef,'other')).rejects.toMatchObject({statusCode:422})` and valid draft retaining prior value revision after changed field definition.

- [ ] **Step 1: Write failing tests** `validates_all_seven_field_types_and_preserves_old_values`, `dashboard_uses_exact_registered_catalog_and_global_context`, `viewer_preferences_survive_publication_without_shared_write`.

```ts
expect(() => validateCustomFieldValue(f.enumDef, 'other')).toThrow();
expect(() => validateCustomFieldValue(f.multiEnumDef, ['A', 'A'])).toThrow();
expect(() => validateCustomFieldValue(f.decimalDef, '1e3')).toThrow();
expect(() => validateCustomFieldValue(f.dateDef, '2026-02-30')).toThrow();
expect(f.oldFieldValue(f.oldFieldRef)).toBe('A');
expect(() => validateDashboard(f.dashboardWithSql, f.refs)).toThrow();
expect(() => validateDashboard(f.dashboardWithLocalTime, f.refs)).toThrow();
expect(() => validateDashboard(f.metricFromOtherAssignment, f.refs)).toThrow();
await f.viewerSetPreferences(); await f.applyPublishedConfiguration();
expect(f.preferences()).toEqual(f.savedPreferences); expect(f.role()).toBe('viewer');
expect(f.publishedMethodRef()).toEqual(f.originalMethodRef);
```

- [ ] **Step 2:** `npm test -- src/features/knowledge/workbench-fields.test.ts src/features/knowledge/workbench-dashboards.test.ts src/features/system/workbench-preferences.test.ts` → FAIL missing schema services.
- [ ] **Step 3:** Implement exact interfaces. Register uor.dashboard.metric-card.v1, goal-table.v1, metric-trend.v1, execution-table.v1, data-issues.v1, scope-filter.v1 schemas exactly 17 §4a; ownerModuleId=uor via schema descriptor, settings.schemaId=typeId, schemaVersion=1. Strict layout w=3|6|12,h=1|2|3; limit integer 1..200; title in nonduplicate columns; kinds/levels unique nonempty, ordered levels include parents, filter unique. Metric/assignment refs compatible; agreed resolves saved basis; renderer consumes query result without formula. Seven field kinds and fieldRef validate same enum/date/Decimal rules, old definitions/values retained. forms.describe exposes identical schemas. Add configuration to DraftService owner schema dispatch, never direct shared overwrite. Personal set checks own installation, context path/known sort and optional public person ref, private policy keys rejected; common publication only updates shared namespace. Include personal prefs in backup ownership hook, policy cache excluded.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Test each valid block/schema and unknown type/version SCHEMA_UNSUPPORTED, repeated block IDs, bad metrics, missing title column, duplicate filter, enum null/non-null constraints. Verify field is descriptive only: add custom field changes no evaluation digest/result. Same definition feeds forms/table/filter/dashboard.
- [ ] **Step 5: Commit**

```text
git add src/features/knowledge/workbench-fields.ts src/features/knowledge/workbench-dashboards.ts src/features/system/workbench-preferences.ts src/features/knowledge/workbench-fields.test.ts src/features/knowledge/workbench-dashboards.test.ts src/features/system/workbench-preferences.test.ts
git commit -m "feat: register configurable fields dashboards and personal preferences"
```

### T21: Индексированные модели пяти экранов и общий поиск

**Deps / AC:** T09, T14–T20, T22 public package read port; AC-12–AC-16, AC-20, AC-22, AC-40–AC-41, AC-48–AC-49, AC-51, AC-53, AC-55. Spec 17 §§2–5,8,12; 19 §7. Deliverable: all published query names have real typed output without hidden capture/calculation.

**Files:** Create `src/features/catalog/workbench-read-models.ts`, `src/features/catalog/workbench-search.ts`, `src/features/catalog/workbench-read-index.ts`, `src/features/catalog/workbench-query-registration.ts`; Test `src/features/catalog/workbench-read-models.test.ts`, `src/features/catalog/workbench-search.test.ts`. Modify `src/server/workbench/application.ts` only to consume registered query module ports, not business rules.

**Interfaces:** `registerWorkbenchQueries(registry:QueryRegistry,ports:WorkbenchReadPorts):void`; ports expose indexed domain reads plus `queryHistorySeries` K02/T09, DraftService owner view, PublicationReadPort supplied T22, NotificationsReadPort, DashboardReadPort. `queryWorkbench(name:WorkbenchQueryName,input:QueryRequest,context:QueryContext):Promise<WorkbenchReadModel>` internal feature dispatcher uses name-specific schema; public registry output validates each union branch. `searchWorkbench(input:QueryRequest,context:QueryContext,index:SearchReadPort):Promise<SearchReadModel>`; SearchHit={ref:EntityRef,name:string,type:string,context:GlobalContext,route:string}, returned with stable page. `createWorkbenchReadIndex(repository:WorkbenchRepository):WorkbenchReadIndex` owns indexes, cursor encoding/digest and rebuild; no direct access from UI. Export types for every query DTO through `workbench-read-models.ts` for UI client generic calls.

- [ ] **Step 1: Write failing tests** `all_five_screen_queries_are_read_only_and_typed`, `rejects_stale_cursor_and_reads_frozen_agreed_basis`, `global_search_includes_archived_and_preserves_target_context`. Seed 2,000 rows plus historical revisions, two clusters, archived goal, manual goal and one ready numeric result; each case asserts no calls to source/calculation ports.

```ts
const before = f.repository.getStateRevision();
for (const name of ['overview', 'goals.list', 'execution.list', 'data.captures']) {
  expect((await f.query(name)).statusCode).toBe(200);
}
expect((await f.viewerQuery('uor.queue')).statusCode).toBe(403);
expect(f.repository.getStateRevision()).toBe(before); expect(f.captureSpy).not.toHaveBeenCalled();
expect((await f.goalWithoutResult()).needs_calculation).toBe(true);
expect((await f.manualGoal()).numericResult).toBeNull();
const page = await f.search('архив'); expect(page.items[0].ref).toEqual(f.archivedGoalRef);
expect(page.items[0].context.scopePath.clusterId).toBe(f.otherClusterId);
await f.changeIndexedRevision();
await expect(f.searchWithCursor(page.nextCursor)).rejects.toMatchObject({ code: 'CURSOR_STALE', statusCode: 409 });
expect(await f.readAgreedSnapshot()).toEqual(f.frozenAgreedView);
expect((await f.currentWithUnknownMergeTime()).active).toBe(true);
await expect(f.exactHistoricalBoundary()).rejects.toMatchObject({ code: 'EFFECTIVE_TIME_UNVERIFIED' });
const storedRefs = f.resultRefs(); f.clock.advanceHours(48);
expect((await f.currentGoal()).freshness).toBe('stale');
expect((await f.currentGoal()).canConfirm).toBe(false);
expect(f.resultRefs()).toEqual(storedRefs); expect(f.count('observed_fact')).toBe(f.initialFactCount);
```

- [ ] **Step 2:** `npm test -- src/features/catalog/workbench-read-models.test.ts src/features/catalog/workbench-search.test.ts` → FAIL missing registered queries/index.
- [ ] **Step 3:** Implement exact interfaces and all names: context.options; overview; goals.list/detail; execution.list/detail; data.captures/rows/lineage; history.series; snapshots.list; uor.queue/package; search; notifications.list; dashboards.view; forms.describe. Each strict filter/sort exactly 17 §8; default 50/max200, stable final sort ID; cursor signed/digested to context/filter/sort/read revision and installation/visibility. Validate context graph/mode/period; agreed without chosen snapshot returns explicit unavailable state, never current under agreed label. Source raw/enriched layers retain lineage; no invented zero/manual percent; numeric result refs/display/unit/coverage/quality/confirmation independent. Goal detail exposes all seven tab payloads and current nextActions. Index goals/products/leaders/works/decisions including archived; global search not constrained by current local scope, return target GlobalContext and route. Shared data visible to viewer, only own draft/capture/jobs/prefs; queue forbidden viewer. Archived goal omitted active overview, retained search/history/work. Confirmed unknown timestamp current works; exact-boundary action rejects, frozen agreed remains read-only. Join typed EntityRef, never bare package/anchor UUID. Current freshness/canConfirm uses pure T07 `projectEvaluationQuality(stored:NumericEvaluation,input:EvaluationInput):NumericEvaluation` from `src/features/evaluation/workbench/quality.ts` with server now: elapsed time can make ready stored result stale without changing basis digest, refs or persisting new result. No source call or materialization inside query.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Add SQLite EXPLAIN QUERY PLAN assertions uses owning indexes rather than history scans; page same IDs stable ties, context/filters cross-cursor 409, unsupported filter 422, malformed ref 404; UOR private projection leak negative test. Run deterministic fixture performance protocol (20 repeats, record hardware/runtime/history size/p50/p95/memory) for 2,000 rows and larger history; project target list/search p95≤500ms and normalize/evaluate≤2s, report measurement rather than asserting hardware-sensitive unit threshold. History remains accessible across index rebuild, no row deletion.
- [ ] **Step 5: Commit**

```text
git add src/features/catalog/workbench-read-models.ts src/features/catalog/workbench-search.ts src/features/catalog/workbench-read-index.ts src/features/catalog/workbench-query-registration.ts src/server/workbench/application.ts src/features/catalog/workbench-read-models.test.ts src/features/catalog/workbench-search.test.ts
git commit -m "feat: expose indexed workbench read models and global search"
```

## Стыки, продолжение после отказа и проверка части

1. T22 получает DraftService read/validate interface T17; package preview обязан повторить полную owner schema/ref validation, incomplete не публикуется. T12 registry не выполняет Git; JobSink передаётся PublishingService через deps. Внешние intent/effect reconciliation/gate принадлежат T22–T26.
2. T27–T29 получают module backup hooks для K01-owned data/personal preferences/local source history/drafts. Files в bundle только по verified handle/artifact hash. OwnPolicyCache/LocalSessionStore не входят ни в backup, ни в rescue; restore invalidates sessions and access cache, новая hostname check.
3. Для индексных и технических таблиц T03 даёт `repository.sqlForModule(moduleId:string):WorkbenchSql` на той же SQLite connection: `get<T>(sql:string,params:SqlValue[]):T|null`, `all<T>(sql:string,params:SqlValue[]):T[]`, `run(sql:string,params:SqlValue[]):{changes:number}`, `execMigration(id:string,ddl:string):void`; SqlValue определён T03. Статический trusted server SQL только для own `wb_<module>_*` projection/journal; entity history только repository.append. Feature store владеет схемой/индексом, короткая запись выполняется в той же repository.transaction. Не вводить отдельную несогласованную SQLite для факта/его индекса и не открывать SQL в UI/handler context.
4. Каждый FAIL шага 2 должен быть отсутствующей возможностью, не import typo/сломанная fixture; исправить тестовый setup до реализации. При FAIL после implementation сохранить draft/data, не идти к commit; исправить причину и повторить затронутые tests/build. Тестовые temp dirs удаляются только в verified temp root.
5. BP-02 блокирует реальное чтение закрытого реестра; BP-03/P-01 блокирует только корпоративный Qlik binding. Synthetic adapter доказывает pipeline, не готовность банка. BP-01/06 и точные merge-time metadata принадлежат публикации, не препятствуют файлам, manual_status, локальным моделям или current confirmed main.
6. После T21 выполнить один общий `npm test -- src/server/workbench src/features/identity/workbench-access-policy.test.ts src/features/connectors/workbench-source-service.test.ts src/features/tabular-import/workbench-parser.test.ts src/features/tabular-import/workbench-import.test.ts src/features/catalog/workbench-directory.test.ts src/features/catalog/workbench-drafts.test.ts src/features/evidence/workbench-evidence.test.ts src/features/execution/workbench-execution.test.ts src/features/execution/workbench-reminders.test.ts src/features/execution/workbench-notifications.test.ts src/features/knowledge/workbench-fields.test.ts src/features/knowledge/workbench-dashboards.test.ts src/features/system/workbench-preferences.test.ts src/features/catalog/workbench-read-models.test.ts src/features/catalog/workbench-search.test.ts`, затем `npm run build`. Записать runtime/command/exit code/новый результат; старые счётчики не переносить.
7. Передача UI T30–T38: protocol types T10, service query DTO T21, registered descriptors T13. Все UI действия идут через K04 client, unknown defaultContext=null корректен на пустой установке. T39 отдельно выключает старые парольные/legacy write endpoints после migration, здесь действующий startup не переключается.
