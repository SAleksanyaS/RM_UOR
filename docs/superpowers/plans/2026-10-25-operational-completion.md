# План завершения доступного объёма

Spec: ../specs/2026-10-25-operational-completion-design.md. Base54aab0a, feature implementation/operational-completion. Прямое разрешение на реализацию/локальный запуск/push и параллельную работу, без остановок между пунктами.

## Границы владельцев

1. adapters — новые features/connectors и правки features/sources. Реальные HTTP/Confluence/Qlik/browser adapters, recorder, privateauth, sourceconfiguration UI, queue/cancel/schedule. В domain только SourceDefinition/collection и SourceAdapter contracts. Root интегрирует server/App/update pipeline и общий validator. Пробный стенд без банковских фактов.
2. execution — новые features/execution, work packages/вехи/DAG/baseline/burndown/forecast/retention/curator inbox/weighted achievement. Сущности entity через общий store; новые маршруты/компоненты экспортировать. Не редактировать App/server/domain без координации.
3. reporting — features/reporting, новые features/report-templates и capture historical organization basis. Реальный PPTX upload/bindings/export, сравнение недель, история правил/организации. В domain только SnapshotEvaluationBasis organization fields, прочие общие edits согласовывать с root.
4. root — операции: compatibility/migrations/backups/restore/retention, release preview/field conflicts/publication selection/evidence library, integration/navigation/privateprefs/performance и гайды.

## Последовательность

- [x] Запустить независимые 1–3 с согласованными ранними контрактами.
- [x] Реализовать 4 и координировать общие сигнатуры/схемы.
- [x] Объединить реальные адаптеры, убрать runtime заглушки и ложный успех обновления локальных старых фактов.
- [x] Закрыть UI маршруты, версии, публикацию, очередь, историю, шаблоны.
- [x] Независимый scoped review интеграций/операций/расчётов, устранить существенное.
- [x] Один общий набор, финальная сборка, локальные реальные стенды/визуальный осмотр и измерения.
- [x] Обновить master/runbook/remaining/evidence, запустить финальную версию, безопасный push RM_UOR.

## Общие ограничения

Нет выдуманных фактов/истории/подтверждений. Предыдущие данные сохраняются при ошибке. Пароли/сессии/CAключи/сырой корпоративный материал приватны. TLS не отключается. Общие изменения атомарны и с CAS. Сценарий декларативный, произвольный код не исполняется. Нет force-push. Читатель собирает личное, публикация куратора. Содержимое выпуска по release/current→main, текущий код разрешено пушить напрямую. Проверки ОС/корпоративной авторизации отмечаются фактически.


Итог: все независимые модули объединены; scoped review исправления и адресные проверки выполнены. Результаты и честные границы: docs/verification/operational-evidence.md. Банковская приёмка остаётся отдельной средой, конкретные функциональные ограничения — docs/remaining-work.md.
