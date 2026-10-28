import { expect, it, vi } from 'vitest';
import { OkoClient, OkoClientError } from './client';

it('obtains the real session token and sends strict own-query and command envelopes', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: String(url).endsWith('/session') ? { csrfToken: 'own-csrf' } : { commandId: 'id', result: { workflowId: 'own' }, changedRefs: [], editToken: null } }), { status: 200 });
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
