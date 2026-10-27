# Интерфейс и общий выпуск — Implementation Plan

> **Для агента:** выполнять по одной задаче с проверкой и коммитом. При наличии навыков применяйте superpowers:subagent-driven-development либо superpowers:executing-plans. Обычных файлов, Git и npm достаточно; Codex и специальные инструменты не обязательны.

**Goal:** собрать пять рабочих разделов на новом API, подключить записываемое ОКО и проверить общий выпуск с сохранением данных.

**Architecture:** React UI использует только v1 read models и команды. Старый entry остаётся рабочим до отдельного T39; после переключения старые парольные/публикационные маршруты недоступны из production.

**Tech Stack:** Node.js 22.16.0, npm 10.9.2, Python 3.13.5 для соответствующего адаптера; существующие React/TypeScript/Vite, Testing Library/Vitest и Playwright без замены зависимостей «на последние».

**Spec:** [17 — интерфейс/API](../../specs/2026-10-28-uor-workbench/17-interface-api-contract.md), [19 — AC](../../specs/2026-10-28-uor-workbench/19-acceptance-delivery-contract.md), [21 — ОКО](../../specs/2026-10-28-uor-workbench/21-oko-browser-scenarios.md), [общие имена](CONTRACTS.md).

## Global Constraints

- Все команды ниже выполняются из корня RM_UOR, в `codex/uor-workbench-rebuild`. Файлы Create — будущие файлы, а не существующая реализация.
- Читатель получает данные/проверенный main, меняет личные настройки, делает свою копию; содержание УОР готовит curator/chief. Hostname не связывается с Bitbucket account.
- UI не вычисляет проценты заново, не передаёт доверенную роль/hostname/результат и не создаёт факт чтением карточки.
- Согласованные основания неизменяемы, история бессрочна; main activation не требует REST timestamp каждого читателя.
- Новый интерфейс целиком включается только в T39. Ни query-параметра, ни production-флага для возврата старой парольной авторизации не создаётся.
- Условие выполнения, качество данных, текущий расчёт и согласованное подтверждение показываются раздельно.
- Синтетика не является банковским прогоном. Настоящие файлы/профили/снимки ОКО не коммитятся.

## Review Focus

1. Поздний HTTP-ответ после смены контекста не заменяет новую карточку; T30 `ignores_obsolete_context_response`.
2. Фоновое обновление не стирает незавершённое поле/фокус; T33 `retains_draft_and_focus_on_background_refresh`.
3. Внешний вход отменён после commit: интерфейс не теряет пакет и не пишет «PR создан»; T36 `shows_git_pushed_pr_auth_pending`.
4. Старый restoreToken и непустая база: никакого молчаливого объединения/замены; T38 `rejects_stale_restore_without_losing_input`.
5. Новый entry не оставляет legacy password route обходом hostname; T39 `production_entry_has_no_legacy_auth_or_release_write`.

## Общая проверка UI-задач

UI-тесты указывают `// @vitest-environment jsdom`, используют существующую Testing Library и Vitest. В каждом afterEach: unmount, cleanup, закрытие test app и восстановление spies/timers. Реальные browser tests остаются Node tests, используют текущий Playwright и локальный синтетический сервер; API mocks не подменяют итоговую проверку T40.

Глобальный UI контекст: `/overview`, `/goals`, `/goals/:id`, `/execution`, `/data`, `/uor`; scope/time/current-agreed сохраняются в URL и preferences. Детали URL и null defaultContext — 17. Все payload проверяются server-side.

### T30: API client, ошибки, контекст и тестовый мост

**Depends:** T10–T21, T22–T29 (зарегистрированные handlers и seed cases). **AC:** 20,29,45,48,53.

**Files:** Create `src/app/workbench/api-client.ts`, `context.tsx`, `route-state.ts`, `testing/api-harness.ts`, `api-client.test.ts`, `route-state.test.ts`; Modify `src/server/workbench/testing/test-application.ts` только для отсутствующих seed cases/тестового clientOrigin.

**Interfaces:** `WorkbenchClient` реализует K04; constructor `{fetch?:typeof fetch,baseUrl?:string}`. Дополнительно `.session():Promise<ApiSuccess<SessionView>>`, `.upload(file:File,purpose:'goal-import'|'evidence'|'workspace-restore')`. `WorkbenchApiError` хранит Problem/status/requestId. `WorkbenchProvider({client,children})`, `useWorkbench()`, `useGlobalContext()`. `createWorkbenchApiHarness(options)` оборачивает T13 test app через app.inject, сохраняет test cookie jar, requests и refs; реальный client использует browser credentials, не читает HttpOnly cookie.

Тестовый trace `RecordedRequest={method:string,url:string,headers:Record<string,string>,body:Record<string,unknown>|null}` сохраняет безопасный разобранный JSON теста; FormData описывается метаданными без bytes/секретов. Поэтому assertions body?.name в следующих задачах типизированы. Полные HTTP/auth логи реального пользователя этим не вводятся.

- [ ] Написать тесты `sends_csrf_and_preserves_problem`, `ignores_obsolete_context_response`, `normalizes_parent_scope_and_history`, с реальным v1 test app. Вектор:
  ```ts
  const h = await createWorkbenchApiHarness({role:'viewer',scenario:'scope-split'});
  await h.client.session();
  await h.client.command({commandId:randomUUID(),name:'preferences.set',baseRevision:null,payload:{values:{notificationPersonId:null}}});
  expect(h.requests.at(-1)?.headers['x-csrf-token']).toBeTruthy();
  expect(h.requests.at(-1)?.body).not.toHaveProperty('role');
  ```
  Отдельный управляемый delayed fetch отдаёт context A после B: активным остаётся B. Некорректный snapshot/current URL не превращается в согласованный срез.
- [ ] RED: `npm test -- src/app/workbench/api-client.test.ts src/app/workbench/route-state.test.ts`. Ожидается ошибка отсутствующего client/контекста, а не зависимостей окружения.
- [ ] Реализовать wire 17, X-CSRF-Token, FormData upload, typed errors, AbortController/sequence для устаревшего чтения. Не автоматически повторять неизвестную мутацию с новым commandId. Диапазон UI преобразуется в BusinessTime единственным адаптером.
- [ ] GREEN: повторить RED-команду и `npm run build`; exit 0. Проверить null defaultContext → предложение получить main, без придуманного ditId.
- [ ] Коммит:
  ```text
  git add src/app/workbench/api-client.ts src/app/workbench/context.tsx src/app/workbench/route-state.ts src/app/workbench/testing/api-harness.ts src/app/workbench/api-client.test.ts src/app/workbench/route-state.test.ts src/server/workbench/testing/test-application.ts
  git commit -m "feat(workbench): add typed client and persistent context"
  ```

### T31: Оболочка, роли, навигация, приветствие и уведомления

**Depends:** T30,T19. **AC:** 40,41,45,47,48,52,56.

**Files:** Create `src/app/workbench/WorkbenchShell.tsx`, `WorkbenchNavigation.tsx`, `WelcomeToast.tsx`, `NotificationCenter.tsx`, `workbench.css`, `testing/ui-harness.tsx`, `WorkbenchShell.test.tsx`.

**Interfaces:** `WorkbenchShell()` выбирает страницы по route-state; `createWorkbenchUiHarness(options)` возвращает api harness плюс `open(path):Promise<void>`, `close():Promise<void>`, requests/refs/client. open рендерит Provider+Shell через Testing Library. Дочерние страницы временно не импортируются до их задачи: registry получает зарегистрированные components, отсутствующий экран имеет явный development unavailable-view; production switch ждёт их всех.

- [ ] Добавить `reader_sees_common_navigation_without_curator_mutation`, `returns_focus_and_preserves_context`, `notification_identity_does_not_grant_role`:
  ```ts
  const h = await createWorkbenchUiHarness({role:'viewer',scenario:'scope-split'});
  await h.open('/overview');
  expect(await screen.findByRole('button',{name:'Данные'})).toBeTruthy();
  expect((screen.getByRole('button',{name:'Панель УОР'}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button',{name:'Отправить пакет в Bitbucket'})).toBeNull();
  expect(h.requests.some(r=>JSON.stringify(r.body).includes('password'))).toBe(false);
  ```
  Доступный reader capture проверяется T14/T32/T34; тест оболочки не зависит от ещё не созданной страницы. Различать видимость навигации и успешное банковское исполнение.
- [ ] RED: `npm test -- src/app/workbench/WorkbenchShell.test.tsx` → отсутствующий Shell/поведение.
- [ ] Реализовать пять пунктов 17: viewer видит объяснение недоступности УОР, curator/chief одинаковую панель; нет пароля/кнопки merge. Приветствие не перехватывает фокус, скрывается через 5 секунд или закрытием. Notification center вызывает markRead/subscribe; optional выбор человека — preference, не роль. CSS reflow 320px, таблицы локально прокручиваются.
- [ ] GREEN: та же команда + `npm run build`; проверить клавиатуру/объявление ошибок и отсутствие потери контекста. Таймер greeting проверить fake timers внутри shell-сценария без отдельной задачи.
- [ ] `git add src/app/workbench/WorkbenchShell.tsx src/app/workbench/WorkbenchNavigation.tsx src/app/workbench/WelcomeToast.tsx src/app/workbench/NotificationCenter.tsx src/app/workbench/workbench.css src/app/workbench/testing/ui-harness.tsx src/app/workbench/WorkbenchShell.test.tsx`; `git commit -m "feat(workbench): add role-aware shell and notifications"`.

### T32: Обзор, список и карточка цели

**Depends:** T31,T21,T07–T09. **AC:** 01–09,12–16,20,29,48,51,53.

**Files:** Create `src/features/overview/workbench/OverviewPage.tsx`, `GoalsPage.tsx`, `GoalDetailPage.tsx`, `ResultSummary.tsx`, `BasisInspector.tsx`, `goal-views.test.tsx`; Modify `src/app/workbench/WorkbenchShell.tsx` для регистрации маршрутов.

**Interfaces:** `WorkbenchOverviewPage()`, `WorkbenchGoalsPage()`, `WorkbenchGoalDetailPage({goalId:string})`; queries overview/goals.list/detail/history.series/data.lineage. Числа/состояния из read model, не второй evaluator в React.

- [ ] Написать `shows_independent_scopes_and_no_false_confirmation`, `shows_cache_date_and_carried_warning`, `reads_agreed_without_current_recalculation`. В scope-split после открытия цели проверить факт ДИТ 92%/порог90%, кластер88%/порог95%, разные результаты; отсутствие Attestation не подписывать «Подтверждено УОР». В manual-goal числового 0% нет.
  ```ts
  await h.open('/goals/'+h.refs.goal.id); // h: role viewer, scenario scope-split
  expect(await screen.findByText('92%')).toBeTruthy();
  expect(screen.getByText('88%')).toBeTruthy();
  expect(screen.queryByText('Подтверждено УОР')).toBeNull();
  ```
- [ ] RED: `npm test -- src/features/overview/workbench/goal-views.test.tsx`.
- [ ] Реализовать обзор исключений → цель → причина/ответственный/следующий шаг → источники/работы/история. Переключение current/agreed требует snapshotId и сохраняет scope. Предварительный балл, пропуски и устаревание подписаны отдельно; stale-clock overlay приходит от сервера. История пятничной проекции не создаётся клиентом.
- [ ] GREEN: та же команда + `npm run build`. Дополнительно fixture population-gap показывает B в списке недостающих; неизвестное mergedAt не запрещает current confirmed main.
- [ ] `git add src/features/overview/workbench/OverviewPage.tsx src/features/overview/workbench/GoalsPage.tsx src/features/overview/workbench/GoalDetailPage.tsx src/features/overview/workbench/ResultSummary.tsx src/features/overview/workbench/BasisInspector.tsx src/features/overview/workbench/goal-views.test.tsx src/app/workbench/WorkbenchShell.tsx`; `git commit -m "feat(workbench): add goals and traceable result views"`.

### T33: Простой конструктор цели и методики

**Depends:** T32,T17,T20. **AC:** 05–12,14–16,45,49,52,55.

**Files:** Create `src/features/goal-setup/workbench/GoalSetupWizard.tsx`, `MethodEditor.tsx`, `PopulationEditor.tsx`, `ApplicabilityEditor.tsx`, `goal-setup.test.tsx`; Modify `src/features/overview/workbench/GoalDetailPage.tsx` для открытия своего черновика.

**Interfaces:** `WorkbenchGoalSetupWizard({goalRef?:EntityRef,onClose:()=>void})`; draft.open → PartialDraftInput save → package.preview; состояние незавершённой формы хранится по draftId, а не во временном DOM.

- [ ] Написать `saves_incomplete_without_zero_defaults`, `retains_draft_and_focus_on_background_refresh`, `rejects_publish_without_population_and_result`, `template_change_preserves_standalone`.
  ```ts
  const h = await createWorkbenchUiHarness({role:'curator',scenario:'population-gap'});
  await h.open('/goals/'+h.refs.goal.id);
  fireEvent.click(await screen.findByRole('button',{name:'Настроить цель'}));
  expect(await screen.findByLabelText('Режим измерения')).toBeTruthy();
  expect(screen.queryByLabelText('Дата начала действия')).toBeNull();
  ```
  В тесте сохранить неполный текст, получить фоновое обновление и убедиться, что текст и активное поле сохранились; preview возвращает список конкретных ошибок, текущая общая цель не меняется.
- [ ] RED: `npm test -- src/features/goal-setup/workbench/goal-setup.test.tsx`.
- [ ] Реализовать последовательные шаги: название/источник/измерение → область и ожидаемый состав → шаблон/самостоятельная методика → показатели/условия/веса/давность → пример/влияние. Начальные операторы только 16, неподдержанный formulaId не подменяется средним. Ручное завершение требует результата, возврат — причины. N/A имеет область/период/причину; дата действия назначения всегда publication.
- [ ] GREEN: тот же test + `npm run build`; проверить server 422 отражается рядом с соответствующим полем, draft не стёрт.
- [ ] `git add src/features/goal-setup/workbench/GoalSetupWizard.tsx src/features/goal-setup/workbench/MethodEditor.tsx src/features/goal-setup/workbench/PopulationEditor.tsx src/features/goal-setup/workbench/ApplicabilityEditor.tsx src/features/goal-setup/workbench/goal-setup.test.tsx src/features/overview/workbench/GoalDetailPage.tsx`; `git commit -m "feat(workbench): add guided goal and method configuration"`.

### T34: Источники, импорт, исходные и обогащённые строки

**Depends:** T31,T14–T17,T21. **AC:** 20–25,30,49,52,55.

**Files:** Create `src/features/sources/workbench/WorkbenchDataPage.tsx`, `SourceSetupWizard.tsx`, `MappingEditor.tsx`, `ImportPreview.tsx`, `LineagePanel.tsx`, `data-views.test.tsx`; Modify `src/app/workbench/WorkbenchShell.tsx` (маршрут /data).

**Interfaces:** `WorkbenchSourceSetupWizard({sourceRef?:EntityRef,goalRef:EntityRef,onClose:()=>void})`; POST /files purpose goal-import; import.preview/apply с selected IDs. В T46 в этот точный файл встраивается BrowserScenarioWizard, здесь не создаётся второй recorder.

- [ ] Написать `accepts_selected_valid_rows_and_keeps_rejections`, `shows_source_and_enriched_layers_without_mutating_raw`, `preserves_manual_override_on_file_revision`. partial-file: 3 приняты/1 отклонена, причина доступна; повтор apply не даёт шести фактов.
  ```ts
  // Arrange partial-file; выбрать 3 корректные строки и применить через UI.
  expect(await screen.findByText('Принято: 3; не принято: 1')).toBeTruthy();
  expect(screen.getByRole('region',{name:'Непринятые строки'})).toBeTruthy();
  expect(h.requests.filter(r=>r.body?.name==='result.confirm')).toHaveLength(0);
  ```
- [ ] RED: `npm test -- src/features/sources/workbench/data-views.test.tsx`.
- [ ] Реализовать смену raw/enriched, sheet/column mapping, явный parsingProfile и diff «было/станет». Плохая дата не превращается в ноль/сегодня. Qlik-цель не получает кнопку «использовать Excel при ошибке»; скачивание браузером CSV всё ещё ОКО. Source и mapping changes — черновик/PR, direct capture — локальные факты.
- [ ] GREEN: та же команда + `npm run build`; проверить scope сохранился при переходе из цели в lineage, непринятые строки можно исправить/дозагрузить.
- [ ] `git add src/features/sources/workbench/WorkbenchDataPage.tsx src/features/sources/workbench/SourceSetupWizard.tsx src/features/sources/workbench/MappingEditor.tsx src/features/sources/workbench/ImportPreview.tsx src/features/sources/workbench/LineagePanel.tsx src/features/sources/workbench/data-views.test.tsx src/app/workbench/WorkbenchShell.tsx`; `git commit -m "feat(workbench): add source mapping and transparent import views"`.

### T35: Работы, риски, зависимости и запросы решений

**Depends:** T31,T18–T19. **AC:** 46–48,52.

**Files:** Create `src/features/execution/workbench/ExecutionPage.tsx`, `WorkEditor.tsx`, `DecisionEditor.tsx`, `DependencyView.tsx`, `execution-views.test.tsx`; Modify `src/app/workbench/WorkbenchShell.tsx`.

**Interfaces:** `WorkbenchExecutionPage()`; handlers work.transition/work.draft.save/workDependency.draft.save/decision.draft.save. Один Work.id отображается из разных целей, а не копируется.

- [ ] Написать `cancel_blocker_requires_replacement_or_reasoned_unlink`, `reopen_preserves_previous_completion`, `forecast_never_changes_planned_deadline`. Запросить отмену без причины → ошибка/сохранённый ввод; добавить причину и снятие зависимости → пакет готов, прежний план неизменён.
  ```ts
  // Arrange Work dueOn=2026-11-05; изменить только forecastOn на2026-11-12.
  expect((screen.getByLabelText('Плановый срок') as HTMLInputElement).value).toBe('2026-11-05');
  expect((screen.getByLabelText('Прогноз') as HTMLInputElement).value).toBe('2026-11-12');
  expect(screen.queryByRole('button',{name:'Подтвердить цель'})).toBeNull();
  ```
- [ ] RED: `npm test -- src/features/execution/workbench/execution-views.test.tsx`.
- [ ] Реализовать состояния 16, риск отдельно от state, план отдельно от forecast. Схема зависимости показывает ответственного/затронутые цели; прогнозы куратор правит явно. Ответ решения и answeredAt заполняются вместе. Viewer читает всё без кнопок общей правки.
- [ ] GREEN: тот же test + `npm run build`; новый timezone clock выдаёт просрочку с 00:00 Москвы, календарь не переносит срок.
- [ ] `git add src/features/execution/workbench/ExecutionPage.tsx src/features/execution/workbench/WorkEditor.tsx src/features/execution/workbench/DecisionEditor.tsx src/features/execution/workbench/DependencyView.tsx src/features/execution/workbench/execution-views.test.tsx src/app/workbench/WorkbenchShell.tsx`; `git commit -m "feat(workbench): connect works decisions and dependency actions"`.

### T36: Панель УОР, накопленный пакет и внешний вход Git

**Depends:** T31,T17,T22–T26. **AC:** 26–33,40–43,55.

**Files:** Create `src/features/publishing/workbench/CuratorPanel.tsx`, `PackageDiff.tsx`, `PublishOperation.tsx`, `curator-panel.test.tsx`; Modify `src/app/workbench/WorkbenchShell.tsx`.

**Interfaces:** `WorkbenchCuratorPanel()`; package.preview/submit/refreshStatus и job.openAuth/cancel/retry; API сообщает фактический этап, UI не считает закрытие консоли успехом.

- [ ] Написать `shows_git_pushed_pr_auth_pending`, `keeps_commits_after_auth_cancel`, `chief_has_same_panel_and_no_merge_action`:
  ```ts
  // test provider: Git push accepted; Bitbucket REST requests auth
  expect(await screen.findByText('Коммиты отправлены, PR ожидает входа')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Слить в main'})).toBeNull();
  expect(screen.queryByLabelText(/пароль/i)).toBeNull();
  ```
  После job.retry число созданных PR не больше одного; при policy revoke поле reason и пакет сохранены, нет попытки remote write.
- [ ] RED: `npm test -- src/features/publishing/workbench/curator-panel.test.tsx`.
- [ ] Реализовать очередь зоны как фильтр, сводку «было/станет/влияние», точную preview revision, отдельные commit/push/PR статусы и ссылку на настоящий Bitbucket PR. Ритм накопления не меняется сохранением комментария. Ручной вход только во внешнем штатном окне, app не принимает пароль.
- [ ] GREEN: тот же test + `npm run build`; проверить оба curator/chief и offline-draft. Обновление состояния после внешнего merge не создаёт новый PR.
- [ ] `git add src/features/publishing/workbench/CuratorPanel.tsx src/features/publishing/workbench/PackageDiff.tsx src/features/publishing/workbench/PublishOperation.tsx src/features/publishing/workbench/curator-panel.test.tsx src/app/workbench/WorkbenchShell.tsx`; `git commit -m "feat(workbench): add accumulated publishing workflow"`.

### T37: Конструктор дашбордов, поля и общий поиск

**Depends:** T31–T33,T20–T21. **AC:** 45,48,49,51,52,56.

**Files:** Create `src/features/dashboards/workbench/DashboardBuilder.tsx`, `DashboardView.tsx`, `CustomFieldEditor.tsx`, `src/features/search/workbench/GlobalSearch.tsx`, `src/features/dashboards/workbench/dashboard-ui.test.tsx`; Modify `src/app/workbench/WorkbenchShell.tsx`.

**Interfaces:** schemas/form descriptors 17; команды dashboard/customField/customFieldValue draft.save и preferences.set. Новый вид блока — кодовый модуль следующего выпуска, не eval произвольной строки.

- [ ] Написать `reorders_blocks_by_keyboard_and_validates_settings`, `field_value_uses_its_versioned_type`, `search_opens_archived_card_in_context`. Добавить Decimal-поле, ошибочная дата/строка не проходит numeric validator; правильное значение видно в таблице/фильтре, не меняет formula inputs.
  ```ts
  // После ввода "не число" в Decimal-поле и попытки проверки.
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('число'));
  expect(h.requests.filter(r=>r.body?.name==='package.submit')).toHaveLength(0);
  ```
- [ ] RED: `npm test -- src/features/dashboards/workbench/dashboard-ui.test.tsx`.
- [ ] Реализовать пять зарегистрированных блоков, точные layout/settings 17, клавиатурный порядок без обязательного drag. Общий dashboard — черновик/PR; личный вид — preferences. Search охватывает цели/продукты/лидеров/работы/решения; открывает canonical ref и контекст, не создаёт копию.
- [ ] GREEN: тот же test + `npm run build`; viewer меняет личный вид, HTTP не даёт ему изменить общий dashboard.
- [ ] `git add src/features/dashboards/workbench/DashboardBuilder.tsx src/features/dashboards/workbench/DashboardView.tsx src/features/dashboards/workbench/CustomFieldEditor.tsx src/features/search/workbench/GlobalSearch.tsx src/features/dashboards/workbench/dashboard-ui.test.tsx src/app/workbench/WorkbenchShell.tsx`; `git commit -m "feat(workbench): add dashboard builder fields and global search"`.

### T38: Обновление, копия и перенос из интерфейса

**Depends:** T31,T26–T29. **AC:** 29,43–45,50–54.

**Files:** Create `src/features/workspace-maintenance/workbench/MaintenancePanel.tsx`, `RestorePreview.tsx`, `maintenance-ui.test.tsx`; Modify `src/app/workbench/WorkbenchShell.tsx` (обслуживание из меню, не шестой основной раздел).

**Interfaces:** publication.check/apply; backup.create/restore.preview/restore.apply; source of success — JobSnapshot, а не нажатие кнопки. Вход restore только fileHandle purpose workspace-restore.

- [ ] Написать `rejects_stale_restore_without_losing_input`, `shows_rescue_before_replace`, `reader_applies_verified_main_without_rest_timestamp`. Изменить БД после preview → PREVIEW_STALE; apply не выполнен, выбранный архив/ошибка видны. После нового preview и подтверждения есть rescue backupId.
  ```ts
  // При PREVIEW_STALE сервер не заменил данные, UI требует новый preview.
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('предпросмотр'));
  expect(screen.getByRole('button',{name:'Проверить архив'})).toBeTruthy();
  expect(screen.queryByText('Восстановление завершено')).toBeNull();
  ```
- [ ] RED: `npm test -- src/features/workspace-maintenance/workbench/maintenance-ui.test.tsx`.
- [ ] Реализовать сводку обновления и restore counts/warnings, явное подтверждение замены, progress/cancelAvailable, восстановление после перезапуска. Основное «Создать копию» посылает includeOriginals=true; неполный архив возможен только явным дополнительным выбором с предупреждением omissions. Скачать архив через защищённый backups/:id/file, evidence — через artifacts/:id, без серверного абсолютного пути. RECOVERY_REQUIRED показывает запрет записи и следующий безопасный шаг. Архив не обещает перенос логина/роли; old rescue доступен в списке копий.
- [ ] GREEN: тот же test + `npm run build`; текущие личные настройки/история не теряются при обычном main update.
- [ ] `git add src/features/workspace-maintenance/workbench/MaintenancePanel.tsx src/features/workspace-maintenance/workbench/RestorePreview.tsx src/features/workspace-maintenance/workbench/maintenance-ui.test.tsx src/app/workbench/WorkbenchShell.tsx`; `git commit -m "feat(workbench): add reviewable maintenance and restore flow"`.

### T39: Переключение рабочего запуска без старого обхода доступа

**Depends:** T01–T38,T42–T47. Это отдельный gate после проверенных библиотек/UI, без production legacy-toggle. **AC:** 40–45,50–55.

**Files:** Modify `src/server/main.ts` (createApp import/boot), `src/app/main.tsx` (App → Workbench provider/shell), `scripts/dev.mjs` (readiness/IPC integration), `src/server/workbench/app.ts`, `src/domain/app-version.ts`, `package.json`, `package-lock.json`; Create `src/server/workbench/bootstrap.ts`, `src/server/workbench/testing/production-entry.ts`, `src/server/workbench/cutover.test.ts`, `scripts/workbench/runtime-smoke.ts`.

**Interfaces:** `createWorkbenchRuntime({projectRoot}):Promise<WorkbenchApplicationDeps>` связывает private site config, repository, policy, modules и T27 update lifecycle. `main.ts` запускает только createWorkbenchApp, host127.0.0.1; React main — только новый Shell. Старые createApp/helpers остаются для проверок прежнего формата/миграции, но production entry их не регистрирует.

`startProductionEntry({codeRoot,workspaceRoot,apiPort,clientPort})` — test-only helper: отдельный child импортирует настоящий src/server/main.ts, а не factory напрямую. TSX берётся через import.meta.resolve из codeRoot; аргументы передаются массивом, cwd — синтетическая workspaceRoot с собственным site config. Возвращает origin/stop, не останавливает чужие процессы. Smoke использует этот helper и создаёт только свою проверочную папку под .runtime/validation.

- [ ] Написать `production_entry_has_no_legacy_auth_or_release_write`, `boots_empty_without_fake_dit_or_curator`, `ipc_candidate_is_closed_until_activation`:
  ```ts
  const child = await startProductionEntry(testPaths);
  expect((await fetch(child.origin+'/api/v1/session')).status).toBe(200);
  expect((await fetch(child.origin+'/api/state')).status).toBe(404);
  expect((await fetch(child.origin+'/api/identity/login',{method:'POST'})).status).toBeGreaterThanOrEqual(400);
  ```
  Дополнительно перечислить все реальные старые mutation paths из `src/server/app.ts` и feature routes, получить их статус404/410; не ограничиваться двумя иллюстративными адресами. Старый cookie/password не открывает curator capability нового API.
- [ ] RED: `npm test -- src/server/workbench/cutover.test.ts`.
- [ ] Реализовать bootstrap и переключение. Новый boot не открывает второй SQLite с обходом gate; recovery/quiesce/IPC из T27 работают до приёма запросов. Кандидат целевой версии — **0.5.0** (технический выбор плана, не объявление выпуска): `npm version 0.5.0 --no-git-tag-version`, такое же значение APP_VERSION; schema migrations остаются отдельно версионированы.
- [ ] GREEN: тот же test, `npm run build`, `npm run smoke:workbench -- --root .runtime/validation/workbench-smoke` на Node22.16.0. Smoke создаёт свою синтетическую workspace/config/БД и слушает отдельные порты, проверяет session/пустой-каталог/остановку/повторный запуск; код берётся из checkout, рабочая .runtime не копируется и Git/ОКО не вызываются. Уже непустая чужая папка — отказ, не рекурсивная очистка.
- [ ] `git add src/server/main.ts src/app/main.tsx scripts/dev.mjs src/server/workbench/app.ts src/domain/app-version.ts src/server/workbench/bootstrap.ts src/server/workbench/testing/production-entry.ts src/server/workbench/cutover.test.ts scripts/workbench/runtime-smoke.ts package.json package-lock.json`; `git commit -m "feat(workbench): activate new runtime and close legacy write entrypoints"`.

### T40: Сквозной локальный browser/runtime прогон

**Depends:** T39,T47. **AC:** 01,07,10–16,20–34,40–56. Это проверка новой цепочки, не замена focused unit/API tests.

**Files:** Create `tests/workbench/full-flow.test.ts`, `tests/workbench/browser-flow.test.ts`, `tests/workbench/helpers/runtime.ts`, `tests/workbench/helpers/browser.ts`; Modify `package.json` для `test:workbench:e2e`.

**Interfaces:** helpers запускают настоящий новый API с синтетическими портами и frontend Vite, fixture goal data и отдельной runtimeRoot. Используют текущий Playwright, без обязательного @playwright/test. Порты по умолчанию API53941/UI53942, разрешённые origin ровно соответствуют им; переопределение test env валидируется. Занятый порт → PORT_IN_USE, чужой процесс не завершается.

- [ ] Написать `full_capture_enrich_draft_pr_merge_apply_second_client` и `ui_keyboard_mobile_import_and_auth_cancel`. Два независимых runtime с общей синтетической Git/Bitbucket-службой: curator PR принят → reader применил main → одинаковый publication identity/другая appliedAt → agreed не переписан. Git/auth/network failures вводятся локальными fixtures, не реальными учётными данными.
  ```ts
  expect(readerCurrent.publishedCommit).toBe(curatorMerged.mainCommit);
  expect(readerAgreed.basisDigest).toBe(beforeRefreshAgreed.basisDigest);
  expect(fakeBitbucket.createdProposalIds).toHaveLength(1);
  expect(fakeSource.realBankRequests).toBe(0);
  ```
  Имена обозначают явные результаты шагов test driver, не глобальные переменные продукта.
- [ ] RED: `npm test -- tests/workbench/full-flow.test.ts tests/workbench/browser-flow.test.ts` (до реализации helpers/сценариев).
- [ ] Реализовать тестовые drivers: истинные HTTP/SQLite/скачивание/браузерные события; fake только внешние провайдеры. Снять screenshot overview/goal/data/package/restore на1024/360/320px в `test-results/workbench/`, проверить keyboard focus и отсутствие root horizontal overflow вне таблицы. Никаких снимков реального банковского источника.
- [ ] GREEN: `npm run build`, `npm run test:workbench:e2e`; exit0, реальные артефакты по каждому заявленному сценарию. Отсутствие браузера — ENVIRONMENT_NOT_VERIFIED, не PASS. Один полный `npm test` после стабилизации; старые baseline failures не приписывать новой версии молча.
- [ ] `git add tests/workbench/full-flow.test.ts tests/workbench/browser-flow.test.ts tests/workbench/helpers/runtime.ts tests/workbench/helpers/browser.ts package.json`; `git commit -m "test(workbench): prove full local workflow and responsive paths"`.

### T41: Банковская приёмка, перенос и комплект общего выпуска

**Depends:** T40,T48,BP-01–BP-06. Если входов банка нет, статус BLOCKED_BANK_INPUT только у этого gate; подготовка локальных задач завершена отдельно. **AC:** все48, реальные BP.

**Files:** Create `docs/releases/workbench-candidate.md`, `docs/guides/workbench-curator.md`, `docs/guides/workbench-reader.md`, `docs/guides/workbench-recovery.md`, `docs/validation/workbench-acceptance.md`; Modify `README.md`, `AGENTS.md`, `docs/agents/START_HERE.md`, `docs/MASTER_SPEC.md`, `docs/architecture/module-map.md`, `docs/VALIDATION.md`, `docs/remaining-work.md`.

**Interfaces:** evidence schema/paths и команды probe:bank/probe:readiness созданы T29; точные профили и опасные шаги — часть05. Реальные входы не входят в Git. Пакет выполнения фиксирует revision приложения/контрактов и manifest проверяемого переноса.

- [ ] До реализации финальных исправлений составить отчёт по всем AC/BP с источником результата. Реальный куратор проверяет выбранную цель: исходный файл → продукт/лидер → результат → комментарий/пакет → main на втором ноутбуке; количество перенесённых/проблемных записей сверяется. Если ожидание расходится, сначала зафиксировать regression test соответствующего владельца, не менять ожидаемый бизнес-результат ради зелёного статуса.
  ```ts
  expect(readiness.required).toEqual(['BP-01','BP-02','BP-03','BP-04','BP-05','BP-06']);
  expect(readiness.blocked).toEqual([]);
  expect(readiness.ready).toBe(true); // checker проверяет bankVerified у реальных reports
  ```
- [ ] Запустить `npm run probe:readiness -- --reports .runtime/probe-reports --require BP-01,BP-02,BP-03,BP-04,BP-05,BP-06`; до реальных BP ожидается ненулевой exit с конкретными missing/failed, а не ложная готовность.
- [ ] Исправить выявленное в owning task и обновить документацию: обычный запуск, роли/hostname, сценарий ОКО, PR-цикл, обновление, копия/восстановление, добавление модуля. Задокументировать реальный runtime/сертификаты/получение package/cancel. Не переносить приватные evidence в публичную документацию.
- [ ] После успешных обязательных проверок повторить только затронутые tests; общий build и readiness. Отчёт содержит команды/exit/runtime/commit/ограничения, а не старые числа тестов. Общий запуск сразу для примерно100 сотрудников, без отдельного pilot-флага; до него нужен принятый перенос и проверенная rescue/backup.
- [ ] Коммит перечисленных документационных файлов: `git add docs/releases/workbench-candidate.md docs/guides/workbench-curator.md docs/guides/workbench-reader.md docs/guides/workbench-recovery.md docs/validation/workbench-acceptance.md README.md AGENTS.md docs/agents/START_HERE.md docs/MASTER_SPEC.md docs/architecture/module-map.md docs/VALIDATION.md docs/remaining-work.md`; `git commit -m "docs(workbench): record verified release and operator runbooks"`.
- [ ] `git push origin codex/uor-workbench-rebuild` публикует только проверенные код/документы без банковских данных. Слияние разработки в main и корпоративный rollout требуют отдельного явного решения владельца; план сам их не выполняет.

## После каждой задачи

Записать в PROGRESS.md task ID/commit, точные команды и exit, AC, данные теста, незавершённый шаг и следующее действие. Ошибка не снимается отметкой «всё хорошо»: остановить зависимые задачи, сохранить черновик/исходную БД, исправить owning module и повторить его проверки. Полный прогон не повторять после каждого текстового изменения; расширять его при изменении поведения/новом сбое.
