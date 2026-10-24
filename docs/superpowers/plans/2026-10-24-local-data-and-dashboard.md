# UOR DIT Operations: план первого этапа

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Делегирование и дополнительные внешние согласования этим документом не назначаются.

**Goal:** запустить из разрешённой папки локальное рабочее место с готовыми данными, расчётами и подтверждениями, качественным обзором по ИТ-лидерам и публикацией общих кураторских изменений через тестовый Git.

**Architecture:** React/TypeScript UI и локальная Node.js-служба, SQLite в `.runtime`, файлы общего каталога отдельно от личных фактов. Сборщик первого этапа демонстрационный; реальные браузерные интеграции подключаются через тот же контракт позже.

**Tech Stack:** Node.js 22.20+, npm, TypeScript, React, Vite, Fastify, Zod, SQLite через изолированный адаптер `node:sqlite`, Vitest, Testing Library. Версии пакетов закрепляются при реализации. Синхронный драйвер SQLite исполняется в выделенном worker при объёмах, блокирующих служебные операции.

**Spec:** `docs/superpowers/specs/2026-10-24-uor-dit-operations-design.md`.

## Global Constraints

- Название: «Рабочее место УОР ДИТ Operations»; УОР — управление обеспечения развития.
- Основной запуск: `npm run dev` из разрешённого корня; среда устанавливается по гайду.
- Windows, macOS, СберОС; пути/процессы/авторизация не зависят от одного жёсткого Linux-пути.
- Первый этап работает с уже имеющимися данными; реальный браузерный сбор остаётся помеченной заглушкой.
- main — опубликованное; release/current — накопление кураторских изменений; руководитель выпускает merge commit.
- Читатель не публикует; код куратора не заменяет персональное разрешение Git.
- Никаких кодов в открытом виде, профилей браузера и личных исходных выгрузок в общих файлах.
- Публичный тестовый контур имеет `publicationMode: demo-only`; рабочие файлы импортируются только локально.
- Положительная оценка требует кураторского подтверждения с комментарием или артефактом; отрицательная применяется сразу.
- Любая операция имеет этап, длительности и итог; не создаём фиктивные проценты прогресса.

## Review Focus

- Нет числовых применимых наблюдений: оценка неизвестна, а не 100% — тест в задаче 3.
- Локально код куратора принят, но Git-доступ read-only: публикация отклонена — тест в задаче 5.
- Два куратора одновременно меняют разные цели: обе правки присутствуют после повторного push — тест в задаче 5.
- Ранее подтверждённое выполнение стало отрицательным: немедленно «не выполнено», старое подтверждение только в истории — тест в задаче 3.
- Приложение перезапущено во время операции либо путь содержит пробелы/кириллицу: понятное восстановление статуса и безопасные пути — тесты в задачах 1 и 6.

## Граница текущего плана

Включены локальный каталог, роли, расчёты и кураторская проверка, общий проверенный снимок, базовая синхронизация/публикация, прогресс операций и директорский обзор. Отдельные будущие планы: реальный Qlik/Confluence, презентации/документы, расписания и расширенные источники. Продуктовые требования для них уже заданы в мастерспеке, но этот план их реализованность не обещает.

Документация, существующая до реализации, сохраняет статус «целевые команды». После каждой задачи обновляется только соответствующий фактически выполненный раздел.

## Структура ответственности

```text
src/domain/                   типы, Zod-схемы, общие ошибки
src/server/app.ts             создание Fastify без автоматического listen
src/server/main.ts            старт и завершение службы
src/server/workspace/         разрешённые корни и безопасные пути
src/server/storage/           SQLite, транзакции, миграции
src/server/operations/        журнал стадий и SSE
src/features/catalog/         импорт, чтение, черновики и редактор
src/features/identity/        локальная сессия и кураторский код
src/features/evaluation/      чистые расчёты и подтверждения
src/features/snapshots/       личные и общие снимки, выбор происхождения
src/features/sources/         интерфейс и демонстрационный адаптер
src/features/publishing/      Git, слияние и семантические изменения
src/features/overview/        матрица, лидер, детализация
src/app/                      оболочка, маршруты и общие представления
config/                       примеры конфигурации без секретов
catalog/                      обезличенный общий начальный каталог
tests/fixtures/               обезличенные предметные случаи
tests/integration/            файловые, SQLite и Git-сценарии
```

### Задача 1. Локальный запуск, контракты и сохранность операций

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`.
- Create: `src/domain/contracts.ts`, `src/server/app.ts`, `src/server/main.ts`.
- Create: `src/server/workspace/paths.ts`, `src/server/storage/database.ts`, `src/server/operations/operation-store.ts`.
- Create: `scripts/dev.mjs`, `config/site.example.json`.
- Test: `tests/integration/workspace-and-operations.test.ts`.

**Interfaces:**
- Produces: `resolveWorkspace(input: { projectRoot: string; allowedRoots: string[] }): Promise<WorkspacePaths>`.
- Produces: `safeArtifactPath(root: string, relativePath: string): Promise<string>`.
- Produces: `createApp(deps: AppDependencies): Promise<FastifyInstance>`.
- Produces: `OperationStore.start(kind: OperationKind): Promise<Operation>`; `stage(id: string, stage: OperationStage): Promise<void>`; `finish(id: string, result: OperationResult): Promise<void>`; `get(id: string): Promise<Operation>`.
- Contracts: `CatalogSnapshot`, `Goal`, `Metric`, `Assignment`, `Observation`, `Evaluation`, `Attestation`, `ValidatedSnapshot`, `DomainChangeEvent`, `Session`. Их поля соответствуют мастерспеке; отсутствующие необязательные значения представлены `null`, не выдуманными строками.
- `Operation`: id, kind, status, stage, startedAt, stageStartedAt, finishedAt, completed/total при известном объёме, result; все времена — ISO UTC, длительности рассчитываются по сохранённым отметкам.

- [ ] **Step 1: Зафиксировать проверки разрешённых путей, восстановления и времени операции.**

```ts
it('rejects traversal and resolved symlink outside approved root');
it('accepts approved path containing spaces and Cyrillic');
it('keeps stage start and elapsed time after reopening operation store');
it('marks unfinished operation interrupted when the service restarts');
```

- [ ] **Step 2: Запустить `npm test -- tests/integration/workspace-and-operations.test.ts` и получить падение на отсутствующих модулях.**
- [ ] **Step 3: Реализовать контракты, SQLite-миграцию, пути, операции и health endpoint; dev-скрипт запускает службу и Vite, открывает UI после готовности, завершает дочерние процессы.**
- [ ] **Step 4: Повторить тест задачи; проверить `npm run dev` из разрешённого корня и понятный отказ из запрещённого.**
- [ ] **Step 5: Сохранить коммит `feat: add approved workspace and local runtime foundation`.**

### Задача 2. Каталог, кураторская сессия и самостоятельное редактирование

**Files:**
- Create: `src/features/catalog/catalog-store.ts`, `catalog-routes.ts`, `import-map.ts`, `catalog-schema.ts`.
- Create: `src/features/identity/role-service.ts`, `identity-routes.ts`.
- Create: `src/features/catalog/GoalEditor.tsx`, `src/features/identity/Welcome.tsx`.
- Create: `scripts/setup-curators.mjs`; local output only: `.runtime/local-config/curators.json`.
- Test: `tests/integration/catalog-and-identity.test.ts`, `tests/fixtures/goal-map-demo.html`.

**Interfaces:**
- Consumes: контракты, пути, SQLite и OperationStore из задачи 1.
- Produces: `CatalogStore.read(): Promise<CatalogSnapshot>`; `saveDraft(session: Session, change: CatalogChange): Promise<Draft>`; `listDrafts(session: Session): Promise<Draft[]>`.
- Produces: `importGoalMap(html: string): ImportPreview`; HTML читается как данные, скрипты не исполняются.
- Produces: `RoleService.enterReader(): Promise<Session>`; `enterCurator(code: string): Promise<Session>`; `requireCurator(sessionId: string): Promise<CuratorSession>`.
- `CatalogChange`: тип объекта, id, базовая ревизия и изменённые поля. Отправка в Git реализуется задачей 5.

- [ ] **Step 1: Добавить предметные проверки.**

```ts
it('imports source goal IDs, directions and assignment overrides without executing HTML');
it('preserves unknown owner, curator and targets as null');
it('rejects invalid curator code and stores no plaintext code in audit');
it('denies reader requests to save shared changes at the service boundary');
it('reopens a saved local draft without changing published catalog');
```

- [ ] **Step 2: Запустить `npm test -- tests/integration/catalog-and-identity.test.ts`, подтвердить падение.**
- [ ] **Step 3: Реализовать импорт/предпросмотр/черновики, серверную сессию, scrypt-проверку локального хеша и редактор полей цели/назначения/источника. Коды вводятся setup-скрипту скрытым вводом, не аргументом команды.**
- [ ] **Step 4: Повторить тесты задачи и вручную пройти читатель → куратор → изменение цели → перезапуск → восстановление черновика.**
- [ ] **Step 5: Сохранить коммит `feat: add curator profiles and editable goal catalog`.**

### Задача 3. Расчёты, прогресс и подтверждение положительного результата

**Files:**
- Create: `src/features/evaluation/evaluate.ts`, `progress.ts`, `fingerprint.ts`, `attestation-service.ts`.
- Test: `src/features/evaluation/evaluate.test.ts`, `attestation-service.test.ts`.
- Create: `tests/fixtures/maturity-demo.json`.

**Interfaces:**
- Consumes: `CatalogSnapshot`, `Observation`, `Session`, локальное хранилище.
- Produces: `evaluateGoal(input: EvaluationInput): Evaluation`.
- Produces: `evaluationFingerprint(input: EvaluationInput): string` с канонической сортировкой входов.
- Produces: `confirmAchievement(session: CuratorSession, input: { evaluationId: string; comment: string | null; evidenceIds: string[] }): Promise<Attestation>`.
- `Evaluation`: goal/assignment, period, actual, progress, official/internal result, coverage, quality flags, fingerprint и validation (`not_required`, `pending`, `confirmed`).

- [ ] **Step 1: Зафиксировать арифметику и переходы.**

```ts
it('uses numerator and denominator rather than average of team percentages');
it('keeps no PR, no releases and exception reasons distinct from zero');
it('returns unknown for zero eligible numeric observations');
it('returns met and pending before curator confirmation');
it('rejects confirmation with blank comment and empty evidenceIds');
it('returns not_met immediately after a confirmed result regresses');
it('keeps fingerprint for identical data downloaded at another time');
it('invalidates confirmation when target, cohort or reporting period changes');
```

- [ ] **Step 2: Запустить `npm test -- src/features/evaluation` и получить предметные падения.**
- [ ] **Step 3: Реализовать поддержанные типы показателей и ограниченный реестр операций; абсолютные факты и прогресс хранить раздельно. Проверить ответственность куратора при подтверждении.**
- [ ] **Step 4: Повторить тесты; показать на демо-цели последовательность красный → зелёный на проверке → подтверждён → снова красный.**
- [ ] **Step 5: Сохранить коммит `feat: add goal evaluation and curator achievement confirmation`.**

### Задача 4. Источники, ручные факты и проверенные общие снимки

**Files:**
- Create: `src/features/sources/source-adapter.ts`, `demo-adapter.ts`, `manual-input.ts`.
- Create: `src/features/snapshots/snapshot-store.ts`, `select-facts.ts`, `publication-package.ts`.
- Test: `src/features/snapshots/select-facts.test.ts`, `tests/integration/snapshot-acceptance.test.ts`.

**Interfaces:**
- Consumes: контракты, расчёты и операции.
- Produces: `SourceAdapter.check(): Promise<SourceReadiness>`; `collect(request: CollectRequest, signal: AbortSignal): AsyncIterable<SourceEvent>`.
- Produces: `acceptSnapshot(input: SnapshotInput): Promise<LocalSnapshot>` — атомарное принятие после контракта.
- Produces: `selectFacts(input: { mode: 'auto' | 'personal' | 'published'; personal: LocalSnapshot | null; published: ValidatedSnapshot[]; expectedScope: Scope }): SelectedFacts`.
- Produces: `preparePublication(session: CuratorSession, snapshotId: string): Promise<PublicationPackage>` — без сетевой отправки, которую выполняет задача 5.

- [ ] **Step 1: Проверить происхождение, отказ доступа и сохранность.**

```ts
it('falls back to compatible validated published data and keeps personal access error');
it('does not silently merge snapshots from different periods or curators');
it('labels manual entry with author, enteredAt and reporting period');
it('preserves previous snapshot after invalid new import');
it('rejects corporate-classified publication in demo-only mode');
it('does not transfer achievement confirmation to different personal facts');
```

- [ ] **Step 2: Запустить `npm test -- src/features/snapshots tests/integration/snapshot-acceptance.test.ts`, подтвердить падение.**
- [ ] **Step 3: Реализовать демонстрационные исходы, ручной факт, нормализованный снимок, проверку куратором и разрешённый состав отправки. Не добавлять реальный браузерный вход.**
- [ ] **Step 4: Повторить тесты и показать читателя без личного доступа с явной плашкой проверенного демо-кураторского набора.**
- [ ] **Step 5: Сохранить коммит `feat: add source provenance and curator-validated snapshots`.**

### Задача 5. Публикация кураторов и объединение изменений

**Files:**
- Create: `src/features/publishing/git-provider.ts`, `git-cli-provider.ts`, `publish-service.ts`, `merge-object.ts`, `semantic-diff.ts`.
- Test: `tests/integration/two-curator-publish.test.ts`, `permission-and-publication.test.ts`.
- Modify: `docs/guides/curator-workflow.md` по фактическому поведению.

**Interfaces:**
- Consumes: `Draft`, `PublicationPackage`, `DomainChangeEvent`, `OperationStore`, серверная сессия.
- Produces: `GitProvider.checkUpdates(branch: string, knownCommit: string | null): Promise<UpdateInfo>`.
- Produces: `GitProvider.readVersion(branch: string): Promise<RepositoryVersion>`; `GitProvider.pushChanges(input: PublishChanges): Promise<PublishResult>`.
- Produces: `publishDrafts(session: CuratorSession, draftIds: string[]): Promise<Operation>`.
- Produces: `describeChanges(before: RepositoryVersion, after: RepositoryVersion): DomainChangeEvent[]`.
- `PublishResult`: remoteCommit, branch, appliedObjectIds; конфликт возвращается как типизированный результат, а не force push.

- [ ] **Step 1: Добавить интеграционные проверки с двумя рабочими копиями и локальным bare-репозиторием, без реальной сети.**

```ts
it('combines concurrent edits to different goals in release/current');
it('retries non-fast-forward after refreshing remote head without losing changes');
it('preserves both drafts for conflicting edit of the same field');
it('rejects publication when curator session has no repository write permission');
it('keeps draft unsent after network failure');
it('never includes runtime files or plaintext codes in commit');
it('includes semantic changes even if a remote file was edited without event file');
```

- [ ] **Step 2: Запустить `npm test -- tests/integration/two-curator-publish.test.ts tests/integration/permission-and-publication.test.ts`, подтвердить падение.**
- [ ] **Step 3: Реализовать изолированную Git-копию, merge по объектам, три ограниченные попытки, публикацию в release/current и журнал; main остаётся читаемым источником выпуска.**
- [ ] **Step 4: Повторить проверки; отдельно выполнить согласованный демо-цикл в тестовом Git с обезличенными файлами: отправка → выпуск руководителем → получение читателем. Зафиксировать, какие сетевые действия фактически проверены.**
- [ ] **Step 5: Сохранить коммит `feat: add release-branch publication and safe concurrent updates`.**

### Задача 6. Выбор обновления и сквозной статус операций

**Files:**
- Create: `src/features/sources/update-planner.ts`, `update-runner.ts`.
- Create: `src/features/operations/OperationPanel.tsx`, `UpdateDialog.tsx`, `ChangesView.tsx`.
- Create: `src/server/operations/operation-routes.ts`.
- Test: `src/features/sources/update-planner.test.ts`, `tests/integration/update-order.test.ts`.

**Interfaces:**
- Consumes: OperationStore, GitProvider, SourceAdapter, расчёты и снимки.
- Produces: `planUpdate(selection: UpdateSelection, catalog: CatalogSnapshot): UpdatePlan`.
- Produces: `runUpdate(plan: UpdatePlan, session: Session): Promise<Operation>`.
- `UpdateSelection`: syncPublished boolean, sourceIds string[], recalculate boolean. «Всё» преобразуется в это же представление. Источники дедуплицируются по sourceId и каноническим параметрам.
- Produces: `GET /api/operations/:id/events` с восстановлением по последнему event id; UI при разрыве переподключается.

- [ ] **Step 1: Зафиксировать порядок и частичный результат.**

```ts
it('finishes selected Git sync before any collection starts');
it('does not sync Git for sources-only selection');
it('collects common source once for matching parameters');
it('reports partial result when one independent source fails');
it('restores current stage and durations after the browser reconnects');
```

- [ ] **Step 2: Запустить `npm test -- src/features/sources tests/integration/update-order.test.ts`, подтвердить падение.**
- [ ] **Step 3: Реализовать план обновления и панель выбора, этапы/таймеры, отмену, историю и сводку полученных изменений. Процент показывать только при известном объёме.**
- [ ] **Step 4: Повторить проверки и вручную пройти три команды: общие данные, один источник, всё.**
- [ ] **Step 5: Сохранить коммит `feat: add selectable updates and persistent operation progress`.**

### Задача 7. Директорский обзор и персональная картина ИТ-лидера

**Files:**
- Create: `src/features/overview/OverviewPage.tsx`, `LeaderPage.tsx`, `GoalPage.tsx`, `GoalLeaderMatrix.tsx`, `overview-model.ts`.
- Create: `src/app/App.tsx`, `src/app/styles.css`, `src/features/overview/view-preferences.ts`.
- Test: `src/features/overview/overview-model.test.ts`, `GoalLeaderMatrix.test.tsx`.

**Interfaces:**
- Consumes: каталог, выбранные факты, Evaluation, Attestation, операции и semantic changes.
- Produces: `buildOverview(input: OverviewInput): OverviewModel` — единственный источник состава матрицы/сводок.
- Produces: переходы ДИТ → лидер → цель/участник с сохранением среза и периода.
- Preferences: контур оценки, группировка, раскрытие, масштаб/детализация и набор видимых столбцов; личные, не публикуются автоматически.

- [ ] **Step 1: Проверить состав и отсутствие ложного успеха на экране.**

```ts
it('groups goals by direction and shows every assigned IT leader by name');
it('distinguishes met pending validation from met confirmed');
it('preserves selected leader scope when opening goal details');
it('shows curator provenance and stale-data flags beside actual values');
it('keeps totals consistent when rows are collapsed or filtered');
```

- [ ] **Step 2: Запустить `npm test -- src/features/overview`, подтвердить падение.**
- [ ] **Step 3: Реализовать связный интерфейс с центральной матрицей, осмысленной иерархией текста, раскрытием деталей, виртуализацией и семантическим масштабом; обеспечить альтернативную навигацию без зума.**
- [ ] **Step 4: Повторить проверки и визуально просмотреть 1366×768 и Full HD: директорская сводка, лидер, цель, панель проверки и состояние ошибки. Исправить обрезания и неразличимые статусы.**
- [ ] **Step 5: Сохранить коммит `feat: add director and IT leader goal workspace`.**

### Задача 8. Предметная демонстрация, руководство и передача

**Files:**
- Create: `docs/demo/first-stage-walkthrough.md`, `docs/verification/first-stage-evidence.md`.
- Modify: `README.md`, `docs/guides/setup-and-run.md`, `docs/AI_PDLC_HANDOFF.md`.
- Test: `tests/integration/first-stage-flow.test.ts`.

**Interfaces:**
- Consumes: все реализованные модули, без новых продуктовых контрактов.
- Produces: воспроизводимый сценарий демонстрации и честный перечень проверенных платформ/интеграций.

- [ ] **Step 1: Зафиксировать сквозной тест: каталог → локальные факты → расчёт → подтверждение → подготовка общей публикации → обзор читателя.**
- [ ] **Step 2: Запустить `npm test -- tests/integration/first-stage-flow.test.ts`, зафиксировать отсутствующие связи.**
- [ ] **Step 3: Соединить оставшиеся границы и обновить документацию фактическими командами/ограничениями.**
- [ ] **Step 4: Выполнить `npm test`, `npm run build`, затем реальную браузерную демонстрацию. Тесты расчётов не считать проверкой дизайна, а демо-сборщик — проверкой корпоративного входа.**
- [ ] **Step 5: Сохранить коммит `docs: document first-stage demonstration and corporate handoff`.**

## Порядок демонстраций

После задачи 2 — запуск и самостоятельная правка каталога. После задачи 3 — понятные статусы и подтверждения. После задачи 4 — собственные и кураторские факты. После задач 5–6 — отправка/получение, история и длительности. После задачи 7 — рабочая управленческая картина. После задачи 8 — итог первого этапа и выбор следующего.

Переход к реальному браузерному сбору выполняется отдельным планом. Документы не объявляют данный план исполненным заранее.
