import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer, type ViteDevServer } from 'vite';
import { createLocalRuntime } from '../../tests/workbench/helpers/runtime';
import { seedGoalReference } from './goal-fixture';
import { createPersonalReferenceEnvironment } from './personal-fixture';
import { createCompletionGitFixture } from './completion-git-fixture';
import type { CompletionOkoFlowResult } from './completion-oko-flow';

/** Creates a new synthetic runtime; never accepts an existing subject database. */
const codeRoot = fileURLToPath(new URL('../../', import.meta.url));
const executablePath = process.env.UOR_TEST_BROWSER_EXECUTABLE;
assert.ok(executablePath && path.isAbsolute(executablePath), 'An installed absolute Chrome path is required');
const output = path.resolve(process.env.UOR_COMPLETION_OUTPUT ?? path.join(codeRoot, 'completion/evidence'));
await mkdir(output, { recursive: true });
const clock = { now: () => '2026-11-01T09:00:00Z' };
const external = await createPersonalReferenceEnvironment(executablePath);
const git = await createCompletionGitFixture({ directory: path.join(path.dirname(output), 'git-fixture') });
let local: Awaited<ReturnType<typeof createLocalRuntime>> | undefined, host: ViteDevServer | undefined;
let closed = false;
async function close() {
  if (closed) return; closed = true;
  await host?.close(); await local?.close(); await external.close(); await git.close();
}
process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });

try {
  local = await createLocalRuntime({ ...external.providers, git: git.git, classification: git.classification, clock });
  const seeded = seedGoalReference(local.runtime.deps.repository, { includeNumericEdgeCases: true });
  const gitState = await git.seed(local.runtime.deps.repository, clock);
  const records = local.runtime.deps.repository.exportWorkspaceCore();
  const fixture = { ...seeded, workIds: records.filter(record => record.entityType === 'work').map(record => record.value.id), decisionIds: records.filter(record => record.entityType === 'decision').map(record => record.value.id), packageIds: gitState.packageIds };
  const globalContext = { scopePath: { ditId: seeded.ditId, clusterId: null, productId: null, teamId: null }, time: { kind: 'as_of', date: '2026-11-01' }, goalId: null, resultMode: 'current', snapshotId: null };
  const goals = await local.request.query<{ items: Array<{ ref: unknown }> }>('goals.list', {}, globalContext);
  for (const row of goals.items) await local.request.settle(await local.request.command('calculation.prepare', { assignmentRef: row.ref, businessTime: globalContext.time }));
  const origin = 'http://127.0.0.1:' + local.ui;
  host = await createServer({ root: codeRoot, clearScreen: false, configFile: path.join(codeRoot, 'vite.config.ts'), cacheDir: path.join(local.root, '.runtime/completion-vite'), server: { host: '127.0.0.1', port: local.ui, strictPort: true, proxy: { '/api': local.origin } } });
  await host.listen();
  const query = '?dit=' + fixture.ditId + '&at=2026-11-01&mode=current';
  const metadata = { synthetic: true, origin, apiOrigin: local.origin, query, fixture, personalWorkflowId: null as string | null, personId: (await local.request.session()).personId, codeRoot, sourceWorktree: process.env.UOR_SOURCE_WORKTREE ?? codeRoot, sourceRevision: process.env.UOR_SOURCE_REVISION ?? null, executablePath, output, subjectRoot: local.root, reportOrigin: external.hooks.reportOrigin, reportUrl: external.hooks.reportUrl, git: gitState, node: process.version, syncedAt: new Date().toISOString(), okoStatus: 'not_run' as 'not_run' | 'passed' | 'failed', okoFailure: null as string | null };
  const saveMetadata = () => writeFile(path.join(output, 'runtime.json'), JSON.stringify(metadata, null, 2));
  await saveMetadata();
  async function oko() {
    try {
      const module = await import(new URL('./completion-oko-flow.ts?run=' + Date.now(), import.meta.url).href) as typeof import('./completion-oko-flow');
      const result: CompletionOkoFlowResult = await module.runCompletionOkoFlow({ origin, query, output, executablePath: executablePath!, request: local!.request, environment: external });
      metadata.personalWorkflowId = result.workflowId; metadata.okoStatus = 'passed'; metadata.okoFailure = null;
    } catch (error) { metadata.okoStatus = 'failed'; metadata.okoFailure = String(error); console.error('COMPLETION_OKO_FAILED', String(error)); }
    await saveMetadata();
  }
  await oko();
  console.log('COMPLETION_READY ' + JSON.stringify(metadata));
  console.log('Owned runtime waits for stdin: oko (repeat actual flow), checkpoint <sha> (record copied source), status, quit.');
  const input = createInterface({ input: process.stdin });
  for await (const raw of input) {
    const command = raw.trim();
    if (command === 'quit') break;
    if (command === 'oko') { await oko(); console.log('COMPLETION_READY ' + JSON.stringify(metadata)); }
    if (command === 'status') console.log('COMPLETION_STATUS ' + JSON.stringify(metadata));
    if (/^checkpoint [a-f0-9]{40}$/.test(command)) { metadata.sourceRevision = command.slice(11); metadata.syncedAt = new Date().toISOString(); await saveMetadata(); }
  }
} finally { await close(); process.stdin.pause(); }
