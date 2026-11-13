import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appVersion, maxSourceBytes, openWorkspace, WorkspaceError } from './workspace.mjs';
import { createBrowserConnector, validateBrowserConfig } from './browser-connector.mjs';
import { BrowserWorkspaceError, openBrowserWorkspace } from './browser-workspace.mjs';
import { BrowserScenarioError, parseBrowserScenario, serializeBrowserScenario } from './browser-scenario.mjs';
import * as nativeGit from './shared-git.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/status-view.js', ['status-view.js', 'text/javascript; charset=utf-8']],
  ['/reconciliation-view.js', ['reconciliation-view.js', 'text/javascript; charset=utf-8']],
  ['/weekly-view.js', ['weekly-view.js', 'text/javascript; charset=utf-8']],
  ['/visualization-view.js', ['visualization-view.js', 'text/javascript; charset=utf-8']],
  ['/browser-view.js', ['browser-view.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/visualization.css', ['visualization.css', 'text/css; charset=utf-8']],
  ['/browser.css', ['browser.css', 'text/css; charset=utf-8']],
  ['/weekly.css', ['weekly.css', 'text/css; charset=utf-8']],
  ['/map-overview.js', ['map-overview.js', 'text/javascript; charset=utf-8']],
  ['/goal-status.js', ['goal-status.js', 'text/javascript; charset=utf-8']],
  ['/dit-settings-view.js', ['dit-settings-view.js', 'text/javascript; charset=utf-8']],
  ['/git-auth-view.js', ['git-auth-view.js', 'text/javascript; charset=utf-8']],
  ['/map-overview.css', ['map-overview.css', 'text/css; charset=utf-8']],
  ['/uor-operations.png', ['uor-operations.png', 'image/png']]
]);

function headers(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function json(response, status, content) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(content));
}

function validateHost(request) {
  const actual = request.socket.localPort;
  const allowed = [`127.0.0.1:${actual}`, `localhost:${actual}`];
  if (!allowed.includes(request.headers.host)) {
    throw new WorkspaceError('Откройте рабочее место по его локальному адресу.', 'HOST', 403);
  }
}

function validateWrite(request) {
  const origin = request.headers.origin;
  if (request.headers['x-rmuor'] !== '1' || (origin && origin !== `http://${request.headers.host}`)) {
    throw new WorkspaceError('Действие доступно в окне рабочего места.', 'ORIGIN', 403);
  }
}

async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new WorkspaceError('Слишком большой запрос.', 'LIMIT', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      request.resume();
      throw new WorkspaceError('Слишком большой запрос.', 'LIMIT', 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new WorkspaceError('Для этого действия нужен запрос JSON.');
  }
  const bytes = await readBody(request, 128 * 1024);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new WorkspaceError('Не удалось прочитать параметры запроса.'); }
}

function attachment(name) {
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

async function route(request, response, workspace, getBrowserWorkspace) {
  headers(response);
  validateHost(request);
  const url = new URL(request.url, 'http://127.0.0.1');
  const method = request.method;
  if (method === 'GET' && url.pathname === '/api/state') return json(response, 200, workspace.getState());
  if (method === 'GET' && url.pathname === '/api/browser') {
    const browser = await getBrowserWorkspace();
    return json(response, 200, browser.getState());
  }
  if (method === 'GET' && url.pathname === '/api/curator-week') {
    const browser = await getBrowserWorkspace();
    return json(response, 200, browser.getCuratorWeek(url.searchParams.get('week')));
  }
  if (method === 'POST') {
    if (url.pathname === '/api/browser/scenario') {
      validateWrite(request);
      const input = await readJson(request);
      return json(response, 200, typeof input?.text === 'string'
        ? parseBrowserScenario(input.text) : { text: serializeBrowserScenario(input?.draft) });
    }
    const action = /^\/api\/browser\/(save|login|close|collect|read|record|record-stop)$/.exec(url.pathname)?.[1];
    if (action) {
      validateWrite(request);
      const input = await readJson(request);
      const browser = await getBrowserWorkspace();
      return json(response, ['save', 'record', 'record-stop'].includes(action) ? 200 : 202, await browser.execute(action, input));
    }
  }
  if (method === 'GET' && url.pathname === '/api/status-register') {
    return json(response, 200, await workspace.statusRegister(url.searchParams.get('source')));
  }
  if (method === 'GET' && url.pathname === '/api/status-week') {
    return json(response, 200, await workspace.statusWeek({
      previousId: url.searchParams.get('previous'),
      currentId: url.searchParams.get('current'),
      period: url.searchParams.get('period'),
      mapOnly: url.searchParams.get('scope') === 'map'
    }));
  }
  if (method === 'GET' && url.pathname === '/api/backup') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': attachment('rm-uor-backup.json')
    });
    return pipeline(workspace.backup(), response);
  }
  if (method === 'GET') {
    const sourceRoute = /^\/api\/source\/([a-f0-9]{64})\/(preview|file)$/.exec(url.pathname);
    if (sourceRoute) {
      const [, id, action] = sourceRoute;
      if (action === 'file') {
        const { source, bytes } = await workspace.readOriginal(id);
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes.length,
          'Content-Disposition': attachment(source.name)
        });
        return response.end(bytes);
      }
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new WorkspaceError('Недопустимый номер строки.');
      return json(response, 200, await workspace.readPreview(id, url.searchParams.get('sheet'), offset));
    }
    const file = staticFiles.get(url.pathname);
    if (file) {
      response.setHeader('Content-Type', file[1]);
      return pipeline(createReadStream(join(root, 'public', file[0])), response);
    }
  }
  if (method === 'POST' && /^\/api\/(?:[a-z]+|dit-status)$/.test(url.pathname)) {
    validateWrite(request);
    const action = url.pathname.slice(5);
    if (action === 'gitcheck') {
      const input = await readJson(request);
      return json(response, 200, { version: await nativeGit.checkGitExecutable({ gitExecutable: input?.gitExecutable }) });
    }
    if (action === 'source') {
      let name;
      try { name = decodeURIComponent(request.headers['x-file-name'] ?? ''); }
      catch { throw new WorkspaceError('Не удалось прочитать имя исходника.'); }
      const bytes = await readBody(request, maxSourceBytes);
      return json(response, 200, await workspace.importSource(name, bytes));
    }
    return json(response, 200, await workspace.execute(action, await readJson(request)));
  }
  return json(response, 404, { error: 'Страница не найдена.', code: 'NOT_FOUND' });
}

function errorStatus(error) {
  if (error instanceof WorkspaceError || error instanceof BrowserWorkspaceError || error instanceof BrowserScenarioError) return error.status;
  if (['CONFLICT', 'GIT_DESTINATION_CHANGED'].includes(error.code)) return 409;
  if (['INVALID_CONFIG', 'INVALID_CREDENTIALS'].includes(error.code)) return 400;
  if (['SHARED_UNAVAILABLE', 'GIT_UNAVAILABLE', 'GIT_AUTH_FAILED', 'INVALID_SHARED_DATA', 'INVALID_PUBLICATION', 'PUBLISH_FAILED'].includes(error.code)) return 502;
  return 500;
}

export async function startServer({
  port = 4179,
  dataDir = join(root, '.local'),
  git,
  background = true,
  browserOptions = {}
} = {}) {
  dataDir = resolve(dataDir);
  const workspace = await openWorkspace({ dataDir, git });
  let browserWorkspace;
  function getBrowserWorkspace() {
    if (!browserWorkspace) {
      const privateRoot = join(dataDir, 'browser');
      const allowHttpLoopback = browserOptions.allowHttpLoopback === true
        && typeof browserOptions.launchPersistentContext === 'function';
      const runtime = createBrowserConnector({ ...browserOptions, privateRoot });
      browserWorkspace = openBrowserWorkspace({
        privateRoot, runtime,
        validateConfig: config => validateBrowserConfig(config, { allowHttpLoopback }),
        importSource: workspace.importSource
      }).catch(error => {
        browserWorkspace = undefined;
        throw error;
      });
    }
    return browserWorkspace;
  }
  const server = createServer((request, response) => {
    void route(request, response, workspace, getBrowserWorkspace).catch(error => {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const status = errorStatus(error);
      const internal = status === 500 && !(error instanceof BrowserWorkspaceError);
      json(response, status, {
        error: internal ? 'Операция не завершилась. Проверьте локальные данные и повторите.' : error.message,
        code: internal ? 'INTERNAL' : error.code
      });
      if (internal) console.error(error);
    });
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.removeListener('error', reject);
      accept();
    });
  });
  server.once('close', () => { void browserWorkspace?.then(browser => browser.shutdown()).catch(() => {}); });
  if (background) {
    let checking = false;
    async function checkShared(force = false) {
      const { profile, shared } = workspace.getState();
      const elapsed = Date.now() - (shared.checkedAt ? Date.parse(shared.checkedAt) : 0);
      if (checking || !profile.remote || profile.gitAuth === 'prompt' || (!force && elapsed < profile.refreshMinutes * 60000)) return;
      checking = true;
      try { await workspace.execute('refresh'); }
      catch { /* Ошибка проверки видна в разделе истории. */ }
      finally { checking = false; }
    }
    const timer = setInterval(() => { void checkShared(); }, 10000);
    timer.unref();
    server.once('close', () => clearInterval(timer));
    void checkShared(true);
  }
  return { server, workspace, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.RM_UOR_PORT ?? 4179);
  const dataDir = process.env.RM_UOR_DATA_DIR ? resolve(process.env.RM_UOR_DATA_DIR) : undefined;
  try {
    const { server, url } = await startServer({ port, dataDir });
    console.log(`Рабочее место УОР ${appVersion} — ${url}`);
    process.once('SIGINT', () => server.close());
    process.once('SIGTERM', () => server.close());
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? 'Рабочее место уже запущено на этом порту.' : error.message);
    process.exitCode = 1;
  }
}
