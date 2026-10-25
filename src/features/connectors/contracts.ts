import { z } from 'zod';
import { ActionError } from '../identity/role-service';
const id = z.string().min(1).max(200);
const envName=z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,199}$/,'Укажите имя переменной окружения вместо значения секрета');
const parameterName=id.refine(value=>!/password|passwd|pwd|secret|token|authorization|cookie|session|credential|saml|otp|api.?key/i.test(value),'Секретные параметры допускаются только в личном профиле доступа');
const parameterValue=z.string().max(2000).refine(value=>!/^\s*(?:Bearer|Basic)\s+\S|-----BEGIN .*PRIVATE KEY-----/i.test(value),'Значения секретов запрещены в общем сценарии');
const endpoint = z.string().url().max(4000).refine(v => { const url=new URL(v);return !url.username && !url.password && ![...url.searchParams.keys()].some(key=>/token|password|secret|credential|authorization|saml|code/i.test(key)); }, 'Credentials in URL forbidden');
const selector = z.string().min(1).max(1000).refine(v => !/password|token|secret|otp|saml|authorization|credential/i.test(v), 'Secret selectors forbidden');
export const stepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: endpoint }).strict(),
  z.object({ action: z.literal('click'), selector }).strict(),
  z.object({ action: z.literal('fill'), selector, parameter: parameterName }).strict(),
  z.object({ action: z.literal('select'), selector, parameter: parameterName }).strict(),
  z.object({ action: z.literal('check'), selector, checked: z.boolean() }).strict(),
  z.object({ action: z.literal('wait'), selector }).strict(),
  z.object({ action: z.literal('download'), selector }).strict()
]);
export const scenarioSchema = z.object({ id, startUrl: endpoint, steps: z.array(stepSchema).max(100) }).strict();
export const collectionSchema = z.object({ adapter: z.enum(['http', 'confluence', 'qlik', 'browser']), format: z.enum(['observations-json', 'csv', 'xlsx']), authProfileId: id,
  endpoint: endpoint.optional(), goalId: id.optional(), scenarioId: id.optional(), scenario: scenarioSchema.optional(), authenticatedSelector:selector.optional(), parameters: z.record(parameterName,parameterValue).optional(),
  confluence: z.object({ deployment: z.enum(['cloud', 'datacenter']), downloadUrl: endpoint }).strict().optional(),
  qlik: z.object({ appId: id, objectId: id, exportFormat: z.enum(['CSV_C', 'CSV_T', 'OOXML']) }).strict().optional()
}).strict();
export type BrowserScenario = z.infer<typeof scenarioSchema>;
export type BrowserStep = z.infer<typeof stepSchema>;
export const privateProfileSchema = z.object({ allowedOrigins: z.array(endpoint).min(1).max(30),
  bearerEnv: envName.optional(), headersEnv: z.record(id, envName).optional(), caFile: z.string().optional(), certFile: z.string().optional(), keyFile: z.string().optional(), passphraseEnv: envName.optional(),
  maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).default(10 * 1024 * 1024), timeoutMs: z.number().int().min(100).max(120000).default(30000), retries: z.number().int().min(0).max(2).default(1),
  browser: z.object({ executablePath: z.string().optional(), channel: id.optional(), profileDirectory: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), headless: z.boolean().default(false), loginUrlPattern: z.string().max(500).optional(),
    clientCertificates: z.array(z.object({ origin: endpoint, certFile: z.string(), keyFile: z.string(), passphraseEnv: envName.optional() }).strict()).max(10).optional()
  }).strict().optional()
}).strict();
export type PrivateProfile = z.infer<typeof privateProfileSchema>;
export const privateConfigSchema = z.object({ profiles: z.record(id, privateProfileSchema) }).strict();
export type ConnectorErrorCode = 'configuration_required' | 'manual_required' | 'manual_login_required' | 'access_denied' | 'network' | 'certificate' | 'timeout' | 'format' | 'incomplete' | 'cancelled';
export class ConnectorError extends ActionError {
  constructor(public code: ConnectorErrorCode, message: string) { super(`${code}: ${message}`, code === 'access_denied' ? 403 : code === 'configuration_required' ? 409 : 422); }
}
export function connectorError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const e = error as Error & { code?: string };
  if (e.name === 'AbortError') return new ConnectorError('cancelled', 'Получение отменено');
  if (/cert|tls|ssl|self.signed|issuer/i.test(`${e.code} ${e.message}`)) return new ConnectorError('certificate', 'Не пройдена проверка сертификата. Настройте доверенный CA/клиентский сертификат');
  if (/timeout|timed.out/i.test(`${e.code} ${e.message}`)) return new ConnectorError('timeout', 'Истекло ограниченное время получения');
  return new ConnectorError('network', 'Источник недоступен. Проверьте сеть, адрес и профиль доступа');
}
