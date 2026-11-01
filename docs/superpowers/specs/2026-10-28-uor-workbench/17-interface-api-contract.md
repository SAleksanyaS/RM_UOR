# Контракт интерфейса API и подключения модулей

Дата: 28.10.2026. Статус: нормативный проект для согласования дизайна; новый API и интерфейс ещё не реализованы.
«Должен» описывает целевое поведение после принятия проекта, а не результат проверки работающего продукта.
Основания: [04](04-specification-standard.md), [06](06-user-journeys.md), [09](09-ux-recommendation.md), [11](11-platform-architecture.md), [13](13-domain-model.md), [15](15-access-policy.md), D-096–D-126.
Предметные сущности, Decimal, Rational, расчёт и основания определяются [16](16-data-calculation-contract.md); эксплуатационные адаптеры, PackageRevision и PublicationAnchor — [18](18-integration-operations-contract.md).
Ссылки на их типы ниже не создают альтернативную предметную модель; критерии межконтрактной приёмки задаёт [19](19-acceptance-delivery-contract.md).

## 1 Границы и выбранные технические решения

Первый выпуск включает цели, данные, аналитику, работы/решения и УОР; формирование отчётов и PPTX остаётся следующим этапом.
Выбор агента: React 19, TypeScript 5, Vite 7, Fastify 5 и Zod 4 как развитие зависимостей существующего RM_UOR, без автоматического обновления библиотек.
Обязательная среда: Node.js 22.16.0, npm 10.9.2, Python 3.13.5. Контракт Python-процесса принадлежит адаптеру документа 18.
Один локальный прикладной процесс и браузерный интерфейс; API слушает loopback. Общий прикладной сервер не вводится.
Основной репозиторий приложения один; закрытый служебный реестр — исключение D-120, не переключаемое рабочее пространство.
Чтение не меняет предметные данные, не запускает источник, не подтверждает цель и не публикует пакет скрытым побочным эффектом.

## 2 Общий контекст и адресация экранов

`GlobalContext` одинаков для всех экранов; каноническая область назначения остаётся `ScopeRef` документа 16.
`scopePath` — модель навигации, не требование хранить всех родителей в каждой предметной записи.

| Поле контекста | Тип и правило |
| --- | --- |
| `scopePath.ditId` | UUIDv4 общей области ДИТ; обязателен. |
| `scopePath.clusterId` | UUIDv4 или null; один лидер кластера показывается отдельно. |
| `scopePath.productId` | UUIDv4 или null; требует выбранного кластера, у продукта свой единственный лидер. |
| `scopePath.teamId` | UUIDv4 или null; требует продукта, детализация необязательна. |
| `goalId` | UUIDv4 или null; null означает все цели выбранной области. |
| `time` | BusinessTime 16: `{kind:"as_of",date:Date}` либо `{kind:"period",startInclusive:Date,endExclusive:Date}`; Date — `YYYY-MM-DD`. |
| `resultMode` | `current` либо `agreed`; это вид результата, а не роль доступа. |
| `snapshotId` | UUIDv4 или null; в agreed после выбора среза обязателен, самовольного выбора чужого периода нет. |

Сервер проверяет существование пути и допустимые связи; отсутствие необязательных команд не является ошибкой полноты.
При выборе кластера сбрасываются несовместимые продукт/команда; при выборе продукта сбрасывается несовместимая команда. Причина видна пользователю.
Область, цель, время и вид результата сохраняются при переходах и возврате браузера, а также в личных настройках последнего контекста.
URL использует параметры `dit`, `cluster`, `product`, `team`, `goal`, `mode`, `snapshot`, `at` либо `from`/`to`; неизвестные параметры не влияют на расчёт.
Параметры from/to передают startInclusive/endExclusive; интерфейс подписывает границы явно. Unknown-дата исходного факта не заменяется выбранной датой контекста.
Исторический контекст не переписывается текущими справочниками. Если согласованного среза нет, показано «Согласованный срез не опубликован», а не текущий результат под старой подписью.

## 3 Пять экранов

| Навигация и маршрут | Обязательное содержание | Основные действия |
| --- | --- | --- |
| Обзор `/overview` | Ситуация в контексте; отдельно отклонения целей, риски работ, решения и проблемы данных. | Фильтровать исключения, открыть цель/работу/решение, изменить область. |
| Цели `/goals`, `/goals/:goalId` | Список, требование и факт/ручной статус, лидеры, методика, текущий и согласованный результаты. | Открыть причины, работу, источник и основание; куратору — локальный черновик. |
| Работы и решения `/execution` | Работы/вехи, план и прогноз, риск, зависимости, адресат и срок решения. | Открыть цепочку, связанный объект, отфильтровать ответственного; куратору — редактировать черновик. |
| Данные `/data` | Полученные наборы, происхождение, частичный импорт, исходные и обогащённые строки. | Получить данные настроенного источника, выбрать набор, посмотреть ошибки и lineage. |
| Панель УОР `/uor` | Очередь своей зоны, черновики, влияние, пакет, PR и замечания. | Проверить, изменить, сохранить, просмотреть влияние, отправить накопленный пакет. |

Пять пунктов зарегистрированы в оболочке. Для viewer «Панель УОР» обозначена как недоступная с понятной причиной; её данные API не выдаёт.
`curator` и `chief` получают одинаковую обычную панель. Обслуживание закрытого реестра не является её шестым разделом.
Карточка цели содержит вкладки «Состояние», «Работы и решения», «Методика», «Расчёт», «Обогащённые данные», «Исходные строки», «История».
Сверху карточки всегда видны полное название, область, требование/состояние, дата данных и следующий предметный шаг.
Связанный объект открывается с сохранением контекста; новая вкладка не создаёт копию записи работы или цели.
Директор использует ДИТ, лидер кластера — продукты кластера, лидер продукта — свой продукт и необходимые команды. Это фильтры, не дополнительные роли.
Оболочка содержит центр уведомлений: непрочитанные, переход к причине, «Отметить прочитанным» и подписку на цель. Это панель общего интерфейса, не шестой раздел навигации.

## 4 Формы без программирования

Все общие изменения сначала сохраняются в черновик. JSON, SQL и исполняемые выражения не являются пользовательским интерфейсом настройки.
Общие формы используют зарегистрированные определения полей, текстовые подсказки и предпросмотр на примере.

| Форма | Поля и простая проверка | Предпросмотр |
| --- | --- | --- |
| Методика | Область, показатели, единицы, условие, цель/границы, обязательность, вес, нормирование и итог из разрешённых операторов 16. | Входы → объяснение расчёта → результат/покрытие/блокировки. |
| Цель и назначение | measurementMode=as_of/period; numeric expectedPopulation — выбранный куратором непустой уникальный ScopeRef[], manual_status — null. | Ожидаемые области сопоставляются с фактическими строками; источник не задаёт ожидаемый состав за куратора. |
| Шаблон | Template.name и methodRef:VersionRef, список использующих назначений; выбор «Общий шаблон» либо «Самостоятельная методика». | Какие назначения изменятся; самостоятельные не затрагиваются. |
| N/A | Показатель, область, период, непустая причина; пропуск данных не создаёт исключение. | Эффективный состав, веса и возможность подтверждения по 16. |
| Источник и колонки | Способ цели, постоянная ссылка, выбор реальных колонок/единиц и разрешённого reducer из 16; без общих секретов. | Исходные/распознанные строки и ошибки до принятия. |
| Дашборд | Название, готовые блоки, порядок, размеры и общий контекст; кнопки перемещения доступны без drag-and-drop. | Реальный экран на выбранном наборе и состояния отсутствующих данных. |
| Описательное поле | Имя, тип, область сущностей, допустимые варианты; устойчивый ID создаёт сервер. | Одно поле в форме, таблице, фильтре и блоке дашборда. |
| Календарь и напоминания | Общие рабочие дни/исключения, время и периодичность по 16; default 09:00 Europe/Moscow. | Ближайшее напоминание; конфигурация входит в PR, чтение уведомления не закрывает причину. |

Начальный каталог CustomFieldDef по 16: text, long_text, decimal, date, boolean, enum и multi_enum; enum выбирает один вариант, multi_enum — неповторяющийся список допустимых вариантов.
Описательное поле не становится формулой, обязательным показателем или основанием подтверждения само по себе.
Начальный каталог блоков: карточка показателя, список целей, временной ряд, работы/решения, проблемы данных; новый тип блока поставляется общим обновлением кода.
Ошибка подписана рядом с полем, содержит требуемое исправление и не стирает введённое. Сумма весов и границы проверяются правилами 16, не догадками UI.
Сохранение незавершённого черновика отделено от проверки готовности подтверждения/публикации; обязательные причины проверяются соответствующей командой.
По D-125 назначения целей и организационные связи действуют с публикации в main; выбора даты начала действия в этих формах нет.
Исторические согласованные основания не пересчитываются. N/A-период и даты измерения сохраняют собственный смысл и не заменяются датой публикации.

### 4a Строгий каталог дашборда

DashboardDef из 16 хранит порядок в массиве blocks; каждый block.id уникален. Типы ниже — весь начальный каталог, не произвольные компоненты.
У блока typeId равен settings.schemaId; schemaVersion=1, ownerModuleId=uor. RegisteredPayload.value содержит ровно поля соответствующей строки, без неизвестных ключей.
Layout={w:3|6|12,h:1|2|3}: ширина в 12 колонках, высота в единицах блока; размещение по порядку слева направо с переносом. Размеры меняют представление, не расчёт.
Во всех блоках применяется GlobalContext; вложенный альтернативный scope/time, URL запроса, SQL, JS и формула в settings запрещены. limit — целое 1..200.

| typeId/schemaId | Точная структура value |
| --- | --- |
| `uor.dashboard.metric-card.v1` | `{layout:Layout,assignmentRef:EntityRef,metricRef:VersionRef,showTrend:boolean}`. |
| `uor.dashboard.goal-table.v1` | `{layout:Layout,columns:GoalColumn[],limit:integer,attentionOnly:boolean}`. |
| `uor.dashboard.metric-trend.v1` | `{layout:Layout,assignmentRef:EntityRef,metricRef:VersionRef,granularity:"day"\|"friday"}`. |
| `uor.dashboard.execution-table.v1` | `{layout:Layout,kind:"all"\|"work"\|"decision",columns:ExecutionColumn[],limit:integer,attentionOnly:boolean}`. |
| `uor.dashboard.data-issues.v1` | `{layout:Layout,kinds:("stale"\|"incomplete"\|"missing"\|"unmapped"\|"error")[],limit:integer}`. |
| Фильтр `uor.dashboard.scope-filter.v1` | `{levels:("cluster"\|"product"\|"team")[],showGoal:boolean}`; меняет общий контекст, не создаёт собственную область блока. |

GoalColumn="title"|"scope"|"owner"|"requirement"|"current"|"agreed"|"freshness"|"coverage"|"confirmation"|"nextAction"; ExecutionColumn="title"|"kind"|"owner"|"state"|"dueOn"|"forecastOn"|"risk"|"nextAction".
columns/kinds/levels непустые, без повторов; columns содержит title. levels сохраняет порядок cluster→product→team и включает родителей выбранной детализации; фильтр в DashboardDef не дублируется.
assignmentRef разрешается в GoalAssignment, metricRef — в редакцию MetricDefinition этого назначения; несовместимая ссылка даёт 422, а не пустой нулевой график. В agreed используются зафиксированные редакции основания; showTrend использует пятничную проекцию 16.
forms.describe возвращает эти же схемы/enum; dashboard.draft.save и package.preview проверяют их сервером. Фильтр не может менять формулу, expectedPopulation или права доступа.

## 5 Просмотр оснований и независимые состояния

Исходный вид показывает сохранённые бизнес-поля и ссылку на получение/строку; обогащённый — добавленные связи и их версии, не перезаписанный оригинал.
Lineage открывает результат → использованные факты → исходные строки, MethodVersion и версии сопоставлений. Для агрегата возвращается набор оснований.
Показываются первичный источник цели, путь доставки `direct`/`local-cache`/`git`, дата источника, получение, полнота и использованная редакция.
Продуктовые факты не удваиваются из-за детализации. Необходимое несопоставление ведёт в очередь УОР; необязательная команда не создаёт проблему.

| Состояние | Что видит пользователь | Разрешённое действие |
| --- | --- | --- |
| `loading` | Название выполняемой операции; прежний результат с датой остаётся, если есть. | Уйти на другой экран; отмена только при доступности у задания. |
| `empty` | «Нет объектов по фильтру» отдельно от «Нет данных»/«Срез не опубликован». | Сбросить фильтр, открыть источник либо другой период. |
| `error` | Причина, сохранённый результат и код операции; без ложного сообщения об успехе. | Повторить только доступное действие, открыть детали. |
| `stale` | Исходная дата и предупреждение; не сегодняшний факт. | Обновить источник; новое подтверждение ограничено правилами 16. |
| `incomplete` | Покрытие, список пропусков/необходимых связей и предварительность. | Проверить основания; обязательный пропуск блокирует подтверждение. |
| `offline` | Что недоступно: источник, Git или служебный реестр; локальные данные сохранены. | Читать, разрешённый offline-черновик; отправка без свежего допуска запрещена. |
| `draft` | Автор и локальная редакция, отличие от опубликованной. | Куратору — изменить/предпросмотреть; не выдавать за общий итог. |
| `approved` | Опубликованный согласованный срез, основание и отдельно наличие/отсутствие Attestation. | Читать историю; свежий факт не переписывает срез, отсутствие подтверждения не скрывается. |

Состояния сочетаются: approved может быть старым, а current — неполным. Одного цвета для выполнения, актуальности и согласования недостаточно.
По D-124 пятничная проекция без нового наблюдения показывает последнее известное значение, исходную дату и «Данные не обновлялись»; измерение не создаётся.
Без прежнего факта — «Нет данных»; одинаковые пятничные значения дают ровную линию, дневные пропуски сохраняются.
По D-125 confirmed-публикация с проверенными commit/hash main применяется в current, даже если точный mergedAt неизвестен. В таком случае показано «Дата публикации не подтверждена», время pull не подставляется.
Unconfirmed-предложение до принятия в main не активно. Неизвестное точное время блокирует только историческое действие, которому нужна граница wall-clock; прежние agreed-основания неизменны.

## 6 Доступность и запуск

Вся навигация доступна клавиатурой; фокус после перехода попадает в заголовок, после закрытия деталей возвращается к вызвавшему элементу.
Кнопки имеют предметные имена: «Обновить данные цели», «Открыть исходные строки», «Проверить пакет», «Отправить пакет в Bitbucket».
Иконка без текста имеет доступное имя; ошибка связана с полем, состояние объявляется через ненавязчивую live-область. Таблицы имеют подписи и заголовки.
По D-120–D-123 локальный Node определяет hostname через `os.hostname()`; тело браузерного запроса не задаёт hostname, роль или personId допуска.
Имя и режим берутся только из собственного профиля закрытого реестра; пароля куратора и сопоставления с Bitbucket account ID нет.
Приветствие «С возвращением, <имя>» немодальное, не забирает фокус, закрывается вручную или через 5 секунд; без имени — «С возвращением».
Смена Git-аккаунта не меняет прикладную роль по hostname; реальная авторизация внешних записей остаётся у Bitbucket.
Реестр изменяет только главный УОР, читают УОР; полный реестр, checkout и кэш допуска не передаются frontend и не входят в обычный архив.

## 7 Транспорт API

Выбор агента: локальный Fastify JSON API с префиксом `/api/v1`; UTF-8, `Content-Type: application/json`, `Cache-Control: no-store` для сессии/команд.
Локальная сессия защищает обращения к процессу, но не является новой авторизацией человека: cookie HttpOnly/SameSite=Strict; разрешён только настроенный origin оболочки.
Изменяющие POST требуют привязанный к локальной сессии CSRF-токен из `/session`; значение не публикуется и не переносится архивом.
Все mutations, включая личные, проверяются сервером по зарегистрированной команде, области владения и состоянию допуска; скрытия кнопки недостаточно.
`curator`/`chief` изменяют содержание УОР в локальном пакете; viewer может менять собственные предпочтения/инструменты и получать доступные факты, не редактируя каталог УОР.
Непосредственно перед каждым push, повтором и каждой записью PR повторяются hostname и свежий допуск по 15; отказ даёт ноль попыток внешней записи.
Ранее проверенный собственный профиль допускает offline-черновики D-098; явный отзыв блокирует подготовку, сохраняя прежние данные.

| Capability | Viewer | Curator / chief | Граница эффекта |
| --- | --- | --- | --- |
| `business.read` | Да. | Да. | Общие предметные данные; без закрытой политики. |
| `capture.local` | Да. | Да. | Получение ОКО и собственная история; не ручная правка официального факта. |
| `calculation.local` | Да. | Да. | Сохранение производного основания/результата без нового факта или подтверждения. |
| `personal.write` | Да. | Да. | Свои предпочтения и данные зарегистрированных независимых инструментов. |
| `uor.prepare` | Нет. | Да, с допускаемым offline-профилем по 15. | Импорт, ручные факты/статусы, общие настройки и локальные черновики УОР. |
| `package.submit` | Нет. | Только со свежим gate каждой внешней записи. | Push/PR под реальными правами Bitbucket; не merge. |
| `publication.apply` | Да. | Да. | Применение проверенной публикации main по кнопке, а не её редактирование. |
| `workspace.backup` | Да. | Да. | Своё локальное рабочее место; без реестра, grant и сессий. |
| Изменение реестра / merge | Нет в обычном API. | Нет в обычном API. | Реестр обслуживает главный отдельно; merge выполняется в Bitbucket. |

HTTP POST сам по себе не означает `uor.prepare`: сервер выбирает capability по descriptor команды и проверяет собственную область данных.

| Общий тип | Нормативная форма |
| --- | --- |
| `Uuid` | UUIDv4; внутренние entityId, commandId, requestId и jobId. Git OID и внешние PR ID — отдельные строки. |
| `EntityRef` | `{entityType:string,id:Uuid}` из 16; тип зарегистрирован владельцем сущности. |
| `VersionRef` | EntityRef + `{revision:integer>=1}` из 16. |
| Числа | Предметные Decimal — канонические строки, вычисленные отношения — Rational 16; JSON number только для счётчиков/лимитов. |
| Время | Моменты — RFC3339 UTC; календарные даты — Date; отображение общих границ Europe/Moscow. |
| `RevisionToken` | Непрозрачная непустая строка состояния конкретного редактируемого ресурса; не заменяет VersionRef. |
| `PageRequest` | `{limit:integer 1..200,cursor:string\|null}`; по умолчанию 50/null. |
| `PageResult` | `{nextCursor:string\|null,hasMore:boolean}`; cursor привязан к контексту, фильтру и версии чтения. |

Успех: `{apiVersion:"1",requestId:Uuid,data:T,meta:Meta}`. `T` определяется зарегистрированным query/command, поля сверх схемы запрещены.
`Meta={generatedAt:Instant,publishedCommit:string|null,stateRevision:RevisionToken,warnings:Problem[],page?:PageResult}`.
Ошибка: `{apiVersion:"1",requestId:Uuid,error:Problem,meta:{generatedAt:Instant}}`; одновременно `data` и `error` запрещены.
`Problem={code:string,message:string,retryable:boolean,details:FieldProblem[],operationId:Uuid|null,provider:"git"|"bitbucket"|null}`.
`FieldProblem={path:string,code:string,message:string,ref:EntityRef|null}`; path — JSON Pointer входного поля, для общей ошибки пустая строка.
В ответах нет stack trace, секретов, содержимого реестра или командной строки с учётными данными. `requestId` возвращается также в `X-Request-ID`.

## 8 Маршруты и запросы

| Метод и путь | Вход | Выход `data` |
| --- | --- | --- |
| `GET /session` | Локальная сессия создаётся при её отсутствии; параметров нет. | SessionView, включая defaultContext; без полного реестра. |
| `POST /session/refresh` | `{}`; повтор чтения политики. | Собственная проекция; временная недоступность отражается policyState, а не ложным отзывом. |
| `POST /queries/:queryName` | Строгий QueryRequest конкретного запроса. | Зарегистрированный read model и Meta; чтение без скрытых mutations. |
| `POST /commands` | CommandRequest. | Синхронный CommandResult либо принятое асинхронное задание. |
| `POST /files` | Multipart: purpose=goal-import/evidence/workspace-restore и один file из браузерного file input, CSRF-токен. | 201: `{fileHandle:Uuid,name:string,mediaType:string,bytes:integer,sha256:string}` в общем envelope. |
| `GET /jobs/:jobId` | UUIDv4 задания. | JobSnapshot, доступный текущему локальному рабочему контексту. |

`POST /files` сохраняет поток в приватную локальную staging-область; не принимает абсолютный путь с клиента и не раздаёт каталог статически. Ограничения размера/форматов — 18; sha256 — 64 lowercase hex.
Handle связан с собственным рабочим местом и purpose: goal-import/evidence требуют uor.prepare, workspace-restore доступен всем для своего рабочего места. Это получение файла, не применение данных и не публикация вложения.
`SessionView={role:"viewer"|"curator"|"chief",displayName:string|null,personId:Uuid|null,policyState:"verified"|"offline_cached"|"unavailable"|"revoked"|"invalid",checkedAt:Instant|null,allowedCommands:string[],csrfToken:string,defaultContext:GlobalContext|null}`.
Если принятого каталога ещё нет, defaultContext=null: оболочка предлагает publication.check/apply без выдуманного ditId. После применения сервер возвращает допустимый контекст из каталога и личных настроек.
`QueryRequest={context:GlobalContext,filter:object,sort:Sort[],page:PageRequest}`; filter/Sort проверяются схемой конкретного query, произвольные поля/SQL не принимаются.
`Sort={field:string,direction:"asc"|"desc"}`; разрешённые field опубликованы descriptor запроса, стабильный последний ключ сортировки — ID.
Перечисленные фильтры имеют только указанные поля; остальные запросы принимают `filter={}`. ref — EntityRef, metricRef/captureRef/resultRef/factRef — VersionRef 16; Boolean — JSON true/false.

| `queryName` | Read model и поля специального фильтра |
| --- | --- |
| `context.options` | Допустимые кластеры/продукты/команды и цель; filter.search — строка до 200 символов. |
| `overview` | Сводка и строки внимания; filter.kind — goal/work/decision/data либо null. |
| `goals.list` / `goals.detail` | Названия, refs, результат, качество, согласование, причины; detail требует context.goalId. |
| `execution.list` / `execution.detail` | Работы/решения, зависимости, сроки; filter.ref для detail, filter.kind для списка. |
| `data.captures` / `data.rows` | Наборы и строки; rows требует filter.captureRef и layer raw/enriched; issuesOnly Boolean. |
| `data.lineage` | filter.resultRef либо factRef; refs строк/версий и объяснение преобразования. |
| `history.series` | filter.metricRef и granularity day/friday; WeeklyPoint 16 сохраняет sourceFactRef/sourceBusinessTime/sourceCapturedAt, carried и warning. |
| `snapshots.list` | Доступные согласованные срезы выбранной области/цели; ref, период, дата и PublicationAnchor. Для выбора разрешён snapshotId=null. |
| `uor.queue` / `uor.package` | Причины проверки, локальные изменения и состояние PR; только curator/chief. |
| `search` | filter.text — 1..200 символов; ref, имя, тип, контекст и маршрут карточки. |
| `notifications.list` | Собственные уведомления: filter.unreadOnly Boolean; ref причины, дата, прочтение и следующий переход. |
| `dashboards.view` / `forms.describe` | filter.ref либо formKind; готовые блоки/схемы полей, допустимые действия и editToken. |

Read model результата включает refs основания, displayValue/unit, состояние выполнения, качество/дату, подтверждение и доступные nextActions; числовой факт у ручной цели отсутствует. Нет готового расчёта — needs_calculation=true и resultRef=null, не фиктивный результат.
`nextAction={commandName:string|null,payload:object|null,route:string|null,label:string,enabled:boolean,disabledReason:string|null}`; payload имеет схему указанной команды, не разрешает обойти серверную проверку.

## 9 Команды и валидация

`CommandRequest={commandId:Uuid,name:string,baseRevision:RevisionToken|null,payload:object}`; неизвестные ключи отклоняются.
`baseRevision` берётся из editToken ресурса; обязателен для изменения существующего черновика. Для создания и добавочного получения данных допустим null.
`CommandResult={commandId:Uuid,result:object,changedRefs:EntityRef[],editToken:RevisionToken|null}`; result имеет схему конкретной команды.
Схемы полей предметных форм берутся из 16; таблица ниже определяет сценарий, а не второй набор CRUD-сущностей.

| `name` | Типизированный payload и эффект | Доступ / выполнение |
| --- | --- | --- |
| `preferences.set` | `{values:PersonalPreferences}`: context, сортировки, визуальные настройки и optional notificationPersonId:Uuid\|null; только личная область. | Все / sync. |
| `notifications.markRead` / `notifications.subscribe` | Чтение `{notificationIds:Uuid[]}` — ID событий из списка; подписка `{goalId:Uuid,subscribed:Boolean}`; только своё состояние, причина не закрывается. | Все / sync. |
| `<moduleId>.local.*` | Только явно зарегистрированная команда независимого инструмента, со своей схемой. | Собственные локальные данные / descriptor. |
| `source.capture` | `{goalId:Uuid}`; использует опубликованную настройку источника цели, сохраняет локальные наблюдения; не создаёт срез/подтверждение. | Все при доступности источника / async. |
| `calculation.prepare` | `{assignmentRef:VersionRef,businessTime:GlobalContext["time"]}` → `{basisRef:VersionRef,resultRef:VersionRef\|null}`; evaluatedAt явно передаёт evaluator сервер в EvaluationContext 16. | Все, доступное основание; чужой черновик не раскрывается / sync. |
| `draft.open` | `{entityType,ref:EntityRef\|null,packageId:Uuid\|null}`; результат `{draftId,objectId,entityRef,editToken}`; objectId=entityRef.id резервируется до заполнения формы. | Curator/chief / sync; без внешней записи. |
| `import.preview` / `import.apply` | preview: `{goalId,fileHandle}`; apply: `{previewToken,acceptedRowIds:Uuid[],acceptedCorrectionIds:Uuid[]}`; handle получен через POST /files. | Curator/chief / async; preview не меняет факты. |
| `goal.draft.save` / `assignment.draft.save` | `{draftId,definition}` с CoreGoalDefinition/GoalAssignment input 16. | Curator/chief / sync. |
| `method.draft.save` / `template.draft.save` | `{draftId,definition}` из схем методики/шаблона 16. | Curator/chief / sync. |
| `source.draft.save` / `fieldMapping.draft.save` | `{draftId,definition}` — PartialDraftInput<SourceDefinition>/PartialDraftInput<SourceFieldMapping> 16; поля/колонки по этим схемам, секреты отдельно по 18. | Curator/chief / sync. |
| `na.draft.save` / `organization.draft.save` | `{draftId,definition}` из N/A или справочника 16; нет ручного effectiveAt для назначения/оргсвязи. | Curator/chief / sync. |
| `manualGoal.transition` / `work.transition` | `{draftId,ref,targetState,reason,resultDescription}`; обязательность полей и допустимые состояния — 16. | Curator/chief / sync. |
| `work.draft.save` / `decision.draft.save` | `{draftId,definition}` соответствующей схемы 16. | Curator/chief / sync. |
| `fact.correct` / `result.confirm` | ManualCorrection: `{draftId,factKey,originalFactRefs:VersionRef[],replacement:Decimal,reason}`; Attestation: `{draftId,resultRef:VersionRef,comment:string,evidenceIds:Uuid[]}`; точные основания/допуск по 16. | Curator/chief / sync, только подготовка пакета. |
| `snapshot.save` | `{draftId,basisRef:VersionRef,resultRef:VersionRef\|null,manualStatusRef:VersionRef\|null,attestationRef:VersionRef\|null}`; ровно один resultRef/manualStatusRef; предложение AgreedSnapshot через PR. | Curator/chief / sync; не числовое подтверждение. |
| `comment.draft.save` | `{draftId,targetRef:EntityRef,text:string}`; Commentary 16, непустой текст и существующая/подготовленная в пакете цель ссылки. | Curator/chief / sync, через пакет. |
| `evidence.draft.save` | `{draftId,kind:"url",url:string}` либо `{draftId,kind:"file",fileHandle:Uuid}` purpose=evidence; сервер формирует Evidence/FileArtifactRef 16. | Curator/chief / sync, через пакет. |
| `goal.archive` / `goal.restore` | `{draftId,goalRef,reason}`; архивирование обратимо, история и связанные работы сохраняются. | Curator/chief / sync, общая редакция только через PR. |
| `dashboard.draft.save` / `customField.draft.save` | `{draftId,definition}` зарегистрированной схемы; без исполняемого кода. | Curator/chief / sync. |
| `reminders.draft.save` | `{draftId,definition}` общей конфигурации календаря/времени из 16; применяется через PR/main, default 09:00 Europe/Moscow. | Curator/chief / sync. |
| `package.preview` | `{packageId}`; сводка влияния, ошибки и previewToken точной редакции. | Curator/chief / async. |
| `package.submit` | `{packageId,previewToken}`; накопленная отправка/доработка PR по 18, без merge. | Curator/chief, свежий gate / async. |
| `package.refreshStatus` | `{packageId}`; сверить PR и PublicationAnchor, не менять роль по аккаунту. | Curator/chief / async. |
| `publication.check` / `publication.apply` | check `{}`; apply `{mainCommit}`; проверенное применение общего выпуска по 18. | Все / async. |
| `backup.create` | `{label:string\|null,includeOriginals:boolean}` → BackupCreateResult 18; политика допуска не переносится. | Все, своё локальное рабочее место / async. |
| `backup.restore.preview` | `{fileHandle:Uuid}` purpose=workspace-restore → RestorePreviewResult 18, включая restoreToken; рабочие данные не меняет. | Все, своё локальное рабочее место / async. |
| `backup.restore.apply` | `{restoreToken:string,confirmReplacement:true}` → RestoreApplyResult 18; replace после независимой rescue-копии, не неявное слияние. | Все, своё локальное рабочее место / async. |
| `job.cancel` / `job.retry` / `job.openAuth` | `{jobId}`; текущие guards исходной операции; openAuth запускает штатный внешний вход по 18, не принимает пароль. | По исходной операции / sync или async. |

Изменение definition сохраняет только черновик; новые MethodVersion и общие редакции публикуются через пакет, а не прямую запись в main.
draftId/packageId — UUIDv4, reason — непустая строка; ref/goalRef — EntityRef, resultRef/factRef — VersionRef точного основания. FileHandle — UUIDv4 принятого локального файла по 18, не путь с клиента.
Definition input содержит предметные поля типа 16 без верхнего Header: schemaVersion/id/revision/recordedAt/actor/publicationAnchorId назначает сервер; попытка записать этот Header даёт 422. Вложенные ID и schemaVersion RegisteredPayload сохраняют смысл схемы 16.
Для definition-команд *.draft.save применяется PartialDraftInput<T>: предметные поля могут отсутствовать, в том числе внутри составной формы; присутствующие значения проверяются по типам/enum, неизвестные ключи запрещены. Отсутствие поля не заменяется null или нулём.
Неполная форма сохраняется с result={draftId,entityRef,complete:boolean,problems:FieldProblem[]}; complete описывает структурную полноту, не подтверждение выполнения. Ссылка sourceId↔goalId может указывать на заранее выданные objectId одного пакета.
Полнота и все межобъектные ссылки обязательны при package.preview/submit; это не разрешение публиковать частичную сущность. Команды перехода состояния, fact.correct/result.confirm/snapshot.save сохраняют свои обязательные причины и инварианты, не PartialDraftInput.
snapshot.save проверяет basisRef и точную редакцию результата/ручного события; numericResult копирует сервер, не принимает расчёт из браузера. attestationRef необязателен и при наличии обязан совпасть по basisDigest: сохранение среза само по себе не создаёт Attestation.
calculation.prepare — локальная запись производных EvaluationBasis/CalculationResult по чистому evaluator 16; у manual_status resultRef=null. Один basisDigest переиспользует те же refs, не создаёт Capture, факт, точку истории, Attestation или PR. UI запускает её как стадию загрузки после capture/apply/preview при needs_calculation, без нового обязательного ритуала пользователя; query только читает, snapshot.save копирует точную готовую основу/результат в пакет.
Evidence URL — абсолютный http/https без встроенных учётных данных; файл проверяется по handle/hash/размеру 18, клиент не назначает FileArtifactRef. Срез, комментарий и evidence возвращают result={draftId,entityRef}; подготовленное становится общим только после PR/main.
PreviewToken — непрозрачная строка предпросмотра точной PackageRevision/main; acceptedRowIds/acceptedCorrectionIds содержат UUIDv4 строк/предложенных корректировок этого preview. Обозначение `local.*` не разрешает незарегистрированные имена.
acceptedCorrectionIds обозначает FileFactCorrectionCandidate 18 — новую редакцию ObservedFact, не ManualCorrection. Последняя создаётся только fact.correct с причиной; импорт не отменяет её молча.
restoreToken связывает hash архива, repo/установку и текущую редакцию заменяемых данных; срок и точные результаты — 18. Изменившаяся база даёт PREVIEW_STALE; apply требует нового preview, не latest-wins.
Личные подписки/прочтение принадлежат локальному рабочему месту; адресные уведомления связываются с personId при наличии собственного профиля. Привязка к Bitbucket account не вводится.
Техническое UX-предложение: optional PersonalPreferences.notificationPersonId — выбор себя из общего справочника для уведомлений, без обязательного входа. RecipientResolver берёт personId собственного registry-профиля, иначе эту настройку; без обоих использует подписки/рабочий контекст и не притворяется, что человек установлен.
notificationPersonId не меняет Header.actor, роль или ACL; выбор другого имени не расширяет общий доступ. Куратору с registry personId такой выбор не нужен; закрытый реестр viewer не выдаётся.
Проверки идут до эффекта: сессия/origin → descriptor → input schema → допуск/владение → revision → предметные инварианты → запись/очередь. Неактуальный editToken даёт 409 REVISION_CONFLICT, иной payload того же commandId — 409 IDEMPOTENCY_CONFLICT, неверный cursor — 409 CURSOR_STALE.
Перед фактической внешней записью и повтором выполняется новый gate; прежнее разрешение на queued job не даёт пожизненного допуска.
`commandId` обеспечивает идемпотентность: тот же ID+payload возвращает прежний результат/jobId; другой payload с тем же ID даёт 409.
Повтор чтения или команды не удаляет историю и не создаёт дубликат факта/PR. Точные ключи наблюдений и удалённых операций определены 16/18.

## 10 HTTP ошибки и асинхронные задания

| HTTP | Значение и обязательные коды |
| --- | --- |
| 200 / 201 | Успешное чтение/синхронная команда; 201 — создан fileHandle. Нулевой список не ошибка. |
| 202 | Задание принято: `data={jobId:Uuid,status:"queued"\|"running",pollAfterMs:1000}`. |
| 400 / 401 / 403 | Некорректный JSON/заголовок; нет локальной сессии; допуск/владение запрещает действие. |
| 404 | Неизвестный route/query/command либо недоступная по правилам ссылка. |
| 409 | Конфликт версии/идемпотентности; PREVIEW_STALE, REMOTE_STATE_UNKNOWN, EFFECTIVE_TIME_UNVERIFIED, RECOVERY_REQUIRED; GIT_AUTH_REQUIRED/PR_AUTH_REQUIRED требуют внешнего входа. |
| 413 / 422 | Превышен настроенный объём 18; либо поле/правило не прошло проверку, details содержит пути. |
| 429 / 503 | Очередь/источник ограничил запрос; либо сервис временно недоступен, ACCESS_RECHECK_REQUIRED. |
| 500 | Неожиданная ошибка; безопасное сообщение и operationId без чувствительных деталей. |

Коды SCHEMA_UNSUPPORTED, SOURCE_SCHEMA_CHANGED и INTEGRITY_MISMATCH сохраняются при передаче ошибок адаптеров 18; строка сообщения не заменяет код.
`jobId` равен operationId UUIDv4. `JobSnapshot={jobId,commandId,status,stage,progress,cancelAvailable,retryAvailable,result,error,warnings,nextAction,startedAt,finishedAt}`; nextAction имеет описанную выше схему либо null.
status сохраняет все состояния 18: queued/running/waiting_user/retry_wait/succeeded/partial/failed/cancelled/interrupted; stage — зарегистрированный код этапа, а не отдельный вариант API enum.
progress — `{completed:integer,total:integer|null,unit:string}`; cancelAvailable/retryAvailable — Boolean; warnings — Problem[]. Моменты startedAt/finishedAt nullable до соответствующего события.
Терминальные состояния — succeeded/partial/failed/cancelled; interrupted требует восстановления по 18. result — типизированный итог либо null, error — Problem либо null, одновременно оба не возвращаются.
У failed error обязателен; partial имеет result, warnings и error=null. Для незавершённого задания result=null, сведения о приостановке передаются предупреждениями. Отмена не скрывает уже выполненный эффект.
GET jobs опрашивается с pollAfterMs; смена экрана не отменяет работу. Обновления общего состояния через websocket не требуются.
job.cancel возвращает 200 CommandResult с result={jobId,cancelRequested:true}; job.openAuth — 200 с result={jobId,externalStepOpened:true}, не успешный push; job.retry — 202 для продолжения операции с повторными guards.
Отмена допустима только до обозначенной адаптером точки необратимости; поздняя отмена даёт 409, не выдаёт выполненную запись за отменённую.
Сетевой таймаут после возможной записи даёт REMOTE_STATE_UNKNOWN; retry сначала сверяет результат, не создаёт второй PR.
PublicationAnchor из 18 различает publicationState confirmed/unconfirmed и timeVerification verified/unknown. Проверенные commit/hash main позволяют current-применение; неизвестное mergedAt не блокирует чтение Git-only клиента.
Только операция, требующая точной исторической границы, блокируется EFFECTIVE_TIME_UNVERIFIED при timeVerification=unknown; pulledAt/authorDate не подменяют mergedAt. До confirmed-публикации предложение не активно.

### Интерактивный вход при отправке D-126

Подготовленные commit/ветка сохраняются. При Git-auth_required задание переходит в waiting_user, stage=git.auth; nextAction подписан «Открыть консоль для входа» и вызывает job.openAuth.
По действию пользователя TerminalRunner из 18 открывает реальную консоль либо штатный Git-login; пароль/ключ вводится там, приложение не получает и не сохраняет его.
После входа свежий pre-write gate перед передачей обязателен по 18; если его нельзя обеспечить без обхода корпоративных hooks, безопасная остановка/повтор сохраняет commit.
Успех push показывается только после exit code 0 и проверки remote; закрытая консоль или завершённый login сами по себе не являются успешной отправкой.
Git SSH/HTTPS-вход не означает авторизацию REST PR. На этапе PR.auth отдельный PR_AUTH_REQUIRED/provider=bitbucket оставляет waiting_user и переход к штатному входу адаптера.
Повтор продолжает тот же пакет/commit и сверяет уже выполненные эффекты: не создаёт новый push, пакет или PR без необходимости. Отмена ожидания сохраняет локальные commits.
Это техническое отображение AUTH_REQUIRED/provider git|bitbucket из 18 в GIT_AUTH_REQUIRED/PR_AUTH_REQUIRED интерфейса; HTTP 409 не означает потерю локальной сессии 401.

## 11 Два примера запросов

Синтетические UUID и данные иллюстрируют wire-контракт; запросы не выполнялись против продукта.

```http
POST /api/v1/queries/overview
Content-Type: application/json
```
```json
{"context":{"scopePath":{"ditId":"11111111-1111-4111-8111-111111111111","clusterId":null,"productId":null,"teamId":null},"goalId":null,"time":{"kind":"as_of","date":"2026-10-28"},"resultMode":"current","snapshotId":null},"filter":{"kind":"data"},"sort":[],"page":{"limit":50,"cursor":null}}
```
Ответ 200:
```json
{"apiVersion":"1","requestId":"22222222-2222-4222-8222-222222222222","data":{"summary":{"attentionCount":0},"items":[]},"meta":{"generatedAt":"2026-10-28T09:00:00Z","publishedCommit":null,"stateRevision":"view:1","warnings":[],"page":{"nextCursor":null,"hasMore":false}}}
```

```http
POST /api/v1/commands
Content-Type: application/json
X-CSRF-Token: synthetic-local-token
```
```json
{"commandId":"33333333-3333-4333-8333-333333333333","name":"source.capture","baseRevision":null,"payload":{"goalId":"44444444-4444-4444-8444-444444444444"}}
```
Ответ 202:
```json
{"apiVersion":"1","requestId":"55555555-5555-4555-8555-555555555555","data":{"jobId":"66666666-6666-4666-8666-666666666666","status":"queued","pollAfterMs":1000},"meta":{"generatedAt":"2026-10-28T09:00:01Z","publishedCommit":null,"stateRevision":"view:1","warnings":[]}}
```

## 12 Статический контракт PlatformModule

Выбор агента: manifest регистрируется при сборке общей поставки, а не загружается как произвольный исполняемый плагин.
`PlatformModule={id,version,platformContractVersion,dependsOn,owns,schemas,queries,commands,hooks}`; id соответствует `[a-z][a-z0-9-]*`, version — SemVer, platformContractVersion=1; dependsOn — ацикличный список ID зарегистрированных модулей.
`owns={entityTypes:string[],namespaces:string[]}`; пересечение владельцев запрещено. SchemaVersion, миграции и ограничения записи принадлежат модулю.
`queries` — descriptors `{name,inputSchema,outputSchema,handler}`; `commands` дополнительно объявляют effect local/sharedDraft/external, access и sync/async.
handler получает узкий контекст операции и свои порты, а не весь ApplicationContext, универсальную БД или произвольный SQL.
SchemaDescriptor={schemaId,schemaVersion,ownerModuleId,inputSchema}; schemaId имеет namespace модуля, schemaVersion — positive integer, ownerModuleId совпадает с manifest.id. Дубликат пары ID/version запрещён.
RegisteredPayload из 16 разрешается только через этот реестр: schemaId/schemaVersion выбирают валидатор value; неизвестный/неподдержанный schema ID даёт SCHEMA_UNSUPPORTED, без исполнения содержимого.

| Hook | Узкий интерфейс и ограничение |
| --- | --- |
| navigation | `{route,label,order,screen,accessHint}`; маршруты/labels уникальны, все поставленные модули зарегистрированы в общей навигации. |
| search | `search(query,context,page) -> SearchHit[]`; hit содержит ref, имя и route; прямой записи нет. |
| customFields | `describe(entityType)` и `validate(definition,value)`; единые схемы формы/таблицы/фильтра. |
| dashboard | `{blockType,settingsSchemaRef:{schemaId,schemaVersion},dataQuery,renderer}`; settings — RegisteredPayload 16, renderer читает read model без повторного расчёта. |
| source | `describe()`, `capture(input,jobContext)`; результат проходит принятие фактов владельцем данных по 16/18. |
| jobs | Описания стадий, cancellation/retry policy и handler конкретной операции; общий планировщик не знает бизнес-формул. |
| history | `list(ref,context,page)` и `lineage(ref)`; бессрочная история не удаляется из hook. |
| publication | `validateDraft`, `describeImpact`, `serializePackage`; внешний push/PR выполняет общий сервис 18. |
| backup | `describeOwnedData`, `exportSnapshot`, `validateRestore`, `restore`; допуск и закрытый реестр исключены. |
| exportLater | Зарезервированное чтение фиксированного результата и основания; отчётные форматы/PPTX первого выпуска не реализуются. |

Модуль читает чужие результаты через query-порт и меняет их только опубликованной командой владельца. Общая панель УОР не создаёт второй каталог фактов.
Registry/router валидируют descriptors и зависимости; они маршрутизируют, не содержат все бизнес-правила в одном god-module.
Чистый расчёт не читает сеть/диск/сессию. UI не получает SQL/Git/секреты, не пишет напрямую в namespaces и не вызывает служебный реестр.
PackageRevision и PublicationAnchor берутся из 18; anchor появляется после проверенного внешнего merge, не из premerge payload с придуманной датой.
Несовместимая версия manifest/схемы даёт SCHEMA_UNSUPPORTED с сохранением данных; общего автоматического удаления или fallback на старый пароль нет.

## 13 Граница проверки документа

Это контракт экранов, запросов и модулей, а не план реализации. Привязка к исходникам и исполняемые шаги оформляются после согласования дизайна.
Примеры JSON, матрицы и выбранные технические решения подлежат проверке по документу 19; работа реальных интеграций подтверждается отдельно по 18.
Приёмка должна различать проверку схемы, функциональный сценарий, внешнее подключение и проверку удобства с людьми; одно не доказывает остальные.
При подготовке выполнены чтение документов и package.json; код не изменён, продуктовые тесты не запускались, готовность реализации не заявляется.
