import { createServer, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

export type SyntheticExportDelivery = { period: string | null; scope: string | null; declaredRows: number; deliveredRows: number; payloadHash: string; complete: boolean };

export type BrowserReportExportMode = 'complete' | 'truncated' | 'empty' | 'error-html' | 'cancelled' | 'expired' | 'redirect-foreign';
const loginHtml = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Синтетический вход</title><main><h1>Локальный тестовый вход</h1><form action="/login" method="post"><label>Пароль стенда <input type="password" name="password" autocomplete="off"></label><button type="submit">Войти в тестовый отчёт</button></form></main></html>`;
const reportHtml = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Синтетический отчёт ОКО</title><style>body{font:16px system-ui;margin:16px}main{max-width:800px}label{display:block;margin:12px 0}input,select,button{font:inherit;max-width:100%;box-sizing:border-box}button{padding:8px}a{display:inline-block;margin:8px}</style><main><h1 data-testid="report-ready">Синтетический отчёт готов</h1><p data-testid="row-count" data-total-rows="2000">Строк в отчёте: 2000</p><form action="/export" method="get"><label for="period">Период</label><input id="period" name="period" value="2026-10"><label for="scope">Состав</label><select id="scope" name="scope"><option value="all">Все продукты</option><option value="product-a">Продукт А</option><option value="product-b">Продукт Б</option></select><button id="export" data-testid="export" type="submit">Выгрузить CSV</button></form><a href="/redirect-foreign" id="foreign-navigation">Проверить запрещённый переход</a><a href="/login-page" id="login-page">Открыть страницу входа</a></main></html>`;
const csv = (rows: number) => 'Key;Product;Leader;Amount;Date\n' + Array.from({ length: rows }, (_, i) => `row-${String(i + 1).padStart(4, '0')};Продукт ${i % 2 ? 'Б' : 'А'};Лидер ${i % 2 ? 'Б' : 'А'};${i + 1},25;31.10.2026`).join('\n') + '\n';

/** Explicitly synthetic loopback fixture; never imported by production composition.
 * No timer drives report/download readiness. Each export waits for one release('download').
 */
export async function startBrowserReportFixture() {
  const log: string[] = [];
  const deliveries: SyntheticExportDelivery[] = [];
  const events = new Map<string, number>(), listeners = new Map<string, Array<{ resolve(): void; reject(error: Error): void }>>();
  const permits = new Map<string, number>(), gates = new Map<string, Array<(open: boolean) => void>>();
  let mode: BrowserReportExportMode = 'complete', closing = false, closePromise: Promise<void> | null = null;
  let missingSelector = false;
  let origin = '', forbiddenOrigin = '';
  const signal = (name: string) => {
    const listener = listeners.get(name)?.shift();
    if (listener) listener.resolve(); else events.set(name, (events.get(name) ?? 0) + 1);
  };
  const gate = (name: string) => {
    if (closing) return Promise.resolve(false);
    const count = permits.get(name) ?? 0;
    if (count) { permits.set(name, count - 1); return Promise.resolve(true); }
    return new Promise<boolean>(resolve => { const queue = gates.get(name) ?? []; queue.push(resolve); gates.set(name, queue); });
  };
  const send = (reply: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') => {
    reply.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); reply.end(body);
  };
  const forbidden = createServer((request, reply) => { log.push(forbiddenOrigin + request.url); signal('forbidden-request'); send(reply, 200, 'Synthetic forbidden origin'); });
  forbidden.on('upgrade', (request, socket) => { log.push(forbiddenOrigin + request.url); signal('forbidden-websocket'); socket.destroy(); });
  const report = createServer((request, reply) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin);
      log.push(url.href); signal('request:' + url.pathname);
      const authenticated = (request.headers.cookie ?? '').split(';').some(value => value.trim() === 'oko_fixture=authenticated');
      if (url.pathname === '/login' && request.method === 'POST') {
        // Deliberately discard input. Fixture telemetry never stores password/cookie/body values.
        request.resume(); reply.writeHead(303, { location: '/report', 'set-cookie': 'oko_fixture=authenticated; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600', 'cache-control': 'no-store' }); reply.end(); signal('login'); return;
      }
      if (url.pathname === '/login-page') { send(reply, 200, loginHtml); return; }
      if (url.pathname === '/security') {
        if (!authenticated) { send(reply, 200, loginHtml); return; }
        send(reply, 200, `<!doctype html><html lang="ru"><meta charset="utf-8"><h1 data-testid="report-ready">Синтетическая проверка origin</h1><button id="check">Проверить ограничения origin</button><script>
document.getElementById('check').onclick = async function () {
  const target = ${JSON.stringify(forbiddenOrigin)};
  const http = fetch(target + '/foreign-fetch').catch(() => {});
  const ws = new Promise(resolve => { const socket = new WebSocket(target.replace('http:', 'ws:') + '/foreign-ws'); socket.onclose = resolve; socket.onerror = resolve; });
  const frame = new Promise(resolve => { const child = document.createElement('iframe'); child.id = 'foreign-frame'; child.onload = resolve; child.onerror = resolve; child.src = target + '/foreign-frame'; document.body.append(child); });
  const worker = navigator.serviceWorker.register('/synthetic-worker.js').catch(() => {});
  await Promise.all([http, ws, frame, worker]); const done = document.createElement('p'); done.dataset.testid = 'security-complete'; done.textContent = 'Проверки завершены'; document.body.append(done);
};</script></html>`); return;
      }
      if (url.pathname === '/synthetic-worker.js') { send(reply, 200, 'self.addEventListener("fetch", () => {});', 'application/javascript'); return; }
      if (url.pathname === '/report' || url.pathname === '/') { send(reply, 200, authenticated ? missingSelector ? reportHtml.replace('id="export" data-testid="export"', 'id="export-changed" data-testid="export-changed"') : reportHtml : loginHtml); signal(authenticated ? 'report-ready' : 'login-page'); return; }
      if (url.pathname === '/redirect-foreign') { reply.writeHead(302, { location: forbiddenOrigin + '/blocked' }); reply.end(); return; }
      if (url.pathname === '/export') {
        signal('export-requested');
        if (!authenticated || mode === 'expired') { send(reply, 401, loginHtml); signal('export-auth-required'); return; }
        const selected = mode;
        if (!await gate('download') || reply.destroyed) return;
        if (selected === 'cancelled') { reply.destroy(); return; }
        if (selected === 'redirect-foreign') { reply.writeHead(302, { location: forbiddenOrigin + '/blocked-export' }); reply.end(); return; }
        if (selected === 'error-html') { send(reply, 200, '<html><h1>Синтетическая ошибка выгрузки</h1></html>'); signal('export-delivered'); return; }
        const bytes = Buffer.from(selected === 'empty' ? '' : csv(selected === 'truncated' ? 1000 : 2000), 'utf8');
        const deliveredRows = selected === 'empty' ? 0 : selected === 'truncated' ? 1000 : 2000;
        deliveries.push({ period: url.searchParams.get('period'), scope: url.searchParams.get('scope'), declaredRows: 2000, deliveredRows, payloadHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), complete: deliveredRows === 2000 });
        reply.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="synthetic-oko.csv"', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        reply.end(bytes); signal('export-delivered'); return;
      }
      send(reply, 404, 'Synthetic route not found', 'text/plain; charset=utf-8');
    })().catch(() => { if (!reply.headersSent && !reply.destroyed) send(reply, 500, 'Synthetic fixture failure', 'text/plain; charset=utf-8'); else reply.destroy(); });
  });
  const listen = (server: Server) => new Promise<string>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); const address = server.address(); if (!address || typeof address === 'string') { reject(Error('Invalid loopback address')); return; } resolve('http://127.0.0.1:' + address.port); });
  });
  const stop = (server: Server) => new Promise<void>((resolve, reject) => { if (!server.listening) { resolve(); return; } server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  try { forbiddenOrigin = await listen(forbidden); origin = await listen(report); }
  catch (error) { await Promise.allSettled([stop(report), stop(forbidden)]); throw error; }
  return {
    origin, forbiddenOrigin,
    waitForEvent(name: string): Promise<void> {
      if (closing) return Promise.reject(Error('Synthetic report fixture is closed'));
      const count = events.get(name) ?? 0;
      if (count) { events.set(name, count - 1); return Promise.resolve(); }
      return new Promise<void>((resolve, reject) => { const queue = listeners.get(name) ?? []; queue.push({ resolve, reject }); listeners.set(name, queue); });
    },
    release(name: string): void { if (closing) return; const waiting = gates.get(name)?.shift(); if (waiting) waiting(true); else permits.set(name, (permits.get(name) ?? 0) + 1); },
    setExportMode(value: BrowserReportExportMode): void { mode = value; },
    setMissingSelector(value: boolean): void { missingSelector = value; },
    requests(): string[] { return [...log]; },
    deliveries(): SyntheticExportDelivery[] { return structuredClone(deliveries); },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      for (const queue of gates.values()) for (const waiting of queue.splice(0)) waiting(false);
      for (const queue of listeners.values()) for (const listener of queue.splice(0)) listener.reject(Error('Synthetic report fixture is closed'));
      closePromise = Promise.all([stop(report), stop(forbidden)]).then(() => undefined); return closePromise;
    },
  };
}
