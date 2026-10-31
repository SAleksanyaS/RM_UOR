import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { bankProbeIdSchema, probeModeSchema, type BankProbeProfile } from '../../src/features/system/workbench/bank-probe-contracts';
import { privateProbeReportDirectory, probeExitCode, runBankProbe } from '../../src/features/system/workbench/bank-probe-driver';

// No provider, approval resolver or evidence verifier is installed by this public CLI.
// Actual bindings must be selected by a reviewed provider-specific composition.
async function main(): Promise<number> {
  try {
    const { values } = parseArgs({ options: { probe: { type: 'string' }, profile: { type: 'string' }, mode: { type: 'string', default: 'dry-run' }, 'report-dir': { type: 'string' }, 'approval-ref': { type: 'string' } }, strict: true });
    const probe = bankProbeIdSchema.parse(values.probe);
    const mode = probeModeSchema.parse(values.mode);
    if (!values['report-dir']) throw new Error('ARGUMENT_REQUIRED');
    let input: unknown = { probe };
    let missingProfile = !values.profile;
    if (values.profile) {
      try {
        const stat = await lstat(values.profile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('PROFILE_FILE_INVALID');
        input = JSON.parse(await readFile(values.profile, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        missingProfile = true;
      }
    }
    if (!input || typeof input !== 'object' || (input as { probe?: unknown }).probe !== probe) throw new Error('PROFILE_PROBE_MISMATCH');
    const reportDirectory = await privateProbeReportDirectory(values['report-dir'], true);
    const report = await runBankProbe(input as BankProbeProfile, { mode, approvalRef: values['approval-ref'] ?? null, reportDirectory });
    if (missingProfile) report.missingInputs = ['profile'];
    await writeFile(join(reportDirectory, `${report.probe}-${report.runId}.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return probeExitCode(report);
  } catch {
    // Parse and filesystem errors may contain private values/paths. Never print the exception.
    process.stderr.write('BANK_PROBE_FAILED: invalid arguments, profile, or private report destination.\n');
    return 1;
  }
}
process.exitCode = await main();
