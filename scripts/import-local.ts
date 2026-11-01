import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { importGoalMap } from '../src/features/catalog/import-map';
import { assertLegacyCliAllowed } from './local-history';

const input = process.argv[2];
if (!input) {
  console.error('Использование: npm run import:map -- "путь/к/карте.html"');
  process.exitCode = 1;
} else {
  try {
    await assertLegacyCliAllowed(process.cwd());
    const catalog = importGoalMap(await readFile(resolve(input), 'utf8'));
    const directory = resolve('.runtime/imports');
    await mkdir(directory, { recursive: true });
    const temporary = resolve(directory, 'catalog.json.tmp');
    await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    await rename(temporary, resolve(directory, 'catalog.json'));
    console.log(`Импортировано локально: ${catalog.goals.length} целей, ${catalog.leaders.length} ИТ-лидеров, ${catalog.assignments.length} назначений.`);
    console.log('Каталог сохранен в .runtime/imports/catalog.json. Корпоративные данные не отправляются в Git.');
    console.log('Для применения перезапустите локальное приложение. Существующие снимки и подтверждения не изменены.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Не удалось импортировать карту целей');
    process.exitCode = 1;
  }
}
