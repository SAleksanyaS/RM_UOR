# Ролевая модель и локальные кураторы

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Пользователь разрешил параллельную реализацию без остановок.

**Goal:** обычный пользователь видит рабочие результаты, куратор — управление;6 новых персональных профилей работают локально.

**Architecture:** чистая общая capability policy, серверный запрет и UIguard; существующие локальные сессии, private scrypt registry. Существующие domain/evaluation правила не меняются.

**Tech Stack:** React/TypeScript, Fastify, SQLite, Node crypto/fs, Vitest.

**Spec:** ../specs/2026-10-25-roles-and-curators-design.md

## Задачи

- [x] backend: permissions.ts, default-deny API, identity account projection/login, операции владельца; адресные проверки ролей и обходов.
- [x] UI: общая политика меню/страниц/диалогов, вход с выбором имени, сохранение читательского обновления, роли в отчётах/знаниях; адресные проверки.
- [x] root: безопасное provisioning6 записей без plaintext, сохранить текущего куратора; private stateprojection, reader SystemPage и проверки.
- [x] audit: сверка исходного запроса и remaining-by-environment.md, честно отделить функциональный пробел от непроведённой приёмки.
- [x] объединить стабильный код, релевантные проверки и сборка, локальный показ, commit/push, обновить handoff.

## На что смотреть

Обход меню прямым HTTP; скрытые настройки в api/state; лишние данные операций/истории; кэш редактора после выхода; невыбранный/чужой аккаунт; потеря существующей записи при provisioning; пароли в clientbundle/Git/log. Читатель не теряет обновление собственных источников и просмотр происхождения фактов.

Проверки и границы: docs/verification/roles-evidence.md. Реальные пароли/реестр и рабочие скриншоты исключены из Git.
