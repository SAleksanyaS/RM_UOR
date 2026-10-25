import { exportCleanDistribution } from './clean-distribution.mjs';

try {
  const args = process.argv.slice(2); let outputPath, includeLocalAccounts = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--with-local-accounts') includeLocalAccounts = true;
    else if (args[index] === '--output' && args[index + 1] && !args[index + 1].startsWith('--') && outputPath === undefined) outputPath = args[++index];
    else if (args[index] === '--help' || args[index] === '-h') { console.log('npm run export:clean -- [--output .runtime/exports/RM_UOR-clean.zip] [--with-local-accounts]'); process.exit(0); }
    else throw new Error('Допустимы --output <путь.zip> и --with-local-accounts');
  }
  const result = await exportCleanDistribution({ projectRoot: process.cwd(), outputPath, includeLocalAccounts });
  console.log(`Чистая программа: ${result.path}\nРевизия: ${result.commit}\nФайлов: ${result.files}`);
  if (result.privateAccountsPath) console.log(`ПРИВАТНЫЕ учётные записи, отдельный файл: ${result.privateAccountsPath}`);
} catch (error) { console.error(`Чистый экспорт не выполнен: ${error.message}`); process.exitCode = 1; }
