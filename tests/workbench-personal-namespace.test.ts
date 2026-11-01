import { afterEach, expect, it } from 'vitest';
import { OkoClient } from '../src/features/connectors/workbench/client';
import { createPersonalRuntime } from './fixtures/workbench/personal-runtime';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
it('combined personal commands use their own registered namespace and reconcile the exact original receipt', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close);
  expect(f.commands.listNames()).toContain('oko.workflow.open');
  expect(f.commands.listNames()).not.toContain('source.browser.record.start');
  const client = new OkoClient(f.fetcher, { prefix: 'oko.workflow' });
  const session = await client.session();
  expect(session.allowedCommands).toContain('source.browser.workflow.open');
  const commandId = crypto.randomUUID();
  const opened = await client.command('source.browser.workflow.open', { title: 'Личный отчёт без каталога' }, commandId);
  expect(opened).toMatchObject({ title: 'Личный отчёт без каталога' });
  expect(f.requests.find(request => request.body?.commandId === commandId)?.body?.name).toBe('oko.workflow.open');
  expect((await client.workspace()).workflows).toHaveLength(1);
  const receipt = await client.reconcileCommand(commandId);
  expect(receipt).toMatchObject({ name: 'source.browser.workflow.open', status: 'completed', result: { title: 'Личный отчёт без каталога' } });
  await expect(client.command('source.browser.profile.set', { sourceId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  expect(f.requests.at(-1)?.body?.name).toBe('oko.workflow.profile.set');
});
it('combined personal role selection delegates the same stable local policy without changing identity or registry state', async () => {
  const f = await createPersonalRuntime(); closes.push(f.close);
  const client = new OkoClient(f.fetcher, { prefix: 'oko.workflow' });
  const before = await client.session();
  await client.command('source.browser.role.set', { role: 'viewer' });
  expect(f.requests.at(-1)?.body?.name).toBe('workbench.role.set');
  expect(await client.session()).toMatchObject({ personId: before.personId, role: 'viewer', policyState: 'local_preview' });
  expect((await client.workspace()).workflows).toHaveLength(0);
});
it('standalone personal namespace remains compatible and combined capability aliases do not grant shared browser controls', async () => {
  const f = await createPersonalRuntime('source.browser'); closes.push(f.close);
  const client = new OkoClient(f.fetcher);
  await client.session(); await client.command('source.browser.workflow.open', { title: 'Прежний запуск' });
  expect(f.requests.find(request => request.body?.name === 'source.browser.workflow.open')).toBeTruthy();
  expect((await client.workspace()).workflows).toHaveLength(1);
});
