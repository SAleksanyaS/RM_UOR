# Завершение личного ОКО и browser reliability

Дата: 2026-11-01. Основа: утверждённый reference checkpoint `32106a9`, completion plan. Только существующий production Workbench runtime, собственные синтетические fixtures, Node **22.16.0**, не более двух Vitest workers. Пользовательская установка и её данные не использовались. Ни общий import pipeline, ни shared storage, ни набор ролей не заменены.

## Что изменено

- **F11:** общий `connectors/browser.ts` всегда передаёт `chromiumSandbox: true` как установленному Chrome/Edge, так и injected launcher. Отказ не запускает повтор с ослабленной защитой. Сообщение объясняет проверку браузера, профиля и sandbox ОС. TLS-проверка, точные origins, блокировка service workers и ограничение downloads сохраняются.
- **Личное право читателя:** только метаданные команд `oko.workflow.*` используют `personal.write`; production composition явно выбирает ту же capability для внутреннего workflow guard. По умолчанию сервис и прежний namespace `source.browser` сохраняют `uor.prepare`. Общая identity policy не менялась. Проверяются личный владелец, CAS и повторная проверка владельца после browser I/O. Читатель может создать собственный сценарий, настроить собственный профиль, записать и повторить выгрузку; общий browser draft/setup и package submission не становятся доступными.
- **Ежедневный экран и настройка:** UI следует разрешённым командам; отдельная проверка `role !== viewer` больше не скрывает разрешённую личную запись. Настройка остаётся mounted при сворачивании. Автозавершение скачанной записи ждёт окончания текущей команды и не отправляется повторно для того же recordingId.
- **Восстановление:** «Проверить сохранённое состояние» проверяет квитанцию исходного commandId и собственное задание. Эта кнопка не создаёт новую мутацию. Незавершённые команды, чужой владелец и чужой namespace не превращаются в успех. Сохранённый ввод остаётся до явного решения пользователя; общий `useUnsavedChanges` защищает смену сценария/уход, но сворачивание настроек не сбрасывает форму.
- **Состояния:** видны серверный статус, имеющиеся stage/progress, ручной вход и разрешённые действия cancel/retry/nextAction. Неизвестные stage/code сохраняются в техническом disclosure. Стадии и счётчики не имитируются таймером. Ошибка не заменяет предыдущий результат. Пустой файл обозначен отдельно и не доказывает полноту. Отмена первого получения не обещает несуществующий прежний результат. Старый результат по-прежнему показывает точные сохранённые headers/values, не текущую mapping как историческую provenance.
- **E35:** picker ждёт как открытие окна, так и завершение/отказ своей операции. Fixture имеет deadline/abort и закрывает свой browser runtime, listener и временную папку в `finally`. Wrapper ограничивает ожидание; завершает только свою process group на POSIX или своё PID tree через `taskkill /T` на Windows. Native тест не подменён успешным мок-ответом.

## RED / GREEN: фактические прогоны

Все перечисленные Vitest-команды запускались с

```sh
PATH=/workspace/scratch/ab925b2abe56/redesign/runtime/node-v22.16.0-linux-x64/bin:$PATH
node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2 --minWorkers=1
```

TCP/browser-вызовы выполнялись вне ограниченного shell sandbox в разрешённом режиме, только на собственных временных данных. Первый запуск F11 в ограниченном sandbox завершил assertions, но завис в teardown; остановлен с exit130 и не считается итоговой проверкой.

| Проверка | RED | GREEN / доказательство |
| --- | --- | --- |
| Обязательный sandbox для channel/executable, без retry | 2 failures: `undefined !== true` | 2 policy + 5 browser lifecycle = **7/7** |
| Личный reader / namespace / чужой владелец | 3 failures: `COMMAND_FORBIDDEN`, недостающие allowedCommands | На момент первого gate **42/42**: real composition, workflow owning suite, namespace |
| E35: wrapper timeout | 1 failure: owned child не завершён к deadline теста | После fix завершается собственный child; освободившийся TCP-порт успешно bind заново |
| E35: browser launch rejection | 1 failure: wrapper timeout вместо выхода fixture | **2/2** deterministic cleanup tests; native test исключён явным `--testNamePattern`, не засчитан |
| Reader first setup / receipt recovery / progress / manual auth / empty | 5 meaningful failures | После исправлений и сохранения старых checks **18/18** UI tests |
| Несохранённый профиль / auto-finish после start | 2 failures: нет подтверждения ухода; premature finish | Включены в итоговый owning gate |
| Отмена без предыдущего результата | 1 failure: ложное «Предыдущий результат сохранён» | Включена в итоговый owning gate; hidden-mounted finish также проверен |

Итоговый адресный gate перед объединением зависимостей: **16 test files / 136 tests passed**, exit0, 67.18s. Полный suite не запускался. После него добавлен явный null guard в `recover()` по замечанию общего typecheck; это не отдельный новый счётчик тестов. Общая сборка/typecheck и финальный suite принадлежат интеграционному этапу.

```sh
node node_modules/vitest/vitest.mjs run \
  src/features/connectors/browser-launch-policy.test.ts \
  src/features/connectors/workbench-browser-runtime.test.ts \
  src/features/connectors/workbench-workflow-service.test.ts \
  src/features/connectors/workbench-personal-access.test.ts \
  src/features/connectors/workbench/BrowserProfileForm.test.tsx \
  src/features/connectors/workbench/BrowserScenarioWizard.test.tsx \
  src/features/connectors/workbench/SharedBrowserScenarioWizard.test.tsx \
  src/features/connectors/workbench/WorkbenchProvider.test.tsx \
  src/features/connectors/workbench/WorkbenchProvider.integration.test.tsx \
  src/features/connectors/workbench/WorkbenchProvider.recovery-ui.test.tsx \
  src/features/connectors/workbench/client.test.ts \
  src/features/connectors/workbench/client.integration.test.ts \
  src/features/connectors/workbench/personal-result-presentation.test.tsx \
  src/features/connectors/workbench/personal-workspace-states.test.tsx \
  tests/workbench-personal-namespace.test.ts \
  src/app/workbench/personal-recovery.test.tsx \
  --maxWorkers=2 --minWorkers=1

node node_modules/vitest/vitest.mjs run tests/oko-runtime-loader.test.ts \
  --testNamePattern='bounded wrapper|launch failure' --maxWorkers=2 --minWorkers=1
```

Исследовательские логи этой рабочей сессии: `redesign/oko-sandbox-red.log`, `oko-sandbox-green.log`, `oko-reader-red.log`, `oko-reader-green.log`, `oko-loader-timeout-red.log`, `oko-loader-failure-red.log`, `oko-loader-green.log`, `oko-ui-red.log`, `oko-guard-red.log`, `oko-cancel-red.log`, `oko-owning-green.log` в workspace вне репозитория. Промежуточный `oko-ui-green-first.log` содержит устранённую ошибку асинхронного ожидания в тесте; не считается финальным GREEN.

## Реальный Chrome под непривилегированным пользователем

Результат: **Google Chrome 156.0.8078.79 / Node v22.16.0 / UID nobody: picker и recorder 2/2 PASS**, exit0. Использованы настоящий `openBrowser`, actual production Node/tsx loader, localhost HTML/CSV, реальная загрузка файла и recorder. В `DEBUG=pw:browser` два реальных launch argv **не содержат `--no-sandbox`**. Оба процесса завершились с exit0; оба HTTP listener закрыты. Логи: `redesign/oko-native-sandbox-nonroot-final.log`, `oko-native-browser-version.txt`.

Изначально доступ блокировали права каталогов: `/workspace` и `/workspace/scratch` имеют 0700 root; первый вызов nobody дал exit126 до Node. В собственной `/tmp` копии parent Chrome также сохранял 0700, поэтому Playwright сообщил недоступный executable. Изменены права только нового synthetic copy каталога; права исходного workspace не менялись. После этого реальный sandbox launch прошёл. Никакого отказа host sandbox, который требовал бы `--no-sandbox`, в последнем запуске не было.

Воспроизводимая подготовка (на Linux с уже имеющимися Node/Chrome/dependencies; **не установка**):

```sh
# Из корня чистого кодового worktree. Источники/модули уже установлены и проверены.
probe_copy=$(mktemp -d /tmp/uor-native-sandbox-XXXXXX)
chmod 755 "$probe_copy"
mkdir -p "$probe_copy/tests/fixtures/workbench" "$probe_copy/data"
cp -a src node_modules package.json "$probe_copy/"
cp tests/fixtures/workbench/oko-loader-regression.ts "$probe_copy/tests/fixtures/workbench/"
cp /workspace/scratch/ab925b2abe56/redesign/runtime/node-v22.16.0-linux-x64/bin/node "$probe_copy/node"
cp -a /workspace/scratch/ab925b2abe56/redesign/runtime/chrome/opt/google/chrome "$probe_copy/chrome"
chmod 755 "$probe_copy/chrome"
chown nobody:nogroup "$probe_copy/data"
cd "$probe_copy"
runuser -u nobody -- env \
  TMPDIR="$probe_copy/data" \
  XDG_CONFIG_HOME="$probe_copy/data/config" \
  XDG_CACHE_HOME="$probe_copy/data/cache" \
  DEBUG=pw:browser \
  UOR_TEST_BROWSER_EXECUTABLE="$probe_copy/chrome/chrome" \
  "$probe_copy/node" --import tsx --test tests/fixtures/workbench/oko-loader-regression.ts
```

Для текущего доказательства копия: `/tmp/uor-native-sandbox-iwlXWD`. Каталоги содержат только исходный код, уже установленные зависимости, браузер и синтетические данные. Browser stderr содержит предупреждения DBus, NSS home и фоновых TLS-запросов этой headless среды; localhost assertions прошли без отключения TLS. Это не проверка банковского SSO, сертификатов, СберБраузера, Edge/Windows или GUI конкретного рабочего места. Windows-ветка завершения PID tree также требует отдельной среды.

## Следующий независимый шаг

Реальная сквозная UI-запись первичной настройки/справочника/исправления/повтора, manual-auth/cancel/error screenshots и daily path выполняются отдельно через `scripts/design-reference/completion-runtime.ts` и `completion-oko-flow.ts`. Этот журнал будет дополнен их фактическими результатами. Приведённые выше 136 tests и native2 tests сами по себе не являются этим сквозным UI доказательством.

## Границы, обнаруженные первым реальным сквозным проходом

Первый driver пропустил настройку CSV delimiter: фактический файл разделён `;`, сохранённый профиль содержал `,`. Чистый разбор тех же байтов подтвердил `INVALID_TABLE: Row width differs from the header`; с `;` получены четыре точных столбца и восемь строк. Автозавершение было отправлено. Исправлен driver; это не дефект recorder.

Вместе с этим воспроизведены и исправлены три реальные границы:

- Известная `WorkbenchParserError` на `record.finish` возвращала HTTP500 и неопределённый ответ. Теперь возвращается HTTP422 с исходным code и detail `/parsingProfile`; пользователь получает действие для проверки формата. Failed recording и предыдущий результат сохраняются.
- Личный справочник использовал общий `goal-import`, поэтому reader не мог пройти настройку целиком. Новый purpose `oko-directory` разрешён через `personal.write` только ненулевому personId; лимит10MiB, CSV/XLSX safety и person/installation/purpose isolation обязательны. Reader по-прежнему не может загружать `goal-import`/evidence и выполнять общий setup/publication. Чужие handle и handle другого purpose недоступны личному preview.
- Любой новый mount формы завершал уже completed recording. Теперь auto-finish вооружается только recordingId из успешного `record.start` этой формы и исключает уже сохранённые steps. Hidden settings сохраняют форму и автозавершение собственного старта. Чтение текущего workflow в новой вкладке ничего не отправляет; после reload доступны явные «Получить записанные шаги» и recovery.

RED: один test ожидал422 и получил500; следующие пять tests выявили недоступный personal purpose/client namespace и незапрошенные finish на pending/saved recording. GREEN на обновлённых dependencies: **7 файлов,105 tests PASS,15.30s, exit0**, Node22.16.0/Vitest4.1.12, `--maxWorkers=2`. Промежуточный проверочный test использовал отсутствующий matcher `toBeDisabled`; заменён наблюдением штатной enabled finish-кнопки, production обходов не добавлено. Vitest4 больше не поддерживает `--minWorkers`; первая попытка с ним завершилась CLI error до tests и не считается RED.

```sh
PATH=/workspace/scratch/ab925b2abe56/redesign/runtime/node-v22.16.0-linux-x64/bin:$PATH \
node node_modules/vitest/vitest.mjs run \
  src/server/workbench/upload.test.ts src/server/workbench/files.test.ts \
  src/features/connectors/workbench-workflow-service.test.ts \
  src/features/connectors/workbench-personal-access.test.ts \
  src/features/connectors/workbench/client.test.ts \
  src/features/connectors/workbench/BrowserScenarioWizard.test.tsx \
  src/features/connectors/workbench/personal-workspace-states.test.tsx --maxWorkers=2
```

Логи вне репозитория: `redesign/oko-parser-error-red.log`, `oko-parser-error-green.log`, `oko-upload-autofinish-red.log`, `oko-upload-autofinish-green-final.log`. Фактический non-root Chrome copy содержит штатный `chrome-sandbox` root:root4755; production `chromiumSandbox:true` сохранён.

## Продолжение настоящего session-only SSO

Первый полный проход достиг native login и затем снова получил `waiting_user`: после ручного входа service закрывал окно и запускал новый persistent context. Сессионная cookie `expires=-1` пропадала. Это воспроизведено отдельным real Chrome regression (RED, exit1,4.53s) и двумя service regressions. Cookie fixture не превращена в постоянную.

Исправление использует тот же native context и ту же очередь профиля. Одноразовый server-only `loginHandleId` привязан к точному owner, исходным настройкам профиля, URL отчёта и authenticated marker; service передаёт его только исходному job/workflow. Повтор проверяет свежие права и исходную revision. Контекст закрывается после результата, ошибки, отмены или отказа preflight; cookies, storageState и токены не извлекаются и не переносятся. Параметры профиля сохранены как независимый снимок в памяти handle.

GREEN: runtime/service **53/53 tests,2файла,7.01s** на Node22.16/Vitest4.1.12/maxWorkers2. Native Chrome156/Node22.16/nobody **3/3 PASS,3.07s**: picker,recorder,session-only continuation. Последний случай доказывает скачивание в том же контексте (`launches=1`), одноразовость handle, затем отмену второй реальной незавершённой выгрузки без нового replay context. Все три listeners закрыты. Отдельные guards проверяют отказ сменённым owner/profile/report/marker/handle, изменение исходного input object, fresh-authority loss и stale revision с cleanup. Это не доказательство банковского сервера или Windows/Edge.

Независимая проверка уточнила cleanup: вызов `closeOwned` в success-finally мог остановить параллельный workflow того же владельца. Четыре regression cases сначала дали RED; теперь автоматическая очистка использует обязательный точный `cancelRecording({owner,handleId})`, а404 потреблённого handle означает уже закрытый context. Явная отмена/закрытие owner остаётся отдельной операцией. Повторные fixture guards:2/2PASS, native wrapper test исключён только из этого адресного запуска, не из общего suite.

```sh
node node_modules/vitest/vitest.mjs run \
  src/features/connectors/workbench-browser-runtime.test.ts \
  src/features/connectors/workbench-workflow-service.test.ts --maxWorkers=2
# Подготовленная выше non-root copy, с текущими src/tests:
runuser -u nobody -- env \
  TMPDIR=/tmp/uor-native-sandbox-iwlXWD/data \
  XDG_CONFIG_HOME=/tmp/uor-native-sandbox-iwlXWD/data/config \
  XDG_CACHE_HOME=/tmp/uor-native-sandbox-iwlXWD/data/cache \
  UOR_TEST_BROWSER_EXECUTABLE=/tmp/uor-native-sandbox-iwlXWD/chrome/chrome \
  /tmp/uor-native-sandbox-iwlXWD/node --import tsx --test tests/fixtures/workbench/oko-loader-regression.ts
```

Логи: `redesign/oko-session-cookie-native-red.log`, `oko-session-cookie-service-red.log`, `oko-session-cookie-native-green.log`, `oko-session-exact-cleanup-red.log`, `oko-session-exact-cleanup-green.log`, `oko-session-cookie-loader-guard-green.log`. Остальные source faults в E2E независимы: после доказанного session-only continuation synthetic source возвращается к исходному публичному режиму перед schema/empty/cancel tests; никакие ответы приложения не подменяются.
