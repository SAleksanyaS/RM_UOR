/** IT release builder. Uses accepted Git bytes and fresh integrity-pinned offline dependencies. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, link, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmForNode } from './local-launcher.mjs';
import { verifyPreparedRuntime } from './prepared-runtime.mjs';
export { verifyPreparedRuntime } from './prepared-runtime.mjs';

const execute = promisify(execFile);
// https://nodejs.org/dist/v22.16.0/SHASUMS256.txt — exact approved Linux x64 distribution.
const pinnedNodeArchiveSha256 = 'f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e';
// This empty builtin file belongs to the verified official Node archive, not a user's npm config.
const builtinNpmConfig = { path: 'runtime/node/lib/node_modules/npm/.npmrc', bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
const hashFile = async file => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const safeEnvironment = () => {
  // Local release assembly never needs an inherited Git identity, template,
  // injected config, credential helper, tracing target or transport setting.
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
};
async function git(root, ...args) {
  return (await execute('git', ['-C', root, ...args], { encoding: 'utf8', env: safeEnvironment(), maxBuffer: 32 * 1024 * 1024, timeout: 120000 })).stdout.trim();
}
function approvedOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || !url.pathname.endsWith('.git')) throw Error('Use the exact approved HTTPS Git URL without credentials/query/fragment.');
  return url.href;
}
async function physicalDirectory(value) {
  const absolute = path.resolve(value);
  if (await realpath(absolute) !== absolute || !(await lstat(absolute)).isDirectory()) throw Error('Use an existing physical directory without symlink ancestors.');
  return absolute;
}
async function omitUpstreamDevelopmentMetadata(root, relative = '') {
  const omitted = [];
  const developmentDirectories = new Set(['.claude', '.codex', '.cursor', '.vscode', '.idea', '.github']);
  for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!item.isDirectory()) continue; // never traverse a package symlink
    const name = relative ? relative + '/' + item.name : item.name;
    if (developmentDirectories.has(item.name)) {
      await rm(path.join(root, name), { recursive: true });
      omitted.push('node_modules/' + name);
    } else omitted.push(...await omitUpstreamDevelopmentMetadata(root, name));
  }
  return omitted.sort();
}
async function inventory(root, relative = '') {
  const entries = [];
  for (const item of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? relative + '/' + item.name : item.name;
    if (name === 'INSTALLATION_MANIFEST.json') continue;
    const file = path.join(root, name), stat = await lstat(file);
    const officialBuiltin = name === builtinNpmConfig.path && stat.isFile() && stat.nlink === 1 && stat.size === builtinNpmConfig.bytes && await hashFile(file) === builtinNpmConfig.sha256;
    if (!officialBuiltin && (/(?:^|\/)(?:\.npmrc|\.env(?:\.[^/]*)?|\.runtime|\.aws|\.ssh|\.auth|browser-profiles|local-config)(?:\/|$)/i.test(name) || /\.local\.json$/i.test(name))) throw Error('Private configuration/session path in prepared inventory: ' + name);
    if (stat.isDirectory()) entries.push(...await inventory(root, name));
    else if (stat.isSymbolicLink()) {
      const target = await readlink(file);
      if (path.isAbsolute(target) || !inside(root, await realpath(file))) throw Error('Packaged symlink escapes the bundle: ' + name);
      entries.push({ path: name, kind: 'symlink', target });
    } else if (stat.isFile() && stat.nlink === 1) entries.push({ path: name, kind: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: await hashFile(file) });
    else throw Error('Unsupported special/hard-linked file: ' + name);
    if (entries.length > 100000) throw Error('Prepared bundle exceeds the inventory limit.');
  }
  return entries;
}
export async function packagePreparedLinux({ projectRoot, runtimeArchive, npmCache, outputPath, origin }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('This prepared artifact is Linux x64 only.');
  const root = await physicalDirectory(projectRoot), cache = await physicalDirectory(npmCache), approvedRemote = approvedOrigin(origin);
  const archive = path.resolve(runtimeArchive), archiveInfo = await lstat(archive);
  if (await realpath(archive) !== archive || !archiveInfo.isFile() || archiveInfo.size > 80 * 1024 ** 2 || await hashFile(archive) !== pinnedNodeArchiveSha256) throw Error('The official pinned Node archive SHA-256 does not match.');
  const output = path.resolve(outputPath), parent = await physicalDirectory(path.dirname(output));
  if (!output.endsWith('.tar.gz') || inside(root, output) || inside(cache, output)) throw Error('Choose a new .tar.gz outside the source/cache directories.');
  try { await access(output); throw Error('Output already exists; choose a new filename.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (await git(root, 'status', '--porcelain=v1', '--untracked-files=no')) throw Error('Commit tracked source changes before packaging.');
  const commit = await git(root, 'rev-parse', 'HEAD^{commit}');
  const packageData = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (packageData.name !== 'uor-dit-operations' || !/^\d+\.\d+\.\d+$/.test(packageData.version)) throw Error('Unexpected application manifest.');
  const tracked = (await git(root, 'ls-files', '-z')).split('\0').filter(Boolean);
  if (tracked.some(name => /(?:^|\/)(?:\.runtime|\.superpowers|node_modules|\.env)(?:\/|$)|\.local\.json$|\.(?:p12|pfx|key|pem|sqlite|db|log)$/.test(name))) throw Error('Accepted tree contains a forbidden private/runtime path.');
  const lockBytes = await readFile(path.join(root, 'package-lock.json')), lock = JSON.parse(lockBytes);
  for (const [location, record] of Object.entries(lock.packages ?? {})) {
    if (!location) continue;
    if (!location.startsWith('node_modules/') || location.split('/').some(part => !part || part === '.' || part === '..') || /[\\:\x00-\x1f]/.test(location) || record.link || typeof record.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/=]+$/.test(record.integrity)) throw Error('Unsupported dependency source in lock: ' + location);
    const resolved = new URL(record.resolved);
    if (resolved.protocol !== 'https:' || resolved.username || resolved.password || resolved.search || resolved.hash) throw Error('Only integrity-pinned HTTPS packages are supported.');
  }
  const staging = await mkdtemp(path.join(parent, '.uor-prepared-'));
  const directoryName = `RM_UOR-${packageData.version}-linux-x64`, destination = path.join(staging, directoryName), temporaryArchive = path.join(staging, 'prepared.tar.gz');
  try {
    await mkdir(destination, { mode: 0o700 });
    const emptyGitTemplate = path.join(staging, 'empty-git-template');
    await mkdir(emptyGitTemplate, { mode: 0o700 });
    await git(destination, 'init', '--initial-branch=main', '--template=' + emptyGitTemplate);
    await git(destination, '-c', 'protocol.file.allow=always', 'fetch', '--depth=1', root, commit);
    await git(destination, 'checkout', '-B', 'main', commit);
    await git(destination, 'remote', 'add', 'origin', approvedRemote);
    await git(destination, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    await git(destination, 'update-ref', 'refs/remotes/origin/main', commit);
    await git(destination, 'config', 'branch.main.remote', 'origin');
    await git(destination, 'config', 'branch.main.merge', 'refs/heads/main');
    for (const relative of ['.git/FETCH_HEAD', '.git/logs', '.git/hooks']) await rm(path.join(destination, relative), { recursive: true, force: true });
    await writeFile(path.join(destination, '.git/description'), 'RM_UOR accepted release checkout\n');
    await mkdir(path.join(destination, '.git/info'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(destination, '.git/info/exclude'), '/runtime/\n/node_modules/\n/INSTALLATION_MANIFEST.json\n/THIRD_PARTY_MANIFEST.json\n');
    await mkdir(path.join(destination, 'runtime'), { mode: 0o700 });
    const extracted = path.join(staging, 'verified-node');
    await mkdir(extracted, { mode: 0o700 });
    await execute('tar', ['-xJf', archive, '-C', extracted, '--same-permissions', '--no-same-owner'], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const runtimeRoot = path.join(destination, 'runtime/node');
    await rename(path.join(extracted, 'node-v22.16.0-linux-x64'), runtimeRoot);
    const nodeTree = await verifyPreparedRuntime(runtimeRoot); // before executing any extracted binary
    const pinned = await npmForNode(path.join(runtimeRoot, 'bin/node'));
    const npmConfig = path.join(staging, 'empty-user-npmrc'), npmGlobalConfig = path.join(staging, 'empty-global-npmrc'), buildTemp = path.join(staging, 'build-temp');
    await writeFile(npmConfig, '', { mode: 0o600 }); await writeFile(npmGlobalConfig, '', { mode: 0o600 }); await mkdir(buildTemp, { mode: 0o700 });
    // Explicit configs/cache and an allowlisted environment prevent inherited credentials.
    // Lifecycle scripts are disabled; the locked native esbuild package is checked below.
    const buildEnvironment = { PATH: path.dirname(pinned.nodeExecutable) + ':/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: buildTemp, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
    await execute(pinned.nodeExecutable, [pinned.npmCli, 'ci', '--offline', '--ignore-scripts', '--include=dev', '--strict-ssl=true', '--no-audit', '--no-fund', '--cache', cache, '--userconfig', npmConfig, '--globalconfig', npmGlobalConfig], { cwd: destination, env: buildEnvironment, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
    await execute(pinned.nodeExecutable, ['node_modules/esbuild/bin/esbuild', '--version'], { cwd: destination, env: buildEnvironment, timeout: 10000, maxBuffer: 4096 });
    // Some upstream npm tarballs contain their author's editor/agent settings.
    // These are not runtime inputs; omit only declared development directories.
    // All other forbidden configuration paths still fail the inventory gate.
    const omittedDevelopmentDirectories = await omitUpstreamDevelopmentMetadata(path.join(destination, 'node_modules'));
    const packages = [];
    for (const [location, record] of Object.entries(lock.packages ?? {})) {
      if (!location) continue;
      try {
        const installed = JSON.parse(await readFile(path.join(destination, location, 'package.json'), 'utf8'));
        if (installed.version !== record.version) throw Error('Installed dependency differs from lock: ' + location);
        packages.push({ path: location, name: installed.name, version: installed.version, license: installed.license ?? record.license ?? 'see package license file', integrity: record.integrity });
      } catch (error) { if (error.code !== 'ENOENT' || !record.optional) throw error; }
    }
    const thirdParty = { format: 'uor-third-party-inventory-v1', target: 'linux-x64', node: '22.16.0', npm: '10.9.2', nodeArchiveSha256: pinnedNodeArchiveSha256, nodeTree, nodeLicense: 'runtime/node/LICENSE', builtinNpmConfig, lockSha256: createHash('sha256').update(lockBytes).digest('hex'), installedPackages: packages, omittedDevelopmentDirectories, note: 'Fresh offline npm ci from the accepted lock; lifecycle scripts disabled. Listed upstream development directories omitted; runtime and license/notice files retained. The sole builtin npm config is the exact empty file from the verified Node archive. The entire extracted Node tree is checked before execution and again before packaging. Existing runtime/dependency trees are never copied. OS Git and SberBrowser are not bundled.' };
    await writeFile(path.join(destination, 'THIRD_PARTY_MANIFEST.json'), JSON.stringify(thirdParty, null, 2) + '\n');
    if (await git(destination, 'status', '--porcelain=v1') || await git(root, 'rev-parse', 'HEAD^{commit}') !== commit) throw Error('Source moved or prepared checkout is not clean.');
    const files = await inventory(destination);
    if (files.filter(item => item.kind === 'file').reduce((sum, item) => sum + item.bytes, 0) > 1536 * 1024 ** 2) throw Error('Prepared bundle exceeds 1.5 GiB.');
    await verifyPreparedRuntime(runtimeRoot); // reject additions/changes made during npm/probe/inventory work
    await writeFile(path.join(destination, 'INSTALLATION_MANIFEST.json'), JSON.stringify({ format: 'uor-prepared-linux-v1', applicationVersion: packageData.version, commit, origin: approvedRemote, platform: 'linux', arch: 'x64', node: '22.16.0', npm: '10.9.2', generatedAt: new Date().toISOString(), includesPrivateWorkspace: false, includesBrowser: false, checkout: 'fresh shallow main; no developer git config or reflogs', files }, null, 2) + '\n');
    await execute('tar', ['-czf', temporaryArchive, '-C', staging, directoryName], { timeout: 300000, maxBuffer: 1024 * 1024 });
    await link(temporaryArchive, output); // exclusive publication: never overwrite an existing artifact
    await unlink(temporaryArchive);
    return { path: output, bytes: (await lstat(output)).size, sha256: await hashFile(output), commit, applicationVersion: packageData.version, target: 'linux-x64', files: files.length, installedPackages: packages.length, nodeExecutableVerified: path.basename(pinned.nodeExecutable) };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const take = name => { const at = args.indexOf(name); if (at < 0 || !args[at + 1]) throw Error('Required: ' + name); return args[at + 1]; };
  const result = await packagePreparedLinux({ projectRoot: process.cwd(), runtimeArchive: take('--runtime-tar'), npmCache: take('--cache'), outputPath: take('--out'), origin: take('--origin') });
  console.log(JSON.stringify(result, null, 2));
}
