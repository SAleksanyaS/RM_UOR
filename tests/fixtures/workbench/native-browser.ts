import { access, mkdtemp, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createBrowserRuntime, type BrowserOwner } from '../../../src/features/connectors/workbench-browser-runtime';
import type { BrowserLaunchOptions } from '../../../src/features/connectors/browser';
import { privateProfileSchema } from '../../../src/features/connectors/contracts';
import { fixtureId } from './factories';
import { startBrowserReportFixture } from './browser-report';

export async function installedBrowserExecutable(): Promise<string> {
  const explicit = process.env.UOR_TEST_BROWSER_EXECUTABLE;
  const candidates = explicit ? [explicit] : ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* No installation or download fallback. */ } }
  throw Error('NATIVE_BROWSER_NOT_READY: set UOR_TEST_BROWSER_EXECUTABLE or install Microsoft Edge explicitly');
}
/** Real installed Chromium, preserving the production launcher options and owner queues. */
export async function createNativeBrowserFixture(existingReport?: Awaited<ReturnType<typeof startBrowserReportFixture>>) {
  const executablePath = await installedBrowserExecutable();
  const report = existingReport ?? await startBrowserReportFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), 'uor-t47-native-'));
  const contexts = new Set<BrowserContext>(), options: BrowserLaunchOptions[] = [];
  let latest: BrowserContext | undefined, closed = false;
  const owners = new Map<string, BrowserOwner>();
  const history: BrowserContext[] = [], launchWaiters: Array<{ after: number; resolve(context: BrowserContext): void }> = [];
  const runtime = createBrowserRuntime({ runtimeRoot: root, launcher: { async launchPersistent(_profile, folder, launchOptions) {
    assert.equal(launchOptions.chromiumSandbox, true);
    // The fixture controls the real native page. Login intentionally requests a
    // visible window in production; this automated driver runs without a display.
    const context = await chromium.launchPersistentContext(folder, { ...launchOptions, headless: true });
    contexts.add(context); latest = context; options.push(launchOptions); history.push(context); for (const waiter of launchWaiters.splice(0)) waiter.resolve(context); context.once('close', () => contexts.delete(context)); return context;
  } } });
  const owner = { installationId: fixtureId(950001), profilePersonId: fixtureId(17) };
  owners.set(owner.installationId, owner);
  const profile = privateProfileSchema.parse({ allowedOrigins: [report.origin], timeoutMs: 10000, browser: { executablePath, profileDirectory: 'synthetic-own', headless: true } });
  const input = { owner, profile, startUrl: report.origin + '/report', authenticatedSelector: '[data-testid="report-ready"]' };
  const page = (): Page => { const value = latest?.pages()[0]; if (!value) throw Error('No owned native page'); return value; };
  return { root, report, runtime, owner, profile, input, executablePath, page,
    launchCount: () => history.length, waitForLaunch(after: number): Promise<BrowserContext> { if (history.length > after) return Promise.resolve(history[after]); return new Promise(resolve => launchWaiters.push({ after, resolve })); },
    openContexts: () => contexts.size, launchOptions: () => [...options],
    async closeContexts() { await Promise.all([...contexts].map(context => context.close())); },
    async login() { await page().getByLabel('Пароль стенда').fill('synthetic-password'); await page().getByRole('button', { name: 'Войти в тестовый отчёт' }).click(); await page().locator(input.authenticatedSelector).waitFor(); },
    async close() {
      if (closed) return; closed = true;
      for (const own of owners.values()) await runtime.closeOwned(own);
      await Promise.all([...contexts].map(context => context.close())); await report.close();
      const resolved = path.resolve(root), allowed = path.resolve(os.tmpdir());
      if (!resolved.startsWith(allowed + path.sep) || !path.basename(resolved).startsWith('uor-t47-native-')) throw Error('Invalid T47 cleanup root');
      await rm(resolved, { recursive: true, force: true });
    },
  };
}
