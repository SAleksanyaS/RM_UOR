# Зависимости и встроенная SQLite

Дата проверки: 2026-11-01. Корпоративный Node 22.16.0 сохранён. Проверка выполнялась сначала в отдельной копии, затем lockfile установлен в рабочую ветку после остановки тестов всех исполнителей.

## Что изменено

| Компонент | Было → стало | Причина и совместимость |
| --- | --- | --- |
| Vitest и его внутренние пакеты | 3.2.7 → 4.1.12 | Исправленный `@vitest/mocker`; прежняя цепочка Tinypool удалена. Выбрана поддерживающая Node 22 ветка с backport, а не автоматический переход на любой предложенный major |
| `exceljs` → `uuid` | 8.3.2 → 11.1.1 | Узкий override только для ExcelJS. Используемый им `v4()` без buffer остаётся совместимым; сам ExcelJS 4.4.0 сохранён |
| `pptxgenjs` → `image-size` | 1.2.1 → 2.0.4 | Узкий override исправленного парсера. PptxGenJS 4.0.1 сохранён; штатный генератор PPTX не подменён |
| Конфигурация тестов | Реальный `node:sqlite` external | Node 22.16 поддерживает prefix-only builtin, но не перечисляет его в `builtinModules`. Vitest 4 в jsdom иначе пытается собрать его для client environment. Узкий test-only `resolveId` сохраняет настоящий SQLite; polyfill и настройки production Vite не добавлялись |

Не менялись версии Node, Fastify, React, Vite, ExcelJS и PptxGenJS. `npm audit fix --force` не использовался. Для создания lockfile понадобился временный npm 11.6.0: npm 10.9.2 воспроизвёл известный `arborist #loadPeerSet / edgesOut` сбой. Установка готового lockfile обычным `npm ci` на Node 22.16.0 / npm 10.9.2 отдельно прошла; постоянное обновление npm не требуется.

## Достижимость и оставшиеся предупреждения

Начальный `npm audit`: 14 затронутых dependency entries — 10 moderate, 2 high, 2 critical. После обновления: 8 moderate, 0 high, 0 critical. Это число записей графа зависимостей, не число продемонстрированных атак.

| Цепочка | Где используется | Оценка по исходникам и решение |
| --- | --- | --- |
| Vitest / mocker / Tinypool | Только разработка и тесты; production bootstrap их не импортирует | Уязвимые версии удалены. Dev-сервер с mocker нельзя считать равным production API |
| `image-size` через PptxGenJS | Сохранённый legacy export/template код; отчёты ещё не возвращены в новый штатный UI | Установлена исправленная версия. Выполнена реальная генерация/чтение PPTX; наличие legacy модуля не объявляется возвращённой функцией интерфейса |
| `uuid` через ExcelJS | XLSX / conditional formatting; ExcelJS вызывает `v4()` | Обновлён совместимый вызов. Уязвимые v3/v5/v6 с пользовательским buffer не являются текущим вызовом ExcelJS, но зависимость всё равно исправлена |
| `exceljs`, `archiver`, `archiver-utils`, `zip-stream`, `readdir-glob`, `glob`, `rimraf`, `minimatch` | Один оставшийся транзитивный граф ExcelJS | Реестр отмечает восемь entries из-за minimatch. В штатном импорте вызывается `Workbook.xlsx.load`, в выгрузке — обычная книга/CSV; пользовательские glob-паттерны и `archive.glob/directory` не принимаются. Достижимая атака в этом пути не установлена |

Оставшиеся версии: ExcelJS 4.4.0, archiver 5.3.2, archiver-utils 2.1.0, zip-stream 4.1.1, readdir-glob 1.1.3, glob 7.2.3, rimraf 2.7.1, minimatch 3.1.5 / 5.1.9. Advisory описывает amplification при `optimizationLevel >= 2`, но публикует широкий affected range `<11.0.1`. Не объявляем старые версии полностью безопасными на основании одного неподтверждённого пути. Не подменяем их несовместимым major override только ради нулевого счётчика. Следующее действие сопровождающего — поддерживаемое обновление цепочки ExcelJS/архиватора с проверкой импортов, потокового экспорта и pattern API; повторить audit при каждом выпуске.

## Проверка выбранного обновления

- Отдельная копия исходников; исходный общий `node_modules` оставался неизменным во время параллельных targeted tests.
- Чистая установка готового lockfile через npm 10.9.2 — PASS; затем тот же способ в объединяемой ветке — PASS.
- XLSX parsing, обогащение личной выгрузки, создание/чтение PPTX и native runtime lease: 29 проверок в четырёх файлах — PASS.
- Смешанный jsdom + настоящий API/SQLite после узкого resolver: 4 проверки — PASS. До него воспроизведён конкретный `Cannot bundle built-in module node:sqlite`.
- TypeScript и production bundle пробной копии — PASS. Итоговые build/full suite всей объединённой ветки фиксируются отдельно.

Логи: `completion/logs/npm-audit-before.json`, `npm-audit-trial.json`, `dependency-trial-npm10-ci.log`, `dependency-integrated-install.log`, `dependency-trial-checks.log`, `dependency-trial-ui-green.log`, `dependency-trial-build.log`.

## SQLite WAL-reset

Фактический `process.versions.sqlite` у проверенного Node 22.16.0 — **3.49.1**. Эта версия предшествует исправлению WAL-reset. По upstream, условие ошибки — несколько соединений к одному WAL-файлу в разных потоках/процессах с совпадающими по времени write/checkpoint; наличие старой версии само по себе не доказывает повреждение базы.

В managed runtime сохраняется один владелец физической рабочей папки (`runtime-lease.ts`) и один основной `WorkbenchRepository` для активной базы (`runtime-storage.ts`). Модули используют один фасад; переключение restore открывает другой путь базы. Диагностическое immutable-чтение отказывается игнорировать непустой WAL. В рассмотренном штатном пути параллельная запись/checkpoint к одному WAL через разные native connections не установлена. Эти механизмы не защищают от сторонней утилиты, самостоятельно открывшей тот же файл с правом записи.

Решение этого этапа: **WAL и runtime lease сохраняются**, автоматической смены корпоративного Node нет. Для корпоративного согласования есть поддерживаемый кандидат в той же линии Node 22: официальный Node 22.22.3 включает SQLite 3.51.3; актуальную разрешённую сборку следует выбрать вместе с сопровождением. Критерий проверки конкретного бинарного файла — SQLite 3.51.3+ либо документированный исправленный backport (например, 3.50.7/3.44.6), затем backup/restore, прерывание update, runtime lease и smoke-проверка на копии данных. Эта записка не объявляет такой бинарный файл уже установленным или банковскую миграцию принятой.

## Первичные источники

1. [Vitest 4 migration](https://v4.vitest.dev/guide/migration.html) — требования и изменения тестового runtime.
2. [Vitest mocker code injection / backports](https://github.com/advisories/GHSA-qxg6-89mg-rqv8).
3. [Vitest redirect mock traversal](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
4. [Tinypool run options](https://github.com/advisories/GHSA-85c8-ppgw-ccpr).
5. [image-size JXL/HEIF](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) и [ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr).
6. [uuid buffer bounds](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
7. [minimatch amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249).
8. [npm resolver issue and version boundary](https://github.com/npm/cli/issues/9787).
9. [SQLite WAL-reset — условия и исправленные версии](https://www.sqlite.org/wal.html#walresetbug).
10. [Node 22.22.3 release](https://nodejs.org/en/blog/release/v22.22.3).

Выводы о достижимости относятся к inspected source и указанным проверкам; они не являются pentest банковской среды.
