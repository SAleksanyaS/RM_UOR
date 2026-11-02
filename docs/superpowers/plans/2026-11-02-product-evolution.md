# RM_UOR Product Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the approved local product: durable raw acquisition, coherent UI, real knowledge/maturity, builders, weekly browser AI, colleague setup and safe Git updates.

**Architecture:** Extend the current local modular monolith through typed feature services, modern command/query registries and explicit archive owners. Accepted shared Git definitions/data stay separate from owned local profiles, operations and drafts. No legacy runtime or new central backend.

**Tech Stack:** TypeScript/React/Fastify, SQLite, pinned Playwright, existing ExcelJS/PptxGenJS/JSZip.

**Spec:** docs/superpowers/specs/2026-11-02-product-evolution.txt. The user attached this specification and explicitly ordered full execution and final main publication.

## Global Constraints

- Node.js 22.16.0, npm 10.9.2; preserve locked dependency versions.
- Target: SberBrowser 152.0.7977.120. Synthetic Chromium tests do not prove bank/SSO acceptance. Preserve TLS and sandbox.
- Modern Workbench runtime only; no legacy HTTP/context shortcut or own central server.
- New persistence receives schema, owner/capability, CAS/idempotency, migration, archive inventory and recovery together with its UI.
- Missing, exception and no-event remain distinct. Source claims and unverified history never become accepted facts or UOR confirmations automatically.
- User authorizes the selected XLSX/PPTX originals and derived business records in main. Credentials, profiles, personal config/runtime and diagnostics remain private.
- Main publication is authorized after checks. Never force-push, erase others, bypass protection or invent target acceptance.
- Focused tests during work; one stabilized full suite/build, then affected reruns. Bound test workers to two.
- Parallel implementations have disjoint files. Controller serializes staging/commits and owns server bootstrap/routes until explicit handoff. Implementers do not spawn agents.
- User delegates normal choices; no additional plan/colour approval loop. Record substantial rulings and continue.

## Review Focus

1. Crash after bytes arrive but before finish: Task1 persists exactly one owned receipt; Task4 restores it.
2. Later import omits a team/metric: Task3 retains expected58×5, missing state and old snapshot.
3. Identity changes during async requests: Task2 clears old metadata; Tasks4/6/7 enforce ownership.
4. AI reply lost or Git head moved: Tasks6/7 reconcile intent/candidate, without duplicate send or overwrite.
5. Shared setup applied to nonempty colleague installation: Task7 preserves identity/private work and validates closure/conflicts/rescue.

## Execution and ownership

Fresh input main: 50678454ff1685bec951718f1fe919d94c8ef52e. Branch: codex/product-20261102. Isolated sibling worktree preserves the audited checkout. Task0 imports54 nonprivate snapshots exactly, retains private config locally and records55 dispositions. The approved specification contains all T01–T12 and AC01–AC25 details.

Tasks1/2/3 start on disjoint files after Task0. Task4 consumes the capture codec and provides raw/HTTP/archive integration. Tasks5–8 follow dependency handoffs, with independent work parallelized. Task9 gates the complete release. Each task has a fresh scoped spec+quality review; all requested scope remains required.

### Task 1: Durable acquisition and browser correctness

**Files:** src/features/connectors/browser.ts, transport.ts, contracts.ts, private-profile-schema.ts; workbench-browser-{recorder,runtime,source,scenarios,profile-locks,diagnostics,commands}.ts; workbench-workflow-{service,store,contracts,module}.ts; their owning tests and focused capture/artifact-policy helpers. No server/** or frontend TSX edits.

**Interfaces:** Preserve Downloaded and BrowserWorkflowRuntimePort through additive optional fields/ports. Introduce owned CaptureIntent/CaptureReceipt and awaitable CaptureSink. Export strict persisted export/receipt codecs and exact table/file inventory to Task4. Keep source.browser.* and oko.workflow.* namespaces separate.

**Implementation decisions:** T01,T03–T10. Persist intent before launch and bytes/receipt before success or cleanup, with restart reconciliation. Same identity/same content returns same receipt; conflicting content rejects; new deliberate attempt receives new identity. Raw, transport, format, processing and replayability are distinct. Add exact optional loginAllowedOrigins defaulting to[] and explicit login/report phases. No suffix trust, arbitrary recovery GET, unsupported process kill or readiness marker pretending to be an export action. Shared broker owns staging until committed. Bounded resource/wait/cancel policy preserves slow progressing transfers. Real ZIP/XLSX/OLE verification includes fake EOCD, CRC, truncated directory/chain and paused/rewritten downloads.

- [x] Write failing workbench-capture-durability.test.ts cases: restart before finish; same-command receipt; changed bytes; foreign owner; parser failure; cancel after raw commit.
- [x] Run those and existing recorder/profile/workflow tests, record RED evidence.
- [x] Implement sink, durable store/journal, verifier, phase policy and lifecycle repairs; publish final additive DTO before UI consumes it.
- [x] Run focused recorder/workflow/store/profile/security tests with npm test -- <files> --maxWorkers=2. Verify real child-process restart where crash durability is claimed; record GREEN.
- [x] Self-review; report owned files, codecs and checks. Controller commits and requests independent browser/security review.

### Task 2: Product shell, appearance and Data experience

**Files:** app/workbench WorkbenchApp/Shell/Navigation/AppearancePanel, route-state, context, workbench.css, production-ui.css and narrow ui/ primitives; sources/workbench DataWorkspace/RawFilesPage; connectors/workbench frontend including provider/exports/wizard/personal workspace; DashboardView appearance extraction; system/workbench-preferences and compatible codecs/tests.

**Interfaces:** Own WorkbenchApp/shared CSS exclusively. Other tasks export KnowledgeWorkspace, MaturityWorkspace, WorkbenchReportsPage, WorkbenchWeeklyPage and WorkbenchUpdatesPage. Extend current preferences with defaulted visual.sidebar expanded/compact; personal favorites/start/recent remain owner-bound. Task1 gives workflow DTO; Task4 gives raw.files list/detail/rows and capture import/manual.

**Implementation decisions:** Capture original-main visual baseline before redesign. Calm analytic direction, local Cyrillic/system fonts, neutral surfaces/teal accent, clear typography/tables, semantic light/dark/system/density. Six main routes and service entries; capability-aware publishing. Data/Knowledge/Reports/Settings must work without goal context. Preserve URL/back/deep links/unsaved guards. Appearance visible everywhere, persisted sidebar and merged preference updates; unknown save reconciles existing operation. Clear prior-owner state and late replies. Data defaults to real raw inventory, acquisition without mapping, then explicit processing; no placeholder route counts as complete. T12 included.

- [x] Extend owning shell/provider/preferences tests for empty context, old deep links, identity change, failed/lost save, persisted theme/sidebar and keyboard focus.
- [x] Record failing behavior, then implement shell/components/routes and real Data integration.
- [x] Verify selected UI tests, CAS preferences and no leaked previous-owner export list; preserve existing pending-operation recovery.
- [x] Capture and inspect real production UI at1440/1366/1024 and360/320, both themes, keyboard and zoom; record baseline/after metadata.
- [x] Self-review; report exact exported components and evidence; controller commits and obtains UX/accessibility review.

### Task 3: Real knowledge, maturity and template

**Files:** materials/maturity/2026-10-30 originals/manifest, data/reference/maturity-2026-10-30.json, reproducible extraction script; features/knowledge/workbench-{contracts,service,commands,query} and KnowledgeWorkspace; features/maturity workbench contracts/materials/evaluate/query/MaturityWorkspace; report-templates/maturity-2026-profile/render. Own additive directory/domain/core schema, catalog validation and explicit team-code enrichment changes and related graph tests. No shell/bootstrap/archive composition edits.

**Interfaces:** registerKnowledgeQueries(registry,{repository,drafts,materials}); registerKnowledgeCommands(registry,{drafts,service}); registerMaturityQueries(registry,{repository,materials}); knowledge.list/detail/quality/importPreview, knowledge.import.apply/materials.prepare, maturity.overview. evaluateMaturity({definition,observations,reportedClaims}) pure. renderMaturity2026Template(bytes,profile,snapshot):Promise<Buffer>. Notify controller of exact final dependency types.

**Implementation decisions:** Honest block/tribe hierarchy, no fabricated DIT or cluster leaders. Reuse modern draft/package/CAS/publication and registered entity ownership. Source counts58teams,5metrics,8displaypeople/58memberships,1block/3tribes/24clusters,290leafslots/434rollups. Numeric273/pass271,15exception,1no-event,1missing. Stable expected58×5 despite omitted imports. Historic25Oct reported aggregates only; no account/role/applicability/UOR invention. Team-level assignments may feed existing evaluator; a dedicated fixed matrix supplies honest aggregate. Keep legacy template; new dit-maturity-2026-10-v1 covers the actual editable10slides.

- [x] Write material/evaluation/profile tests for exact hashes/counts/cells, missing row/team/metric, frozen basis, no fabricated authorization/history, idempotent import and CAS/reader rejection.
- [x] Implement normalized bundle, registered source-backed knowledge, query/commands/UI and pure evaluator/profile/renderer.
- [x] Verify measured counts, exact8/58mapping, N311, old snapshot name stability and dynamic10slide output on changed period/name.
- [x] Report archive/publication dependencies to Tasks4/5/7; visual export verification follows actual files.
- [x] Self-review; controller commits and requests independent data/method review.

### Task 4: Generic raw acquisition, archive and diagnostics

**Files:** new connectors/workbench-raw-acquisition module; server/workbench files/routes/application/bootstrap composition; workspace-maintenance/workbench/source-archive-owners and tests; scripts/log-capture.mjs/logs.mjs and focused checks.

**Interfaces:** Consume Task1 codec/store. Produce raw.files.list/detail/rows queries without GlobalContext and raw.capture.import/manual commands. A narrow module registration supplies schemas/capabilities; route byte reader preserves owner/hash/MIME. Archive export/stage/restore/re-export consumes the same strict capture codec.

**Implementation decisions:** Local file/manual table and Confluence attachment acquisition all retain raw before parsing. Selected Confluence browser recipe/origin/version metadata; no guessed API contour. Stable attempt ID, bounded upload, honest unsupported/corrupt/HTML status and server-paged actual rows. Reader owns personal input; common acceptance remains separate. T02/T05/T11: include visible/hidden/raw-only exports/receipts and files in typed archive/code-update rescue; reject unknown/foreign/corrupt inventories atomically. Preserve XLS/XLSX/CSV/TSV/octet-stream and safe Content-Disposition/nosniff. Redact default logs/diagnostics, working20MB/20file rotation/follow/signals.

- [x] Add failing HTTP/SQLite tests for own-reader raw acquisition with no goal, same-command retry, new attempt, invalid type and foreign denial.
- [x] Implement generic acquisition/read/parse-preview and wire Task2 exact DTO.
- [x] Backup raw-only/hidden exports, restore same owner on second clean installation, restart/re-export and compare bytes/hashes; foreign owner/corruption fail without changes.
- [x] Verify real log filenames/rotation/follow and child termination; no sensitive canary in output.
- [x] Controller commits; obtain archive/HTTP/diagnostics review.

### Task 5: Goal, dashboard and report builders

**Files:** goal-setup/workbench and dashboards/workbench constructor improvements; new reporting/workbench contracts/service/store/commands/queries/exports/WorkbenchReportsPage and archive codec.

**Interfaces:** Consume existing draft/method/block contracts and Task3 MaturitySnapshot/profile; produce modern report snapshot prepare/save/detail/export functions and byte reader. Shell owner mounts page; controller registers commands and archive owner.

**Implementation decisions:** Template-first progressive setup, explicit participants and missing semantics. Status rules reuse goal methodology, separate quality/UOR. KPI/table/trend/comparison/matrix/work/quality blocks; preview/layout/filters/keyboard reorder/save/reopen with personal/shared separation. Report builder selects scope/period/sections/order/title/comment. One immutable snapshot freezes values/rules/names/template for UI/XLSX/PPTX/PDF. No legacy app API.

- [x] Write failing create/edit/reopen tests including one threshold and report section change, two-window CAS and reader denial.
- [x] Implement bounded builders, snapshot persistence/codecs and pure export adapters.
- [x] Check same numbers/units/lineage across actual exports and historical name immutability; render actual PPTX/PDF and inspect.
- [x] Run focused owning tests; report and independently review builder/report contracts.

### Task 6: Weekly loop and GigaChat in SberBrowser

**Files:** weekly-report/workbench contracts/store/service/commands/queries/page/archive; connectors/gigachat-browser-* narrow provider; versioned prompt templates.

**Interfaces:** WorkbenchWeeklyPage in reports; weekly.* commands/queries; injectable GigaChatBrowserPort using canonical broker. Persist send states prepared/sending/unknown/received/reviewed, intent/evidence hash/prompt/response/edits. Private configuration stays private.

**Implementation decisions:** Explicit Europe/Moscow week; deterministic facts/changes/quality/work/comments evidence. Four blocks: up to3insights, achievements, attention/decisions, nextweek plan. Exact configured corporate URL/profile/UI binding. Show selected outgoing context, persist intent before send and reconcile same conversation after lost response. No blind retry or fake system API role. Model text cannot create fact/confirmation/publication. Explicit linked-action creation and nextweek completion/carry-forward without duplicates. UI/MFA/close/partial-generation recovery; manual fallback is not automation acceptance.

- [x] Add real store/command tests for frozen evidence, fewer-than3insights, unsupported numeric claims, owner/CAS and unknown-send reconciliation.
- [x] Implement versioned analyst/critic/editor prompts and browser provider, status/recovery UI and linked weekly actions.
- [x] Verify configured synthetic chat DOM, no duplicate external sends, auth expiry/close and nextweek action persistence. Separately record real bank acceptance unavailable when it is unavailable.
- [x] Independent weekly/browser review after focused tests and commit.

### Task 7: Shared setup, updates and notifications

**Files:** workspace-maintenance/workbench setup-package-* and SetupPackagePanel; system/workbench update-channel/provider/WorkbenchUpdatesPage; execution notification source integration; native Git provider where current default unavailable.

**Interfaces:** setup.* commands/queries, versioned manifest schema/minAppVersion/dependency closure/hashes/provenance/inventory. Update source plugs into existing durable notification provider; CodeUpdateService remains sole activation owner. Controller registers features/archive codecs.

**Implementation decisions:** Personal same-owner backup, colleague common setup and code update separate. Public package contains selected common definitions/data/templates/recipes/prompts/materials; no credentials/profiles/roles/jobs/foreign drafts/absolute paths. Preview/idempotent apply with new local identity and rescue/conflict handling on nonempty install. Check exact trusted Git candidate at startup/resume/online/periodic jitter-backoff. One notification per channel/release/owner, durable read/snooze/applied/error. Preserve staging/quiesce/backup/health/IPC commitpoint and no rollback after accepted new data. Dirty/active/moved-main/schema/disk/crash safe recovery. Preserve local-preview external publication restrictions.

- [x] Test actual two clean databases with twopeople and same common setup; repeat/update no duplicate or lost local work; foreign personal backup rejected.
- [x] Implement versioned package closure/import/updates and notification integration.
- [x] Test local bare Git newcommit→poll→one notification→apply; offline/restart/two windows/identity change and existing activation crash gates.
- [x] Independent architecture/distribution/update review after focused evidence.

### Task 8: Launcher, simple onboarding and delivery guide

**Files:** launch/install/setup scripts; modern onboarding/environment page; README_RU_LOCAL_START, README and guides. Final PDF/screenshots/distributions generated outside code worktree until packaged.

**Interfaces:** Consume canonical site/runtime schema and Task7 setup package; shell owner mounts onboarding. One daily launcher invokes current main runtime, no second database/composition.

**Implementation decisions:** Target actual supported Linux corporate environment; truthful Windows support separately. Ordinary user starts without terminal/JSON/choosing Node; IT provisioning explicitly separate. Pinned versions/browser detect/validated path/roots/ports; Git/AI details only when selected. Actual installer/launcher artifact, clean source archive, selected materials/shared setup and PDF full function/setup/recovery guide. Exclude private state/secrets; version/hash/dependency/license inventory. Current guides distinguish implemented/local-tested/target-unverified.

- [x] Test clean prepared directory launch/status/stop/relaunch with pinned Node; no existing runtime overwritten.
- [x] Implement diagnostics and launcher/onboarding, preserve safe defaults and explain path/port/browser failures.
- [x] Unpack the actual tested distribution and verify inventory/start/raw/restart; final published source/archive identity is bound in the delivered release manifest.
- [x] Generate the complete guide after stable UI and inspect text/rendered pages. Final published SHA, PDF identity and artifact limitations are bound during delivery.

### Task 9: Integrated acceptance, independent review and main publication

**Files:** validation evidence, current MASTER_SPEC/module-map/remaining-work, release/PROGRESS records; final code tree and artifact manifests.

**Interfaces:** All prior feature registrations/codecs/pages must be production reachable. Final outputs are remote SHA/tree, tests with exact versions/exits and downloadable delivery artifacts.

- [x] Complete four vertical gates: install/raw/recovery; raw/knowledge/goal/explainable export; weekly/AI/review/nextweek; colleague setup/notification/update.
- [x] Complete six independent lenses: UX/IA; visual/accessibility; data/method; browser/privacy; architecture/distribution/update; end-to-end weekly/product. Fix material findings with scoped re-review and ledger rulings.
- [x] Complete the stabilized full Vitest run with maxWorkers=2 and npm run build. Preserve actual tested SHA/output, all Windows-only skips and target environment limitations in the acceptance act.
- [x] Inspect real UI/export screenshots, keyboard/reflow, actual HTTP/SQLite behavior and all55TXT dispositions/25AC coverage. No open P0/P1 data/security issue to main.

**Post-commit publication record:** complete source/docs are committed before the allowed non-force expected-head update. The actual remote readback and exact codeZIP/prepared/setup/PDF evidence are recorded after publication in the delivered `publication.json` and `RELEASE_MANIFEST.json`; they cannot be self-referentially embedded in this preceding Git commit.

## Self-review and continuing execution

All18 specification sections map to Tasks0–9; all T01–T12 and AC01–AC25 are assigned. Shared-file ownership is resolved in this plan and the per-plan ledger. No required weekly/update/report scope is silently deferred. If context resets, resume from committed PROGRESS, plan ledger and git log; do not repeat completed audits or restart the plan.
