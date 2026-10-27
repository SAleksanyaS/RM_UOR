# Самопроверка подробного плана

Дата: 28 октября 2026 года. Область: план и его согласованные входы; не реализация и не продуктовый прогон.

1. **Покрытие спецификации.** Все48 исходных AC связаны с задачами/тестовыми файлами в AC-COVERAGE; уточнение ОКО имеет8OC и T42–T48. BP-01–BP-06 имеют конкретные профили, команды, результаты и блокируемые capabilities. Отчётность следующего этапа не включена в кодовые задачи.
2. **Гранулярность шагов.** У каждой T01–T48 есть зависимости, точные файлы и публичные интерфейсы, проверочные assertions, RED/GREEN/команда и commit. T00 — baseline без изменения продуктового кода. T41 не рисует PASS вместо отсутствующей банковской среды. Default order явно учитывает поздние номера ОКО.
3. **Согласованность типов.** Сверены EntityRef/VersionRef; PublicationAnchor без Header и отдельная package/storage revision; Clock/actor; captures/metrics в EvaluationInput; digest без часов и эфемерное качество; atomic CommandOutcome/receipt; jobs; Draft/FileStore; Source parsingProfile; BrowserScenario locator/steps; backend binary artifact/backup routes. Общие имена — CONTRACTS, owning file — частьплана.
4. **Review Focus.** В owning tasks закреплены часы/precision, crash между effect/receipt, auth/revoke после ожидания, missing/partial/unknown date, rollback/rescue. Дополнительная browser проверка включает NSS/SSO-boundary, profile isolation, selector ambiguity и настоящее скачивание.
5. **Соразмерность.** В плане сохранены решения, интерфейсы, короткие assertions и команды; тела функций не переписаны из будущей программы. Подсистемы разделены на части, а порядок и обязательные пересечения сведены в главный файл. Полные business schemas остаются в спеках.

Закрытые при сборке стыки: недостающие DTO результата handlers, actor производного расчёта, индексные порты одного SQLite, передача байтов backup/evidence, header CSRF, обязательные элементы parser profile, legacy entry без обхода, реальная последовательность browser-replay задач. Новых общих бизнес-вопросов для этого плана не осталось.

Документация проверяется `node docs/superpowers/plans/2026-10-28-uor-workbench/verify-plan.mjs`: checksums/48tasks/48AC+8OC/JSON/links. Для совместимости checksum на разных ОС docs/superpowers фиксирует LF через .gitattributes.

Код новой версии, тесты приложения, build, банковские probes, native login и реальная миграция в ходе подготовки этого плана не выполнялись. Самопроверка не повышает статусы PROGRESS до DONE. Фактический Git commit/push документации фиксируется отдельно в истории ветки.
