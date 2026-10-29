import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import { closeOkoLauncherResources, stopOkoLauncher } from './oko-launcher-cleanup';

/** Test owns the entire project, report and browsers. Production imports no fixture. */
export async function createOkoLauncherHarness() {
  const repository = process.cwd(), temp = await realpath(tmpdir()), root = await mkdtemp(path.join(temp, 'uor-oko-launcher-'));
  const logs: string[] = [], telemetry: Array<Record<string, unknown>> = [];
  const downloads: Array<{ period: string | null; scope: string | null }> = [];
  const exportBook = new ExcelJS.Workbook(), exportSheet = exportBook.addWorksheet('Report');
  exportSheet.addRow(['ID', 'Product', 'Value', 'Date']); exportSheet.addRow(['r1', 'p1', '123456789012345.67', '2026-10-28']);
  const exportBytes = Buffer.from(await exportBook.xlsx.writeBuffer());
  const waitFor = async (condition: () => unknown, message: string, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (!condition()) { if (Date.now() >= deadline) throw Error(message + '\n' + logs.join('')); await new Promise(resolve => setTimeout(resolve, 30)); }
  };
  let control: { id: number; action: string } | null = null, serial = 0, acknowledged = 0, authenticated = false;
  const report = createServer(async (request, response) => {
    if (request.url === '/control') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(control)); return; }
    if (request.url?.startsWith('/ack/')) { acknowledged = Number(request.url.slice(5)); control = null; response.end('ok'); return; }
    if (request.url === '/telemetry') { let data = ''; for await (const chunk of request) data += chunk; telemetry.push(JSON.parse(data)); response.end('ok'); return; }
    if (request.url === '/auth') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(authenticated)); return; }
    if (request.url === '/login') { authenticated = true; response.end('ok'); return; }
    if (request.url === '/prepare-export') { setTimeout(() => response.end('ready'), 100); return; }
    if (request.url?.startsWith('/export?')) {
      const query = new URL(request.url, 'http://127.0.0.1').searchParams;
      const filters = { period: query.get('period'), scope: query.get('scope') }; downloads.push(filters);
      if (filters.period !== 'October' || filters.scope !== 'dit') { response.writeHead(422).end('Expected report filters'); return; }
      response.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename=report.xlsx' }).end(exportBytes); return;
    }
    response.setHeader('content-type', 'text/html'); response.end(await readFile(path.join(repository, 'tests/fixtures/workbench/oko-launcher-report.html'), 'utf8'));
  });
  let launcher: ChildProcess | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const stop = () => stopOkoLauncher(launcher);
  const close = async (primaryError?: unknown) => closeOkoLauncherResources({
    saveEvidence: async () => { const directory = path.join(repository, '.runtime/validation/workbench/continuation'); await mkdir(directory, {recursive:true}); await writeFile(path.join(directory, 'oko-launcher-process.log'), logs.join('')); },
    closeBrowser: async () => browser?.close(), stopLauncher: stop,
    closeReport: () => new Promise<void>(resolve => { report.closeAllConnections(); report.close(() => resolve()); }),
    removeProject: async () => {
      assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('uor-oko-launcher-'));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  }, primaryError);
  try {
    await Promise.all([cp(path.join(repository, 'src'), path.join(root, 'src'), { recursive: true }), mkdir(path.join(root, 'scripts')), mkdir(path.join(root, 'config'))]);
    await Promise.all(['package.json', 'tsconfig.json'].map(name => cp(path.join(repository, name), path.join(root, name))));
    await cp(path.join(repository, 'scripts/oko.ts'), path.join(root, 'scripts/oko.ts'));
    await symlink(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const { build } = await import('vite');
    await build({ configFile: path.join(repository, 'vite.config.ts'), logLevel: 'error', build: { outDir: path.join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: path.join(repository, 'oko.html') } } });
    const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = (reserve.address() as {port: number}).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
    await writeFile(path.join(root, 'config/oko.local.json'), JSON.stringify({ port, clientPort: port === 5175 ? 5176 : 5175, autoOpen: false, roleMode: 'local-preview' }));
    await new Promise<void>(resolve => report.listen(0, '127.0.0.1', resolve));
    const reportUrl = `http://127.0.0.1:${(report.address() as {port: number}).port}/report`, url = `http://127.0.0.1:${port}/oko.html`;
    const start = async () => {
      let ready = false;
      launcher = spawn(process.execPath, ['--import', 'tsx', 'scripts/oko.ts', '--serve'], { cwd: root, env: { ...process.env, UOR_NO_OPEN: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      launcher.stdout!.on('data', bytes => { const text = String(bytes); logs.push(text); if (text.includes('ОКО готово:')) ready = true; });
      launcher.stderr!.on('data', bytes => logs.push(String(bytes))); launcher.on('error', error => logs.push(error.message));
      await waitFor(() => ready || launcher!.exitCode !== null, 'Standard launcher did not become ready');
      assert.equal(launcher.exitCode, null, logs.join(''));
    };
    await start(); browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ acceptDownloads: true }); page.setDefaultTimeout(18000);
    return { root, page, url, reportUrl, logs, telemetry, start, stop, close, exportBytes, downloads,
      expire: () => { authenticated = false; },
      reportAction: async (action: 'login' | 'marker' | 'record') => {
        const id = ++serial; control = { id, action }; await waitFor(() => acknowledged === id, `Managed report did not perform ${action}. Telemetry: ${JSON.stringify(telemetry.slice(-8))}`);
      },
      waitReport: async (mode: 'login' | 'picker' | 'recorder', after = 0) => {
        await waitFor(() => telemetry.slice(after).some(item => item.mode === mode), `Managed ${mode} not installed: ${JSON.stringify(telemetry.slice(-8))}`);
      },
      readDownload: async (download: import('playwright').Download) => { const file = await download.path(); assert.ok(file); return readFile(file, 'utf8'); },
      readDownloadBytes: async (download: import('playwright').Download) => { const file = await download.path(); assert.ok(file); return readFile(file); },
    };
  } catch (error) { await close(error); throw error; }
}
