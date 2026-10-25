# Локальное завершение и навигация

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans. Пользователь прямо разрешил параллельное исполнение без промежуточных согласований.

**Goal:** полный maturityPPTX, перенос/хранение/восстановление обновления и удобная навигация с проверенным дизайном.
**Architecture:** существующие локальные модули иRBAC; изолированные подпроцессы шаблона, workspace-maintenance, stagedupdater и rootUI/integration.
**Tech Stack:** React/TypeScript, Fastify/SQLite, OOXML/JSZip, Node/fs/IPC, Vitest, локальныеPPTXrender tools.
**Spec:** ../specs/2026-10-25-local-completion-design.md

- [x] templateagent: все11слайдов, profile/payload/render/самостоятельнаяUIнастройка, privateготоваявыгрузка, адресныеOOXML/данные/визуальнаяпроверка.
- [x] storageagent: переносимыйbundle, restoreсоткатом, archive/retention/quarantine и сегменты журнала; отдельныйcuratorpanel/routes, адресные roundtrip/tamper/refprotectiontests.
- [x] updateragent: stagingзависимостей без остановкистаройверсии, IPCprepare, безопасныйswap/CAS/recovery; адресные lifecyclefailuretests.
- [x] root: новыйSidebar/persistmode, контраст/цвета/сеткасокращениеперегруза, осмотр всехстраниц иразмеров, исправленияпо независимому review.
- [x] root: registerroutes/panels/version/docs, объединитьстабильныемодули, одинрелевантныйобщийпрогон/послеисправлений толькоадресные, финальнаясборка.
- [x] запустить опубликованныйкод, показатьUI+готовыйPPTX, проверитьприватностьпакета, pushmain/release/current, обновитьremaining/AI-PDLC.

Reviewfocus: старые значения шаблона, методика/охват/период; восстановлениебезчужихcredentials и с рабочимивложениями; удалениеReferencedартефакта; сбой/прерываниеcodeupdate; подписи/tooltip/focus/mobile вкомпактномменю; случайныйвозвраткураторскогоменючитателю.
