import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { safeArtifactPath } from '../../server/workspace/paths';
import { ConnectorError, connectorError, privateConfigSchema, type PrivateProfile } from './contracts';

export async function loadProfile(runtimeRoot: string, id: string): Promise<PrivateProfile> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path.join(runtimeRoot, 'local-config/connectors.json'), 'utf8')); }
  catch { throw new ConnectorError('configuration_required', 'Настройте приватный файл .runtime/local-config/connectors.json'); }
  const parsed = privateConfigSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.profiles[id]) throw new ConnectorError('configuration_required', 'Профиль доступа отсутствует или имеет неверный формат');
  return parsed.data.profiles[id];
}
export function checkedUrl(value: string, profile: PrivateProfile, websocket = false) {
  let url: URL; try { url = new URL(value); } catch { throw new ConnectorError('configuration_required', 'Не указан точный адрес источника'); }
  const origin = url.origin.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const protocols = websocket ? ['wss:', 'ws:'] : ['https:', 'http:'];
  if (!protocols.includes(url.protocol) || url.username || url.password || !profile.allowedOrigins.includes(origin)) throw new ConnectorError('configuration_required', 'Адрес отсутствует в разрешённых origins приватного профиля');
  if (['http:', 'ws:'].includes(url.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new ConnectorError('configuration_required', 'Корпоративное соединение требует TLS');
  return url;
}
export function profileHeaders(profile: PrivateProfile): Record<string, string> {
  const headers: Record<string, string> = {};
  const env = (key: string) => { const v = process.env[key]; if (!v || /[\r\n]/.test(v)) throw new ConnectorError('configuration_required', 'Не задана переменная окружения профиля доступа'); return v; };
  if (profile.bearerEnv) headers.Authorization = `Bearer ${env(profile.bearerEnv)}`;
  for (const [header, variable] of Object.entries(profile.headersEnv ?? {})) { if (!/^[a-zA-Z0-9-]+$/.test(header)) throw new ConnectorError('configuration_required', 'Неверное имя заголовка'); headers[header] = env(variable); }
  return headers;
}
export async function tlsOptions(profile: PrivateProfile) {
  return { ...(profile.caFile ? { ca: await readFile(profile.caFile) } : {}), ...(profile.certFile ? { cert: await readFile(profile.certFile) } : {}), ...(profile.keyFile ? { key: await readFile(profile.keyFile) } : {}), ...(profile.passphraseEnv ? { passphrase: process.env[profile.passphraseEnv] } : {}), rejectUnauthorized: true as const };
}
export interface Downloaded { bytes: Buffer; name: string; contentType: string }
/** Each redirect is validated before forwarding any private headers. */
export async function download(value: string, profile: PrivateProfile, signal: AbortSignal): Promise<Downloaded> {
  const tls = await tlsOptions(profile), headers = profileHeaders(profile);
  const once = async (address: string, redirects = 0): Promise<Downloaded> => {
    signal.throwIfAborted(); const url = checkedUrl(address, profile);
    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { ...tls, headers, signal }, res => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) { res.resume(); if (redirects >= 4 || !res.headers.location) { reject(new ConnectorError('format', 'Слишком много перенаправлений')); return; }
          let next:URL;try{next=new URL(res.headers.location,url);}catch{reject(new ConnectorError('format','Источник вернул некорректное перенаправление'));return;} if (next.origin !== url.origin) { reject(new ConnectorError('manual_login_required', 'Источник перенаправил на другой origin; выполните вход в браузере')); return; }
          once(next.href, redirects + 1).then(resolve, reject); return; }
        if (status === 401) { res.resume(); reject(new ConnectorError('manual_login_required', 'Требуется вход или обновление токена')); return; }
        if (status === 403) { res.resume(); reject(new ConnectorError('access_denied', 'Источник отказал в доступе')); return; }
        if (status < 200 || status >= 300) { res.resume(); const error = new ConnectorError('network', `Источник вернул HTTP ${status}`); Object.assign(error, { transient: [429,500,502,503,504].includes(status) }); reject(error); return; }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > profile.maxBytes) { const e = new ConnectorError('format', 'Файл превышает допустимый размер'); reject(e); res.destroy(e); req.destroy(e); } else chunks.push(chunk); });
        res.on('error', reject); res.on('aborted', () => reject(new ConnectorError('incomplete', 'Передача файла прервана')));
        res.on('end', () => { const expected = Number(res.headers['content-length']); if (Number.isFinite(expected) && expected !== size) reject(new ConnectorError('incomplete', 'Длина файла не соответствует заголовку')); else resolve({ bytes: Buffer.concat(chunks), name: path.basename(url.pathname) || 'download', contentType: String(res.headers['content-type'] ?? '') }); });
      });
      const timer = setTimeout(() => req.destroy(new ConnectorError('timeout', 'Истекло время получения файла')), profile.timeoutMs);
      req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end();
    });
  };
  for (let attempt = 0; ; attempt++) { try { return await once(value); } catch (e) {
    const raw = e as Error & { transient?: boolean; code?: string };
    if (attempt >= profile.retries || !(raw.transient || ['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT'].includes(raw.code ?? ''))) throw connectorError(e);
    await delay(200 * (attempt + 1), undefined, { signal });
  } }
}

const queues = new Map<string, Promise<void>>();
/** A cancelled waiter releases its slot only after its predecessor, preserving exclusivity. */
export async function withProfileQueue<T>(key: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve(); let release!: () => void;
  const own = new Promise<void>(resolve => { release = resolve; }); const tail = previous.then(() => own); queues.set(key, tail);
  let aborted: (() => void) | undefined;
  try {
    await Promise.race([previous, new Promise<never>((_, reject) => { aborted = () => reject(new DOMException('Aborted', 'AbortError')); signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted(); })]);
    signal.throwIfAborted(); return await run();
  } finally {
    if (aborted) signal.removeEventListener('abort', aborted);
    void previous.then(release).then(() => { if (queues.get(key) === tail) queues.delete(key); });
  }
}
export async function browserProfilePath(runtimeRoot: string, profile: PrivateProfile) {
  if (!profile.browser) throw new ConnectorError('configuration_required', 'Не настроен браузерный профиль');
  return safeArtifactPath(runtimeRoot, `browser-profiles/${profile.browser.profileDirectory}`);
}
