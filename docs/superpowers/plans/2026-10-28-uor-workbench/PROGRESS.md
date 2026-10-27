# Progress / журнал исполнения

Implementation started on 2026-10-28. See run entries below; task statuses are evidence-based.
Branch: `codex/uor-workbench-rebuild`. Source code baseline: `3d8704e4a6ff2195af4f2c0602ed11bff5d38f4b`.

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
| T09 | [01-core-and-calculation.md](01-core-and-calculation.md) | Indexed history queries and immutable agreed retention | PLANNED | Not executed |
| T10 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Строгий wire, локальная сессия и CSRF | PLANNED | Not executed |
| T11 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Политика hostname и непереносимый собственный cache | PLANNED | Not executed |
| T12 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Durable command registry, задания и идемпотентность | PLANNED | Not executed |
| T13 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Статические модули, запросы и изолированная сборка v1 | PLANNED | Not executed |
| T14 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Приватные uploads и источник → raw → normalize → capture | PLANNED | Not executed |
| T15 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | CSV/XLSX mapping, partial import и редакции исходных фактов | PLANNED | Not executed |
| T16 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Версионное обогащение и назначения новой команды | PLANNED | Not executed |
| T17 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Незавершённые черновики, evidence и точное подтверждение/срез | PLANNED | Not executed |
| T18 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Работы, решения и ацикличные зависимости | PLANNED | Not executed |
| T19 | [02-platform-data-and-api.md](02-platform-data-and-api.md) | Московский календарь, адресные уведомления и личные подписки | PLANNED | Not executed |
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
| T42 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Собственный браузерный профиль и управляемый runtime port | PLANNED | Not executed |
| T43 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Recorder после входа, безопасные действия и приватные снимки | PLANNED | Not executed |
| T44 | [06-oko-browser-scenarios.md](06-oko-browser-scenarios.md) | Версионный scenario draft, параметры и проверка экспорта | PLANNED | Not executed |
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
