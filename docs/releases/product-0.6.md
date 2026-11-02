# Поставка RM_UOR 0.6.0

Назначение: исходный ZIP, подготовленный Linux x64 комплект, общий setup package, реальные примеры экспортов и PDF-руководство. Точные финальные SHA/размеры находятся в прилагаемом `RELEASE_MANIFEST.json`; результаты — в [акте](../validation/product-2026-11-02.md). Код прошёл полный локальный suite и проверку извлечённого Linux-комплекта. Связь окончательных артефактов с наблюдённым remote main проверяется при финальной упаковке; локальные implementation SHA не подменяют опубликованный commit.

## Воспроизводимая подготовка

Исходный ZIP: `npm run export:clean` из чистого принятого checkout. Экспорт использует Git commit и явный allowlist, включает выбранные разрешённые материалы и рабочие launchers, исключает private runtime/конфигурацию/сеансы.

Подготовленный Linux x64 архив создаётся отдельно:

```text
node scripts/package-prepared-linux.mjs --runtime-tar /absolute/path/node-v22.16.0-linux-x64.tar.xz --cache /absolute/path/npm-cache --out /absolute/path/RM_UOR-0.6.0-linux-x64.tar.gz --origin https://github.com/SAleksanyaS/RM_UOR.git
```

Builder проверяет pinned SHA-256 официального Node archive и канонический состав всего извлечённого runtime до выполнения Node/npm и повторно перед упаковкой. Создаётся свежий shallow main; зависимости устанавливаются offline по accepted lock с отключёнными lifecycle scripts, отдельными пустыми npm configs и изолированной конфигурацией Git. Существующие runtime/node_modules не копируются. Lock integrity/версии, esbuild, относительные symlinks, private paths и чистота Git проверяются; состав/hash каждого файла и third-party licenses перечислены. Из комплекта исключены браузер и системный Git; их подготавливает ИТ. Адрес origin в реальной корпоративной поставке утверждается организацией.

Канонический digest официального runtime — `943fedffb513cc78f59e694bb806a137ced7f34dd0471fcb2b181510387ecc27`: 5927 записей с путями, типами, правами, размерами, хешами и целями ссылок. Самосогласованный installation manifest не заменяет это независимое сравнение с официальным TAR. Лишний, изменённый, отсутствующий или небезопасно связанный runtime-файл блокирует сборку.

На новой физической папке нужно проверить inventory/hash/symlinks, отсутствие конфигурации/SQLite/профиля, bundled Node/npm, первый запуск, UI/API, ручной raw, остановку, повторный запуск и прежние identity/bytes. Установка зависимостей не является действием ежедневного пользователя. Папка с данными не используется как площадка проверки нового архива.

Общий пакет: `node --import tsx src/features/workspace-maintenance/workbench/setup-package-cli.ts /absolute/path/uor-common-v1.uor-setup.json`. Это разрешённые материалы/пресеты, не личная копия и не выдача роли. Полный рабочий backup создаётся через обслуживание и предназначен тому же подтверждённому владельцу.

PDF содержит полный текущий guide и реальные снимки UI. Экспорты зрелости построены из выбранного source snapshot; синтетический пример корректировки помечен отдельно. Нельзя переименовать HTML в PDF или выдать исходный ZIP за готовую установку.
