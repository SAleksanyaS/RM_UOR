import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const port = z.number().int().min(1024).max(65535);
const schema = z.strictObject({
  port: port.default(4176), clientPort: port.default(5175), autoOpen: z.boolean().default(true),
  roleMode: z.enum(['local-preview', 'registry']).default('local-preview'),
  mainRepositoryId: z.string().min(1).default('RM_UOR'),
  registry: z.strictObject({ checkout: z.string().min(1), expectedRemote: z.string().min(1), acceptedBranch: z.string().min(1).default('main'), registryPath: z.string().min(1).default('registry.json'), repositoryId: z.string().min(1) }).nullable().default(null),
}).refine(value => value.port !== value.clientPort, 'API and client ports must differ');
export type OkoConfiguration = z.infer<typeof schema>;
export async function loadOkoConfiguration(projectRoot: string): Promise<OkoConfiguration> {
  const root = await realpath(projectRoot);
  const relative = process.env.UOR_OKO_CONFIG ?? 'config/oko.local.json';
  const file = path.resolve(root, relative), inside = path.relative(root, file);
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('OKO configuration must be inside the project private config');
  let raw: unknown = {};
  try { const bytes = await readFile(file); if (bytes.length > 65536) throw Error('OKO configuration is too large'); raw = JSON.parse(bytes.toString('utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return schema.parse(raw);
}
