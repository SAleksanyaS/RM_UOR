import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { bankProbeIds, bankProbeProfileSchema, bankProbeReportSchema, type BankProbeId, type BankProbeProfile } from './bank-probe-contracts';
import { checkBankReadiness, createBankProbeDriver, probeExitCode, requiredProbeChecks, runBankProbe, privateProbeReportDirectory, type ProbeBindingContext } from './bank-probe-driver';

const names = ['bitbucket', 'registry', 'qlik', 'legacy', 'runtime', 'terminal'];
async function example(index = 0): Promise<BankProbeProfile> {
  return JSON.parse(await readFile(`config/probes/${names[index]}.example.json`, 'utf8'));
}
async function complete(): Promise<Extract<BankProbeProfile, { probe: 'BP-01' }>> {
  return { ...await example(), probe: 'BP-01', profileId: 'test-profile', approvedOrigins: ['https://fixture.invalid'],
    credentialProfileRef: 'local-credential', repositoryId: 'fixture-repo', origin: 'https://fixture.invalid/repo',
    edition: 'observed-edition', version: 'observed-version', testBranch: 'probe/sandbox', existingTestPrId: '123',
    allowedAuthenticationDescription: 'approved authentication', mergeExamples: [{ kind: 'merge', prId: '123', mainCommit: 'abc' }] } as Extract<BankProbeProfile, { probe: 'BP-01' }>;
}
const options = { mode: 'dry-run' as const, approvalRef: null, reportDirectory: '.runtime/probe-reports/tests' };
const successChecks = (probe: BankProbeId) => requiredProbeChecks[probe].map(id => ({ id, status: 'passed' as const, evidenceRefs: ['evidence-1'], reason: null }));

describe('bank probe boundary', () => {
  it('new PR writes require creation provenance from the same approved run', async () => {
    const profile = await complete(); const contexts: ProbeBindingContext[] = [];
    const operations = ['native-pr.create', 'native-pr.update', 'test-pr.cleanup'];
    const approval = { probe: 'BP-01' as const, profileId: profile.profileId, repositoryId: profile.repositoryId, origin: profile.origin, expiresAt: '2999-01-01T00:00:00Z', target: profile.testBranch!, operations, sandbox: true, existingTestPrIds: ['123'] };
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: vi.fn(), writeOperations: operations, testWrite: async (_profile, context) => { contexts.push(context); return { checks: successChecks('BP-01'), externalWrites: 0, limitations: [] }; } } }, resolveApproval: async () => approval });
    const first = await driver(profile, { ...options, mode: 'test-write', approvalRef: 'approval' });
    const second = await driver(profile, { ...options, mode: 'test-write', approvalRef: 'approval' });
    expect(contexts[0].testPrScope).toBeDefined();
    const firstScope = contexts[0].testPrScope!; const secondScope = contexts[1].testPrScope!;
    expect(firstScope.runId).toBe(first.runId); expect(secondScope.runId).toBe(second.runId);
    expect(() => firstScope.assertWritable('123')).not.toThrow();
    expect(() => firstScope.assertWritable('new-pr')).toThrow('PROBE_PR_NOT_APPROVED');
    firstScope.recordCreated('new-pr'); expect(() => firstScope.assertWritable('new-pr')).not.toThrow();
    expect(() => secondScope.assertWritable('new-pr')).toThrow('PROBE_PR_NOT_APPROVED');
  });
  it.each(['native-pr.update', 'native-pr.decline', 'test-pr.cleanup'])('binds existing PR identity before %s dispatch', async operation => {
    const profile = await complete(); const testWrite = vi.fn(async () => ({ checks: successChecks('BP-01'), externalWrites: 1, limitations: [] }));
    const approval = { probe: 'BP-01' as const, profileId: profile.profileId, repositoryId: profile.repositoryId, origin: profile.origin, expiresAt: '2999-01-01T00:00:00Z', target: profile.testBranch!, operations: [operation], sandbox: true, existingTestPrIds: ['123'] };
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: vi.fn(), testWrite, writeOperations: [operation] } }, resolveApproval: async () => approval });
    const denied = await driver({ ...profile, existingTestPrId: 'unapproved-pr' }, { ...options, mode: 'test-write', approvalRef: 'approval' });
    expect(denied.status).toBe('failed'); expect(denied.externalWrites).toBe(0); expect(testWrite).not.toHaveBeenCalled();
    await driver(profile, { ...options, mode: 'test-write', approvalRef: 'approval' });
    expect(testWrite).toHaveBeenCalledOnce();
  });
  it.each(bankProbeIds)('strictly parses the safe %s discriminated profile and report', async probe => {
    const profile = await example(bankProbeIds.indexOf(probe));
    expect(bankProbeProfileSchema.parse(profile).probe).toBe(probe);
    const report = await runBankProbe(profile, options);
    expect(bankProbeReportSchema.parse(report).probe).toBe(probe);
    expect(report.bankVerified).toBe(false);
    expect(report.status).toBe('not_ready');
    expect(probeExitCode(report)).toBe(2);
    expect(bankProbeProfileSchema.safeParse({ ...profile, token: 'secret' }).success).toBe(false);
    expect(bankProbeReportSchema.safeParse({ ...report, privateCookie: 'secret' }).success).toBe(false);
  });
  it('missingBankParametersNeverBecomeReady', async () => {
    const report = await runBankProbe(await example(), options);
    expect(report.missingInputs).toContain('edition');
    expect(report.externalWrites).toBe(0);
    expect(checkBankReadiness([report], ['BP-01']).ready).toBe(false);
  });
  it('testWriteRequiresExplicitApprovalAndDryRunNeverConnects', async () => {
    const readOnly = vi.fn(); const testWrite = vi.fn(); const resolveApproval = vi.fn();
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly, testWrite } }, resolveApproval });
    const dry = await driver(await complete(), options);
    expect(dry.externalWrites).toBe(0);
    expect(readOnly).not.toHaveBeenCalled(); expect(testWrite).not.toHaveBeenCalled(); expect(resolveApproval).not.toHaveBeenCalled();
    const denied = await driver(await complete(), { ...options, mode: 'test-write' });
    expect(denied.status).toBe('failed');
    expect(denied.checks.some(c => c.reason === 'PROBE_WRITE_NOT_APPROVED')).toBe(true);
    expect(testWrite).not.toHaveBeenCalled();
  });
  it('a filled profile without native provider binding remains not_ready', async () => {
    const report = await runBankProbe(await complete(), { ...options, mode: 'read-only' });
    expect(report.status).toBe('not_ready');
    expect(report.missingInputs).toContain('binding.BP-01');
    expect(report.bankVerified).toBe(false);
  });
  it('fakeContractCannotSatisfyRealEvidence', async () => {
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: async () => ({ checks: successChecks('BP-01'), externalWrites: 0, limitations: [] }) } } });
    const report = await driver(await complete(), { ...options, mode: 'read-only' });
    expect(report.contractPassed).toBe(true);
    expect(report.bankVerified).toBe(false);
    expect(report.status).toBe('not_ready');
    const forged = { ...report, status: 'passed' as const, bankVerified: true, missingInputs: [] };
    expect(checkBankReadiness([forged], ['BP-01']).ready).toBe(false);
  });
  it('missingSixReportsStayBlocked and BP IDs never accept P IDs', async () => {
    const report = await runBankProbe(await example(), options);
    const readiness = checkBankReadiness([report], [...bankProbeIds]);
    expect(readiness.blocked.map(b => b.probe)).toEqual(bankProbeIds);
    expect(readiness.blocked.every(b => b.capabilities.length > 0)).toBe(true);
    expect(() => checkBankReadiness([], ['P-02' as BankProbeId])).toThrow();
    expect(bankProbeProfileSchema.safeParse({ ...await example(), probe: 'P-02' }).success).toBe(false);
  });
  it('redactsProbeInputsAndErrors without echoing input or provider errors', async () => {
    const profile = await complete();
    const sentinel = 'very-private-cookie-secret';
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: async () => { throw new Error(`https://private.invalid Authorization: ${sentinel} Cookie: ${sentinel}`); } } } });
    const report = await driver({ ...profile, credentialProfileRef: sentinel }, { ...options, mode: 'read-only' });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(sentinel); expect(serialized).not.toContain('private.invalid'); expect(serialized).not.toContain(profile.origin);
    expect(report.status).toBe('failed'); expect(probeExitCode(report)).toBe(1);
    expect(report.redactedInputHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects extra secrets, mismatched origins and placeholders before calling provider', async () => {
    const readOnly = vi.fn();
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly } } });
    for (const profile of [{ ...await complete(), cookies: 'secret' }, { ...await complete(), origin: 'https://other.invalid/repo' }, { ...await complete(), edition: '<BANK_EDITION>' }]) {
      const report = await driver(profile as BankProbeProfile, { ...options, mode: 'read-only' });
      expect(report.status).toBe('not_ready'); expect(report.bankVerified).toBe(false);
    }
    expect(readOnly).not.toHaveBeenCalled();
  });
  it('requires approval record expiry, exact targets and operations before any write', async () => {
    const testWrite = vi.fn();
    const profile = await complete();
    for (const record of [null, { probe: 'BP-01', expiresAt: '2000-01-01T00:00:00Z', target: 'probe/sandbox', operations: ['test-write'], sandbox: true },
      { probe: 'BP-01', expiresAt: '2999-01-01T00:00:00Z', target: 'another-branch', operations: ['test-write'], sandbox: true },
      { probe: 'BP-01', expiresAt: '2999-01-01T00:00:00Z', target: 'probe/sandbox', operations: [], sandbox: true }]) {
      const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: vi.fn(), testWrite } }, resolveApproval: async () => record as never });
      const report = await driver(profile, { ...options, mode: 'test-write', approvalRef: 'local-approval' });
      expect(report.status).toBe('failed'); expect(report.externalWrites).toBe(0);
    }
    expect(testWrite).not.toHaveBeenCalled();
  });
  it('does not allow main as a sandbox target', async () => {
    const testWrite = vi.fn();
    const profile = await complete();
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: vi.fn(), testWrite, writeOperations: ['native-pr.create'] } }, resolveApproval: async () => ({ probe: 'BP-01', profileId: profile.profileId, repositoryId: profile.repositoryId, origin: profile.origin, expiresAt: '2999-01-01T00:00:00Z', target: 'main', operations: ['native-pr.create'], sandbox: true }) });
    const report = await driver({ ...await complete(), testBranch: 'main' }, { ...options, mode: 'test-write', approvalRef: 'local-approval' });
    expect(report.status).toBe('failed'); expect(testWrite).not.toHaveBeenCalled();
  });
  it('requires every capability and trustworthy evidence even for a completed real mode', async () => {
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: async () => ({ checks: successChecks('BP-01').slice(1), externalWrites: 0, limitations: [] }) } }, verifyEvidence: () => true });
    const report = await driver(await complete(), { ...options, mode: 'read-only' });
    expect(report.bankVerified).toBe(false); expect(report.status).toBe('not_ready');
    expect(report.checks.some(c => c.status === 'not_run')).toBe(true);
  });
  it('trusted composition can verify a complete real result, with report bytes verified again on readiness', async () => {
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: async () => ({ checks: successChecks('BP-01'), externalWrites: 0, limitations: [] }) } }, verifyEvidence: () => true });
    const report = await driver(await complete(), { ...options, mode: 'read-only' });
    expect(report.bankVerified).toBe(true); expect(report.status).toBe('passed'); expect(probeExitCode(report)).toBe(0);
    expect(checkBankReadiness([report], ['BP-01'], { verifyEvidence: () => true }).ready).toBe(true);
    expect(checkBankReadiness([{ ...report, checks: report.checks.slice(1) }], ['BP-01'], { verifyEvidence: () => true }).ready).toBe(false);
  });
  it('read-only provider write claims fail instead of becoming bank evidence', async () => {
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: async () => ({ checks: successChecks('BP-01'), externalWrites: 1, limitations: [] }) } }, verifyEvidence: () => true });
    const report = await driver(await complete(), { ...options, mode: 'read-only' });
    expect(report.status).toBe('failed'); expect(report.bankVerified).toBe(false);
  });
  it('requires exact provider write operations and repository scope even with an approval reference', async () => {
    const profile = await complete(); const testWrite = vi.fn(async () => ({ checks: successChecks('BP-01'), externalWrites: 1, limitations: [] }));
    const approval = { probe: 'BP-01' as const, profileId: profile.profileId, repositoryId: profile.repositoryId, origin: profile.origin, expiresAt: '2999-01-01T00:00:00Z', target: 'probe/sandbox', operations: ['native-pr.create'], sandbox: true };
    for (const record of [{ ...approval, repositoryId: 'other-repository' }, { ...approval, operations: ['test-write'] }]) {
      const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: vi.fn(), testWrite, writeOperations: ['native-pr.create'] } }, resolveApproval: async () => record, verifyEvidence: () => true });
      const report = await driver(profile, { ...options, mode: 'test-write', approvalRef: 'record-id' });
      expect(report.status).toBe('failed');
    }
    expect(testWrite).not.toHaveBeenCalled();
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: vi.fn(), testWrite, writeOperations: ['native-pr.create'] } }, resolveApproval: async () => approval, verifyEvidence: () => true });
    const report = await driver(profile, { ...options, mode: 'test-write', approvalRef: 'record-id' });
    expect(testWrite).toHaveBeenCalledOnce(); expect(report.externalWrites).toBe(1); expect(probeExitCode(report)).toBe(0);
  });
  it('report directories refuse escapes outside the private probe root', async () => {
    await expect(privateProbeReportDirectory('config/probes', false)).rejects.toThrow('PRIVATE_PROBE_REPORT_DIRECTORY_REQUIRED');
    await expect(privateProbeReportDirectory('.runtime/probe-reports/../../escape', false)).rejects.toThrow('PRIVATE_PROBE_REPORT_DIRECTORY_REQUIRED');
  });
  it('all six self-asserted JSON successes remain blocked without trusted evidence verification', async () => {
    const reports = await Promise.all(bankProbeIds.map(async (probe, index) => ({ ...await runBankProbe(await example(index), options), mode: 'read-only' as const, status: 'passed' as const, contractPassed: true, bankVerified: true, missingInputs: [], checks: successChecks(probe) })));
    const result = checkBankReadiness(JSON.parse(JSON.stringify(reports)), [...bankProbeIds]);
    expect(result.ready).toBe(false); expect(result.blocked).toHaveLength(6);
  });
  it('evidence verifier failures and duplicate capability evidence fail closed', async () => {
    const driver = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: async () => ({ checks: successChecks('BP-01'), externalWrites: 0, limitations: [] }) } }, verifyEvidence: () => { throw Error('private secret'); } });
    const report = await driver(await complete(), { ...options, mode: 'read-only' });
    expect(report.bankVerified).toBe(false); expect(report.status).toBe('not_ready');
    const duplicate = createBankProbeDriver({ bindings: { 'BP-01': { readOnly: async () => ({ checks: [...successChecks('BP-01'), successChecks('BP-01')[0]], externalWrites: 0, limitations: [] }) } }, verifyEvidence: () => true });
    expect((await duplicate(await complete(), { ...options, mode: 'read-only' })).bankVerified).toBe(false);
  });
  it('CLI defaults to dry-run and a missing profile stays not_ready rather than failing or connecting', async () => {
    const result = await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/probes/bank-probe.ts', '--probe', 'BP-01', '--report-dir', `.runtime/probe-reports/cli-test-${randomUUID()}`]).then(value => ({ ...value, code: 0 }), error => error as { stdout: string; stderr: string; code: number });
    expect(result.code).toBe(2);
    const report = bankProbeReportSchema.parse(JSON.parse(result.stdout));
    expect(report.mode).toBe('dry-run'); expect(report.status).toBe('not_ready'); expect(report.missingInputs).toContain('profile'); expect(report.externalWrites).toBe(0);
  });
  it('nested placeholders never become bank evidence', async () => {
    const readOnly = vi.fn();
    const report = await createBankProbeDriver({ bindings: { 'BP-01': { readOnly } } })({ ...await complete(), mergeExamples: [{ kind: 'merge', prId: '<PR_ID>', mainCommit: '<COMMIT>' }] }, { ...options, mode: 'read-only' });
    expect(report.missingInputs).toContain('mergeExamples'); expect(readOnly).not.toHaveBeenCalled();
  });
  it('Qlik validates the configured origin while preserving a known report query and fragment', async () => {
    const profile = { ...await example(2), probe: 'BP-03' as const, approvedOrigins: ['https://fixture.invalid'], goalRef: 'goal-1', sourceLocator: 'https://fixture.invalid/report?sheet=one#view', acquisition: 'sberbrowser-recorder' as const, sberBrowserExecutable: 'C:/fixture/browser.exe', authenticationSelector: 'approved-auth', browserScenarioRef: { entityType: 'browser_scenario' as const, id: 'scenario-1', revision: 1 }, managedProfileRef: 'private-profile', contextDescription: 'approved source', expectedRows: 0, expectedKeys: ['id'], expectedDateFields: ['date'], completenessReference: 'private-evidence' };
    const readOnly = vi.fn(async () => ({ checks: successChecks('BP-03'), externalWrites: 0, limitations: [] }));
    const report = await createBankProbeDriver({ bindings: { 'BP-03': { readOnly } } })(profile as BankProbeProfile, { ...options, mode: 'read-only' });
    expect(readOnly).toHaveBeenCalledOnce(); expect(report.contractPassed).toBe(true); expect(report.bankVerified).toBe(false);
  });
});
