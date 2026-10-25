import WebSocket from 'ws';
import { ConnectorError, type PrivateProfile } from './contracts';
import { checkedUrl, download, profileHeaders, tlsOptions } from './transport';
import type { SourceCollection } from '../../domain/contracts';
/** Qlik Engine JSON-RPC; deployment-specific endpoint/session is explicit configuration. */
export async function collectQlik(config: SourceCollection, profile: PrivateProfile, signal: AbortSignal) {
  if (!config.endpoint || !config.qlik) throw new ConnectorError('configuration_required', 'Укажите точный Engine websocket endpoint, appId и objectId Qlik');
  const endpoint = checkedUrl(config.endpoint, profile, true), socket = new WebSocket(endpoint, { ...await tlsOptions(profile), headers: profileHeaders(profile), handshakeTimeout: profile.timeoutMs, maxPayload: profile.maxBytes });
  let sequence = 0; const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const abort = () => socket.terminate(); signal.addEventListener('abort', abort, { once: true });
  const rpc = (handle: number, method: string, params: unknown[]) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new ConnectorError('timeout', 'Qlik Engine не ответил вовремя')); }, profile.timeoutMs);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ jsonrpc: '2.0', id, handle, method, params }));
  });
  socket.on('message', bytes => { let result; try { result = JSON.parse(bytes.toString()); } catch { socket.terminate(); return; }
    const wait = pending.get(result.id); if (!wait) return; pending.delete(result.id); clearTimeout(wait.timer);
    if (result.error) wait.reject(new ConnectorError('format', 'Qlik Engine отклонил запрос: проверьте объект и разрешение export')); else wait.resolve(result.result ?? {});
  });
  socket.on('close', () => { for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new ConnectorError(signal.aborted ? 'cancelled' : 'incomplete', 'Соединение Qlik завершено')); } pending.clear(); });
  socket.on('error', () => {});
  try {
    signal.throwIfAborted(); await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new ConnectorError(signal.aborted ? 'cancelled' : 'manual_login_required', 'Qlik не открыл сессию. Проверьте сертификат/SSO и endpoint'))); });
    const doc = await rpc(-1, 'OpenDoc', [config.qlik.appId, '', '', '', false]), handle = (doc.qReturn as { qHandle?: number })?.qHandle;
    if (!handle) throw new ConnectorError('format', 'Qlik OpenDoc не вернул handle');
    const object = await rpc(handle, 'GetObject', [config.qlik.objectId]), objectHandle = (object.qReturn as { qHandle?: number })?.qHandle;
    if (!objectHandle) throw new ConnectorError('format', 'Qlik GetObject не вернул handle');
    const result = await rpc(objectHandle, 'ExportData', [config.qlik.exportFormat, '/qHyperCubeDef', 'uor-export', 'A']);
    if (typeof result.qUrl !== 'string' || !result.qUrl) throw new ConnectorError('incomplete', 'Qlik не вернул qUrl выгрузки');
    const base = new URL(endpoint); base.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    return await download(new URL(result.qUrl, base).href, profile, signal);
  } finally { signal.removeEventListener('abort', abort); for (const wait of pending.values()) clearTimeout(wait.timer); socket.terminate(); }
}
