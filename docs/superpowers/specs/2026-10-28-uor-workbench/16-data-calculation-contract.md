# Проект контракта данных и расчётов
Дата: 28.10.2026. Статус: нормативный проект целевой модели для последующих спецификаций; это не код продукта и не план его изменения.
Основания: [решения D-001–D-125](05-decisions.md), [модель](13-domain-model.md), [примеры](14-acceptance-examples.md).
Связанные контракты: [интерфейс/API](17-interface-api-contract.md), [источники, публикация и операции](18-integration-operations-contract.md), [приёмка](19-acceptance-delivery-contract.md). Их окончательные имена сверяются при сборке пакета.
Слово «должен» задаёт проверяемое свойство проекта. Подтверждённый смысл и предлагаемый способ его реализации различаются ниже.
## 1. Подтверждённые основания
- Области ДИТ, кластера и команды имеют собственные требования; продукт — основной аналитический срез, команды необязательны (D-021–D-030, D-092–D-093).
- Куратор настраивает показатели, условия, обязательность, веса и формулу; высокий балл не компенсирует провал обязательного показателя (D-023–D-029).
- Нет данных, неприменимость, устаревание, результат расчёта и подтверждение имеют разный смысл; исходный факт не подменяется процентом выполнения.
- Источник цели: ОКО, файл при отсутствии настроенного ОКО либо ручной статус; резерв прямого получения — локальный успешный набор, затем опубликованный Git (D-068, D-074).
- История бессрочная; общая история и согласованный срез различимы; непрерывная карта и архивирование не стирают прошлое (D-104–D-116).
- Пятничная проекция переносит последнее известное значение с исходной датой и предупреждением, сохраняя исходные пропуски (D-119, D-124).
- Новые назначения и изменения оргсвязей действуют с публикации в main, без выбора даты и ретроактивного переназначения; согласованные основания неизменяемы (D-125).
- Имя и режим определяются hostname-профилем без привязки к аккаунту Bitbucket; авторизация и аудит сетевых действий независимы (D-120–D-123).
## 2. Технические выборы этого проекта
Это предложения проектировщика для реализации принятых требований, а не дополнительные решения пользователя.
- UUIDv4 создаётся через crypto.randomUUID(); внутренний ID не зависит от имени, внешнего ключа, hostname или пути файла.
- У сущности устойчивый ID и возрастающая целая revision; опубликованная прежняя редакция не перезаписывается.
- Входные Decimal передаются каноническими строками; вычисленные отношения сохраняются точными рациональными числами.
- Расчёт не округляет входы, пороги и промежуточные результаты. Предлагаемое отображение — до 2 знаков после запятой, half-up; сравнение выполняется до него.
- Время события — UTC ISO 8601 с Z; календарная дата — YYYY-MM-DD в Europe/Moscow. Дата измерения не выводится из времени импорта.
- Для диапазона и равенства текущий контракт сравнивает точно переданные Decimal; бизнес-допуск не изобретается. Метод с особой погрешностью получает отдельный проверенный контракт по D-088.
- Предлагаемый whitelist подготовки числового входа: source_provided_value, sum, count, ratio; куратор выбирает явное правило, не универсальный язык формул.
- Перечисленные нормирования и weighted_mean_v1 описаны полностью; неизвестная формула не заменяется средним или нулём. Расширение подключается с версией и эталоном.
## 3. Общие типы
~~~ts
type UUIDv4 = string; // валидный UUID версии 4; пример не равен реальному ID банка
type PositiveInt = number; // целое >= 1, в безопасном диапазоне JSON integer
type Decimal = string; // конечное десятичное число: без экспоненты, +, -0 и лишних нулей
type IntString = string; // десятичное целое, без ведущих нулей кроме "0"
type Rational = { numerator: IntString; denominator: IntString }; // denominator > 0, дробь сокращена
type ExactNumber = Decimal | Rational; // исходный Decimal либо точно вычисленное отношение
type UtcInstant = string; // YYYY-MM-DDTHH:mm:ss[.sss]Z
type MoscowDate = string; // существующая календарная YYYY-MM-DD, не UTC timestamp
type Sha256 = string; // "sha256:" + 64 hex; правила хеширования см. раздел 11
type EntityRef = { entityType: string; id: UUIDv4 };
type VersionRef = EntityRef & { revision: PositiveInt };
type ScopeRef = { kind: "dit" | "cluster" | "product" | "team"; id: UUIDv4 };
type ActorRef = { hostname: string; installationId: UUIDv4; profilePersonId: UUIDv4 | null };
type Header = {
  schemaVersion: 1; id: UUIDv4; revision: PositiveInt;
  recordedAt: UtcInstant; actor: ActorRef; publicationAnchorId: UUIDv4 | null;
};
type BusinessTime =
  | { kind: "as_of"; date: MoscowDate }
  | { kind: "period"; startInclusive: MoscowDate; endExclusive: MoscowDate }
  | { kind: "unknown" };
type DateRange = { startInclusive: MoscowDate; endExclusive: MoscowDate | null };
type EvaluationContext = { evaluatedAt: UtcInstant; businessTime: Exclude<BusinessTime, { kind: "unknown" }> };
~~~
Decimal канонизируется без потери значения: "92.0" становится "92"; "0.01" остаётся "0.01"; NaN/Infinity запрещены.
Rational хранит точный процент: 92/90 × 100 = {numerator:"920",denominator:"9"}, а не округлённый порог.
ActorRef содержит объявленного человека из hostname-профиля, не удостоверенную связь с аккаунтом Bitbucket. Сетевой отправитель хранится отдельно.
Ссылки на существующие редакции проверяются в выбранном общем выпуске/локальном пакете. Присутствие UUID само по себе не доказывает существование объекта.
## 4. Определение цели и назначение
~~~ts
type CoreGoalDefinition = Header & {
  title: string; description: string;
  mode: "numeric" | "manual_status"; measurementMode: "as_of" | "period"; sourceId: UUIDv4;
  primaryCuratorPersonId: UUIDv4; coCuratorPersonIds: UUIDv4[];
  lifecycle: "active" | "archived"; archiveReason: string | null;
};
type MethodBinding =
  | { kind: "template"; templateId: UUIDv4 }
  | { kind: "standalone"; methodRef: VersionRef };
type GoalAssignment = Header & {
  goalId: UUIDv4; scope: ScopeRef; methodBinding: MethodBinding; officialDueOn: MoscowDate | null;
  expectedPopulation: ScopeRef[] | null;
};
type Template = Header & { name: string; methodRef: VersionRef };
~~~
Wire-объект определения называется coreGoalDefinition, тип — CoreGoalDefinition. Предлагается один контракт назначения и для общей области ДИТ.
measurementMode — выбранный куратором режим D-033: состояние на дату либо результат за период; он не является сроком достижения или частотой получения.
| Привязка | Разрешение метода при создании нового основания |
| --- | --- |
| template | Последняя подтверждённая опубликованная редакция Template по templateId → её methodRef; обе VersionRef сохраняются в основании. |
| standalone | Точная methodRef из назначения; публикация шаблона её не заменяет. |
Новая публикация Template применяется к связанным текущим назначениям по D-032; уже сохранённые основания остаются на прежних версиях.
Назначение содержит собственные условия через methodBinding. Показатели, сроки и методики соседних областей не выводятся друг из друга автоматически.
Для numeric expectedPopulation — явно выбранный куратором непустой список уникальных ScopeRef, для manual_status — null. Справочник помогает выбору, но состав не выводится из пришедших строк или всего справочника.
Агрегат источника может ожидать только scope самого назначения; продуктовый reducer — выбранные продукты. Список фиксируется в редакции назначения и копируется в EvaluationBasis; это состав числовых входов, не rollup дочерних целей.
Официальный срок не является датой начала действия назначения и не заменяет план/прогноз работы.
Активное назначение должно однозначно определять методику выбранной цели и области; конфликтующие активные варианты отклоняются. Повторные исторические редакции сохраняются.
Архивная цель исключена из активного обзора, доступна через поиск и историю; архивирование/возврат через PR. Дата/причина архивирования сохраняются событием, работы не отменяются.
## 5. Показатели, условия и версии методик
~~~ts
type MetricDefinition = Header & { name: string; unit: { code: string; label: string }; domain: "nonnegative_decimal" | "nonnegative_integer" | "signed_decimal" };
type NumericCondition =
  | { op: "gte" | "lte" | "eq"; target: Decimal }
  | { op: "range"; min: Decimal; max: Decimal };
type Normalization =
  | { kind: "increase_ratio_v1" }
  | { kind: "decrease_ratio_capped_v1"; maxPercent: Decimal }
  | { kind: "zero_counter_v1" }
  | { kind: "binary_condition_v1" };
type MetricRule = {
  metricRef: VersionRef; mandatory: boolean; originalWeight: Decimal;
  condition: NumericCondition; normalization: Normalization;
  freshness: { maxAgeHours: Decimal; updateEveryHours: Decimal };
  reducer: InputReducer;
};
type MethodVersion = Header & (
  | { mode: "numeric"; rules: MetricRule[];
      formula: { kind: "weighted_mean_v1"; scoreCondition: NumericCondition } }
  | { mode: "manual_status" }
);
~~~
У MetricRule уникальная metricRef внутри методики; веса неотрицательны, сумма исходных весов числовой методики положительна. maxAgeHours/updateEveryHours положительны.
Обязательность — отдельное условие достижения, не название веса. Нулевой вес не делает обязательное условие необязательным.
reducer явно задаётся внутри версии методики. Набор продуктовых строк не становится показателем кластера без такого правила; селекция строк относится к области назначения и проверенной версии справочника.
Редукция получает версию содержащей её методики и происхождение. Неизвестный kind или несовместимый профиль возвращает UNSUPPORTED_REDUCER с ID назначения/методики/показателя, без автоматического fallback.
Нельзя усреднять разнородные единицы или дважды учитывать продукт из-за связей с командами. Справочник состава и фактически пришедшие строки не заменяют друг друга.
Редактор не исполняет произвольный JS/SQL/формулу из строки. Другие согласуемые формулы получают явный идентификатор, контракт и пример, не fallback к weighted_mean_v1.
## 6. Справочники, связи и якорь публикации
~~~ts
type DirectoryEntity = Header & {
  kind: "dit" | "cluster" | "product" | "team" | "person" | "it_service";
  name: string; externalKeys: { sourceId: UUIDv4; key: string }[];
};
type DirectoryLink = Header & (
  | { kind: "dit_cluster" | "cluster_product" | "cluster_team" | "product_team";
      from: EntityRef; to: EntityRef }
  | { kind: "leader"; scope: ScopeRef; personId: UUIDv4 }
);
type PublicationAnchorRef = { publicationAnchorId: UUIDv4 };
~~~
Полная схема PublicationAnchor импортируется из документа 18: это post-merge результат проверки события Bitbucket, а не авторское время коммита. publicationAnchorId разрешается только как EntityRef {entityType:"publication_anchor",id:publicationAnchorId}; совпадение его UUID с packageId не объединяет типы сущностей.
В опубликованных назначениях/оргсвязях publicationAnchorId обязателен; до merge он может ссылаться на packageId согласно контракту 18.
PublicationAnchor имеет независимые publicationState=confirmed|unconfirmed и timeVerification=verified|unknown по документу 18. Проверенные commit/hash в main подтверждают публикацию.
Confirmed main активирует текущие назначения/оргсвязи даже при неизвестном mergedAt; до main черновик/unconfirmed не активен. effectiveAt берётся только из verified mergedAt, иначе null с явным признаком неизвестной даты.
Только wall-clock исторический запрос, которому необходим точный момент публикации, возвращает EFFECTIVE_TIME_UNVERIFIED при unknown. Чтение текущей main и истории по сохранённой revision/basis не требует REST timestamp каждому читателю.
Нельзя подставить pulledAt, appliedAt, время клиента или authorDate. Даты нет — она не угадывается, ради её добавления не создаётся новый PR.
Связи выбираются по редакции и якорю публикации. Новая связь не переназначает прошлый факт/согласованный срез; исправление факта имеет отдельный процесс.
У кластера и продукта по одному лидеру соответствующего уровня; команды необязательны. Одна команда не объявляется принадлежащей только одному продукту без требования.
Команда закреплена за кластером, перевод между кластерами не поддерживается. Связи ИТ-услуг не достраиваются автоматически.
Новая команда автоматически получает назначения целей кластера с командными шаблонами по D-039–D-040; действовать они начинают только с публикации в main по D-125. Это не добавляет её молча в expectedPopulation иных назначений.
## 7. Источник, получение и исходный факт
~~~ts
type InputReducer =
  | { kind: "source_provided_value" | "sum"; valueField: string }
  | { kind: "count" }
  | { kind: "ratio"; numeratorField: string; denominatorField: string; multiplier: Decimal };
type RawCell = { kind: "text" | "number" | "boolean" | "blank"; original: string | null };
type RawSourceRow = { rowKey: string; cells: Record<string, RawCell> };
type CanonicalSourceRow = { rowKey: string; dimensions: Record<string, string | null>; numbers: Record<string, Decimal | null>; businessTime: BusinessTime; unitCode: string | null };
type SourceFieldMapping = Header & {
  sourceId: UUIDv4; rowKeyFields: string[]; dimensionFields: Record<string, string>; productKeyField: string | null; fixedScope: ScopeRef | null;
  metricFields: { metricId: UUIDv4; fields: Record<string, string> }[]; dateField: string | null; periodStartField: string | null; periodEndField: string | null; unitField: string | null; fixedUnitCode: string | null;
};
type SourceDefinition = Header & {
  goalId: UUIDv4; kind: "qlik" | "file" | "manual_status";
  mappingRef: VersionRef | null; publicLocator: string | null;
};
type Capture = Header & {
  sourceId: UUIDv4; operationId: UUIDv4; obtainedVia: "direct" | "file_import";
  capturedAt: UtcInstant; sourceUpdatedAt: UtcInstant | null;
  payloadHash: Sha256; rawArtifactId: UUIDv4 | null; mappingRef: VersionRef;
  result: "accepted" | "partial"; acceptedRows: number; rejectedRows: number;
  rawRows: RawSourceRow[]; canonicalRows: CanonicalSourceRow[];
};
type Lineage = {
  captureId: UUIDv4; sourceRowKeys: string[]; mappingRef: VersionRef;
  directoryLinkRefs: VersionRef[]; inputFactRefs: VersionRef[]; reducerMethodRef: VersionRef | null;
};
type ObservedFact = Header & {
  sourceId: UUIDv4; captureId: UUIDv4; metricId: UUIDv4; scope: ScopeRef;
  businessTime: BusinessTime; sourceUpdatedAt: UtcInstant | null;
  origin: "source_value" | "reducer"; state: "known" | "missing"; value: ExactNumber | null; missingReason: string | null;
  unitCode: string; factKey: string; lineage: Lineage;
};
~~~
known требует ExactNumber и value!=null; исходное source_value — Decimal, reducer ratio может дать Rational; missing требует value=null и непустую причину. Не принятая ошибочная строка хранится диагностикой/исходником, не числовым нулём.
SourceFieldMapping явно связывает измерения, product key, поля величин/числителя/знаменателя, дату/период и единицу. Например, demo_product_key/demo_value — только синтетические имена колонок; реальные поля устанавливаются в банке.
Capture.rawRows сохраняет исходные ячейки отдельно от canonicalRows; нормализация не перезаписывает original. rowKey различает исходные строки до обогащения, а не номера созданных join-дубликатов.
После проверки ключей и устранения повторов одного rowKey: source_provided_value требует ровно одну подходящую строку; sum суммирует выбранный valueField; count считает уникальные принятые rowKey; ratio=(sum numeratorField)/(sum denominatorField)×multiplier. multiplier задаётся явно, например 100 для процентов.
Отсутствующий нужный компонент не становится нулём; нулевой знаменатель ratio — диагностируемая невозможность входа. Среднее процентов, неявный child rollup и счёт размноженных join-строк не разрешены. Все участвующие rowKey и версия reducer сохраняются в lineage.
factKey — канонический ключ сравнения источника, показателя, области, делового времени и нужных измерений строки. Конкретные внешние поля устанавливаются при подключении.
Capture отражает успешное реальное получение, включая согласованный частичный файл; ошибка/отмена не заменяют последний успешный набор. Отдельные сетевые/импортные контракты — документ 18.
Повтор одной операции с тем же operationId идемпотентен. Новое реальное получение может дать новое наблюдение с прежним значением, сохраняя дату данных источника.
Повтор одинакового файла не удваивает принятые факты; изменённые значения показываются «было / станет», применяются выбранные, исправленные пропуски дополняют прежние строки.
Git/локальный кэш доставляют существующий Capture/факты и не создают Capture с сегодняшней датой. Неизвестная дата источника остаётся неизвестной.
Источник цели получает весь нужный набор продуктов. До 2 000 строк — профиль нагрузки одной выгрузки, не разрешение обрезать её или очищать историю.
Общий SourceDefinition не содержит секретов, браузерных профилей и приватных путей. Фактический формат банка и полный экспорт проверяются в среде.
## 8. Применимость, корректировки и ручной статус
~~~ts
type Applicability = Header & {
  assignmentId: UUIDv4; metricId: UUIDv4; period: DateRange;
  kind: "not_applicable"; reason: string;
};
type ManualCorrection = Header & {
  factKey: string; originalFactRefs: VersionRef[]; replacement: Decimal;
  reason: string;
};
type ManualState = "not_started" | "in_progress" | "completed";
type ManualStatusEvent = Header & {
  assignmentId: UUIDv4; from: ManualState | null; to: ManualState;
  resultDescription: string | null; reason: string | null; evidenceIds: UUIDv4[];
};
~~~
При отсутствии действующего исключения вход применим. Исключение требует куратора, причины, области назначения и периода; публикация проходит обычный PR.
Пропуск не создаёт Applicability. По окончании периода исключения вход снова ожидается; исходное определение/вес не удаляется.
Корректировка сохраняет исходные ссылки и дату/период факта; её редактирование/публикация не делает факт свежим. До merge это только предложение.
Повторный источник с тем же factKey не стирает принятую корректировку; расхождение показывается куратору. На другой период она не переносится автоматически.
Если ключа/периода недостаточно для определения «тот же факт», автоматическое наложение корректировки запрещено; нужна диагностика сопоставления, не догадка.
Для completed обязателен непустой resultDescription; ссылка/файл необязательны. completed→in_progress требует непустой reason по D-118.
Прежнее завершение и описание результата остаются отдельным событием истории; общая запись меняется после PR/merge.
Ручной статус не получает искусственного Decimal, нулевого балла или N/A из пустого числового набора. Этот контракт не вводит дополнительный этап числового расчёта для ручной цели.
## 8a. Минимальные схемы остальных модулей
Предлагаемые типы ниже закрывают ссылки API документа 17; они не добавляют новых бизнес-возможностей.
~~~ts
type Work = Header & { title: string; goalIds: UUIDv4[]; responsibility: { scope: ScopeRef; personId: UUIDv4 }[]; state: "planned" | "in_progress" | "paused" | "completed" | "cancelled"; dueOn: MoscowDate | null; forecastOn: MoscowDate | null; nextAction: string; reason: string | null; resultDescription: string | null; evidenceIds: UUIDv4[]; risk: { reason: string; helpNeeded: string } | null; blocker: string | null };
type WorkDependency = Header & { predecessorWorkId: UUIDv4; successorWorkId: UUIDv4; active: boolean; changeReason: string | null };
type Decision = Header & { workId: UUIDv4; request: string; requestedFromPersonId: UUIDv4; dueOn: MoscowDate; answer: string | null; answeredAt: UtcInstant | null };
type CustomFieldDef = Header & { name: string; entityTypes: string[]; valueType: "text" | "long_text" | "decimal" | "boolean" | "date" | "enum" | "multi_enum"; enumValues: string[] | null };
type CustomFieldValue = Header & { objectRef: EntityRef; fieldRef: VersionRef; value: string | string[] | boolean | null };
type Commentary = Header & { targetRef: EntityRef; text: string };
type FileArtifactRef = { artifactId: UUIDv4; hash: Sha256; mimeType: string; bytes: number };
type Evidence = Header & ({ kind: "file"; file: FileArtifactRef } | { kind: "url"; url: string });
type RegisteredPayload = { schemaId: string; schemaVersion: PositiveInt; value: Record<string, unknown> };
type DashboardDef = Header & { title: string; blocks: { id: UUIDv4; typeId: string; settings: RegisteredPayload }[]; filters: RegisteredPayload[] };
type BusinessCalendar = Header & { timeZone: "Europe/Moscow"; workingWeekdays: (1|2|3|4|5|6|7)[]; exceptions: { date: MoscowDate; working: boolean }[] };
type ReminderSettings = Header & { calendarId: UUIDv4; dailyAt: string; repeatEveryWorkdays: PositiveInt }; // dailyAt HH:mm, default "09:00"; repeat default 1
type PersonalOwner = { installationId: UUIDv4; profilePersonId: UUIDv4 | null };
type NotificationSubscription = { schemaVersion: 1; id: UUIDv4; owner: PersonalOwner; goalId: UUIDv4; enabled: boolean; createdAt: UtcInstant };
type NotificationReadState = { schemaVersion: 1; owner: PersonalOwner; eventId: UUIDv4; readAt: UtcInstant | null };
~~~
Work.completed требует результата; paused/cancelled требуют причины; completed→in_progress требует причины с сохранением завершения. Вложения необязательны. Одна работа может относиться к нескольким целям; их измеренный результат не меняется из-за состояния работы.
Зависимости ацикличны, self-reference запрещена. Отмена предшественника показывает предупреждение; замена/снятие связи требует причины, прогнозы куратор пересматривает вручную. У Decision ответ и answeredAt заполняются вместе; просрочка вычисляется отдельно, это техническая двухсостоянийная проекция, не новая роль руководителя.
CustomFieldValue проверяется по fieldRef: text/long_text — строка, decimal — Decimal, boolean — boolean, date — MoscowDate, enum — один элемент enumValues, multi_enum — уникальный string[] из enumValues; null означает незаполненное поле. enumValues непустой уникальный список только для двух enum-типов, иначе null; смена определения не удаляет прежние значения. Это описательные поля, не формулы расчёта.
Commentary требует существующую цель/работу/иной зарегистрированный targetRef и непустой text. Evidence сохраняет автора через Header; file — неизменяемый файловый артефакт с проверяемым hash, непустым MIME и bytes — целым >=0; url — абсолютная HTTP(S)-ссылка без встроенных учётных данных. Файл и URL взаимоисключающие; приватный путь файла не публикуется вместо артефакта. Вложения связаны с работой/статусом/подтверждением через evidenceIds и входят в тот же PR; обычный комментарий не подтверждает выполнение.
Схемы блоков/фильтров регистрирует модуль uor: schemaId uor.dashboard.<type>.v1, type=metric-card|goal-table|metric-trend|execution-table|data-issues|scope-filter. Точные поля — в 17; без зарегистрированной схемы публикация запрещена, произвольный код не исполняется.
BusinessCalendar/ReminderSettings — общая конфигурация через PR; subscriptions/read state — личные, не публикуются автоматически. Номер weekday: 1=понедельник; исключение даты заменяет недельное правило; пустая/дублирующаяся дата или неверный HH:mm отклоняются.
Напоминания только по рабочим дням календаря, по умолчанию 09:00 МСК; после перерыва одно актуальное, без очереди пропущенных повторов. Совпадение адресата по нескольким назначениям не дублирует событие. Политика календаря не переносит сроки работ.
## 9. Основание, результат и подтверждение
~~~ts
type EvaluationBasis = Header & EvaluationContext & {
  assignmentRef: VersionRef; goalRef: VersionRef; methodRef: VersionRef; templateRef: VersionRef | null;
  expectedPopulation: ScopeRef[] | null;
  factRefs: VersionRef[]; correctionRefs: VersionRef[]; applicabilityRefs: VersionRef[];
  directoryLinkRefs: VersionRef[]; digest: Sha256;
};
type NumericEvaluation = {
  basisRef: VersionRef;
  calculation: "ready" | "preliminary" | "no_data" | "not_applicable" | "blocked";
  achievement: "met" | "not_met" | "unknown" | "not_applicable";
  scorePercent: Rational | null; preliminaryPercent: Rational | null;
  coveragePercent: Rational | null; missingMetricIds: UUIDv4[];
  missingPopulation: { metricId: UUIDv4; scope: ScopeRef }[];
  complete: boolean; freshness: "fresh" | "stale" | "unknown"; qualityFlags: string[];
  canConfirm: boolean;
};
type CalculationResult = Header & NumericEvaluation;
type Attestation = Header & {
  basisDigest: Sha256; comment: string; evidenceIds: UUIDv4[];
};
type AgreedSnapshot = Header & {
  basisRef: VersionRef; numericResult: NumericEvaluation | null;
  manualStatusRef: VersionRef | null; attestationRef: VersionRef | null;
};
~~~
AgreedSnapshot содержит ровно один из numericResult/manualStatusRef; он фиксирует свои редакции, а не читает изменяемую текущую методику.
Полнота каждого применимого показателя сверяется с expectedPopulation и lineage: отсутствующий участник попадает в missingPopulation, весь вход этого показателя неполон, canConfirm=false. Частичная сумма не выдаётся за полный известный r; исключение N/A относится к показателю как раньше. Дозагрузка пересчитывает текущую полноту; прежняя ошибка операции не делает исправленный набор вечно неполным.
Расчёт чистый: evaluatedAt и businessTime — явные входы и часть основания; метод не читает системные часы сам. Чтение/предпросмотр не создают факта, подтверждения или публикации. Сохранение среза — отдельная команда документа 17.
businessTime запроса должен соответствовать measurementMode цели. При as_of выбирается последнее допустимое известное наблюдение с businessTime.kind=as_of для каждого ожидаемого участника/показателя с датой факта <= проверяемой даты и capturedAt <= min(evaluatedAt, конец этой даты в Москве). Для равной деловой даты выбирается последнее допустимое получение; неоднозначные равные ключи дают диагностику, не произвольный выбор.
При period выбираются факты с явно совместимым периодом: текущий контракт требует точного совпадения startInclusive/endExclusive с запросом и capturedAt<=evaluatedAt; sum/count/ratio объединяют участников/строки только внутри него. Пересекающиеся, неполные или соседние периоды не суммируются молча; иной календарный reducer требует отдельного зарегистрированного контракта. unknown не подменяется датой загрузки и не подходит для точного отбора на дату/период.
Числовое подтверждение относится к точному basisDigest; новая основа не наследует старое подтверждение. Старое решение остаётся доступным в своей истории.
canConfirm=true только при met, полном нужном составе, проверенной допустимой актуальности и отсутствии блокирующих ошибок основания. Подтверждение не создаётся автоматически.
Высокий предварительный балл, успешный импорт, завершённая работа, merge истории или пятничная проекция не заменяют эти условия.
Давность не изменяет исторический результат среза; предупреждение о текущей актуальности отделяется от согласованного достижения.
## 10. Поддержанные числовые правила
Обозначения: x — исходный факт, t — целевое значение, r — нормированное выполнение в процентах. Единицы x/t совпадают.
| Контракт | Область и точная формула |
| --- | --- |
| increase_ratio_v1 | Условие gte, t>0, x>=0: r=100×x/t. Общего ограничения 100% нет. |
| decrease_ratio_capped_v1 | Условие lte, t>0, x>=0, конечный M>100: r=min(M,100×t/x) при x>0; при x=0 r=M. M задаётся явно, 200 не default. |
| zero_counter_v1 | Неотрицательный целый счётчик с условием lte и t=0: x=0→r100, x>0→r0; missing→нет результата. |
| binary_condition_v1 | range: min<=x<=max; eq: x=t. Выполнено→r100, нарушено→r0; missing отдельно. Границы включены. |
Превышение сырой доли и нормированное перевыполнение не смешиваются: само обозначение "%" не снимает ограничений домена источника.
Конфигурация проверяет min<=max, совместимость нормирования/условия/домена и единицы; неподдержанное сочетание не получает выдуманную формулу.
После N/A: A — применимые правила; эффективный вес wEff_i=100×w_i/sum_A(w), если знаменатель положителен; исходный w сохраняется.
Все правила N/A: achievement/calculation=not_applicable; баллы и покрытие null, подтверждения нет; цель исключается из доли выполнения области и учитывается отдельным числом.
Для weighted_mean_v1 при полном A: score=sum_A(w_i×r_i)/sum_A(w_i); сравнение с явным formula.scoreCondition, без скрытого порога 100.
При пропусках K⊆A — известные применимые входы: P=sum_K(w_i×r_i)/sum_K(w_i), C=100×sum_K(w_i)/sum_A(w_i). P — preliminaryPercent, не окончательный scorePercent.
D-029 подтверждает предварительный балл при неполноте; точные формулы P/C выше — выбор проектировщика этого контракта. При неполноте scorePercent=null; P хранится отдельно, даже когда C=100 из-за нулевого веса пропуска.
Нулевая сумма доступных весов не создаёт P. Нет известных входов→no_data; применимые входы без положительного веса→blocked/zero_applicable_weight, не 100%.
Техвыбор текущего weighted_mean_v1: полный расчёт требует всех применимых входов методики, включая нулевой вес; mandatory отдельно проверяет достижение. Иные политики необязательных пропусков не заявляются поддержанными молча.
Известный провал mandatory→not_met даже при пропусках; иначе неполнота→unknown. При полном составе нужны успех всех mandatory и успех scoreCondition.
Устаревший известный факт остаётся известным для балла/охвата, но не даёт нового подтверждения; freshness и complete не объединяются. Давность считается относительно evaluatedAt: якорь — sourceUpdatedAt, иначе явно заданная дата/период факта, никогда capturedAt.
Техвыбор для дат без часов: as_of — начало указанного дня МСК; period — конец последнего дня периода (endExclusive 00:00 МСК минус 1 мс). Возраст <= maxAgeHours означает fresh; будущий/неизвестный якорь даёт unknown с диагностикой, а не искусственно свежий результат.
При unknown дате актуальности не подставляется capturedAt; предлагается блокировать новое подтверждение до проверенного основания актуальности, сохраняя расчёт и диагностику.
Отрицательные значения, специальные допуски, иные невзвешенные методы и сложные агрегации не получают формулы по аналогии; их контракт/эталон фиксируется перед поддержкой по D-088.
## 11. Неизменяемость и выбор редакций
- Header.revision — версия записи, MethodVersion — версия правил; schemaVersion — версия формата. Эти числа не заменяют commit публикации.
- Основание сохраняет версии фактов/методики/связей и применённые исключения; одного ID текущего каталога недостаточно.
- Предлагаемый digest: SHA-256 канонического JSON основания без собственного digest; ключи объектов сортируются, наборы ссылок упорядочены по entityType/id/revision.
- Decimal и Rational перед хешированием канонизируются; форматирование "92.0"/"92" не создаёт нового числового смысла. Исходное представление сохраняется в сырой строке.
- Применение новой публикации не переписывает прежний AgreedSnapshot. Текущий расчёт может получить новую основу и иной результат.
- D-125 запрещает задним числом менять назначение/оргсвязь. Осознанная корректировка измеренного факта по D-036 — другой процесс и тоже не перезаписывает прежний срез.
- Сетевой аудит содержит отправителя Bitbucket/операцию отдельно от ActorRef; аккаунт не используется для выбора режима и не сопоставляется с hostname-профилем.
## 12. Пятничная проекция
~~~ts
type WeeklyPoint = {
  assignmentId: UUIDv4; metricId: UUIDv4; friday: MoscowDate;
  value: ExactNumber | null; sourceFactRef: VersionRef | null;
  sourceBusinessTime: BusinessTime | null; sourceCapturedAt: UtcInstant | null;
  carried: boolean; warning: "Данные не обновлялись" | null;
};
~~~
Техническое правило выборки: для одной области/метрики и выбранной редакции брать последнее подходящее наблюдение, полученное не позже конца этой пятницы по Москве; будущая загрузка не выдаётся за известную раньше.
При свежем пятничном наблюдении value берётся из него; одинаковые значения соединяются горизонтально.
При отсутствии свежего — последнее известное, carried=true, исходная дата и предупреждение D-124. При отсутствии прежнего значения value/ref/time=null, carried=false: «Нет данных», не 0.
Дата friday — координата графика, не дата измерения. sourceBusinessTime сохраняется даже при неизвестной дате; UI не подставляет пятницу вместо исходной даты.
WeeklyPoint не создаёт Capture/ObservedFact, не заполняет исходные дневные пропуски, не обновляет давность и не разрешает новое подтверждение. Построение проекции не создаёт PR.
Если из исходных строк не получен однозначный вход или единицы несовместимы, проекция показывает проблему, а не выполняет неописанную конверсию.
## 13. Точные синтетические JSON-примеры
Ниже контрольные конверты input/expected для вычислений, не полный пакет хранения. Идентификаторы условны, значения не относятся к банковской карте.
Пример 1: обязательный показатель провален, хотя взвешенный балл 96 проходит настроенный порог 90.
~~~json
{
  "caseId": "weighted-mandatory",
  "input": {
    "scoreThreshold": "90",
    "rules": [
      {"weight":"20","mandatory":true,"target":"100","fact":"80","normalization":"increase_ratio_v1"},
      {"weight":"80","mandatory":false,"target":"100","fact":"100","normalization":"increase_ratio_v1"}
    ]
  },
  "expected": {"scorePercent":{"numerator":"96","denominator":"1"},"coveragePercent":{"numerator":"100","denominator":"1"},"complete":true,"achievement":"not_met","canConfirm":false}
}
~~~
Пример 2: results — уже нормированные r; предварительный балл не маскирует пропуск, отдельный N/A перераспределяет веса.
~~~json
{
  "cases": [
    {"input":{"weights":["50","50"],"results":["80",null],"applicability":["applicable","applicable"]},
     "expected":{"scorePercent":null,"preliminaryPercent":{"numerator":"80","denominator":"1"},"coveragePercent":{"numerator":"50","denominator":"1"},"complete":false,"achievement":"unknown","canConfirm":false}},
    {"input":{"weights":["60","20","20"],"results":["100","100",null],"applicability":["applicable","applicable","not_applicable"]},
     "expected":{"effectiveWeights":["75","25",null],"scorePercent":{"numerator":"100","denominator":"1"},"coveragePercent":{"numerator":"100","denominator":"1"},"complete":true}}
  ]
}
~~~
Пример 3: перенос четвергового значения на пятничный график без нового получения.
~~~json
{
  "input":{"friday":"2026-10-23","lastFact":{"value":"92","date":"2026-10-22"},"freshFridayFact":null},
  "expected":{"value":"92","sourceDate":"2026-10-22","carried":true,"warning":"Данные не обновлялись","newCaptureCount":0,"newObservedFactCount":0,"freshnessChanged":false,"attestationCreated":false}
}
~~~
## 14. Инварианты и отрицательные случаи приёмки
1. Одна цель: ДИТ 92 при требовании 90 и кластер 88 при 95 дают разные результаты; нижний уровень не отменяет общий автоматически.
2. Равные строки разных команд не удваивают продуктовый факт; отсутствие необязательных команд, не входящих в expectedPopulation, не объявляет продукт неполным.
3. Повтор operationId/файла не увеличивает число принятых логических фактов; исправленные пропуски дополняют набор, а не стирают принятые строки.
4. Умолчания нуля при missing, бесконечный M, M<=100, NaN/Infinity, min>max, несовместимые единицы и неизвестный formulaId отклоняются до расчёта.
5. Сломанная ссылка, повтор metricRef, отрицательный вес, отсутствующая редакция методики либо неоднозначное сопоставление блокируют основание, а не объявляют успех.
6. Полнота 100% по весам не отменяет отсутствующий нулевой вход; известный провал mandatory не компенсируется score>100.
7. Все N/A дают not_applicable без балла; применимые с нулевой суммой весов дают диагностируемую невозможность расчёта.
8. При цели 0 и счётчике 0 результат 100; при 1 — 0; при missing — нет данных. При t10/M200: x8→125, x5/x1/x0→200.
9. Отсутствие свежей пятничной загрузки даёт предупреждение и старую дату; без прежнего значения — нет данных; исходная история не пополняется.
10. Ручной effectiveAt либо pull/authorDate вместо merge отклоняются. Confirmed main активирует текущие связи при unknown mergedAt; только точный wall-clock запрос получает EFFECTIVE_TIME_UNVERIFIED. Срез по сохранённому basis читается.
11. Публикация новой оргсвязи/методики не меняет digest и значения старого согласованного среза; приложение может пересчитать только новую текущую основу.
12. Возврат ручной цели без причины и завершение без результата не готовы к PR; прежнее завершение сохраняется, числовой балл не создаётся.
13. Архивирование не удаляет записи и не отменяет связанные работы; перенос архива сохраняет историю/авторство, но не активирует чужой кэш режима.
14. expectedPopulation=[продукт A, продукт B], получен только A: отсутствующий B показан явно, вход неполон и не подтверждается. Полученные строки и новая команда не меняют опубликованный список автоматически.
15. Будущее capturedAt исключается из as_of; пересекающиеся периоды не суммируются. При одинаковом основании и evaluatedAt чистый результат одинаков; изменение часов клиента не меняет сохранённый срез.
16. Новая редакция Template меняет только новые текущие основания связанных назначений; standalone и сохранённый basis не меняются. Неверный enum/multi_enum, пустой Commentary.text и Evidence без корректного файла/URL отклоняются.
## 15. Граница готовности
Формат, алгоритмы и отрицательные случаи проверяются независимо от UI; конкретные команды/API описывает 17, источники/пакеты/публикацию/восстановление — 18, исполнимую приёмку и задачи — 19.
Реальные банковские колонки, ключи, допустимые выгрузки, права и старые данные проверяются при подключении; синтетика не заменяет банковский эталон.
Здесь не выбираются новые серверы, account binding, многопроектность, удаление истории или отчётность первого этапа. Неописанная сложная методика не включается скрытым предположением.
