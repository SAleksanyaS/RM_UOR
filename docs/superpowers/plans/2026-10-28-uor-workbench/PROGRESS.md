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
| T04 | [01-core-and-calculation.md](01-core-and-calculation.md) | Exact conditions, normalization contracts and whitelist reducers | PLANNED | Not executed |
| T05 | [01-core-and-calculation.md](01-core-and-calculation.md) | Fact selection, explicit time, freshness and expected population | PLANNED | Not executed |
| T06 | [01-core-and-calculation.md](01-core-and-calculation.md) | Numeric evaluator: weighted N/A, preliminary score and independent mandatory gate | PLANNED | Not executed |
| T07 | [01-core-and-calculation.md](01-core-and-calculation.md) | Basis materialization, exact method resolution, manual/correction/attestation/snapshot rules | PLANNED | Not executed |
| T08 | [01-core-and-calculation.md](01-core-and-calculation.md) | Friday projection with original provenance and no invented measurement | PLANNED | Not executed |
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
