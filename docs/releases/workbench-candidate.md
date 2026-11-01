# Локальный кандидат Workbench 0.5.0

Дата: 1 ноября 2026 года. Ветка `codex/uor-workbench-rebuild`. Текущая source revision: **`a445c23385c9f32f4a284537d944c228430df11e`**, узкое завершение остатка I1 после f1331c4. Проверка остатка закрыла I1; итоговая release-docs запись и фактическая сборка распакованного кодового архива: **PENDING_LOCAL**.

Локальный комплект реализует штатный новый runtime/UI, пять основных экранов, личный ОКО, общие browser scenarios, типизированные пакеты/публикацию, backup/restore/rescue и fail-closed startup/recovery. Default Bitbucket adapter остаётся недоступным до проверенного корпоративного binding. Локальные Git/Bitbucket/registry/Qlik внешние службы и внешний merge — синтетические.

## Состояние проверки

| Gate | Результат |
| --- | --- |
| Среда локальных проверок | Windows, Node22.16.0/npm10.9.2, Chrome156.0.8078.74, Edge156.0.4314.58 |
| T39/T40 task review | Один fresh review;4Important исправлены одним correction pass; отдельного второго task review нет |
| T48 local delivery/review | CLI/service/tests/guide поставлены;3Important исправлены одним pass; изолированные4файла/57тестов и TypeScript exit0, exact-hash delta перенесён |
| Объединённый targeted main gate | T48/read-only/startup/legacy fixture:61/61,exit0,17.78s; application fixture:23/23 PASS |
| Первый объединённый suite | 259файлов/1871тест;257файлов/1868тестов прошли,3fail; результат не GREEN, три устаревшие fixtures исправлены |
| Общий suite source revision fba0ce6 | **PASS260файлов/1892теста,exit0,668.70s**, старт2026-11-01 10:41:50MSK; `workbench-candidate-full-suite-final.log` |
| Сборка текущей source revision a445c23 | **exit0**, TypeScript+Vite1.99s; `final-fix-wave/i1-scalar-build.log` |
| Scoped review fba0ce6→f1331c4 | **I1 NOT ADDRESSED**, SQL всё ещё разбирал lifetime payload JSON; **I2/I3/M1/M3 ADDRESSED**, M2cosmetic DEFERRED. Этот результат сохранён |
| Узкое завершение I1 a445c23 | **ADDRESSED**, без нового Critical/Important breakage. Covering scalar/diagnostic indexes; native5query programs: **0payload table columns/0JSON functions**. Тот же review seat подтвердил closure отдельным addendum, сохранив первый NOT ADDRESSED |
| Свежий main gate a445c23 | **6файлов/104теста PASS,exit0,78.45s**:source24/readmodels23/repo15/restore5/readonly1/T48probe36; дополнительно native-entry5PASSexit0,23.64s. Счётчики не складываются |
| Source revision | `a445c23385c9f32f4a284537d944c228430df11e`; финальная release-docs/artifact запись **PENDING_LOCAL** |
| Реальная readiness | **BLOCKED_BANK_INPUT**: observed exit2,ready=false, все6×REPORT_MISSING при пустом требуемом report root |

Счётчики focused проверок пересекаются с общими/нативными сценариями и не складываются. Прежние сборки и числа T25 не заменяют итоговый gate. Полная [матрица56AC/OC и6BP](../validation/workbench-acceptance.md) сохраняет contract-only границы AC-08/AC-28; [VALIDATION](../VALIDATION.md) содержит историю и текущие результаты.

## Комплект и продолжение

[Куратор](../guides/workbench-curator.md), [читатель](../guides/workbench-reader.md), [backup/restore/recovery](../guides/workbench-recovery.md), [ОКО probe](../guides/workbench-oko-browser.md), [рабочий журнал](../superpowers/plans/2026-10-28-uor-workbench/PROGRESS.md), [границы и оставшаяся работа](../remaining-work.md).

Общий suite260/1892 относится точно к **fba0ce6 до финальных исправлений**, не к текущему a445c23. Correction f1331c4 имел отдельные4файла/52PASS и неизменённые8файлов/124PASS в разных вызовах, main74PASS/build1.85s; scoped review принял I2/I3/M1/M3, но оставил I1открытым из-за SQLite JSON parsing до paging. Тот же исполнитель узко завершил I1в a445c23; true covering indexes подтверждены native VDBE proof и main104tests/build1.99s. Пять дополнительных actual native-entry/stock-launcher/update-failure/ACK-loss tests прошли23.64s. Тот же reviewer подтвердил I1ADDRESSED без нового breakage; исходный неуспешный scoped verdict сохранён, новый whole-branch review не объявляется.

Только M2(плотный JSX конструктора) отложен косметически. Все I1–I3 и M1/M3 приняты scoped review с узким I1addendum; oko.html включён. Остались финальная release-docs запись и фактическая проверка чистого экспорта: build inputs, manifest и сборка распакованного артефакта. Кодовый экспорт строится из принятой Git revision без `.runtime`, пользовательских данных, исходных выгрузок, профилей/cookies, закрытого реестра, credentials и приватных evidence. Личная копия данных и архив кода — разные артефакты.

## Фактическая банковская приёмка

BP-01–BP-06, целевой T48 и банковская часть T41 — **BLOCKED_BANK_INPUT**. Нужны реальные Bitbucket/Git/auth и private hostname registry, физический СберБраузер/SSO/CA/proxy и полный проверенный export, реальные старые данные с inventory/counts/hash/кураторским решением, целевые ОС/железо и корпоративные helper/hooks. Локальные Chrome/Edge и JSON success этого не доказывают; T48 synthetic evidence сохраняет `acceptedSourceBinding=false`.

Реальные данные пользователей не перенесены. Поддержанный synthetic old-layout clone/rescue и same-person restore подтверждают только свои технические сценарии. Проектные500ms/2s, p50/p95/peak memory на банковском ноутбуке не измерены.

Подключение около100 сотрудников, merge в main, tag и rollout не выполнены и не следуют автоматически из локальной поставки.
