import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createBrowserConnector, validateBrowserConfig } from '../src/browser-connector.mjs';

const config = {
  id: 'report-1', url: 'https://reports.example.test/current', allowedOrigins: ['https://sso.example.test'],
};

function workbookFixture() {
  const parts = {
    'xl/workbook.xml': '<workbook><sheets><sheet name="Report" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/report.xml" Type="http://test/worksheet"/></Relationships>',
    'xl/worksheets/report.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>',
  };
  const chunks = [];
  const directory = [];
  let offset = 0;
  let size = 0;
  for (const [path, xml] of Object.entries(parts)) {
    const name = Buffer.from(path);
    const data = Buffer.from(xml);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    offset += local.length + name.length + data.length;
    size += central.length + name.length;
    chunks.push(local, name, data);
    directory.push(central, name);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...directory, end]);
}

async function fixtureRoot(t) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, 'rm-uor-browser-'));
  t.after(async () => {
    const path = await realpath(root);
    assert.equal(dirname(path), parent);
    assert.ok(basename(path).startsWith('rm-uor-browser-'));
    await rm(path, { recursive: true, force: true });
  });
  return root;
}

function fakeRuntime({ downloadUrl, credentialField = false, oversize = false, reportResult } = {}) {
  const launches = [];
  async function launchPersistentContext(profile, options) {
    const context = new EventEmitter();
    const page = new EventEmitter();
    const session = new EventEmitter();
    const messages = [];
    const steps = [];
    let currentUrl = 'about:blank';
    session.send = async (name, params) => {
      messages.push([name, params]);
      if (name === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (name === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
      if (name === 'Page.createIsolatedWorld') {
        session.emit('Runtime.executionContextCreated', {
          context: { id: 1, name: params.worldName, auxData: { frameId: 'main' } },
        });
        return { executionContextId: 1 };
      }
      if (name === 'Runtime.evaluate') return { result: { value: 'ready' } };
    };
    page.goto = async url => { currentUrl = url; };
    page.url = () => currentUrl;
    page.close = async () => {};
    page.locator = selector => ({
      async click() {
        steps.push(['click', selector]);
        if (selector !== '#download') return;
        const bytes = workbookFixture();
        const path = join(options.downloadsPath, 'browser-generated-id');
        await writeFile(path, bytes);
        const url = downloadUrl ?? 'https://reports.example.test/generated';
        session.emit('Browser.downloadWillBegin', { guid: 'browser-generated-id', url, suggestedFilename: 'report.xlsx' });
        if (oversize) session.emit('Browser.downloadProgress', { guid: 'browser-generated-id', totalBytes: 31_000_000, receivedBytes: 0 });
        page.emit('download', {
          suggestedFilename: () => 'report.xlsx', url: () => url, path: async () => path, cancel: async () => {},
        });
      },
      async waitFor() { steps.push(['wait', selector]); },
      async isVisible() { return true; },
      async evaluate() { return reportResult; },
      async elementHandle() {
        return {
          async evaluate() { return !credentialField; },
          async fill(value) { steps.push(['fill', selector, value]); },
          async dispose() {},
        };
      },
    });
    context.pages = () => [page];
    context.route = async (pattern, handler) => { context.routeHandler = handler; };
    context.routeWebSocket = async (pattern, handler) => { context.socketHandler = handler; };
    context.newCDPSession = async () => session;
    context.close = async () => { context.emit('close'); };
    launches.push({ profile, options, context, page, session, messages, steps });
    return context;
  }
  return { launches, launchPersistentContext };
}

test('validates canonical exact origins, a local browser executable, and non-secret replay configuration', () => {
  const checked = validateBrowserConfig(config);
  assert.deepEqual(checked.allowedOrigins, ['https://reports.example.test', 'https://sso.example.test']);
  assert.throws(() => validateBrowserConfig({ ...config, url: 'http://127.0.0.1:3000/report' }), /HTTPS/iu);
  assert.throws(() => validateBrowserConfig({ ...config, allowedOrigins: ['https://sso.example.test/'] }), /origin|адрес/iu);
  assert.throws(() => validateBrowserConfig({ ...config, url: 'https://reports.example.test/?access_token=secret' }), /секрет/iu);
  assert.throws(() => validateBrowserConfig({ ...config, executablePath: 'chrome.exe' }), /абсолютн/iu);
  assert.throws(() => validateBrowserConfig({ ...config, actions: [{ type: 'fill', selector: '#password', value: '123' }] }), /секрет|вход/iu);
});

test('owns a private profile and guards network requests, redirects and WebSockets', async t => {
  const privateRoot = await fixtureRoot(t);
  const runtime = fakeRuntime();
  const connector = createBrowserConnector({ privateRoot, launchPersistentContext: runtime.launchPersistentContext });
  assert.deepEqual(await connector.login(config), { open: true });
  assert.equal(connector.isOpen(config.id), true);
  await assert.rejects(connector.login(config), { code: 'BROWSER_BUSY' });
  const second = createBrowserConnector({ privateRoot, launchPersistentContext: runtime.launchPersistentContext });
  await assert.rejects(second.login(config), { code: 'BROWSER_BUSY' });
  const { context, page, options, messages, session } = runtime.launches[0];
  assert.equal(options.headless, false);
  assert.equal(options.chromiumSandbox, true);
  assert.equal(options.ignoreHTTPSErrors, false);
  assert.equal(options.serviceWorkers, 'block');
  const route = async (url, parent = null) => {
    let decision;
    await context.routeHandler({
      request: () => ({ url: () => url, frame: () => ({ page: () => page, parentFrame: () => parent }) }),
      continue: async () => { decision = 'allow'; },
      abort: async () => { decision = 'block'; },
    });
    return decision;
  };
  assert.equal(await route('https://sso.example.test/login?code=temporary'), 'allow');
  assert.equal(await route('https://reports.example.test.evil.invalid/'), 'block');
  assert.equal(await route('https://reports.example.test/iframe', {}), 'block');
  const socketDecisions = [];
  for (const url of ['wss://reports.example.test/ws', 'wss://evil.invalid/ws']) {
    await context.socketHandler({
      url: () => url, connectToServer: () => socketDecisions.push('allow'), close: () => socketDecisions.push('block'),
    });
  }
  assert.deepEqual(socketDecisions, ['allow', 'block']);
  session.emit('Fetch.requestPaused', { requestId: 'redirect', request: { url: config.url },
    responseStatusCode: 302, responseHeaders: [{ name: 'Location', value: 'https://evil.invalid/data' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.some(([name, params]) => name === 'Fetch.failRequest' && params.requestId === 'redirect'));
  assert.deepEqual(await connector.close(config.id), { open: false });
  assert.equal(connector.isOpen(config.id), false);
  await second.login(config);
  assert.equal(runtime.launches[1].profile, runtime.launches[0].profile);
  await second.close(config);
});

test('collects a local XLSX, rejects off-origin and oversized downloads, and never fills login fields', async t => {
  const privateRoot = await fixtureRoot(t);
  const collectConfig = {
    ...config, actions: [{ type: 'wait', selector: '#filter' }, { type: 'fill', selector: '#filter', value: 'DIT' }],
    downloadSelector: '#download',
  };
  const success = fakeRuntime();
  const connector = createBrowserConnector({ privateRoot, launchPersistentContext: success.launchPersistentContext });
  const result = await connector.collect(collectConfig);
  assert.equal(result.filename, 'report.xlsx');
  assert.deepEqual(result.bytes, workbookFixture());
  assert.deepEqual(success.launches[0].steps, [['wait', '#filter'], ['fill', '#filter', 'DIT'], ['click', '#download']]);
  await assert.rejects(readFile(join(success.launches[0].options.downloadsPath, 'browser-generated-id')), { code: 'ENOENT' });
  assert.equal(connector.isOpen(config.id), false);

  const offOrigin = fakeRuntime({ downloadUrl: 'https://evil.invalid/report.xlsx' });
  const blocked = createBrowserConnector({ privateRoot, launchPersistentContext: offOrigin.launchPersistentContext });
  await assert.rejects(blocked.collect(collectConfig), { code: 'BROWSER_DOWNLOAD_ORIGIN' });
  const overLimit = fakeRuntime({ oversize: true });
  const capped = createBrowserConnector({ privateRoot, launchPersistentContext: overLimit.launchPersistentContext });
  await assert.rejects(capped.collect(collectConfig), { code: 'BROWSER_DOWNLOAD_TOO_LARGE' });
  const credential = fakeRuntime({ credentialField: true });
  const prevented = createBrowserConnector({ privateRoot, launchPersistentContext: credential.launchPersistentContext });
  await assert.rejects(prevented.collect(collectConfig), { code: 'BROWSER_INPUT_FORBIDDEN' });
  assert.deepEqual(credential.launches[0].steps, [['wait', '#filter']]);
});

test('refuses an obstructed private profile directory', async t => {
  const root = await fixtureRoot(t);
  await mkdir(join(root, 'nested'));
  const privateRoot = join(root, 'nested', 'not-a-directory');
  await writeFile(privateRoot, 'private');
  const runtime = fakeRuntime();
  const connector = createBrowserConnector({ privateRoot, launchPersistentContext: runtime.launchPersistentContext });
  await assert.rejects(connector.login(config), { code: 'BROWSER_PRIVATE_DIRECTORY' });
  assert.equal(runtime.launches.length, 0);
});

test('reads only a configured report and supports cancellation', async t => {
  const privateRoot = await fixtureRoot(t);
  const result = { title: 'Недельный отчёт', text: 'Готово: сверка\nПланы: проверка' };
  const runtime = fakeRuntime({ reportResult: result });
  const connector = createBrowserConnector({ privateRoot, launchPersistentContext: runtime.launchPersistentContext });
  await assert.rejects(connector.read(config), { code: 'BROWSER_CONFIG' });
  await assert.rejects(connector.read({ ...config, readySelector: '#ready', reportSelector: 'body' }), { code: 'BROWSER_CONFIG' });
  assert.deepEqual(await connector.read({ ...config, readySelector: '#ready', reportSelector: '#report' }), result);
  assert.deepEqual(runtime.launches[0].steps, [['wait', '#ready'], ['wait', '#report']]);
  assert.equal(connector.isOpen(config.id), false);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(connector.login(config, { signal: controller.signal }), { code: 'BROWSER_CANCELLED' });
  assert.equal(runtime.launches.length, 1);
  const collecting = connector.collect(config);
  collecting.catch(() => {});
  await connector.close(config);
  await assert.rejects(collecting, { code: 'BROWSER_CANCELLED' });
  assert.equal(connector.isOpen(config.id), false);
});

test('reuses an idle sign-in tab for read or XLSX with unchanged origin settings', async t => {
  const privateRoot = await fixtureRoot(t);
  const result = { title: 'Report', text: 'Ready' };
  const runtime = fakeRuntime({ reportResult: result });
  const connector = createBrowserConnector({ privateRoot, launchPersistentContext: runtime.launchPersistentContext });
  const settings = { ...config, readySelector: '#ready', reportSelector: '#report' };
  await connector.login(settings);
  const login = runtime.launches[0];
  await login.page.goto('https://sso.example.test/sign-in');
  await assert.rejects(connector.read(settings), { code: 'BROWSER_LOGIN_REQUIRED' });
  assert.equal(connector.isOpen(settings.id), true);
  await assert.rejects(connector.read({ ...settings, allowedOrigins: [] }), { code: 'BROWSER_BUSY' });
  await login.page.goto('https://reports.example.test/current#session-ready');
  assert.deepEqual(await connector.read(settings), result);
  assert.equal(runtime.launches.length, 1);
  assert.equal(login.page.url(), 'https://reports.example.test/current#session-ready');
  assert.equal(connector.isOpen(settings.id), false);

  await connector.login(settings);
  const output = await connector.collect({ ...settings, downloadSelector: '#download' });
  assert.deepEqual(output.bytes, workbookFixture());
  assert.equal(runtime.launches.length, 2);
  const modes = runtime.launches[1].messages
    .filter(([name]) => name === 'Browser.setDownloadBehavior').map(([, fields]) => fields.behavior);
  assert.deepEqual(modes, ['deny', 'allowAndName']);
  assert.equal(connector.isOpen(settings.id), false);
});

test('records only the dedicated report world and retains the login tab after stopping', async t => {
  const privateRoot = await fixtureRoot(t);
  const runtime = fakeRuntime();
  const connector = createBrowserConnector({ privateRoot, launchPersistentContext: runtime.launchPersistentContext });
  await assert.rejects(connector.startRecording(config), { code: 'BROWSER_LOGIN_REQUIRED' });
  await connector.login(config);
  assert.deepEqual(await connector.startRecording(config), { recording: true });
  assert.equal(connector.isRecording(config.id), true);
  await assert.rejects(connector.collect(config), { code: 'BROWSER_BUSY' });
  const { session, messages } = runtime.launches[0];
  const name = messages.find(([method]) => method === 'Runtime.addBinding')[1].name;
  const send = (executionContextId, selector, download) => session.emit('Runtime.bindingCalled', {
    name, executionContextId, payload: JSON.stringify({ selector, download }),
  });
  send(999, '#ignored', false);
  send(1, '#login', false);
  send(1, '#filter', false);
  send(1, '[data-testid="export"]', true);
  send(1, '#after', false);
  assert.deepEqual(await connector.stopRecording(config.id), {
    actions: [{ type: 'click', selector: '#filter' }], downloadSelector: '[data-testid="export"]',
  });
  assert.equal(connector.isRecording(config.id), false);
  assert.equal(connector.isOpen(config.id), true);
  assert.ok(messages.some(([method]) => method === 'Runtime.removeBinding'));
  assert.ok(messages.some(([method]) => method === 'Page.removeScriptToEvaluateOnNewDocument'));
  await connector.close(config);
});

test('does not return a partial script after excess steps or navigation away from the report origin', async t => {
  const privateRoot = await fixtureRoot(t);
  const runtime = fakeRuntime();
  const connector = createBrowserConnector({ privateRoot, launchPersistentContext: runtime.launchPersistentContext });
  await connector.login(config);
  const { session, messages } = runtime.launches[0];
  await connector.startRecording(config);
  const binding = () => messages.filter(([method]) => method === 'Runtime.addBinding').at(-1)[1].name;
  for (let index = 0; index < 13; index++) {
    session.emit('Runtime.bindingCalled', {
      name: binding(), executionContextId: 1,
      payload: JSON.stringify({ selector: '#step-' + index, download: false }),
    });
  }
  await assert.rejects(connector.stopRecording(config), { code: 'BROWSER_RECORD_LIMIT' });
  assert.equal(connector.isRecording(config.id), false);
  await connector.startRecording(config);
  session.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://sso.example.test/sign-in' } });
  await assert.rejects(connector.stopRecording(config), { code: 'BROWSER_RECORD_ORIGIN' });
  assert.equal(connector.isOpen(config.id), true);
  await connector.close(config);
});

async function loopbackFixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return 'http://127.0.0.1:' + server.address().port;
}

const realBrowserTest = process.env.RM_UOR_REAL_BROWSER_TEST === '1';
test('Playwright local fixture keeps a session-only login in the same read or export tab', {
  skip: !realBrowserTest,
}, async t => {
  const require = createRequire(import.meta.url);
  const modulePath = require.resolve(process.env.RM_UOR_PLAYWRIGHT);
  const runtime = await import(pathToFileURL(modulePath).href);
  const chromium = runtime.chromium ?? runtime.default.chromium;
  let outsideRequests = 0;
  let launches = 0;
  let openContext;
  let connector;
  let settings;
  t.after(async () => { if (connector && settings) await connector.close(settings); });
  const outside = await loopbackFixture(t, (request, response) => {
    outsideRequests++;
    response.end('unexpected');
  });
  const source = await loopbackFixture(t, (request, response) => {
    if (request.url === '/login') {
      response.writeHead(302, { location: '/', 'set-cookie': 'fixture=verified; SameSite=Strict; Path=/' }).end();
    } else if (!request.headers.cookie?.includes('fixture=verified')) {
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
      response.end('<!doctype html><title>Вход</title><a id="sign-in" href="/login">Войти</a>');
    } else if (request.url === '/redirect') {
      response.writeHead(302, { location: outside + '/blocked' }).end();
    } else if (request.url === '/xlsx') {
      const bytes = workbookFixture();
      response.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="report.xlsx"',
        'content-length': bytes.length,
      }).end(bytes);
    } else {
      response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
      response.end('<!doctype html><title>Отчёт</title><p id="ready">Готово</p><section id="summary">Строка отчёта</section>' +
        '<button id="ignored">Программный клик</button><a id="report-step" href="/details">Детали</a>' +
        '<form id="sign-in-flow"><button type="button" id="form-continue">Продолжить</button></form>' +
        '<a id="explicit-export" download href="/xlsx">Выгрузить</a>' +
        '<a id="export" href="/xlsx">Скачать</a><script>fetch("/redirect").catch(() => { document.querySelector("#ready").id="redirect-blocked"; });</script>');
    }
  });
  const privateRoot = await fixtureRoot(t);
  connector = createBrowserConnector({
    privateRoot, allowHttpLoopback: true, browserExecutablePath: process.env.RM_UOR_BROWSER,
    async launchPersistentContext(profile, options) {
      launches++;
      openContext = await chromium.launchPersistentContext(profile, { ...options, headless: true });
      return openContext;
    },
  });
  settings = { id: 'fixture', url: source + '/', readySelector: '#redirect-blocked', reportSelector: '#summary' };
  async function manualLogin() {
    assert.deepEqual(await connector.login(settings), { open: true });
    const tab = openContext.pages()[0];
    await tab.locator('#sign-in').click();
    await tab.locator('#redirect-blocked').waitFor({ state: 'visible' });
  }
  await manualLogin();
  await connector.startRecording(settings);
  const tab = openContext.pages()[0];
  await tab.locator('#ignored').evaluate(element => element.click());
  await tab.locator('#form-continue').click();
  await tab.locator('#report-step').click();
  await tab.locator('#redirect-blocked').waitFor({ state: 'visible' });
  await tab.locator('#explicit-export').click();
  assert.deepEqual(await connector.stopRecording(settings), {
    actions: [{ type: 'click', selector: '#report-step' }], downloadSelector: '#explicit-export',
  });
  assert.equal(connector.isOpen(settings.id), true);
  assert.deepEqual(await connector.read(settings), { title: 'Отчёт', text: 'Строка отчёта' });
  assert.equal(launches, 1);
  await manualLogin();
  const downloaded = await connector.collect({ ...settings, downloadSelector: '#export' });
  assert.equal(downloaded.filename, 'report.xlsx');
  assert.deepEqual(downloaded.bytes, workbookFixture());
  assert.equal(outsideRequests, 0);
  assert.equal(launches, 2);
});
