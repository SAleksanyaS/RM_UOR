import { z } from 'zod';

export const bankProbeIds = ['BP-01', 'BP-02', 'BP-03', 'BP-04', 'BP-05', 'BP-06'] as const;
export const bankProbeIdSchema = z.enum(bankProbeIds);
export type BankProbeId = z.infer<typeof bankProbeIdSchema>;
export const probeModeSchema = z.enum(['dry-run', 'read-only', 'test-write']);
export type ProbeMode = z.infer<typeof probeModeSchema>;
const text = z.string().max(4096);
const nullableText = text.nullable();
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const base = {
  schemaVersion: z.literal(1), profileId: slug, environmentLabel: text,
  credentialProfileRef: nullableText, approvedOrigins: z.array(text).max(100), evidenceDirectory: text,
};
export const bitbucketProbeProfileSchema = z.object({ ...base, probe: z.literal('BP-01'),
  repositoryId: nullableText, origin: nullableText, edition: nullableText, version: nullableText,
  testBranch: nullableText, existingTestPrId: nullableText, allowedAuthenticationDescription: nullableText,
  mergeExamples: z.array(z.object({ kind: z.enum(['merge', 'squash', 'fast-forward']), prId: text, mainCommit: text }).strict()),
}).strict();
export const registryProbeProfileSchema = z.object({ ...base, probe: z.literal('BP-02'),
  origin: nullableText, repositoryId: nullableText, acceptedBranch: nullableText, registryPath: nullableText,
  curatorProfileRef: nullableText, chiefProfileRef: nullableText, unknownHostname: nullableText, revokedHostname: nullableText,
}).strict();
export const qlikProbeProfileSchema = z.object({ ...base, probe: z.literal('BP-03'),
  goalRef: nullableText, sourceLocator: nullableText, acquisition: z.literal('sberbrowser-recorder'),
  sberBrowserExecutable: nullableText, authenticationSelector: nullableText,
  browserScenarioRef: z.object({ entityType: z.literal('browser_scenario'), id: text, revision: z.number().int().positive() }).strict().nullable(),
  managedProfileRef: nullableText, contextDescription: nullableText, expectedRows: z.number().int().nonnegative().nullable(),
  expectedKeys: z.array(text), expectedDateFields: z.array(text), completenessReference: nullableText,
}).strict();
export const legacyProbeProfileSchema = z.object({ ...base, probe: z.literal('BP-04'),
  sourceArchivePath: nullableText, attachmentsRoot: nullableText,
  expectedCounts: z.object({ records: z.number().int().nonnegative(), comments: z.number().int().nonnegative(), history: z.number().int().nonnegative(), files: z.number().int().nonnegative() }).strict().nullable(),
  curatorReviewReference: nullableText, sourceFormatDescription: nullableText,
}).strict();
export const runtimeProbeProfileSchema = z.object({ ...base, probe: z.literal('BP-05'),
  workspaceRoot: nullableText, nodeExecutable: nullableText, npmExecutable: nullableText, gitExecutable: nullableText,
  pythonExecutable: nullableText, caProfileRef: nullableText, proxyProfileRef: nullableText,
  testUpdateCommit: nullableText, disposableWorkspaceRoot: nullableText,
}).strict();
export const terminalProbeProfileSchema = z.object({ ...base, probe: z.literal('BP-06'),
  gitExecutable: nullableText, transport: z.enum(['https', 'ssh']).nullable(), nativeTerminalDescription: nullableText,
  helperDescription: nullableText, repositoryId: nullableText, origin: nullableText, approvedTestBranch: nullableText,
  corporateHooksDescription: nullableText, corporateHooksFingerprint: nullableText,
}).strict();
export const bankProbeProfileSchema = z.discriminatedUnion('probe', [bitbucketProbeProfileSchema, registryProbeProfileSchema, qlikProbeProfileSchema, legacyProbeProfileSchema, runtimeProbeProfileSchema, terminalProbeProfileSchema]);
export type BankProbeProfile = z.infer<typeof bankProbeProfileSchema>;
export type BitbucketProbeProfile = z.infer<typeof bitbucketProbeProfileSchema>;
export type RegistryProbeProfile = z.infer<typeof registryProbeProfileSchema>;
export type QlikProbeProfile = z.infer<typeof qlikProbeProfileSchema>;
export type LegacyProbeProfile = z.infer<typeof legacyProbeProfileSchema>;
export type RuntimeProbeProfile = z.infer<typeof runtimeProbeProfileSchema>;
export type TerminalProbeProfile = z.infer<typeof terminalProbeProfileSchema>;

const diagnostic = z.string().regex(/^[A-Za-z0-9_. -]{1,160}$/);
export const probeCheckSchema = z.object({ id: diagnostic, status: z.enum(['passed', 'failed', 'not_run']),
  evidenceRefs: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)), reason: diagnostic.nullable(),
}).strict();
export type ProbeCheck = z.infer<typeof probeCheckSchema>;
const reportBase = {
  schemaVersion: z.literal(1), runId: z.uuid(), profileId: slug, mode: probeModeSchema,
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), status: z.enum(['passed', 'failed', 'not_ready']),
  environment: z.object({ node: text, npm: text, python: nullableText, os: text, git: nullableText }).strict(),
  contractPassed: z.boolean(), bankVerified: z.boolean(), missingInputs: z.array(diagnostic),
  checks: z.array(probeCheckSchema), externalWrites: z.number().int().nonnegative(),
  limitations: z.array(diagnostic), redactedInputHash: z.string().regex(/^[a-f0-9]{64}$/),
};
export const bankProbeReportSchema = z.discriminatedUnion('probe', [
  z.object({ ...reportBase, probe: z.literal('BP-01') }).strict(), z.object({ ...reportBase, probe: z.literal('BP-02') }).strict(),
  z.object({ ...reportBase, probe: z.literal('BP-03') }).strict(), z.object({ ...reportBase, probe: z.literal('BP-04') }).strict(),
  z.object({ ...reportBase, probe: z.literal('BP-05') }).strict(), z.object({ ...reportBase, probe: z.literal('BP-06') }).strict(),
]).superRefine((report, ctx) => {
  if ((report.bankVerified || report.status === 'passed') && (report.mode === 'dry-run' || !report.contractPassed || !report.bankVerified || report.missingInputs.length || !report.checks.length || report.checks.some(c => c.status !== 'passed' || !c.evidenceRefs.length))) {
    ctx.addIssue({ code: 'custom', message: 'INCONSISTENT_VERIFIED_REPORT' });
  }
  if (report.mode !== 'test-write' && report.externalWrites > 0 && report.status !== 'failed') ctx.addIssue({ code: 'custom', message: 'UNEXPECTED_EXTERNAL_WRITES' });
});
export type BankProbeReport = z.infer<typeof bankProbeReportSchema>;
export type BankReadinessResult = { ready: boolean; required: BankProbeId[]; blocked: { probe: BankProbeId; reason: string; capabilities: string[] }[] };
