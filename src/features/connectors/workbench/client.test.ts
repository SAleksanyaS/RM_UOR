import { expect, it, vi } from 'vitest';
import { OkoClient, OkoClientError } from './client';

it('obtains the real session token and sends strict own-query and command envelopes', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: String(url).endsWith('/session') ? { csrfToken: 'own-csrf' } : { commandId: String(url).endsWith('/commands') ? JSON.parse(String(init?.body)).commandId : '11111111-1111-4111-8111-111111111111', result: { workflowId: 'own' }, changedRefs: [], editToken: null } }), { status: 200 });
  };
  const client = new OkoClient(fetcher as typeof fetch);
  await client.session(); await client.workspace('own'); await client.command('source.browser.workflow.open', { workflowId: 'own' });
  expect(JSON.parse(String(requests[1].init?.body))).toMatchObject({ context: null, filter: { workflowId: 'own' }, sort: [] });
  expect(requests[2].init?.headers).toMatchObject({ 'x-csrf-token': 'own-csrf' });
  expect(JSON.parse(String(requests[2].init?.body))).toMatchObject({ name: 'source.browser.workflow.open', payload: { workflowId: 'own' } });
});

it('preserves actionable API failure codes instead of returning a success-shaped value', async () => {
  const client = new OkoClient((async () => new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: 'Настройки изменились', details: [] } }), { status: 409 })) as typeof fetch);
  await expect(client.workspace()).rejects.toMatchObject({ name: 'OkoClientError', code: 'REVISION_CONFLICT', message: 'Настройки изменились' });
  expect(new OkoClientError('X', 'Ошибка').message).toBe('Ошибка');
});
it('calls browser fetch with its global receiver rather than the client instance', async () => {
  const stub = vi.spyOn(globalThis, 'fetch').mockImplementation(function(this: unknown) { if (this !== globalThis) throw new TypeError('Illegal invocation'); return Promise.resolve(new Response(JSON.stringify({ data: { csrfToken: 'own' } }))); });
  try { expect((await new OkoClient().session()).csrfToken).toBe('own'); } finally { stub.mockRestore(); }
});
it('keeps response-loss uncertainty for invalid or server-error command replies', async () => {
  for (const response of [new Response('invalid-json', { status: 200 }), new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Lost after commit' } }), { status: 500 })]) {
    const client = new OkoClient((async () => response) as typeof fetch);
    await expect(client.command('source.browser.workflow.open', {})).rejects.toMatchObject({ uncertain: true });
  }
});

const validCommandId = '11111111-1111-4111-8111-111111111111', validJobId = '22222222-2222-4222-8222-222222222222';
it.each([
  { label: 'null', data: null }, { label: 'number', data: 7 }, { label: 'string', data: 'accepted' }, { label: 'boolean', data: true }, { label: 'array', data: [] },
  { label: 'missing result', data: { commandId: validCommandId, changedRefs: [], editToken: null } },
  { label: 'null result', data: { commandId: validCommandId, result: null, changedRefs: [], editToken: null } },
  { label: 'missing command fields', data: { result: {} } },
  { label: 'missing accepted job fields', data: { jobId: validJobId } },
  { label: 'missing accepted job id', data: { status: 'queued', pollAfterMs: 1000 } },
  { label: 'invalid accepted status', data: { jobId: validJobId, status: 'missing', pollAfterMs: 1000 } },
])('classifies malformed command success data ($label) as an uncertain response', async ({ data }) => {
  const client = new OkoClient((async () => new Response(JSON.stringify({ data }), { status: 200 })) as typeof fetch);
  await expect(client.command('source.browser.workflow.open', {}, validCommandId)).rejects.toMatchObject({ name: 'OkoClientError', code: 'INVALID_RESPONSE', uncertain: true });
});
it.each([null, 7, 'accepted', true, []])('classifies a malformed outer success envelope as uncertain', async envelope => {
  const client = new OkoClient((async () => new Response(JSON.stringify(envelope), { status: 200 })) as typeof fetch);
  await expect(client.command('source.browser.workflow.open', {}, validCommandId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE', uncertain: true });
});
