import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { z } from 'zod';
import { emptyCatalog } from './workspace-bootstrap.mjs';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_BYTES = 96 * 1024 * 1024;
const topFiles = new Set(['.gitignore', '.nvmrc', '.node-version', 'AGENTS.md', 'GIGACODE.md', 'README.md', 'LICENSE', 'LICENSE.md', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts']);
const currentDocs = new Set(['docs/MASTER_SPEC.md', 'docs/USER_GUIDE.md', 'docs/AI_PDLC_HANDOFF.md', 'docs/BANK_CONNECTORS_RUNBOOK.md', 'docs/ARCHIVE.md', 'docs/VALIDATION.md', 'docs/remaining-work.md', 'docs/remaining-by-environment.md']);
const protectedFolders = new Set(['.git', 'src', 'scripts', 'tests', 'public', 'docs', 'config', 'catalog', 'node_modules', 'dist', 'coverage', 'playwright', 'test-results', 'playwright-report']);
const registrySchema = z.array(z.object({ id: z.string().min(1).max(300), name: z.string().trim().min(1).max(200), salt: z.string().min(1).max(200), hash: z.string().regex(/^[a-f0-9]{128}$/) }).strict()).min(1).max(100);
const emptyList = z.array(z.never()).length(0);
const blankCatalogSchema = z.object({ schemaVersion: z.literal(1), id: z.literal('uor-blank-v1'), name: z.literal('Рабочая повестка ДИТ'), classification: z.literal('corporate'), importedAt: z.iso.datetime({ offset: true }), goals: emptyList, leaders: emptyList, assignments: emptyList, sources: emptyList, comments: emptyList, entities: emptyList, directions: emptyList }).strict();
const normalizeName = name => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');

async function git(root, args, binary = false) {
  const result = await execute('git', ['-C', root, ...args], { encoding: binary ? 'buffer' : 'utf8', maxBuffer: MAX_ARCHIVE_BYTES, timeout: 60000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return binary ? result.stdout : result.stdout.trim();
}
function inside(root, destination) { const relative = path.relative(root, destination); return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
async function noLinks(root, destination) {
  if (destination !== root && !inside(root, destination)) throw new Error('Путь выходит за рабочую папку');
  let current = root;
  const entries = [root, ...path.relative(root, destination).split(path.sep).filter(Boolean).map(part => current = path.join(current, part))];
  for (const entry of entries) {
    try { if ((await lstat(entry)).isSymbolicLink()) throw new Error('Символьные ссылки в пути экспорта или учётного реестра запрещены'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function unusedOutput(root, candidate) {
  if (typeof candidate !== 'string' || !candidate || /[\x00-\x1f]/.test(candidate) || candidate.split(/[\\/]/).includes('..')) throw new Error('Некорректный путь выходного ZIP');
  const destination = path.resolve(root, candidate), relative = path.relative(root, destination), parts = relative.split(path.sep), first = parts[0].toLowerCase();
  if (!inside(root, destination) || parts.some(part => part.includes(':') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || !/\.zip$/i.test(destination) || protectedFolders.has(first) || first.startsWith('.') && first !== '.runtime'
    || first === '.runtime' && (parts.length < 3 || parts[1].toLowerCase() !== 'exports')) throw new Error('Выберите ZIP внутри рабочей папки вне защищённых каталогов; стандартное место — .runtime/exports');
  await noLinks(root, destination);
  try { await lstat(destination); throw new Error('Выходной файл уже существует; выберите другое имя'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return destination;
}
function safeArchivePath(name) {
  return typeof name === 'string' && name.length <= 2000 && !/[\\:\x00-\x1f]/.test(name) && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..');
}
function included(name) {
  // This tracked file is a public setup template; its placeholder-only content is checked below.
  if (name === 'config/curators.example.json') return true;
  const parts = name.split('/');
  if (parts.some(part => ['.git', '.runtime', 'node_modules', 'dist', 'coverage', '.venv', '.aws', 'playwright-report', 'test-results'].includes(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part))
    || /\.local(?:\.|$)/i.test(name) || /\.(?:key|pem|pfx|p12|sqlite|db|zip|pptx|xlsx|xls|docx|pdf|log)$/i.test(name)
    || /^(?:curators|credentials|secrets)(?:[._-]|$)/i.test(parts.at(-1))) return false;
  if (topFiles.has(name) || currentDocs.has(name) || ['config/site.example.json', 'config/update-protocol.json', 'catalog/catalog.json', 'catalog/demo.json', 'catalog/demo-snapshots.json'].includes(name)) return true;
  if (/^docs\/(?:guides|architecture|agents)\/[a-zA-Z0-9_./-]+\.md$/.test(name)) return true;
  return /^(?:src|scripts|tests|public)\//.test(name) && /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|css|json|html|svg|png|jpe?g|webp|ico|woff2?|ttf)$/.test(name);
}
async function cleanCommit(root) {
  if (await git(root, ['status', '--porcelain=v1', '--untracked-files=no'])) throw new Error('Есть незакоммиченные изменения отслеживаемых файлов. Сначала примите текущую ревизию; экспорт использует только HEAD.');
  const commit = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Не определена принятая ревизия Git');
  return commit;
}
async function localAccounts(root) {
  const filename = path.join(root, '.runtime', 'local-config', 'curators.json');
  try {
    await noLinks(root, filename); const info = await lstat(filename);
    if (!info.isFile() || info.size > 128000) throw new Error('Неподдержанный размер реестра');
    const registry = registrySchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    if (registry.some(record => /[\x00-\x1f\x7f]/.test(record.id + record.name + record.salt)) || new Set(registry.map(record => record.id)).size !== registry.length || new Set(registry.map(record => normalizeName(record.name))).size !== registry.length) throw new Error('Повторяются или повреждены профили');
    return Buffer.from(JSON.stringify(registry, null, 2) + '\n');
  } catch (error) { throw new Error('Локальный реестр учётных записей отсутствует или не прошёл строгую проверку. Приватный ZIP не создан.', { cause: error }); }
}
const hashEntry = (name, bytes) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const zipBytes = zip => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

/** Code-only delivery from a clean accepted Git revision. Private account hashes never enter the public archive. */
export async function exportCleanDistribution({ projectRoot, outputPath, includeLocalAccounts = false }) {
  if (typeof projectRoot !== 'string' || typeof includeLocalAccounts !== 'boolean') throw new Error('Проверьте параметры чистого экспорта');
  const requestedRoot = path.resolve(projectRoot); await noLinks(requestedRoot, requestedRoot);
  const root = await realpath(requestedRoot), top = await realpath(await git(root, ['rev-parse', '--show-toplevel']));
  if (root !== top) throw new Error('Запустите экспорт из корня репозитория');
  const commit = await cleanCommit(root);
  // The unfiltered Git archive is held in memory only; files on disk are always filtered ZIPs.
  const archived = await JSZip.loadAsync(await git(root, ['archive', '--format=zip', commit], true), { checkCRC32: true });
  const zip = new JSZip(), files = []; let total = 0;
  for (const name of Object.keys(archived.files).sort()) {
    const entry = archived.files[name]; if (entry.dir) continue;
    if (!safeArchivePath(name) || entry.unsafeOriginalName && entry.unsafeOriginalName !== name) throw new Error('Git-архив содержит небезопасный путь');
    if (!included(name)) continue;
    if ((Number(entry.unixPermissions) & 0o170000) === 0o120000) throw new Error('Символьные ссылки в поставляемом коде не поддержаны');
    if (entry._data.uncompressedSize > MAX_FILE_BYTES) throw new Error('Файл кода превышает допустимый размер');
    const bytes = await entry.async('nodebuffer'); total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > MAX_CONTENT_BYTES || files.length >= 10000) throw new Error('Поставка превышает допустимый объём');
    // Preserve the safe empty first-launch baseline, never a user's populated corporate catalog.
    if (name === 'catalog/catalog.json' && !blankCatalogSchema.safeParse(JSON.parse(bytes.toString('utf8'))).success) continue;
    if (name === 'config/curators.example.json') {
      const placeholder = z.array(z.object({ name: z.string().min(1).max(200), code: z.literal('REPLACE_WITH_PRIVATE_PASSWORD') }).strict()).min(1).max(100).safeParse(JSON.parse(bytes.toString('utf8')));
      if (!placeholder.success) throw new Error('Публичный пример кураторов должен содержать только placeholder REPLACE_WITH_PRIVATE_PASSWORD');
    }
    zip.file(name, bytes); files.push(hashEntry(name, bytes));
  }
  const generatedBaseline = !zip.file('catalog/catalog.json');
  if (generatedBaseline) { const bytes = jsonBytes(emptyCatalog()); zip.file('catalog/catalog.json', bytes); files.push(hashEntry('catalog/catalog.json', bytes)); }
  const packageFile = zip.file('package.json'); if (!packageFile) throw new Error('В принятой ревизии отсутствует package.json');
  const applicationVersion = JSON.parse(await packageFile.async('text')).version;
  if (typeof applicationVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(applicationVersion)) throw new Error('Некорректная версия принятой программы');
  const destination = await unusedOutput(root, outputPath ?? `.runtime/exports/RM_UOR-clean-${applicationVersion}-${commit.slice(0, 12)}.zip`);
  const privateDestination = includeLocalAccounts ? await unusedOutput(root, destination.replace(/\.zip$/i, '.private-local-accounts.zip')) : undefined;
  const registry = includeLocalAccounts ? await localAccounts(root) : undefined;
  const instructions = Buffer.from(`# Чистая поставка РМ УОР\n\nВерсия ${applicationVersion}. Ревизия кода: ${commit}.\n\nРаспакуйте ZIP в разрешённую отдельную папку. Прочитайте docs/USER_GUIDE.md и docs/agents/START_HERE.md. Установите согласованные Node/npm/Git, выполните npm ci и npm run setup:workspace -- --mode empty. Проверьте локальную конфигурацию и учётные записи по руководству, затем запустите npm run dev. Для подключения внутреннего Git используйте утверждённый порядок настройки организации.\n\nВ архиве нет истории Git, рабочей SQLite-базы, локальных конфигураций, паролей/хешей учётных записей, сессий, браузерных профилей, cookies, сертификатов, зависимостей и личных артефактов. manifest содержит SHA-256 каждого файла, кроме самого manifest. Пустой каталог первого запуска включён всегда; generatedBaseline в manifest показывает, создан ли он экспортом взамен отсутствующего/заполненного. Это поставка программы, не перенос рабочего набора; для рабочих данных используйте проверяемый перенос из обслуживания.\n\nЕсли отдельно создан PRIVATE ZIP учётных записей, храните и передавайте его по разрешённому приватному каналу. Он не входит в этот архив. Банковские источники, ОС, авторизация и Office требуют целевой приёмки.\n`);
  zip.file('TRANSFER_README.md', instructions); files.push(hashEntry('TRANSFER_README.md', instructions));
  zip.file('DISTRIBUTION_MANIFEST.json', jsonBytes({ format: 'uor-clean-distribution-v1', commit, applicationVersion, createdAt: new Date().toISOString(), includesLocalAccounts: false, generatedBaseline, files }));
  const publicBytes = await zipBytes(zip), outputs = [{ path: destination, bytes: publicBytes }];
  if (registry) {
    const privateZip = new JSZip(), readme = Buffer.from(`# PRIVATE — локальные учётные записи\n\nПРИВАТНЫЙ архив. Содержит имена, идентификаторы и salted password hashes. Права на этот файл защищают доступ к приложению. Не добавляйте архив в Git и не передавайте публично.\n\nНа подготовленной доверенной станции при остановленном приложении проверьте хеш файла по PRIVATE_MANIFEST.json и установите local-config/curators.json как .runtime/local-config/curators.json по утверждённому порядку администратора. Не перезаписывайте существующий реестр без согласованного переноса; после установки запустите приложение заново. Пароли открытым текстом здесь отсутствуют; они передаются пользователям отдельно. Сессии, браузер, cookies, сертификаты и настройки доступа не переносятся.\n`);
    privateZip.file('local-config/curators.json', registry); privateZip.file('PRIVATE_README.md', readme);
    privateZip.file('PRIVATE_MANIFEST.json', jsonBytes({ format: 'uor-private-local-accounts-v1', private: true, commit, applicationVersion, publicArchive: path.basename(destination), publicArchiveSha256: sha256(publicBytes), files: [hashEntry('local-config/curators.json', registry), hashEntry('PRIVATE_README.md', readme)] }));
    outputs.push({ path: privateDestination, bytes: await zipBytes(privateZip) });
  }
  if (await cleanCommit(root) !== commit) throw new Error('Принятая ревизия изменилась во время экспорта; повторите действие');
  const created = [];
  try {
    for (const output of outputs) {
      await mkdir(path.dirname(output.path), { recursive: true }); await unusedOutput(root, output.path);
      const handle = await open(output.path, 'wx', 0o600); created.push(output.path);
      try { await handle.writeFile(output.bytes); await handle.sync(); } finally { await handle.close(); }
    }
  } catch (error) { for (const file of created) await unlink(file).catch(() => {}); throw error; }
  return { path: destination, commit, files: files.length + 1, ...(privateDestination ? { privateAccountsPath: privateDestination } : {}) };
}
