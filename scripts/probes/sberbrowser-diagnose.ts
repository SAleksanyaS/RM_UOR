import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { describeLaunchFailure, inspectBrowserEnvironment, safeErrorDetail } from '../../src/features/connectors/workbench-browser-diagnostics';

/** Exit code is reported after stdout flushes so a pipe never truncates the report. */
function finish(code: number): void {
  process.stdout.write('', () => { process.exitCode = code; });
}

/**
 * Read-only doctor for the personal OKO browser: reports the host environment and
 * tries the same launch options the application uses (Chromium sandbox always on).
 * Nothing is written to .runtime and the real profile is never touched.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    executable: { type: 'string' }, channel: { type: 'string' }, headed: { type: 'boolean', default: false },
    'keep-open-ms': { type: 'string', default: '0' }, url: { type: 'string' },
  }, strict: true });
  if (!values.executable && !values.channel) throw new Error('EXECUTABLE_OR_CHANNEL_REQUIRED');
  const keepOpen = Number(values['keep-open-ms'] ?? '0');
  if (!Number.isSafeInteger(keepOpen) || keepOpen < 0) throw new Error('INVALID_KEEP_OPEN');
  const browser = { ...(values.executable ? { executablePath: values.executable } : {}), ...(values.channel ? { channel: values.channel } : {}), profileDirectory: 'doctor', headless: false } as const;
  const environment = await inspectBrowserEnvironment(browser);
  process.stdout.write(`${JSON.stringify({ stage: 'environment', ...environment }, null, 2)}\n`);
  const folder = await mkdtemp(join(tmpdir(), 'uor-sberbrowser-doctor-'));
  try {
    const { chromium } = await import('playwright');
    const context = await chromium.launchPersistentContext(folder, {
      executablePath: values.executable, channel: values.channel, headless: !values.headed,
      chromiumSandbox: true, serviceWorkers: 'block', acceptDownloads: true, ignoreHTTPSErrors: false,
    });
    try {
      const page = context.pages()[0] ?? await context.newPage();
      const url = values.url ?? 'about:blank';
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error: safeErrorDetail(error) }));
      const navigation = response.ok
        ? { ok: true, status: typeof response.value?.status === 'function' ? response.value.status() : null }
        : { ok: false, error: response.error };
      process.stdout.write(`${JSON.stringify({ stage: 'launch', ok: true, headless: !values.headed, url, version: context.browser()?.version() ?? null, navigation }, null, 2)}\n`);
      if (values.headed && keepOpen > 0) { process.stdout.write(`Окно открыто. Закрытие через ${keepOpen} мс или по закрытию окна вручную…\n`); await new Promise<void>(resolve => { const timer = setTimeout(resolve, keepOpen); context.once('close', () => { clearTimeout(timer); resolve(); }); }); }
    } finally { await context.close().catch(() => {}); }
    return 0;
  } catch (error) {
    const diagnosis = describeLaunchFailure(error, environment);
    process.stdout.write(`${JSON.stringify({ stage: 'launch', ok: false, headless: !values.headed, reason: diagnosis.reason, detail: diagnosis.detail, environment }, null, 2)}\n`);
    return 2;
  } finally { await rm(folder, { recursive: true, force: true }).catch(() => {}); }
}

main().then(finish, error => {
  process.stderr.write(`SBERRBROWSER_PROBE_FAILED: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  finish(1);
});
