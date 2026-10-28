# Progress / журнал исполнения

Implementation started on 2026-10-28. See run entries below; task statuses are evidence-based.
Branch: `codex/uor-workbench-rebuild`. Source code baseline: `3d8704e4a6ff2195af4f2c0602ed11bff5d38f4b`.

## Continue here

T00–T14 are implemented and checked. T19 has a checked foundation with later bindings still pending. **User priority now overrides the default order: OKO browser recording/replay and actual download first, then enrichment; other work is deferred.** Read the latest run entry and [core checkpoint review](CORE_CHECKPOINT_REVIEW.md). The workbench remains separate from the production entry (T39); no live data has been migrated.

Resume commands from the repository root:

```text
git branch --show-current
git status --short
git log -12 --oneline
node docs/superpowers/plans/2026-10-28-uor-workbench/verify-plan.mjs
```

Use Node22.16.0/npm10.9.2. On this Windows executor the portable runtime is already cached in `.runtime/toolchains/node-v22.16.0-win-x64`; prepend its absolute path to PATH and use `npm.cmd`. On another machine use the standard installed target runtime, not that machine-specific path. Never reinstall over live workspace data.

The OKO runtime/recorder, pure parser/mapping, export validation and enrichment core are checked together:134files/712tests PASS plus build on Node22.16/npm10.9.2. Continue with the missing own v1 command/query bindings and the narrow OKO record/test interface, then production source wiring with explicit coverage and published scenario references. Do not redo T43 or the pure parser/enrichment core. Filters and export clicks come from interaction; completed nonempty download ends recording automatically. T44 shared draft publication and T45 production source wiring still require their actual prerequisites; do not claim them complete merely because the runtime works. T19 and general platform/cutover work remain deferred. Preserve failed-collection fallback and original dates; no hidden file fallback for Qlik.

## Task status

Statuses: PLANNED / RUNNING / DONE / BLOCKED_RUNTIME / BLOCKED_BANK_INPUT / FAILED.
DONE requires actual checks, commit and evidence. Default execution order is in the main plan; numeric order alone is incorrect.

| Task | Plan | Deliverable | Status | Commit / evidence |
| --- | --- | --- | --- | --- |
| T00 | Main plan | Verify branch/runtime/baseline | DONE | 99 files /475 tests GREEN; exact-base build GREEN on Node22.16.0/npm10.9.2 |
| T01 | [01-core-and-calculation.md](01-core-and-calculation.md) | Exact numbers, primitive validation and Moscow time | DONE | Commit titled `feat(workbench): add exact numeric and time primitives`; 5 tests + build GREEN |
| T02 | [01-core-and-calculation.md](01-core-and-calculation.md) | All domain-16 contracts, strict schemas, version references and fixture factories | DONE | Commit titled `feat(workbench): define versioned domain schemas and fixtures`; T01–T02 10 tests + build GREEN |
| T03 | [01-core-and-calculation.md](01-core-and-calculation.md) | Append-only SQLite repository, CAS, synchronous transaction and index foundation | DONE | Commit titled `feat(workbench): add append-only CAS repository`; 29 focused/regression checks + build GREEN |
| T04 | [01-core-and-calculation.md](01-core-and-calculation.md) | Exact conditions, normalization contracts and whitelist reducers | DONE | Commit titled `feat(workbench): implement exact conditions and reducers`; 3 tests with numeric vectors + build GREEN |
| T05 | [01-core-and-calculation.md](01-core-and-calculation.md) | Fact selection, explicit time, freshness and expected population | DONE | Commit titled `feat(workbench): select complete facts with explicit time`; T04–T05 9 tests + build GREEN |
| T06 | [01-core-and-calculation.md](01-core-and-calculation.md) | Numeric evaluator: weighted N/A, preliminary score and independent mandatory gate | DONE | Commit titled `feat(workbench): evaluate weighted goals without lossy numbers`; 38 focused/regression tests + build GREEN |
| T07 | [01-core-and-calculation.md](01-core-and-calculation.md) | Basis materialization, exact method resolution, manual/correction/attestation/snapshot rules | DONE | Commit titled `feat(workbench): materialize immutable bases and confirmation rules`; 13 focused tests + build GREEN |
| T08 | [01-core-and-calculation.md](01-core-and-calculation.md) | Friday projection with original provenance and no invented measurement | DONE | Commit titled `feat(workbench): project Friday series with retained source dates`; 3 tests + build GREEN |
| T09 | [01-core-and-calculation.md](01-core-and-calculation.md) | Indexed history queries and immutable agreed retention | DONE | `2b3dc5f`; 3001 rows, frozen basis, keyset pagination; 9 focused tests |
| T10 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Строгий wire, локальная сессия и CSRF | DONE | `2a2c033`; protocol/session/origin/CSRF/error tests |
| T11 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Политика hostname и непереносимый собственный cache | DONE | `874b600`; 24 focused tests incl actual private cache |
| T12 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Durable command registry, задания и идемпотентность | DONE | `1775ad3`; installation-scoped eligible local restart recovery, atomic receipt reconciliation, indexed checkpoints; full 598/598 GREEN |
| T13 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Статические модули, запросы и изолированная сборка v1 | DONE | Commit titled `feat(workbench): reconcile queued jobs during isolated startup`; real restart/session/job/replay HTTP test, full 598/598 + build GREEN |
| T14 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Приватные uploads и источник → raw → normalize → capture | DONE | Commit titled `feat(workbench): stage private uploads and retain source capture lineage`; focused69/69 + build; source/file scoped re-reviews PASS |
| T15 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | CSV/XLSX mapping, partial import и редакции исходных фактов | RUNNING | Lossless parser + pure mapper checked in full712/712; generic import/apply deferred |
| T16 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Версионное обогащение и назначения новой команды | RUNNING | Pure enrichment/validation/versioned reads11focused + full712/712; proposals/production binding deferred |
| T17 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Незавершённые черновики, evidence и точное подтверждение/срез | PLANNED | Not executed |
| T18 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Работы, решения и ацикличные зависимости | PLANNED | Not executed |
| T19 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Московский календарь, адресные уведомления и личные подписки | RUNNING | `6810b40`; foundation 14 tests GREEN; T17/T18/query bindings pending |
| T20 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Схемы полей/дашбордов и личные предпочтения | PLANNED | Not executed |
| T21 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Индексированные модели пяти экранов и общий поиск | PLANNED | Not executed |
| T22 | [03-publication-and-recovery.md](03-publication-and-recovery.md) | PackageRevision, manifest, canonical hash и preview | PLANNED | Not executed |
| T23 | [03-publication-and-recovery.md](03-publication-and-recovery.md) | Собственная staging-ветка и безопасный Git provider | PLANNED | Not executed |
| T24 | [03-publication-and-recovery.md](03-publication-and-recovery.md) | Нативный Bitbucket port, recovery и capability profile | PLANNED | Not executed |
| T25 | [03-publication-and-recovery.md](03-publication-and-recovery.md) | TerminalRunner, native auth и fresh gate после ожидания | PLANNED | Not executed |
| T26 | [03-publication-and-recovery.md](03-publication-and-recovery.md) | Verified main и независимые оси PublicationAnchor | PLANNED | Not executed |
| T27 | [03-publication-and-recovery.md](03-publication-and-recovery.md) | Обновление кода через существующий durable activation runtime | PLANNED | Not executed |
| T28 | [03-publication-and-recovery.md](03-publication-and-recovery.md) | Типизированный backup/restore, replace-preview и независимая rescue | PLANNED | Not executed |
| T29 | [03-publication-and-recovery.md](03-publication-and-recovery.md) | Legacy staging migration и исполняемые probe drivers | PLANNED | Not executed |
| T30 | [04-interface-and-release.md](04-interface-and-release.md) | API client, ошибки, контекст и тестовый мост | PLANNED | Not executed |
| T31 | [04-interface-and-release.md](04-interface-and-release.md) | Оболочка, роли, навигация, приветствие и уведомления | PLANNED | Not executed |
| T32 | [04-interface-and-release.md](04-interface-and-release.md) | Обзор, список и карточка цели | PLANNED | Not executed |
| T33 | [04-interface-and-release.md](04-interface-and-release.md) | Простой конструктор цели и методики | PLANNED | Not executed |
| T34 | [04-interface-and-release.md](04-interface-and-release.md) | Источники, импорт, исходные и обогащённые строки | PLANNED | Not executed |
| T35 | [04-interface-and-release.md](04-interface-and-release.md) | Работы, риски, зависимости и запросы решений | PLANNED | Not executed |
| T36 | [04-interface-and-release.md](04-interface-and-release.md) | Панель УОР, накопленный пакет и внешний вход Git | PLANNED | Not executed |
| T37 | [04-interface-and-release.md](04-interface-and-release.md) | Конструктор дашбордов, поля и общий поиск | PLANNED | Not executed |
| T38 | [04-interface-and-release.md](04-interface-and-release.md) | Обновление, копия и перенос из интерфейса | PLANNED | Not executed |
| T39 | [04-interface-and-release.md](04-interface-and-release.md) | Переключение рабочего запуска без старого обхода доступа | PLANNED | Not executed |
| T40 | [04-interface-and-release.md](04-interface-and-release.md) | Сквозной локальный browser/runtime прогон | PLANNED | Not executed |
| T41 | [04-interface-and-release.md](04-interface-and-release.md) | Банковская приёмка, перенос и комплект общего выпуска | PLANNED | Not executed |
| T42 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Собственный браузерный профиль и управляемый runtime port | RUNNING | Owner runtime/profile/schema/CAS checked; own v1 command/query bindings pending |
| T43 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Recorder после входа, безопасные действия и приватные снимки | DONE | Commit titled `feat(workbench): record completed browser exports and enrich mapped rows`; real Edge record→auto-END→replay, full712/712/build + review PASS |
| T44 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Версионный scenario draft, параметры и проверка экспорта | RUNNING | Pure download/column/hash preview checked13focused/full712; shared draft/test commands pending |
| T45 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Воспроизведение, повтор после входа и локальное принятие | PLANNED | Not executed |
| T46 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Мастер без JSON — профиль → запись → проверка → пакет | PLANNED | Not executed |
| T47 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Настоящий локальный browser fixture и полный v1 сценарий | PLANNED | Not executed |
| T48 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Проба Сбербраузера, эксплуатационные инструкции и граница готовности | PLANNED | Not executed |

## Bank readiness

| Probe | Status | Real environment evidence |
| --- | --- | --- |
| BP-01 | NOT_READY | Not executed; inputs described in part05 |
| BP-02 | NOT_READY | Not executed; inputs described in part05 |
| BP-03 | NOT_READY | Not executed; inputs described in part05 |
| BP-04 | NOT_READY | Not executed; inputs described in part05 |
| BP-05 | NOT_READY | Not executed; inputs described in part05 |
| BP-06 | NOT_READY | Not executed; inputs described in part05 |

## Run 2026-10-28 — execution setup and T01

- Entry branch `codex/uor-workbench-rebuild`, base `34455dd96a16637d464587759239f0f1bd76bc02`; clean working tree. Origin verified as the requested RM_UOR repository.
- Runtime: Windows x64; default host Node24.22.1 has no npm in PATH. Reused an existing portable, checksum-checked Node22.16.0 distribution under `.runtime/toolchains/node-v22.16.0-win-x64`; npm10.9.2. Python3.8.5 is not the target3.13.5 and is **not used** by this implementation. Git2.33.0.windows.2.
- Commands below prepend that portable directory to PATH and use `npm.cmd` on Windows. Sandbox blocks Node22 parent-directory lstat, so tests/build require the execution host's approved unsandboxed process runner; product code contains no such workaround.
- Ruling: execute in the user's explicitly selected existing branch/checkout; no extra worktree or branch is created. Existing working data is preserved.
- Ruling: use this tracked, tool-independent journal and private `.runtime/validation/workbench` evidence instead of Bash-only skill helpers; the plan's split task files are the briefs. This preserves continuation on machines without those skills.
- Pre-flight shared interfaces checked: T01→T02/T04/T08 primitive names; T02→T03/T05/T07 entity/ref schemas; T03→T07/T09/T12 same-transaction storage; T05→T06/T07 selection/context; T07→T17/T21 immutable basis vs projected freshness; T10/T11→T12/T13 server actor/access; T14/T15/T16→T17 source pipeline; T12/T13→T22–T29 command/jobs; T22→T23–T26 package vs anchor revisions; T28→T38 backup file endpoint; T13/T30→T31–T38 API-only UI; T42–T45→T34/T46–T48 browser/scenario boundary; T47→T39→T40→T41 cutover ordering. No additional conflict beyond rulings already fixed in CONTRACTS.md and spec21 was found. Recheck each task's exact input/output when starting it.
- T00: docs verifier PASS (20 checksums /48 tasks /48 AC +8 OC /8 JSON examples). Full existing-suite baseline and build started; see next entry for final results. No dependency or lockfile changes made.
- T01 RED: `npm.cmd test -- src/domain/workbench/exact-number.test.ts src/domain/workbench/primitives.test.ts src/domain/workbench/time.test.ts` → exit1, all3 modules absent. Evidence `t01-red.log`.
- T01 implementation: exact BigInt fractions, canonical Decimal/wire schemas, UUID generation, stable errors and Moscow date arithmetic. Formatter rejects invalid precision or more than1000 decimal places; this display-only bound never rounds calculations.
- During GREEN tests caught leading-zero integer conversion from fractions and an invalid Zod union call; corrected the causes. Rational schema refinements now return validation failure rather than throwing out of safeParse.
- T01 final same focused command → exit0, 3 files /5 tests. `npm.cmd run build` → exit0 (TypeScript + Vite). Evidence `t01-green.log`, `t01-build.log`. Existing production entry and data are unchanged.
- Next task: T02. Read its brief in `01-core-and-calculation.md`, write `schemas.test.ts`, run RED, implement strict domain schemas and complete synthetic fixtures. Do not switch production entry before T39.

## Run 2026-10-28 — T00 completion and T02

- T01 commit: `92e9f6d`. T02 base: that commit. No dependencies/lockfile/runtime entry changed.
- T00 baseline `npm.cmd test` → exit0, 99 files /475 tests, 390.02s (`t00-baseline-test.log`). Suite discovery preceded creation of T01 tests, so this is the legacy baseline.
- Ruling: the initial baseline build started after the long suite, when T02 files were partially written, and failed on absent in-progress imports. It is **not** a legacy defect. Verified the exact initial commit34455dd using `git archive` into a new ignored `.runtime/validation/workbench/baseline-34455dd` directory, then `npm.cmd --prefix .runtime/validation/workbench/baseline-34455dd run build` → exit0 (`t00-baseline-build-clean.log`). No live data was copied or reset.
- T02 RED `npm.cmd test -- src/domain/workbench/schemas.test.ts` → exit1, schemas/fixture module absent (`t02-red.log`). Additional linked-goal/scope checks first failed as expected (`t02-crossref-red.log`).
- Added all28 Header entity schemas and all required type families, independent publication anchor/private notification schemas, canonical source parsing defaults and complete numeric fixture graph with source↔goal cycle. Schema defaults are applied on parse; fixture graph includes all its declared targets.
- Ruling: ReferenceRequirement gains an optional internal `validateTarget` callback. Consumers of the original two fields remain compatible. This lets the same deferred reference gate reject a numeric assignment with null population, a scope with the wrong directory kind, a mismatched goal/source and a value invalid for its exact custom-field definition. Callbacks are not wire data or persisted payloads.
- T02 GREEN `npm.cmd test -- src/domain/workbench` → exit0, 4 files /10 tests; `npm.cmd run build` → exit0. Evidence `t02-green.log`, `t02-build.log`. No bank integration or UI completion claimed.
- Next exact action: write `src/server/storage/workbench-repository.test.ts` per T03, run `npm.cmd test -- src/server/storage/workbench-repository.test.ts` for RED, then implement separate append-only wb_* tables. Deferred cyclic references, savepoint rollback, closed async leases and anchor metadata/package revision separation are required gates.

## Run 2026-10-28 — T03

- Base `d92911e` (T02); new storage is separate from legacy records and production entry. All fixtures use fresh temporary SQLite databases/artifact folders, never live workspace data.
- RED `npm.cmd test -- src/server/storage/workbench-repository.test.ts` → exit1, repository absent (`t03-red.log`).
- Implemented append-only versions/heads, CAS, deferred cyclic-reference validation, immutable Capture revision1, published-head selection, separate anchor metadata revision, indexed candidates and module SQL/projection ports. Module registrations retain typed schema validation rather than casting through unknown.
- Added rollback tests for thrown writes, dangling refs, projection exceptions, native async functions, Promise/thenable results and writes from a closed async lease; nested SAVEPOINT rollback preserves the outer transaction. Module writes and entity changes share a single stateRevision increment at outer commit.
- Additional RED cases caught the reserved `entity` module namespace and a 2000-scope OR query exceeding SQLite's expression depth1000. Namespace/table checks now reject core/foreign-table writes; scope matching uses bound JSON row-value membership, not a growing OR expression (`t03-sql-red.log`, `t03-population-red.log`).
- Refactor: memoize resolved targets inside one immutable validation phase and reuse each capture once per candidate read. This avoids repeatedly parsing a 2000-row capture for every fact. No cache persists beyond the operation.
- GREEN `npm.cmd test -- src/domain/workbench src/server/storage/workbench-repository.test.ts tests/integration/snapshot-acceptance.test.ts tests/integration/goal-history.test.ts` → exit0, 7 files /29 tests; 2000-member seed/query case853ms in this run, no truncation. `npm.cmd run build` → exit0 (`t03-green.log`, `t03-build.log`). Node22 emits its normal experimental SQLite warning.
- Next exact action: T04 tests in `src/features/evaluation/workbench/{conditions,reducers}.test.ts`; run `npm.cmd test -- src/features/evaluation/workbench/conditions.test.ts src/features/evaluation/workbench/reducers.test.ts` for RED, then implement exact normalization and whitelisted reducers.

## Run 2026-10-28 — T04

- Base `da26adc` (T03); T01–T03 and journal were pushed to the requested GitHub branch. No main merge.
- RED `npm.cmd test -- src/features/evaluation/workbench/conditions.test.ts src/features/evaluation/workbench/reducers.test.ts` → exit1, both modules absent (`t04-red.log`).
- Implemented exact inclusive conditions and all4 versioned normalization formulas with domain/profile checks; no caps for increase, explicit cap>100 for decrease, strict integer zero-counter and binary eq/range. No rounding enters arithmetic or threshold comparison.
- Reducers deduplicate canonical rows, preserve sorted source keys, reject conflicting duplicates/missing components/units and compute ratio of sums. Unknown reducer throws UNSUPPORTED_REDUCER with assignment/method/metric refs; inputs remain unchanged.
- GREEN same focused command → exit0, 2 files /3 tests covering all documented vectors and rejection cases (`t04-green.log`); `npm.cmd run build` → exit0 (`t04-build.log`).
- Next exact action: T05 selection/freshness tests, then `npm.cmd test -- src/features/evaluation/workbench/select-facts.test.ts` RED. Implement explicit time windows, full population checks, applicability, correction provenance and lineage without importing the old selector.

## Run 2026-10-28 — T05

- Base `a9520ab` (T04). RED `npm.cmd test -- src/features/evaluation/workbench/select-facts.test.ts` → exit1, selector absent (`t05-red.log`). Additional provenance RED caught a materialized value masking a missing original cell (`t05-provenance-red.log`).
- Added as-of Moscow cutoff/exact-period selection, explicit full population checks, N/A interval coverage, recursive lineage/cycle diagnostics and deterministic reference sets. Equal semantic repeats share a value while retaining refs; conflicting ties never use ID ordering. Historical reads do not select facts recorded after evaluatedAt.
- Freshness uses sourceUpdatedAt or explicit business-date/period boundary, compared exactly in milliseconds against Decimal hours. Capture, import and correction timestamps never refresh old data. Published corrections retain their original fact refs/freshness and signal subsequent-source discrepancies.
- Ruling: an already aggregated, single observation can be corrected as a scalar. Rewriting multiple ratio/count components from a scalar correction is not defined by the spec; the selector returns `unsupported_correction_reduction` rather than inventing numerator weights or averaging ratios. A future explicit reducer contract can support that case; simple one-row source/sum corrections are implemented now. Original raw/canonical rows are never changed.
- GREEN `npm.cmd test -- src/features/evaluation/workbench/select-facts.test.ts src/features/evaluation/workbench/conditions.test.ts src/features/evaluation/workbench/reducers.test.ts` → exit0, 3 files /9 tests. `npm.cmd run build` → exit0 (`t05-green.log`, `t05-build.log`).
- Next exact action: T06 weighted evaluator tests, then `npm.cmd test -- src/features/evaluation/workbench/evaluate.test.ts` RED. Preserve separate preliminary score, mandatory gate and freshness/confirmation.

## Run 2026-10-28 — T06

- Base `75d413a` (T05). RED `npm.cmd test -- src/features/evaluation/workbench/evaluate.test.ts` → exit1, evaluator absent (`t06-red.log`).
- Added pure weighted evaluator with exact score/preliminary/coverage, independent mandatory gate, N/A reweighting, all-N/A result and zero-applicable-weight block. A missing zero-weight input remains incomplete even when coverage displays100. Stale/unknown freshness preserves the known score and prevents confirmation. No DB, network or system clock is read.
- Unsupported formulas/configurations and broken selection provenance return explicit blocked diagnostics; no silent default threshold or formula. Inputs and raw values remain unchanged.
- GREEN `npm.cmd test -- src/features/evaluation/workbench/evaluate.test.ts src/features/evaluation/evaluate.test.ts src/features/evaluation/measurement.test.ts` → exit0, 3 files /38 tests (`t06-green.log`); `npm.cmd run build` → exit0 (`t06-build.log`).
- Next exact action: T07 `basis.test.ts` and `state-rules.test.ts`, then RED with the repository tests. Add atomic digest lookup/materialization, exact published resolver and ephemeral quality projection before any API/UI wiring.

## Run 2026-10-28 — T07

- Base `144288d` (T06). RED `npm.cmd test -- src/features/evaluation/workbench/basis.test.ts src/features/evaluation/workbench/state-rules.test.ts src/server/storage/workbench-repository.test.ts` → exit1, new modules/lookup absent (`t07-red.log`).
- Added canonical semantic basis digest, atomic basis/result/digest-index insertion, registered storage migration and indexed lookup. Repeated preparation (even by another actor or later clock) returns immutable existing refs without a write; new basis/result attributes the actual supplied server actor.
- Resolver samples Clock once, requires confirmed config anchors and exact method/metric refs, resolves published templates without replacing standalone methods, and validates exact selected lineage links. Unknown merge time does not block confirmed current config. Missing refs never fall back to latest.
- Added manual transition, correction provenance, attestation and snapshot rules. Confirmation requires exact digest/ref and current admissibility; optional evidence/comment rules follow the new spec. Internal validators accept a complete CalculationResult subtype as well as a plain NumericEvaluation while keeping strict wire schemas.
- Clock-only quality projection preserves stored numbers/achievement/refs and updates freshness/confirmation flags. Tests persist a real agreed snapshot, advance the clock, and verify both stored result and agreed JSON remain unchanged. Template/method/link updates retain the earlier basis refs. Manual prepare returns resultRef=null.
- During verification fixed a TypeScript control-flow issue in the throwing mismatch helper; no weakened validation or unknown casts added.
- Final GREEN same RED command → exit0, 3 files /13 tests (`t07-green.log`); an earlier combined T01–T07 run also passed36 tests. `npm.cmd run build` → exit0 (`t07-build.log`).
- Next exact action: T08 Friday projection tests, then `npm.cmd test -- src/features/evaluation/workbench/friday.test.ts` RED. Preserve original dates and produce carried points without measurements or DB writes.

## Run 2026-10-28 — T08

- Base `23ae6b8` (T07). RED `npm.cmd test -- src/features/evaluation/workbench/friday.test.ts` → exit1, projection absent (`t08-red.log`).
- Implemented a pure Moscow-calendar Friday projection: cut off future business dates/captures, preserve source refs/dates and flat equal values, carry a known value with the original date/warning, keep gaps before the first value and retain unknown-time provenance. No Date.now, evaluator, storage write or artificial Capture is involved.
- Ruling: whole periods retain their boundaries and become eligible only when completed. A series mixing known as-of and period meanings is rejected as `INCOMPATIBLE_SERIES_TIME`; no implicit temporal conversion. Unknown-time observations are display fallback when no eligible known-business-time value exists and always carry a warning.
- GREEN same focused command → exit0, 1 file /3 tests (`t08-green.log`); `npm.cmd run build` → exit0 (`t08-build.log`).
- Current checkpoint: T00–T08 implemented/checked; T09 and later remain PLANNED. The new components still run alongside legacy and have not switched production entry or changed live data. Next is T09 indexed historical read model, including >3000-observation retention/pagination and exact agreed-basis reads.

## Run 2026-10-28 — checkpoint review fixes and complete verification

- Review base/head `34455dd..8ee8910`. A fresh read-only reviewer reported3 Important findings and no Critical/Minor findings. Details and boundaries: [CORE_CHECKPOINT_REVIEW.md](CORE_CHECKPOINT_REVIEW.md).
- R1: reproduce a published correction of one derived observation (expected50, received100). Apply the correction at its target logical observation, preserve correction/original lineage refs in the semantic basis, and preserve original freshness. Unsupported multi-aggregate redistribution is explicitly blocked rather than ignored.
- R2: reproduce a result using another metric through lineage (expected blocked, received ready); also reproduce an unrelated leader link used as scope proof. Enforce metric identity in the pure traversal and actual exact published ancestor/descendant directory paths in the server resolver. The pure input's resolution.directoryLinkRefs is server-verified context, not a browser-controlled assertion. A valid product→team path remains supported.
- R3: reproduce a single-quoted SQLite table name bypassing the module namespace and rewriting an immutable goal in a temporary DB. Reject ambiguous single-quoted structural identifiers before string-literal stripping. Regression verifies rejection and the unchanged original goal.
- RED: `npm.cmd test -- src/features/evaluation/workbench/basis.test.ts src/features/evaluation/workbench/evaluate.test.ts` → exit1 (both lineage defects); `npm.cmd test -- src/server/storage/workbench-repository.test.ts src/features/evaluation/workbench/select-facts.test.ts` → exit1 (correction and SQL defects). Evidence `review-lineage-red.log`, `review-correction-sql-red.log`.
- GREEN: repository + selector + resolver/basis + evaluator focused suite → exit0, 4 files /24 tests (`review-fixes-green.log`); additional valid-path test → exit0, 7 basis tests (`review-path-green.log`). The first whole-suite checkpoint run overlapped the new RED regression and failed on that reproduced defect; it is not a legacy baseline failure or completion evidence.
- **Final fresh verification after all runtime fixes:** `npm.cmd test` → exit0, **111 files /518 tests**, 341.92s (`checkpoint-final-test.log`); then `npm.cmd run build` → exit0 (`checkpoint-final-build.log`), Node22.16.0/npm10.9.2. No failures or skipped failures were suppressed. SQLite experimental warnings are from Node22.
- `node docs/superpowers/plans/2026-10-28-uor-workbench/verify-plan.mjs` → exit0, approved checksums and document links intact. `git diff --check` → exit0. Clarified that the documentation verifier does not itself execute product checks. README now links this implementation journal.
- Commit for this fix pass: titled `fix(workbench): close core review findings` (contains this entry and sanitized review report). Eight task implementation commits precede it. No real bank probes, main merge, deployment or production-entry switch performed. Live runtime data and the compat checkout remain untouched.
- **Next task remains T09**, first action: read its brief/index-namespace ruling, write `src/features/history/workbench-history.test.ts`, then run `npm.cmd test -- src/features/history/workbench-history.test.ts` RED. No T09 implementation is partially staged or represented as complete. Source files and all continuation information are committed together; private logs are supplementary, not required to resume.

## Run 2026-10-28 — four-stream time-bounded implementation

- User asked for maximum parallel streams and an attempt to finish in20 minutes. Start04:23:07UTC, target04:43:07UTC. Used all4 slots: history, transport/composition, identity/notifications, and root commands/jobs/integration. Shared checkout; file ownership separated, only root staged/committed. No extra branches/worktrees, main merge or live bank effects.
- T09 `2b3dc5f`: indexed immutable history with transactional projection/backfill, source-version/cursor binding, daily gaps, whole periods, exact agreed basis and optional verified wall-clock publication selection. 3001 observations survive archive/reopen and pagination. RED→GREEN also caught period page size, missing/conflicting predecessor, and a late-captured older-business-date Friday predecessor. Index name `wb_history_snapshot_assignment_time` stays within module namespace. Final history9/9; required storage/basis/legacy regression29/29 before last history-only edge addition. Logs `parallel-t09-*.log`.
- T10 `2a2c033`: strict wire17, process-local cookies/session, exact loopback/origin/CSRF and safe envelopes/errors. Peer review reproduced provider-error text leakage; only explicit safe errors can expose text/details. POST requires configured Origin. Domain error codes map to stable HTTP status without exposing arbitrary Error messages. T10+T13 combined12 tests GREEN, `parallel-t13-green.log`.
- T11 `874b600`: server hostname normalization, globally unambiguous private registry, own installation+both-repository-bound offline projection and fresh external gates. Curator/chief ordinary capabilities equal; no Bitbucket identity binding. Cache rejects links and uses actual user-only Windows DACL. Explicit revocation invalidates grant; transient outage allows only own previously verified drafts. 24 tests GREEN. Real registry adapter remains not_ready until BP02.
- T12 core `11f381d`: durable typed command intent/receipts, same-ID replay/conflict, atomic local effect+receipt, durable job event/checkpoint history, per-resource bounded queue, owner-only job access, late-cancel guard, fresh gates at actual execution/retry, native-auth waiting_user preserved, and idle drain. RED→GREEN fixed queued jobs stuck forever, retry bypassing queue, input ZodError500 instead of422, and auth waiting overwritten as failure. Tests retain61+ jobs and350 checkpoints without lifetime caps.8 tests GREEN, `parallel-t12-auth-green.log`.
- **T12 remaining gate / ruling:** unknown queued work is conservatively interrupted after restart; automatic reconstruction/scheduling of explicitly eligible local commands is not implemented. This is safer than pretending queued work will resume. Complete that behavior and fault-injection coverage before calling T12 DONE; external writes still require owning reconciliation.
- T13 implementation `1f8c4a0`: static validated module graph/owners/schema registry, query registry, isolated Fastify application and real empty/scope-split fixtures. No success stubs for unavailable future features. Actual source hook spy proves reads do not capture; personal tool owner and backup declaration tested. Default navigation collision and provider-safe error mapping were peer-reviewed and fixed.5 T13 tests GREEN. T13 completion remains gated by T12's remaining recovery behavior.
- T19 foundation `6810b40`: Moscow working calendar/reminder calculations, private durable notifications/read/subscriptions, current-event dedup, missed-day catchup, cancellable polling/backoff and receipt-wrapped own commands.14 tests GREEN. Still missing T17 reminders.draft.save, T18 real cause provider, application lifecycle wiring and T21 list pagination. Convenience read is latest200; persisted event/read/subscription history is unbounded. No fictitious provider or DraftService registered.
- Integration: all new modules jointly **110 tests /22 files GREEN** (`parallel-combined-focused.log`); **npm run build exit0** (`parallel-final-build.log`). Fixed parallel test-import/narrowing/parameter-shadow type errors; source contents normalized to LF only, no runtime change from normalization.
- Whole-suite verification is recorded in the following final entry when complete. Product entry remains legacy until T39; source/PR/UI/T42+ browser automation are still planned. No BP was marked passed from synthetic fixtures.

## Final verification of the parallel pass — 2026-10-28

- `npm.cmd test` → **exit0, 121 files /585 tests**, 359.40s (`.runtime/validation/workbench/parallel-full-test.log`). This is the complete existing+new suite after runtime code freeze, not merely the focused tests.
- `npm.cmd run build` → **exit0**, TypeScript+Vite (`parallel-final-build.log`), Node22.16.0/npm10.9.2. Targeted combined suite110/110 also passed. No lockfile/dependency changes.
- `git diff --check` → exit0 after LF normalization; approved-doc verifier PASS. Six implementation commits `2b3dc5f..6810b40` plus this journal commit. All source changes are committed; private test logs are supplementary and not required by the next agent.
- The user20-minute target did not make all remaining tasks complete. Actual completed additions are T09–T11; checked implementations/foundations for T12/T13/T19 retain the explicit gaps above. T14–T18/T20+ and bank probes remain unimplemented/unverified. Continue from T12's local queued recovery completion gate, then finish T13 gate and T14. No production-entry switch, real bank session or main merge is claimed.

## Run 2026-10-28 — T12 recovery completion and T13 startup integration

- Continued from `4a6415b` in a fresh isolated clone of the requested branch. The supplied chat summary was older than the tracked journal; completed T09–T11 were not repeated. No old workspace or live runtime data was copied, reset or reinstalled.
- Runtime: official Node22.16.0/npm10.9.2 archive downloaded into the ignored `.runtime/toolchains`, checked against Node's SHA256 manifest. `npm ci --no-audit --no-fund` installed the existing lockfile unchanged. Git commits use per-command Codex author identity because this new clone has no configured author; global Git settings are unchanged.
- T12 `1775ad3`: original and current descriptors must explicitly opt into asynchronous local queued recovery. Persisted effect/policy, command/job IDs and resource key survive restart. Recovery is scoped to the trusted installation before any lifecycle write; another installation's jobs/receipts remain unchanged and recoverable by that owner. Current hostname/profile/access/capability are reconstructed at the actual bounded queue slot. Legacy, external/shared, running/retry-wait, checkpointed and irreversible work is not blindly replayed.
- Local durable receipts reconcile pending jobs without another effect or false failure after response loss. Interruption, receipt reconciliation and requeue decisions share one synchronous transaction before scheduling, so another crash during recovery rolls back cleanly. Added a checkpoint(job_id) covering index without trimming retained history.
- T13: after module registration and isolated Fastify readiness, startup invokes `recoverPending(installationId, resolver)`. The real temp SQLite restart test polls the original job over HTTP, replays its command once, verifies current server actor, and proves foreign job state plus HTTP ownership isolation. Legacy production startup remains unchanged.
- RED evidence: missing recovery and async post-commit false failure; a second startup crash left a job interrupted; independent review reproduced foreign lifecycle mutation and a repeated unindexed checkpoint scan. Each fix has an observed RED→GREEN regression. Final focused command across command-registry/jobs/application/recovery-application: exit0, 4 files/23 tests. Independent scoped review: both findings addressed, no new blocking issue; documentation signature nit corrected.
- Initial whole-suite sandbox attempt was stopped after Windows denied temporary Git config writes/atomic renames. Approved-process run then reported 594 passed/4 failed: existing path tests compared the inherited 8.3 TEMP alias `ALEKSA~1` to canonical `Aleksandr`, breaking Vite/bootstrap/update fixtures. Set TEMP/TMP **for the test process only** to `fs.realpathSync.native(os.tmpdir())`; all four affected files/11 tests then passed without product/test changes.
- **Final fresh full verification:** canonical TEMP/TMP, approved process, Node22.16.0/npm10.9.2: `npm.cmd test -- --fileParallelism --maxWorkers=4` → **exit0, 122 files/598 tests, 95.70s** (`t12-t13-full-test-canonical.log`). `npm.cmd run build` → **exit0**, TypeScript+Vite (`t12-t13-final-build.log`). SQLite experimental/upstream Rollup warnings remain unchanged. No failures were hidden or assertions weakened.
- Private RED/GREEN/review logs are under `.runtime/validation/workbench/continuation`; tracked code, tests and this journal are sufficient to resume. Approved-document verifier and `git diff --check` passed. No bank probe, external provider write, main merge, deployment or production-entry switch is claimed.
- Next: T14 private uploads/source pipeline. Read its exact task/specs. Internal context/profile binding must come from trusted published inventory and saved allowed context, not a fabricated first assignment/date. T19 remains a foundation, not DONE.

## Run entry template

```text
Task:
Started at (UTC):
Branch / commit:
Runtime Node / npm / Python-if-used / OS / Git:
Dirty files at entry:
Current step:
Changed files:
Command -> exit code -> evidence file:
AC / OC checks:
Commit:
Open failure / missing input:
Preserved data / recovery state:
Next exact action / command:
```

Do not insert secrets, bank files or full terminal/auth/browser transcripts here. Private evidence stays in .runtime; commit only sanitized result summaries.

## T14 checkpoint and user priority change — 2026-10-28

Implemented private purpose/owner-bound streamed uploads and immutable raw → normalize → enrich → capture/facts/history with an atomic local receipt. Added pinned @fastify/multipart9.4.0 and its additive dependencies without upgrading existing packages. No production startup/cutover or real bank data was changed. Source inventory, saved context and adapters are explicit injected ports, not production demo defaults.

Independent file/source reviews each found two important defects; all four were reproduced, corrected and scoped re-reviewed PASS. The passive-XLSX gate now uses bounded linear structure scanning before decoded namespace/coordinate validation. Current-source fallback now exposes durable latest partial-attempt diagnostics beside retained successful data, and an invalid local pointer no longer suppresses valid verified Git data. See CONTRACTS for the required future T17/T21 consumer gate.

Final target-runtime checks: source17/17, files/upload23/23, combined affected API/command/jobs/source/files8files69/69 PASS; build PASS (`t14-checkpoint-build.log`). A broad exploratory run passed126files641tests but included one newly written T42 RED runtime fixture while that task was in progress; it is not reported as a clean full suite. Full integration will run after the browser/parser slices freeze. Private logs/reports remain under .runtime/validation/workbench/continuation; no source files, browser profiles or private test artifacts are committed.

User explicitly reordered remaining work to OKO recording/replay/download first and enrichment next. All filters/actions are learned from interaction; recording must end automatically after a completed nonempty download. T42 and the T15 pure parser dependency are underway; general import apply, publication, dashboards and remaining platform work are deferred. No exact corporate URL was found in the old baseline public connector configuration/runbook search; the recorded start URL remains configurable, so this does not block implementation.

### OKO prerequisite: T15 pure parser checkpoint

Added parseWorkbenchTable({bytes,name,parsingProfile}) with raw cells/physical coordinates and workbook date-system metadata. UTF8/Windows1251, CSV delimiter, worksheet, decimal/group separators and date format are explicit saved settings. XLSX numbers are read from OOXML lexical values before any floating conversion. Formula/macro/external-link/archive/resource checks reuse the passive file gate. No business row keys, source dates, directory IDs, units or population completeness are inferred.

Focused parser17/17 PASS on Node22.16/npm10.9.2. Independent review found incorrect conventional-path shared strings; the fix follows the unique workbook relationship and ignores unreferenced decoys. Three regression failures reproduced the defect, then17/17 GREEN; independent scoped re-review PASS. Initial parser typecheck passed; later combined checks temporarily included unfinished browser recorder tests, so final whole-branch build/suite remains pending. Generic import preview/apply and file-fact correction workflow are deliberately not implemented or claimed complete.

## OKO recording/download and enrichment-core checkpoint — 2026-10-28

Implemented the strict declarative browser-scenario schema, own managed persistent profile/runtime, exact role/label/CSS and same-origin frame locators, authenticated recorder, private masked screenshots and explicit owner cancellation. Fill/select records parameter names, never their values. Recording ends automatically after download.failure confirms completion and a bounded nonempty CSV/XLSX file is read/validated; a click/event alone is not success. Automatic close retains an own idempotent review result. Manual login installs no recorder. Legacy connector signatures remain compatible.

The pure downstream path now validates expected format/columns and original-byte hash, maps rows using the saved column/profile/row-key definition, and enriches through exact source external keys and versioned directory refs. Source raw decimal/date values are retained. Missing/ambiguous products remain diagnostic, optional teams are not required, and many-to-many team links never multiply rows. Current confirmed-main directory reads permit unknown publication time; historical time reads retain the anchor guard, saved refs/bases remain unchanged.

Independent review corrections: T42 binding-only CAS now changes revision; closeOwned cancels queued opens. T43 service projects VersionRef→EntityRef before the real repository lookup and checks the revision separately; owner shutdown explicitly cancels unresolved downloads before draining finish. Each defect was reproduced RED and corrected GREEN, then scoped independent re-review PASS. T16 core, pure export preview and mapper independent scoped review PASS. See CONTRACTS for the explicit dependency/interface rulings.

Final evidence on frozen code: `npm test -- --fileParallelism --maxWorkers=4` exit0, **134files/712tests PASS**, started10:03:30UTC, duration114.63s (`oko-final-full-test.log`). `npm run build` exit0, Vite built7.09s (`oko-final-build.log`). Node22.16.0/npm10.9.2 and native canonical TEMP/TMP; approved native runner required for actual browser/temporary SQLite/Git fixtures. Plan verification PASS20checksums/48tasks/48AC+8OC/8JSON+links. Worker approval-service timeout/disconnects were resolved by the controller's approved runner; no remaining approval block or bypass.

Native Edge on localhost proves manual SPA login is excluded, exact label/role and same-origin report iframe actions record, actual CSV completion closes recording automatically, owner-only PNG review works and the same managed profile replays a real download. A separate integration regression covers browser replay port→CSV parse→exact mapping→directory enrichment with12345678901234567890.001, literal business date and raw spelling preserved. This is synthetic verification, not a corporate OKO/SberBrowser/SSO/proxy/certificate or export-population probe.

Remaining work is explicit: wire own v1 profile/record/test commands/queries and a narrow no-code OKO interface; add the actual production SourceAdapter/closure and verified coverage evidence, published-scenario resolution and necessary draft acceptance. Generic import/apply, team proposals, publication/cutover and other general screens remain deferred. No real bank Capture/facts, production startup switch or reader publication bypass was introduced. The recording sample download is discarded privately after validation; downstream test/replay obtains the real file again. Corporate start URL was not found in searched old public baseline/config/runbook and remains configurable.

## Complete personal OKO UI workflow — 2026-10-28

- User priority: finish download and enrichment through a usable interface now; defer other screens. Later explicit ruling replaces the registry requirement for this isolated entry with a visible temporary **Читатель / Редактор** switch. Default local editor is labelled `local_preview`, never verified registry. Same local identity survives the switch; publication/chief remain unavailable. Optional accepted-Git registry mode is retained for later configuration.
- Added `oko.html`, dedicated React wizard/provider/client, `dev:oko` / `start:oko`, and real isolated v1/SQLite/session/job/profile/browser composition. Legacy production entry/App/context remain unchanged. Launch and user steps: [OKO_WORKFLOW](../../../OKO_WORKFLOW.md). Built UI runs at `http://127.0.0.1:4176/oko.html`; development UI at port5175.
- Complete path: own report/profile → manual login → marker selection by click → recorder auto-completes on a real completed CSV/XLSX download → sample parse/column mapping and explicit replay parameters → personal dictionary upload/column mapping → replay/normalization/enrichment → preview plus verified original/enriched attachments. No user CSS/JSON. Reload retains own job/login IDs; explicit own browser-close recovery releases a lost window. Failed replay retains prior successful output.
- Mapping/enrichment reuse the validated pure cores and directory graph checks. Exact decimals, literal dates, explicit directory UUIDs and original bytes are preserved; ambiguous/missing links remain diagnostics, team relations do not multiply rows. Derived CSV neutralizes formulas. No shared source, published directory, accepted Capture/facts or goal confirmation is fabricated by this file workflow.
- Platform changes: explicit null-context own query variant leaves business queries strict; person-bound command intents/receipts/jobs and uploads enforce ownership before cache reads/retries/downloads. Result route checks session/exact origin/owner/size/hash/safe attachment name. Runtime marker/replay share locator validation; passwordless SSO controls are excluded; abort closes a stuck navigation.
- Independent reviews reproduced and closed profile-write/CAS races, stale role/person saves, cross-person staged-file reads, marker/auth-selector mismatch and unbound native fetch. Each runtime defect has an observed RED→GREEN regression. Narrow service re-review found no remaining P1/P2 in its three requested paths; independent launch/local-role/attachment integration review also passed. Runtime/frontend reviews and final actual UI exercise passed. Browser URL validation messages and completed-recording status text were corrected after visible checks.
- **Fresh combined verification:** Node22.16.0/npm10.9.2, canonical native TEMP/TMP, approved native process: `npm test -- --fileParallelism --maxWorkers=4` → **exit0, 149files/767tests PASS**, started11:44:23MSK,96.54s (`oko-ui-full-test.log`). `npm run build` → **exit0**, TypeScript+Vite (`oko-ui-final-build.log`). Plan verifier PASS20approved checksums/48tasks/48AC+8OC/8JSON+links; `git diff --check` clean.
- Actual compiled UI E2E builds into its own temporary dist, then drives real Edge and managed persistent contexts through the entire path via UI/HTTP, including temporary roles and real multipart/binary downloads. Exact123456789012345.67, product/cluster UUIDs/names,1row/0unresolved and no browser JS errors verified. Full-suite run includes this test. Visual result reviewed; normal empty live launcher started and UI shown in browser. Private runtime/test profiles/reports remain outside Git.
- This completes the requested personal file workflow, not all T42–T48 or bank acceptance. Real OKO address, SberBrowser/SSO/proxy/certificates and report population require the actual bank environment. Production SourceAdapter/closure, shared scenario publication, directory proposals/acceptance, general screens and T39 cutover remain deferred. Next user step: run the launcher, enter the actual report URL/browser executable and record the report path; roles need no registry setup for this temporary mode.
