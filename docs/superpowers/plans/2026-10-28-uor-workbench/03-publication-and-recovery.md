# Публикация и восстановление — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. При отсутствии skills у исполнителя достаточно обычных Git/npm и приведённых контрактов; это не причина блокировать GigaCode.

**Goal:** Накопленный личный пакет проходит проверку, безопасный push и нативный PR; verified main применяется атомарно, а обновление и перенос сохраняют данные после сбоя.

**Architecture:** Feature slices используют WorkbenchRepository и CommandRegistry частей 01/02, а внешние эффекты выполняются через узкие Git/Bitbucket/TerminalRunner ports. Предметная публикация, обновление программы и замена рабочего места имеют разные автоматы, журналы и точки принятия. Существующий durable code-update runtime расширяется для новой БД, а не заменяется демонстрационным updater.

**Tech Stack:** TypeScript, Zod 4, Node.js 22.16.0, npm 10.9.2, node:sqlite, Git CLI, Fastify 5, Vitest; Python 3.13.5 только для адаптера, которому он действительно нужен.

**Spec:** Frozen approved `docs/superpowers/specs/2026-10-28-uor-workbench/15-access-policy.md`, `16-data-calculation-contract.md`, `17-interface-api-contract.md`, `18-integration-operations-contract.md`, `19-acceptance-delivery-contract.md`; соседние имена — `CONTRACTS.md` K01–K05 в этой папке.

## Global Constraints

- Рабочий checkout: `RM_UOR`, ветка `codex/uor-workbench-rebuild`, исходный commit `3d8704e4a6ff2195af4f2c0602ed11bff5d38f4b`; каждую задачу начинать с `git status --short` и `git branch --show-current`.
- Эта поставка — только план. Ни одной команды реализации/теста/commit из этого документа сейчас не выполнять.
- Банк использует корпоративный Bitbucket; GitHub `SAleksanyaS/RM_UOR` — репозиторий разработки. Банковские данные, адреса, реестр и учётные сведения в GitHub не попадают.
- Chief использует обычную панель куратора; merge выполняется во внешнем Bitbucket, метода merge в приложении нет.
- Hostname получает сервер; профиль hostname не сопоставляется с аккаунтом Bitbucket. Git metadata не является авторизацией.
- Свежий gate выполняется перед каждой внешней записью и повтором; очередь, открытый терминал и успешная проверка при входе не сохраняют grant.
- Только обычный fast-forward push собственной `uor/<curatorPersonId>/<packageId>`; main не является push target приложения. Нет force-push, reset исполняемой/чужой копии и скрытого общего release/current.
- Не отключать корпоративные hooks, helper, ASKPASS или TLS. Нет `--no-verify` и замены core.hooksPath пустым каталогом.
- Нулевые/неизвестные/устаревшие данные, N/A, предварительный результат и подтверждение различимы. Preview ничего не подтверждает.
- История бессрочная; нет автоматического удаления, lifetime-cap или повторного вычисления старого basis сегодняшней методикой.
- 2 000 строк одного получения и около 100 локальных установок — исходный нагрузочный профиль, не cap агрегатного числа строк.
- До probe — синтетический контракт и честный unsupported/not_ready; не поддельный production success.
- Любая SQL transaction синхронна. Сеть, файловая подготовка и ожидание Git происходят до короткой транзакции.
- Jobs, Problem, commandId и auth mapping берутся из 17/T12; второй HTTP API не создаётся.

## Review Focus

1. Unicode path collision, case aliases и symlink в manifest не обходят allowlist; T22 `rejectsAliasesAndLinksBeforeHash`.
2. Утерянный ответ push/create PR после реального эффекта не создаёт второй commit/PR; T24 `reconcilesLostCreateWithoutDuplicate`, T25 `reconcilesUnknownPushBeforeRetry`.
3. Допуск отозван, пока пользователь входит в Git; T25 `revocationDuringAuthStopsTransferAfterCorporateHooks`.
4. Reader без Bitbucket REST применяет verified main с неизвестным mergedAt; T26 `gitOnlyCurrentApplyWithoutTimestamp`.
5. Target меняется после rescue, либо процесс падает после commitpoint; T28 `changedAfterRescueKeepsActiveAndRescue`, T27 `committedFailureNeverRestoresOlderData`.

## Карта файлов и соглашения типов

Пути ниже относительно RM_UOR. `Modify` перечисляет только существующие прочитанные файлы; прочие новые файлы явно `Create`.
Все новые public DTO/schema и порты экспортируются из `src/features/publishing/workbench/index.ts` либо `src/features/workspace-maintenance/workbench/index.ts`; exports добавляются только при реализации владельца.
`UUIDv4`, `Header`, `EntityRef`, `VersionRef`, `Sha256`, `UtcInstant` берутся из T01/T02 `src/domain/workbench/index.ts`.
`GitOid=string` валидируется как полный 40/64 lowercase hexadecimal OID и дополнительно `^{commit}` в нужном repo; не принимать abbreviated OID или ref вместо commit.
`RawSha256=string` — ровно 64 lowercase hex, `RevisionToken=string` — непрозрачная непустая строка 17, `UTCDateTime=UtcInstant`.
`CommandContext` ровно обновлённый K03, включая server-derived `actor:ActorRef`; actor не копируется из assignment/пакета. operationId равен jobId, не commandId. Получать job через T12 `jobs.findByCommand(context.commandId,context.installationId)`; отсутствие зарегистрированного async job — ошибка исполнения, не новый случайный job.
`WorkbenchRepository` ровно K01 и согласованные T03 ports: `readPublicationAnchor(ref:EntityRef):PublicationAnchor|null`, `appendPublicationAnchor(value:PublicationAnchor,expectedHead:number|null):VersionRef`; ref строго `{entityType:'publication_anchor',id:packageId}`.
Wire PublicationAnchor из `src/domain/workbench/publication.ts` остаётся ровно 18, без Header envelope и подстановки actor/recordedAt. T03 хранит историю уточнений отдельно от value.revision принятого пакета.
`PublicationPackageRecord=Header & {cycleId:UUIDv4;curatorPersonId:UUIDv4;state:PackageState;current:PackageRevision|null;sent:PackageRevision|null;draftRefs:VersionRef[];proposal:ProposalLink|null}` имеет entityType=`publication_package`.
PackageState — ровно `draft|validating|preview_ready|publishing|open_pr|needs_rework|merged|declined`.
Совпадение UUID package/anchor не объединяет типы сущностей; внешние ссылки всегда EntityRef с entityType.

Прочитанные старые точки: `application-publishing.ts` читает releaseBranch и помечает отдельные drafts опубликованными; `git-cli-provider.ts` содержит общий releaseBranch, forced checkout, clean, пустые hooks и noninteractive auth.
Новый поток не вызывает эти mutating методы. T23 проверяет отсутствие старых mutating routes в новой T13 factory; старый createApp остаётся test/legacy library, production runtime toggle не вводится.
`system/code-update.ts` уже связывает launcher/IPC и backup; `scripts/code-update-runtime.mjs` уже имеет schemaVersion=2 journal, staged dependencies, ff-only, rollbackOwned, committed activation и recoverCodeUpdate.
`workspace-maintenance/recovery.ts` уже выполняет rollback до startup imports; bundle-service имеет namespace allowlist, staged preview, 30 минут и rebind; storage-service имеет карантин и automaticQuarantine timer.
T27/T28 сохраняют эти гарантии, заменяют несовместимый перенос авторства/rebind и не регистрируют автоматическую очистку предметной истории в новой factory.
`catalog/import-map.ts` читает inert portal-data; он выводит старые thresholds и sources эвристикой. Для целевой миграции эти выводы не становятся утверждённой методикой.

## Общая форма сервисов и регистрации

`new PublishingService(deps:PublishingDependencies)` создаётся один раз, а методы получают `CommandContext` явно:

```ts
preview(context:CommandContext,input:PackagePreviewInput):Promise<PackagePreviewResult>
submit(context:CommandContext,input:PackageSubmitInput):Promise<PackageSubmitResult>
refreshStatus(context:CommandContext,packageId:UUIDv4):Promise<PackageStatusResult>
checkPublication(context:CommandContext):Promise<PublicationCheckResult>
applyPublication(context:CommandContext,mainCommit:GitOid):Promise<PublicationApplyResult>
registerPublishingCommands(registry:CommandRegistry,service:PublishingService):void
```

`MaintenanceService` экспортирует `createBackup`, `previewRestore`, `applyRestore`, `checkCodeUpdate`, `applyCodeUpdate`, каждый `(context:CommandContext,input:CorrespondingInput):Promise<CorrespondingResult>`.
`registerMaintenanceCommands(registry:CommandRegistry,service:MaintenanceService):void` регистрирует три backup-команды 17; code update — внутренний lifecycle, не выдуманная публичная команда 17.
`PublishingDependencies={repository:WorkbenchRepository;clock:Clock;accessPolicy:AccessPolicyService;git:PublicationGitPort;bitbucket:BitbucketPort;terminal:TerminalRunner;artifacts:PackageArtifactStore;jobs:JobStore;jobSink:JobSink;drafts:DraftService}`.
PackageArtifactStore, PublicationGitPort и BitbucketPort определяются T22/T23/T24; JobStore — T12, не отдельное хранилище jobs этой части.
Это итоговый constructor shape: T22 принимает только repository/clock/accessPolicy/artifacts/jobs/jobSink/drafts и git:PackageMainReader; T23 реализует PublicationGitPort, T24 сужает git и добавляет bitbucket/TerminalRunner contract, T25 даёт native runner implementation. Не импортировать ещё не созданные модули и не добавлять stub методы ради промежуточного build.
T12 JobStore.findByCommand возвращает JobSnapshot; JobSink.stage(jobId,stage,progress), checkpoint(jobId,value), complete(jobId,result,warnings), fail(jobId,error) обновляют технический job, не доменную stateRevision.
Descriptor имеет name/inputSchema/outputSchema/capability/effect/execution/handler; handler возвращает `CommandOutcome<R>={result:R;changedRefs:EntityRef[];editToken:RevisionToken|null}`. Регистратор оборачивает service result и точные changedRefs; read/check возвращает []/null. outputSchema проверяет result, не outcome-envelope.
Собственный durable external-effect journal — таблица `wb_publishing_effects` через T03 `sqlForModule('publishing')`, статический SQL, ключ operationId/stage/package revision. Он содержит intention/checkpoint/external IDs и безопасные коды, не secret buffers и не второй JobStore.
Владение session/installation проверяет CommandRegistry по T10–T12; сервис повторно сверяет owner пакета и revisions после await.

---

### T22: PackageRevision, manifest, canonical hash и preview

**Dependencies:** T01–T03, T10–T12, T15–T21. **AC:** AC-22, AC-26, AC-28, AC-30, AC-49, AC-55. **Spec:** 16 §3/8/11; 17 §9; 18 §8–10/13.

**Files:**
- Create: `src/features/publishing/workbench/contracts.ts` — wire/model schemas и экспорт DTO.
- Create: `src/features/publishing/workbench/package-manifest.ts` — canonical bytes, path validation, hashes.
- Create: `src/features/publishing/workbench/package-artifacts.ts` — private revision-scoped artifact access.
- Create: `src/features/publishing/workbench/package-preview.ts` — semantic preview и server-owned tokens.
- Create: `src/features/publishing/workbench/publishing-service.ts` — начало PublishingService, preview.
- Create: `src/features/publishing/workbench/register-commands.ts`, `index.ts` — registration/exports реализованных методов.
- Test: `src/features/publishing/workbench/package-manifest.test.ts`, `package-preview.test.ts`.

**Interfaces:**
- Consumes: K01 getHead/readVersion/append/transaction; K02 prepareEvaluation; T11 assertCommandAllowed; T12 registration descriptor и jobs.
- Produces: `PackageRevision` и `PackageManifest` ровно 18 §9; `PackageFile={path:string;sha256:RawSha256;bytes:number}`.
- Produces: `PackagePreviewInput={packageId:UUIDv4}`, `PackageSubmitInput={packageId:UUIDv4;previewToken:string}`.
- Produces: `PackagePreviewResult={packageRevision:PackageRevision;previewToken:string;expiresAt:UtcInstant;changes:PackageChange[];warnings:Problem[];errors:Problem[]}`.
- `PackageChange={objectRef:EntityRef;field:string;before:unknown;main:unknown;proposed:unknown;conflict:boolean}`; values сериализуются только зарегистрированной доменной схемой, unknown здесь не обход input validation.
- `PackageArtifactStore.readRevision(ref:PackageRevision):Promise<ReadonlyMap<string,Uint8Array>>`; `writeRevision(ref:PackageRevision,files:ReadonlyMap<string,Uint8Array>):Promise<void>`; files становятся immutable после успешной проверки.
- `createPackageArtifactStore(options:{artifactRoot:string}):PackageArtifactStore` создаёт проверенный private store; повтор записи иных bytes той же revision отклоняется.
- `buildPackageManifest(input:{package:Omit<PackageRevision,'contentHash'>;files:ReadonlyMap<string,Uint8Array>}):PackageManifest`.
- `validatePackageFiles(input:{root:string;paths:string[];publicationMode:'demo-only'|'internal'}):Promise<void>`.
- `VerifiedMain={repositoryId:string;commit:GitOid;files:ReadonlyMap<string,Uint8Array>}`, `PackageMainReader={readMain:()=>Promise<VerifiedMain>}` определяются в contracts.ts T22; provider implementation появится T23, T22 проверяется через явный fake port.
- `PackagePreviewDependencies={repository:WorkbenchRepository;clock:Clock;artifacts:PackageArtifactStore;git:PackageMainReader;drafts:DraftService}`.
- `createPackagePreview(context:CommandContext,input:PackagePreviewInput,deps:PackagePreviewDependencies):Promise<PackagePreviewResult>`.
- DraftService из T17: `readDraftPackage(packageId:UUIDv4):DraftPackageView`, `validateDraftPackage(packageId:UUIDv4):DraftValidation`; полные entry definitions повторно валидируются схемами владельцев, не PartialDraftInput.

- [ ] **Step 1: Write failing tests with exact assertions.**

```ts
it('canonicalVectorSortsKeysAndFilesWithoutChangingText', async () => {
  // fixture has Cyrillic + combining characters, Decimal '92', two POSIX paths.
  expect(canonicalBytes.toString('hex')).toBe(vector.expectedUtf8Hex);
  expect(manifest.packageRevision.contentHash).toBe(`sha256:${vector.expectedHash}`);
  expect(manifest.files.map(f => f.path)).toEqual(['published/a.json','published/я.json']);
  expect(manifest.files.some(f => f.path.endsWith('manifest.json'))).toBe(false);
});
it('rejectsAliasesAndLinksBeforeHash', async () => {
  expect(rejectedCodes).toEqual(['INTEGRITY_MISMATCH','INTEGRITY_MISMATCH','INTEGRITY_MISMATCH']);
  expect(writtenFiles).toHaveLength(0); // traversal, case-alias collision, symlink/junction.
});
it('editMainOrBasisInvalidatesPreviewAndNeverCreatesAttestation', async () => {
  expect(changedRevision).toBe(previousRevision + 1);
  expect(reusedOldToken.error.code).toBe('PREVIEW_STALE');
  expect(createdAttestations).toHaveLength(0);
  expect(previousRevisionBytes).toEqual(savedPreviousRevisionBytes);
});
it('independentFieldsMergeButSameFieldNeedsExplicitChoice', async () => {
  expect(independentCombined).toMatchObject({title:'main title',description:'my description'});
  expect(conflict).toMatchObject({field:'title',before:'base',main:'main title',proposed:'my title',conflict:true});
  expect(conflictedPreview.errors.length).toBeGreaterThan(0);
});
```

Test fixture `vector` создаётся в test как статическая строка JSON и заранее проверенный node:crypto SHA-256; ожидаемый hash фиксируется литералом в тесте, не вызовом проверяемого buildPackageManifest.
Добавить отдельные test.each для secret-field, registry path, undeclared bytes, duplicate path, binary evidence size/hash, неизвестной schema и dangling VersionRef.
Стандартный machine layout: `published/workbench/packages/<packageId>/<revision>/manifest.json`, `records/<entityType>/<id>/<revision>.json`, `artifacts/<rawSha256>` под тем же revision root.
Manifest paths относительно revision root. Объектные файлы — только зарегистрированные типы 16; artifacts — только отобранные evidence с проверенным MIME/hash/классификацией, без executable payload.
Shared `browser_scenario`/SourceDefinition.browserScenarioRef используют общий manifest: source ref определяет T02, BrowserScenarioDefinition/owner schema — T42 из части 06; сценарий проходит обычный package/PR. expectedExport фиксирует format csv/xlsx и requiredColumns, полнота проверяется по expectedPopulation 16. Cookies, managed browser profile, screenshots, private certs и local executable/config исключены. Отдельного раннего push сценариев нет; неизвестная owner schema даёт SCHEMA_UNSUPPORTED.

- [ ] **Step 2: Confirm RED.**

Run: `npm test -- src/features/publishing/workbench/package-manifest.test.ts src/features/publishing/workbench/package-preview.test.ts`.
Expected: FAIL (new modules/exports отсутствуют), а не ложный PASS с skipped tests.

- [ ] **Step 3: Implement exact exports above.**

Канонизация: recursive keys по UTF-16 code units, files по нормализованному POSIX path; прочие массивы сохраняют порядок, строки не NFC-normalize, UTF-8 без BOM, без пробелов. File hashes считают реальные bytes, не декодированный текст.
contentHash вычислять по `{package:PackageRevision без contentHash,files}`; createdAt один раз на редакцию от context.clock, сохранённый повтор его не меняет.
Server token хранит owner/installation/repo/package revision/hash/main/basis refs и TTL 30 минут; хранится вне предметной stateRevision. После изменения token нельзя «обновить» скрыто.
Сверить все object schemas/refs и повторный domain evaluation после field merge; текстовый Git merge не заменяет предметную проверку.
Состояние validating/preview_ready отражает результат. Errors оставляют доступный draft с причинами, не уничтожают предыдущую отправленную revision.
Register только `package.preview` на этой стадии; остальные descriptors добавляются владельцами T24/T26. Регистратор не публикует stub success.

- [ ] **Step 4: Confirm GREEN and build.**

Run: `npm test -- src/features/publishing/workbench/package-manifest.test.ts src/features/publishing/workbench/package-preview.test.ts`; expected PASS.
Run: `npm run build`; expected exit 0.

- [ ] **Step 5: Commit exact files.**

```text
git add src/features/publishing/workbench/contracts.ts src/features/publishing/workbench/package-manifest.ts src/features/publishing/workbench/package-artifacts.ts src/features/publishing/workbench/package-preview.ts src/features/publishing/workbench/publishing-service.ts src/features/publishing/workbench/register-commands.ts src/features/publishing/workbench/index.ts src/features/publishing/workbench/package-manifest.test.ts src/features/publishing/workbench/package-preview.test.ts
git commit -m "feat: add immutable workbench package previews"
```

### T23: Собственная staging-ветка и безопасный Git provider

**Dependencies:** T22, T11/T12. **AC:** AC-26, AC-28, AC-30, AC-42, AC-43. **Spec:** 15 §6; 18 §7/10/13.

**Files:**
- Create: `src/features/publishing/workbench/git-port.ts`, `git-staging-provider.ts`.
- Existing reference only: `src/features/publishing/git-cli-provider.ts`, `application-publishing.ts`; их старый release flow не подключать к новой T13 factory и не переиспользовать для push.
- Modify: `src/features/publishing/workbench/index.ts`.
- Test: `src/features/publishing/workbench/git-staging-provider.test.ts`, `legacy-publication-guard.test.ts`.

**Interfaces:**
- Produces: `PreparedProposal={packageRevision:PackageRevision;checkout:string;branch:string;commit:GitOid;expectedRemoteHead:GitOid|null}`; checkout приватный, в browser DTO не попадает.
- Consumes VerifiedMain/PackageMainReader T22; provider проверяет remote/commit и allowed tree, до domain validation T26.
- `PublicationGitPort.readMain():Promise<VerifiedMain>`.
- `PublicationGitPort.prepare(input:{manifest:PackageManifest;files:ReadonlyMap<string,Uint8Array>;expectedRemoteHead:GitOid|null}):Promise<PreparedProposal>`.
- `PublicationGitPort.inspectRemote(branch:string):Promise<GitOid|null>`; `verifyPrepared(prepared:PreparedProposal):Promise<void>`.
- `createGitStagingProvider(options:{projectRoot:string;runtimeRoot:string;repositoryId:string;remoteUrl:string;gitExecutable:string}):PublicationGitPort`.
- push не принадлежит этому порту: T25 TerminalRunner получает уже подготовленный commit.

- [ ] **Step 1: Write RED tests against real temporary bare repositories.**

```ts
it('curatorsUseIndependentBranchesAndDoNotTouchRunningCheckout', async () => {
  expect(a.branch).toBe(`uor/${curatorA}/${packageA}`);
  expect(b.branch).toBe(`uor/${curatorB}/${packageB}`);
  expect(runningHeadAfter).toBe(runningHeadBefore);
  expect(runningDirtyBytesAfter).toEqual(runningDirtyBytesBefore);
  expect(recordedArgv.some(a => a.includes('--force') || a.includes('reset') || a.includes('clean'))).toBe(false);
});
it('staleRemoteOrPreparedBytesRequiresNewPreview', async () => {
  expect(result.error.code).toBe('PREVIEW_STALE');
  expect(pushCalls).toHaveLength(0);
  expect(savedPreparedCommit).toBe(originalPreparedCommit);
});
it('legacyPublicationCannotBypassWorkbenchGate', async () => {
  expect([404,410]).toContain(legacyPublishHttp.statusCode);
  expect([404,410]).toContain(legacySyncHttp.statusCode);
  expect(activeRevisionAfter).toBe(activeRevisionBefore);
});
```

Add `rejectsOptionLikeRemoteRefsAndShellInjection`, asserting every spawn uses shell:false, executable/cwd checked, argv tokens remain separate; no secret URLs in errors.
Add `stagesOnlyManifestPaths`: staged tree includes exact manifest/files, excludes unrelated .runtime/config/registry even if present in checkout.
Add `nonFastForwardIsConflictWithoutForceOrAutomaticRebase`: remote branch changed by another actor; no retry mutates history, package retained.

- [ ] **Step 2: Confirm RED.**

Run: `npm test -- src/features/publishing/workbench/git-staging-provider.test.ts src/features/publishing/workbench/legacy-publication-guard.test.ts`; expected FAIL new provider/guard missing.

- [ ] **Step 3: Implement exact interfaces and guards.**

Fresh private checkout per prepared revision; retain successful checkout/commit for auth retries. Existing own branch starts from observed head only when it descends from expected base; no destructive reset/rebase to fit main.
Validate remote, full commits and exact `refs/heads/uor/...`; prepare commit with literal argv. `git add -- <explicit manifest paths>` only; no `git add .`.
Do not reuse initialize() that installs empty hooks or git() that forces GCM_INTERACTIVE=Never. Read-only background fetch may be noninteractive; interactive runner has separate policy T25.
Before preparing and again before push compare main/base, branch expected head, package hash/revision; changed main requires semantic re-preview T22.
Requests to legacy publication/auth routes through new T13 factory must return 404/410, not invoke old services. Existing old createApp tests remain baseline; T39 switches production entry once, without a runtime flag that reopens password/release mutations.

- [ ] **Step 4: Confirm GREEN and build.**

Run same two test files; expected PASS. Run `npm run build`; expected exit 0.

- [ ] **Step 5: Commit.**

```text
git add src/features/publishing/workbench/git-port.ts src/features/publishing/workbench/git-staging-provider.ts src/features/publishing/workbench/index.ts src/features/publishing/workbench/git-staging-provider.test.ts src/features/publishing/workbench/legacy-publication-guard.test.ts
git commit -m "feat: isolate proposal branches and guard legacy publication"
```

### T24: Нативный Bitbucket port, recovery и capability profile

**Dependencies:** T22/T23, T11/T12. **AC:** AC-26–AC-30, AC-33, AC-40, AC-42. **Spec:** 18 §8/11/17/18.

**Files:**
- Create: `src/features/publishing/workbench/bitbucket-port.ts`, `fake-bitbucket.ts`, `proposal-reconciliation.ts`.
- Create: `src/features/publishing/workbench/terminal-runner.ts` — только TerminalRunner/TerminalRunResult/PreTransferGate interfaces, точные сигнатуры T25 ниже; T24 fake port injection, не native production success.
- Modify: `src/features/publishing/workbench/contracts.ts`, `publishing-service.ts`, `register-commands.ts`, `index.ts`.
- Test: `src/features/publishing/workbench/bitbucket-contract.test.ts`, `proposal-reconciliation.test.ts`, `publishing-commands.test.ts`.

**Interfaces:**
- `BitbucketCapabilities={profileId:string;edition:string;version:string;nativePullRequests:boolean;findByPackageMarker:boolean;updateOpenProposal:boolean;readComments:boolean;explicitReworkState:boolean;mergeEvidence:'verified'|'unsupported';terminalAuthProfileId:string|null}`.
- `ProposalLink={provider:'bitbucket';repositoryId:string;id:string;url:string}`.
- `ProposalSnapshot={link:ProposalLink;packageId:UUIDv4;sourceCommit:GitOid;targetCommit:GitOid;state:'open'|'needs_rework'|'merged'|'declined'|'unknown';author:{externalId:string|null;displayName:string};externalVersion:string}`.
- `ProposalComment={id:string;version:string;text:string;createdAt:UtcInstant;authorDisplayName:string;requiresRework:boolean}`.
- `ProposalWrite={packageRevision:PackageRevision;branch:string;proposalCommit:GitOid;summary:string;marker:string}`.
- `MergeEvidence={mainCommit:GitOid;proposalCommit:GitOid|null;mergedAt:UtcInstant|null;source:string;verified:boolean}`.
- `BitbucketPort.capabilities():Promise<BitbucketCapabilities>`; `findProposal(packageId:UUIDv4):Promise<ProposalSnapshot|null>`.
- `createProposal(input:ProposalWrite):Promise<ProposalSnapshot>`; `updateProposal(link:ProposalLink,input:ProposalWrite):Promise<ProposalSnapshot>`.
- `readProposal(link:ProposalLink):Promise<ProposalSnapshot>`; `readComments(link:ProposalLink):Promise<ProposalComment[]>`; `readMergeEvidence(link:ProposalLink):Promise<MergeEvidence>`.
- `createFakeBitbucket(options:{capabilities:BitbucketCapabilities}):BitbucketPort` is test-only, никогда default production binding.
- `PackageSubmitResult={packageRevision:PackageRevision;preparedCommit:GitOid;proposal:ProposalLink;state:'open_pr'}`.
- `PackageStatusResult={packageId:UUIDv4;state:PackageState;proposal:ProposalLink|null;comments:ProposalComment[];anchor:PublicationAnchor|null;warnings:Problem[]}`.
- `reconcileProposal(context:CommandContext,input:ProposalWrite,deps:{bitbucket:BitbucketPort;accessPolicy:AccessPolicyService;repository:WorkbenchRepository}):Promise<ProposalSnapshot>`.

- [ ] **Step 1: Write failing tests.**

```ts
it('reconcilesLostCreateWithoutDuplicate', async () => {
  expect(first.error.code).toBe('REMOTE_STATE_UNKNOWN');
  expect(retry.proposal.id).toBe(createdExternally.id);
  expect(fake.createCalls).toHaveLength(1);
  expect(Date.parse(journal.intentAt)).toBeLessThan(Date.parse(externalCreateAt));
});
it('reworkUpdatesSamePrAndOrdinaryCommentDoesNotDemandRework', async () => {
  expect(afterComment.state).toBe('open_pr');
  expect(afterExplicitRework.state).toBe('needs_rework');
  expect(resubmitted.proposal.id).toBe(first.proposal.id);
  expect(fake.updateCalls).toHaveLength(1);
});
it('ambiguousMarkerAndUnsupportedSearchNeverCreateBlindly', async () => {
  expect(results.map(r => r.error.code)).toEqual(['REMOTE_STATE_UNKNOWN','REMOTE_STATE_UNKNOWN']);
  expect(createCalls).toHaveLength(0);
});
it('gateRunsBeforeEveryPrWriteAndAccountMismatchIsNotLocalDenial', async () => {
  expect(gateOperations).toEqual([createOperation,updateOperation]);
  expect(revokedAttemptWrites).toBe(0);
  expect(differentBitbucketAuthorAccepted).toBe(true);
});
```

Also assert `bitbucketPort` has no merge method; merged/declined only after observed provider status; unknown remains unknown, polling does not invent denial.
`publishing-commands.test.ts`: descriptors package.submit/package.refreshStatus are typed async, owner enforced; commandId replay returns same T12 job; changed payload produces IDEMPOTENCY_CONFLICT.

- [ ] **Step 2: Confirm RED.**

Run: `npm test -- src/features/publishing/workbench/bitbucket-contract.test.ts src/features/publishing/workbench/proposal-reconciliation.test.ts src/features/publishing/workbench/publishing-commands.test.ts`; expected FAIL.

- [ ] **Step 3: Implement port, fake and orchestration.**

Persist intent before external mutation and checkpoint after read-back; search stable packageId marker, not PR title. Reconcile push/PR after interrupted/timeout before deciding which effect remains.
Store curatorPersonId separately from actual PR author. New local edits while open_pr remain distinct current revision; sent revision is immutable.
Register package.submit and package.refreshStatus through CommandRegistry; no raw HTTP routes, external merge, PR comment writes or auto-submit on reconnect.
Default production Bitbucket binding returns explicit unsupported/not_ready until 18 P-02 probe and reviewed provider-specific plan; this is 19 BP-01, not BP-02 registry.
Actual write readiness additionally requires registry BP-02 and interactive safety BP-06. Capability success on fake is insufficient to flip readiness.
Unknown search or response keeps REMOTE_STATE_UNKNOWN and saved package, with reconcile next action; never automatically create a replacement PR.

- [ ] **Step 4: Confirm GREEN and build.**

Run same three tests; expected PASS. Run `npm run build`; expected exit 0. Record corporate integration as unverified.

- [ ] **Step 5: Commit.**

```text
git add src/features/publishing/workbench/bitbucket-port.ts src/features/publishing/workbench/fake-bitbucket.ts src/features/publishing/workbench/proposal-reconciliation.ts src/features/publishing/workbench/terminal-runner.ts src/features/publishing/workbench/contracts.ts src/features/publishing/workbench/publishing-service.ts src/features/publishing/workbench/register-commands.ts src/features/publishing/workbench/index.ts src/features/publishing/workbench/bitbucket-contract.test.ts src/features/publishing/workbench/proposal-reconciliation.test.ts src/features/publishing/workbench/publishing-commands.test.ts
git commit -m "feat: add recoverable native proposal contract"
```

### T25: TerminalRunner, native auth и fresh gate после ожидания

**Dependencies:** T23/T24, T11/T12. **AC:** AC-31, AC-32, AC-33, AC-42, AC-43. **Spec:** 17 §10; 18 §10 TerminalRunner/P-06.

**Files:**
- Modify: `src/features/publishing/workbench/terminal-runner.ts` — T24 contract получает проверенную native implementation.
- Create: `src/features/publishing/workbench/pre-transfer-gate.ts`, `terminal-capability-profile.ts`.
- Modify: `src/features/publishing/workbench/publishing-service.ts`, `index.ts`.
- Test: `src/features/publishing/workbench/terminal-runner.test.ts`, `pre-transfer-gate.test.ts`.

**Interfaces:**
- `TerminalRunResult={status:'confirmed';exitCode:0;remoteCommit:GitOid}|{status:'cancelled';exitCode:number|null}|{status:'unknown';exitCode:number|null;reason:string}|{status:'auth_required';provider:'git'|'bitbucket'}`.
- `PreTransferGate=()=>Promise<void>`; rejection must terminate Git before transfer, never merely update UI.
- `TerminalRunner.runGitPush(input:{cwd:string;args:readonly string[];preparedCommit:GitOid;preTransferGate:PreTransferGate;signal:AbortSignal}):Promise<TerminalRunResult>`.
- `TerminalCapabilityProfile={id:string;platform:string;gitVersion:string;transport:'https'|'ssh';helperDescription:string;corporateHookFingerprint:RawSha256;postWaitGateVerified:boolean;evidenceId:string}`.
- `createPreTransferGate(context:CommandContext,prepared:PreparedProposal,deps:{accessPolicy:AccessPolicyService;git:PublicationGitPort;artifacts:PackageArtifactStore}):PreTransferGate`.
- `createTerminalRunner(profile:TerminalCapabilityProfile):TerminalRunner`; no verified native profile => explicit unsupported, no fallback that bypasses safety.

- [ ] **Step 1: Write failing scripted-runner tests, then local real-Git fixture.**

```ts
it('revocationDuringAuthStopsTransferAfterCorporateHooks', async () => {
  expect(trace).toEqual(['auth_wait','auth_resumed','corporate_hook','fresh_gate','denied']);
  expect(transferredCommits).toHaveLength(0);
  expect(preparedCommitAfter).toBe(preparedCommitBefore);
});
it('cancelledTerminalKeepsCommitAndRedactsEverySecretChannel', async () => {
  expect(result.status).toBe('cancelled');
  expect(savedBranch).toBe(originalBranch);
  expect(logs + JSON.stringify(job)).not.toContain(sentinelSecret);
  expect(logs + JSON.stringify(job)).not.toContain(sentinelCookie);
});
it('reconcilesUnknownPushBeforeRetry', async () => {
  expect(retryPreparedCommit).toBe(initialPreparedCommit);
  expect(commitCalls).toBe(1);
  expect(remoteReadsBeforeRetryWrite).toBeGreaterThan(0);
});
it('gitSuccessDoesNotAuthenticateRestPr', async () => {
  expect(job.status).toBe('waiting_user');
  expect(job.stage).toBe('PR.auth');
  expect(job.warnings[0].code).toBe('PR_AUTH_REQUIRED');
  expect(newCommitCallsAfterPrLogin).toBe(0);
});
```

`nativeEnvironmentPreservesHelpersAndHooks`: assert argv excludes --no-verify; env does not set GIT_TERMINAL_PROMPT=0/false or GCM_INTERACTIVE=Never; no config override empties hooks/helper/ASKPASS.
`exitZeroRequiresRemoteVerification`: exit 0 + mismatching remote => REMOTE_STATE_UNKNOWN, not open_pr.
`unverifiedPostWaitGateRefusesTransfer`: profile postWaitGateVerified=false results zero push invocations, saved commit retained.

- [ ] **Step 2: Confirm RED.**

Run: `npm test -- src/features/publishing/workbench/terminal-runner.test.ts src/features/publishing/workbench/pre-transfer-gate.test.ts`; expected FAIL.

- [ ] **Step 3: Implement signatures and job transitions.**

Delegate secret entry to real visible native terminal/helper; app does not proxy stdin, capture credential prompts or accept passwords in forms/argv/config.
Before terminal open gate normally; after any wait require preTransferGate immediately before bytes transfer, checking fresh hostname/accepted registry, package/hash/preview and remote heads.
Corporate hooks are called via an approved chain; preserve original bytes/path/fingerprint. Gate chain order must be proved for actual transport by BP-06. Do not silently install a wrapper over unknown hooks.
If ordering cannot be guaranteed: stop safely before transfer, allow separate native authorization, re-preview/retry after fresh validation; never continue using previous grant.
Job states use T12: waiting_user + git.auth + GIT_AUTH_REQUIRED and nextAction job.openAuth; separate PR.auth + PR_AUTH_REQUIRED after Git success. openAuth itself never means push succeeded.
Cancel before transfer preserves branch/commit/package; cancellation after possible effect first reconciles remote and cannot erase accepted push.
Retain same prepared commit and revision on pure auth retry; changed main/content requires new preview/revision. Validate remote after exit 0 before creating PR.

- [ ] **Step 4: Confirm GREEN and build.**

Run same tests; expected PASS. Run `npm run build`; expected exit 0. Scripted/native local fixtures do not verify bank helper, GOST/smartcard/SSO or another OS.

- [ ] **Step 5: Commit.**

```text
git add src/features/publishing/workbench/terminal-runner.ts src/features/publishing/workbench/pre-transfer-gate.ts src/features/publishing/workbench/terminal-capability-profile.ts src/features/publishing/workbench/publishing-service.ts src/features/publishing/workbench/index.ts src/features/publishing/workbench/terminal-runner.test.ts src/features/publishing/workbench/pre-transfer-gate.test.ts
git commit -m "feat: gate interactive git after authorization waits"
```

### T26: Verified main и независимые оси PublicationAnchor

**Dependencies:** T22–T25, T03/T09. **AC:** AC-22, AC-28, AC-29, AC-45, AC-51, AC-53. **Spec:** 16 §6/11; 18 §12–14.

**Files:**
- Create: `src/features/publishing/workbench/publication-anchor.ts`, `publication-apply.ts`.
- Modify: `src/features/publishing/workbench/contracts.ts`, `publishing-service.ts`, `register-commands.ts`, `index.ts`.
- Test: `src/features/publishing/workbench/publication-anchor.test.ts`, `publication-apply.test.ts`.

**Interfaces:**
- Export `PublicationAnchor` with exactly 18 §12 fields, schemaVersion=1, id=packageId, targetBranch=main; no appliedAt field.
- `PublicationCheckResult={currentCommit:GitOid|null;availableCommit:GitOid|null;available:boolean;warnings:Problem[]}`.
- `PublicationApplyResult={appliedCommit:GitOid;stateRevision:RevisionToken;anchors:PublicationAnchor[];warnings:Problem[]}`.
- `verifyPublicationAnchor(input:{main:VerifiedMain;manifest:PackageManifest;evidence:MergeEvidence|null;verifiedAt:UtcInstant}):PublicationAnchor`.
- `PublicationApplyDependencies={repository:WorkbenchRepository;git:PublicationGitPort;artifacts:PackageArtifactStore;clock:Clock;bitbucket:BitbucketPort|null}`.
- `applyVerifiedPublication(context:CommandContext,input:{mainCommit:GitOid},deps:PublicationApplyDependencies):Promise<PublicationApplyResult>`; bitbucket=null допустим для reader и не блокирует verified Git apply.

- [ ] **Проверка специальной версии anchor:** при публикации package revision=1 сохранить confirmed/timeUnknown anchor; затем получить проверенный mergedAt и append metadata при expectedHead=1. Версия строки станет2, wire anchor.revision остаётся1, contentHash/mainCommit прежние; повторная старая expectedHead даёт conflict. Не применять Header.revision правило к package revision. Проверка относится к T03/T26 и выполняется в соответствующих repository/publication-anchor tests.

- [ ] **Step 1: Write failing tests.**

```ts
it('gitOnlyCurrentApplyWithoutTimestamp', async () => {
  expect(anchor).toMatchObject({id:packageId,packageId,publicationState:'confirmed',timeVerification:'unknown',mergedAt:null,mainCommit});
  expect(currentAssignment.ref).toEqual(newAssignmentRef);
  expect(currentOrgLink.ref).toEqual(newLinkRef);
  expect(wallClockQuery.error.code).toBe('EFFECTIVE_TIME_UNVERIFIED');
  expect(restCalls).toBe(0);
});
it('twoInstallationsAgreeOnAnchorAndNeverUsePullTime', async () => {
  expect(a.anchor.id).toBe(b.anchor.id);
  expect(a.anchor.mergedAt).toBe(b.anchor.mergedAt);
  expect(a.anchor.mergedAt).toBe(realProviderMergedAt);
  expect(a.appliedAt).not.toBe(b.appliedAt);
  expect(a.anchor).not.toHaveProperty('appliedAt');
});
it('unconfirmedOrBadManifestNeverActivatesAndRollbackIsAtomic', async () => {
  expect(beforeMergeActiveRef).toEqual(oldAssignmentRef);
  expect(failedApplyActiveCommit).toBe(oldCommit);
  expect(failedApplyActiveRef).toEqual(oldAssignmentRef);
  expect(savedOldBasis).toEqual(oldBasisBytes);
});
```

Also `sameUuidDifferentEntityTypesRemainDistinct`; `squashEvidenceMustNameVerifiedMainAndPackageHash`; `applyRetainsLocalSuccessfulFactsDraftsCorrectionsAndPreferences`.
Reject entire incoming version on unsupported schema/hash/ref/classification; no partial apply. Current source cache must not be replaced by older Git fallback.

- [ ] **Step 2: Confirm RED.**

Run: `npm test -- src/features/publishing/workbench/publication-anchor.test.ts src/features/publishing/workbench/publication-apply.test.ts`; expected FAIL.

- [ ] **Step 3: Implement signatures and registration.**

Check remote identity and commit in accepted main ancestry, validate exact package revision/hash/tree, stage artifacts before synchronous repository transaction.
Commit domain revisions, anchor records and appliedCommit together. Older saved bases/snapshots remain immutable; local unpublished objects do not become published because UUID happens to match.
publicationState=confirmed needs mainCommit and verifiedAt. timeVerification=verified additionally needs provider verified actual merge time matching commit/revision/hash; otherwise unknown, mergedAt=null, safe reason.
Never use authorDate/committerDate/createdAt/pulledAt/appliedAt as mergedAt. Later metadata enrichment updates anchor record without new package/PR or changing accepted content revision.
Register publication.check/apply for all roles, async. Check/poll reports availability only; apply requires explicit user command. No background auto-apply.
Historical revision/basis reads remain possible when mergedAt is unknown; only exact wall-clock boundary query is blocked.

- [ ] **Step 4: Confirm GREEN and build.**

Run same tests; expected PASS. Run `npm run build`; expected exit 0.

- [ ] **Step 5: Commit.**

```text
git add src/features/publishing/workbench/publication-anchor.ts src/features/publishing/workbench/publication-apply.ts src/features/publishing/workbench/contracts.ts src/features/publishing/workbench/publishing-service.ts src/features/publishing/workbench/register-commands.ts src/features/publishing/workbench/index.ts src/features/publishing/workbench/publication-anchor.test.ts src/features/publishing/workbench/publication-apply.test.ts
git commit -m "feat: apply verified main with independent publication time"
```

### T27: Обновление кода через существующий durable activation runtime

**Dependencies:** T03/T10–T12, T26. **AC:** AC-30, AC-50, AC-51. **Spec:** 18 §14; existing update protocol schemaVersion=1/bootstrap=1.

**Files:**
- Create: `src/features/system/workbench/code-update-service.ts`, `code-update-service.test.ts`.
- Modify: `src/features/system/code-update.ts`, `scripts/code-update-runtime.mjs`, `scripts/code-update-runtime.d.mts`, `scripts/dev.mjs` — extend lifecycle, durable commitpoint/recovery and IPC adapter.
- Modify: `src/features/system/transactional-update.test.ts`, `src/features/system/code-update.test.ts`.
- Modify: `src/server/workspace/context.ts` — recover workbench journal before imports/normal writes.

**Interfaces:**
- `CodeUpdateInput={expectedCommit:GitOid;targetCommit:GitOid}`, `CodeUpdateCheckInput=Record<string,never>`.
- `CodeUpdateCheckResult={currentCommit:GitOid;targetCommit:GitOid;available:boolean;launcherAvailable:boolean;warnings:Problem[]}`.
- `CodeUpdateApplyResult={currentCommit:GitOid;targetCommit:GitOid;rolledBack:boolean;recoveryRequired:boolean}`.
- `CodeUpdateService.check(context:CommandContext,input:CodeUpdateCheckInput):Promise<CodeUpdateCheckResult>`; `apply(context:CommandContext,input:CodeUpdateInput):Promise<CodeUpdateApplyResult>`.
- `CodeUpdateLauncherPort={available:()=>Promise<boolean>;request:(ticket:{id:UUIDv4;expectedCommit:GitOid;targetCommit:GitOid})=>Promise<void>;observe:(requestId:UUIDv4)=>Promise<CodeUpdateResult|null>}`; `new CodeUpdateService(deps:{projectRoot:string;config:CodeUpdateConfig;launcher:CodeUpdateLauncherPort;clock:Clock;jobs:JobStore;jobSink:JobSink})`.
- Existing `executeCodeUpdate(root,config,ticket,options:UpdateLifecycle):Promise<CodeUpdateResult>` and `recoverCodeUpdate(root):Promise<CodeUpdateResult|null>` remain launcher entry points.
- Extend `UpdateLifecycle` with `backupWorkspace?:()=>Promise<{backupId:string;sha256:RawSha256;bytes:number}>`, `restoreWorkspace?:(backupId:string)=>Promise<void>`; keep old databaseBackup field readable for interrupted schemaVersion=2 journals.
- Runtime journal schemaVersion=3 adds `workspaceBackup` and lifecycle owner; v2 recovery remains supported, unknown version => RECOVERY_REQUIRED.

- [ ] **Step 1: Write failing tests using fault injection at each durable boundary.**

```ts
it('committedFailureNeverRestoresOlderData', async () => {
  expect(result.currentCommit).toBe(targetCommit);
  expect(restoredOldDatabaseCalls).toBe(0);
  expect(newlyAcceptedFact).toEqual(factAfterCommitpoint);
});
it('beforeCommitpointRestoresMatchingCodeDatabaseAndFiles', async () => {
  expect(head).toBe(previousCommit);
  expect(activeDatabaseHash).toBe(previousDatabaseHash);
  expect(activeEvidenceHash).toBe(previousEvidenceHash);
  expect(result.rolledBack).toBe(true);
});
it('humanEditsAndFailedRollbackBlockWritesWithoutErasingChanges', async () => {
  expect(problem.code).toBe('RECOVERY_REQUIRED');
  expect(unknownHumanBytesAfter).toEqual(unknownHumanBytesBefore);
  expect(acceptedMutationCalls).toBe(0);
});
```

Extend existing tests: dependencies install while old app serves reads; failed install never quiesces; IPC ready does not open candidate writes before durable committed + activation; origin/expectedCommit change rejects; recovery runs before imports; v2 interrupted journals recover compatibly.

- [ ] **Step 2: Confirm RED.**

Run: `npm test -- src/features/system/workbench/code-update-service.test.ts src/features/system/transactional-update.test.ts src/features/system/code-update.test.ts`; expected new workbench cases FAIL.

- [ ] **Step 3: Implement lifecycle adapter; retain current algorithm.**

Sequence remains download/verify/prepare dependencies while old app works, quiesce, verified workspace backup, ff-only activate, closed bootstrap healthcheck, durable commitpoint, IPC activation.
Extend current runtime journal rather than replacing it with a new independent updater. Existing database-only rollback must also restore workbench files/active pointer when workbench storage is active.
Check clean tracked HEAD/origin both before preparation and activation. Do not reset human edits; recovery stops when ownership/revision no longer matches.
Failure before commitpoint restores matching old state; failure after it only restarts/repairs committed new state, never rolls back new user data. Unsuccessful recovery locks writes with RECOVERY_REQUIRED until resolved.
Wire CodeUpdateService into MaintenanceService T28 internally. Retain authenticated launcher IPC; no arbitrary command execution endpoint and no new public code.update command outside frozen 17.
Новый T13 Fastify factory получает узкий lifecycle adapter `{quiesce,resume,backupWorkspace,restoreWorkspace,activate}`; он не создаёт старый ApplicationContext/парольный RoleService ради reuse. Старые update/restore tests остаются baseline; новый runtime entry не регистрирует прежние password mutation routes.
T27 определяет snapshot lifecycle port и проверяет его fault-injection fixture; T28 подключает реальную полную archive implementation. Пока full workbench backup/restore callbacks отсутствуют, update с новой storage schema возвращает SCHEMA_UNSUPPORTED до quiesce, а не использует database-only rollback.

- [ ] **Step 4: Confirm GREEN and build.**

Run same tests; expected PASS. Run `npm run build`; expected exit 0. Actual bank runtime recovery remains BP-05.

- [ ] **Step 5: Commit.**

```text
git add src/features/system/workbench/code-update-service.ts src/features/system/workbench/code-update-service.test.ts src/features/system/code-update.ts scripts/code-update-runtime.mjs scripts/code-update-runtime.d.mts scripts/dev.mjs src/features/system/transactional-update.test.ts src/features/system/code-update.test.ts src/server/workspace/context.ts
git commit -m "feat: extend durable code activation to workbench storage"
```

### T28: Типизированный backup/restore, replace-preview и независимая rescue

**Dependencies:** T03/T10–T12, T27. **AC:** AC-30, AC-44, AC-45, AC-50, AC-51, AC-54. **Spec:** 15 §8; 17 §9; 18 §15.

**Files:**
- Create: `src/features/workspace-maintenance/workbench/contracts.ts`, `workspace-archive.ts`, `restore-service.ts`, `maintenance-service.ts`, `register-commands.ts`, `index.ts`.
- Create: `src/features/workspace-maintenance/workbench/download-routes.ts` — typed binary backup download, без file path из браузера.
- Modify: `src/features/workspace-maintenance/bundle-service.ts`, `recovery.ts`, `storage-service.ts`, `routes.ts` — explicit legacy guards, extend durable journal, disable automatic history disposal in workbench.
- Modify: `src/server/workspace/context.ts` — startup recovery gate.
- Modify: T10/T13 `src/server/workbench/routes.ts`, `application.ts` — подключить binary route к существующим session/origin guards и server-derived QueryContext; это файлы, создаваемые ранними задачами, сейчас их ещё нет.
- Test: `src/features/workspace-maintenance/workbench/restore-service.test.ts`, `workspace-archive.test.ts`, `maintenance-commands.test.ts`, `download-routes.test.ts`.

**Interfaces:**
- `BackupCreateInput={label:string|null;includeOriginals:boolean}`; `BackupCreateResult={backupId:UUIDv4;archiveSha256:RawSha256;bytes:number;createdAt:UtcInstant;sourceStateRevision:RevisionToken;empty:boolean;omissions:string[]}`.
- `RestorePreviewInput={fileHandle:UUIDv4}`; `RestorePreviewResult={restoreToken:string;archiveSha256:RawSha256;repoId:string;currentStateRevision:RevisionToken;currentEmpty:boolean;mode:'replace';expiresAt:UtcInstant;counts:{records:number;files:number};warnings:Problem[]}`.
- `RestoreApplyInput={restoreToken:string;confirmReplacement:true}`; `RestoreApplyResult={mode:'replace';appliedArchiveSha256:RawSha256;stateRevision:RevisionToken;rescue:{status:'created';backupId:UUIDv4}|{status:'empty';backupId:null};recheckRequired:true}`. bytes/counts целые >=0; RawSha256 без префикса.
- `MaintenanceService.createBackup(context:CommandContext,input:BackupCreateInput):Promise<BackupCreateResult>`; `previewRestore(context:CommandContext,input:RestorePreviewInput):Promise<RestorePreviewResult>`; `applyRestore(context:CommandContext,input:RestoreApplyInput):Promise<RestoreApplyResult>`.
- `BackupFile={stream:Readable;bytes:number;sha256:RawSha256;name:string}`; `Readable` — Node `node:stream`, bytes — safe integer >=0. `MaintenanceService.getBackupFile(context:QueryContext,backupId:UUIDv4):Promise<BackupFile>` проверяет ownership/repo/index/bytes/hash до выдачи stream.
- `BackupDownloadPort={backupFile:(backupId:UUIDv4,request:LocalRequest)=>Promise<BackupFile>}` расширяет WorkbenchHttpPort; application строит QueryContext по локальной сессии, а не принимает installationId/repo/role от браузера.
- `registerBackupDownloadRoutes(app:FastifyInstance,application:BackupDownloadPort,readRequest:(request:FastifyRequest)=>Promise<LocalRequest>):void`; routes.ts передаёт тот же read session/origin/host guard, что остальным authenticated GET.
- `MaintenanceService.checkCodeUpdate(context:CommandContext,input:CodeUpdateCheckInput):Promise<CodeUpdateCheckResult>`; `applyCodeUpdate(context:CommandContext,input:CodeUpdateInput):Promise<CodeUpdateApplyResult>` delegate T27.
- `registerMaintenanceCommands(registry:CommandRegistry,service:MaintenanceService):void`.
- `createWorkspaceArchive(context:CommandContext,input:BackupCreateInput,deps:ArchiveDependencies):Promise<BackupCreateResult>`; `validateWorkspaceArchive(bytes:Uint8Array):Promise<ValidatedWorkspaceArchive>`.
- `WorkspaceArchiveRecord={moduleId:string;schemaId:string;schemaVersion:number;key:string;value:unknown}`; registered module schema validates value, own namespace and references; unknown не разрешает произвольный namespace.
- `WorkspaceArchiveManifest={format:'uor-workspace-v1';version:1;applicationVersion:string;storageSchemaVersion:number;createdAt:UtcInstant;actor:ActorRef;recordsSha256:RawSha256;files:{path:string;sha256:RawSha256;bytes:number;kind:'evidence'|'original'|'module'}[];exclusions:string[]}`.
- `ValidatedWorkspaceArchive={manifest:WorkspaceArchiveManifest;records:WorkspaceArchiveRecord[];files:ReadonlyMap<string,Uint8Array>}`; personal preferences/anchor wire сохраняются через module schema, не принудительно Header[].
- `RestoreTokenRecord={token:string;archiveSha256:RawSha256;stateRevision:RevisionToken;repositoryId:string;installationId:UUIDv4;sessionId:string;expiresAt:UtcInstant;consumedBy:UUIDv4|null}` stored privately outside replaceable state.
- `ArchiveDependencies={repository:WorkbenchRepository;artifactRoot:string;files:FileStore;sessionId:(context:CommandContext)=>string;modules:ReadonlyMap<string,WorkspaceArchiveCodec>;lifecycle:WorkspaceLifecycle;clock:Clock}`.
- T14 `FileStore.read(handle:UUIDv4,installationId:UUIDv4,purpose:'goal-import'|'evidence'|'workspace-restore'):Promise<StagedFile>` из `src/server/workbench/files.ts`; StagedFile.bytesValue — проверенные immutable bytes. Restore читает только workspace-restore purpose, без browser path.
- `WorkspaceArchiveCodec={moduleId:string;exportRecords:(repository:WorkbenchRepository)=>WorkspaceArchiveRecord[];validate:(record:WorkspaceArchiveRecord)=>void;restoreRecords:(repository:WorkbenchRepository,records:WorkspaceArchiveRecord[])=>void;isUserData:(record:WorkspaceArchiveRecord)=>boolean}`; все module codecs обязательны для полной копии, отсутствие codec блокирует замену.
- `WorkspaceLifecycle={quiesce:(operationId:UUIDv4)=>Promise<void>;resume:()=>Promise<void>;activate:(stagedRoot:string)=>Promise<void>;recover:()=>Promise<void>}`; `MaintenanceDependencies={archive:ArchiveDependencies;codeUpdate:CodeUpdateService;jobs:JobStore;jobSink:JobSink}`; `new MaintenanceService(deps:MaintenanceDependencies)`.

- [ ] **Step 1: Write failing tests.**

```ts
it('changedAfterRescueKeepsActiveAndRescue', async () => {
  expect(result.error.code).toBe('PREVIEW_STALE');
  expect(activeHash).toBe(changedTargetHash);
  expect(verifiedRescueAvailable).toBe(true);
});
it('nonemptyReplaceWithSameIdsKeepsIndependentRescue', async () => {
  expect(preview.mode).toBe('replace');
  expect(result.rescue.status).toBe('created');
  expect(rescueRecords).toEqual(previousWholeState);
  expect(activeRecords).toEqual(incomingWholeState);
  expect(implicitMergedRecords).toHaveLength(0);
});
it('emptyTargetAndReplayHaveHonestSingleOutcome', async () => {
  expect(result.rescue).toEqual({status:'empty',backupId:null});
  expect(replayedResult).toEqual(result);
  expect(activationCalls).toBe(1);
});
it('restoreNeverImportsGrantsSessionsOrRegistryOnSameOrNewHost', async () => {
  expect(result.recheckRequired).toBe(true);
  expect(importedPrivatePolicyRecords).toHaveLength(0);
  expect(resolvedAccess.fresh).toBe(false);
});
```

Add expired token at exactly 30 minutes; changed personal setting/file/repo/hash/session => PREVIEW_STALE/ownership denial before active write. Job/preview technical changes alone do not invalidate token.
Add path traversal/ZIP bomb/declared extra file/hash/ref/schema mismatch, rescue failure abort, evidence included despite includeOriginals=false, reports/module data/history preserved.
Add viewer own archive success, foreign fileHandle denial, legacy route cannot bypass new service, rollback failure RECOVERY_REQUIRED, all history remains queryable after old retention timer fires.
`downloadMatchesRecordedHashAndOmitsPrivatePolicy`: GET собственного backupId =>200, Content-Type=application/zip, Content-Disposition attachment, Content-Length=recorded bytes, X-Archive-Sha256=recorded raw64hex; SHA-256 бинарного body равен backup.create.archiveSha256; ZIP не содержит registry/grants/session/cookies/connection secrets и JSON envelope отсутствует.
`foreignUnknownOrOtherRepoBackupIsNotFound`: неизвестный/чужой installationId/иной repo ID =>404 без stream/private metadata; own rescue backupId разрешается через независимый rescue index после replace. `tamperedBackupFailsBeforeHeaders`: изменённые bytes =>INTEGRITY_MISMATCH без частичной выдачи ZIP.

- [ ] **Step 2: Confirm RED.**

Run: `npm test -- src/features/workspace-maintenance/workbench/restore-service.test.ts src/features/workspace-maintenance/workbench/workspace-archive.test.ts src/features/workspace-maintenance/workbench/maintenance-commands.test.ts src/features/workspace-maintenance/workbench/download-routes.test.ts`; expected FAIL.

- [ ] **Step 3: Implement exact wire and durable replace.**

Resolve own fileHandle purpose workspace-restore, verify manifest/schema/hash/path/references in staging without active changes. Preview binds archive hash + all replaced records/files/preferences revision + repo + installation + local session, TTL 30 minutes.
Apply requires literal confirmReplacement=true. Nonempty target needs verified independent rescue including originals before replacement; schema/default metadata alone is empty. Preserve archive catalog outside replaceable DB.
After rescue and under quiesce recheck token/hash/stateRevision/repo; mismatch retains active and rescue. Stage migrations before atomic activation, write durable journal before switching DB/files/pointer, healthcheck then commit.
Use existing recovery.ts discipline; extend schemas for new owned active directories and commit marker, reject arbitrary destinations. Recover before startup imports. Failure preserves old coherent active or explicitly locks writes.
No rebindSelf: historical actor survives. Exclude registry/ownAccess cache/grants/sessions/secrets/cookies/managed browser profiles/screenshots/credentials/certificates/connection config from normal and rescue archive. Invalidate local admission cache after successful restore even on same hostname.
Register backup.create/backup.restore.preview/backup.restore.apply for all roles with session/CSRF/installation ownership; no curator-only guard copied from old bundle-service.
Register typed `GET /api/v1/backups/:backupId/file` для собственной установки и текущего configured repo; backupId разрешается только через own backup/rescue index, не как путь/URL. Ответ — binary application/zip + attachment с безопасным generated name, Content-Length и X-Archive-Sha256 raw64hex; no JSON envelope. Неизвестный/чужой backupId =>404. Обычный archive и rescue оба исключают private policy; восстановленная БД не заменяет индекс rescue/ownership.
Новая T13 factory не регистрирует старые restore/cleanup routes или retention timer; запросы дают 404/410. Старые module APIs получают explicit refusal при попытке открыть новый storage schema; это schema guard, не production runtime toggle. История остаётся бессрочно доступна через новые indexed queries.

- [ ] **Step 4: Confirm GREEN and build.**

Run the four new tests из Step 2 plus `npm test -- src/features/workspace-maintenance/recovery.test.ts src/features/system/restore-safety.test.ts`; expected PASS.
Run `npm run build`; expected exit 0. Bank full restore remains BP-05/BP-04.

- [ ] **Step 5: Commit.**

```text
git add src/features/workspace-maintenance/workbench/contracts.ts src/features/workspace-maintenance/workbench/workspace-archive.ts src/features/workspace-maintenance/workbench/restore-service.ts src/features/workspace-maintenance/workbench/maintenance-service.ts src/features/workspace-maintenance/workbench/register-commands.ts src/features/workspace-maintenance/workbench/index.ts src/features/workspace-maintenance/workbench/download-routes.ts src/features/workspace-maintenance/bundle-service.ts src/features/workspace-maintenance/recovery.ts src/features/workspace-maintenance/storage-service.ts src/features/workspace-maintenance/routes.ts src/server/workspace/context.ts src/server/workbench/routes.ts src/server/workbench/application.ts src/features/workspace-maintenance/workbench/restore-service.test.ts src/features/workspace-maintenance/workbench/workspace-archive.test.ts src/features/workspace-maintenance/workbench/maintenance-commands.test.ts src/features/workspace-maintenance/workbench/download-routes.test.ts
git commit -m "feat: replace workspaces with verified rescue and fresh admission"
```

### T29: Legacy staging migration и исполняемые probe drivers

**Dependencies:** T01–T03, T14–T28. **AC:** AC-30, AC-44, AC-50, AC-51, AC-54; QA-01; BP-01–BP-06 readiness. **Spec:** 18 §16/18; 19 §6–8.

**Files:**
- Create: `src/features/migration/workbench/legacy-migration.ts`, `legacy-migration.test.ts`, `contracts.ts`.
- Create: `src/features/system/workbench/bank-probe-contracts.ts`, `bank-probe-driver.ts`, `bank-probe-driver.test.ts`.
- Create: `scripts/probes/bank-probe.ts`, `scripts/probes/check-readiness.ts`.
- Create: `config/probes/bitbucket.example.json`, `registry.example.json`, `qlik.example.json`, `legacy.example.json`, `runtime.example.json`, `terminal.example.json`.
- Modify: `package.json` — actual probe script entries described below.
- Modify: `scripts/import-local.ts`, `scripts/local-history.ts` — explicit workbench guards; old direct activation/history clearing cannot bypass migration/indefinite history.

**Interfaces:**
- `LegacyStagingMigration.preview(context:CommandContext,input:LegacyMigrationInput):Promise<LegacyMigrationReport>`; `apply(context:CommandContext,input:{reportToken:string;confirmedMappings:LegacyIdMapping[]}):Promise<LegacyMigrationResult>`.
- `new LegacyStagingMigration(deps:{files:FileStore;repository:WorkbenchRepository;clock:Clock;stagingRoot:string;maintenance:MaintenanceService})`; source/mapping handles используют goal-import, attachment handles evidence; attachment bytes проверяются, не исполняются.
- `LegacyMigrationInput={sourceFileHandle:UUIDv4;attachmentFileHandles:UUIDv4[];mappingFileHandle:UUIDv4|null}`; fileHandles private/own installation, never arbitrary browser absolute paths.
- `LegacyIdMapping={legacyType:string;legacyId:string;targetRef:EntityRef}`.
- `LegacyMigrationReport={sourceHash:Sha256;reportToken:string;counts:{input:number;accepted:number;problematic:number};mappings:LegacyIdMapping[];issues:{legacyId:string;code:string;reason:string}[];basisVerified:boolean;warnings:Problem[]}`.
- `LegacyMigrationResult={sourceHash:Sha256;stateRevision:RevisionToken;counts:LegacyMigrationReport['counts'];requiresCuratorReview:true}`.
- `runBankProbe(profile:BankProbeProfile,options:{mode:'dry-run'|'read-only'|'test-write';approvalRef:string|null;reportDirectory:string}):Promise<BankProbeReport>`.
- `checkBankReadiness(reports:BankProbeReport[],required:BankProbeId[]):BankReadinessResult`; profile/report discriminated schemas specified in `05-bank-probes.md`.

- [ ] **Step 1: Write failing tests.**

```ts
it('migrationPreservesOriginalsHistoryAndUnknownBasisWithoutGuessing', async () => {
  expect(report.counts.input).toBe(report.counts.accepted + report.counts.problematic);
  expect(migratedOriginalBytes).toEqual(legacyOriginalBytes);
  expect(unknownMethodIssue.code).toBe('LEGACY_BASIS_UNVERIFIED');
  expect(inventedEffectiveDates).toHaveLength(0);
  expect(migratedHistoryIds).toEqual(allLegacyHistoryIds);
});
it('sameSourceReplayAndFailedMigrationNeverDuplicateOrActivatePartial', async () => {
  expect(secondResult).toEqual(firstResult);
  expect(duplicateRecords).toHaveLength(0);
  expect(failedRunActiveRevision).toBe(originalActiveRevision);
});
it('missingBankParametersNeverBecomeReady', async () => {
  expect(report.status).toBe('not_ready');
  expect(report.missingInputs).toContain('edition');
  expect(report.externalWrites).toBe(0);
  expect(checkBankReadiness([report],['BP-01']).ready).toBe(false);
});
it('testWriteRequiresExplicitApprovalAndDryRunNeverConnects', async () => {
  expect(unapproved.error.code).toBe('PROBE_WRITE_NOT_APPROVED');
  expect(dryRunNetworkCalls).toBe(0);
  expect(redactedReport).not.toContain(sentinelSecret);
});
```

Add `fakeContractCannotSatisfyRealEvidence` and `missingSixReportsStayBlocked`; reject BP/P number confusion; no 2k aggregate row cap; synthetic data over 2k across captures remains migratable.

- [ ] **Step 2: Confirm RED.**

Run: `npm test -- src/features/migration/workbench/legacy-migration.test.ts src/features/system/workbench/bank-probe-driver.test.ts`; expected FAIL.

- [ ] **Step 3: Implement exact interfaces and actual script entries.**

Read inert legacy source into staging; map stable IDs deterministically using persisted mapping, verify comments/history/attachments/ref chains, keep originals. Preserve missing methodology/date/origin as explicit issue; old numericThreshold heuristic does not create MethodVersion.
SourceHash + mapping revision identifies repeat; curator reportToken binds target revision and source, apply uses same staged/verified/rescue discipline as T28. Actual legacy source/expected counts still require BP-04.
Add package scripts exactly: `probe:bank` → `tsx scripts/probes/bank-probe.ts`; `probe:readiness` → `tsx scripts/probes/check-readiness.ts`.
Driver `--probe BP-01 --profile <path> --mode dry-run --report-dir <private path>`; default mode dry-run validates/redacts only, no network or active changes. read-only allows approved reads; test-write additionally requires explicit approvalRef and sandbox target.
Without a real provider binding, driver emits not_ready with missing dependency; it never runs fake adapter as bank evidence. Safe examples use nulls/placeholders, not bank endpoints or guessed SSO.
Real Qlik binding требует T45 и BP-03: основной способ уже задан пользователем — managed persistent СберБраузер, запись/finish/save действий для known report URL и автореплей загрузки, а не выбор Engine API. T46 — wizard, T47 — реальная локальная Chromium fixture, T48 — банк. Скачанный этим сценарием CSV/XLSX остаётся источником ОКО, не manual-file fallback.
Readiness separates contractPassed from bankVerified and records each capability; report exit 0 only for actual requested mode success, 2 for not_ready, 1 for failed.
Guard scripts/import-local.ts against direct workbench active import; old history archive command refuses workbench mode until replaced by nondeleting archive projection, preserving all original history.

- [ ] **Step 4: Confirm GREEN, exercise dry-run and build.**

Run the two tests; expected PASS. Run `npm run build`; expected exit 0.
Run `npm run probe:bank -- --probe BP-01 --profile config/probes/bitbucket.example.json --mode dry-run --report-dir .runtime/probe-reports/planning-smoke`; expected exit 2, not_ready, externalWrites=0.
Run `npm run probe:readiness -- --reports .runtime/probe-reports/planning-smoke --require BP-01,BP-02,BP-03,BP-04,BP-05,BP-06`; expected exit 2 listing missing/unverified probes.
Эти команды существуют только после T29. Сейчас их не выполнять; положительной банковской проверки они сами по себе не дают.

- [ ] **Step 5: Commit exact files.**

```text
git add src/features/migration/workbench/legacy-migration.ts src/features/migration/workbench/legacy-migration.test.ts src/features/migration/workbench/contracts.ts src/features/system/workbench/bank-probe-contracts.ts src/features/system/workbench/bank-probe-driver.ts src/features/system/workbench/bank-probe-driver.test.ts scripts/probes/bank-probe.ts scripts/probes/check-readiness.ts config/probes/bitbucket.example.json config/probes/registry.example.json config/probes/qlik.example.json config/probes/legacy.example.json config/probes/runtime.example.json config/probes/terminal.example.json package.json scripts/import-local.ts scripts/local-history.ts
git commit -m "feat: stage legacy migration and explicit bank readiness probes"
```

## Передача после T29

- [ ] Запустить объединённые focused tests T22–T29 и `npm run build` на combined commit; полный `npm test` принадлежит финальному gate главного плана.
- [ ] Передать UI исполнителю exports PublishingService/registerPublishingCommands и MaintenanceService/registerMaintenanceCommands; browser получает только wire DTO, не checkout paths/registry/private profiles.
- [ ] В отчёте отдельно перечислить AC evidence и BP/not_ready; fake tests не доказывают bank auth, merge metadata, hooks или реальные исходники миграции.
- [ ] Реальные адаптеры реализуются только после probe и отдельного provider-specific subplan по `05-bank-probes.md`; неизвестная банковская среда не заполняется догадкой.
