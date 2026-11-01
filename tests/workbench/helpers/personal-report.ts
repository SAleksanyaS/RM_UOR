import { createServer } from 'node:http';

/** The report deliberately contains no human product/leader values. */
export const rawPersonalReport = Buffer.from('RowId;ProductAlias;Amount;Date;directory.productName\r\n=row-1;ALIAS-A;12.5;2026-10-28;source-column\r\nrow-2;ALIAS-A;9007199254740993.25;2026-10-28;source-column\r\n', 'utf8');
export async function startPersonalReport() {
  let origin = '', exports = 0, closed = false;
  const gates: Array<() => void> = [], permits: number[] = [];
  const waiters: Array<() => void> = [];
  const report = createServer((request, reply) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin), logged = (request.headers.cookie ?? '').includes('personal_synthetic=1');
      if (url.pathname === '/login' && request.method === 'POST') { request.resume(); reply.writeHead(303, { location: '/report', 'set-cookie': 'personal_synthetic=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600' }); reply.end(); return; }
      if (!logged) { reply.setHeader('content-type', 'text/html; charset=utf-8'); reply.end('<!doctype html><meta charset="utf-8"><h1>Синтетический вход</h1><form action="/login" method="post"><label for="secret">Пароль стенда</label><input id="secret" type="password" name="secret"><button>Войти в тестовый отчёт</button></form>'); return; }
      if (url.pathname === '/export') {
        exports++; for (const notify of waiters.splice(0)) notify();
        if (permits.length) permits.pop(); else await new Promise<void>(resolve => gates.push(resolve));
        if (closed || reply.destroyed) return;
        reply.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="personal-raw.csv"', 'content-length': rawPersonalReport.length }); reply.end(rawPersonalReport); return;
      }
      reply.setHeader('content-type', 'text/html; charset=utf-8');
      reply.end('<!doctype html><meta charset="utf-8"><main><h1 data-testid="personal-ready">Личный синтетический отчёт</h1><form action="/export"><label for="period">Период</label><input id="period" name="period" value="2026-10"><label for="scope">Состав</label><select id="scope" name="scope"><option value="all">Все продукты</option></select><button>Выгрузить CSV</button></form></main>');
    })().catch(() => reply.destroy());
  });
  await new Promise<void>((resolve, reject) => { report.once('error', reject); report.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + (report.address() as { port: number }).port;
  return { origin, exportCount: () => exports,
    waitForExport(after: number) { return exports > after ? Promise.resolve() : new Promise<void>(resolve => waiters.push(resolve)); },
    release() { const gate = gates.shift(); if (gate) gate(); else permits.push(1); },
    async close() { if (closed) return; closed = true; for (const gate of gates.splice(0)) gate(); await new Promise<void>((resolve, reject) => { report.close(error => error ? reject(error) : resolve()); report.closeAllConnections(); }); },
  };
}
