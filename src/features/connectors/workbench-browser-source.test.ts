import { browserPolicyCdpFixture, browserPolicyPageFixture } from '../../../tests/fixtures/workbench/browser-policy-cdp';
import { testBrowserSelection } from '../../../tests/fixtures/workbench/test-browser-selection';
import { afterEach, expect, it, vi } from 'vitest';
import { draftCleanups, draftFixture } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeHeader, makeNumericFixture } from '../../../tests/fixtures/workbench/factories';
import type { SourceDefinition, SourceFieldMapping, DirectoryEntity, Capture } from '../../domain/workbench/entities';
import { browserScenarioDefinitionSchema } from '../../domain/workbench/browser-scenario';
import { createBrowserScenarioService } from './workbench-browser-scenarios';
import { createBrowserProfileService } from './workbench-browser-profile';
import { createBrowserSourceAdapter, createBrowserLoginService } from './workbench-browser-source';
import { createSourceService, registerSourceCommands } from './workbench-source-service';
import { createSourceStore } from './workbench-source-store';
import { parseWorkbenchTable } from '../tabular-import/workbench-parser';
import { enrichSourceRows } from '../catalog/workbench-directory';
import { ConnectorError, privateProfileSchema } from './contracts';
import type { BrowserScenarioRuntimePort } from './workbench-source-contracts';
import { registerBrowserCommands } from './workbench-browser-commands';
import { createBrowserRecorderService } from './workbench-browser-recorder';
import { createBrowserRuntime } from './workbench-browser-runtime';
import { EventEmitter } from 'node:events';
import type { BrowserContext } from 'playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { createJobStore } from '../../server/workbench/jobs';
import { createCommandRegistry } from '../../server/workbench/command-registry';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

afterEach(async () => { while (draftCleanups.length) await draftCleanups.pop()!(); });
const ref = (entityType: string, value: { id: string; revision: number }) => ({ entityType, id: value.id, revision: value.revision });
async function fixture() {
  const f = draftFixture({ input: makeNumericFixture({ scope: { kind: 'dit', id: fixtureId(101) } }) });
  const source = f.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: f.input.goal.sourceId })!;
  const old = f.repository.readVersion<SourceFieldMapping>(source.mappingRef!)!;
  const mapping = { ...old, revision: 2, fixedScope: f.input.assignment.scope, productKeyField: null };
  const scenario = browserScenarioDefinitionSchema.parse({ ...makeHeader(880001, { publicationAnchorId: source.publicationAnchorId }), sourceId: source.id, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#report', steps: [{ action: 'download', locator: { kind: 'css', selector: '#export' } }], parameters: {}, expectedExport: { format: 'csv', requiredColumns: ['demo_value'] } });
  f.repository.transaction(() => { f.repository.append('source_field_mapping', mapping, 1); f.repository.append('browser_scenario', scenario, null); f.repository.append('source_definition', { ...source, revision: 2, mappingRef: ref('source_field_mapping', mapping), browserScenarioRef: ref('browser_scenario', scenario) }, 1); });
  let authenticated = true, visible = false, proof = true, active = 0, hook: (() => Promise<void>) | undefined;
  let bytes = Buffer.from('demo_row_key,demo_scope_id,demo_metric_id,demo_value,demo_date\nr1,dit,m1,92.00,2026-10-23\n');
  const unavailable = async (): Promise<never> => { throw Error('Unused runtime operation'); };
  const runtime: BrowserScenarioRuntimePort = {
    openLogin: async () => ({ handleId: fixtureId(880002), mode: 'login', state: 'open' }),
    observeLogin: async () => visible,
    prepareLogin: vi.fn(async () => { authenticated = visible; return { state: 'ready' as const, expiresAt: new Date(Date.parse(f.clock.now()) + 900000).toISOString() }; }),
    finish: async () => { return { recordingId: fixtureId(880002), startUrl: scenario.startUrl, authenticatedSelector: scenario.authenticatedSelector, steps: [], parameterNames: [], screenshotHandles: [], hasDownload: false }; },
    startRecording: unavailable, screenshot: unavailable, waitForCompletion: unavailable, closeOwned: async () => {},
    replay: vi.fn(async (_input, signal) => { active++; try { if (!authenticated) throw new ConnectorError('manual_login_required', 'Expired'); await hook?.(); signal.throwIfAborted(); return { bytes, name: 'synthetic.csv', contentType: 'text/csv' }; } finally { active--; } }),
    inspectExport: async binding => proof ? { ...binding, publishedAssignment: ref('goal_assignment', f.input.assignment), observedAt: f.clock.now(), expiresAt: new Date(Date.parse(f.clock.now()) + 60000).toISOString(), selectionVerified: true, allPagesExported: true, reportedRows: 1 } : null,
  };
  const profiles = createBrowserProfileService({ runtimeRoot: f.root, repository: f.repository, clock: f.clock });
  const directoryEntities = f.repository.readPublishedCatalog().filter(v => v.entityType === 'directory_entity').map(v => v.value as DirectoryEntity);
  const enricher = { enrich: ({ rows }: { rows: Capture['canonicalRows'] }) => enrichSourceRows({ capture: { sourceId: source.id, mappingRef: ref('source_field_mapping', mapping), rawRows: rows.map(row => ({ rowKey: row.rowKey, cells: {} })), canonicalRows: rows }, mapping, directoryEntities, directoryLinks: [] }) };
  const scenarios = createBrowserScenarioService({ repository: f.repository, drafts: f.service, runtime, profiles, parser: parseWorkbenchTable, enricher, clock: f.clock });
  const browserAdapter = createBrowserSourceAdapter({ runtime, profiles, scenarios, clock: f.clock });
  const store = createSourceStore({ repository: f.repository });
  store.installPublished([{ goalRef: ref('core_goal_definition', f.input.goal), sourceRef: { ...ref('source_definition', source), revision: 2 }, mappingRef: ref('source_field_mapping', mapping), assignmentRef: ref('goal_assignment', f.input.assignment), templateRef: null, methodRef: ref('method_version', f.input.method), metricRefs: f.input.metrics.map(m => ref('metric_definition', m)), directoryEntityRefs: directoryEntities.map(d => ref('directory_entity', d)), directoryLinkRefs: [], directoryRevision: 'synthetic-directory' }]);
  store.bindAdapter({ sourceId: source.id, adapterKey: 'browser', profileRef: null, revision: 'synthetic-1' });
  store.saveAllowedContext({ installationId: f.context.installationId, goalId: f.input.goal.id, revision: 'selection-1', context: { scopePath: { ditId: fixtureId(101), clusterId: null, productId: null, teamId: null }, goalId: f.input.goal.id, time: { kind: 'as_of', date: '2026-10-23' }, resultMode: 'current', snapshotId: null } }, null);
  const adapters = new Map<string, import('./workbench-source-contracts').SourceAdapter>();
  const service = createSourceService({ repository: f.repository, store, adapters, browserAdapter, normalizer: { normalize: () => { throw Error('Browser must use its real table normalizer'); } }, enricher, jobs: f.jobs, clock: f.clock, recheckGuard: async context => { if (f.context.ownAccess.policyState === 'revoked' || f.context.ownAccess.personId !== context.ownAccess.personId) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Access changed'); } });
  registerSourceCommands(f.registry, service);
  const login = createBrowserLoginService({ runtime, profiles, scenarios, repository: f.repository });
  registerBrowserCommands(f.registry, { profiles, scenarios, login, recorder: createBrowserRecorderService({ repository: f.repository, profiles, runtime, jobs: f.jobs, clock: f.clock }) });
  await profiles.set(f.context, { sourceId: source.id, profileId: 'synthetic', profile: privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { executablePath: process.execPath, profileDirectory: 'synthetic' } }), expectedRevision: null });
  f.context.ownAccess.role = 'viewer';
  let serial = 890000;
  const send = async (name = 'source.capture', payload: Record<string, unknown> = { goalId: f.input.goal.id }, commandId = fixtureId(serial++)) => { const accepted = await f.registry.execute({ commandId, name, payload, baseRevision: null }, { ...f.context, commandId }); await f.registry.idle(); return 'jobId' in accepted ? f.jobs.get(accepted.jobId, f.context.installationId)! : accepted; };
  const capture = async () => { const job = await send(); if (!('jobId' in job)) throw Error('Expected job'); return job; };
  return { ...f, source, mapping, scenario, scenarios, store, service, runtime, profiles, login, browserAdapter, adapters, enricher, send, capture, fallback: () => store.readFallback({ installationId: f.context.installationId, goalId: f.input.goal.id }), auth: (v: boolean) => { authenticated = v; }, marker: (v: boolean) => { visible = v; }, proof: (v: boolean) => { proof = v; }, bytes: (v: string) => { bytes = Buffer.from(v); }, hook: (v: typeof hook) => { hook = v; }, active: () => active };
}

async function restartCapture(f: Awaited<ReturnType<typeof fixture>>) {
  const repository = createWorkbenchRepository(f.config); draftCleanups.push(() => repository.close());
  const jobs = createJobStore({ repository, clock: f.clock });
  const registry = createCommandRegistry({ repository, jobs, accessPolicy: f.policy });
  const browserAdapter = createBrowserSourceAdapter({ runtime: f.runtime, profiles: f.profiles, scenarios: f.scenarios, clock: f.clock });
  const service = createSourceService({ repository, store: createSourceStore({ repository }), adapters: f.adapters, browserAdapter, normalizer: { normalize: () => { throw Error('Browser normalizer required'); } }, enricher: f.enricher, jobs, clock: f.clock, recheckGuard: async context => { if (f.context.ownAccess.policyState === 'revoked' || f.context.ownAccess.personId !== context.ownAccess.personId) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Changed access'); } });
  registerSourceCommands(registry, service);
  let resolved = 0;
  await registry.recoverPending(f.context.installationId, async identity => { resolved++; return { ...f.context, repository, commandId: identity.commandId }; }); await registry.idle();
  return { jobs, registry, resolved: () => resolved, retry: async (jobId: string, seed = 997000) => { const commandId = fixtureId(seed); const result = await registry.execute({ commandId, name: 'job.retry', payload: { jobId }, baseRevision: null }, { ...f.context, repository, commandId }); await registry.idle(); return result; } };
}
it('private preview evidence cannot authorize the published capture pipeline', async () => {
  const f = await fixture(); f.proof(false);
  Object.assign(f.runtime, { inspectPreviewExport: async (input: object) => ({ ...input, observedAt: f.clock.now(), expiresAt: '2026-10-23T12:10:00Z', selectionVerified: true, allPagesExported: true, reportedRows: 1 }) });
  const job = await f.capture();
  expect(job.status).toBe('failed'); expect(job.error?.code).toBe('EXPORT_COVERAGE_UNVERIFIED');
  expect(f.fallback().captureRef).toBeNull();
});
it.each(['waiting_user', 'running'] as const)('review_I1_rebinds_only_explicit_browser_retry_after_restart: %s', async state => {
  const f = await fixture(); f.auth(false); const original = await f.capture();
  if (state === 'running') f.jobs.update(original.jobId, { status: 'running', stage: 'source.collect', warnings: [], nextAction: null });
  let replays = 0; const replay = f.runtime.replay; f.runtime.replay = async (...args) => { replays++; return replay(...args); }; f.auth(true);
  const restarted = await restartCapture(f); expect(replays).toBe(0); expect(restarted.resolved()).toBe(0);
  expect(restarted.jobs.get(original.jobId, f.context.installationId)).toMatchObject({ status: state === 'running' ? 'interrupted' : 'waiting_user', retryAvailable: true });
  await restarted.retry(original.jobId); expect(restarted.jobs.get(original.jobId, f.context.installationId)).toMatchObject({ status: 'succeeded', commandId: original.commandId }); expect(replays).toBe(1); expect(restarted.resolved()).toBe(1);
  expect(f.store.listOwnCaptures({ installationId: f.context.installationId, profilePersonId: f.context.ownAccess.personId })).toHaveLength(1);
});
it.each(['owner', 'configuration', 'policy'] as const)('review_I1_restart_retry_rechecks_%s', async change => {
  const f = await fixture(); f.auth(false); const original = await f.capture(); const restarted = await restartCapture(f); f.auth(true);
  let replayed = false; f.runtime.replay = async () => { replayed = true; throw Error('Must recheck before replay'); };
  if (change === 'owner') { f.context.ownAccess.personId = fixtureId(999); f.context.actor.profilePersonId = fixtureId(999); await expect(restarted.retry(original.jobId)).rejects.toMatchObject({ statusCode: 404 }); }
  if (change === 'policy') { f.policy.assertCommandAllowed = async () => { throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Revoked at fresh policy gate'); }; await expect(restarted.retry(original.jobId)).rejects.toMatchObject({ statusCode: 403 }); }
  if (change === 'configuration') { const source = f.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: f.source.id })!; f.repository.append('source_definition', { ...source, revision: 3 }, 2); await restarted.retry(original.jobId); expect(restarted.jobs.get(original.jobId, f.context.installationId)?.error?.code).toBe('SOURCE_CONFIGURATION_CHANGED'); }
  expect(replayed).toBe(false); expect(f.fallback().captureRef).toBeNull();
});
it('review_I1_restart_reconciles_committed_receipt_without_replay', async () => {
  const f = await fixture(); f.jobs.complete = () => { throw Error('Simulated process loss after receipt'); }; const original = await f.capture(); expect(original.status).toBe('running'); const accepted = f.fallback().captureRef;
  let replayed = false; f.runtime.replay = async () => { replayed = true; throw Error('Must use durable receipt'); };
  const restarted = await restartCapture(f); expect(restarted.jobs.get(original.jobId, f.context.installationId)).toMatchObject({ status: 'succeeded', result: { captureRef: accepted } }); expect(replayed).toBe(false);
  expect(f.store.listOwnCaptures({ installationId: f.context.installationId, profilePersonId: f.context.ownAccess.personId })).toHaveLength(1);
});
it('review_I1_missing_recovery_handler_clears_advertised_retry', async () => {
  const f = await fixture(); f.auth(false); const original = await f.capture();
  const jobs = createJobStore({ repository: f.repository, clock: f.clock }), registry = createCommandRegistry({ repository: f.repository, jobs, accessPolicy: f.policy });
  await registry.recoverPending(f.context.installationId, async () => { throw Error('No registered capture handler'); });
  expect(jobs.get(original.jobId, f.context.installationId)).toMatchObject({ retryAvailable: false, cancelAvailable: false });
});
it('review_I1_missing_checkpoint_cannot_advertise_or_run_recovery', async () => {
  const f = await fixture(); f.auth(false); const original = await f.capture();
  f.repository.sqlForModule('jobs').run('DELETE FROM wb_jobs_checkpoints WHERE job_id=?', [original.jobId]);
  const restarted = await restartCapture(f); expect(restarted.jobs.get(original.jobId, f.context.installationId)).toMatchObject({ retryAvailable: false, cancelAvailable: false });
  await expect(restarted.retry(original.jobId)).rejects.toMatchObject({ code: 'RETRY_NOT_AVAILABLE' }); expect(restarted.resolved()).toBe(0);
});
it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE).each(['401', '403', 'login', 'fetch401', 'form403', 'unrelated403', 'cancel'] as const)('review_I2_real_export_click_handles_%s', async mode => {
  const f = await fixture(); let responseMode = 'completed'; const contexts: BrowserContext[] = [];
  let exportReached!: () => void; const reached = new Promise<void>(resolve => { exportReached = resolve; });
  const csv = 'demo_row_key,demo_scope_id,demo_metric_id,demo_value,demo_date\nr1,dit,m1,92.00,2026-10-23\n';
  const server = createServer((req, res) => {
    if (req.url === '/noise') { res.writeHead(403).end('Unrelated image denied'); return; }
    if (req.url === '/login') { res.writeHead(200, { 'content-type': 'text/html' }).end('<div data-authentication><input type="password"></div>'); return; }
    if (req.url?.startsWith('/export')) {
      if (responseMode === 'cancel') { exportReached(); return; }
      if (responseMode === 'login') { res.writeHead(302, { location: '/login' }).end(); return; }
      if (['401', '403', 'fetch401', 'form403'].includes(responseMode)) { res.writeHead(responseMode.endsWith('403') ? 403 : 401, { 'content-type': 'text/html' }).end('Export authentication failed'); return; }
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=report.csv' }).end(csv); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<div id="report">Report</div>' + (responseMode === 'form403' ? '<form action="/export"><button id="export" type="submit">Export</button></form>' : responseMode === 'fetch401' ? '<button id="export" onclick="fetch(\'/export\')">Export</button>' : '<a id="export" href="/export" onclick="const image=new Image();image.src=\'/noise\';fetch(\'/noise\')">Export</a>'));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const profile = await f.profiles.getOwn(f.context, f.source.id); await f.profiles.set(f.context, { sourceId: f.source.id, profileId: 'synthetic', expectedRevision: profile.revision, profile: privateProfileSchema.parse({ allowedOrigins: [origin], timeoutMs: 1500, browser: { ...testBrowserSelection(), profileDirectory: 'review-edge', headless: true } }) });
    f.repository.transaction(() => { f.repository.append('browser_scenario', { ...f.scenario, revision: 2, startUrl: origin + '/report' }, 1); const source = f.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: f.source.id })!; f.repository.append('source_definition', { ...source, revision: 3, browserScenarioRef: { ...ref('browser_scenario', f.scenario), revision: 2 } }, 2); });
    f.runtime.replay = createBrowserRuntime({ runtimeRoot: f.root, launcher: { launchPersistent: async (_profile, folder, options) => { expect(options.chromiumSandbox).toBe(true);const context = await chromium.launchPersistentContext(folder, { ...options, headless: true,...(process.env.UOR_TEST_CI_NO_SANDBOX==='1'?{chromiumSandbox:false}:{}) }); contexts.push(context); return context; } } }).replay;
    expect((await f.capture()).status).toBe('succeeded'); const previous = f.fallback(); responseMode = mode;
    const pending = f.capture();
    if (mode === 'cancel') { await reached; const running = f.jobs.recoveryCandidates(f.context.installationId).find(candidate => candidate.snapshot.status === 'running')!; await f.jobs.cancel(running.snapshot.jobId, f.context.installationId); }
    const job = await pending;
    if (mode === 'unrelated403') expect(job.status).toBe('succeeded');
    else { expect(job).toMatchObject(mode === 'cancel' ? { status: 'cancelled' } : mode.endsWith('403') ? { status: 'failed', error: { code: 'SOURCE_ACCESS_DENIED' } } : { status: 'waiting_user', stage: 'browser.auth', warnings: [{ code: 'AUTH_REQUIRED', provider: null }] }); expect(f.fallback().captureRef).toEqual(previous.captureRef); expect(f.fallback().sourceDate).toBe(previous.sourceDate); }
    expect(contexts.every(context => context.pages().length === 0)).toBe(true);
  } finally { await Promise.all(contexts.map(context => context.close().catch(() => {}))); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);

it('published_browser_capture_preserves_real_raw_bytes_and_business_date', async () => {
  const f = await fixture(); const job = await f.capture(); expect(job).toMatchObject({ status: 'succeeded', result: { acceptedRows: 1 } });
  const result = job.result as { captureRef: import('../../domain/workbench').VersionRef }; const view = f.store.readCapture(result.captureRef, f.context.installationId)!;
  expect(view.capture).toMatchObject({ obtainedVia: 'direct', rawRows: [{ cells: { demo_value: { original: '92.00' } } }] });
  expect(view.artifact?.hash).toBe(view.capture.payloadHash); expect(view.facts[0]).toMatchObject({ value: '92', businessTime: { kind: 'as_of', date: '2026-10-23' } });
  expect(f.fallback().captureRef).toEqual(result.captureRef);
});
it('login_retry_reuses_job_and_never_accepts_login_html', async () => {
  const f = await fixture(); const closeLogin = vi.spyOn(f.runtime, 'finish'); const first = await f.capture(); f.auth(false); const waiting = await f.capture();
  expect(waiting).toMatchObject({ status: 'waiting_user', stage: 'browser.auth', result: null, warnings: [{ code: 'AUTH_REQUIRED', provider: null }], nextAction: { commandName: 'source.browser.login.open' } });
  const opened = await f.send('source.browser.login.open', { sourceRef: { ...ref('source_definition', f.source), revision: 2 } });
  const loginId = opened.result!.loginId as string;
  expect(await f.login.finish(f.context, { loginId })).toMatchObject({ authenticated: false }); expect(f.fallback().captureRef).toEqual(first.result!.captureRef);
  f.marker(true); expect(await f.login.finish(f.context, { loginId })).toMatchObject({ authenticated: true });
  expect(closeLogin).not.toHaveBeenCalled();
  expect(f.runtime.prepareLogin).toHaveBeenCalledWith(expect.objectContaining({ loginHandleId: loginId, preparationId: f.source.id, preparationRevision: expect.stringMatching(/^[a-f0-9]{64}$/), startUrl: f.scenario.startUrl, authenticatedSelector: f.scenario.authenticatedSelector }));
  const preparation = vi.mocked(f.runtime.prepareLogin!).mock.calls[0][0];
  expect(f.jobs.get(waiting.jobId, f.context.installationId)?.nextAction).toMatchObject({ commandName: 'job.retry', payload: { jobId: waiting.jobId } });
  await f.send('job.retry', { jobId: waiting.jobId }); expect(f.jobs.get(waiting.jobId, f.context.installationId)).toMatchObject({ status: 'succeeded', commandId: waiting.commandId });
  expect(f.runtime.replay).toHaveBeenLastCalledWith(expect.objectContaining({ preparationId: preparation.preparationId, preparationRevision: preparation.preparationRevision, owner: preparation.owner, operationId: waiting.jobId }), expect.anything());
  await expect(f.login.finish(f.context, { loginId })).rejects.toMatchObject({ code: 'BROWSER_HANDLE_NOT_FOUND' });
  expect(f.store.listOwnCaptures({ installationId: f.context.installationId, profilePersonId: f.context.ownAccess.personId })).toHaveLength(2);
  const accepted = f.fallback().captureRef; f.bytes('<html>login</html>'); expect(await f.capture()).toMatchObject({ status: 'failed', error: { code: 'SOURCE_SCHEMA_CHANGED' } }); expect(f.fallback().captureRef).toEqual(accepted);
});
it('failed_partial_rows_and_changed_configuration_during_collection_preserve_last_success', async () => {
  const f = await fixture(); await f.capture(); const previous = f.fallback().captureRef;
  f.bytes('demo_row_key,demo_scope_id,demo_metric_id,demo_value,demo_date\nr1,dit,m1,bad,2026-10-23\n');
  const partial = await f.capture(); expect(partial.result).toMatchObject({ rejectedRows: 1 }); expect(f.fallback().captureRef).toEqual(previous);
  f.hook(async () => { const source = f.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: f.source.id })!; f.repository.append('source_definition', { ...source, revision: 3 }, 2); });
  expect(await f.capture()).toMatchObject({ status: 'failed', error: { code: 'SOURCE_CONFIGURATION_CHANGED' } }); expect(f.fallback().captureRef).toEqual(previous);
});
it('rechecks_live_access_before_commit', async () => {
  const f = await fixture(); await f.capture(); const previous = f.fallback().captureRef;
  f.hook(async () => { f.context.ownAccess.policyState = 'revoked'; });
  expect(await f.capture()).toMatchObject({ status: 'failed', error: { code: 'ACCESS_DENIED' } }); expect(f.fallback().captureRef).toEqual(previous);
});
it('resume_checks_original_private_owner_before_returning_an_existing_capture', async () => {
  const f = await fixture(); const job = await f.capture(); const context = { ...f.context, commandId: job.commandId };
  expect(await f.service.resumeBrowserCapture(job.jobId, context)).toMatchObject({ captureRef: job.result!.captureRef, duplicate: true });
  await expect(f.service.resumeBrowserCapture(job.jobId, { ...context, actor: { ...context.actor, profilePersonId: fixtureId(999) }, ownAccess: { ...context.ownAccess, personId: fixtureId(999) } })).rejects.toMatchObject({ code: 'SOURCE_CONFIGURATION_CHANGED' });
});
it('expired_export_evidence_before_atomic_commit_preserves_last_success', async () => {
  const f = await fixture(); await f.capture(); const previous = f.fallback().captureRef; const enrich = f.enricher.enrich;
  f.enricher.enrich = input => { const value = enrich(input); f.setNow(new Date(Date.parse(f.clock.now()) + 120000).toISOString()); return value; };
  expect(await f.capture()).toMatchObject({ status: 'failed', error: { code: 'EXPORT_COVERAGE_UNVERIFIED' } }); expect(f.fallback().captureRef).toEqual(previous);
});
it('changed_source_during_manual_login_closes_only_the_owned_handle', async () => {
  const f = await fixture(); const opened = await f.login.open(f.context, { sourceRef: { ...ref('source_definition', f.source), revision: 2 } });
  const source = f.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: f.source.id })!;
  f.repository.append('source_definition', { ...source, revision: 3 }, 2);
  let closed = false; const finish = f.runtime.finish; f.runtime.finish = async input => { closed = true; return finish(input); };
  await expect(f.login.finish(f.context, { loginId: opened.loginId })).rejects.toMatchObject({ code: 'SOURCE_CONFIGURATION_CHANGED' }); expect(closed).toBe(true);
});
it('simultaneous_adapter_preparations_keep_distinct_owned_job_contexts', async () => {
  const f = await fixture(); const binding = f.store.resolveCapture({ installationId: f.context.installationId, goalId: f.input.goal.id });
  const { captureRequestSchema } = await import('./workbench-source-contracts');
  const request = (id: number) => captureRequestSchema.parse({ operationId: fixtureId(id), goalRef: binding.goalRef, sourceRef: binding.sourceRef, mappingRef: binding.mappingRef, businessTime: binding.businessTime, context: binding.context, configurationRevision: binding.configurationRevision, profileRef: null });
  const first = request(999001), second = request(999002), other = { ...f.context, ownAccess: { ...f.context.ownAccess, personId: fixtureId(999) }, actor: { ...f.context.actor, profilePersonId: fixtureId(999) } };
  await f.profiles.set(other, { sourceId: f.source.id, profileId: 'second', profile: privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { executablePath: process.execPath, profileDirectory: 'second' } }), expectedRevision: null });
  const observed: Array<{ operation: string; owner: string | null; folder: string | undefined }> = [];
  let release!: () => void, started!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { started = resolve; });
  const replay = f.runtime.replay;
  f.runtime.replay = async (input, signal) => { observed.push({ operation: input.profile.browser!.profileDirectory!, owner: input.owner.profilePersonId, folder: input.profile.browser?.profileDirectory }); if (input.owner.profilePersonId === f.context.ownAccess.personId) { started(); await held; } return replay(input, signal); };
  f.browserAdapter.prepare(f.context, first, binding, f.store); f.browserAdapter.prepare(other, second, binding, f.store);
  const one = f.browserAdapter.collect(first, new AbortController().signal); await entered;
  const two = await f.browserAdapter.collect(second, new AbortController().signal); release(); const original = await one;
  expect(observed).toMatchObject([{ owner: fixtureId(17), folder: 'synthetic' }, { owner: fixtureId(999), folder: 'second' }]);
  expect(original.operationId).toBe(first.operationId); expect(two.operationId).toBe(second.operationId); expect(original.artifact!.artifactId).not.toBe(two.artifact!.artifactId);
  f.browserAdapter.release(first); f.browserAdapter.release(second);
});
it.each(['payloadHash', 'scenarioHash', 'mappingRef', 'sourceRef', 'publishedAssignment', 'allPagesExported', 'reportedRows', 'expiresAt'])('rejects invalid server export evidence: %s', async field => {
  const f = await fixture(); await f.capture(); const previous = f.fallback().captureRef; const inspect = f.runtime.inspectExport!;
  f.runtime.inspectExport = async (binding, signal) => ({ ...await inspect(binding, signal), [field]: field.endsWith('Hash') ? 'sha256:' + 'f'.repeat(64) : field === 'allPagesExported' ? false : field === 'reportedRows' ? 2 : field === 'expiresAt' ? '2020-01-01T00:00:00Z' : { entityType: 'source_definition', id: fixtureId(999), revision: 1 } }) as Awaited<ReturnType<typeof inspect>>;
  expect(await f.capture()).toMatchObject({ status: 'failed', error: { code: 'EXPORT_COVERAGE_UNVERIFIED' } }); expect(f.fallback().captureRef).toEqual(previous);
});
it.each([0, 2])('requires_unique_selector_in_actual_runtime: %s matches', async count => {
  const f = await fixture(); await f.capture(); const previous = f.fallback().captureRef;
  const events = new EventEmitter(); let closed = false;
  const page = browserPolicyPageFixture({ goto: async () => {}, url: () => f.scenario.startUrl, frames: () => [], locator: (selector: string) => ({ count: async () => selector === '#report' ? 1 : count, isVisible: async () => true, evaluateAll: async () => false }) });
  const context = Object.assign(events, { setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {}, pages: () => [page], newCDPSession: async () => browserPolicyCdpFixture(), setOffline: async () => {}, addInitScript: async () => {}, route: async () => {}, routeWebSocket: async () => {}, close: async () => { closed = true; events.emit('close'); } }) as unknown as BrowserContext;
  const runtime = createBrowserRuntime({ runtimeRoot: f.root, launcher: { launchPersistent: async () => context } }); f.runtime.replay = runtime.replay;
  expect(await f.capture()).toMatchObject({ status: 'failed', error: { code: count === 0 ? 'SELECTOR_NOT_FOUND' : 'SELECTOR_NOT_UNIQUE' } }); expect(closed).toBe(true); expect(f.fallback().captureRef).toEqual(previous);
});
it.each([401, 403])('actual_runtime_detects_http_auth_response: %s', async status => {
  const f = await fixture(); const events = new EventEmitter();
  const page = browserPolicyPageFixture({ goto: async () => ({ status: () => status }), url: () => f.scenario.startUrl, frames: () => [], locator: () => ({ count: async () => 1, isVisible: async () => true, evaluateAll: async () => false }) });
  const context = Object.assign(events, { setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {}, pages: () => [page], newCDPSession: async () => browserPolicyCdpFixture(), setOffline: async () => {}, addInitScript: async () => {}, route: async () => {}, routeWebSocket: async () => {}, close: async () => { events.emit('close'); } }) as unknown as BrowserContext;
  f.runtime.replay = createBrowserRuntime({ runtimeRoot: f.root, launcher: { launchPersistent: async () => context } }).replay;
  const job = await f.capture(); expect(status === 401 ? job.warnings[0]?.code : job.error?.code).toBe(status === 401 ? 'AUTH_REQUIRED' : 'SOURCE_ACCESS_DENIED');
});
it.each(['failed', 'missing', 'empty', 'html', 'completed'])('actual_runtime_requires_completed_nonempty_download: %s', async state => {
  const f = await fixture(); const events = new EventEmitter(); let closed = false;
  const filename = path.join(f.root, 'synthetic-download.csv'); await writeFile(filename, state === 'empty' ? '' : state === 'html' ? '<html>login</html>' : 'demo_row_key,demo_scope_id,demo_metric_id,demo_value,demo_date\nr1,dit,m1,92,2026-10-23\n');
  const download = { failure: async () => state === 'failed' ? 'cancelled' : null, path: async () => {if(state==='failed')throw Error('Engine download failed');return state==='missing'?null:filename;}, suggestedFilename: () => 'synthetic.csv', cancel: async () => {}, delete: async () => {} };
  const pageEvents = new EventEmitter(); const page = Object.assign(pageEvents, { goto: async () => {}, url: () => f.scenario.startUrl, frames: () => [], locator: () => ({ count: async () => 1, isVisible: async () => true, evaluateAll: async () => false, evaluate: async () => null, waitFor: async () => {}, click: async () => { pageEvents.emit('download', download); } }) });
  const context = Object.assign(events, { setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {}, pages: () => [page], newCDPSession: async () => browserPolicyCdpFixture(), setOffline: async () => {}, addInitScript: async () => {}, route: async () => {}, routeWebSocket: async () => {}, close: async () => { closed = true; events.emit('close'); } }) as unknown as BrowserContext;
  f.runtime.replay = createBrowserRuntime({ runtimeRoot: f.root, launcher: { launchPersistent: async () => context } }).replay;
  const job = await f.capture(); expect(job.status).toBe(state === 'completed' ? 'succeeded' : 'failed'); expect(closed).toBe(true);
  if (state !== 'completed') {expect(f.fallback().captureRef).toBeNull();expect(job.error?.code).toBe(state === 'html' ? 'SOURCE_SCHEMA_CHANGED' : 'DOWNLOAD_REQUIRED');}
});
it('missing_export_proof_empty_download_and_cancel_keep_previous_capture', async () => {
  const f = await fixture(); await f.capture(); const previous = f.fallback().captureRef;
  f.proof(false); expect(await f.capture()).toMatchObject({ status: 'failed', error: { code: 'EXPORT_COVERAGE_UNVERIFIED' } });
  f.proof(true); f.bytes(''); expect(await f.capture()).toMatchObject({ status: 'failed', error: { code: 'DOWNLOAD_REQUIRED' } });
  f.hook(async () => { const job = f.jobs.recoveryCandidates(f.context.installationId).find(v => v.snapshot.status === 'running')!; await f.jobs.cancel(job.snapshot.jobId, f.context.installationId); });
  expect(await f.capture()).toMatchObject({ status: 'cancelled' }); expect(f.active()).toBe(0); expect(f.fallback().captureRef).toEqual(previous);
});
it('retry_rejects_changed_published_source_and_changed_owner', async () => {
  const f = await fixture(); f.auth(false); const job = await f.capture();
  const source = f.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: f.source.id })!;
  f.repository.append('source_definition', { ...source, revision: 3, publicLocator: 'https://report.example.invalid/new-report' }, 2);
  f.auth(true); await f.send('job.retry', { jobId: job.jobId }); expect(f.jobs.get(job.jobId, f.context.installationId)).toMatchObject({ status: 'failed', error: { code: 'SOURCE_CONFIGURATION_CHANGED' } });
  f.auth(false); const own = await f.capture(); f.context.ownAccess.personId = fixtureId(999); f.context.actor.profilePersonId = fixtureId(999);
  await expect(f.send('job.retry', { jobId: own.jobId })).rejects.toMatchObject({ statusCode: 404 });
});
it('removing_browser_scenario_cannot_switch_the_original_retry_to_another_adapter', async () => {
  const f = await fixture(); f.auth(false); const waiting = await f.capture(); let invoked = false;
  f.adapters.set('browser', { check: async () => { invoked = true; throw Error('Must not switch source adapter'); }, collect: async () => { throw Error('Must not collect'); } });
  const source = f.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: f.source.id })!;
  f.repository.append('source_definition', { ...source, revision: 3, browserScenarioRef: null }, 2);
  await f.send('job.retry', { jobId: waiting.jobId }); expect(f.jobs.get(waiting.jobId, f.context.installationId)).toMatchObject({ status: 'failed', error: { code: 'SOURCE_CONFIGURATION_CHANGED' } }); expect(invoked).toBe(false);
});
it('login_observation_requires_live_unique_report_marker_and_owned_handle', async () => {
  const f = await fixture(); let count = 0, closed = false, pageUrl = f.scenario.startUrl;
  const events = new EventEmitter();
  const page = browserPolicyPageFixture({ goto: async () => {}, url: () => pageUrl, frames: () => [], locator: (selector: string) => ({ count: async () => count, isVisible: async () => !closed && count > 0, evaluateAll: async () => selector === '#report' }) });
  const context = Object.assign(events, { setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {}, pages: () => closed ? [] : [page], newCDPSession: async () => browserPolicyCdpFixture(), setOffline: async () => {}, addInitScript: async () => {}, route: async () => {}, routeWebSocket: async () => {}, close: async () => { if (!closed) { closed = true; events.emit('close'); } } }) as unknown as BrowserContext;
  const runtime = createBrowserRuntime({ runtimeRoot: f.root, launcher: { launchPersistent: async () => context } });
  const owner = { installationId: f.context.installationId, profilePersonId: f.context.ownAccess.personId };
  const opened = await runtime.openLogin({ owner, profile: (await f.profiles.getOwn(f.context, f.source.id)).profile!, startUrl: f.scenario.startUrl, authenticatedSelector: '#report' }, new AbortController().signal);
  const observe = () => runtime.observeLogin!({ owner, handleId: opened.handleId });
  expect(await observe()).toBe(false); count = 2; expect(await observe()).toBe(false); count = 1; expect(await observe()).toBe(true);
  pageUrl = 'https://report.example.invalid/login'; expect(await observe()).toBe(false);
  await expect(runtime.observeLogin!({ owner: { ...owner, profilePersonId: fixtureId(999) }, handleId: opened.handleId })).rejects.toMatchObject({ code: 'BROWSER_HANDLE_NOT_FOUND' });
  await runtime.closeOwned(owner); await expect(observe()).rejects.toMatchObject({ code: 'BROWSER_HANDLE_NOT_FOUND' });
});
