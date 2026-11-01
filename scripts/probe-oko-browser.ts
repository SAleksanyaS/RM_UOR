import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { chromium } from 'playwright';
import { hostname } from 'node:os';
import { z } from 'zod';
import { uuidSchema } from '../src/domain/workbench/primitives';
import type { WorkbenchRepository } from '../src/server/storage/workbench-repository';
import { createBlockedOkoBrowserProbe, okoBrowserProbeConfigSchema, probeOkoBrowser, publicOkoBrowserProbeReport, type OkoBrowserProbeResult } from '../src/features/connectors/workbench-browser-probe';
import { createBrowserRuntime } from '../src/features/connectors/workbench-browser-runtime';
import { createBrowserProfileService } from '../src/features/connectors/workbench-browser-profile';
import { assertPhysicalPath } from '../src/server/workbench/files';
import { WorkbenchHttpError } from '../src/server/workbench/protocol';

/** Fixed composition: configuration selects references only, never executable JS/providers/SQL.
 * No target export or bank-matrix verifier is installed by this CLI. */
export async function runOkoBrowserCli(args: string[] = process.argv.slice(2)): Promise<OkoBrowserProbeResult> {
  let repository: WorkbenchRepository | undefined, releaseLease: (() => Promise<void>) | undefined;
  let runtime: ReturnType<typeof createBrowserRuntime> | undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  let owner: { installationId: string; profilePersonId: string | null } | undefined;
  const controller = new AbortController(), onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  try {
    const { values } = parseArgs({ args, options: { config: { type: 'string' } }, strict: true, allowPositionals: false });
    if (!values.config) return createBlockedOkoBrowserProbe();
    const projectRoot = await realpath(process.cwd());
    const configRoot = path.join(projectRoot, '.runtime/probes/oko'), configFile = path.resolve(projectRoot, values.config);
    const relative = path.relative(configRoot, configFile);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return createBlockedOkoBrowserProbe();
    await assertPhysicalPath(configFile, false);
    const entry = await lstat(configFile);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 65536) return createBlockedOkoBrowserProbe();
    const parsed = okoBrowserProbeConfigSchema.safeParse(JSON.parse(await readFile(configFile, 'utf8')));
    if (!parsed.success) return createBlockedOkoBrowserProbe();
    const config = parsed.data;
    const siteFile = path.join(projectRoot, 'config/site.local.json'); await assertPhysicalPath(siteFile, false);
    const site = z.object({ allowedWorkspaceRoots: z.array(z.string()).min(1), roleMode: z.enum(['local-preview', 'registry']).default('local-preview'), mainRepositoryId: z.string().min(1).default('RM_UOR'), registry: z.object({ checkout: z.string(), expectedRemote: z.string(), acceptedBranch: z.string().default('main'), registryPath: z.string().default('registry.json'), repositoryId: z.string() }).nullable().default(null) }).parse(JSON.parse(await readFile(siteFile, 'utf8')));
    const allowed = await Promise.all(site.allowedWorkspaceRoots.map(value => realpath(value)));
    if (!allowed.some(root => { const inside = path.relative(root, projectRoot); return inside === '' || inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside); })) return createBlockedOkoBrowserProbe();
    if (config.mode === 'record-replay' && (!process.stdin.isTTY || !process.stderr.isTTY)) return createBlockedOkoBrowserProbe('OPERATOR_REQUIRED');
    const { acquireRuntimeLease } = await import('../src/server/workbench/runtime-lease');
    // Acquire before opening SQLite or running any application recovery. No full app bootstrap.
    releaseLease = await acquireRuntimeLease(projectRoot);
    const runtimeRoot = path.join(projectRoot, '.runtime/workbench');
    const existingJson = async (relative: string) => { const file = path.join(runtimeRoot, relative); await assertPhysicalPath(file, false); return JSON.parse(await readFile(file, 'utf8')); };
    const identity = z.strictObject({ installationId: uuidSchema, personId: uuidSchema }).parse(await existingJson('identity.json'));
    const pointer = z.strictObject({ version: z.literal(1), active: z.string().regex(/^(?:initial|restore-[a-f0-9-]{36})$/) }).parse(await existingJson('active.json'));
    const subjectRoot = path.join(runtimeRoot, 'subject', pointer.active), databaseFile = path.join(subjectRoot, 'workbench.sqlite');
    const { requireManagedDatabase } = await import('../src/server/workbench/runtime-storage');
    await requireManagedDatabase(subjectRoot, { immutable: true });
    const { createWorkbenchRepository } = await import('../src/server/storage/workbench-repository');
    repository = createWorkbenchRepository({ filename: databaseFile, artifactRoot: path.join(subjectRoot, 'files'), readOnly: true });
    const activeRepository = repository, clock = { now: () => new Date().toISOString() }, installationId = identity.installationId;
    const { createLocalPreviewPolicy } = await import('../src/server/workbench/oko-local-role');
    const { createAccessPolicyService, createUnavailableRegistryReadPort } = await import('../src/features/identity/workbench-access-policy');
    const { createOwnPolicyCache } = await import('../src/features/identity/workbench-policy-cache');
    const { createAcceptedGitRegistry } = await import('../src/server/workbench/oko-registry');
    const capabilityFor = () => 'capture.local' as const;
    const accessPolicy = site.roleMode === 'local-preview' ? createLocalPreviewPolicy({ directory: runtimeRoot, personId: identity.personId, clock, capabilityFor }) : createAccessPolicyService({ hostname, registry: site.registry ? createAcceptedGitRegistry(site.registry) : createUnavailableRegistryReadPort(), cache: createOwnPolicyCache({ directory: path.join(runtimeRoot, 'own-policy-cache') }), installationId, mainRepositoryId: site.mainRepositoryId, serviceRepositoryId: site.registry?.repositoryId ?? 'registry-not-configured', clock, capabilityFor });
    let browser: { name: string; version: string | null } = { name: 'unobserved', version: null };
    runtime = createBrowserRuntime({ runtimeRoot, launcher: { async launchPersistent(_profile, folder, options) {
      const context = await chromium.launchPersistentContext(folder, options);
      try {
        const cdp = await context.newCDPSession(context.pages()[0] ?? await context.newPage());
        const observed = await cdp.send('Browser.getVersion'); await cdp.detach();
        browser = { name: /Edg\//.test(observed.userAgent) ? 'Edge' : /^Chrome\//.test(observed.product) ? 'Chromium' : 'unobserved', version: observed.product.split('/')[1] ?? null };
      } catch { /* Missing native metadata cannot certify compatibility. */ }
      return context;
    } } });
    const profiles = createBrowserProfileService({ runtimeRoot, repository: activeRepository, clock });
    const currentContext = async () => {
      const ownAccess = await accessPolicy.resolveOwnAccess(); owner ??= { installationId, profilePersonId: ownAccess.personId };
      return { repository: activeRepository, clock, installationId, ownAccess, requestId: randomUUID() };
    };
    const operator = config.mode === 'record-replay' ? {
      async login({ signal }: { handleId: string; signal: AbortSignal }) {
        rl ??= createInterface({ input: process.stdin, output: process.stderr });
        await rl.question('Complete manual sign-in in the owned browser, then press Enter here. Ctrl+C cancels.\n', { signal });
      },
      async record({ signal }: { handleId: string; signal: AbortSignal }) {
        rl ??= createInterface({ input: process.stdin, output: process.stderr });
        await rl.question('Review the published parameters, perform the authorized report actions and download, then press Enter.\n', { signal });
      },
    } : undefined;
    const report = await probeOkoBrowser({ ...config, runtimeRoot }, { runtime, repository: activeRepository, clock, signal: controller.signal, trusted: { currentContext, profiles, operator, browser: () => browser } });
    const evidenceRoot = path.join(runtimeRoot, 'probes/oko');
    let existingParent = evidenceRoot;
    while (true) { try { await assertPhysicalPath(existingParent, true); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; existingParent = path.dirname(existingParent); } }
    await mkdir(evidenceRoot, { recursive: true }); await assertPhysicalPath(evidenceRoot, true);
    const evidenceFile = path.join(evidenceRoot, randomUUID() + '.json');
    await writeFile(evidenceFile, JSON.stringify(publicOkoBrowserProbeReport(report), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    report.privateEvidencePath = evidenceFile; return report;
  } catch (error) {
    // No free-text error/path/profile/provider value reaches either public stream.
    return createBlockedOkoBrowserProbe(error instanceof WorkbenchHttpError && ['WORKSPACE_BUSY', 'RECOVERY_REQUIRED'].includes(error.code) ? error.code : 'INPUT_REQUIRED');
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    rl?.close();
    if (runtime && owner) await runtime.closeOwned(owner).catch(() => {});
    try { repository?.close(); } catch { /* No raw close exception in public output. */ }
    await releaseLease?.().catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await runOkoBrowserCli(); process.stdout.write(JSON.stringify(publicOkoBrowserProbeReport(report), null, 2) + '\n');
  process.exitCode = report.status === 'passed' && report.acceptedSourceBinding ? 0 : report.status === 'failed' ? 1 : 2;
}
