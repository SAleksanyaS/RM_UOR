# UOR Workbench Core and Calculation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tool-agnostic fallback mandated by the user:** if those skills/tools are unavailable, execute the same tasks, tests, review gates and Git commands directly; unavailable Codex tools never block execution. Skills are optional in that fallback. This document authorizes planning only; implementation starts after the user's plan review.

**Goal:** Создать точное предметное ядро, отдельное версионное хранилище и воспроизводимый расчёт с бессрочной историей, сохраняя работающую версию до T39.

**Architecture:** Новая модель живёт в `src/domain/workbench`, чистые функции — в `src/features/evaluation/workbench`. SQLite-репозиторий сохраняет неизменяемые редакции, CAS и индексы, а отдельный серверный resolver передаёт вычислителю уже разрешённые версии и часы. Старые contracts/evaluator/LocalDatabase остаются действующим путём до общего cutover.

**Tech Stack:** TypeScript strict/ES2022, Zod 4, BigInt, Node `node:sqlite`, Vitest; Node.js 22.16.0, npm 10.9.2, Python 3.13.5 только для соответствующего адаптера.

**Spec:** `docs/superpowers/specs/2026-10-28-uor-workbench/16-data-calculation-contract.md` §§3–14; `19-acceptance-delivery-contract.md` §§2–8; решения `05-decisions.md` D-021–D-041, D-074–D-088, D-104–D-125; примеры `14-acceptance-examples.md`; API `17-interface-api-contract.md` §§queries/commands; anchor из `18-integration-operations-contract.md` §12. Общие имена: [CONTRACTS.md](CONTRACTS.md).

## Global Constraints

- Основной checkout: `C:/Users/Sasha/Documents/ChatGPT/единый дашборд целей/RM_UOR`; ветка `codex/uor-workbench-rebuild`, исходный commit `3d8704e4a6ff2195af4f2c0602ed11bff5d38f4b`. Все команды ниже — из этого корня, PowerShell. Не обновлять `RM_UOR-compat-22.16.0` параллельно.
- Перед первой задачей: `git status --short`, `git branch --show-current`, `node --version`, `npm --version`, `python --version`; ожидаемые версии `v22.16.0`, `10.9.2`, `Python 3.13.5`. При расхождении остановить изменение среды и записать причину. `npm ci` нужен только при отсутствующих/неподходящих зависимостях; не выполнять setup:workspace над существующей установкой.
- Это план, не протокол запуска: все FAIL/PASS ниже — **ожидаемые**, ещё не полученные результаты. В исполнении сохранять команду, runtime, exit code и краткое доказательство в журнале главного плана.
- Никаких новых npm scripts/dependencies для ядра. Использовать существующие `npm test -- <точный файл>` и `npm run build`. Импорты TypeScript следуют существующему стилю без расширения.
- Decimal — каноническая конечная десятичная строка; Rational — сокращённые целые строки с положительным знаменателем. Числа измерений, веса, пороги, проценты и сравнения не переводятся в JS Number; Number допустим для безопасных revision, счётчиков и миллисекунд календаря. JSON никогда не содержит BigInt.
- Все fixture — синтетические; фиксированные UUIDv4/часы/названия `demo_*`. Не читать рабочую `.runtime`, локальные настройки, реестр доступа или корпоративные исходники ради теста.
- История бессрочная: нет DELETE старых редакций, lifetime cap, автоматической очистки или годового сброса. Уточнение истории не дорисовывает отсутствующие старые основания.
- Источник, измерение, расчёт, работа, комментарий и подтверждение — разные сущности. Ни pure evaluation, ни query, ни Friday projection не создают Capture/ObservedFact/Attestation/PR.
- Поддержаны только reducer whitelist и формулы 16; неизвестный kind/несовместимые единицы блокируют основание. Нет JS/SQL/formula-string из пользовательских данных.
- Новые назначения/связи активируются только confirmed main; неизвестное mergedAt не блокирует текущую main. Запрос точной wall-clock границы получает `EFFECTIVE_TIME_UNVERIFIED`, старый basis остаётся читаемым.
- Все перечисленные ниже production-файлы сначала **Create**; последующие задачи явно **Modify** только уже созданные здесь файлы. До T39 не менять старые `src/domain/contracts.ts`, `src/features/evaluation/{evaluate,measurement,normalize,fingerprint,progress}.ts`, `src/features/snapshots/select-facts.ts`, `src/server/storage/database.ts`, `src/features/history/history-service.ts`, `src/server/app.ts`, `src/app/App.tsx`.
- Перед составлением плана проверены эти старые файлы и соседние tests: старый evaluator использует Number и legacy Observation; select-facts допускает fallback даты collectedAt; LocalDatabase хранит mutable records(namespace,id); старый history-service использует list() и текущие каталоги. Их алгоритмы не переиспользовать для новой точности/времени/истории.
- При FAIL исправлять текущую задачу и повторять её точный тест; не продолжать потребителя с заглушкой, не менять ожидаемые числа ради PASS. Git-команды в шагах — будущие команды исполнителя; сейчас их не выполнять.

## Review Focus

1. T01: очень большие Decimal, отрицательный half-up, 99.995 перед порогом 100 — точное сравнение до округления; тест `keeps_exact_comparison_before_display_rounding`.
2. T03: Promise/thenable из транзакции или упавшая вторая запись — полный rollback entity/head/index/stateRevision; тест `rolls_back_async_or_failed_transactions`.
3. T05: одинаковые дата и capturedAt с разным содержимым, полночь МСК и отсутствующий продукт при новом справочнике — диагностируемая неоднозначность/неполнота; тест `does_not_guess_ties_or_population`.
4. T07: серверные часы прошли freshness boundary без новых фактов — прежние basis/result refs и числа, новое подтверждение запрещено, agreed сохранён; тест `reuses_basis_while_projecting_current_quality`.
5. T09: архивированная цель и история более 300/2 000 строк, новая методика/оргсвязь после agreed — доступно всё, старые refs/digest/числа неизменны, запрос пользуется индексом; тест `retains_history_and_frozen_agreed_basis`.

---

## File map and shared interfaces

`src/domain/workbench/entities.ts` — один публичный barrel типов; реализации типов разделены ниже по ответственности. `index.ts` экспортирует только существующие символы. Entity namespace для storage — snake_case (`core_goal_definition`, `goal_assignment`, `method_version`, …); поле API `coreGoalDefinition` сохраняет wire-имя 16, это не namespace. EntityRef всегда сравнивается по entityType+id, VersionRef также по revision.

| Tasks | Files | Responsibility |
| --- | --- | --- |
| T01 | `primitives.ts`, `exact-number.ts`, `time.ts`, `errors.ts` | Форматы, точные операции, время МСК, коды ошибок |
| T02 | `entities/{goals,methods,directory,sources,states,execution,extensions,evaluation,notifications}.ts`, `publication.ts`, `entities.ts`, `schemas/{core,sources,states,extensions,evaluation}.ts`, `schemas.ts`, `index.ts` | Все типы/схемы 16 и anchor 18, ссылки, безопасные fixtures |
| T03 | `src/server/storage/workbench-{schema,repository}.ts` | Новые wb_* таблицы, CAS, транзакции, зарегистрированные схемы, индексированные входы |
| T04–T06 | `src/features/evaluation/workbench/{conditions,reducers,selection-contracts,select-facts,evaluate}.ts` | Условия, reducer whitelist, полнота/время, weighted_mean_v1 |
| T07–T08 | Там же `{basis,resolve-input,prepare-evaluation,state-rules,quality,friday}.ts` | Digest, материализация, ручные/согласованные правила, ephemeral quality, Friday |
| T09 | `src/features/history/{workbench-history-contracts,workbench-history-index,workbench-history}.ts` | Индексированный immutable read model истории |

`Clock={now():UtcInstant}` определяется T01, серверный protocol переэкспортирует его. `EvaluationInput` определяется T02:

```ts
type EvaluationInput = {
  assignment: GoalAssignment; goal: CoreGoalDefinition; method: MethodVersion;
  facts: ObservedFact[]; applicability: Applicability[]; corrections: ManualCorrection[];
  captures: Capture[]; metrics: MetricDefinition[]; context: EvaluationContext;
  resolution: { basisRef: VersionRef; templateRef: VersionRef | null; actor: ActorRef;
    directoryLinkRefs: VersionRef[]; publicationAnchors: PublicationAnchor[] };
};
type PrepareEvaluationRequest = {
  assignmentRef: VersionRef; businessTime: EvaluationContext['businessTime'];
};
```

Resolver выделяет кандидат UUIDv4 basis на сервере; это ещё не запись. Pure evaluator получает `resolution.basisRef`, prepare переиспользует сохранённый ref при совпавшем digest. Браузер не назначает ref/digest/evaluatedAt. Все schema/body/fixture типы T02 существуют до тестов T04–T09.

### T01. Exact numbers, primitive validation and Moscow time

**Dependencies / AC:** нет; AC-01–AC-04, AC-15 (общая точность и календарь), отрицательные случаи 16 §14.4.
**Files:** Create `src/domain/workbench/primitives.ts`, `exact-number.ts`, `time.ts`, `errors.ts`, `primitives.test.ts`, `exact-number.test.ts`, `time.test.ts` (все в этой папке).
**Consumes:** BigInt/crypto.randomUUID/Zod из уже установленных зависимостей.
**Produces:** примитивы 16 §3 и `Clock`; `WorkbenchError extends Error {code:string;details:Record<string,unknown>}` с constructor `(code:string,details?:Record<string,unknown>)`. Экспорты функций:

```ts
canonicalDecimal(input:string):Decimal;
toRational(value:ExactNumber):Rational;
rational(numerator:IntString,denominator:IntString):Rational;
add(a:ExactNumber,b:ExactNumber):Rational;
subtract(a:ExactNumber,b:ExactNumber):Rational;
multiply(a:ExactNumber,b:ExactNumber):Rational;
divide(a:ExactNumber,b:ExactNumber):Rational;
compare(a:ExactNumber,b:ExactNumber):-1|0|1;
formatExact(value:ExactNumber,places?:number):string; // default 2, half-up, trim trailing zeros
newUuid():UUIDv4;
moscowStart(date:MoscowDate):UtcInstant;
moscowEnd(date:MoscowDate):UtcInstant;
addMoscowDays(date:MoscowDate,days:number):MoscowDate;
```

- [ ] Написать `keeps_exact_comparison_before_display_rounding` в exact-number.test.ts; `R` — локальный helper `(n:string,d='1')=>({numerator:n,denominator:d})`:

```ts
expect(canonicalDecimal('00092.000')).toBe('92');
expect(canonicalDecimal('-0.000')).toBe('0');
expect(divide(multiply('92','100'),'90')).toEqual(R('920','9'));
expect(add('9007199254740993.01','0.09')).toEqual(R('90071992547409931','10'));
expect(formatExact('99.995')).toBe('100');
expect(compare('99.995','100')).toBe(-1);
expect(formatExact('-1.235')).toBe('-1.24');
expect(()=>divide('1','0')).toThrowError(expect.objectContaining({code:'DIVISION_BY_ZERO'}));
for (const value of ['NaN','Infinity','1e3','+1',' 1 ']) expect(()=>canonicalDecimal(value)).toThrow();
```

- [ ] Добавить `validates_wire_primitives` и `uses_moscow_calendar_boundaries` с точными assertions: canonical Decimal schema отвергает `92.0/-0/01`; UUID schema принимает `00000000-0000-4000-8000-000000000001`, отвергает v1; Rational schema отвергает `2/4`, denominator `0` и `-1`; MoscowDate отвергает `2026-02-29`, принимает `2028-02-29`; UtcInstant отвергает timestamp без Z; `moscowStart('2026-10-23')==='2026-10-22T21:00:00.000Z'`, `moscowEnd(...)==='2026-10-23T20:59:59.999Z'`, `addMoscowDays('2026-12-31',1)==='2027-01-01'`.
- [ ] RED: `npm test -- src/domain/workbench/exact-number.test.ts src/domain/workbench/primitives.test.ts src/domain/workbench/time.test.ts` → FAIL: отсутствующие новые модули/экспорты.
- [ ] Реализовать указанные signatures; primitives.ts экспортирует отдельные strict Zod schemas `uuidSchema`, `decimalSchema`, `rationalSchema`, `utcInstantSchema`, `moscowDateSchema`, `sha256Schema`, `versionRefSchema`. Canonicalizer принимает неканоническую десятичную запись без экспоненты, wire schema требует canonical; GCD сокращает дроби, знак только у numerator, ноль `0/1`. Сравнение — cross-multiply BigInt. Не round при parse/арифметике; half-up применяется только formatter.
- [ ] GREEN: повторить RED-команду → PASS; `npm run build` → exit 0. Сохранить отсутствие новых runtime dependencies.
- [ ] Commit:

```powershell
git add src/domain/workbench/primitives.ts src/domain/workbench/exact-number.ts src/domain/workbench/time.ts src/domain/workbench/errors.ts src/domain/workbench/primitives.test.ts src/domain/workbench/exact-number.test.ts src/domain/workbench/time.test.ts
git commit -m "feat(workbench): add exact numeric and time primitives"
```

### T02. All domain-16 contracts, strict schemas, version references and fixture factories

**Dependencies / AC:** T01; AC-06, AC-09–AC-12, AC-16, AC-34, AC-46, AC-47, AC-49, AC-55 (структурные правила; команды/права реализуются позже).
**Files:** Create все `entities/*`, `publication.ts`, `entities.ts`, `schemas/*`, `schemas.ts`, `index.ts` из file map; Test/Create `src/domain/workbench/schemas.test.ts`; Create `tests/fixtures/workbench/factories.ts`.
**Consumes:** примитивы/точные сравнения T01. **Produces:** все типы и discriminated unions из 16 §§3–9/12 **без сокращения полей**, PublicationAnchor из 18 §12 (без выдуманных Header-полей), EvaluationInput/PrepareEvaluationRequest выше. `GitOid=string` валидируется как 40/64 lower hex; UTCDateTime anchor — alias UtcInstant.

| Type file | Required exported contracts |
| --- | --- |
| `entities/goals.ts` | CoreGoalDefinition, MethodBinding, GoalAssignment, Template |
| `entities/methods.ts` | MetricDefinition, NumericCondition, Normalization, MetricRule, MethodVersion, InputReducer |
| `entities/directory.ts` | DirectoryEntity, DirectoryLink, PublicationAnchorRef |
| `entities/sources.ts` | RawCell, RawSourceRow, CanonicalSourceRow, SourceFieldMapping, SourceParsingProfile, SourceDefinition, Capture, Lineage, ObservedFact |
| `entities/states.ts` | Applicability, ManualCorrection, ManualState, ManualStatusEvent |
| `entities/execution.ts` | Work, WorkDependency, Decision |
| `entities/extensions.ts` | CustomFieldDef, CustomFieldValue, Commentary, FileArtifactRef, Evidence, RegisteredPayload, DashboardDef |
| `entities/notifications.ts` | BusinessCalendar, ReminderSettings, PersonalOwner, NotificationSubscription, NotificationReadState |
| `entities/evaluation.ts` | EvaluationBasis, NumericEvaluation, CalculationResult, Attestation, AgreedSnapshot, WeeklyPoint, EvaluationInput, PrepareEvaluationRequest |

Schema ownership: core.ts — goals/methods/directory/publication; sources.ts — источники/факты; states.ts — N/A/corrections/manual/work/dependencies/decision; extensions.ts — поля/комментарии/evidence/dashboard/calendar/личные настройки; evaluation.ts — basis/result/attestation/snapshot. schemas.ts объединяет их. `schemaForEntity(type:string):z.ZodType<Header>` принимает только Header-сущности; private notifications/read-state и PublicationAnchor имеют отдельные schemas, не притворяются Header.

```ts
type ReferenceRequirement={ref:EntityRef|VersionRef;expectedEntityTypes:string[]};
type WorkbenchEntityMap={
 core_goal_definition:CoreGoalDefinition;goal_assignment:GoalAssignment;template:Template;
 metric_definition:MetricDefinition;method_version:MethodVersion;
 directory_entity:DirectoryEntity;directory_link:DirectoryLink;
 source_field_mapping:SourceFieldMapping;source_definition:SourceDefinition;
 capture:Capture;observed_fact:ObservedFact;applicability:Applicability;
 manual_correction:ManualCorrection;manual_status_event:ManualStatusEvent;
 work:Work;work_dependency:WorkDependency;decision:Decision;
 custom_field_def:CustomFieldDef;custom_field_value:CustomFieldValue;
 commentary:Commentary;evidence:Evidence;dashboard_def:DashboardDef;
 business_calendar:BusinessCalendar;reminder_settings:ReminderSettings;
 evaluation_basis:EvaluationBasis;calculation_result:CalculationResult;
 attestation:Attestation;agreed_snapshot:AgreedSnapshot;
};
type WorkbenchEntityType=keyof WorkbenchEntityMap;
type WorkbenchEntity=WorkbenchEntityMap[WorkbenchEntityType];
parseEntity<K extends WorkbenchEntityType>(type:K,input:unknown):WorkbenchEntityMap[K];
entityReferences(type:WorkbenchEntityType,value:WorkbenchEntity):ReferenceRequirement[];
validateReferences(requirements:ReferenceRequirement[],resolve:(ref:EntityRef|VersionRef)=>unknown|null):void;
validateCustomFieldValue(value:CustomFieldValue,definition:CustomFieldDef):void;
type SourceParsingProfile={sheetName:string|null;csvDelimiter:','|';'|'\t';
 csvEncoding:'utf8'|'windows1251';dateFormat:'iso'|'dd.mm.yyyy'|'excel-serial';
 decimalSeparator:'.'|',';groupSeparator:'none'|'space'|'nbsp'|'comma'|'dot'};
```

- [ ] Зафиксировать согласованное дополнение к SourceFieldMapping/SourceDefinition (addendum главного плана): `SourceFieldMapping.parsingProfile?:SourceParsingProfile` со schema default `{sheetName:null,csvDelimiter:',',csvEncoding:'utf8',dateFormat:'iso',decimalSeparator:'.',groupSeparator:'none'}`; конфликт decimalSeparator с одноимённым groupSeparator отвергается. `SourceDefinition.browserScenarioRef?:VersionRef|null` разрешает только entityType`browser_scenario`; тип будущего BrowserScenario сюда не импортировать. Parsing/recorder/использование существующего browser.ts реализуют T15/T42–T48; ядро только хранит/валидирует настройки и ссылки, не угадывает неоднозначную дату.
- [ ] Явно дополнить `EvaluationBasis` полями `templateRef:VersionRef|null` и `evaluatedAt:UtcInstant|null`: первое сохраняет версию использованного шаблона (standalone=null), второе — часы первой материализации для воспроизводимости качества. Новая основа всегда получает evaluatedAt из server EvaluationContext; отсутствующее историческое время миграции не дорисовывается. Эти поля и правила описаны также в дополнении21. Digest включает templateRef, но исключает evaluatedAt; ни один Pick<> в T07 не ссылается на отсутствующее поле.
- [ ] Создать factory exports с **полными** defaults: `fixtureId(seed:number):UUIDv4` (последние 12 hex от seed), `makeHeader(seed:number,overrides?:Partial<Header>):Header`, `versionRef(entityType:string,seed:number,revision?:number):VersionRef`, `makeSourceRow(rowKey:string,numbers:Record<string,Decimal|null>):CanonicalSourceRow`, `makePublicationAnchor(overrides?:Partial<PublicationAnchor>):PublicationAnchor`.
- [ ] Там же `makeNumericFixture(options?:{seedBase?:number;scope?:ScopeRef;values?:Array<Decimal|null>;weights?:Decimal[];mandatory?:boolean[];targets?:Decimal[];scoreTarget?:Decimal;expectedPopulation?:ScopeRef[];observedPopulation?:ScopeRef[];context?:EvaluationContext}):EvaluationInput` и `makeEntityGraph(input?:EvaluationInput):{anchors:PublicationAnchor[];entries:Array<{entityType:WorkbenchEntityType;value:WorkbenchEntity}>;input:EvaluationInput}`. Default: seedBase0, scope one product `fixtureId(101)`, metric `fixtureId(201)`, fact100/target100/weight100/mandatoryfalse; gte/increase/source_provided_value valueField `demo_value`; maxAge168/updateEvery24; businessTime as_of 2026-10-23; capturedAt/sourceUpdatedAt `2026-10-23T09:00:00Z`; evaluatedAt `2026-10-23T12:00:00Z`; all Header recordedAt `2026-10-23T10:00:00Z`; actor hostname `demo-host`, installationId fixtureId(1), profilePersonId null. seedBase прибавляется ко всем внутренним seeds графа (кроме явно переданных ScopeRef), позволяя seed двух независимых fixtures без ID collision. values/weights/targets lengths agree or factory throws. Cross product observedPopulation×metrics makes rows/facts with stable unique IDs and lineage; null value has state missing and nonempty reason.
- [ ] makeEntityGraph includes referenced directory/source/mapping/metric/method/goal/assignment/capture/facts and confirmed synthetic anchors, including intentionally cyclic source.goalId/goal.sourceId. All entries reference real included versions; core goal source mode agrees. Это обеспечивает T03 transactional reference validation; factory не импортирует ещё не существующий repository. Manual/extension tests используют полный makeHeader плюс inline typed objects, не `as unknown as`.
- [ ] Написать `rejects_invalid_domain_and_cross_references`: `parseEntity('method_version', negativeWeight)` throws; duplicate metricRef throws; all-zero original weights throws; range min2/max1 throws; duplicate expectedPopulation throws; numeric empty population throws; missing fact with value'0' throws; known fact null throws; negative acceptedRows throws; existing UUID with wrong entityType fails validateReferences; exact method revision999 missing fails. Проверить `makeEntityGraph()` всеми schemas и reference resolver Map<entityType/id/revision,...>.
- [ ] Написать `validates_extension_values_and_manual_states`: enum чужое значение, multi_enum дубликаты, date2026-02-29, empty Commentary.text, URL с credentials, file без hash/MIME или bytes<0 отклоняются; `completed` без resultDescription отвергается; `completed→in_progress` без reason отвергается; Decision.answer без answeredAt отвергается; WorkDependency self-link отвергается; Reminder dailyAt25:00 и дубли дат исключений отвергаются; Evidence file **или** URL принимаются, оба сразу отвергаются. Dashboard registered payload пока проверяется структурно; registry semantic validation — задача дашбордов.

```ts
const i=makeNumericFixture();
if(i.method.mode!=='numeric') throw new Error('fixture must be numeric');
expect(()=>parseEntity('method_version',{...i.method,rules:[
 {...i.method.rules[0],originalWeight:'-1'}]})).toThrow();
expect(()=>parseEntity('commentary',{...makeHeader(801),
 targetRef:{entityType:'goal_assignment',id:i.assignment.id},text:'  '})).toThrow();
expect(()=>validateReferences([{ref:{...versionRef('method_version',1),revision:999},
 expectedEntityTypes:['method_version']}],()=>null)).toThrow();
```

- [ ] RED: `npm test -- src/domain/workbench/schemas.test.ts` → FAIL на отсутствующих schemas/exports. Fixture файл может быть написан первым, но тест не пропускать.
- [ ] Реализовать signatures/types/schemas; `.strict()` для объектов и явные enum. Canonical Decimal не превращать из Number. Поля/типы всех §8a присутствуют; межобъектные проверки выполняются через resolver, не только UUID regex. `publicationAnchorId` всегда reference на `publication_anchor`, никогда автоматически на `publication_package`; published activation проверяет сервер, не Zod по наличию UUID. Private owner records не публикуются generic append.
- [ ] GREEN: та же команда → PASS; `npm run build` → exit0. В schemas.test явно проверить namespace registry.keys() на полный набор Header-типов таблицы, а не только размер.
- [ ] Commit:

```powershell
git add src/domain/workbench/entities/goals.ts src/domain/workbench/entities/methods.ts src/domain/workbench/entities/directory.ts src/domain/workbench/entities/sources.ts src/domain/workbench/entities/states.ts src/domain/workbench/entities/execution.ts src/domain/workbench/entities/extensions.ts src/domain/workbench/entities/evaluation.ts src/domain/workbench/entities/notifications.ts src/domain/workbench/publication.ts src/domain/workbench/entities.ts src/domain/workbench/schemas/core.ts src/domain/workbench/schemas/sources.ts src/domain/workbench/schemas/states.ts src/domain/workbench/schemas/extensions.ts src/domain/workbench/schemas/evaluation.ts src/domain/workbench/schemas.ts src/domain/workbench/index.ts src/domain/workbench/schemas.test.ts tests/fixtures/workbench/factories.ts
git commit -m "feat(workbench): define versioned domain schemas and fixtures"
```

### T03. Append-only SQLite repository, CAS, synchronous transaction and index foundation

**Dependencies / AC:** T01–T02; AC-24, AC-30, AC-51, AC-53 (storage prerequisites).
**Files:** Create `src/server/storage/workbench-schema.ts`, `workbench-repository.ts`, `workbench-repository.test.ts`; Create `tests/fixtures/workbench/repository.ts`.
**Consumes:** parseEntity/entityReferences/validateReferences, PublicationAnchor schema, makeEntityGraph. **Produces:** K01:

```ts
createWorkbenchRepository(options:{filename:string;artifactRoot:string}):WorkbenchRepository;
interface WorkbenchRepository {
  getHead<T extends Header>(ref:EntityRef):T|null;
  readVersion<T extends Header>(ref:VersionRef):T|null;
  append<T extends Header>(entityType:string,value:T,expectedHead:number|null):VersionRef;
  transaction<T>(action:()=>T):T; getStateRevision():string; close():void;
  readPublishedHead<T extends Header>(ref:EntityRef):T|null;
  readPublicationAnchor(ref:EntityRef):PublicationAnchor|null;
  appendPublicationAnchor(value:PublicationAnchor,expectedHead:number|null):VersionRef;
  readEvaluationCandidates(query:EvaluationCandidateQuery):EvaluationCandidates;
  registerEntityType<T extends Header>(type:string,registration:EntityRegistration<T>):void;
  registerProjection(name:string,project:(entityType:string,value:Header)=>void):void;
  sqlForModule(moduleId:string):WorkbenchSql;
}
type EntityRegistration<T extends Header>={schema:z.ZodType<T>;references:(value:T)=>ReferenceRequirement[]};
type EvaluationCandidateQuery={sourceId:UUIDv4;assignmentId:UUIDv4;metricIds:UUIDv4[];
  scopes:ScopeRef[];businessTime:EvaluationContext['businessTime'];evaluatedAt:UtcInstant};
type EvaluationCandidates=Pick<EvaluationInput,'facts'|'captures'|'applicability'|'corrections'>;
type SqlValue=string|number|bigint|null|Uint8Array;
interface WorkbenchSql {
  get<T>(sql:string,params?:SqlValue[]):T|null;
  all<T>(sql:string,params?:SqlValue[]):T[];
  run(sql:string,params?:SqlValue[]):{changes:number};
  execMigration(id:string,ddl:string):void;
}
```

`SqlForModule` — доверенный серверный адаптер со статическим SQL для своих `wb_<module>_*` projection/journal tables; не пользовательский SQL API, не обход append для entity history. Те же connection/transaction; jobs/drafts/search не открывают вторую БД. Создать `seedGraph(repository:WorkbenchRepository,graph:ReturnType<typeof makeEntityGraph>):void` в test fixture repository.ts; он append anchors+entries в одной transaction.

- [ ] **Проверка специальной версии anchor:** при публикации package revision=1 сохранить confirmed/timeUnknown anchor; затем получить проверенный mergedAt и append metadata при expectedHead=1. Версия строки станет2, wire anchor.revision остаётся1, contentHash/mainCommit прежние; повторная старая expectedHead даёт conflict. Не применять Header.revision правило к package revision. Проверка относится к T03/T26 и выполняется в соответствующих repository/publication-anchor tests.

- [ ] Написать `keeps_versions_and_rejects_stale_heads`: temporary directory через mkdtempSync; seedGraph; append metric revision2 expectedHead1, затем stale append expectedHead1 → `REVISION_CONFLICT`; old readVersion.name остаётся исходным; head.name новый; повтор одинакового revision не overwrite; отдельная публикация anchor с тем же UUID, что package, не разрешает package как anchor. После close/reopen обе версии и stateRevision сохранены.
- [ ] Написать `rolls_back_async_or_failed_transactions`: сохранить stateRevision, в transaction append revision2, затем throw → old head и revision, все projection rows неизменны. `transaction(()=>Promise.resolve('x'))` и собственный thenable возвращают `ASYNC_TRANSACTION_FORBIDDEN`; ни commit, ни фоновой записи. Отдельный async test возвращает Promise из обычной функции, который после microtask пытается append: write отвергается `TRANSACTION_CONTEXT_CLOSED`, old head остаётся. Вложенная sync transaction использует SAVEPOINT, не второй BEGIN; nested rollback не повреждает внешнюю транзакцию. Незавершённая ссылка разрешается только внутри той же transaction; dangling ref на commit → rollback всего графа.
- [ ] Написать `activates_confirmed_main_without_guessing_merge_time`: anchor confirmed/timeVerificationunknown/mainCommit заполнен/mergedAtnull + assignment с этим anchor → readPublishedHead возвращает assignment; unconfirmed revision3 не заменяет published revision2. `sqlForModule('jobs').execMigration('jobs-test-v1',...)` повторяется без потери строки; mutation через module SQL откатывается вместе с append, stateRevision не возрастает от чтения.

```ts
const graph=makeEntityGraph();seedGraph(repository,graph);
const metric=graph.input.metrics[0];
repository.append('metric_definition',{...metric,revision:2,name:'demo_v2'},1);
expect(repository.readVersion<MetricDefinition>({entityType:'metric_definition',
 id:metric.id,revision:1})?.name).toBe(metric.name);
expect(()=>repository.append('metric_definition',{...metric,revision:3},1))
 .toThrowError(expect.objectContaining({code:'REVISION_CONFLICT'}));
```

- [ ] RED: `npm test -- src/server/storage/workbench-repository.test.ts` → FAIL на отсутствии repository.
- [ ] Реализовать таблицы отдельно от legacy records: `wb_entity_versions(entity_type,id,revision,payload_json,recorded_at,publication_anchor_id,PRIMARY KEY(entity_type,id,revision))`, `wb_entity_heads(entity_type,id,revision,PRIMARY KEY(entity_type,id))`, `wb_meta(key,value)`, `wb_schema_migrations(id,applied_at)`, `wb_publication_anchors(id,revision,payload_json,publication_state,merged_at,PRIMARY KEY(id,revision))`, `wb_fact_index(entity_type,id,revision,source_id,metric_id,scope_kind,scope_id,business_kind,business_start,business_end,capture_id,fact_key)`, `wb_capture_index(id,revision,captured_at)`, `wb_applicability_index(id,revision,assignment_id,metric_id,start_date,end_date)`, `wb_correction_index(id,revision,fact_key)`.
- [ ] workbench-schema.ts экспортирует `migrateWorkbench(db:DatabaseSync):void`; transaction migration и user_version/собственная migration table не меняют legacy таблицы. Named indexes: `wb_fact_scope_time` на (source_id,metric_id,scope_kind,scope_id,business_kind,business_start,business_end), `wb_capture_time` на (captured_at,id), `wb_fact_key` на fact_key, `wb_applicability_assignment` на (assignment_id,metric_id,start_date), `wb_correction_fact_key` на fact_key, `wb_versions_anchor` на (publication_anchor_id,entity_type,id,revision). WAL + foreign_keys. Read candidates связывает только указанные scope/metric/source и business window; включает captures/inputFactRefs lineage выбранных фактов, не list всей истории. Corrections/N/A — только confirmed опубликованные редакции; latest source rows остаются локальными оперативными.
- [ ] append проверяет schema, exact next revision и expectedHead; references deferred до внешнего commit позволяют source↔goal граф. Capture — immutable получение: revision1, попытка revision2→`CAPTURE_IMMUTABLE`; новое реальное получение имеет новый Capture.id/operationId, старый fact.captureId никогда не начинает указывать на другую capturedAt/rawRows. Добавить этот assertion в repository test. BEGIN IMMEDIATE + обновление head/index/stateRevision атомарны; stateRevision возрастает один раз на изменившуюся внешнюю транзакцию (включая module SQL writes). registerProjection отвергает повтор имени; callbacks вызываются для staged Header entities после reference validation перед commit, в той же sync transaction; exception callback откатывает всё. AsyncFunction отклонять до вызова; Promise/thenable результата — до commit; AsyncLocalStorage из node:async_hooks хранит lease active на время sync action, и mutation из продолжения закрытого lease отвергается. Все исключения дают rollback. registerEntityType отвергает повтор имени; закрытие/обновление schema требует явного migration. ArtifactRoot хранится как разрешённый корень, пути из entity не исполняются.
- [ ] GREEN: повторить точный RED → PASS; `npm test -- tests/integration/snapshot-acceptance.test.ts tests/integration/goal-history.test.ts` → legacy PASS; `npm run build` → exit0.
- [ ] Commit:

```powershell
git add src/server/storage/workbench-schema.ts src/server/storage/workbench-repository.ts src/server/storage/workbench-repository.test.ts tests/fixtures/workbench/repository.ts
git commit -m "feat(workbench): add append-only CAS repository"
```

### T04. Exact conditions, normalization contracts and whitelist reducers

**Dependencies / AC:** T01–T02; AC-01–AC-04, AC-15, AC-22 (чистое сведение, без изменения source rows).
**Files:** Create `src/features/evaluation/workbench/conditions.ts`, `conditions.test.ts`, `reducers.ts`, `reducers.test.ts`.
**Consumes:** NumericCondition/Normalization/MetricDefinition/InputReducer/CanonicalSourceRow, arithmetic T01. **Produces:**

```ts
testCondition(value:ExactNumber,condition:NumericCondition):boolean;
normalizeMetric(value:ExactNumber|null,rule:MetricRule,metric:MetricDefinition):Rational|null;
type ReductionInput={reducer:InputReducer;rows:CanonicalSourceRow[];unitCode:string;
  assignmentRef:VersionRef;methodRef:VersionRef;metricRef:VersionRef};
type ReductionOutcome={value:ExactNumber|null;sourceRowKeys:string[];qualityFlags:string[]};
reduceRows(input:ReductionInput):ReductionOutcome;
```

- [ ] Написать `matches_exact_normalization_vectors`: gte100/x120 →120/1; gte90/x92→920/9; decrease lte10/M200 для x8→125/1, x5/x1/x0→200/1; zero_counter lte0 x0→100/1,x3→0/1,missing→null; eq1 для1→100,1.0001→0; range[1,2] для1/2→100,0.9999/2.0001→0, missing→null. TestCondition('99.995',gte100) false. Signed domain допустим только для binary eq/range; increase/decrease с отрицательным input отклоняются. `maxPercent='100'/'Infinity'`, неизвестный normalization, min>max и fractional zero_counter → schema/contract error, без fallback.
- [ ] Написать `reduces_unique_rows_and_preserves_missing`: строки A=2/B=3 + join-дубликат A дают sum5, count2; source_provided_value на двух разных rows → null + `ambiguous_source_value`; ratio rows (n1,d2),(n2,d4), multiplier100 →50/1 (ratio of sums), denominator0 → null + `zero_denominator`; один null-компонент → null + `missing_reducer_component`; одна строка unithours при ожидаемом percent → null + `incompatible_units`; повтор rowKey с отличным numbers → null + `conflicting_row_key`. Проверить input deep-equal clone после reducer.

```ts
const i=makeNumericFixture();
if(i.method.mode!=='numeric') throw new Error('fixture must be numeric');
const rule=i.method.rules[0],metric=i.metrics[0];
expect(normalizeMetric('92',{...rule,condition:{op:'gte',target:'90'}},metric))
 .toEqual({numerator:'920',denominator:'9'});
expect(normalizeMetric(null,rule,metric)).toBeNull();
expect(testCondition('99.995',{op:'gte',target:'100'})).toBe(false);
```

- [ ] RED: `npm test -- src/features/evaluation/workbench/conditions.test.ts src/features/evaluation/workbench/reducers.test.ts` → FAIL на отсутствующих функциях.
- [ ] Реализовать signatures. normalizeMetric проверяет домен и совместимость normalization/condition; reducer сначала дедуплицирует rowKey, совпадающие исходные строки учитывает один раз. count считает уникальные принятые rows, не join-объекты; source_provided_value требует одну подходящую строку. Неизвестный reducer бросает `UNSUPPORTED_REDUCER` с assignmentRef/methodRef/metricRef в details. Outcomes с missing/unit/conflict не дают частичного числового value; сохранить sourceRowKeys отсортированными.
- [ ] GREEN: повторить точную RED-команду → PASS; `npm run build` → exit0.
- [ ] Commit:

```powershell
git add src/features/evaluation/workbench/conditions.ts src/features/evaluation/workbench/conditions.test.ts src/features/evaluation/workbench/reducers.ts src/features/evaluation/workbench/reducers.test.ts
git commit -m "feat(workbench): implement exact conditions and reducers"
```

### T05. Fact selection, explicit time, freshness and expected population

**Dependencies / AC:** T01–T04; AC-06–AC-08, AC-15–AC-16, AC-25; 16 §14.2/14/15.
**Files:** Create `src/features/evaluation/workbench/selection-contracts.ts`, `select-facts.ts`, `select-facts.test.ts`.
**Consumes:** EvaluationInput, captures with capturedAt, metrics with domain/unit; reduceRows T04. **Produces:**

```ts
type SelectedMetric={metricRef:VersionRef;applicable:boolean;value:ExactNumber|null;
  factRefs:VersionRef[];correctionRefs:VersionRef[];applicabilityRefs:VersionRef[];
  missingPopulation:Array<{metricId:UUIDv4;scope:ScopeRef}>;
  freshness:'fresh'|'stale'|'unknown';qualityFlags:string[]};
type FactSelection={metrics:SelectedMetric[];factRefs:VersionRef[];
  correctionRefs:VersionRef[];applicabilityRefs:VersionRef[];
  missingMetricIds:UUIDv4[];missingPopulation:Array<{metricId:UUIDv4;scope:ScopeRef}>;
  complete:boolean;freshness:'fresh'|'stale'|'unknown';qualityFlags:string[]};
selectEvaluationFacts(input:EvaluationInput):FactSelection;
factFreshness(input:{fact:ObservedFact;rule:MetricRule;evaluatedAt:UtcInstant}):{
  freshness:'fresh'|'stale'|'unknown';qualityFlags:string[]};
```

- [ ] Написать `selects_as_of_and_exact_period`: fact datedOct22 capturedOct23T09 included for as_ofOct23/evaluatedAt12Z; same date capturedOct24 excluded; datedOct24 excluded; fact capturedOct23T21Z исключён концом МСК даже если evaluatedAtOct25. Для запроса period[Oct1,Nov1) принимается только точное совпадение; [Oct1,Oct20), [Oct15,Nov15), соседнийNov1–Dec1 и unknown не подходят. mismatch goal.measurementMode/context → `MEASUREMENT_MODE_MISMATCH`.
- [ ] Написать `does_not_guess_ties_or_population`: expectedPopulation A/B, строки толькоA → missingPopulation[{metricId,scope:B}], metric.value null, completefalse; добавленный в directory teamC не меняет expectedPopulation. Новая корректная строкаB даёт complete true без вечного partial-флага старой Capture. Два разных факта с равными businessDate/capturedAt и разными value → null + `ambiguous_fact_selection` при обоих порядках массива; одинаковый VersionRef не удваивается; две команды с lineage на тот же продуктовый fact не удваивают продукт.
- [ ] Написать `uses_business_freshness_not_capture_or_correction_clock`: sourceUpdatedAtOct22T12Z, evaluatedAtOct23T12Z, maxAge24 →fresh; evaluatedAtOct23T12:00:00.001Z→stale. sourceUpdatedAtnull/as_ofOct23 якорь Oct22T21Z; period endExclusiveOct24 якорьOct23T20:59:59.999Z. Будущий sourceUpdatedAt →unknown+`future_freshness_anchor`; unknown business/sourceUpdatedAtnull →unknown, capturedAtсегодня не помогает. Принятая correction replacement12 для factKeyK вместо10 сохраняет freshness anchor; новый source11 с тем жеK не стирает12 и добавляет `correction_source_discrepancy`; другой period/key не получает correction.
- [ ] Написать `expires_na_without_removing_original_weights`: N/A assignment+metric+period действует только при покрытии всей businessTime запроса (as_of — дата внутри [start,end), period — весь диапазон); endExclusiveOct24 не исключает as_ofOct24; при пересечении лишь части period — `partial_applicability_period`, вход blocked, автоматического разбиения периода нет. Missing не создаёт N/A; чужое assignmentId игнорируется; reason пустой отвергает schema.

```ts
const A:ScopeRef={kind:'product',id:fixtureId(101)};
const B:ScopeRef={kind:'product',id:fixtureId(102)};
const i=makeNumericFixture({expectedPopulation:[A,B],observedPopulation:[A]});
const selected=selectEvaluationFacts(i);
expect(selected.missingPopulation).toEqual([{metricId:i.metrics[0].id,scope:B}]);
expect(selected.metrics[0].value).toBeNull();
expect(selected.complete).toBe(false);
```

- [ ] RED: `npm test -- src/features/evaluation/workbench/select-facts.test.ts` → FAIL на отсутствии exports.
- [ ] Реализовать exact signatures. Для as_of сначала eligible cutoff `capturedAt<=min(evaluatedAt,moscowEnd(date))`, потом максимальная businessDate, затем максимальный capturedAt; неоднозначный tie не разрешать id-sort. Period — exact interval/captured cutoff. По каждому rule сверить **весь** explicit population до reducer; частичный aggregate не выдаёт known metric. Lineage inputFactRefs раскрывается с проверкой scope/unit и посещённых refs; цикл/недостающий ref блокирует. Reducer читает только CanonicalSourceRow по lineage.sourceRowKeys выбранных Capture; RawCell.original не меняется. Корректировки применяются только после точного factKey/time match, anchor подтверждён resolver, оригиналы остаются в factRefs. Freshness aggregate: stale при любом известном stale, иначе unknown при unknown/missing, иначе fresh; N/A не портит актуальность применимых.
- [ ] GREEN: повторить точную RED-команду → PASS; `npm run build` → exit0.
- [ ] Commit:

```powershell
git add src/features/evaluation/workbench/selection-contracts.ts src/features/evaluation/workbench/select-facts.ts src/features/evaluation/workbench/select-facts.test.ts
git commit -m "feat(workbench): select complete facts with explicit time"
```

### T06. Numeric evaluator: weighted N/A, preliminary score and independent mandatory gate

**Dependencies / AC:** T01–T05; AC-01–AC-09, AC-15–AC-16.
**Files:** Create `src/features/evaluation/workbench/evaluate.ts`, `evaluate.test.ts`.
**Consumes:** selectEvaluationFacts, normalizeMetric/testCondition and exact arithmetic. **Produces:** `evaluateAssignment(input:EvaluationInput):NumericEvaluation`; output basisRef=`input.resolution.basisRef`; отсутствие DB/clock/network/import UI.

- [ ] Написать `keeps_scope_results_independent`: отдельные fixtures ДИТ fact92,target90 и cluster fact88,target95 → met/not_met; source numeric facts остаются92/88. `known_mandatory_failure_overrides_score` fixture values80/100, weights20/80, mandatorytrue/false, scoreTarget95 → score96/1, coverage100/1, completetrue, achievementnot_met, canConfirmfalse.
- [ ] Написать `renormalizes_na_and_keeps_partial_score_separate`: weights60/20/20, values100/100/null, третий N/A →score100,coverage100,completetrue; input originalWeight остаются60/20/20. Все N/A → calculation/achievementnot_applicable, score/preliminary/coveragenull, canConfirmfalse. values80/null,weights50/50 → score null,preliminary80/1,coverage50/1,completefalse,achievementunknown. values80/null,weights100/0 → coverage100/1,но score null,completefalse,canConfirmfalse. known mandatory80 + missing other → achievementnot_met независимо от preliminary.
- [ ] Написать `never_turns_absent_or_zero_weight_into_success`: все known отсутствуют →no_data, preliminarynull; после N/A применимы только rules с weight0 →blocked + `zero_applicable_weight`; stale known score100 сохраняет score100,complete true,canConfirmfalse; unknown freshness аналогично; неполный expectedPopulation блокирует соответствующий metric и score. Unsupported formula →blocked + `unsupported_formula`; отсутствие versionRef/metric unit →blocked, не default100.

```ts
const result=evaluateAssignment(makeNumericFixture({values:['80','100'],
 weights:['20','80'],mandatory:[true,false],scoreTarget:'95'}));
expect(result).toMatchObject({scorePercent:{numerator:'96',denominator:'1'},
 coveragePercent:{numerator:'100',denominator:'1'},complete:true,
 achievement:'not_met',canConfirm:false});
const partial=evaluateAssignment(makeNumericFixture({values:['80',null],weights:['50','50']}));
expect(partial.scorePercent).toBeNull();
expect(partial.preliminaryPercent).toEqual({numerator:'80',denominator:'1'});
```

- [ ] RED: `npm test -- src/features/evaluation/workbench/evaluate.test.ts` → FAIL на отсутствующем evaluator.
- [ ] Реализовать signature. Для A применимых rules/K известных полных metric: score=ΣA(wr)/ΣA(w) только при всех A; P=ΣK(wr)/ΣK(w), C=100ΣK(w)/ΣA(w), null при нулевом знаменателе. Пропущенный нулевой вес всё равно неполнота. Известный mandatory fail →not_met; иначе incomplete→unknown; complete требует mandatory-success и явного scoreCondition. canConfirm true только met+complete+fresh+без blocking flags. Вернуть сортированные уникальные missingMetricIds/missingPopulation/qualityFlags; значения и refs input не изменять.
- [ ] GREEN: точная RED-команда →PASS; `npm test -- src/features/evaluation/evaluate.test.ts src/features/evaluation/measurement.test.ts` →legacy PASS; `npm run build` →exit0.
- [ ] Commit:

```powershell
git add src/features/evaluation/workbench/evaluate.ts src/features/evaluation/workbench/evaluate.test.ts
git commit -m "feat(workbench): evaluate weighted goals without lossy numbers"
```

### T07. Basis materialization, exact method resolution, manual/correction/attestation/snapshot rules

**Dependencies / AC:** T01–T06; AC-08–AC-12, AC-16, AC-25, AC-30, AC-34, AC-53, AC-55.
**Files:** Create `src/features/evaluation/workbench/basis.ts`, `resolve-input.ts`, `prepare-evaluation.ts`, `state-rules.ts`, `quality.ts`, `basis.test.ts`, `state-rules.test.ts`; Modify `src/server/storage/workbench-repository.ts`, `workbench-schema.ts` для idempotent materialization lookup; Test existing `workbench-repository.test.ts` добавить rollback index.
**Consumes:** K01, Clock, EvaluationInput, pure evaluator, schemas. **Produces:**

```ts
type BasisContent=Pick<EvaluationBasis,'assignmentRef'|'goalRef'|'methodRef'|'templateRef'|
 'businessTime'|'expectedPopulation'|'factRefs'|'correctionRefs'|'applicabilityRefs'|'directoryLinkRefs'>;
canonicalBasis(input:EvaluationInput):BasisContent;
digestBasis(content:BasisContent):Sha256;
resolveEvaluationInput(request:PrepareEvaluationRequest,repository:WorkbenchRepository,clock:Clock,actor:ActorRef):EvaluationInput;
prepareEvaluation(input:EvaluationInput,repository:WorkbenchRepository):{basisRef:VersionRef;resultRef:VersionRef|null};
projectEvaluationQuality(stored:NumericEvaluation,input:EvaluationInput):NumericEvaluation;
validateManualTransition(previous:ManualStatusEvent|null,next:ManualStatusEvent):void;
validateCorrection(correction:ManualCorrection,originals:ObservedFact[]):void;
validateAttestation(input:{basis:EvaluationBasis;result:NumericEvaluation;attestation:Attestation}):void;
validateAgreedSnapshot(input:{snapshot:AgreedSnapshot;basis:EvaluationBasis;
 result:CalculationResult|null;manualStatus:ManualStatusEvent|null;attestation:Attestation|null}):void;
// added repository method, backed by unique wb_evaluation_digest index:
findEvaluationByDigest(digest:Sha256):{basisRef:VersionRef;resultRef:VersionRef|null}|null;
```

- [ ] Написать `canonicalizes_semantics_and_reuses_materialized_refs`: seedGraph fixture; resolve/prepare дважды →same basisRef/resultRef,stateRevision не меняется вторично; shuffled factRefs/object keys и Decimal source formatting canonicalized до source schema не меняют digest; новая fact revision/method revision/population меняют digest. После искусственной ошибки append CalculationResult не остаётся ни basis, ни digest-index. Counts Capture/ObservedFact/Attestation/AgreedSnapshot не растут от prepare. Переданный viewer actor `{hostname:'demo-reader',installationId:fixtureId(2),profilePersonId:null}` сохраняется в новом Header; это не actor куратора назначения.
- [ ] Написать `resolves_template_and_standalone_without_retroactivity`: linked assignment после confirmed Template revision2 использует её methodRef; standalone сохраняет точную methodRef1. Unconfirmed Template3 не активируется; confirmed anchor unknown mergedAt активирует Template2 без guessed date. Старый basis хранит templateRef1/methodRef1/linkRefs1 и читается после публикации link2. Missing method ref→`BROKEN_REFERENCE`, не latest fallback. Точный wall-clock resolver, добавляемый T09, будет иметь отдельный режим; обычный prepare/current timestamp merge не требует.
- [ ] Написать `reuses_basis_while_projecting_current_quality`: fixedClock Oct23T12Z даёт fresh/met/canConfirmtrue; с теми же facts clockOct31T12Z prepare возвращает прежние refs без новой entity; `projectEvaluationQuality(stored,laterInput)` сохраняет score/basisRef, freshnessstale/canConfirmfalse. stored JSON и сохранённый agreed JSON не меняются. validateAttestation получает projected result и отвергает позднюю попытку `CONFIRMATION_NOT_ALLOWED`; простой комментарий или работаcompleted не меняют этот gate.
- [ ] Написать `requires_manual_result_and_preserves_previous_completion`: nextcompleted c resultDescriptionnull→error; с непустым результатом/evidenceIds[]→успех; completed→in_progress reasonnull→error; с причиной→успех, previous.resultDescription неизменен. manual goal prepare→resultRefnull, без numeric score/N/A. validateCorrection replacement12 сохраняет original refs/time; пустая reason/несовпавшие factKey/разные periods→error; последующий source11 не стирает correction12 (T05).
- [ ] Написать `pins_attestation_and_snapshot_to_exact_basis`: пустой comment→error; evidence может быть[] при непустом comment (не наследовать legacy минимум10). attestation.basisDigest≠basis.digest→`BASIS_MISMATCH`; result.canConfirmfalse→`CONFIRMATION_NOT_ALLOWED`. Snapshot numericResult XOR manualStatusRef; оба/ниодного→error; result.basisRef другойrevision→error; manualStatus.assignmentId другой→error; attestationRefnull допустим и не создаёт Attestation. Существующий attestation с точным digest допускается; новый result basis не наследует его.

```ts
const graph=makeEntityGraph();seedGraph(repository,graph);
const first=prepareEvaluation(graph.input,repository);
const before=repository.getStateRevision();
const later={...graph.input,context:{...graph.input.context,evaluatedAt:'2026-10-31T12:00:00Z'}};
expect(prepareEvaluation(later,repository)).toEqual(first);
expect(repository.getStateRevision()).toBe(before);
const stored=repository.readVersion<CalculationResult>(first.resultRef!);
if(!stored) throw new Error('missing stored result');
expect(projectEvaluationQuality(stored,later)).toMatchObject({
 freshness:'stale',canConfirm:false,scorePercent:stored.scorePercent,basisRef:stored.basisRef});
```

- [ ] RED: `npm test -- src/features/evaluation/workbench/basis.test.ts src/features/evaluation/workbench/state-rules.test.ts src/server/storage/workbench-repository.test.ts` →FAIL на отсутствии exports/lookup.
- [ ] Реализовать resolver: clock.now ровно один раз; readVersion assignment, подтверждение current-anchor; exact goal/method/metric revisions; template через readPublishedHead, standalone exact; readEvaluationCandidates с explicit population/metric/source/time; directory refs из проверенной lineage, refs упорядочены entityType/id/revision. Не брать текущую mutable org при воспроизведении basis. REQUIRED resolution.actor передаётся четвёртым параметром от CommandContext.actor (реальные серверные hostname+installationId+own-registry personId|null); basis/result Header использует его. Не копировать автора назначения и не доверять actor тела HTTP. Повторная материализация другим actor возвращает прежние immutable refs/авторство, command audit фиксирует новый вызов отдельно.
- [ ] Реализовать canonicalBasis/digest/prepare. **Уточнение идемпотентности:** digest исключает Header, собственный digest и evaluatedAt; включает businessTime, выбранные refs и expectedPopulation. Это предотвращает новые записи от каждого poll/открытия; EvaluationBasis сохраняет evaluatedAt первого materialization, result — quality на то время. Canonical JSON сортирует ключи и set refs; Decimal/Rational canonical, SHA-256 prefix. Поля часов не используются для генерации нового measurement. Перед append в одной transaction повторить digest lookup; сохранить basis+result+`wb_evaluation_digest(digest UNIQUE,basis_id,basis_revision,result_id,result_revision)` атомарно. При совпадении вернуть сохранённые refs; первоначальный resolution.basisRef заменить существующим при оценке/возврате.
- [ ] Реализовать projectEvaluationQuality как чистое пересчитывание freshness/canConfirm и относящихся к текущей давности flags; **не** менять score/preliminary/coverage/achievement/complete/basisRef. Query текущих данных и будущий result.confirm обязаны снова вызвать projection с серверными часами; agreed возвращает сохранённый результат без projection. State-rules проверяет семантику, не выполняет append/publish/role checks; owning command вызывает её внутри CAS transaction. ManualStatusEvent сохраняется отдельным immutable событием, не overwrite предыдущего.
- [ ] GREEN: повторить RED →PASS; `npm run build` →exit0. Не подключать новый путь к legacy app до T39.
- [ ] Commit:

```powershell
git add src/features/evaluation/workbench/basis.ts src/features/evaluation/workbench/resolve-input.ts src/features/evaluation/workbench/prepare-evaluation.ts src/features/evaluation/workbench/state-rules.ts src/features/evaluation/workbench/quality.ts src/features/evaluation/workbench/basis.test.ts src/features/evaluation/workbench/state-rules.test.ts src/server/storage/workbench-repository.ts src/server/storage/workbench-schema.ts src/server/storage/workbench-repository.test.ts
git commit -m "feat(workbench): materialize immutable bases and confirmation rules"
```

### T08. Friday projection with original provenance and no invented measurement

**Dependencies / AC:** T01–T02, T05; AC-13, AC-15, 16 §12/14.9.
**Files:** Create `src/features/evaluation/workbench/friday.ts`, `friday.test.ts`.
**Consumes:** WeeklyPoint, exact Fact/Capture versions and explicit server evaluatedAt. **Produces:**

```ts
type FridaySeriesInput={assignmentRef:VersionRef;metricRef:VersionRef;scope:ScopeRef;
 facts:ObservedFact[];captures:Capture[];fromInclusive:MoscowDate;toExclusive:MoscowDate;
 evaluatedAt:UtcInstant};
projectFridaySeries(input:FridaySeriesInput):WeeklyPoint[];
```

- [ ] Написать `carries_thursday_without_creating_friday_fact`: rangeOct16–Oct31; нет раннего fact→Oct16 point.value/ref/time null,carriedfalse. ThursdayOct22 value92 capturedOct22T12Z→Oct23 value92,sourceBusinessTime as_ofOct22,sourceCapturedAt исходный,carriedtrue,warning`Данные не обновлялись`; Oct30 всё ещё92/dateOct22. deepEqual input before/after; spy Date.now throws, функция всё равно работает.
- [ ] Написать `keeps_flat_values_and_excludes_future_capture`: реальные FridayOct9/Oct16 facts85 с отдельными captures→оба value85,carriedfalse,warningnull; FridayOct23 fact92 capturedOct24 исключён дляOct23, известный85 перенесён; fact capturedOct23T21Z (после конца МСК) исключён. Отсутствующая пятница не добавляется к input.facts. Unknown sourceBusinessTime остаётся unknown в provenance, никогда не превращается в friday; по нему нельзя давать freshness/confirmation.
- [ ] Написать `reports_ambiguous_series_instead_of_converting_units`: две подходящие строки с разными единицами или одинаковым max business/captured key, но разными value→`INCOMPATIBLE_SERIES_UNITS`/`AMBIGUOUS_FACT_SELECTION`. Period измерение допускается только как исходный целый завершённый period (endExclusive≤следующий деньFriday); period не распределяется по дням. Friday coordinate генерируется календарём МСК, range endExclusive не включается.

```ts
const i=makeNumericFixture({values:['92']});
i.facts[0].businessTime={kind:'as_of',date:'2026-10-22'};
i.captures[0].capturedAt='2026-10-22T12:00:00Z';
const points=projectFridaySeries({assignmentRef:{entityType:'goal_assignment',
 id:i.assignment.id,revision:i.assignment.revision},metricRef:{entityType:'metric_definition',
 id:i.metrics[0].id,revision:i.metrics[0].revision},scope:i.assignment.scope,
 facts:i.facts,captures:i.captures,fromInclusive:'2026-10-23',toExclusive:'2026-10-24',
 evaluatedAt:i.context.evaluatedAt});
expect(points[0]).toMatchObject({friday:'2026-10-23',value:'92',carried:true,
 sourceBusinessTime:{kind:'as_of',date:'2026-10-22'},warning:'Данные не обновлялись'});
```

- [ ] RED: `npm test -- src/features/evaluation/workbench/friday.test.ts` →FAIL на отсутствии projection.
- [ ] Реализовать signature: перечислить пятницы range, cutoff=min(evaluatedAt,moscowEnd(friday)); отфильтровать source scope/metric и future businessTime/capture. Для известных as_of выбрать последнюю businessDate, затем capturedAt; unknown сохраняется как отдельный source provenance, пригодный лишь для показа по последнему допустимому capture. carried=false только если исходная business date — этаFriday; для period — последний календарный день периода этаFriday; unknown всегда carriedtrue. Не вызывать evaluator/freshness/DB/команды, не обновлять дату источника; новая загрузка старого периода не притворяется новым измерением.
- [ ] GREEN: точная RED-команда→PASS; `npm run build`→exit0.
- [ ] Commit:

```powershell
git add src/features/evaluation/workbench/friday.ts src/features/evaluation/workbench/friday.test.ts
git commit -m "feat(workbench): project Friday series with retained source dates"
```

### T09. Indexed history queries and immutable agreed retention

**Dependencies / AC:** T01–T03, T07–T08; AC-08–AC-09, AC-12–AC-15, AC-24, AC-29, AC-51, AC-53.
**Files:** Create `src/features/history/workbench-history-contracts.ts`, `workbench-history-index.ts`, `workbench-history.ts`, `workbench-history.test.ts`; Modify `src/server/storage/workbench-repository.ts`, `workbench-schema.ts` для transactionally maintained history index. Existing legacy history files не менять.
**Consumes:** exact basis/readVersion, Friday projection, WorkbenchSql. **Produces:**

```ts
type HistorySeriesInput={assignmentRef:VersionRef;metricRef:VersionRef;
 mode:'current'|'agreed';snapshotRef:VersionRef|null;granularity:'day'|'friday';
 fromInclusive:MoscowDate;toExclusive:MoscowDate;evaluatedAt:UtcInstant;
 effectiveAt:UtcInstant|null;cursor:string|null;limit:number};
type DailyPoint={assignmentId:UUIDv4;metricId:UUIDv4;date:MoscowDate;
 value:ExactNumber|null;sourceFactRef:VersionRef|null;sourceBusinessTime:BusinessTime|null;
 sourceCapturedAt:UtcInstant|null};
type PeriodHistoryPoint={assignmentId:UUIDv4;metricId:UUIDv4;businessTime:BusinessTime;
 value:ExactNumber|null;sourceFactRef:VersionRef;sourceCapturedAt:UtcInstant};
type HistorySeries={mode:'current'|'agreed';basisRef:VersionRef|null;
 points:Array<DailyPoint|WeeklyPoint|PeriodHistoryPoint>;nextCursor:string|null;qualityFlags:string[]};
queryHistorySeries(input:HistorySeriesInput,repository:WorkbenchRepository):HistorySeries;
installHistoryIndex(repository:WorkbenchRepository):void;
type HistoryIndexQuery={assignmentRef:VersionRef;metricRef:VersionRef;scope:ScopeRef;
 fromInclusive:MoscowDate;toExclusive:MoscowDate;capturedBefore:UtcInstant;
 cursor:string|null;limit:number};
type HistoryIndexPage={facts:ObservedFact[];captures:Capture[];nextCursor:string|null};
// added repository methods:
readHistoryRecords(query:HistoryIndexQuery):HistoryIndexPage;
// history index writer, called synchronously by repository append hook:
indexHistoryVersion(sql:WorkbenchSql,entityType:string,value:Header,
 context:{capture:Capture|null;basis:EvaluationBasis|null}):void;
```

- [ ] Написать `retains_history_and_frozen_agreed_basis`: заменить default facts графа на3 001 синтетических observations с разными UUID и business dates `addMoscowDays('2018-01-01',i)` для i0..3000, отдельными Capture и fixed capturedAt=moscowStart(businessDate); seedGraph одной transaction. Сохранить agreed snapshot на старом basis, затем новые method/directory link, archive goal и reopen repository. Day query range2018-01-01–2026-10-24 с pagination до nextCursornull возвращает среди ненулевых sourceFactRef все3 001 refs ровно один раз; нет cap300/2 000/годового удаления. Agreed query возвращает старые method/link/fact refs, numericResult и digest byte-for-byte; current может другойbasis. Несуществующее старое основание →`HISTORICAL_BASIS_UNAVAILABLE`, текущим каталогом не восстанавливать.
- [ ] Написать `uses_index_and_preserves_daily_gaps`: factsOct22=92,Oct24=93, day rangeOct22–Oct25 → Oct22value92,Oct23null,Oct24value93; fridayOct23→92 carriedtrue с исходнымOct22. `EXPLAIN QUERY PLAN` статического SELECT содержит `wb_history_scope_time`, не `SCAN wb_entity_versions`; индекс поддерживается той же transaction, отказ append не оставляет индексную строку. Query не меняет stateRevision/число rows. Для period возвращаются целые PeriodHistoryPoint с исходными границами, не вымышленные DailyPoint по дням внутри периода.
- [ ] Написать `separates_current_publication_from_wall_clock_history`: effectiveAtnull, confirmed anchorunknown →current/readVersion/agreed доступны. effectiveAt задан и нужный anchorunknown→`EFFECTIVE_TIME_UNVERIFIED`; unconfirmed не активируется. Не подставлять authorDate/pull/appliedAt. Query modeagreed без snapshotRef→validation error; snapshot другойassignment/metricrevision→`BASIS_MISMATCH`; курсор другого фильтра→`INVALID_CURSOR`.

```ts
// history — результат day query для двух явно описанных выше фактов Oct22/Oct24.
expect(history.points).toEqual([
 expect.objectContaining({date:'2026-10-22',value:'92'}),
 expect.objectContaining({date:'2026-10-23',value:null,sourceFactRef:null}),
 expect.objectContaining({date:'2026-10-24',value:'93'}),
]);
expect(repository.getStateRevision()).toBe(revisionBeforeQuery);
expect(indexPlan.some(row=>row.detail.includes('wb_history_scope_time'))).toBe(true);
expect(indexPlan.some(row=>row.detail.includes('SCAN wb_entity_versions'))).toBe(false);
```

- [ ] RED: `npm test -- src/features/history/workbench-history.test.ts` →FAIL на отсутствующем query/index port.
- [ ] Реализовать contracts/signatures. installHistoryIndex через sqlForModule('history').execMigration создаёт `wb_history_observations(id,revision,source_id,metric_id,scope_kind,scope_id,business_start,business_end,captured_at,payload_ref)` с `wb_history_scope_time` на `(source_id,metric_id,scope_kind,scope_id,business_start,captured_at,id,revision)` и `wb_history_snapshots(id,revision,assignment_id,business_start,basis_id,basis_revision)` с `wb_snapshot_assignment_time` на `(assignment_id,business_start,id,revision)`, затем repository.registerProjection('history',callback). Application T13 вызывает installHistoryIndex один раз до загрузки модулей; tests перед seedGraph. Projection stores refs, не переписывает values. ObservedFact не имеет assignmentId/capturedAt: callback читает точную Capture через repository и передаёт в context; snapshot получает assignmentId через context.basis.assignmentRef. Hook вызывается после deferred reference validation перед commit, включая staged captures/bases; не выводить assignment из текущей org. Необработанный entityType ничего не индексирует. Backfill идемпотентно обходит существующие immutable rows один раз в storage migration (repository владеет чтением wb_entity_versions), online query никогда так не делает. SQL module `'history'` обслуживает только `wb_history_*` tables; immutable entities записывает repository.
- [ ] Read model проверяет metricRef в методике выбранной assignment/basis и все exact refs. В current raw series basisRef=null: история читает факты указанной assignment.scope/goal.sourceId и metricRef, не материализует новую основу; числовой current-query adapter отдельно использует T07 quality projection. Agreed берёт только snapshot.basisRef/numericResult/manualStatusRef и exact refs. Friday вызывает T08; day показывает исходные пропуски, period сохраняет целые периоды. Friday page включает один predecessor fact до fromInclusive, чтобы перенос через границу страницы не исчезал; predecessor не возвращается повторно как новое observation. Limit1..500 — размер страницы, не lifetime cap; cursor кодирует полный filter fingerprint+последний стабильный businessTime/capturedAt/id/revision; prepared bound SQL, без произвольного sort/SQL от UI. Запрос source_id получает из точного goalRef сохранённого basis для agreed, опубликованного определения выбранной assignment для current.
- [ ] GREEN: точная RED-команда→PASS; `npm test -- src/server/storage/workbench-repository.test.ts src/features/evaluation/workbench/basis.test.ts tests/integration/goal-history.test.ts`→PASS; `npm run build`→exit0. Нагрузочный замер p95/2 000 rows оформляет поздняя delivery задача; этот тест не объявлять банковским benchmark.
- [ ] Commit:

```powershell
git add src/features/history/workbench-history-contracts.ts src/features/history/workbench-history-index.ts src/features/history/workbench-history.ts src/features/history/workbench-history.test.ts src/server/storage/workbench-repository.ts src/server/storage/workbench-schema.ts
git commit -m "feat(workbench): retain indexed history and frozen agreed snapshots"
```

## Handoff to the next plan

- T10–T13 import primitive Clock, K01 repository and domain types; register owning schemas/SQL migrations against the same SQLite transaction. Не дублировать HTTP или entity store.
- `calculation.prepare` handler: resolveEvaluationInput(payload,repository,clock,context.actor) → prepareEvaluation; input/result schemas17; browser fields actor/basisDigest/evaluatedAt не доверяются. `result.confirm` требует fresh projection T07 непосредственно перед validateAttestation и CAS write; `snapshot.save` требует validateAgreedSnapshot, сам не создаёт Attestation. Ручное завершение проверяет validateManualTransition и сохраняет отдельное событие.
- Источники/обогащение создают реальные Capture/ObservedFact через append; умеют reduceRows и lineage, передают capturedAt отдельно. Синтетические fixture не становятся производственным seed. Publication adapters используют отдельный PublicationAnchor port и никогда не добавляют выдуманные Header-поля в wire18.
- History query adapter преобразует context17/filter.metricRef/granularity/page в HistorySeriesInput, сервер задаёт evaluatedAt; effectiveAt используется только при реальном запросе точной исторической границы. На agreed не накладывать текущую freshness.
- ВсеAC выше покрывают только указанную часть инварианта; роли/HTTP/PR/реальная миграция/BP и UI подтверждаются поздними задачами главного плана. T01–T09 не означают, что новый продукт подключён или банковские проверки пройдены.
