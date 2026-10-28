import { expect, it } from 'vitest';
import { z } from 'zod';
import { QueryRegistry, type QueryContext } from './query-registry';
import { ownQueryRequestSchema, queryRequestSchema } from './protocol';

it('supports a scope-free own query while business descriptors still require a real global context', async () => {
  const registry = new QueryRegistry();
  registry.register({ name: 'source.browser.workspace', inputSchema: ownQueryRequestSchema, outputSchema: z.strictObject({ installationId: z.string() }), handler: async context => ({ installationId: context.installationId }) });
  registry.register({ name: 'overview', inputSchema: queryRequestSchema, outputSchema: z.strictObject({ ok: z.boolean() }), handler: async () => ({ ok: true }) });
  const context = { installationId: 'own-installation', ownAccess: { role: 'viewer' } } as QueryContext;
  const request = { context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } };
  expect(await registry.execute('source.browser.workspace', request, context)).toEqual({ installationId: 'own-installation' });
  await expect(registry.execute('overview', request, context)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(queryRequestSchema.safeParse(request).success).toBe(false);
});
