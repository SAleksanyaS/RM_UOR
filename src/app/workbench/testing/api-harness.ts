import { createWorkbenchTestApplication } from '../../../server/workbench/testing/test-application';
import { WorkbenchClient } from '../api-client';

export type RecordedRequest = { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> | null };
function safeJson(body: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(body, (key, value) => /password|secret|authorization|cookie|private.?key|access.?token|refresh.?token|csrf.?token|credential/i.test(key) ? '[redacted]' : value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
/** Only synthetic app.inject traffic is recorded. Browser cookies never enter client code. */
export async function createWorkbenchApiHarness(options: Parameters<typeof createWorkbenchTestApplication>[0]) {
  const origin = options.clientOrigin ?? 'http://127.0.0.1:5173';
  const application = await createWorkbenchTestApplication(options);
  const requests: RecordedRequest[] = [];
  const cookies = new Map<string, string>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, origin);
    if (url.origin !== origin) throw Error('Test harness refuses external requests');
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('host', url.host); headers.set('origin', origin);
    let payload: string | Buffer | undefined, body: RecordedRequest['body'] = null;
    const raw = init?.body ?? (input instanceof Request && !['GET', 'HEAD'].includes(method) ? await input.text() : undefined);
    if (raw instanceof FormData) {
      body = {};
      for (const [key, value] of raw.entries()) body[key] = typeof value === 'string' ? value : { name: value.name, type: value.type, size: value.size };
      // The native encoder chooses the boundary, just as a browser does.
      const encoded = new Request(url, { method, body: raw });
      headers.set('content-type', encoded.headers.get('content-type')!); payload = Buffer.from(await encoded.arrayBuffer());
    } else if (typeof raw === 'string') { payload = raw; body = safeJson(raw); }
    else if (raw !== undefined && raw !== null) throw Error('Unsupported harness request body');
    const recordedHeaders: Record<string, string> = {};
    headers.forEach((value, key) => {
      if (!['cookie', 'authorization', 'proxy-authorization', 'x-api-key'].includes(key)) recordedHeaders[key] = key === 'x-csrf-token' ? '[present]' : value;
    });
    requests.push({ method, url: url.pathname + url.search, headers: recordedHeaders, body });
    if (init?.credentials !== 'omit' && cookies.size) headers.set('cookie', [...cookies].map(([key, value]) => key + '=' + value).join('; '));
    const response = await application.app.inject({ method: method as 'GET' | 'POST', url: url.pathname + url.search, headers: Object.fromEntries(headers.entries()), payload });
    for (const cookie of response.cookies) cookies.set(cookie.name, cookie.value);
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && key.toLowerCase() !== 'set-cookie') responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    return new Response(new Uint8Array(response.rawPayload), { status: response.statusCode, headers: responseHeaders });
  };
  return { ...application, requests, fetch: fetcher, client: new WorkbenchClient({ fetch: fetcher }), close: application.close };
}
