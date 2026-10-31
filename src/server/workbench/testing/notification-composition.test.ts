import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createWorkbenchApiHarness } from '../../../app/workbench/testing/api-harness';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
it('exposes and executes real personal notification commands for a reader', async () => {
  const h = await createWorkbenchApiHarness({ role: 'viewer', scenario: 'empty' }); cleanups.push(h.close);
  const session = await h.client.session();
  expect(session.data.allowedCommands).toContain('notifications.markRead');
  expect(session.data.allowedCommands).toContain('notifications.subscribe');
  const commandId = randomUUID();
  const result = await h.client.command({ commandId, name: 'notifications.markRead', payload: { notificationIds: [] }, baseRevision: null });
  expect(result.data).toMatchObject({ commandId, result: { notificationIds: [] } });
});
