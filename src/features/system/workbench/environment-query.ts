import { access, readFile, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { QueryRegistry, QueryContext } from '../../../server/workbench/query-registry';
import { ownQueryRequestSchema } from '../../../server/workbench/protocol';
import { APP_VERSION } from '../../../domain/app-version';
import type { BrowserDiscovery } from '../../../../scripts/open-workbench-browser.mjs';
import type { CommandRegistry } from '../../../server/workbench/command-registry';
import type { JobStore } from '../../../server/workbench/jobs';
import { uuidSchema } from '../../../domain/workbench/primitives';

export const browserDiscoverySchema = z.strictObject({
  targetVersion: z.string(),
  candidates: z.array(z.strictObject({ executablePath: z.string().max(4096), version: z.string().nullable(), status: z.enum(['compatible', 'unverified']) })).max(6),
  message: z.string(),
});
export const environmentStatusSchema = z.strictObject({
  applicationVersion: z.string(), nodeVersion: z.string(), nodeCompatible: z.boolean(),
  npmVersion: z.string().nullable(), npmCompatible: z.boolean().nullable(),
  platform: z.string(), architecture: z.string(), targetBrowser: z.literal('СберБраузер 152.0.7977.120'),
  timeZone: z.literal('Europe/Moscow'), repositoryConfigured: z.boolean(), registryConfigured: z.boolean(),
  rawFiles: z.number().int().nonnegative(), publishedDefinitions: z.number().int().nonnegative(), privateBrowserConfigured: z.boolean(),
  workspaceReadable: z.boolean(), workspaceWritable: z.boolean(), freeBytes: z.number().nonnegative().nullable(),
  ports: z.strictObject({ api: z.number().int(), client: z.number().int() }),
});
export type EnvironmentStatus = z.infer<typeof environmentStatusSchema>;
export type BrowserEnvironment = z.infer<typeof browserDiscoverySchema>;
const inputSchema = ownQueryRequestSchema.extend({ filter: z.strictObject({}), sort: z.array(z.never()).max(0) });
const diagnosticInputSchema = inputSchema.extend({ filter: z.strictObject({ commandId: uuidSchema.optional() }) });
export const environmentDiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(1), generatedAt: z.string(), environment: environmentStatusSchema,
  operation: z.strictObject({
    commandId: uuidSchema, name: z.string().nullable(),
    status: z.enum(['not_found', 'pending', 'accepted', 'completed', 'interrupted']),
    job: z.strictObject({ jobId: uuidSchema, status: z.string(), stage: z.string(), errorCode: z.string().nullable(), warningCodes: z.array(z.string()).max(20) }).nullable(),
  }).nullable(),
  excluded: z.array(z.string()),
});
export type EnvironmentDiagnostics = z.infer<typeof environmentDiagnosticsSchema>;

async function runtimeDetails(root: string) {
  let npmVersion: string | null = null;
  const cli = process.env.npm_execpath;
  if (cli && path.isAbsolute(cli)) {
    try {
      const manifest = JSON.parse(await readFile(path.join(path.dirname(cli), '../package.json'), 'utf8'));
      if (manifest.name === 'npm' && typeof manifest.version === 'string') npmVersion = manifest.version;
    } catch { /* A direct developer launch may not include the npm CLI path. */ }
  }
  let freeBytes: number | null = null;
  try { const info = await statfs(root); freeBytes = Math.min(Number.MAX_SAFE_INTEGER, Number(info.bavail) * Number(info.bsize)); } catch { /* Host may not expose filesystem statistics. */ }
  const permitted = async (mode: number) => { try { await access(root, mode); return true; } catch { return false; } };
  return { npmVersion, npmCompatible: npmVersion === null ? null : npmVersion === '10.9.2',
    workspaceReadable: await permitted(constants.R_OK), workspaceWritable: await permitted(constants.W_OK), freeBytes };
}

export function registerEnvironmentQuery(registry: QueryRegistry, options: {
  root: string; ports: EnvironmentStatus['ports']; repositoryConfigured: boolean; registryConfigured: boolean;
  inspectOwn(context: QueryContext): Promise<Pick<EnvironmentStatus, 'rawFiles' | 'publishedDefinitions' | 'privateBrowserConfigured'>>;
  discoverBrowser(): Promise<BrowserDiscovery>;
  commands: CommandRegistry; jobs: JobStore;
}): void {
  const readEnvironment = async (context: QueryContext): Promise<EnvironmentStatus> => {
      return { applicationVersion: APP_VERSION, nodeVersion: process.versions.node, nodeCompatible: process.versions.node === '22.16.0',
        platform: process.platform, architecture: process.arch, targetBrowser: 'СберБраузер 152.0.7977.120', timeZone: 'Europe/Moscow',
        repositoryConfigured: options.repositoryConfigured, registryConfigured: options.registryConfigured, ports: options.ports,
        ...await runtimeDetails(options.root), ...await options.inspectOwn(context) };
  };
  registry.register({ name: 'environment.get', inputSchema, outputSchema: environmentStatusSchema, handler: readEnvironment });
  registry.register({ name: 'environment.browser', inputSchema, outputSchema: browserDiscoverySchema,
    async handler() { return options.discoverBrowser(); },
  });
  registry.register({ name: 'environment.diagnostics', inputSchema: diagnosticInputSchema, outputSchema: environmentDiagnosticsSchema,
    async handler(context, request): Promise<EnvironmentDiagnostics> {
      const commandId = request.filter.commandId;
      const command = commandId ? options.commands.reconcileCommand?.(commandId, context) : null;
      let job: ReturnType<JobStore['get']> = null;
      if (command?.job) {
        options.commands.assertJobAccess?.(command.job.jobId, context);
        job = options.jobs.get(command.job.jobId, context.installationId);
      }
      const code = (value: string | undefined) => value && /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : null;
      return { schemaVersion: 1, generatedAt: context.clock.now(), environment: await readEnvironment(context),
        operation: command ? { commandId: command.commandId, name: command.name, status: command.status,
          job: job ? { jobId: job.jobId, status: job.status, stage: job.stage,
            errorCode: code(job.error?.code), warningCodes: job.warnings.map(item => code(item.code)).filter((item): item is string => item !== null).slice(0, 20) } : null } : null,
        excluded: ['Личные имена и идентификаторы', 'Адреса источников и пути компьютера', 'Исходные файлы и результаты операций', 'Сеансы, сертификаты и секреты', 'Текст журналов и сообщений внешних систем'],
      };
    },
  });
}
