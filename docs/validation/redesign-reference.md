# Визуальный эталон РМ УОР - 01.11.2026

**Статус: этапы 1-2 готовы к визуальному согласованию. Полный перенос и выпуск не завершены.**

Основание: [новая спецификация владельца](../superpowers/specs/2026-11-01-product-redesign.txt), прежде всего раздел 16. План: [2026-11-01-product-redesign-reference](../superpowers/plans/2026-11-01-product-redesign-reference.md).

База: `ac299a5508dba60df7d4f5b8152fb7aaf4655223`, исходная ветка `codex/uor-workbench-rebuild`. Отдельная рабочая ветка: `codex/uor-redesign-reference`. Исходный checkout не изменялся. Push, merge и обновление пользовательского Windows preview не выполнялись.

## Реализованный срез

- Сняты текущая и прежняя оболочки на отдельных синтетических данных. Production before/after используют один backend runtime и тот же набор; legacy показан отдельно.
- Штатный `src/app/main.tsx -> WorkbenchApp`, полный бренд, sidebar 248 px / compact 76 px, пять разделов, служебные действия и мобильное меню. Второй backend и отдельное showcase-приложение не созданы.
- Общий контекст помещён в раскрываемую строку. Личная вкладка ОКО не показывает фильтры целей; её URL selector переживает startup, refresh, изменение контекста и Back/Forward.
- Обзор разделяет отклонение результата, проблему данных и ожидание подтверждения. Ручной статус null/not_started/in_progress/completed отражается без выдуманного прогресса. DashboardView сохранён в раскрываемом разделе.
- Карточка цели сохраняет BasisInspector/ResultSummary/exact refs, отдельно показывает факт, порог, качество, подтверждение, ответственного, срок и следующий шаг.
- Data использует PersonalOkoWorkspace поверх прежних OkoClient/WorkbenchProvider/BrowserScenarioWizard. OkoApp целиком больше не встраивается. Ежедневное получение, последний результат и два файла первичны; настройка остаётся mounted для auto-finish записи.
- Серверная авторизация, namespace `oko.workflow.*`, прежние receipt/recovery, parser/enrichment и версии dependencies сохранены.

## Карта переиспользования

- [Функции и компоненты](redesign-reference/reuse-map.txt).
- [Существующий ОКО](redesign-reference/oko-reuse.txt).
- [Подтверждённые оставшиеся дефекты](redesign-reference/remaining-defects.txt): F01-F04, F11, F12/F13, F15, E35.

Карты составлены до изменений эталона, на базе ac299a5; это инвентаризация, не текущий акт приёмки. Актуальное представление описано выше и в module-map. Отдельная матрица лидеров из legacy не объявляется восстановленной.

## Review и исправления

[Один scoped review](redesign-reference/scoped-review-before-fixes.txt) обнаружил четыре P2. Исправлены: потеря personal hash; мобильный focus после текущего раздела и обслуживания; неподтверждённая подпись raw CSV column; неверное представление ручного статуса.

Без сохранённой column provenance сокращённый личный preview показывает точные неслужебные headers; все поля доступны через прежний PreviewTable. Current recipe не переинтерпретирует старый result. UNMAPPED_PRODUCT объяснён обычным языком; code/path остаются в техническом раскрытии. Неизвестные сообщения не скрываются.

[Один visual review](redesign-reference/visual-review-before-fixes.txt) привёл к узким правкам: следующий шаг Goal на1366x768, плотность Overview на320/360, перенос кнопки и длинного имени Data. Мобильный поиск сохранён отдельной кнопкой. Повторный широкий review не проводился.

RED до исправления: 3 падения навигационных unit-регрессий; 4 отказа из5 первоначальных native checks; 5 падений из8 смысловых регрессий. [Смысловые RED/GREEN](redesign-reference/semantic-fixes.txt) сохранены. Существующие проверки не ослаблялись ради счётчика.

## Проверки этого этапа

Среда: Linux; отдельный Node **22.16.0**, npm **10.9.2**, Chrome **156.0.8078.79**. Node сверён с официальным SHASUMS256. Зависимости установлены по исходному lockfile, 414 packages; версии не менялись. Корпоративный Node владельца не обновлялся.

### Адресные тесты: 82/82, 13 файлов

Команда под отдельным Node22.16:

```bash
npm test -- src/features/overview/workbench/goal-views.test.tsx src/features/overview/workbench/goal-review-fixes.test.tsx src/features/overview/workbench/overview-attention.test.tsx src/app/workbench/navigation-drawer.test.tsx src/app/workbench/WorkbenchShell.test.tsx src/app/workbench/WorkbenchApp.test.tsx src/app/workbench/route-state.test.ts src/app/workbench/lineage-route.test.tsx src/app/workbench/context.test.tsx src/app/workbench/personal-recovery.test.tsx src/features/connectors/workbench/BrowserScenarioWizard.test.tsx src/features/connectors/workbench/WorkbenchProvider.recovery-ui.test.tsx src/features/connectors/workbench/personal-result-presentation.test.tsx --fileParallelism --maxWorkers=2
```

Фактический exit0; 13 files /82 tests PASS; 16.38 s. Лог пакета: `evidence/reference-targeted-release.log`. Промежуточные44/11/8/31 не прибавляются к82. Старые1892/104/5 относятся к другим состояниям кода.

### Сборка

`npm run build`: exit0, TypeScript и Vite успешно. Лог `evidence/reference-build-final.log`. Предупреждения upstream zod о PURE-комментариях сохранены в логе. Вложенные design-reference scripts дополнительно проверены отдельной typecheck, так как общий tsconfig их не включает.

### Настоящий браузер

- **8/8**: direct URL, reload, Back/Forward; возврат native focus из обслуживания кнопкой и Escape; текущий раздел; поиск на320 px. Проверены `document.activeElement` и `inert`. `daily-regression-green.json`, pageerror отсутствуют.
- **6/6** финального ежедневного ОКО-пути: один replay, новый resultId, понятное замечание, оба downloads, сохранённая настройка, отсутствие pageerror. `final-daily-flow.json` и настоящий `final-daily-flow.mp4`.
- Инициализация fixture прошла настоящий loopback report, клик download в Chrome, recorder, mapping, multipart upload справочника, replay, parser/enrichment и SQLite. Result/API responses не подменялись.
- 8 строк, 1 с замечанием, 7 без замечаний. Исходник565 bytes; enriched4538 bytes. Byte equality и SHA-256 проверены.
- Исходный SHA-256: `9cb5a16423c80914a039d30b1f487d6ec370251a9c744abb38303fe0fd41aea2`.
- Enriched SHA-256: `860a864d1fae1e081df8ae802838b95f82063982c7d4d2d6f78e31ead7a7a908`.
- Финальный resultId: `736b768d-3217-4957-b22a-6488831c71d8`. Начальный ID и промежуточные повторы сохранены в evidence, но не называются актуальным результатом.
- Старые download URLs сохранили байты в первоначальном daily-flow. Recipe hash не изменился в обоих явных daily replay.

### Визуальные материалы

- До: 3 production экрана x2 viewport (1440x1000,1366x768), тот же набор данных.
- После: **18 уникальных состояний** = Обзор/Данные/Цель x1440x1000,1366x768,1024x900,768x1024,360x900,320x900. Отдельно drawer360 и legacy-reference.
- Нет page overflow и pageerror. Повторные capture не считаются новыми сценариями: manifest оставляет последнюю запись на phase/route/viewport; исходный capture-log сохранён.
- Полные страницы и viewport PNG включены в review-пакет. Финальные desktop/mobile PNG визуально просмотрены. Локальная прокрутка таблицы допустима.

## Открытые границы

1. Полный перенос списка целей, работ/решений, источников, мастеров, draft/preview и всех состояний - после одного визуального согласования владельца.
2. Полный ролик первого пользователя от настройки до исправления справочника остаётся для этапа4. Fixture прошёл настоящий recorder/replay; финальное видео демонстрирует ежедневную работу с готовым рецептом.
3. Право reader на личный replay: прежняя серверная команда требует uor.prepare. UI её не обходит. Целевое право читателя получать личные данные остаётся функциональной задачей.
4. OkoWorkflowView не содержит accepted/rejected и стадий parse/enrich progress. Они не выдуманы в UI; unresolvedRows означает строки с замечаниями, а не только неизвестные продукты.
5. F01-F04/F11-F15/E35, reachability dependencies и SQLite assessment не закрыты этим визуальным этапом. История, публикация и внешние права не переписаны.
6. Полный suite, чистая распакованная поставка и обновление preview ещё впереди. Один полный прогон требуется после стабилизации всего редизайна.
7. СберБраузер, SSO, smartcard, ГОСТ, сертификаты, прокси, Bitbucket enforcement и целевая ОС не проверены этим Chrome/Linux-стендом. F11 не закрывается запуском тестового Chrome.

## Источники

- Входная спецификация1.0, разделы4,16-18.
- [Carbon UI shell](https://www.carbondesignsystem.com/building-blocks/core/components/ui-shell-left-panel/guidelines): общая оболочка и навигация.
- [W3C WAI-ARIA modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/): инертный фон, Tab/Shift+Tab, Escape, возврат фокуса.
- [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype) и [SQLite WAL](https://www.sqlite.org/wal.html#walresetbug): отдельные технические границы следующего этапа.
