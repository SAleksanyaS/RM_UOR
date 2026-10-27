# ОКО: запись и воспроизведение действий в Сбербраузере — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Без skill/tool выполнять тот же порядок обычными npm/Git; никакие Codex API исполнителю не обязательны.

**Goal:** Дать куратору записать получение файла из отчёта ОКО в личном Сбербраузере, проверить/опубликовать сценарий и затем автоматически воспроизводить опубликованные действия у сотрудников.

**Architecture:** Развить существующий Playwright recorder/runtime, используя отдельный собственный persistent browser profile. Сценарий с разрешёнными действиями — общая версионная сущность через draft/PR; путь браузера, cookies, вход и сертификаты — приватные настройки рабочего места. Воспроизведение отдаёт настоящий downloaded file конвейеру T14–T16, не создаёт отдельный evaluator и не требует Engine API.

**Tech Stack:** Node.js **22.16.0**, npm **10.9.2**, существующий Playwright **1.64.1**, TypeScript/Zod/Fastify/Vitest, React 19; Python **3.13.5** допустим, новый worker не нужен. Production browser executable Сбербраузера подтверждается BP-03; Edge/Chromium используется только для локальных синтетических integration fixtures.

**Spec:** [21 — браузерный сценарий ОКО](../../specs/2026-10-28-uor-workbench/21-oko-browser-scenarios.md), [15](../../specs/2026-10-28-uor-workbench/15-access-policy.md), [16](../../specs/2026-10-28-uor-workbench/16-data-calculation-contract.md), [17](../../specs/2026-10-28-uor-workbench/17-interface-api-contract.md), [18](../../specs/2026-10-28-uor-workbench/18-integration-operations-contract.md), [19](../../specs/2026-10-28-uor-workbench/19-acceptance-delivery-contract.md); [02](02-platform-data-and-api.md), [CONTRACTS](CONTRACTS.md). Checkout `RM_UOR`, ветка `codex/uor-workbench-rebuild`, базовый commit `3d8704e4a6ff2195af4f2c0602ed11bff5d38f4b`.

## Global Constraints

- Пользователь выбрал основной способ ОКО: открыть/подключить Сбербраузер → войти вручную → отчёт → записать клики/фильтры/download → закончить/сохранить → воспроизводить. Доступ к Qlik Engine не является обязательной предпосылкой.
- Никакой actual browser/UI, банковской сети или пользовательского профиля при подготовке этого плана не открывать. Реальные действия — только при реализации и согласованной пробе.
- SourceDefinition.kind остаётся `qlik`; `browserScenarioRef` ссылается на принятую редакцию `browser_scenario`. Не превращать ОКО в file/manual fallback.
- Reader воспроизводит только published scenario; curator/chief записывает/тестирует собственный draft, после PR/main сценарий общий. Обычный читатель не меняет колонки, шаги или shared фильтры.
- Роль/автор — hostname policy; OS/Git/SSO-разрешения самостоятельны. `X-CSRF-Token` из SessionView; только `/api/v1` registry/commands, без нового legacy API.
- Вход выполняется в настоящем браузере; пароли/OTP/QR/токены/cookies/login interaction не включаются в действия, снимки или пакет. TLS проверки/корпоративные hooks не отключаются.
- Сценарий содержит declarative allowlist действий; без JS/eval/shell/CDP command payload из формы. Селекторы однозначны, шаги и timeout ограничены; hard sleep не является ожиданием готовности.
- Download обязателен, реальный файл непустой и проверенный. Успешный click/HTTP/window closed не означает успешного получения/входа/полноты.
- Cookies/профиль/закрытые ключи/private config никогда не входят в PR/main/backup/rescue. Новое устройство требует своего входа; общий сценарий не переносит сессию.
- До T39 legacy startup не меняется; T42–T48 используют новую фабрику/API. Все проверки имеют current runtime/result; старые акты Edge не доказывают новую реализацию или Сбербраузер.

## Review Focus

1. SPA-логин на корневом URL с видимым QR/password: recorder остаётся выключен до явного authenticated boundary; T43 `never_records_login_or_hidden_secrets`.
2. Два одновременно открытых запроса к одному profile: один managed context/очередь, чужой браузерный профиль не присоединяется; T42 `isolates_managed_profile_and_releases_cancelled_waiter`.
3. Изменившийся selector или файл не скачался: сохранён старый capture, job говорит ошибку этапа; T45 `requires_unique_selector_and_completed_nonempty_download`.
4. Успех входа у одного сотрудника: cookies не оказываются у другого; T47 `same_scenario_requires_own_profile_and_authentication`.
5. Экспорт показывает первую страницу 50 строк из 2,000: неполнота не объявляется успешным полным набором; T44 `preview_requires_export_coverage_evidence`, T48 BP-03 protocol.

---

## Проверенные исходники и границы повторного использования

- `src/features/connectors/browser.ts`: `openBrowser(runtime,profile)`, `startRecording(runtime,owner,profile,startUrl,observe,authenticatedSelector,onClosed)`, `finishRecording(runtime,owner,id,save)`, `executeBrowser(runtime,profile,scenario,parameters,signal)`, `stopAllRecordings()`. Есть launchPersistentContext, allowlist requests/WebSocket/redirect, serviceWorkers:block, masked screenshots, private download cleanup, profile queue. Это reuse point, не повод дублировать Node helper в Python.
- `src/features/connectors/contracts.ts`: `stepSchema`, `scenarioSchema`, private browser executable/channel/profileDirectory/auth pattern/certificates. Сейчас scenarioSchema допускает пустые steps и не требует download; проверка нового полного сценария должна это исправить на owner schema boundary.
- `src/features/connectors/transport.ts`: `checkedUrl`, `browserProfilePath`, `withProfileQueue`, `Downloaded`. Private profile path внутри runtime; TLS не отключается. `private-config.ts` сохраняет личные настройки атомарно с CAS, без env values.
- `src/features/connectors/routes.ts`: старые recorder/login/profile HTTP handlers привязаны к legacy RoleService/Session и не переносятся в новую сборку. Переиспользовать runtime через порт, а не объявлять эти пути обходом new policy.
- `src/features/connectors/ConnectorPage.tsx`, `PrivateProfileEditor.tsx`: есть формы профиля/записи/параметров, но legacy fetch/role/JSON editor не подходят для нового основного пути. Их UI поведение переносится в отдельный мастер, данные идут через WorkbenchClient.
- `src/features/connectors/connectors.test.ts`: действующие реальные Edge fixtures покрывают download/recorder/origin/auth boundary, но используют таймеры. Новые deterministic tests ожидают locator/event/state, не копируют `waitForTimeout`/sleep из старых tests.
- Прочитаны `docs/BANK_CONNECTORS_RUNBOOK.md`, `docs/guides/runtime-versions.md`. Реальная СберОС/SSO/ГОСТ/smartcard и Chromium executable не доказаны локальным Edge.

Все изменения ограничены connectors slice, его явными owner hooks и planned UI integration. Перед каждой задачей git status/branch/HEAD; без reset/clean/копирования runtime. Приведённые `f` — fixtures конкретного теста, создаваемые из fake BrowserRuntimePort или локальной HTML страницы; не production fallback.

### T42: Собственный браузерный профиль и управляемый runtime port

**Deps / AC:** T10–T14, T20; AC-20, AC-40–AC-45, AC-56; browser requirements spec21. Deliverable: private browser binding without changing public source.

**Files:** Create `src/domain/workbench/browser-scenario.ts`, `src/features/connectors/workbench-browser-runtime.ts`, `src/features/connectors/workbench-browser-profile.ts`; Modify `src/domain/workbench/index.ts` (new owner exports), `src/features/connectors/browser.ts` (injectable launcher seam, existing exports remain compatible); Test `src/domain/workbench/browser-scenario.test.ts`, `src/features/connectors/workbench-browser-profile.test.ts`, `src/features/connectors/workbench-browser-runtime.test.ts`.

**Interfaces:** `BrowserOwner={installationId:UUIDv4,profilePersonId:UUIDv4|null}`. `BrowserProfileBinding={sourceId:UUIDv4,profileId:string}` personal only. `BrowserRuntimePort={openLogin(input:BrowserLoginInput,signal:AbortSignal):Promise<BrowserSessionHandle>,startRecording(input:BrowserRecordInput,signal:AbortSignal):Promise<BrowserSessionHandle>,finish(input:{handleId:UUIDv4,owner:BrowserOwner,save:boolean}):Promise<RecordedBrowserScenario>,replay(input:BrowserReplayInput,signal:AbortSignal):Promise<Downloaded>,closeOwned(owner:BrowserOwner):Promise<void>}`. `BrowserSessionHandle={handleId:UUIDv4,state:'open',mode:'login'|'record'}`; handle is mapped privately to existing recorder ID/context. `createBrowserRuntime({runtimeRoot:string,launcher:BrowserLauncherPort}):BrowserRuntimePort` wraps existing browser functions. `BrowserLauncherPort.launchPersistent(profile:PrivateProfile,profilePath:string):Promise<BrowserContext>` injects real Playwright or fake; no arbitrary browser/session attach URL from client.

`BrowserProfileService.set(context:CommandContext,input:{sourceId:UUIDv4,profileId:string,profile:PrivateProfile,expectedRevision:string|null}):Promise<{profileId:string,revision:string}>` reuses savePrivateProfile. `getOwn(context:QueryContext,sourceId:UUIDv4):Promise<BrowserProfileView>` returns only own safe settings and configured/auth state; no cookie/env values.

`createBrowserProfileService({runtimeRoot:string,repository:WorkbenchRepository,clock:Clock}):BrowserProfileService`; `BrowserProfileView={sourceId:UUIDv4,profileId:string|null,profile:PrivateProfile|null,revision:string|null,configured:boolean,sessionState:'closed'|'open'|'authentication_required'|'authenticated'}`. Own profile contains only already-typed env names/cert paths and browser settings, never resolved env values. Runtime state is observed, not derived from stored cookie existence. Register own query only, no endpoint listing profiles of another owner.

T42 domain exports one exact wire, no replacement of legacy `BrowserStep`:

```ts
type StableBrowserLocator =
 | { kind: 'css'; selector: string }
 | { kind: 'role'; role: BrowserAriaRole; name: string; exact: true }
 | { kind: 'label'; text: string; exact: true };
type RecordedBrowserStep =
 | { action: 'goto'; url: string }
 | { action: 'click' | 'wait' | 'download'; locator: StableBrowserLocator; framePath?: StableBrowserLocator[] }
 | { action: 'fill' | 'select'; locator: StableBrowserLocator; parameter: string; framePath?: StableBrowserLocator[] }
 | { action: 'check'; locator: StableBrowserLocator; checked: boolean; framePath?: StableBrowserLocator[] };
type BrowserScenarioDefinition = Header & {
 sourceId: UUIDv4; startUrl: string; authenticatedSelector: string;
 steps: RecordedBrowserStep[]; parameters: Record<string,string>;
 expectedExport: { format: 'csv'|'xlsx'; requiredColumns: string[] };
};
```

Export `stableBrowserLocatorSchema`, `recordedBrowserStepSchema`, `browserScenarioDefinitionSchema` from browser-scenario.ts/index.ts; entity type browser_scenario owned by connectors. `BrowserAriaRole` is exact subset button/link/combobox/textbox/checkbox/option/tab/menuitem/radio/dialog/heading/table/row/cell/listbox; unsupported role rejected rather than guessed. CSS unique, role/label exact matching; framePath nonempty when present and each locator resolves one allowed same-origin report iframe. Last step exactly one download; max100 steps, URLs strict HTTP(S), no credentials/secret query parameters. requiredColumns nonempty unique. Partial drafts can omit business fields, complete schema cannot. Add test `expect(browserScenarioDefinitionSchema.safeParse(f.twoDownloads()).success).toBe(false)` and unknown action/role negative assertions in domain test; Header spoof rejected at draft command T44.

- [ ] **Step 1: Write failing tests** `isolates_managed_profile_and_releases_cancelled_waiter`, `viewer_profile_save_is_personal_and_cas_protected`, domain `rejects_duplicate_download_and_unknown_aria_role`. Fixture injects fake launcher/context, temporary runtime and deferred queue gate; schema fixture uses T02 makeHeader/fixtureId and one final download.

```ts
const first = await f.openOwnLogin();
expect(f.launchPath()).toContain('browser-profiles');
expect(f.launchPath()).not.toContain(f.normalUserBrowserProfile);
const queued = f.openSecondOnSameProfile(); f.abortSecond(); await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
expect(f.maxConcurrentContexts()).toBe(1);
await f.close(first); expect(await f.openThird()).toMatchObject({ state: 'open' });
await f.viewerSaveProfile(); expect(f.sharedSource()).toEqual(f.originalSource);
await expect(f.saveWithOldRevision()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
expect(JSON.stringify(f.exportableOwnedData())).not.toContain('cookies');
expect(browserScenarioDefinitionSchema.safeParse(f.scenarioWithTwoDownloads()).success).toBe(false);
expect(stableBrowserLocatorSchema.safeParse({kind:'role',role:'invented',name:'Export',exact:true}).success).toBe(false);
expect(recordedBrowserStepSchema.safeParse({action:'evaluate',script:'return 1'}).success).toBe(false);
```

- [ ] **Step 2:** `npm test -- src/domain/workbench/browser-scenario.test.ts src/features/connectors/workbench-browser-profile.test.ts src/features/connectors/workbench-browser-runtime.test.ts` → FAIL missing port/service.
- [ ] **Step 3:** Implement exact interfaces. Runtime owner key is installation+profile person; do not accept owner/role from browser payload. Validate configured executable as local file and profile slug/root/symlink; launch Sber executable through existing Playwright persistent context, show real window for recording/login. Reuse an already managed own context if open; an externally busy profile returns explicit PROFILE_IN_USE, never copies everyday profile or attaches to arbitrary debug endpoint. Personal profile save uses typed personal.write command, exact origin list, expectedRevision CAS; translates legacy config conflict to REVISION_CONFLICT. Keep passwords/env/cert values in OS/native flow, no secret form. Binding/profile store outside portable data; backup hook excludes it. Close/abort releases queue and temporary downloads; shutdown closes only app-owned contexts.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Verify launch failure/profile missing gives configuration diagnostic and zero capture; other owner cannot finish/open private handle. Changing executable/binding does not change method/source revision. No Playwright/browser launched by unit tests.
- [ ] **Step 5: Commit**

```text
git add src/domain/workbench/browser-scenario.ts src/domain/workbench/index.ts src/domain/workbench/browser-scenario.test.ts src/features/connectors/workbench-browser-runtime.ts src/features/connectors/workbench-browser-profile.ts src/features/connectors/browser.ts src/features/connectors/workbench-browser-profile.test.ts src/features/connectors/workbench-browser-runtime.test.ts
git commit -m "feat: bind private managed browser profiles to workbench sources"
```

### T43: Recorder после входа, безопасные действия и приватные снимки

**Deps / AC:** T42; AC-22, AC-41, AC-49, AC-55; spec21 security. Deliverable: sanitized declarative recording, no shared save/acceptance.

**Files:** Create `src/features/connectors/workbench-browser-recorder.ts`, `src/features/connectors/workbench-browser-locators.ts`; Modify `src/features/connectors/browser.ts` (event-driven recorder status/drain + no login capture); Test `src/features/connectors/workbench-browser-recorder.test.ts`.

**Interfaces:** `BrowserScenarioDefinition`/`RecordedBrowserStep` use single owner schema spec21, reuse allowlist goto/click/fill/select/check/wait/download; no eval. `createBrowserRecorderService({runtime:BrowserRuntimePort,repository:WorkbenchRepository,jobs:JobStore,clock:Clock}):BrowserRecorderService`; `.start(context:CommandContext,input:{sourceRef:VersionRef,startUrl:string,authenticatedSelector:string}):Promise<{recordingId:UUIDv4,state:'recording'}>`; `.finish(context,input:{recordingId:UUIDv4,save:boolean}):Promise<RecordedBrowserScenario>`. `RecordedBrowserScenario={recordingId:UUIDv4,startUrl:string,authenticatedSelector:string,steps:RecordedBrowserStep[],parameterNames:string[],screenshotHandles:UUIDv4[],hasDownload:boolean}`; this is private unsaved review DTO. `.screenshot(context:QueryContext,recordingId:UUIDv4,handleId:UUIDv4):Promise<{bytes:Uint8Array,mediaType:'image/png'}>` owner-only read, no public path. `BrowserLoginInput={owner:BrowserOwner,profile:PrivateProfile,startUrl:string,authenticatedSelector:string}`; `BrowserRecordInput=BrowserLoginInput`; `BrowserReplayInput={owner:BrowserOwner,profile:PrivateProfile,scenario:BrowserScenarioDefinition}`. `resolveRecordedLocator(page:Page,framePath:StableBrowserLocator[]|undefined,locator:StableBrowserLocator,profile:PrivateProfile):Promise<Locator>` in locators.ts validates every frame/locator exactly once before action; returns no DOM/HTML to client.

- [ ] **Step 1: Write failing tests** `never_records_login_or_hidden_secrets`, `records_unique_source_filters_and_download_without_values`, `finish_drains_events_and_cannot_read_foreign_screenshots`. Use fake runtime event source; T47 later actual browser pins same behavior.

```ts
await f.emitLoginEvents({ otp: '123456', password: 'synthetic-secret', qrVisible: true });
expect(f.recordedSteps()).toEqual([]); expect(f.screenshots()).toEqual([]);
await f.setAuthenticatedBoundary(); await f.emitFilterChange('period', '2026-10-01'); await f.emitDownload('#export');
const recording = await f.finish();
expect(recording.steps).toContainEqual({ action: 'fill', locator: { kind: 'css', selector: '#period' }, parameter: 'field_period' });
expect(recording.hasDownload).toBe(true);
expect(JSON.stringify(recording)).not.toMatch(/123456|synthetic-secret|2026-10-01/);
expect(f.lastMask()).toEqual(expect.arrayContaining(['input', 'textarea', 'select', 'iframe']));
await expect(f.otherOwnerReadScreenshot()).rejects.toMatchObject({ statusCode: 404 });
```

- [ ] **Step 2:** `npm test -- src/features/connectors/workbench-browser-recorder.test.ts` → FAIL missing recorder service/schema.
- [ ] **Step 3:** Implement exact interfaces, reuse startRecording(...observe=true,authenticatedSelector) and finishRecording(...save=false) so raw recording is reviewed before shared draft. Require unique visible authenticated marker AND absent visible auth indicators; check source origin/SSO path for every event/screenshot, including same-origin report framePath. Extend the legacy mainFrame-only recorder deliberately for allowed same-origin report frames; auth/cross-origin/unsupported frame produces explicit unsupported problem, never records login or silently claims full scenario. Bind listeners before navigation. Filter secret selectors/fields/form descendants and hidden/file/OTP/password inputs; never record values, request headers, bodies or storage state. Safe fill/select stores parameter name only. Prefer exact role/label, then data-testid/id/name CSS; count!=1 rejects and surfaces unresolved selector rather than guesses nth-child. Adapter maps legacy selector-string steps to CSS locator and uses new resolver for role/label/frame steps; old BrowserStep type stays intact. Keep 100-action/15-minute recording technical limits explicit; wait uses visibility/assertion, not sleep. Event queue drain on finish ensures last click/download retained even asynchronous event ordering. Snapshot text is potentially private: masked screenshots remain own local artifacts and excluded from package/backup. Manual login mode installs no recorder/binding and takes no snapshots; NSS/mTLS/SSO has no assumed password form.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Assert spoofed binding events/foreign frames ignored, login appearing mid-recording pauses recording, hidden authenticated marker insufficient, ambiguous selector diagnostic, no download -> review complete=false and cannot publish. Finishing/cancelling twice safely closes own resource; operation reports opened/closed, not authenticated/captured.
- [ ] **Step 5: Commit**

```text
git add src/features/connectors/workbench-browser-recorder.ts src/features/connectors/workbench-browser-locators.ts src/features/connectors/browser.ts src/features/connectors/workbench-browser-recorder.test.ts
git commit -m "feat: record safe authenticated source actions for review"
```

### T44: Версионный scenario draft, параметры и проверка экспорта

**Deps / AC:** T15–T17, T43; AC-16, AC-22, AC-26, AC-49, AC-55; spec21. Deliverable: testable publishable scenario with no accepted fact from preview.

**Files:** Create `src/features/connectors/workbench-browser-scenarios.ts`, `src/features/connectors/workbench-browser-commands.ts`; Modify `src/features/catalog/workbench-draft-commands.ts` (owner scenario save), `src/features/connectors/workbench-source-contracts.ts` (browser port binding); Test `src/features/connectors/workbench-browser-scenarios.test.ts`.

**Interfaces:** `BrowserScenarioService.save(context:CommandContext,input:{draftId:UUIDv4,definition:PartialDraftInput<BrowserScenarioDefinition>}):Promise<DraftSaveResult>`; `.test(context,input:{draftId:UUIDv4}):Promise<BrowserScenarioTestResult>`; `.resolvePublished(sourceRef:VersionRef):BrowserScenarioDefinition`. `BrowserScenarioTestResult={draftId:UUIDv4,scenarioRef:EntityRef,inputHash:Sha256,downloadedBytes:number,acceptedPreviewRows:number,rejectedPreviewRows:number,complete:boolean,problems:FieldProblem[]}`. Test invokes replay+T15 parser+T16 enrichment in preview mode, writes diagnostic/test receipt only, not Capture/fact/last-success. `registerBrowserCommands(registry:CommandRegistry,services:BrowserServices):void` declares typed descriptors/capabilities from command matrix below; persisted scenario owner validates schema/ref integrity before T22 serialization.

`BrowserServices={profiles:BrowserProfileService,recorder:BrowserRecorderService,login:BrowserLoginService,scenarios:BrowserScenarioService}`; registrar uses exact results from each service and T12 CommandOutcome. Schema from T42 expectedExport only format/requiredColumns; no free-text coverageRule or second expected population. Each declared required column must exist; completeness derives from actual mapping and published GoalAssignment.expectedPopulation, never received row count alone. Parameters are entered/confirmed once after recording and persisted in revision; replay re-applies them each run and verifies selected report state before final download.

`createBrowserScenarioService({repository:WorkbenchRepository,drafts:DraftService,runtime:BrowserRuntimePort,profiles:BrowserProfileService,parser:typeof parseWorkbenchTable,enricher:EnricherPort,clock:Clock}):BrowserScenarioService`. It owns read/test schema registration for browser_scenario, command registration is a separate call. Source rows are tested against the exact SourceFieldMapping parsingProfile and requiredColumns, not a second CSV implementation.

- [ ] **Step 1: Write failing tests** `preview_requires_export_coverage_evidence`, `scenario_draft_save_requires_safe_parameters_and_download`, `reader_resolves_only_published_revision`.

```ts
expect((await f.savePartial({ startUrl: f.reportUrl })).complete).toBe(false);
expect((await f.saveCompleteWithoutDownload()).complete).toBe(false);
expect(f.packageValidation()).toContainEqual(expect.objectContaining({ code: 'DOWNLOAD_REQUIRED' }));
await expect(f.saveWithParameter('password', 'x')).rejects.toMatchObject({ statusCode: 422 });
const before = f.acceptedCounts(); const tested = await f.testOwnDraft();
expect(tested.downloadedBytes).toBeGreaterThan(0); expect(f.acceptedCounts()).toEqual(before);
expect(f.lastSuccessfulCapture()).toEqual(f.previousCapture);
expect(f.resolveAsViewer()).toEqual(f.publishedScenario); expect(f.resolveAsViewer()).not.toEqual(f.draftScenario);
expect((await f.testTruncatedExport()).complete).toBe(false);
expect(f.packageValidation()).toContainEqual(expect.objectContaining({ code: 'EXPORT_COVERAGE_UNVERIFIED' }));
```

- [ ] **Step 2:** `npm test -- src/features/connectors/workbench-browser-scenarios.test.ts` → FAIL missing scenario service/commands.
- [ ] **Step 3:** Implement exact signatures; SourceDefinition browserScenarioRef resolves `browser_scenario` exact VersionRef, cross-linked draft IDs permitted only own package. Scenario full schema requires explicit report URL/auth marker, at least one download, all referenced parameter names supplied with safe non-secret values and explicit format/mapping/coverage evidence; recursive partial save uses T17, full publication validation blocks missing/incomplete fields. No executable/credential/private profile properties accepted in shared scenario. Parameters enter through labeled controls and explicit values, no captured raw values; same schema validation at save/preview/submit. Test receipt binds scenario revision/mapping ref/source ref/content hash; edits invalidate previous test. Coverage checked against observed export metadata/probe evidence and selected expected population, never assumed from success/file existence. Unverified 50/2000-page export returns explicit problem; preview can display rows but not full readiness. Shared version activates only after confirmed main; test/save do not send PR.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Test source/goal swap, foreign draft, expired test receipt, unsupported action, unknown key, parameter missing and secret URL query/userinfo rejected. Full valid scenario serializes only declarative scenario/settings, no screenshots/private profile; preview result shows raw/enriched/error counts and reasons.
- [ ] **Step 5: Commit**

```text
git add src/features/connectors/workbench-browser-scenarios.ts src/features/connectors/workbench-browser-commands.ts src/features/catalog/workbench-draft-commands.ts src/features/connectors/workbench-source-contracts.ts src/features/connectors/workbench-browser-scenarios.test.ts
git commit -m "feat: validate and draft recorded source scenarios"
```

### T45: Воспроизведение, повтор после входа и локальное принятие

**Deps / AC:** T12, T14–T16, T44; AC-20–AC-21, AC-23, AC-26, AC-30, AC-43; spec21. Deliverable: source.capture reads actual published browser scenario and preserves fallback on failure.

**Files:** Create `src/features/connectors/workbench-browser-source.ts`; Modify `src/features/connectors/browser.ts` (unique selector/auth/download readiness), `src/features/connectors/workbench-source-service.ts` (browser adapter selection), `src/server/workbench/jobs.ts` (source login nextAction registration); Test `src/features/connectors/workbench-browser-source.test.ts`.

**Interfaces:** `createBrowserSourceAdapter({runtime:BrowserRuntimePort,profiles:BrowserProfileService,scenarios:BrowserScenarioService,clock:Clock}):SourceAdapter`; implements check/collect T14. `BrowserLoginService.open(context:CommandContext,input:{sourceRef:VersionRef}):Promise<{loginId:UUIDv4,windowOpened:true}>`; `.finish(context,input:{loginId:UUIDv4}):Promise<{loginId:UUIDv4,authenticated:boolean}>`. Browser auth diagnostic uses `AUTH_REQUIRED` with stage browser.auth in SourceIssue; Job Problem uses `AUTH_REQUIRED`, provider=null with nextAction source.browser.login.open then job.retry. `resumeBrowserCapture(jobId:UUIDv4,context:CommandContext):Promise<CaptureResult>` keeps original source/scenario refs and command identity, rechecks published config/ownership/access before recollect; changed refs require new capture request rather than stale acceptance.

`createBrowserLoginService({runtime:BrowserRuntimePort,profiles:BrowserProfileService,scenarios:BrowserScenarioService,repository:WorkbenchRepository}):BrowserLoginService`; login handle ownership matches BrowserOwner. Published BrowserScenarioDefinition.startUrl/authenticatedSelector gives source boundary; no guessed password page. `windowOpened:true` is success of opening only; authenticated true requires live report-boundary observation, not closing a window or finding a cookie file.

- [ ] **Step 1: Write failing tests** `requires_unique_selector_and_completed_nonempty_download`, `login_retry_reuses_job_and_never_accepts_login_html`, `cancel_keeps_previous_capture_and_releases_profile`.

```ts
f.runtime.expireLogin(); const accepted = f.lastSuccessfulCapture();
await f.captureAsViewer(); expect(f.job()).toMatchObject({ status: 'waiting_user', result: null });
expect(f.job().nextAction).toMatchObject({ commandName: 'source.browser.login.open' });
await f.openLogin(); expect(f.job().status).not.toBe('succeeded');
await f.finishLoginWithVisibleMarker(); await f.retryOriginalJob();
expect(f.job().jobId).toBe(f.originalJobId); expect(f.acceptedNewCaptures()).toHaveLength(1);
f.runtime.noDownload(); await expect(f.capture()).rejects.toMatchObject({ code: 'DOWNLOAD_REQUIRED' });
expect(f.lastSuccessfulCapture()).not.toEqual(null);
f.runtime.downloadLoginHtml(); await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_SCHEMA_CHANGED' });
expect(f.lastSuccessfulCapture()).not.toEqual(f.failedCandidateRef);
await f.cancelBeforeCommit(); expect(f.lastSuccessfulCapture()).toEqual(f.captureBeforeCancel);
expect(f.runtime.activeContexts()).toBe(0);
```

- [ ] **Step 2:** `npm test -- src/features/connectors/workbench-browser-source.test.ts` → FAIL missing browser SourceAdapter.
- [ ] **Step 3:** Implement exact adapter/login/resume signatures using executeBrowser and T14 pipeline. Capture uses published scenario only for every role; curator private draft test remains T44. Map expired SSO/visible auth marker/HTTP auth into waiting_user, no automatic login/credential collection; open login shows actual owned browser without recorder, finish verifies unique authenticated selector rather than trusts close/click. Retry same job stages, same command idempotency, zero duplicate captures. Replay each step validates current origin/frame/unique locator/safe field; use locator wait/state/download event, no sleeps. Mandatory successful completed nonempty download, bounded bytes/content and filename; reject HTML login/error masquerading XLSX/CSV. Abort/timeout removes partial download and context but accepted source cache untouched. Parse/normalize/enrich/coverage outside short atomic commit; recheck scenario/mapping/main/basis guards and capability. Keep business date, lineage and original raw bytes; network/SSO failure displays last local/Git fact with old date, no new Capture for fallback.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Check changed selector -> SELECTOR_NOT_UNIQUE/SELECTOR_NOT_FOUND safe error, no zero; conflicting profile serialization; capture after new main source ref rejects stale acceptance. New collection same value allowed real capture, repeated original command one result. Source adaptation has no evaluator duplication/Attestation/PR.
- [ ] **Step 5: Commit**

```text
git add src/features/connectors/workbench-browser-source.ts src/features/connectors/browser.ts src/features/connectors/workbench-source-service.ts src/server/workbench/jobs.ts src/features/connectors/workbench-browser-source.test.ts
git commit -m "feat: replay published browser sources with recoverable login"
```

### T46: Мастер без JSON — профиль → запись → проверка → пакет

**Deps / AC:** T30–T34, T44–T45; AC-40–AC-41, AC-49, AC-52, AC-55; spec21. Deliverable: keyboard-usable source flow in new app, reader only own login/replay.

**Files:** Create `src/features/connectors/workbench/BrowserScenarioWizard.tsx`, `src/features/connectors/workbench/BrowserProfileForm.tsx`, `src/features/connectors/workbench-browser.css`; Test `src/features/connectors/workbench/BrowserScenarioWizard.test.tsx`, `src/features/connectors/workbench/BrowserProfileForm.test.tsx`; Modify `src/features/sources/workbench/SourceSetupWizard.tsx` (`WorkbenchSourceSetupWizard` from T34); not legacy ConnectorPage routes.

**Interfaces:** `WorkbenchBrowserScenarioWizard({sourceRef:VersionRef,draftId:UUIDv4|null,onDraftSaved:(draftId:UUIDv4)=>void}):JSX.Element`; consumes WorkbenchProvider/client and forms.describe, queries own browser state. `WorkbenchBrowserProfileForm({sourceRef:VersionRef,onSaved:()=>void}):JSX.Element` edits private own config, no shared source save. `WorkbenchSourceSetupWizard` statically imports BrowserScenarioWizard for source.kind=qlik; no new arbitrary executable form contribution contract.

- [ ] **Step 1: Write failing tests** `curator_records_reviews_filters_and_saves_draft_without_json`, `viewer_can_login_and_capture_but_cannot_record`, `background_job_preserves_form_and_focus`. Use T30 UI harness real app.inject with fake BrowserRuntimePort; no real browser in component tests.

```tsx
await f.renderAs('curator'); await f.enterReportUrl(); await f.click('Открыть Сбербраузер и записать действия');
expect(f.sentCommand().name).toBe('source.browser.record.start');
await f.completeRecording(); expect(f.screen.getByLabelText('Значение фильтра «Период»')).toBeVisible();
expect(f.screen.queryByRole('textbox', { name: /JSON/i })).toBeNull();
await f.fillSafeFilterAndTest(); await f.click('Сохранить сценарий в черновик');
expect(f.sentCommand().name).toBe('source.browserScenario.draft.save'); expect(f.publicationCalls()).toBe(0);
await f.renderAs('viewer'); expect(f.screen.queryByRole('button', { name: /записать действия/i })).toBeNull();
expect(f.screen.getByRole('button', { name: 'Открыть браузер для входа' })).toBeEnabled();
await f.typeFilter('Незавершённый ввод'); await f.backgroundJobUpdate();
expect(f.screen.getByLabelText('Значение фильтра «Период»')).toHaveValue('Незавершённый ввод');
```

- [ ] **Step 2:** `npm test -- src/features/connectors/workbench/BrowserScenarioWizard.test.tsx src/features/connectors/workbench/BrowserProfileForm.test.tsx` → FAIL missing components.
- [ ] **Step 3:** Implement exact components/hook. Form steps show local browser/profile/configured sites, report URL, authenticated boundary selection/help, record/finish/cancel, ordered human-readable actions, safe parameter controls, test preview with actual rows/issues/coverage and save draft. Source setup selects this flow by default for ОКО; no required Engine endpoint/appId/objectId/JSON/SQL. Separate shared scenario from own executable/login. Show native browser handoff explanation, actual recording/window/job state, previous successful data/date, explicit source auth/selector/download failures and retry action. Saving creates local draft and links to package preview; no publish per recording. Reader sees own login/profile and capture controls for published source, no recorder/step/shared parameter editor. Keyboard step navigation, labels/errors/live status, cancel focus return, 320/360/1024 widths, no horizontal page scroll; no secrets entry fields. Changing screen does not cancel capture, unsaved form input preserved on polls.
- [ ] **Step 4:** Same tests → PASS; `npm run build` → exit 0. Test empty/unconfigured/profile-in-use/loading/offline/error/partial, field values retained after validation, successful save updates editToken; recorder revoked mid-flow cannot save shared draft but local review remains. Actual browser visual review later T47; component tests do not claim real Sber browser operation.
- [ ] **Step 5: Commit**

```text
git add src/features/sources/workbench/SourceSetupWizard.tsx src/features/connectors/workbench/BrowserScenarioWizard.tsx src/features/connectors/workbench/BrowserProfileForm.tsx src/features/connectors/workbench-browser.css src/features/connectors/workbench/BrowserScenarioWizard.test.tsx src/features/connectors/workbench/BrowserProfileForm.test.tsx
git commit -m "feat: add guided browser recording and source preview forms"
```

### T47: Настоящий локальный browser fixture и полный v1 сценарий

**Deps / AC:** T42–T46; AC-20–AC-26, AC-30, AC-41, AC-49, AC-55; spec21. Deliverable: record→draft test→main fixture→reader replay with real downloadable bytes, local Chromium only.

**Files:** Create `tests/fixtures/workbench/browser-report.ts`, `tests/workbench-browser-record-replay.test.ts`, `tests/workbench-browser-source-security.test.ts`; Modify `src/server/workbench/testing/test-application.ts` (test-only browser source scenario); no production fixture import.

**Interfaces:** `startBrowserReportFixture():Promise<{origin:string,forbiddenOrigin:string,waitForEvent(name:string):Promise<void>,release(name:string):void,requests():string[],close():Promise<void>}>` creates ephemeral loopback HTML/report/export/login fixture with fixed synthetic 2,000 rows and event gates. Browser executable from explicit `UOR_TEST_BROWSER_EXECUTABLE` or installed `msedge`; no network/package install automatic. Fixture uses stable selectors, authenticated marker and mock http cookie; `.release()` drives page events without timers. `createWorkbenchTestApplication` options from T13 gain `browserRuntime?:BrowserRuntimePort` and scenario union gains `'browser-source'`; production deps unchanged. `createBrowserIntegrationHarness(fixture:Awaited<ReturnType<typeof startBrowserReportFixture>>):Promise<BrowserIntegrationHarness>` is local helper in integration test, wraps that factory and actual BrowserRuntimePort; all methods in assertions drive API, not production backdoors.

- [ ] **Step 1: Write failing tests** `same_scenario_requires_own_profile_and_authentication`, `local_recorder_to_published_reader_capture_uses_downloaded_rows`, `blocks_foreign_origin_and_secret_recording_in_real_browser`.

```ts
const fixture = await startBrowserReportFixture(); const f = await createBrowserIntegrationHarness(fixture);
await f.curatorRecordAndFinish(); expect(f.recordedSteps().at(-1)?.action).toBe('download');
expect(JSON.stringify(f.recordedScenario())).not.toContain('synthetic-password');
await f.testAndSaveDraft(); expect(f.acceptedFacts()).toHaveLength(0);
await f.applyVerifiedSyntheticMain(); await f.readerCaptureOwnProfile();
expect(f.acceptedFacts()).toHaveLength(2000); expect(f.capture().acceptedRows).toBe(2000);
expect(f.count('attestation')).toBe(0); expect(f.prCalls()).toBe(0);
await f.startSecondInstallation(); expect(f.secondProfileHasCookie()).toBe(false);
expect((await f.secondCaptureJob()).status).toBe('waiting_user');
expect(fixture.requests().filter(x => x.startsWith(fixture.forbiddenOrigin))).toHaveLength(0);
await f.closeAll(); expect(f.openOwnedContexts()).toBe(0);
```

- [ ] **Step 2:** `npm test -- tests/workbench-browser-record-replay.test.ts tests/workbench-browser-source-security.test.ts` → FAIL missing fixture/harness or unsupported browser binding. Missing installed browser is explicit environment block, not passed test; unit tests T42–T46 remain runnable.
- [ ] **Step 3:** Implement exact fixture/helpers and integration tests, reuse actual new API/new domain repository. Report page waits on event gates; Playwright locator/event assertions control recorder readiness, filter changes, download completion and late login expiry. Test request/WS/redirect/page/frame origin denial, service workers blocked, screenshots owner-only no-store, no secret text/values in scenario/journal/package, arbitrary JS action rejected. Profile A persists own cookie across restart; profile B/installation B starts unauthenticated. Simulate changed selector, truncated file, download cancelled/empty/error HTML, command repeat/cancel, config changed during file delivery. Seed verified synthetic main by publication test port only; label synthetic, no real PR creation. UI browser walkthrough at 320/360/1024 confirms no-code path/focus, capture job continues across screen change.
- [ ] **Step 4:** Same tests → PASS with explicit executable/runtime recorded; `npm run build` → exit 0. Run T42–T46 unit test paths once, then these integration tests. Evidence distinguishes actual local Edge/Chromium from target bank compatibility; no screenshots/raw bank files committed. Teardown validates resolved temp root before recursive deletion and closes only owned loopback servers/contexts.
- [ ] **Step 5: Commit**

```text
git add tests/fixtures/workbench/browser-report.ts tests/workbench-browser-record-replay.test.ts tests/workbench-browser-source-security.test.ts src/server/workbench/testing/test-application.ts
git commit -m "test: verify browser recording and replay through workbench API"
```

### T48: Проба Сбербраузера, эксплуатационные инструкции и граница готовности

**Deps / AC:** T47; BP-03/P-01, BP-05 and spec21. Deliverable: executable probe protocol and honest result; only actual source binding waits for bank environment.

**Files:** Create `scripts/probe-oko-browser.ts`, `tests/probe-oko-browser.test.ts`, `docs/guides/workbench-oko-browser.md`; Modify `docs/BANK_CONNECTORS_RUNBOOK.md` (new v1 main path and evidence), `docs/VALIDATION.md` (separate local/bank statuses). Actual evidence saved private, sanitized summary may be committed.

**Interfaces:** `probeOkoBrowser(input:{runtimeRoot:string,profileId:string,sourceRef:VersionRef,scenarioRef:VersionRef,mode:'check'|'record-replay'},deps:{runtime:BrowserRuntimePort,repository:WorkbenchRepository,clock:Clock}):Promise<OkoBrowserProbeResult>`; `OkoBrowserProbeResult={status:'passed'|'blocked'|'failed',checkedAt:UtcInstant,browser:{name:string,version:string|null},runtime:{node:string,npm:string},checks:{code:string,status:'passed'|'blocked'|'failed',message:string}[],acceptedSourceBinding:boolean,privateEvidencePath:string|null}`. CLI requires explicit private config/source refs, missing inputs return blocked/nonzero and no browser launch. Synthetic fixture can validate probe orchestration but `acceptedSourceBinding=false` unless actual authorized target evidence satisfies every required check.

- [ ] **Step 1: Write failing tests** `missing_bank_inputs_never_pass_probe`, `local_edge_evidence_does_not_claim_sber_compatibility`, `probe_report_redacts_secrets_and_requires_complete_export`.

```ts
expect(await f.probeMissingConfig()).toMatchObject({ status: 'blocked', acceptedSourceBinding: false });
expect(f.runtimeLaunchCalls()).toBe(0);
expect(await f.probeSyntheticEdge()).toMatchObject({ acceptedSourceBinding: false });
expect(await f.probeTruncatedActualExport()).toMatchObject({ status: 'failed', acceptedSourceBinding: false });
expect(JSON.stringify(f.publicReport())).not.toMatch(/synthetic-token|Cookie:|Authorization:|PRIVATE KEY/);
expect(f.publicReport().checks.map(x => x.code)).toContain('EXPORT_COMPLETE');
```

- [ ] **Step 2:** `npm test -- tests/probe-oko-browser.test.ts` → FAIL missing probe function; do not run actual bank CLI during unit test.
- [ ] **Step 3:** Implement exact probe/script, typed private config parsing and safe diagnostic output. Run authorized target probe with actual installed Сбербраузер version/executable, working persistent profile, real SSO/cert/smartcard behavior, report URL/marker, filters and full export. Show ordinary login, cancel, re-open same own profile, fresh replay, expired session + manual reentry/retry, revoked access, offline/cache fallback, page/selector changes, download success/size/date/keys/coverage across all 2,000 expected rows or actual full target count. Compare source export and normalized/enriched rows; browser capability and full-export proof recorded, no Engine endpoint discovery mandatory. Do not create PR/change ACL in probe; shared scenario publication tested via approved normal flow separately. Guide documents start/finish/parameter review/test/draft/package, reader own profile/login/replay, safe re-record after layout changes and diagnostics with next action. Evidence contains actual dates/runtime/browser/check output without credentials/raw bank content in repo.
- [ ] **Step 4:** `npm test -- tests/probe-oko-browser.test.ts` → PASS; `npm run build` → exit 0. Execute `npx --no-install tsx scripts/probe-oko-browser.ts --config <private-config-file>` only with available authorized target environment; record exit/check status. If absent/incompatible, mark BP-03/browser binding blocked with precise input/action; all independent local feature tests remain complete. No claim of bank readiness from mock/Edge.
- [ ] **Step 5: Commit**

```text
git add scripts/probe-oko-browser.ts tests/probe-oko-browser.test.ts docs/guides/workbench-oko-browser.md docs/BANK_CONNECTORS_RUNBOOK.md docs/VALIDATION.md
git commit -m "docs: add target browser probe and source recording runbook"
```

## Command/query registration and final self-check

| Name | Exact input | Capability / effect / execution |
| --- | --- | --- |
| source.browser.profile.set | `{sourceId,profileId,profile,expectedRevision}` T42 | personal.write / local / sync |
| source.browser.login.open | `{sourceRef:VersionRef}` | capture.local / local / async |
| source.browser.login.finish | `{loginId:UUIDv4}` | capture.local / local / sync |
| source.browser.record.start | `{sourceRef:VersionRef,startUrl:string,authenticatedSelector:string}` | uor.prepare / local / async |
| source.browser.record.finish | `{recordingId:UUIDv4,save:boolean}` | uor.prepare / local / sync |
| source.browserScenario.draft.save | `{draftId,definition:PartialDraftInput<BrowserScenarioDefinition>}` | uor.prepare / sharedDraft / sync |
| source.browser.record.test | `{draftId:UUIDv4}` | uor.prepare / local / async |
| source.capture | `{goalId:UUIDv4}` unchanged T14 | capture.local / local / async |
| source.browser.own query | QueryRequest filter `{sourceRef:VersionRef}` | business.read, own private projection only |

Each descriptor has strict input/output schemas and CommandOutcome wrapper T12; output schemas correspond to exact service result above. Private screenshots use `GET /api/v1/source-browser/recordings/:recordingId/screenshots/:handleId` with session/origin/owner guard, image/png/no-store/nosniff; no general static files route. Register this typed read route in workbench routes only when browser module is included. No profile/cookie data in normal source DTO, full registry or private profile not readable by another owner.

T42–T48 are additive to T10–T41. T39 cutover depends on completed local browser mechanism/integration T47 if this is the chosen first-release ОКО path; actual corporate binding readiness separately BP-03/T48. At every failure keep saved scenario/draft/previous accepted facts; no reset/profile deletion/auth bypass. Old Engine adapter can remain available as an explicit separately probed option, but UI default and acceptance route use recording/replay.
