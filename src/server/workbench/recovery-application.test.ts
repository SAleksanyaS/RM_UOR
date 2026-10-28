import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';
import type { AccessPolicyService, OwnAccessProfile } from '../../features/identity/workbench-access-policy';
import { createWorkbenchRepository } from '../storage/workbench-repository';
import { createWorkbenchApp } from './app';
import { createCommandRegistry, type CommandContext } from './command-registry';
import { commitCommandEffect, createCommandStore } from './command-store';
import { createJobStore } from './jobs';
import type { PlatformModule } from './modules';
import { QueryRegistry } from './query-registry';
import { createLocalSessionStore } from './session';

it('startup recovers an eligible local job with server identity and exposes its original job over HTTP', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-recovery-app-'));
  const options = { filename: path.join(root, 'state.sqlite'), artifactRoot: path.join(root, 'artifacts') };
  const installationId = fixtureId(1), commandId = fixtureId(2), foreignInstallationId = fixtureId(3);
  const clock = { now: () => '2026-10-28T12:00:00Z' };
  const request = { commandId, name: 'notes.local.save', baseRevision: null, payload: { value: 'restored' } };
  let repository = createWorkbenchRepository(options);
  const seededJobs = createJobStore({ repository, clock });
  const seededCommands = createCommandStore(repository);
  seededCommands.begin(request, installationId);
  const accepted = seededJobs.create(commandId, installationId, request.name);
  seededJobs.setResourceKey(accepted.jobId, 'notes:own');
  seededCommands.accept(installationId, commandId, accepted, { effect: 'local', queuedRecovery: 'restart-safe-local' });
  seededCommands.begin(request, foreignInstallationId);
  const foreign = seededJobs.create(commandId, foreignInstallationId, request.name);
  seededJobs.setResourceKey(foreign.jobId, 'notes:foreign');
  seededCommands.accept(foreignInstallationId, commandId, foreign, { effect: 'local', queuedRecovery: 'restart-safe-local' });
  const foreignBeforeRestart = seededJobs.get(foreign.jobId, foreignInstallationId);
  repository.close();
  repository = createWorkbenchRepository(options);

  const own: OwnAccessProfile = { role: 'curator', personId: fixtureId(9), displayName: 'Current profile', policyState: 'verified', checkedAt: clock.now() };
  const accessPolicy: AccessPolicyService = { resolveOwnAccess: async () => own, assertCommandAllowed: async () => own, assertFreshPublishAllowed: async () => { throw Error('Unexpected external write'); } };
  const jobs = createJobStore({ repository, clock });
  const commands = createCommandRegistry({ repository, jobs, accessPolicy });
  const sql = repository.sqlForModule('notes');
  sql.execMigration('v1', 'CREATE TABLE wb_notes_values(installation_id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const actors: CommandContext['actor'][] = [];
  const module: PlatformModule = {
    id: 'notes', version: '1.0.0', platformContractVersion: 1, dependsOn: [],
    owns: { namespaces: ['notes.personal'], entityTypes: [] }, schemas: [], queries: [], hooks: {},
    commands: [{ name: request.name, inputSchema: z.strictObject({ value: z.string() }), outputSchema: z.strictObject({ value: z.string() }), capability: 'personal.write', effect: 'local', execution: 'async', queuedRecovery: 'restart-safe-local', resourceKey: () => 'notes:own', handler: async (context, payload) => {
      actors.push(context.actor);
      return commitCommandEffect(context, () => {
        sql.run('INSERT INTO wb_notes_values(installation_id,value) VALUES(?,?)', [context.installationId, payload.value]);
        return { result: payload, changedRefs: [], editToken: null };
      });
    } }],
  };
  let app: Awaited<ReturnType<typeof createWorkbenchApp>> | undefined;
  try {
    app = await createWorkbenchApp({ hostname: () => 'SERVER-RESTART', repository, clock, accessPolicy, commands, queries: new QueryRegistry(), jobs, modules: [module], sessions: createLocalSessionStore({ clock }), allowedOrigins: ['http://127.0.0.1:5173'], installationId });
    await commands.idle();
    expect(jobs.get(accepted.jobId, installationId)).toMatchObject({ commandId, status: 'succeeded', result: { value: 'restored' }, error: null });
    expect(actors).toEqual([{ hostname: 'SERVER-RESTART', installationId, profilePersonId: fixtureId(9) }]);
    expect(sql.all('SELECT installation_id,value FROM wb_notes_values')).toEqual([{ installation_id: installationId, value: 'restored' }]);
    const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { host: 'localhost' } });
    const headers = { host: 'localhost', cookie: String(session.headers['set-cookie']).split(';')[0], origin: 'http://127.0.0.1:5173', 'x-csrf-token': session.json().data.csrfToken };
    const status = await app.inject({ method: 'GET', url: '/api/v1/jobs/' + accepted.jobId, headers });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toMatchObject({ jobId: accepted.jobId, commandId, status: 'succeeded' });
    const inaccessible = await app.inject({ method: 'GET', url: '/api/v1/jobs/' + foreign.jobId, headers });
    expect(inaccessible.statusCode).toBe(404);
    expect(jobs.get(foreign.jobId, foreignInstallationId)).toEqual(foreignBeforeRestart);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/commands', headers, payload: request });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().data.jobId).toBe(accepted.jobId);
    await commands.idle();
    expect(actors).toHaveLength(1);
  } finally {
    await commands.idle();
    if (app) await app.close();
    repository.close();
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('uor-recovery-app-')) throw Error('Invalid test cleanup root');
    rmSync(resolved, { recursive: true, force: true });
  }
});
