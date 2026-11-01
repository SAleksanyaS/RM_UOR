/** Historical UI only. Fresh synthetic legacy runtime; never a production entry. */
import { access, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { createApp } from '../../src/server/app';
import { privateDevServerDeny } from '../vite-private-files';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.UOR_REFERENCE_OUTPUT ?? path.join(projectRoot, '.runtime/design-reference/evidence');
const runtimeBase = path.join(projectRoot, '.runtime/design-reference/legacy-runtimes');
const chrome = process.env.UOR_TEST_BROWSER_EXECUTABLE;
if (!chrome) throw Error('UOR_TEST_BROWSER_EXECUTABLE must identify an installed browser');
const apiPort = 5812, clientPort = 5813;
await access(chrome);
await mkdir(runtimeBase, { recursive: true });
await mkdir(output, { recursive: true });
const syntheticRoot = await mkdtemp(path.join(runtimeBase, 'legacy-reference-'));
await mkdir(path.join(syntheticRoot, 'catalog'));
await mkdir(path.join(syntheticRoot, 'config'));
await copyFile(path.join(projectRoot, 'catalog/demo.json'), path.join(syntheticRoot, 'catalog/demo.json'));
await copyFile(path.join(projectRoot, 'catalog/demo-snapshots.json'), path.join(syntheticRoot, 'catalog/demo-snapshots.json'));
const demo = JSON.parse(await readFile(path.join(syntheticRoot, 'catalog/demo.json'), 'utf8'));
if (demo.classification !== 'demo') throw new Error('Reference runner accepts only the existing demo catalog');
await writeFile(path.join(syntheticRoot, 'config/site.local.json'), JSON.stringify({ allowedWorkspaceRoots: [syntheticRoot], repositoryUrl: '', publicationMode: 'demo-only', port: apiPort, clientPort, autoOpen: false }));

const api = await createApp({ projectRoot: syntheticRoot, allowedRoots: [syntheticRoot], registry: [], repositoryUrl: '', publicationMode: 'demo-only', startupCheck: false });
const entryPath = '/__legacy_reference_entry.js';
const virtualId = '\0legacy-reference-entry';
const html = '<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Исторический интерфейс РМ УОР · демонстрационные данные</title></head><body><div id="root"></div><script type="module" src="' + entryPath + '"></script></body></html>';
const vite = await createViteServer({
  configFile: false,
  root: projectRoot,
  cacheDir: path.join(syntheticRoot, 'vite-cache'),
  plugins: [react(), {
    name: 'historical-legacy-reference',
    resolveId(id) { if (id === entryPath) return virtualId; },
    load(id) {
      if (id !== virtualId) return;
      return "import React from 'react';import {createRoot} from 'react-dom/client';import {App} from '/src/app/App.tsx';import '@salutejs/sdds-themes/css/sdds_serv_malachite__light.css';import '/src/app/styles.css';import '/src/app/workspace-shell.css';createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));";
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/') return next();
        void server.transformIndexHtml('/', html).then(value => { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(value); }).catch(next);
      });
    },
  }],
  server: { host: '127.0.0.1', port: clientPort, strictPort: true, fs: { strict: true, deny: [...privateDevServerDeny] }, proxy: { '/api': 'http://127.0.0.1:' + apiPort } },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const browserErrors: string[] = [], blockedRequests: string[] = [];
const captures: Array<{ file: string; width: number; height: number; sidebar: string; headings: string[] }> = [];
try {
  await api.listen({ host: '127.0.0.1', port: apiPort });
  await vite.listen();
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU', colorScheme: 'light', reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:' + clientPort || url.protocol === 'data:') return route.continue();
    blockedRequests.push(url.origin + url.pathname);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) browserErrors.push(response.status() + ' ' + response.url()); });
  await page.goto('http://127.0.0.1:' + clientPort + '/', { waitUntil: 'networkidle' });
  await page.locator('.workspace-shell').waitFor();
  await page.getByRole('button', { name: 'Развернуть меню', exact: true }).click();
  await page.locator('.workspace-sidebar.is-expanded').waitFor();
  await page.evaluate(() => document.fonts.ready);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const file = 'legacy-overview-expanded-' + viewport.width + 'x' + viewport.height + '.png';
    await page.screenshot({ path: path.join(output, file), fullPage: false, animations: 'disabled' });
    captures.push({ file, ...viewport, sidebar: 'expanded', headings: await page.locator('h1,h2').allTextContents() });
  }
  const state = await (await page.request.get('http://127.0.0.1:' + clientPort + '/api/state')).json();
  const metadata = { purpose: 'Historical legacy UI layout and brand reference; not production acceptance or a data-equivalent comparison', syntheticRoot, entry: 'src/app/App.tsx', server: 'src/server/app.ts:createApp', fixtures: ['catalog/demo.json', 'catalog/demo-snapshots.json'], role: state.session.role, classification: state.catalog.classification, goals: state.catalog.goals.length, snapshots: state.snapshots.length, captures, browserErrors, blockedRequests };
  await writeFile(path.join(output, 'legacy-reference.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(JSON.stringify(metadata, null, 2));
  if (browserErrors.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
