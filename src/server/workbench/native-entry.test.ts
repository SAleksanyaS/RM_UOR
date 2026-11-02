import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeCodeUpdate, runCommand, type WorkspaceReturn } from '../../../scripts/code-update-runtime.mjs';
import { createWorkbenchRuntime } from './bootstrap';
import { createCommandStore } from './command-store';
import { startProductionEntry } from './testing/production-entry';
const codeRoot = realpathSync.native(fileURLToPath(new URL('../../..', import.meta.url)));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanups.splice(0).reverse())
    await action(); });
async function port() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const value = (server.address() as {
    port: number;
}).port; await new Promise<void>(resolve => server.close(() => resolve())); return value; }
async function fixture() { const root = await mkdtemp(path.join(realpathSync.native(tmpdir()), 't39-entry-')), api = await port(), client = await port(); cleanups.push(() => rm(root, { recursive: true, force: true })); await mkdir(path.join(root, 'config')); await writeFile(path.join(root, 'config/site.local.json'), JSON.stringify({ port: api, clientPort: client, autoOpen: false, allowedWorkspaceRoots: [root], roleMode: 'local-preview' })); return { root, api, client }; }
function launch(root: string, args: string[], env: NodeJS.ProcessEnv = {}) { let output = ''; const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, UOR_NO_OPEN: '1', ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); child.stdout!.on('data', value => output += value); child.stderr!.on('data', value => output += value); cleanups.push(async () => { if (child.exitCode !== null || child.signalCode !== null)
    return; const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); if (child.connected)
    child.send({ type: 'uor.shutdown' });
else
    child.kill('SIGTERM'); await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 15000))]); if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    throw Error('Native child did not close: ' + output);
} }); return { child, output: () => output }; }
async function waitReady(child: ChildProcess, output: () => string) { await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(Error(output())), 25000); child.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'uor.child-ready') {
    clearTimeout(timer);
    resolve();
} }); child.once('exit', () => { clearTimeout(timer); reject(Error(output())); }); }); }
async function request(child: ChildProcess, message: Record<string, unknown>) { const id = randomUUID(); return new Promise<{
    ok: boolean;
    message?: string;
}>((resolve, reject) => { const timer = setTimeout(() => reject(Error('IPC timeout')), 10000); const listener = (value: any) => { if (value?.id === id && value.type === 'uor.update-prepared') {
    clearTimeout(timer);
    child.off('message', listener);
    resolve(value);
} }; child.on('message', listener); child.send({ id, ...message }); }); }
const mainArgs = ['--import', pathToFileURL(path.join(codeRoot, 'node_modules/tsx/dist/loader.mjs')).href, path.join(codeRoot, 'src/server/main.ts')];
const legacyWrites = ['/api/auth/curator', '/api/auth/reader', '/api/identity/login', '/api/goals', '/api/goals/example', '/api/entities', '/api/drafts/example', '/api/import/tabular/commit', '/api/import/maturity/commit', '/api/goal-setup/commit', '/api/releases/current', '/api/release/preview', '/api/release/resolve', '/api/publish', '/api/sync', '/api/connectors/recording/finish', '/api/connectors/login/finish', '/api/system/backups', '/api/system/backups/restore', '/api/system/preferences', '/api/system/code-update', '/api/workspace/export', '/api/workspace/restore', '/api/reports/profiles', '/api/weekly-reports', '/api/evidence'];
it('actual main runs only v1 routes, keeps legacy bytes, and changes the authorized local role', async () => {
    const f = await fixture();
    await mkdir(path.join(f.root, '.runtime'));
    const old = Buffer.from('synthetic legacy bytes must remain untouched');
    await writeFile(path.join(f.root, '.runtime/app.db'), old);
    const process = await startProductionEntry({ root: f.root, codeRoot });
    cleanups.push(process.stop);
    const base = `http://127.0.0.1:${f.api}`;
    expect(await (await fetch(base + '/api/health')).json()).toMatchObject({ version: '0.6.0' });
    const session = await fetch(base + '/api/v1/session');
    const value = await session.json();
    expect(value.data.defaultContext).toBeNull();
    expect(value.data.policyState).toBe('local_preview');
    for (const url of legacyWrites)
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
            expect((await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: '{}' })).status, url).toBe(404);
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    const role = await fetch(base + '/api/v1/commands', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': value.data.csrfToken }, body: JSON.stringify({ commandId: randomUUID(), name: 'workbench.role.set', baseRevision: null, payload: { role: 'viewer' } }) });
    expect(role.status, await role.text()).toBe(200);
    expect((await (await fetch(base + '/api/v1/session', { headers: { cookie } })).json()).data.role).toBe('viewer');
    expect(await readFile(path.join(f.root, '.runtime/app.db'))).toEqual(old);
}, 45000);
it('actual candidate admits no HTTP work until authenticated IPC matches the durable commitpoint', async () => {
    const f = await fixture(), token = randomUUID(), requestId = randomUUID(), directory = path.join(f.root, '.runtime/code-update');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'launcher.json'), JSON.stringify({ root: f.root, pid: process.pid, token, heartbeat: Date.now() }));
    const launched = launch(f.root, mainArgs, { UOR_UPDATE_BOOTSTRAP: '1', UOR_UPDATE_START_MODE: 'candidate', UOR_UPDATE_LAUNCHER_TOKEN: token });
    await waitReady(launched.child, launched.output);
    const base = `http://127.0.0.1:${f.api}`;
    expect((await fetch(base + '/api/v1/session')).status).toBe(503);
    expect(await request(launched.child, { type: 'uor.activate-code-update', requestId, token })).toMatchObject({ ok: false });
    await writeFile(path.join(directory, 'active.json'), JSON.stringify({ phase: 'committed', requestId }));
    expect(await request(launched.child, { type: 'uor.activate-code-update', requestId, token })).toMatchObject({ ok: true });
    expect((await fetch(base + '/api/v1/session')).status).toBe(200);
}, 45000);
it('standard dev launcher starts the actual new main and current UI', async () => {
    const f = await fixture();
    for (const directory of ['src', 'scripts', 'data', 'materials'])
        await cp(path.join(codeRoot, directory), path.join(f.root, directory), { recursive: true });
    for (const file of ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'oko.html'])
        await cp(path.join(codeRoot, file), path.join(f.root, file));
    await symlink(path.join(codeRoot, 'node_modules'), path.join(f.root, 'node_modules'), 'junction');
    const launched = launch(f.root, ['scripts/dev.mjs']);
    const url = `http://127.0.0.1:${f.client}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (launched.child.exitCode !== null)
            throw Error(launched.output());
        try {
            const response = await fetch(url + '/api/v1/session');
            if (response.ok) {
                ready = true;
                break;
            }
        }
        catch { }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    expect(ready, launched.output()).toBe(true);
    expect((await (await fetch(url)).text())).toContain('/src/app/main.tsx');
    expect((await fetch(url + '/api/state')).status).toBe(404);
    expect(await (await fetch(url + '/api/health')).json()).toMatchObject({ version: '0.6.0' });
}, 60000);
it.each(['candidate-failure', 'activation-ack-lost'] as const)('native updater transfers the exclusive lease and preserves the correct workspace after %s', async (fault) => {
    const f = await fixture(), remote = path.join(f.root, 'remote.git'), author = path.join(f.root, 'author'), clone = path.join(f.root, 'clone');
    const git = (cwd: string, args: string[]) => runCommand('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], cwd);
    await git(f.root, ['init', '--bare', remote]);
    await git(f.root, ['clone', remote, author]);
    await git(author, ['checkout', '-b', 'main']);
    await mkdir(path.join(author, 'config'));
    await writeFile(path.join(author, 'config/update-protocol.json'), '{"schemaVersion":1,"bootstrap":1}');
    await writeFile(path.join(author, 'package.json'), '{"name":"synthetic","private":true}');
    await writeFile(path.join(author, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    await writeFile(path.join(author, '.gitignore'), '.runtime/\nnode_modules/\nconfig/site.local.json\n');
    await writeFile(path.join(author, 'file.txt'), 'before');
    await git(author, ['add', '.']);
    await git(author, ['commit', '-m', 'Synthetic before']);
    await git(author, ['push', 'origin', 'main']);
    await git(f.root, ['clone', '--branch', 'main', remote, clone]);
    const expectedCommit = (await git(clone, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(path.join(author, 'file.txt'), 'candidate');
    await git(author, ['commit', '-am', 'Synthetic candidate']);
    await git(author, ['push', 'origin', 'main']);
    const targetCommit = (await git(author, ['rev-parse', 'HEAD'])).stdout.trim();
    const config = { repositoryUrl: remote, publishedBranch: 'main' };
    await writeFile(path.join(clone, 'config/site.local.json'), JSON.stringify({ ...config, port: f.api, clientPort: f.client, allowedWorkspaceRoots: [clone], roleMode: 'local-preview' }));
    const seed = await createWorkbenchRuntime({ projectRoot: clone }), own = await seed.deps.accessPolicy.resolveOwnAccess(), commandId = randomUUID(), store = createCommandStore(seed.deps.repository), update = { commandId, name: 'code.update.apply', baseRevision: null, payload: { expectedCommit, targetCommit } };
    store.begin(update, seed.deps.installationId, { scope: 'person', personId: own.personId });
    const job = seed.deps.jobs.create(commandId, seed.deps.installationId, update.name);
    store.accept(seed.deps.installationId, commandId, job, { effect: 'local', queuedRecovery: null });
    seed.deps.jobs.update(job.jobId, { status: 'running' });
    await seed.close();
    const token = randomUUID(), directory = path.join(clone, '.runtime/code-update');
    await writeFile(path.join(directory, 'launcher.json'), JSON.stringify({ root: clone, pid: process.pid, token, heartbeat: Date.now() }));
    let current: ReturnType<typeof launch> | null = null, mode = 'ordinary', workspaceBackup: WorkspaceReturn | undefined, restores = 0, candidates = 0;
    const start = async (nextMode = 'ordinary') => { mode = nextMode; current = launch(clone, mainArgs, { UOR_UPDATE_BOOTSTRAP: mode === 'candidate' ? '1' : '0', UOR_UPDATE_START_MODE: mode, UOR_UPDATE_LAUNCHER_TOKEN: token }); await waitReady(current.child, current.output); };
    const stop = async () => { if (!current)
        return; const process = current.child; if (process.exitCode === null && process.signalCode === null) {
        const exited = new Promise<void>(resolve => process.once('exit', () => resolve()));
        process.send({ type: 'uor.shutdown' });
        await exited;
    } current = null; };
    await start();
    const result = await executeCodeUpdate(clone, config, { id: job.jobId, expectedCommit, targetCommit }, { install: async (stage) => { await mkdir(path.join(stage, 'node_modules')); }, quiesce: async () => { const reply = await request(current!.child, { type: 'uor.prepare-code-update', requestId: job.jobId, token }) as {
            ok: boolean;
            workspaceBackup?: WorkspaceReturn;
        }; expect(reply.ok, JSON.stringify(reply)).toBe(true); workspaceBackup = reply.workspaceBackup; expect((await fetch(`http://127.0.0.1:${f.api}/api/v1/session`)).status).toBe(503); }, backupWorkspace: async () => workspaceBackup!, stop, start, ready: async () => { if (mode === 'candidate') {
            candidates++;
            expect((await fetch(`http://127.0.0.1:${f.api}/api/v1/session`)).status).toBe(503);
            return fault !== 'candidate-failure';
        } return (await fetch(`http://127.0.0.1:${f.api}/api/v1/session`)).ok; }, activate: async () => { const reply = await request(current!.child, { type: 'uor.activate-code-update', requestId: job.jobId, token }); expect(reply.ok).toBe(true); const base = `http://127.0.0.1:${f.api}`, session = await fetch(base + '/api/v1/session'), sessionData = await session.json(), cookie = session.headers.get('set-cookie')!.split(';')[0]; const written = await fetch(base + '/api/v1/commands', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': sessionData.data.csrfToken }, body: JSON.stringify({ commandId: randomUUID(), name: 'oko.workflow.open', baseRevision: null, payload: { title: 'Accepted after durable commitpoint' } }) }); expect(written.status, await written.text()).toBe(200); throw Error('Synthetic activation acknowledgement lost'); }, restoreWorkspace: async (backupId) => { restores++; await runCommand(process.execPath, ['--import', pathToFileURL(path.join(codeRoot, 'node_modules/tsx/dist/loader.mjs')).href, path.join(codeRoot, 'scripts/restore-workbench.ts'), backupId], clone, { timeout: 45000 }); } });
    expect(result.rolledBack).toBe(fault === 'candidate-failure');
    expect(restores).toBe(fault === 'candidate-failure' ? 1 : 0);
    expect(candidates).toBe(1);
    expect(await readFile(path.join(clone, 'file.txt'), 'utf8')).toBe(fault === 'candidate-failure' ? 'before' : 'candidate');
    const session = await fetch(`http://127.0.0.1:${f.api}/api/v1/session`);
    expect(session.status).toBe(200);
    if (fault === 'activation-ack-lost') {
        const sessionValue = await session.json();
        const cookie = session.headers.get('set-cookie')!.split(';')[0], data = await (await fetch(`http://127.0.0.1:${f.api}/api/v1/queries/oko.workflow.workspace`, { method: 'POST', headers: { cookie, origin: 'http://127.0.0.1:' + f.api, 'content-type': 'application/json', 'x-csrf-token': sessionValue.data.csrfToken }, body: JSON.stringify({ context: null, filter: {}, sort: [], page: { limit: 50, cursor: null } }) })).json();
        expect(data.data, JSON.stringify(data)).toBeDefined();
        expect(data.data.workflows).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Accepted after durable commitpoint' })]));
    }
    await stop();
}, 90000);
