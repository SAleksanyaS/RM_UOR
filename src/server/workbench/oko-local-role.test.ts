import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sessionViewSchema } from './protocol';
import { createLocalPreviewPolicy } from './oko-local-role';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.basename(root).startsWith('oko-local-role-')) throw Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'oko-local-role-'));
  roots.push(directory);
  const personId = randomUUID();
  const options = { directory, personId, clock: { now: () => '2026-10-28T09:00:00Z' }, capabilityFor: (name: string) => name === 'local.prepare' ? 'uor.prepare' as const : 'package.submit' as const };
  return { directory, personId, options, policy: createLocalPreviewPolicy(options) };
}

it('starts as an explicitly marked local editor who can prepare but cannot publish', async () => {
  const { personId, policy } = await fixture();
  const own = await policy.resolveOwnAccess();
  expect(own).toMatchObject({ role: 'curator', personId, policyState: 'local_preview' });
  expect(sessionViewSchema.safeParse({ ...own, allowedCommands: ['local.prepare'], csrfToken: 'synthetic', defaultContext: null }).success).toBe(true);
  await expect(policy.assertCommandAllowed('local.prepare')).resolves.toMatchObject({ role: 'curator' });
  await expect(policy.assertCommandAllowed('external.publish')).rejects.toMatchObject({ code: 'LOCAL_PREVIEW_ONLY' });
  await expect(policy.assertFreshPublishAllowed(randomUUID())).rejects.toMatchObject({ code: 'LOCAL_PREVIEW_ONLY' });
});

it('switches to reader, denies preparation, and restores editor after reopening the local role file', async () => {
  const { directory, personId, options, policy } = await fixture();
  await policy.setRole('viewer');
  const reopened = createLocalPreviewPolicy(options);
  expect(await reopened.resolveOwnAccess()).toMatchObject({ role: 'viewer', personId, policyState: 'local_preview' });
  await expect(reopened.assertCommandAllowed('local.prepare')).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  await reopened.setRole('curator');
  expect(await policy.resolveOwnAccess()).toMatchObject({ role: 'curator', personId, policyState: 'local_preview' });
  expect(JSON.parse(await readFile(path.join(directory, 'oko-local-role.json'), 'utf8'))).toEqual({ schemaVersion: 1, role: 'curator' });
  await expect(reopened.assertFreshPublishAllowed(randomUUID())).rejects.toMatchObject({ code: 'LOCAL_PREVIEW_ONLY' });
});
