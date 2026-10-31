import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createJobStore } from '../../../server/workbench/jobs';
import { createCommandRegistry } from '../../../server/workbench/command-registry';
import { MaintenanceService } from './maintenance-service';
import { registerMaintenanceCommands } from './register-commands';
import { fixture } from './test-fixture';
it('registers precisely the three async own workspace commands for a viewer', async () => {
  const f = await fixture('viewer data'); try {
    const jobs = createJobStore({ repository: f.deps.repository, clock: f.deps.clock });
    const accessPolicy = { async resolveOwnAccess() { return f.context.ownAccess; }, async assertCommandAllowed() { return f.context.ownAccess; }, async assertFreshPublishAllowed() { throw Error('No external publish expected'); } };
    const registry = createCommandRegistry({ repository: f.deps.repository, jobs, accessPolicy });
    const service = new MaintenanceService({ archive: f.deps, jobs, jobSink: jobs }); registerMaintenanceCommands(registry, service);
    expect(registry.listNames()).toEqual(['backup.create', 'backup.restore.apply', 'backup.restore.preview', 'job.cancel', 'job.openAuth', 'job.retry']);
    const accepted = await registry.execute({ commandId: f.context.commandId, name: 'backup.create', baseRevision: null, payload: { label: 'own', includeOriginals: false } }, f.context);
    expect(accepted).toHaveProperty('jobId'); await registry.idle();
    const job = jobs.get((accepted as { jobId: string }).jobId, f.context.installationId); expect(job?.status).toBe('succeeded'); expect(job?.result).toMatchObject({ empty: false });
    const badId = randomUUID(); await expect(registry.execute({ commandId: badId, name: 'backup.restore.apply', baseRevision: null, payload: { restoreToken: 'token', confirmReplacement: false } }, { ...f.context, commandId: badId })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  } finally { await f.dispose(); }
});
