import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { bankProbeIds, bankProbeIdSchema, bankProbeReportSchema, type BankProbeReport } from '../../src/features/system/workbench/bank-probe-contracts';
import { checkBankReadiness, privateProbeReportDirectory } from '../../src/features/system/workbench/bank-probe-driver';

async function readReports(directory: string): Promise<BankProbeReport[]> {
  const reports: BankProbeReport[] = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reports; throw error; }
  for (const entry of entries) {
    const file = join(directory, entry.name);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error('REPORT_REPARSE_DENIED');
    if (stat.isDirectory()) reports.push(...await readReports(file));
    else if (stat.isFile() && entry.name.endsWith('.json')) {
      if (stat.size > 1024 * 1024) throw new Error('REPORT_TOO_LARGE');
      reports.push(bankProbeReportSchema.parse(JSON.parse(await readFile(file, 'utf8'))));
    }
  }
  return reports;
}
async function main(): Promise<number> {
  try {
    const { values } = parseArgs({ options: { reports: { type: 'string' }, require: { type: 'string', default: bankProbeIds.join(',') } }, strict: true });
    if (!values.reports) throw new Error('REPORTS_REQUIRED');
    const requested = (values.require ?? '').split(',').map(id => bankProbeIdSchema.parse(id));
    // Public readiness cannot narrow release readiness by omitting one of the six required probes.
    if (requested.length !== bankProbeIds.length || bankProbeIds.some(id => !requested.includes(id))) throw new Error('ALL_SIX_BANK_REPORTS_REQUIRED');
    const directory = await privateProbeReportDirectory(values.reports, false);
    // JSON claims are untrusted. A reviewed production composition must verify actual private evidence.
    const result = checkBankReadiness(await readReports(directory), requested);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ready ? 0 : 2;
  } catch {
    process.stderr.write('BANK_READINESS_FAILED: invalid arguments, report schema, or private report source.\n');
    return 1;
  }
}
process.exitCode = await main();
