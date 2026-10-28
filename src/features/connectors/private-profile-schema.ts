import { z } from 'zod';
const id = z.string().min(1).max(200);
const envName=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,199}$/,'Укажите имя переменной окружения вместо значения секрета');
const endpoint=z.string().url().max(4000).refine(v=>{const url=new URL(v);return !url.username && !url.password && ![...url.searchParams.keys()].some(key=>/token|password|secret|credential|authorization|saml|code/i.test(key));},'Credentials in URL forbidden');
export const privateProfileSchema = z.object({ allowedOrigins: z.array(endpoint).min(1).max(30),
  bearerEnv: envName.optional(), headersEnv: z.record(id, envName).optional(), caFile: z.string().optional(), certFile: z.string().optional(), keyFile: z.string().optional(), passphraseEnv: envName.optional(),
  maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).default(10 * 1024 * 1024), timeoutMs: z.number().int().min(100).max(120000).default(30000), retries: z.number().int().min(0).max(2).default(1),
  browser: z.object({ executablePath: z.string().optional(), channel: id.optional(), profileDirectory: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), headless: z.boolean().default(false), loginUrlPattern: z.string().max(500).optional(),
    clientCertificates: z.array(z.object({ origin: endpoint, certFile: z.string(), keyFile: z.string(), passphraseEnv: envName.optional() }).strict()).max(10).optional()
  }).strict().optional()
}).strict();
export type PrivateProfile = z.infer<typeof privateProfileSchema>;
