import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkbenchRuntime } from './bootstrap';
import { createWorkbenchApp } from './app';
import type { CommandContext } from './command-registry';
import { snapshotWorkspace } from '../../features/workspace-maintenance/workbench/workspace-archive';
import { createOkoWorkflowStore } from '../../features/connectors/workbench-workflow-store';
import { createWorkspaceOwnership } from '../storage/workbench-ownership';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse())
    await close(); });
async function root() { const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 'uor-t39-')); cleanups.push(() => rm(root, { recursive: true, force: true })); await mkdir(path.join(root, 'config')); await writeFile(path.join(root, 'config/site.local.json'), JSON.stringify({ port: 53961, clientPort: 53962, allowedWorkspaceRoots: [root], roleMode: 'local-preview' })); return root; }
it('healthcheck rejects a durable active pointer that disagrees with the live facade', async () => {
    const projectRoot = await root(), runtime = await createWorkbenchRuntime({ projectRoot });
    cleanups.push(runtime.close);
    const pointer = path.join(projectRoot, '.runtime/workbench/active.json'), original = await readFile(pointer);
    await writeFile(pointer, JSON.stringify({ version: 1, active: 'restore-' + randomUUID() }));
    try { await expect(runtime.services.archive.workspace!.healthcheck()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' }); }
    finally { await writeFile(pointer, original); }
});
it('boots actual empty subject composition without a fake organizational context or verified grant', async () => {
    const runtime = await createWorkbenchRuntime({ projectRoot: await root(), codeRoot: process.cwd() });
    cleanups.push(runtime.close);
    const app = await createWorkbenchApp(runtime.deps);
    cleanups.push(() => app.close());
    const session = await app.inject('/api/v1/session');
    expect(session.statusCode).toBe(200);
    expect(session.json().data.defaultContext).toBeNull();
    expect(session.json().data.policyState).toBe('local_preview');
    expect(runtime.deps.repository.exportWorkspaceCore()).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/identity/login', payload: { password: 'legacy' } })).statusCode).toBe(404);
    expect((await app.inject('/api/state')).statusCode).toBe(404);
    expect(runtime.deps.commands.listNames()).toEqual(expect.arrayContaining(['backup.create', 'source.capture', 'package.preview', 'oko.workflow.record.start', 'source.browser.record.start']));
});
it('restores the complete subject through a new root while current command receipts remain local', async () => {
    const projectRoot = await root(), runtime = await createWorkbenchRuntime({ projectRoot, codeRoot: process.cwd() });
    cleanups.push(runtime.close);
    const app = await createWorkbenchApp(runtime.deps, { configure: runtime.configure, deferActivation: true });
    cleanups.push(() => app.close());
    await runtime.activate();
    const ctx = async (): Promise<CommandContext> => { const ownAccess = await runtime.deps.accessPolicy.resolveOwnAccess(); return { repository: runtime.deps.repository, clock: runtime.deps.clock, installationId: runtime.deps.installationId, actor: { hostname: 'synthetic', installationId: runtime.deps.installationId, profilePersonId: ownAccess.personId }, commandId: randomUUID(), requestId: randomUUID(), sessionId: 'synthetic-current-session', ownAccess }; };
    const execute = async (name: string, payload: Record<string, unknown>, baseRevision: string | null = null) => { const context = await ctx(); const accepted = await runtime.deps.commands.execute({ commandId: context.commandId, name, payload, baseRevision }, context); await runtime.deps.commands.idle(); if ('jobId' in accepted) {
        const job = runtime.deps.jobs.get(accepted.jobId, context.installationId)!;
        expect(job.status, JSON.stringify(job)).toBe('succeeded');
        return { result: job.result!, commandId: context.commandId };
    } return accepted; };
    const opened = await execute('draft.open', { entityType: 'core_goal_definition', ref: null, packageId: null });
    const saved = await execute('goal.draft.save', { draftId: opened.result.draftId, definition: { title: 'Preserved private draft' } }, 'editToken' in opened ? opened.editToken : null);
    const before = await snapshotWorkspace(runtime.services.archive);
    const backup = await execute('backup.create', { label: 'Synthetic complete', includeOriginals: true });
    const pointerBefore = await readFile(path.join(projectRoot, '.runtime/workbench/active.json'), 'utf8');
    const file = await runtime.services.maintenance.getBackupFile(await ctx(), String(backup.result.backupId));
    const chunks: Uint8Array[] = [];
    for await (const chunk of file.stream)
        chunks.push(chunk);
    const context = await ctx(), upload = await runtime.services.files.stage({ installationId: context.installationId, profilePersonId: context.ownAccess.personId, purpose: 'workspace-restore', name: 'synthetic.zip', mediaType: 'application/zip', stream: (async function* () { yield Buffer.concat(chunks); })() });
    const preview = await execute('backup.restore.preview', { fileHandle: upload.fileHandle });
    const restored = await execute('backup.restore.apply', { restoreToken: preview.result.restoreToken, confirmReplacement: true });
    expect(restored.result.stateRevision).toBe(before.revision);
    expect((await snapshotWorkspace(runtime.services.archive)).records).toEqual(before.records);
    expect(await readFile(path.join(projectRoot, '.runtime/workbench/active.json'), 'utf8')).not.toBe(pointerBefore);
    expect(runtime.deps.commands.reconcileCommand?.(saved.commandId, await ctx()).status).toBe('completed');
    expect((await app.inject('/api/v1/session')).statusCode).toBe(200);
});
it('candidate composition cannot admit requests or recover jobs until explicit activation', async () => {
    const runtime = await createWorkbenchRuntime({ projectRoot: await root(), codeRoot: process.cwd(), candidate: true });
    cleanups.push(runtime.close);
    const app = await createWorkbenchApp(runtime.deps, { deferActivation: true, configure: runtime.configure });
    cleanups.push(() => app.close());
    expect((await app.inject('/api/v1/session')).statusCode).toBe(503);
    await runtime.activate(app);
    expect((await app.inject('/api/v1/session')).statusCode).toBe(200);
});
it('composed result routing uses bounded exact owner metadata and refuses a family collision', async () => {
    const runtime = await createWorkbenchRuntime({ projectRoot: await root() });
    cleanups.push(runtime.close);
    const { repository, installationId, clock } = runtime.deps, ownAccess = await runtime.deps.accessPolicy.resolveOwnAccess(), context = { repository, installationId, clock, ownAccess, requestId: randomUUID() }, id = randomUUID(), owner = installationId + '/' + ownAccess.personId, store = createOkoWorkflowStore(repository), bytes = Buffer.from('Product,Leader\r\nSynthetic product,Synthetic leader\r\n');
    const artifact = { name: 'synthetic.csv', mimeType: 'text/csv', base64: bytes.toString('base64'), hash: createHash('sha256').update(bytes).digest('hex') };
    store.putResult(owner, id, { original: artifact, enriched: artifact });
    repository.sqlForModule('oko_workflow').run('INSERT INTO wb_oko_workflow_results VALUES(?,?,?)', [owner, randomUUID(), 'broken unrelated JSON']);
    const list = vi.spyOn(runtime.services.sources, 'listOwnCaptures');
    expect((await runtime.deps.browserResults!.read(context, id, 'enriched')).bytes).toEqual(bytes);
    expect(list).not.toHaveBeenCalled();
    repository.sqlForModule('sources').run('INSERT INTO wb_sources_captures VALUES(?,?,?,?)', [installationId, randomUUID(), id, 'damaged selected capture']);
    createWorkspaceOwnership(repository).bind({ moduleId: 'sources', key: 'capture:' + id, installationId, personId: ownAccess.personId, provenance: 'created' });
    await expect(runtime.deps.browserResults!.read(context, id, 'enriched')).rejects.toMatchObject({ code: 'ARTIFACT_ID_COLLISION' });
    expect(list).not.toHaveBeenCalled();
});
