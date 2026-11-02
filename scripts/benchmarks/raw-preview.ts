/** Reproducible synthetic HTTP benchmark. Does not touch an existing workspace. */
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createLocalRuntime, codeRoot } from '../../tests/workbench/helpers/runtime';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw Error('Pass an absolute output JSON path');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const source = Object.fromEntries(await Promise.all(['src/features/connectors/workbench-raw-acquisition.ts', 'src/features/tabular-import/workbench-parser.ts'].map(async file => [file, hash(await readFile(path.join(codeRoot, file)))])));
const measurements: unknown[] = [];
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
for (const count of [10_000, 100_000]) {
  const f = await createLocalRuntime();
  try {
    const access = await f.runtime.deps.accessPolicy.resolveOwnAccess();
    const csv = Buffer.from('Row,Team,Value,Date,Status\r\n' + Array.from({ length: count }, (_, i) => `${i},Team ${i % 58},${(i * 17) % 1000},2026-10-30,${i % 7 === 0 ? 'attention' : 'ready'}`).join('\r\n') + '\r\n');
    const before = process.memoryUsage().rss;
    const start = performance.now();
    const upload = await f.runtime.services.files.stage({ installationId: f.runtime.deps.installationId, profilePersonId: access.personId, purpose: 'raw-file', name: `benchmark-${count}.csv`, mediaType: 'text/csv', stream: (async function* () { yield csv; })() });
    const saved = await f.request.command('raw.capture.import', { fileHandle: upload.fileHandle, sourceKind: 'local_file' });
    const acquisitionMs = performance.now() - start;
    const id = saved.result.id;
    await f.restart();
    await f.request.session();
    const coldStart = performance.now();
    const detail = await f.request.query('raw.files.detail', { id });
    const coldDetailMs = performance.now() - coldStart;
    const samples: Record<string, number[]> = { page: [], search: [], sort: [] };
    let peakRss = process.memoryUsage().rss;
    if (detail.parseState === 'parsed') {
      for (let sample = 0; sample < 20; sample++) {
        for (const [name, extra] of Object.entries({ page: {}, search: { search: `Team ${sample % 58}` }, sort: { sortColumn: 'Value', direction: sample % 2 ? 'asc' : 'desc' } })) {
          const at = performance.now();
          const rows = await f.request.query('raw.files.rows', { id, limit: 50, ...extra });
          if (rows.rows.length > 50 || rows.page.total < rows.rows.length) throw Error('Invalid bounded page');
          samples[name].push(performance.now() - at);
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }
      }
    }
    measurements.push({ rows: count, columns: 5, bytes: csv.length, fixtureSha256: hash(csv), acquisitionMs, coldDetailMs, parseState: detail.parseState, issue: detail.issue?.code ?? null,
      rssBefore: before, rssPeak: peakRss, rssAfter: process.memoryUsage().rss,
      timings: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, values.length ? { n: values.length, p50: percentile(values, .5), p95: percentile(values, .95), max: Math.max(...values) } : null])) });
  } finally { await f.close(); }
}
const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, kernel: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemory: os.totalmem(), source,
  conditions: 'One real local HTTP/SQLite runtime; after restart cold parse; 20 sequential warm samples per operation; 50 returned rows. RSS includes harness, app and retained V8 memory. Concurrent engineering jobs may share the host. Synthetic five-column CSV; no banking traffic.', measurements };
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, measurements }));
