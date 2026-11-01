import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { bankProbeIdSchema, bankProbeProfileSchema, bankProbeReportSchema, probeModeSchema, type BankProbeId, type BankProbeProfile, type BankProbeReport, type BankReadinessResult, type ProbeCheck, type ProbeMode } from './bank-probe-contracts';

export const requiredProbeChecks: Record<BankProbeId, readonly string[]> = {
  'BP-01': ['native-pr', 'pr-lifecycle', 'marker-reconciliation', 'merge-evidence', 'merge-time'],
  'BP-02': ['registry-schema', 'hostname-policy', 'readonly-permissions', 'fresh-revocation-gate', 'offline-denied-policy'],
  'BP-03': ['managed-sberbrowser', 'recorder-replay-download', 'source-schema', 'completeness', 'failure-preserves-facts', 'load-profile'],
  'BP-04': ['legacy-inventory', 'counts-and-references', 'original-byte-hashes', 'basis-unknowns', 'idempotent-staging', 'curator-review', 'rescue-apply'],
  'BP-05': ['runtime-versions', 'allowed-roots', 'tls-and-private-areas', 'static-leakage', 'backup-restore-update', 'recovery-faults', 'performance'],
  'BP-06': ['native-auth', 'transport-helper-hooks', 'post-wait-gate', 'revocation-zero-transfer', 'cancel-and-reconcile', 'git-rest-separation'],
};
export type ProbeOptions = { mode: ProbeMode; approvalRef: string | null; reportDirectory: string };
export type ProbeApproval = { probe: BankProbeId; profileId: string; repositoryId: string | null; origin: string | null;
  expiresAt: string; target: string; operations: string[]; sandbox: boolean; existingTestPrIds?: string[] };
export type ProbeBindingResult = { checks: ProbeCheck[]; externalWrites: number; limitations: string[] };
/** Trusted provider must register only IDs returned by successful native-pr.create in this run,
 * and assertWritable immediately before every PR update/decline/cleanup. Never register profile IDs. */
export type ProbeTestPrScope = { readonly runId: string; readonly existingTestPrIds: readonly string[];
  recordCreated(prId: string): void; assertWritable(prId: string): void };
export type ProbeBindingContext = { mode: 'read-only' | 'test-write'; approvedOrigins: readonly string[];
  allowedRoots: readonly string[]; approval: ProbeApproval | null; reportDirectory: string; testPrScope: ProbeTestPrScope | null };
export type BankProbeBindings = { [P in BankProbeId]?: {
  readOnly(profile: Extract<BankProbeProfile, { probe: P }>, context: ProbeBindingContext): Promise<ProbeBindingResult>;
  testWrite?(profile: Extract<BankProbeProfile, { probe: P }>, context: ProbeBindingContext): Promise<ProbeBindingResult>;
  writeOperations?: readonly string[];
} };
/** Trusted composition only: verifies private evidence bytes/provenance, never a profile/CLI assertion. */
export type BankEvidenceVerifier = (report: Readonly<BankProbeReport>) => boolean;
export type BankProbeDependencies = { bindings?: BankProbeBindings; allowedRoots?: readonly string[];
  resolveApproval?: (reference: string) => Promise<ProbeApproval | null>; verifyEvidence?: BankEvidenceVerifier };

const isMissing = (value: unknown): boolean => value === null || value === undefined || (typeof value === 'string' && (!value.trim() || /<|>|placeholder|replace[_ -]?me|example\.com|BANK_/i.test(value))) || (Array.isArray(value) ? !value.length || value.some(isMissing) : Boolean(value && typeof value === 'object' && Object.values(value).some(isMissing)));
const privateText = (value: unknown): boolean => typeof value === 'string' && /(?:authorization|cookie|password|bearer|access[_-]?token)\s*[:=]/i.test(value);
function missingInputs(profile: BankProbeProfile): string[] {
  const required: Record<BankProbeId, string[]> = {
    'BP-01': ['credentialProfileRef', 'approvedOrigins', 'repositoryId', 'origin', 'edition', 'version', 'testBranch', 'existingTestPrId', 'allowedAuthenticationDescription', 'mergeExamples'],
    'BP-02': ['credentialProfileRef', 'approvedOrigins', 'origin', 'repositoryId', 'acceptedBranch', 'registryPath', 'curatorProfileRef', 'chiefProfileRef', 'unknownHostname', 'revokedHostname'],
    'BP-03': ['approvedOrigins', 'goalRef', 'sourceLocator', 'sberBrowserExecutable', 'authenticationSelector', 'browserScenarioRef', 'managedProfileRef', 'contextDescription', 'expectedRows', 'expectedKeys', 'expectedDateFields', 'completenessReference'],
    'BP-04': ['sourceArchivePath', 'attachmentsRoot', 'expectedCounts', 'curatorReviewReference', 'sourceFormatDescription'],
    'BP-05': ['workspaceRoot', 'nodeExecutable', 'npmExecutable', 'gitExecutable', 'testUpdateCommit', 'disposableWorkspaceRoot'],
    'BP-06': ['credentialProfileRef', 'approvedOrigins', 'gitExecutable', 'transport', 'nativeTerminalDescription', 'helperDescription', 'repositoryId', 'origin', 'approvedTestBranch', 'corporateHooksDescription', 'corporateHooksFingerprint'],
  };
  const data = profile as unknown as Record<string, unknown>;
  const missing = required[profile.probe].filter(key => isMissing(data[key]) || privateText(data[key]));
  if (profile.approvedOrigins.some(origin => !validOrigin(origin))) missing.push('approvedOrigins');
  const locator = 'origin' in profile ? profile.origin : profile.probe === 'BP-03' ? profile.sourceLocator : null;
  if (locator && !isMissing(locator)) {
    try {
      const url = new URL(locator);
      if (!['https:', 'ssh:'].includes(url.protocol) || url.password || (url.protocol !== 'ssh:' && url.username) || (profile.probe !== 'BP-03' && (url.search || url.hash)) || !profile.approvedOrigins.includes(url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin)) missing.push('approvedOrigins');
    } catch { missing.push('origin'); }
  }
  return [...new Set(missing)];
}
function validOrigin(value: string): boolean {
  try { const u = new URL(value); return !isMissing(value) && ['https:', 'ssh:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && (u.pathname === '/' || !u.pathname); } catch { return false; }
}
function approvalTarget(profile: BankProbeProfile): string | null {
  switch (profile.probe) {
    case 'BP-01': return profile.testBranch;
    case 'BP-02': return profile.acceptedBranch;
    case 'BP-05': return profile.disposableWorkspaceRoot;
    case 'BP-06': return profile.approvedTestBranch;
    default: return null; // No approved write protocol for source acquisition or legacy apply here.
  }
}
const allowedWriteOperations: Record<BankProbeId, readonly string[]> = {
  'BP-01': ['native-pr.create', 'native-pr.update', 'native-pr.decline', 'test-pr.cleanup', 'test-branch.cleanup'],
  'BP-02': ['test-registry.revoke', 'test-registry.restore'], 'BP-03': [], 'BP-04': [],
  'BP-05': ['disposable-workspace.initialize', 'disposable-workspace.update', 'disposable-workspace.restore', 'disposable-workspace.fault-injection'],
  'BP-06': ['test-branch.push', 'test-branch.cleanup'],
};
function validApproval(approval: ProbeApproval | null, profile: BankProbeProfile, operations: readonly string[] | undefined): approval is ProbeApproval {
  const target = approvalTarget(profile);
  return Boolean(approval && target && !/(^|[\\/])(main|master)([\\/]|$)/i.test(target) && approval.sandbox === true
    && approval.probe === profile.probe && approval.profileId === profile.profileId && approval.target === target
    && approval.repositoryId === ('repositoryId' in profile ? profile.repositoryId : null)
    && approval.origin === ('origin' in profile ? profile.origin : null)
    && Number.isFinite(Date.parse(approval.expiresAt)) && Date.parse(approval.expiresAt) > Date.now()
    && Array.isArray(approval.operations) && operations?.length
    && (profile.probe !== 'BP-01' || !operations.some(operation => ['native-pr.update', 'native-pr.decline', 'test-pr.cleanup'].includes(operation))
      || (Array.isArray(approval.existingTestPrIds) && approval.existingTestPrIds.every(id => typeof id === 'string' && id.trim().length > 0)
        && profile.existingTestPrId !== null && approval.existingTestPrIds.includes(profile.existingTestPrId)))
    && operations.every(operation => allowedWriteOperations[profile.probe].includes(operation) && approval.operations.includes(operation)));
}
function testPrScope(runId: string, approval: ProbeApproval, operations: readonly string[]): ProbeTestPrScope {
  const existingTestPrIds = Object.freeze([...(approval.existingTestPrIds ?? [])]);
  const created = new Set<string>();
  return Object.freeze({ runId, existingTestPrIds,
    recordCreated(prId: string) {
      if (!operations.includes('native-pr.create') || !approval.operations.includes('native-pr.create') || !prId.trim() || existingTestPrIds.includes(prId)) throw new Error('PROBE_PR_CREATION_NOT_APPROVED');
      created.add(prId);
    },
    assertWritable(prId: string) { if (!existingTestPrIds.includes(prId) && !created.has(prId)) throw new Error('PROBE_PR_NOT_APPROVED'); },
  });
}
function inputHash(input: unknown): string {
  // Hash only the redacted shape. Neither report nor digest contains credential values.
  const shape = input && typeof input === 'object' ? Object.keys(input).sort() : ['invalid'];
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}
async function pathsApproved(profile: BankProbeProfile, allowedRoots: readonly string[]): Promise<boolean> {
  const paths = profile.probe === 'BP-04' ? [profile.sourceArchivePath, profile.attachmentsRoot]
    : profile.probe === 'BP-05' ? [profile.workspaceRoot, profile.disposableWorkspaceRoot] : [];
  if (!paths.length) return true;
  if (!allowedRoots.length) return false;
  try {
    const roots = await Promise.all(allowedRoots.map(root => realpath(root)));
    for (const path of paths) {
      if (!path || !isAbsolute(path)) return false;
      const resolved = await realpath(path);
      if (!roots.some(root => { const rel = relative(root, resolved); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); })) return false;
    }
    return true;
  } catch { return false; }
}
function safeChecks(probe: BankProbeId, checks: ProbeCheck[]): ProbeCheck[] {
  return requiredProbeChecks[probe].map(id => {
    const matches = checks.filter(c => c.id === id);
    const check = matches.length === 1 ? matches[0] : undefined;
    if (!check) return { id, status: 'not_run', evidenceRefs: [], reason: 'MISSING_CAPABILITY_EVIDENCE' };
    const refs = Array.isArray(check.evidenceRefs) ? check.evidenceRefs.filter(ref => typeof ref === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(ref)) : [];
    const status = ['passed', 'failed', 'not_run'].includes(check.status) ? check.status : 'failed';
    return { id, status, evidenceRefs: refs, reason: status === 'passed' ? null : 'PROVIDER_CHECK_NOT_PASSED' };
  });
}
function allCapabilities(report: BankProbeReport): boolean {
  return requiredProbeChecks[report.probe].every(id => { const checks = report.checks.filter(c => c.id === id); return checks.length === 1 && checks[0].status === 'passed' && checks[0].evidenceRefs.length > 0; });
}
function trusted(verifier: BankEvidenceVerifier | undefined, report: BankProbeReport): boolean {
  try { return verifier?.(structuredClone(report)) === true; } catch { return false; }
}

export function createBankProbeDriver(deps: BankProbeDependencies = {}) {
  return async (input: BankProbeProfile, options: ProbeOptions): Promise<BankProbeReport> => {
    const startedAt = new Date().toISOString();
    const parsed = bankProbeProfileSchema.safeParse(input);
    const probeResult = bankProbeIdSchema.safeParse(input?.probe);
    if (!probeResult.success) throw new Error('INVALID_BANK_PROBE_ID');
    const mode = probeModeSchema.parse(options.mode);
    const report: BankProbeReport = { schemaVersion: 1, probe: probeResult.data, runId: randomUUID(), profileId: parsed.success ? parsed.data.profileId : 'invalid-profile', mode,
      startedAt, finishedAt: startedAt, status: 'not_ready', environment: { node: process.version, npm: 'not_observed', python: null, os: process.platform, git: null },
      contractPassed: false, bankVerified: false, missingInputs: [], checks: [], externalWrites: 0, limitations: [], redactedInputHash: inputHash(input) };
    const finish = () => { report.finishedAt = new Date().toISOString(); return bankProbeReportSchema.parse(report); };
    if (!parsed.success) { report.missingInputs = ['validProfile']; report.limitations = ['PROFILE_SCHEMA_INVALID']; return finish(); }
    const profile = parsed.data;
    report.missingInputs = missingInputs(profile);
    report.checks = safeChecks(profile.probe, []);
    if (mode === 'dry-run') { report.limitations = ['DRY_RUN_NO_CONNECTIONS', 'BANK_EVIDENCE_NOT_COLLECTED']; return finish(); }
    let approval: ProbeApproval | null = null;
    const binding = deps.bindings?.[profile.probe];
    if (mode === 'test-write') {
      try { approval = options.approvalRef ? await deps.resolveApproval?.(options.approvalRef) ?? null : null; } catch { /* Never echo private approval storage errors. */ }
      if (!validApproval(approval, profile, binding?.writeOperations)) { report.status = 'failed'; report.checks = [{ id: 'approval', status: 'failed', evidenceRefs: [], reason: 'PROBE_WRITE_NOT_APPROVED' }]; return finish(); }
    }
    if (!binding || (mode === 'test-write' && !binding.testWrite)) report.missingInputs.push(`binding.${profile.probe}`);
    if (report.missingInputs.length) return finish();
    if (!await pathsApproved(profile, deps.allowedRoots ?? [])) { report.missingInputs.push('configuredAllowedRoots'); return finish(); }
    try {
      // Dispatch remains discriminated by probe. A reviewed provider supplies this port; no generic fetch fallback.
      const execute = (mode === 'test-write' ? binding!.testWrite : binding!.readOnly)! as (profile: BankProbeProfile, context: ProbeBindingContext) => Promise<ProbeBindingResult>;
      const result = await execute(profile, { mode, approvedOrigins: [...profile.approvedOrigins], allowedRoots: [...deps.allowedRoots ?? []], approval, reportDirectory: options.reportDirectory,
        testPrScope: mode === 'test-write' && profile.probe === 'BP-01' && approval ? testPrScope(report.runId, approval, binding!.writeOperations!) : null });
      report.externalWrites = Number.isSafeInteger(result.externalWrites) && result.externalWrites >= 0 ? result.externalWrites : 0;
      report.checks = safeChecks(profile.probe, result.checks);
      if (result.limitations.length) report.limitations.push('PROVIDER_LIMITATIONS_RECORDED_PRIVATELY');
      if ((mode === 'read-only' && report.externalWrites > 0) || !Number.isSafeInteger(result.externalWrites) || result.externalWrites < 0 || report.checks.some(c => c.status === 'failed')) {
        report.status = 'failed'; report.limitations.push('PROVIDER_CONTRACT_FAILED'); return finish();
      }
      report.contractPassed = allCapabilities(report);
      if (report.contractPassed && trusted(deps.verifyEvidence, report)) { report.bankVerified = true; report.status = 'passed'; }
      else { report.missingInputs.push(report.contractPassed ? 'trustedBankEvidence' : 'capabilityEvidence'); }
    } catch { report.status = 'failed'; report.limitations.push('PROVIDER_EXECUTION_FAILED'); if (mode === 'test-write') report.limitations.push('EXTERNAL_WRITE_OUTCOME_UNKNOWN'); }
    return finish();
  };
}

/** CLI output only: reject arbitrary destinations and reparse points before creating any directories. */
export async function privateProbeReportDirectory(directory: string, create: boolean): Promise<string> {
  const root = resolve('.runtime/probe-reports');
  const target = resolve(directory);
  const within = relative(root, target);
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('PRIVATE_PROBE_REPORT_DIRECTORY_REQUIRED');
  let current = process.cwd();
  for (const part of relative(current, target).split(sep)) {
    if (!part) continue;
    current = resolve(current, part);
    try { const stat = await lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('PRIVATE_PROBE_REPORT_REPARSE_DENIED'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (create) await mkdir(target, { recursive: true });
  return target;
}
export const runBankProbe = createBankProbeDriver();
export function probeExitCode(report: BankProbeReport): 0 | 1 | 2 { return report.status === 'passed' && report.bankVerified && report.mode !== 'dry-run' ? 0 : report.status === 'failed' ? 1 : 2; }

export function checkBankReadiness(reports: BankProbeReport[], required: BankProbeId[], trust: { verifyEvidence?: BankEvidenceVerifier } = {}): BankReadinessResult {
  const ids = [...new Set(required.map(id => bankProbeIdSchema.parse(id)))];
  const blocked: BankReadinessResult['blocked'] = [];
  for (const probe of ids) {
    // A directory may contain older failed runs; only a uniquely latest run can establish current readiness.
    const candidates = reports.filter(report => report.probe === probe).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
    const report = candidates[0];
    const parsed = bankProbeReportSchema.safeParse(report);
    const complete = parsed.success && allCapabilities(parsed.data);
    if (!report || !parsed.success || (candidates[1]?.finishedAt === report.finishedAt) || !complete || report.status !== 'passed' || !report.bankVerified || report.mode === 'dry-run' || !trusted(trust.verifyEvidence, report)) {
      const missing = parsed.success ? requiredProbeChecks[probe].filter(id => !report.checks.some(c => c.id === id && c.status === 'passed' && c.evidenceRefs.length > 0)) : [...requiredProbeChecks[probe]];
      blocked.push({ probe, reason: !report ? 'REPORT_MISSING' : !parsed.success ? 'REPORT_INVALID' : report.status === 'failed' ? 'PROBE_FAILED' : 'BANK_EVIDENCE_UNVERIFIED', capabilities: missing.length ? [...missing] : [...requiredProbeChecks[probe]] });
    }
  }
  return { ready: ids.length > 0 && !blocked.length, required: ids, blocked };
}
