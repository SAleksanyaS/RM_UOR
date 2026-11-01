import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Download } from 'playwright';
import { createServer } from 'vite';
import { createLocalRuntime, codeRoot } from './runtime';
import type { WorkbenchRuntimeProviders } from '../../../src/server/workbench/runtime-contracts';

export async function chromeExecutable() {
  const executable = process.env.UOR_TEST_BROWSER_EXECUTABLE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  await access(executable).catch(() => { throw Error('ENVIRONMENT_NOT_VERIFIED: installed Google Chrome unavailable: ' + executable); });
  return executable;
}
export async function downloadedBytes(download: Download) {
  const stream = await download.createReadStream(); if (!stream) throw Error('Actual browser download missing');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}
/** Actual production entry modules and Vite rules; only external ports may be injected. */
export async function createLocalBrowserRun(providers: WorkbenchRuntimeProviders = {}) {
  const executablePath = await chromeExecutable(), local = await createLocalRuntime(providers);
  const artifactRoot = path.join(codeRoot, '.runtime/validation/workbench/continuation/t40-browser'); await mkdir(artifactRoot, { recursive: true });
  let host: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let closed = false;
  async function close() { if (closed) return; closed = true; await browser?.close(); await host?.close(); await local.close(); }
  try {
    host = await createServer({ configFile: path.join(codeRoot, 'vite.config.ts'), root: codeRoot, cacheDir: path.join(local.root, '.runtime/vite-cache'), server: { host: '127.0.0.1', port: local.ui, strictPort: true, proxy: { '/api': local.origin } } });
    await host.listen();
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, acceptDownloads: true });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(String(error)));
    return { ...local, get runtime() { return local.runtime; }, get app() { return local.app; }, origin: 'http://127.0.0.1:' + local.ui, page, browser, context, errors, artifact: (name: string) => path.join(artifactRoot, name), close };
  } catch (error) { await close(); throw error; }
}
