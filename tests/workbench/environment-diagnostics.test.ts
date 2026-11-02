import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createCommandStore } from '../../src/server/workbench/command-store';
import { createLocalRuntime } from './helpers/runtime';

it('downloads an allowlisted diagnostic projection of an owned operation without its data, results, paths or another owner', async () => {
  const fixture = await createLocalRuntime();
  try {
    await fixture.request.session();
    const commandId = randomUUID();
    await fixture.request.command('raw.capture.manual', {
      title: 'PRIVATE_TITLE', columns: ['password'], rows: [['PRIVATE_SECRET_VALUE']],
    }, null, commandId);
    const report = await fixture.request.query('environment.diagnostics', { commandId });
    expect(report).toMatchObject({ schemaVersion: 1, environment: { nodeVersion: '22.16.0', rawFiles: 1 }, operation: { commandId, status: 'completed', job: null } });
    expect(Object.keys(report.operation).sort()).toEqual(['commandId', 'job', 'name', 'status']);
    const encoded = JSON.stringify(report);
    for (const secret of ['PRIVATE_TITLE', 'PRIVATE_SECRET_VALUE', 'password', fixture.root, 'csrfToken', 'sourceUrl']) expect(encoded).not.toContain(secret);
    expect(encoded.length).toBeLessThan(32000);
    const missing = await fixture.request.query('environment.diagnostics', { commandId: randomUUID() });
    expect(missing.operation.status).toBe('not_found');

    const foreignId = randomUUID();
    createCommandStore(fixture.runtime.deps.repository).begin({ commandId: foreignId, name: 'raw.capture.manual', baseRevision: null, payload: {} }, fixture.runtime.deps.installationId, { scope: 'person', personId: randomUUID() });
    await expect(fixture.request.query('environment.diagnostics', { commandId: foreignId })).rejects.toThrow('404');
    await expect(fixture.request.query('environment.diagnostics', { commandId: 'a private path' })).rejects.toThrow('422');
  } finally { await fixture.close(); }
}, 30000);
