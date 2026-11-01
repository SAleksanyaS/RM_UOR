import { afterEach, expect, it, vi } from 'vitest';
import { probeOkoBrowser, publicOkoBrowserProbeReport, okoBrowserProbeConfigSchema, okoBankRequiredChecks, type OkoProbeTrustedPorts } from '../src/features/connectors/workbench-browser-probe';
import { draftFixture, draftCleanups } from './fixtures/workbench/drafts';
import { fixtureId, makeHeader, makeNumericFixture } from './fixtures/workbench/factories';
import { createNativeBrowserFixture } from './fixtures/workbench/native-browser';
import { createBrowserProfileService } from '../src/features/connectors/workbench-browser-profile';
import { privateProfileSchema } from '../src/features/connectors/contracts';
import { browserScenarioDefinitionSchema } from '../src/domain/workbench/browser-scenario';
import type { SourceDefinition, SourceFieldMapping } from '../src/domain/workbench/entities';
import type { BrowserRuntimePort } from '../src/features/connectors/workbench-browser-runtime';
import type { BrowserExportBinding, BrowserExportEvidence } from '../src/features/connectors/workbench-source-contracts';
import { runOkoBrowserCli } from '../scripts/probe-oko-browser';
import { mkdir, writeFile, readFile, readdir, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireRuntimeLease } from '../src/server/workbench/runtime-lease';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const ref = (entityType: string, value: { id: string; revision: number }) => ({ entityType, id: value.id, revision: value.revision });
afterEach(async () => { while (draftCleanups.length) await draftCleanups.pop()!(); });
async function fixture(native?: Awaited<ReturnType<typeof createNativeBrowserFixture>>) {
  const f = draftFixture({ input: makeNumericFixture({ scope: { kind: 'dit', id: fixtureId(101) } }) });
  const old = f.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: f.input.goal.sourceId })!;
  const priorMapping = f.repository.readVersion<SourceFieldMapping>(old.mappingRef!)!;
  const mapping = { ...priorMapping, revision: 2, parsingProfile: { ...priorMapping.parsingProfile!, ...(native ? { csvDelimiter: ';' as const, decimalSeparator: ',' as const, dateFormat: 'dd.mm.yyyy' as const } : {}) }, rowKeyFields: ['Key'], dimensionFields: {}, fixedScope: f.input.assignment.scope, productKeyField: null, metricFields: [{ metricId: f.input.metrics[0].id, fields: { demo_value: 'Amount' } }], dateField: 'Date' };
  const scenario = browserScenarioDefinitionSchema.parse({ ...makeHeader(988001, { publicationAnchorId: old.publicationAnchorId }), sourceId: old.id, startUrl: native?.input.startUrl ?? 'https://synthetic.example.invalid/report', authenticatedSelector: native?.input.authenticatedSelector ?? '#ready', steps: [{ action: 'fill', locator: { kind: 'css', selector: '#period' }, parameter: 'period' }, { action: 'select', locator: { kind: 'css', selector: '#scope' }, parameter: 'scope' }, { action: 'download', locator: { kind: 'css', selector: '#export' } }], parameters: { period: '2026-10', scope: 'all' }, expectedExport: { format: 'csv', requiredColumns: ['Key', 'Amount', 'Date'] } });
  const source = { ...old, revision: 2, mappingRef: ref('source_field_mapping', mapping), browserScenarioRef: ref('browser_scenario', scenario) };
  f.repository.transaction(() => { f.repository.append('source_field_mapping', mapping, 1); f.repository.append('browser_scenario', scenario, null); f.repository.append('source_definition', source, 1); });
  const profiles = createBrowserProfileService({ runtimeRoot: native?.root ?? f.root, repository: f.repository, clock: f.clock });
  await profiles.set(f.context, { sourceId: source.id, profileId: 'synthetic', profile: native?.profile ?? privateProfileSchema.parse({ allowedOrigins: ['https://synthetic.example.invalid'], browser: { executablePath: process.execPath, profileDirectory: 'synthetic' } }), expectedRevision: null });
  const record = { recordingId: fixtureId(988002), startUrl: scenario.startUrl, authenticatedSelector: scenario.authenticatedSelector, steps: scenario.steps, parameterNames: [], screenshotHandles: [], hasDownload: true };
  const unused = async (): Promise<never> => { throw Error('unused'); };
  const runtime: BrowserRuntimePort = native?.runtime ?? { openLogin: vi.fn(async () => ({ handleId: fixtureId(988002), state: 'open' as const, mode: 'login' as const })), observeLogin: async () => true, finish: async () => record, startRecording: vi.fn(async () => ({ handleId: fixtureId(988003), state: 'open' as const, mode: 'record' as const })), waitForCompletion: async () => record, replay: vi.fn(async () => ({ name: 'synthetic.csv', bytes: Buffer.from('Key,Amount,Date\nr1,92,2026-10-23\n'), contentType: 'text/csv' })), screenshot: unused, closeOwned: vi.fn(async () => {}) };
  const input = { runtimeRoot: native?.root ?? f.root, profileId: 'synthetic', sourceRef: ref('source_definition', source), scenarioRef: ref('browser_scenario', scenario), mode: 'record-replay' as const };
  const trusted = { currentContext: async () => f.context, profiles, operator: { login: async (_input?: { handleId: string; signal: AbortSignal }) => {}, record: async (_input?: { handleId: string; signal: AbortSignal }) => {} }, browser: (): { name: string; version: string | null } => ({ name: 'Edge', version: '130.0.0.0' }), inspectExport: async (binding: BrowserExportBinding): Promise<BrowserExportEvidence | null> => ({ ...binding, publishedAssignment: ref('goal_assignment', f.input.assignment), observedAt: f.clock.now(), expiresAt: new Date(Date.parse(f.clock.now()) + 60000).toISOString(), selectionVerified: true, allPagesExported: true, reportedRows: native ? 2000 : 1 }) };
  return { ...f, assignment: f.input.assignment, input, trusted, runtime, deps: { runtime, repository: f.repository, clock: f.clock, trusted }, source, scenario, mapping };
}
it('missing_bank_inputs_never_pass_probe', async () => {
  const f = await fixture();
  const result = await probeOkoBrowser({ ...f.input, profileId: '' }, f.deps);
  expect(result).toMatchObject({ status: 'blocked', acceptedSourceBinding: false });
  expect(f.runtime.openLogin).not.toHaveBeenCalled(); expect(f.runtime.replay).not.toHaveBeenCalled();
  const missingTrusted = await probeOkoBrowser(f.input, { runtime: f.runtime, repository: f.repository, clock: f.clock });
  expect(missingTrusted.checks.map(x => x.code)).toContain('TRUSTED_CONTEXT_REQUIRED');
  expect(f.runtime.openLogin).not.toHaveBeenCalled();
});
it('local_edge_evidence_does_not_claim_sber_compatibility', async () => {
  const f = await fixture(); Object.assign(f.trusted, { bankVerified: true });
  const result = await probeOkoBrowser(f.input, f.deps);
  expect(result).toMatchObject({ status: 'blocked', acceptedSourceBinding: false, browser: { name: 'Edge' } });
  expect(f.runtime.openLogin).toHaveBeenCalled(); expect(f.runtime.startRecording).toHaveBeenCalled(); expect(f.runtime.replay).toHaveBeenCalled();
  expect(result.checks).toContainEqual(expect.objectContaining({ code: 'EXPORT_COMPLETE', status: 'passed' }));
  expect(result.checks).toContainEqual(expect.objectContaining({ code: 'BLOCKED_BANK_INPUT', status: 'blocked' }));
});
it('probe_report_redacts_secrets_and_requires_complete_export', async () => {
  const f = await fixture(); f.trusted.inspectExport = async binding => ({ ...binding, publishedAssignment: ref('goal_assignment', f.assignment), observedAt: f.clock.now(), expiresAt: new Date(Date.parse(f.clock.now()) + 60000).toISOString(), selectionVerified: true, allPagesExported: true, reportedRows: 2000 });
  const result = await probeOkoBrowser(f.input, f.deps);
  expect(result).toMatchObject({ status: 'failed', acceptedSourceBinding: false });
  expect(result.checks).toContainEqual(expect.objectContaining({ code: 'EXPORT_COMPLETE', status: 'failed' }));
  vi.mocked(f.runtime.replay).mockRejectedValue(Error('synthetic-token Cookie: Authorization: PRIVATE KEY C:/secret/profile?key=secret'));
  const failed = await probeOkoBrowser(f.input, f.deps);
  failed.privateEvidencePath = 'C:/synthetic-token/PRIVATE KEY';
  expect(JSON.stringify(publicOkoBrowserProbeReport(failed))).not.toMatch(/synthetic-token|Cookie:|Authorization:|PRIVATE KEY|secret/);
});
it('current owner, current refs, access and strict config are checked before launch', async () => {
  const f = await fixture();
  expect(okoBrowserProbeConfigSchema.safeParse({ ...f.input, bankVerified: true }).success).toBe(false);
  f.context.ownAccess.personId = fixtureId(988100);
  expect((await probeOkoBrowser(f.input, f.deps)).status).toBe('blocked'); expect(f.runtime.openLogin).not.toHaveBeenCalled();
  f.context.ownAccess.policyState = 'revoked';
  expect((await probeOkoBrowser(f.input, f.deps)).status).toBe('blocked'); expect(f.runtime.openLogin).not.toHaveBeenCalled();
});
it('check never starts a browser and a changed exact scenario blocks before launch', async () => {
  const f = await fixture();
  expect((await probeOkoBrowser({ ...f.input, mode: 'check' }, f.deps)).acceptedSourceBinding).toBe(false);
  expect(f.runtime.openLogin).not.toHaveBeenCalled();
  expect((await probeOkoBrowser({ ...f.input, scenarioRef: { ...f.input.scenarioRef, revision: 99 } }, f.deps)).status).toBe('blocked');
  expect(f.runtime.openLogin).not.toHaveBeenCalled();
});
it('standalone CLI missing configuration is structured blocked with no evidence path', async () => {
  const result = await runOkoBrowserCli([]);
  expect(result).toMatchObject({ status: 'blocked', acceptedSourceBinding: false, privateEvidencePath: null, browser: { name: 'unobserved' } });
  expect((await runOkoBrowserCli(['--provider', 'C:/secret.js'])).status).toBe('blocked');
});
it('standalone CLI refuses an already leased synthetic workspace before opening its database', async () => {
  const f = await fixture();
  await mkdir(path.join(f.root, '.runtime/probes/oko'), { recursive: true }); await mkdir(path.join(f.root, 'config'), { recursive: true });
  await writeFile(path.join(f.root, 'config/site.local.json'), JSON.stringify({ allowedWorkspaceRoots: [f.root], roleMode: 'local-preview' }));
  const { runtimeRoot: _unused, ...config } = f.input;
  await writeFile(path.join(f.root, '.runtime/probes/oko/local.json'), JSON.stringify({ ...config, mode: 'check' }));
  const release = await acquireRuntimeLease(f.root);
  try {
    const child = spawnSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/probe-oko-browser.ts'), '--config', '.runtime/probes/oko/local.json'], { cwd: f.root, encoding: 'utf8', timeout: 30000, windowsHide: true });
    expect(child.status).toBe(2);
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 'blocked', acceptedSourceBinding: false, checks: [expect.objectContaining({ code: 'WORKSPACE_BUSY' })] });
  } finally { await release(); }
});
it.each(['zero-byte', 'incomplete', 'missing', 'valid', 'pending-wal', 'pending-journal'] as const)('standalone check preserves %s managed active database without launches or migrations', async kind => {
  const f = await fixture(), runtimeRoot = path.join(f.root, '.runtime/workbench'), activeRoot = path.join(runtimeRoot, 'subject/initial');
  await mkdir(path.join(f.root, '.runtime/probes/oko'), { recursive: true }); await mkdir(path.join(f.root, 'config'), { recursive: true }); await mkdir(activeRoot, { recursive: true });
  await writeFile(path.join(f.root, 'config/site.local.json'), JSON.stringify({ allowedWorkspaceRoots: [f.root], roleMode: 'local-preview' }));
  await writeFile(path.join(runtimeRoot, 'identity.json'), JSON.stringify({ installationId: f.context.installationId, personId: f.context.ownAccess.personId }));
  await writeFile(path.join(runtimeRoot, 'active.json'), JSON.stringify({ version: 1, active: 'initial' }));
  const { runtimeRoot: _unused, ...config } = f.input;
  await writeFile(path.join(f.root, '.runtime/probes/oko/local.json'), JSON.stringify({ ...config, mode: 'check' }));
  const database = path.join(activeRoot, 'workbench.sqlite');
  if (kind === 'zero-byte') await writeFile(database, '');
  if (kind === 'incomplete') { const db = new DatabaseSync(database); db.exec('CREATE TABLE retained_history (id TEXT)'); db.close(); }
  if (['valid', 'pending-wal', 'pending-journal'].includes(kind)) { f.repository.close(); await copyFile(f.config.filename, database); }
  if (kind === 'pending-wal' || kind === 'pending-journal') await writeFile(database + (kind === 'pending-wal' ? '-wal' : '-journal'), 'synthetic retained journal');
  const before = kind === 'missing' ? null : await readFile(database), beforeEntries = await readdir(activeRoot);
  const schema = (file: string) => { const db = new DatabaseSync(pathToFileURL(file).href + '?mode=ro&immutable=1', { readOnly: true }); try { return db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(); } finally { db.close(); } };
  const beforeSchema = before?.length ? schema(database) : [];
  const child = spawnSync(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('scripts/probe-oko-browser.ts'), '--config', '.runtime/probes/oko/local.json'], { cwd: f.root, encoding: 'utf8', timeout: 30000, windowsHide: true });
  expect(child.status).toBe(2); const report = JSON.parse(child.stdout);
  expect(report).toMatchObject({ status: 'blocked', acceptedSourceBinding: false, browser: { name: 'unobserved' } });
  if (kind !== 'valid') expect(report.checks.map((check: { code: string }) => check.code)).toContain('RECOVERY_REQUIRED');
  if (kind === 'missing') await expect(access(database)).rejects.toMatchObject({ code: 'ENOENT' });
  else { expect(await readFile(database)).toEqual(before); if (before?.length) expect(schema(database)).toEqual(beforeSchema); }
  expect(await readdir(activeRoot)).toEqual(beforeEntries);
});
it('viewer may check existing binding but cannot launch record-replay', async () => {
  const f = await fixture(); f.context.ownAccess.role = 'viewer';
  const record = await probeOkoBrowser(f.input, f.deps);
  expect(record.checks.map(check => check.code)).toContain('RECORDING_FORBIDDEN');
  expect(f.runtime.openLogin).not.toHaveBeenCalled(); expect(f.runtime.startRecording).not.toHaveBeenCalled(); expect(f.runtime.replay).not.toHaveBeenCalled();
  const check = await probeOkoBrowser({ ...f.input, mode: 'check' }, f.deps);
  expect(check.checks).toContainEqual(expect.objectContaining({ code: 'CONFIGURATION_READY', status: 'passed' }));
});
it.each(['login', 'record'] as const)('role downgraded during %s wait stops further recording/replay and only cleans probe handles', async stage => {
  const f = await fixture(); const finish = vi.spyOn(f.runtime, 'finish'); f.runtime.cancelRecording = vi.fn(async () => {});
  f.trusted.operator[stage] = async () => { f.context.ownAccess.role = 'viewer'; };
  const result = await probeOkoBrowser(f.input, f.deps);
  expect(result.checks.map(check => check.code)).toContain('RECORDING_FORBIDDEN'); expect(result.acceptedSourceBinding).toBe(false);
  if (stage === 'login') expect(f.runtime.startRecording).not.toHaveBeenCalled();
  expect(f.runtime.replay).not.toHaveBeenCalled(); expect(f.runtime.closeOwned).not.toHaveBeenCalled();
  expect([...finish.mock.calls, ...vi.mocked(f.runtime.cancelRecording).mock.calls].every(([input]) => [fixtureId(988002), fixtureId(988003)].includes(input.handleId))).toBe(true);
});
it.each(['person', 'installation', 'repository', 'profile', 'target-expiry-context', 'target-expiry-profile', 'export-expiry', 'context-mutated-profile', 'policy-mutated-profile'] as const)('final authoritative gate rejects changed %s without claiming synthetic bank success', async change => {
  const f = await fixture(); f.context.ownAccess.policyState = 'verified';
  let verified = false, finalSamples = 0;
  const getOwn = f.trusted.profiles.getOwn.bind(f.trusted.profiles);
  const trusted: OkoProbeTrustedPorts = { ...f.trusted, browser: () => ({ name: 'SberBrowser', version: '130.0.0.0' }),
    currentContext: async () => {
      if (!verified || ++finalSamples !== 2) return f.context;
      if (change === 'target-expiry-context' || change === 'export-expiry') f.setNow(new Date(Date.parse(f.clock.now()) + 2000).toISOString());
      return { ...f.context, installationId: change === 'installation' ? fixtureId(988101) : f.context.installationId, repository: change === 'repository' ? {} as typeof f.repository : f.repository, ownAccess: { ...f.context.ownAccess, personId: change === 'person' ? fixtureId(988102) : f.context.ownAccess.personId } };
    },
    profiles: { getOwn: async (context, sourceId) => {
      const result = await getOwn(context, sourceId);
      if (verified && finalSamples === 2) {
        if (change === 'profile') return { ...result, revision: 'changed' };
        if (change === 'target-expiry-profile') f.setNow(new Date(Date.parse(f.clock.now()) + 2000).toISOString());
        if (change === 'context-mutated-profile') context.installationId = fixtureId(988103);
        if (change === 'policy-mutated-profile') context.ownAccess.policyState = 'revoked';
      }
      return result;
    } },
    targetEvidence: { verify: async binding => { verified = true; return { binding, observedAt: f.clock.now(), expiresAt: new Date(Date.parse(f.clock.now()) + (change === 'export-expiry' ? 60000 : 1000)).toISOString(), checks: okoBankRequiredChecks.map(code => ({ code, status: 'passed' as const })) }; } },
  };
  if (change === 'export-expiry') { const inspect = trusted.inspectExport!; trusted.inspectExport = async (binding, signal) => { const result = (await inspect(binding, signal))!; return { ...result, expiresAt: new Date(Date.parse(f.clock.now()) + 1000).toISOString() }; }; }
  const result = await probeOkoBrowser(f.input, { ...f.deps, trusted });
  expect(verified).toBe(true); expect(finalSamples).toBe(2);
  expect(result.acceptedSourceBinding).toBe(false); expect(result.status).toBe('blocked');
});
it.each(['missing', 'stale', 'other-mapping', 'no-all-pages'] as const)('export evidence %s cannot certify complete bank data', async kind => {
  const f = await fixture(), inspect = f.trusted.inspectExport;
  f.trusted.inspectExport = async binding => {
    if (kind === 'missing') return null;
    const evidence = (await inspect(binding))!;
    if (kind === 'stale') evidence.expiresAt = f.clock.now();
    if (kind === 'other-mapping') evidence.mappingRef = { ...evidence.mappingRef, revision: 999 };
    if (kind === 'no-all-pages') evidence.allPagesExported = false;
    return evidence;
  };
  const result = await probeOkoBrowser(f.input, f.deps);
  expect(result.status).toBe(kind === 'missing' ? 'blocked' : 'failed'); expect(result.acceptedSourceBinding).toBe(false);
});
it.each(['bad-number', 'bad-date', 'duplicate-key'] as const)('mapped %s is rejected without facts or acceptance', async kind => {
  const f = await fixture(), stable = f.repository.getStateRevision();
  const csv = kind === 'bad-number' ? 'Key,Amount,Date\nr1,unknown,2026-10-23\n' : kind === 'bad-date' ? 'Key,Amount,Date\nr1,92,not-a-date\n' : 'Key,Amount,Date\nr1,92,2026-10-23\nr1,93,2026-10-23\n';
  vi.mocked(f.runtime.replay).mockResolvedValue({ name: 'synthetic.csv', bytes: Buffer.from(csv), contentType: 'text/csv' });
  const result = await probeOkoBrowser(f.input, f.deps);
  expect(result).toMatchObject({ status: 'failed', acceptedSourceBinding: false });
  expect(result.checks).toContainEqual(expect.objectContaining({ code: 'EXPORT_INVALID', status: 'failed' }));
  expect(f.repository.getStateRevision()).toBe(stable);
});
it('access revoked during operator wait closes only probe handle and never starts recording', async () => {
  const f = await fixture(); f.trusted.operator.login = async () => { f.context.ownAccess.policyState = 'revoked'; };
  const finish = vi.spyOn(f.runtime, 'finish');
  const result = await probeOkoBrowser(f.input, f.deps);
  expect(result).toMatchObject({ status: 'blocked', acceptedSourceBinding: false });
  expect(f.runtime.startRecording).not.toHaveBeenCalled(); expect(f.runtime.replay).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledWith(expect.objectContaining({ handleId: fixtureId(988002), save: false }));
  expect(f.runtime.closeOwned).not.toHaveBeenCalled();
});
it('a browser name and archive booleans never substitute for target evidence', async () => {
  const f = await fixture(); f.trusted.browser = () => ({ name: 'SberBrowser', version: '130.0.0.0' });
  Object.assign(f.trusted, { bankVerified: true, authorized: true, targetEvidenceJson: { allChecksPassed: true } });
  expect((await probeOkoBrowser(f.input, f.deps)).acceptedSourceBinding).toBe(false);
});
it('cancel while waiting for recording completion closes only the probe recording', async () => {
  const f = await fixture(), controller = new AbortController();
  f.runtime.waitForCompletion = () => new Promise(() => {});
  f.trusted.operator.record = async () => { controller.abort(); };
  f.runtime.cancelRecording = vi.fn(async () => {});
  const result = await Promise.race([probeOkoBrowser(f.input, { ...f.deps, signal: controller.signal }), new Promise<never>((_resolve, reject) => setTimeout(() => reject(Error('Probe ignored abort')), 1000))]);
  expect(result.checks).toContainEqual(expect.objectContaining({ code: 'CANCELLED', status: 'blocked' }));
  expect(f.runtime.cancelRecording).toHaveBeenCalledWith(expect.objectContaining({ handleId: fixtureId(988003) }));
  expect(f.runtime.closeOwned).not.toHaveBeenCalled(); expect(f.runtime.replay).not.toHaveBeenCalled();
});
it('native installed Edge runs login recording completion and replay without accepting bank binding', async () => {
  const native = await createNativeBrowserFixture(); draftCleanups.push(native.close);
  const f = await fixture(native); const before = f.repository.getStateRevision();
  let nativeVersion: string | null = null;
  f.trusted.browser = () => ({ name: 'Edge', version: nativeVersion });
  f.trusted.inspectExport = async binding => {
    const delivered = native.report.deliveries().filter(value => value.payloadHash === binding.payloadHash).at(-1);
    if (!delivered) return null;
    return { ...binding, publishedAssignment: ref('goal_assignment', f.assignment), observedAt: f.clock.now(), expiresAt: new Date(Date.parse(f.clock.now()) + 60000).toISOString(), selectionVerified: delivered.period === '2026-10' && delivered.scope === 'all', allPagesExported: delivered.complete, reportedRows: delivered.declaredRows };
  };
  f.trusted.operator.login = async () => {
    const cdp = await native.page().context().newCDPSession(native.page());
    nativeVersion = (await cdp.send('Browser.getVersion')).product.split('/')[1] ?? null; await cdp.detach();
    await native.login();
  };
  f.trusted.operator.record = async () => {
    await native.page().getByLabel('Период', { exact: true }).fill('2026-10');
    await native.page().getByLabel('Период', { exact: true }).press('Tab');
    await native.page().getByLabel('Состав', { exact: true }).selectOption('all');
    await native.page().getByRole('button', { name: 'Выгрузить CSV' }).click({ noWaitAfter: true });
    await native.report.waitForEvent('export-requested'); native.report.release('download');
  };
  const replay = native.runtime.replay.bind(native.runtime);
  native.runtime.replay = async (input, signal) => { const pending = replay(input, signal); await native.report.waitForEvent('export-requested'); native.report.release('download'); return pending; };
  // The fixture's report uses public selectors; the real runtime receives this exact published scenario.
  f.scenario.steps = [{ action: 'fill', locator: { kind: 'label', text: 'Период', exact: true }, parameter: 'period' }, { action: 'select', locator: { kind: 'label', text: 'Состав', exact: true }, parameter: 'scope' }, { action: 'download', locator: { kind: 'role', role: 'button', name: 'Выгрузить CSV', exact: true } }];
  f.repository.append('browser_scenario', { ...f.scenario, revision: 2 }, 1);
  f.repository.append('source_definition', { ...f.source, revision: 3, browserScenarioRef: { ...f.input.scenarioRef, revision: 2 } }, 2);
  f.input.sourceRef.revision = 3; f.input.scenarioRef.revision = 2;
  const stable = f.repository.getStateRevision(); const result = await probeOkoBrowser(f.input, f.deps);
  expect(result).toMatchObject({ status: 'blocked', acceptedSourceBinding: false });
  expect(result.checks).toContainEqual(expect.objectContaining({ code: 'EXPORT_COMPLETE', status: 'passed' }));
  expect(native.launchCount()).toBeGreaterThanOrEqual(3); expect(native.openContexts()).toBe(0);
  expect(f.repository.getStateRevision()).toBe(stable); expect(stable).not.toBe(before);
  expect(result.browser.version).toMatch(/^\d+(?:\.\d+){1,3}$/);
  await writeFile(path.resolve('.runtime/validation/workbench/continuation/t48-native-probe.json'), JSON.stringify({ report: publicOkoBrowserProbeReport(result), syntheticOnly: true, launchCount: native.launchCount(), deliveredRows: native.report.deliveries().at(-1)?.deliveredRows, repositoryUnchangedByProbe: f.repository.getStateRevision() === stable }, null, 2) + '\n');
}, 60000);
