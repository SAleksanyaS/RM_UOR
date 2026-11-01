import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WorkbenchApiError, WorkbenchClient } from './api-client';
import { createWorkbenchApiHarness } from './testing/api-harness';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
it('sends_csrf_and_preserves_problem', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); cleanups.push(h.close);
  const session = await h.client.session();
  const request = { commandId: randomUUID(), name: 'preferences.set', baseRevision: null, payload: { values: { context: null, sorts: {}, visual: { theme: 'system', density: 'comfortable' }, notificationPersonId: null } } };
  const result = await h.client.command(request);
  expect(result.data).toHaveProperty('commandId', request.commandId);
  expect(session.data.csrfToken).toBeTruthy();
  expect(h.requests.at(-1)?.headers['x-csrf-token']).toBeTruthy();
  expect(JSON.stringify(h.requests)).not.toContain(session.data.csrfToken);
  expect(h.requests.at(-1)?.body).not.toHaveProperty('role');
  expect(h.requests.at(-1)?.headers.cookie).toBeUndefined();
  await expect(h.client.command({ ...request, commandId: randomUUID() })).rejects.toMatchObject({ status: 409, problem: { code: 'REVISION_CONFLICT' }, requestId: expect.any(String) });
  await expect(h.client.command({ ...request, commandId: randomUUID(), payload: { values: { notificationPersonId: null } } })).rejects.toBeInstanceOf(WorkbenchApiError);
  expect(h.requests.filter(r => r.body?.commandId === request.commandId)).toHaveLength(1);
});
it('keeps_empty_context_and_real_read_models', async () => {
  const empty = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'empty' }); cleanups.push(empty.close);
  expect((await empty.client.session()).data.defaultContext).toBeNull();
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'scope-split' }); cleanups.push(h.close);
  const context = (await h.client.session()).data.defaultContext!;
  const result = await h.client.query<{ entities: Array<{ id: string }> }>('context.options', { context, filter: {}, sort: [], page: { limit: 50, cursor: null } });
  expect(result.data.entities.some(e => e.id === context.scopePath.ditId)).toBe(true);
  await expect(h.client.job(randomUUID())).rejects.toMatchObject({ status: 404, problem: { code: 'JOB_NOT_FOUND' } });
});
it('uploads_form_data_without_retaining_file_bytes', async () => {
  const h = await createWorkbenchApiHarness({ role: 'curator', scenario: 'scope-split' }); cleanups.push(h.close);
  const result = await h.client.upload(new File(['synthetic evidence'], 'proof.txt', { type: 'text/plain' }), 'evidence');
  expect(result.data).toMatchObject({ name: 'proof.txt', bytes: 18 });
  expect(h.requests.at(-1)?.body).toEqual({ purpose: 'evidence', file: { name: 'proof.txt', type: 'text/plain', size: 18 } });
  expect(JSON.stringify(h.requests)).not.toContain('synthetic evidence');
});
it('uses_browser_credentials_and_never_retries_an_unknown_mutation', async () => {
  let count = 0;
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'empty' }); cleanups.push(h.close);
  const client = new WorkbenchClient({ fetch: async (input, init) => { expect(init?.credentials).toBe('same-origin'); if (String(input).endsWith('/commands')) { count++; throw Error('lost response'); } return h.fetch(input, init); } });
  await client.session();
  await expect(client.command({ commandId: randomUUID(), name: 'preferences.set', baseRevision: null, payload: {} })).rejects.toThrow('lost response');
  expect(count).toBe(1);
});
it.each(['malformed-command', 'foreign-command', 'malformed-upload'] as const)('rejects_%s_without_retry', async kind => {
  const h = await createWorkbenchApiHarness({ role: 'curator', scenario: 'scope-split' }); cleanups.push(h.close);
  const session = await h.client.session(), requestId = randomUUID(), commandId = randomUUID();
  let mutations = 0;
  const client = new WorkbenchClient({ fetch: async input => {
    if (String(input).endsWith('/session')) return new Response(JSON.stringify(session), { status: 200 });
    mutations++;
    const data = kind === 'foreign-command' ? { commandId: randomUUID(), result: {}, changedRefs: [], editToken: null } : {};
    return new Response(JSON.stringify({ ...session, requestId, data }), { status: 200 });
  } });
  const response = kind === 'malformed-upload' ? client.upload(new File(['proof'], 'proof.txt', { type: 'text/plain' }), 'evidence') : client.command({ commandId, name: 'preferences.set', baseRevision: null, payload: {} });
  await expect(response).rejects.toMatchObject({ name: 'WorkbenchApiError', status: 200, requestId, problem: { code: 'INVALID_RESPONSE' } });
  expect(mutations).toBe(1);
});
