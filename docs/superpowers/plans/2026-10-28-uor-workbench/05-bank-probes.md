# Банковские probes и provider-specific subplans — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Обычные Git/npm достаточны, если у исполнителя нет skills.

**Goal:** Получить проверяемые сведения о разрешённой банковской среде до реализации реальных bindings и отделить локальные tests от корпоративной готовности.

**Architecture:** T29 создаёт один typed probe driver, шесть discriminated профилей, отчёт и readiness checker. Dry-run валидирует профиль без сети; read-only собирает разрешённые сведения; test-write требует отдельного явного согласования. После результата оформляется отдельный точный subplan, который выбирает provider wire и binding, а не заполняет пробелы предположениями.

**Tech Stack:** Node.js 22.16.0, npm 10.9.2, TypeScript/tsx, Zod, Git CLI; Python 3.13.5 при доказанной необходимости адаптера.

**Spec:** Frozen 15–19 в `docs/superpowers/specs/2026-10-28-uor-workbench/`; public interfaces `CONTRACTS.md` K01–K05; driver task T29 в `03-publication-and-recovery.md`.
Уточнение пользователя и дополнение 21: основной ОКО способ — managed persistent СберБраузер + recorder/replay known report URL; подробные T42–T48 находятся в части 06.

## Global Constraints

- Сейчас только план: никаких банковских подключений, сетевых записей, PR, ACL или реальной миграции не выполняется.
- Repo разработки GitHub и корпоративный Bitbucket продукта различны. В repo попадают только синтетические examples и обезличенные итоги, не банковские источники/адреса/credentials.
- Default `dry-run`: zero network, zero external writes, zero active-state writes. Отсутствие профиля/версии/входа — not_ready, а не success.
- `read-only`: разрешённые чтения, локальный приватный отчёт; remote mutation count=0.
- `test-write`: только после явного согласования владельцем конкретных repo/ветки/PR/операций и approvalRef; не main, не рабочие ACL сотрудников.
- Реальный Git-auth не подтверждает REST-auth; hostname не сопоставляется с аккаунтом Bitbucket.
- Hooks, TLS, helpers/ASKPASS не обходятся; full registry и секреты не попадают в diagnostics.
- 2 000 строк одного получения — мягкий нагрузочный профиль, бессрочная история и совокупный объём им не ограничиваются.
- До предоставления bank host/edition/version/разрешённого входа, legacy данных и ноутбука соответствующие bindings и production acceptance остаются not_ready.

## Review Focus

1. Пустой или placeholder профиль — not_ready до сети: T29 `missingBankParametersNeverBecomeReady`.
2. Fixture/fake может дать contractPassed, но не bankVerified: T29 `fakeContractCannotSatisfyRealEvidence`.
3. Test-write без согласованной цели — отказ до эффекта: T29 `testWriteRequiresExplicitApprovalAndDryRunNeverConnects`.
4. Приватный endpoint/Authorization/cookie в исключении — redaction до отчёта: T29 `redactsProbeInputsAndErrors`.
5. BP/P нумерация или пропущенный evidence повышает готовность ошибочно — T29 `missingSixReportsStayBlocked`.

## Реальные команды и файлы, создаваемые T29

- [ ] T29 создаёт `scripts/probes/bank-probe.ts`, `scripts/probes/check-readiness.ts` и package.json scripts `probe:bank`, `probe:readiness`.
- [ ] T29 создаёт `src/features/system/workbench/bank-probe-contracts.ts`, `bank-probe-driver.ts`, `bank-probe-driver.test.ts`.
- [ ] Examples: `config/probes/{bitbucket,registry,qlik,legacy,runtime,terminal}.example.json`, null/placeholder values, no credentials.
- [ ] Фактические локальные профили хранить в `.runtime/local-config/probes/*.json`, evidence в `.runtime/probe-reports/<runId>/`; это приватные пути вне публикуемого package manifest.

```text
npm run probe:bank -- --probe BP-01 --profile config/probes/bitbucket.example.json --mode dry-run --report-dir .runtime/probe-reports/bp01-dry
npm run probe:bank -- --probe BP-02 --profile config/probes/registry.example.json --mode dry-run --report-dir .runtime/probe-reports/bp02-dry
npm run probe:bank -- --probe BP-03 --profile config/probes/qlik.example.json --mode dry-run --report-dir .runtime/probe-reports/bp03-dry
npm run probe:bank -- --probe BP-04 --profile config/probes/legacy.example.json --mode dry-run --report-dir .runtime/probe-reports/bp04-dry
npm run probe:bank -- --probe BP-05 --profile config/probes/runtime.example.json --mode dry-run --report-dir .runtime/probe-reports/bp05-dry
npm run probe:bank -- --probe BP-06 --profile config/probes/terminal.example.json --mode dry-run --report-dir .runtime/probe-reports/bp06-dry
npm run probe:readiness -- --reports .runtime/probe-reports --require BP-01,BP-02,BP-03,BP-04,BP-05,BP-06
```

Эти команды станут доступны после T29; dry-run examples ожидаемо exit 2/not_ready. Они не запускают реальный binding и не разрешают test-write.
Для фактического read-only использовать ту же команду с личным profile и `--mode read-only`; test-write дополнительно `--approval-ref <LOCAL_APPROVAL_RECORD>`.
`<LOCAL_APPROVAL_RECORD>` — непрозрачный локальный ID сохранённого согласования, не секрет и не самоподписанный флаг обхода. Driver сверяет scope approved operations/targets/expiry в приватной записи.
Driver не выдаёт approval сам; человек явно задаёт разрешённые внешние действия. Cleanup созданного тестового PR/branch также входит в согласованный scope и не выполняется через force/reset.

## Общий typed envelope

```ts
type BankProbeId='BP-01'|'BP-02'|'BP-03'|'BP-04'|'BP-05'|'BP-06';
type ProbeMode='dry-run'|'read-only'|'test-write';
type ProbeBase={schemaVersion:1;probe:BankProbeId;profileId:string;environmentLabel:string;
  credentialProfileRef:string|null;approvedOrigins:string[];evidenceDirectory:string};
type BankProbeProfile=BitbucketProbeProfile|RegistryProbeProfile|QlikProbeProfile|
  LegacyProbeProfile|RuntimeProbeProfile|TerminalProbeProfile;
type BankProbeReport={schemaVersion:1;probe:BankProbeId;runId:string;profileId:string;
  mode:ProbeMode;startedAt:string;finishedAt:string;status:'passed'|'failed'|'not_ready';
  environment:{node:string;npm:string;python:string|null;os:string;git:string|null};
  contractPassed:boolean;bankVerified:boolean;missingInputs:string[];
  checks:{id:string;status:'passed'|'failed'|'not_run';evidenceRefs:string[];reason:string|null}[];
  externalWrites:number;limitations:string[];redactedInputHash:string};
type BankReadinessResult={ready:boolean;required:BankProbeId[];
  blocked:{probe:BankProbeId;reason:string;capabilities:string[]}[]};
```

Return exit 0 только когда запрошенный реальный mode выполнен; exit 2 — missing inputs/not_ready, exit 1 — выполненная неуспешная проверка.
Readiness не выводится из exit code dry-run: bankVerified=true требует реального environment evidence, не synthetic adapter. Profiles и отчёты имеют strict discriminated schemas.
`credentialProfileRef` — локальная ссылка на разрешённое подключение, не password/token/cert bytes. Секретные значения не выводятся даже при parse/network error.
Каждый check содержит дату/безопасные входы/фактический результат/ограничения/evidence; requested-but-not-run не превращается в passed.

## BP-01 — native Bitbucket и merge evidence

**Соответствие:** 19 BP-01 объединяет 18 P-02 (native PR) и P-03 (merge evidence). 19 BP-02 относится к служебному реестру, а не к PR.
**Input:**

```ts
type BitbucketProbeProfile=ProbeBase&{probe:'BP-01';repositoryId:string|null;
  origin:string|null;edition:string|null;version:string|null;testBranch:string|null;
  existingTestPrId:string|null;allowedAuthenticationDescription:string|null;
  mergeExamples:{kind:'merge'|'squash'|'fast-forward';prId:string;mainCommit:string}[]};
```

Safe example: origin=null, edition=null, version=null, testBranch=null, mergeExamples=[]; строки `<BANK_ORIGIN>` не считаются валидным host.
- [ ] Read-only: согласованная версия/edition, permissions и ограничения main, чтение PR/comments/status/source/target commits, фактический автор, возможность поиска stable package marker.
- [ ] Test-write после отдельного согласования: один native PR; потерянный create response и find/reconcile без дубля; update same open PR; declined/explicit rework; независимость двух кураторов.
- [ ] Merge примеры выполняет владелец во внешнем Bitbucket; приложение не вызывает merge. Сопоставить accepted revision/hash с mainCommit для normal/squash/FF.
- [ ] Зафиксировать фактическое mergedAt или capability unsupported с причиной. Не подставлять commit dates/pull time.
- [ ] До результата заблокирован real Bitbucket binding T24; неизвестный timestamp блокирует только точные wall-clock history операции, не confirmed Git current apply T26.
**Результат:** redacted capability profile + request/response schemas/статусы/корреляция маркера, фактические ограничения. SSH Git success не считается REST success.

## BP-02 — закрытый registry и отзыв допуска

```ts
type RegistryProbeProfile=ProbeBase&{probe:'BP-02';origin:string|null;repositoryId:string|null;
  acceptedBranch:string|null;registryPath:string|null;curatorProfileRef:string|null;
  chiefProfileRef:string|null;unknownHostname:string|null;revokedHostname:string|null};
```

- [ ] Read-only: прочитать принятую ветку/файл по schema 15, серверный hostname, case/whitespace normalization, duplicate rejection, активный/неизвестный/выключенный профиль.
- [ ] Проверить curator Read и отсутствие registry write (включая inherited permissions), chief exclusive write/защиту accepted branch документальным evidence; не менять рабочие ACL ради теста.
- [ ] На согласованном тестовом registry change: отзыв после очереди и во время auth; fresh gate перед каждым push/PR write/retry даёт zero writes.
- [ ] Проверить network/auth expired отдельно от explicit Read denied; старый own offline profile допускает только локальные drafts, не publication.
- [ ] Не включать полный registry, чужие hosts/persons или serviceSettings в отчёт/reader API/backup; restored own cache не становится grant.
**Blocked:** реальный T11 registry binding и fresh permission production acceptance; локальные схемы/синтетический policy test остаются независимы.

## BP-03 — один фактический источник ОКО/Qlik

```ts
type QlikProbeProfile=ProbeBase&{probe:'BP-03';goalRef:string|null;sourceLocator:string|null;
  acquisition:'sberbrowser-recorder';sberBrowserExecutable:string|null;authenticationSelector:string|null;
  browserScenarioRef:{entityType:'browser_scenario';id:string;revision:number}|null;
  managedProfileRef:string|null;contextDescription:string|null;expectedRows:number|null;expectedKeys:string[];
  expectedDateFields:string[];completenessReference:string|null};
```

- [ ] Read-only: проверить заданный основной способ managed persistent СберБраузер, фактический executable/known report URL/SSO и разрешённый local profile; реальные адреса/certificates/auth selector предоставляет среда, не проектировщик.
- [ ] На разрешённом отчёте проверить startRecording → click/filter/download sequence → finish/save, затем автоматический replay. Переиспользовать существующие browser.ts startRecording/finishRecording/executeBrowser через T42–T45; T46 — мастер, T47 — локальный browser fixture; mock recorder tests не доказывают bank SSO.
- [ ] Определить реальные бизнес-ключи, даты измерения/обновления, units, поля Decimal, filters и права; сохранить обезличенный schema sample, не raw bank rows в repo.
- [ ] Доказать все страницы/лимиты/export/object bounds; первая страница, HTTP 200 или файл не доказывают completeness.
- [ ] Убедиться в стабильности filters/selectors, завершении download и полном наборе CSV/XLSX. Это первичный источник ОКО даже при файловом output; manual file fallback не включается.
- [ ] Проверить denied/truncation/schema-change/cancel; последний успешный набор не затёрт и факт 0 не создан.
- [ ] Измерить 2k-row profile и допустимый больший набор; профиль не превращать в aggregate cap и не обещать все Qlik deployments.
**Blocked:** real Qlik binding требует T45 + BP-03/QA-01 bank golden; независимые file/manual modes и общий parser/evaluator не блокируются. Engine API — возможное отдельное будущее расширение, не первый способ.

## BP-04 — реальные legacy данные и вложения

```ts
type LegacyProbeProfile=ProbeBase&{probe:'BP-04';sourceArchivePath:string|null;
  attachmentsRoot:string|null;expectedCounts:{records:number;comments:number;history:number;files:number}|null;
  curatorReviewReference:string|null;sourceFormatDescription:string|null};
```

Local CLI paths разрешены только из configured allowed roots; browser migration использует T29 fileHandles. Safe examples содержат null paths.
- [ ] Read-only: inventory реальной прежней карты/справочников/comments/history/attachments, source hashes и expected curator counts.
- [ ] Staging: stable ID map, input=accepted+problematic counts, dangling refs/unknown methodology/dates/origin, byte hashes, повтор без дубля.
- [ ] Даты миграции не становятся измерением/effectiveAt; старый agreed basis не пересчитывается нынешней методикой.
- [ ] Проверка куратора сохраняется отдельно от machine validation; реальные bank golden/проблемы не заменяются demo fixtures.
- [ ] Apply в тестовом пустом/непустом локальном target только после согласования замены; verified rescue и старый active доступны при fault injection.
**Blocked:** production migration completeness и real QA-01; synthetic migration correctness не снимает зависимость.

## BP-05 — фактический рабочий ноутбук, update и restore

```ts
type RuntimeProbeProfile=ProbeBase&{probe:'BP-05';workspaceRoot:string|null;
  nodeExecutable:string|null;npmExecutable:string|null;gitExecutable:string|null;
  pythonExecutable:string|null;caProfileRef:string|null;proxyProfileRef:string|null;
  testUpdateCommit:string|null;disposableWorkspaceRoot:string|null};
```

- [ ] Read-only: runtime версии, Git, SQLite, разрешённые roots/права, CA/proxy/TLS, writable private areas и запрет static leakage.
- [ ] Локальный согласованный disposable target: запуск empty workspace, чтение источника, indexed search/history, backup/restore и code update штатным launcher.
- [ ] Fault injection до/после durable commitpoint, IPC activation, recovery before imports, human edit refusal, RECOVERY_REQUIRED write lock.
- [ ] Замер: hardware/history size, repeats/p50/p95/peak memory/errors/cancel; отдельно network wait и CPU/SQLite. List/search p95≤500ms, 2k normalize/evaluate≤2s — проектные цели, не объявленные достижения.
- [ ] Запуск Windows fixture не подтверждает СберОС/macOS/Office/GOST/smartcard; report перечисляет только фактическую среду.
**Blocked:** bank deployment/runtime acceptance, совместимость и recovery; локальный build не снимает BP-05.

## BP-06 — interactive Git и post-wait pre-transfer gate

```ts
type TerminalProbeProfile=ProbeBase&{probe:'BP-06';gitExecutable:string|null;
  transport:'https'|'ssh'|null;nativeTerminalDescription:string|null;helperDescription:string|null;
  repositoryId:string|null;origin:string|null;approvedTestBranch:string|null;
  corporateHooksDescription:string|null;corporateHooksFingerprint:string|null};
```

- [ ] Read-only: точные Git/OS/transport/helper/ASKPASS/hooks и approved launch mechanism; не выводить из наличия Git поддержку другого транспорта/OS.
- [ ] Test-write с approvalRef: сохранить один prepared commit, вызвать настоящий native auth, самостоятельно введённый пользователем credential не проходит app logs/stdin/config.
- [ ] Доказать порядок auth wait → native resume → corporate hooks → fresh hostname/registry/package/remote gate → transfer; wrapper не перезаписывает hook, нет --no-verify.
- [ ] Отзыв/изменение main во время wait даёт zero transfer; если доказать безопасный порядок нельзя, передача unsupported, сохраняется commit и доступен безопасный отдельный auth/retry.
- [ ] Cancel/closed terminal/nonzero/unknown outcome сохраняют package/branch/commit; exit 0 подтверждается remote OID. Replay не создаёт новый commit/PR.
- [ ] Git success + отдельный REST login даёт waiting_user PR.auth/PR_AUTH_REQUIRED; после входа свежий gate, тот же PR-stage, без account matching.
**Blocked:** production TerminalRunner profile; локальный scripted trace не доказывает реальную корпоративную цепочку hooks.

## Где и как создавать следующий provider-specific subplan

- [ ] После BP-01/P-02 записать `docs/superpowers/plans/2026-10-28-uor-workbench/provider-subplans/bitbucket-<profileId>.md`.
- [ ] После BP-02 — `provider-subplans/registry-<profileId>.md`; BP-03 — `provider-subplans/qlik-<profileId>.md`; BP-04 — `provider-subplans/legacy-<profileId>.md`; BP-05 — `provider-subplans/runtime-<profileId>.md`; BP-06 — `provider-subplans/terminal-<profileId>.md` под той же папкой.
- [ ] profileId нормализовать safe ASCII slug без bank host/person name; нельзя использовать input path как filename.
- [ ] Каждый subplan содержит evidence run IDs/date/environment/hash, точные edition/version и capabilities, разрешённые origins/transport по config refs и blocked cases.
- [ ] Перечислить точные Create/Modify paths, factory exports и T13 binding injection, existing port methods и конкретный wire request/response/status/error mapping с redacted синтетическими примерами.
- [ ] Для Bitbucket: observed routes/methods/header names/API version, marker search/pagination/version concurrency, PR lifecycle, actual author, auth renewal, timeout reconciliation и merge-to-main evidence normal/squash/FF; secret header values отсутствуют.
- [ ] Для registry: accepted branch/path/schema/hostname normalization, readonly permission evidence, revoke/expiry/offline distinctions и свежие gate checks; нет Bitbucket account binding.
- [ ] Для Qlik: точный SberBrowser executable/launch profile и recorder/replay wire T42–T45, мастер T46 и fixture T47, auth selector и SSO observation, реальные поля/ключи/date/units/filters/download/page bounds/fullness proof, source-schema-change mapping; no guessed auth. Shared browser_scenario/source ref публикуются общим PR, local profile/cookies исключаются.
- [ ] Для terminal: exact native launch/argv/cwd/process ownership, helper inheritance, corporate hook chain preservation/fingerprint, post-wait gate timing proof, abort/exit/remote verification и unsupported cases.
- [ ] Для legacy/runtime: mapping tables/expected counts/basis unknowns и rescue/rollback/commitpoint ownership; documented version upgrade/recovery compatibility.
- [ ] Каждый содержит RED test names+assertions, runnable commands, GREEN/build, exact staged files/commit, AC/BP evidence boundary и человеческую проверку конкретного binding.
- [ ] До probe нет выдуманного endpoint/SSO/пароля и нет production binding; после probe документация выбирает наблюдённый wire, executor реализует только reviewed subplan.

## Readiness gate

- [ ] `probe:readiness` перечисляет capability-specific missing/failed checks, не один общий зелёный флаг из mock tests.
- [ ] PR write требует BP-01 native PR + BP-02 fresh registry + BP-06 safe interactive path; precise history additionally needs BP-01 merge time evidence.
- [ ] Current verified main reading/apply не требует REST у каждого reader; неизвестное mergedAt остаётся unknown.
- [ ] Реальный Qlik ждёт BP-03, реальный перенос BP-04, банковская эксплуатация BP-05. Независимые file/manual/contracts можно реализовать до них.
- [ ] Production release требует требуемые AC, real migration/recovery и нужные BP; отсутствие банка означает честное not_ready, не завершающий synthetic PASS.
