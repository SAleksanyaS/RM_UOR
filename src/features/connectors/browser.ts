import { readFile, mkdir, writeFile, stat, lstat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BrowserContext, Page, Locator, Download, Frame, CDPSession } from 'playwright';
import { safeArtifactPath } from '../../server/workspace/paths';
import { ConnectorError, scenarioSchema, stepSchema, type PrivateProfile, type BrowserScenario, type BrowserStep } from './contracts';
import { describeLaunchFailure, inspectBrowserEnvironment, launchHint, safeErrorDetail, type BrowserEnvironmentReport } from './workbench-browser-diagnostics';
import { browserProfilePath, checkedUrl, checkedBrowserUrl, loginUrlAllowed, withProfileQueue, type Downloaded } from './transport';
import { assertRecordedField, cancelWorkbenchRecording, completedBrowserDownload, finishWorkbenchRecording, hasWorkbenchRecording, recordingReady, startWorkbenchRecording, waitForWorkbenchRecordingComplete, readWorkbenchRecordingScreenshot } from './workbench-browser-recorder';
import type { RecordedBrowserStep } from '../../domain/workbench/browser-scenario';
import { resolveRecordedLocator } from './workbench-browser-locators';
import { releaseStaleProfileLocks, acquireBrowserProfileLease } from './workbench-browser-profile-locks';
export const waitForRecordingComplete = waitForWorkbenchRecordingComplete;
export const readRecordingScreenshot = readWorkbenchRecordingScreenshot;
export async function cancelRecording(runtime: string, owner: string, id: string): Promise<boolean> {
  if (hasWorkbenchRecording(id)) return cancelWorkbenchRecording(runtime, owner, id);
  await finishRecording(runtime, owner, id, false); return false;
}
const profileReleases=new Map<string,Promise<void>>();
const browserDownloads=new WeakMap<BrowserContext,string>();
const browserLimits = new WeakMap<BrowserContext,{error?:ConnectorError}>();
interface BrowserPolicy {
  phase: 'login' | 'report'; transitioning: boolean; retainedPage?: Page;
  guards: Map<Page, Promise<CDPSession>>; downloads: string;
  capture?: BrowserHelperOptions['capture']; activeDownloads: Set<string>;
  downloadSession?: CDPSession; detachDownloads?: () => void;
  limit: { error?: ConnectorError };
}
const browserPolicies = new WeakMap<BrowserContext, BrowserPolicy>();
const browserClosures = new WeakMap<BrowserContext, Promise<void>>();
/** Concurrent native close calls can acknowledge before the first close finishes.
 * Policy rejection, cancellation and replay cleanup share that first promise. */
function closeBrowserContext(context: BrowserContext): Promise<void> {
  let closing = browserClosures.get(context);
  if (!closing) { closing = context.close().catch(() => {}); browserClosures.set(context, closing); }
  return closing;
}

const reportWorkerPolicyError = () => new ConnectorError('configuration_required',
  'Браузер не подтвердил безопасный режим отчёта без фоновых workers. Проверьте поддержку целевого браузера; вход повторно не открывался.',
  { reason: 'REPORT_WORKER_POLICY_UNAVAILABLE', detail: 'REPORT_WORKER_POLICY_UNAVAILABLE' });
// A string is intentional: this runs in the native production loader and must
// not refer to TypeScript/esbuild helpers or extract any authentication state.
const reportWorkerGuard = `(() => {
  if (globalThis.ServiceWorkerContainer) Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {
    configurable: false, writable: false,
    value: function () { return Promise.reject(new DOMException('Report worker policy', 'SecurityError')); }
  });
})();`;
const reportDocumentMaxBytes = 16 * 1024 * 1024;
// Engine-level single-tab boundary: reject popup creation before its first
// request, while preserving scripts, cookies, forms and same-tab downloads.
const reportDocumentPolicy = "worker-src 'none'; sandbox allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-pointer-lock allow-orientation-lock allow-presentation allow-top-navigation";
const reportWindowPolicyError = () => new ConnectorError('configuration_required',
  'Источник открыл новое окно во время получения отчёта. Настройте выгрузку в текущей вкладке.',
  { reason: 'REPORT_NEW_WINDOW_UNSUPPORTED', detail: 'REPORT_NEW_WINDOW_UNSUPPORTED' });
function rejectReportWindow(context: BrowserContext, policy: BrowserPolicy) {
  policy.limit.error = reportWindowPolicyError(); void closeBrowserContext(context);
}

/** Header-only CDP continuation silently ignores added CSP in the tested engine.
 * Fulfil the original document bytes explicitly, in bounded transient memory.
 * No document, cookie, token or storage snapshot is persisted or logged. */
async function protectReportDocument(guard: CDPSession, event: { requestId: string; responseStatusCode?: number; responseStatusText?: string; responseHeaders?: Array<{ name: string; value: string }> }) {
  const headers = event.responseHeaders ?? [];
  const declaredSize = headers.find(header => header.name.toLowerCase() === 'content-length')?.value;
  if (declaredSize && /^\d+$/.test(declaredSize) && Number(declaredSize) > reportDocumentMaxBytes) throw reportWorkerPolicyError();
  const { stream } = await guard.send('Fetch.takeResponseBodyAsStream', { requestId: event.requestId });
  const chunks: Buffer[] = []; let length = 0;
  try {
    for (;;) {
      const part = await guard.send('IO.read', { handle: stream, size: 64 * 1024 });
      const bytes = Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8');
      length += bytes.length; if (length > reportDocumentMaxBytes) throw reportWorkerPolicyError();
      chunks.push(bytes); if (part.eof) break;
    }
    // Chromium provides decoded body bytes. Reusing compression/framing headers
    // would corrupt the response; all source security and cookie headers remain.
    await guard.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: event.responseStatusCode!, responsePhrase: event.responseStatusText,
      responseHeaders: [...headers.filter(header => !/^(content-encoding|content-length|transfer-encoding)$/i.test(header.name)),
        { name: 'Content-Length', value: String(length) }, { name: 'Content-Security-Policy', value: reportDocumentPolicy }],
      body: Buffer.concat(chunks, length).toString('base64') });
  } finally { chunks.length = 0; await guard.send('IO.close', { handle: stream }).catch(() => {}); }
}

/** Bind current capture state, not the original login options. Browser events
 * must journal the GUID/path before a receipt can be committed or a window closes. */
async function bindBrowserDownloads(context: BrowserContext, policy: BrowserPolicy, profile: PrivateProfile, page: Page) {
  policy.detachDownloads?.();
  const cdp = await context.newCDPSession(page); policy.downloadSession = cdp;
  const begin = (event: { url: string; guid: string; suggestedFilename: string }) => {
    policy.activeDownloads.add(event.guid);
    try {
      if (policy.transitioning) throw reportWorkerPolicyError();
      checkedUrl(event.url, profile);
      policy.capture?.sink.stage?.({ directory: policy.downloads, guid: event.guid, name: event.suggestedFilename });
    } catch {
      policy.limit.error = new ConnectorError('incomplete', 'Не удалось связать выгрузку с операцией');
      void cdp.send('Browser.cancelDownload', { guid: event.guid }).catch(() => {});
    }
  };
  const progress = (event: { guid: string; state: string; receivedBytes: number; totalBytes: number }) => {
    if (event.state === 'completed' || event.state === 'canceled') policy.activeDownloads.delete(event.guid);
    if (event.receivedBytes > profile.maxBytes || event.totalBytes > profile.maxBytes) {
      policy.limit.error = new ConnectorError('format', 'Браузерная выгрузка превышает допустимый размер');
      void cdp.send('Browser.cancelDownload', { guid: event.guid }).catch(() => {});
    }
  };
  cdp.on('Browser.downloadWillBegin', begin); cdp.on('Browser.downloadProgress', progress);
  policy.detachDownloads = () => { cdp.off('Browser.downloadWillBegin', begin); cdp.off('Browser.downloadProgress', progress); };
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: policy.downloads, eventsEnabled: true });
  browserDownloads.set(context, policy.downloads);
}

/** A login is not a report security boundary: workers can make redirects and
 * sockets outside page routes. Retire every old realm/worker before resuming the
 * same context. Report CSP deliberately excludes dedicated/shared workers too;
 * worker-dependent reports require a separate target-browser acceptance check. */
async function enterReportPolicy(context: BrowserContext, policy: BrowserPolicy, profile: PrivateProfile, page: Page, callerSignal?: AbortSignal) {
  const deadline = AbortSignal.timeout(profile.timeoutMs), signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const abort = () => { void closeBrowserContext(context); };
  signal.addEventListener('abort', abort, { once: true });
  const sessions: CDPSession[] = [];
  policy.transitioning = true; policy.retainedPage = page; policy.phase = 'report';
  const waitFor = async (check: () => boolean, subscribe: (changed: () => void) => () => void) => {
    signal.throwIfAborted(); if (check()) return;
    await new Promise<void>((resolve, reject) => {
      const changed = () => { if (check()) { cleanup(); resolve(); } };
      const aborted = () => { cleanup(); reject(signal.reason); };
      const closed = () => { cleanup(); reject(reportWorkerPolicyError()); };
      const unsubscribe = subscribe(changed);
      const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', aborted); context.off('close', closed); };
      signal.addEventListener('abort', aborted, { once: true }); context.once('close', closed); changed();
      if (signal.aborted) aborted();
    });
  };
  const inventory = async () => {
    const cdp = await context.newCDPSession(page); sessions.push(cdp);
    const registrations = new Map<string, { scopeURL: string; isDeleted: boolean }>();
    const versions = new Map<string, { runningStatus: string }>();
    let registrationsSeen = false, versionsSeen = false;
    const listeners = new Set<() => void>();
    const subscribe = (changed: () => void) => { listeners.add(changed); return () => { listeners.delete(changed); }; };
    cdp.on('ServiceWorker.workerRegistrationUpdated', event => { registrationsSeen = true; for (const entry of event.registrations) registrations.set(entry.registrationId, entry); for (const changed of listeners) changed(); });
    cdp.on('ServiceWorker.workerVersionUpdated', event => { versionsSeen = true; for (const entry of event.versions) versions.set(entry.versionId, entry); for (const changed of listeners) changed(); });
    await cdp.send('ServiceWorker.enable');
    // The enable reply arrives BEFORE its asynchronous snapshots, including the
    // two empty snapshots. A command acknowledgement alone proves nothing here.
    await waitFor(() => registrationsSeen && versionsSeen, subscribe);
    return { cdp, registrations, versions, subscribe };
  };
  try {
    signal.throwIfAborted(); await context.setOffline(true);
    await context.addInitScript({ content: reportWorkerGuard });
    for (const guid of policy.activeDownloads) await policy.downloadSession?.send('Browser.cancelDownload', { guid });
    policy.activeDownloads.clear();
    for (const other of context.pages()) if (other !== page) await other.close();
    // Same tab: sessionStorage survives; no cookies/storageState are read/copied.
    await page.goto('about:blank');
    for (const other of context.pages()) if (other !== page) await other.close();
    const workers = await inventory();
    await workers.cdp.send('ServiceWorker.stopAllWorkers');
    for (const entry of workers.registrations.values()) if (!entry.isDeleted) await workers.cdp.send('ServiceWorker.unregister', { scopeURL: entry.scopeURL });
    await waitFor(() => [...workers.registrations.values()].every(entry => entry.isDeleted) && [...workers.versions.values()].every(entry => entry.runningStatus === 'stopped'), workers.subscribe);
    const { targetInfo } = await workers.cdp.send('Target.getTargetInfo');
    if (!targetInfo.browserContextId) throw reportWorkerPolicyError();
    const contextId = targetInfo.browserContextId, workerTypes = new Set(['worker', 'shared_worker', 'service_worker']);
    const destroyed = new Set<string>(), changed = new Set<() => void>();
    workers.cdp.on('Target.targetDestroyed', event => { destroyed.add(event.targetId); for (const listener of changed) listener(); });
    await workers.cdp.send('Target.setDiscoverTargets', { discover: true });
    const ownedTargets = (await workers.cdp.send('Target.getTargets')).targetInfos.filter(target => target.browserContextId === contextId && workerTypes.has(target.type));
    for (const target of ownedTargets) {
      await workers.cdp.send('Target.closeTarget', { targetId: target.targetId });
      await waitFor(() => destroyed.has(target.targetId), listener => { changed.add(listener); return () => { changed.delete(listener); }; });
    }
    // SharedWorkers with extended lifetime can outlive every old document.
    // Verify their actual target retirement, scoped to this owned context only.
    if ((await workers.cdp.send('Target.getTargets')).targetInfos.some(target => target.browserContextId === contextId && workerTypes.has(target.type))) throw reportWorkerPolicyError();
    const final = await inventory();
    if ([...final.registrations.values()].some(entry => !entry.isDeleted) || [...final.versions.values()].some(entry => entry.runningStatus !== 'stopped')) throw reportWorkerPolicyError();
    signal.throwIfAborted();
  } catch (error) {
    if (callerSignal?.aborted) callerSignal.throwIfAborted();
    policy.limit.error = reportWorkerPolicyError(); throw policy.limit.error;
  } finally {
    signal.removeEventListener('abort', abort);
    // A closing target may never acknowledge detach; native close owns cleanup.
    if (!signal.aborted) for (const cdp of sessions) await cdp.detach().catch(() => {});
  }
}

/** Never blocks a launch failure: diagnostics must stay read-only and best-effort. */
async function browserEnvironment(browser: NonNullable<PrivateProfile['browser']>): Promise<BrowserEnvironmentReport> {
  try { return await inspectBrowserEnvironment(browser); }
  catch { return { executablePath: browser.executablePath ?? null, channel: browser.channel ?? null, executable: { exists: true, isFile: true, executable: true, directory: false, mode: null },
    sandbox: { chromeSandbox: null, mode: null, setuidRoot: null }, profileDirectory: { writable: null }, platform: process.platform, uid: null, userns: { cloneAllowed: 'unknown' }, appArmorChromium: { restricted: 'unknown' } }; }
}
export type BrowserLaunchOptions = NonNullable<Parameters<typeof import('playwright')['chromium']['launchPersistentContext']>[1]>;
export interface BrowserLauncherPort { readonly requiresProfileLease?:boolean; launchPersistent(profile: PrivateProfile, profilePath: string, options: BrowserLaunchOptions): Promise<BrowserContext> }
export type BrowserHelperOptions = { launcher?: BrowserLauncherPort; signal?: AbortSignal; authenticatedSelector?: string; workbenchRecording?: boolean; workbenchSteps?: RecordedBrowserStep[]; onDownloadsPath?: (directory: string) => void; phase?:'login'|'report'; onCaptured?:(download:Downloaded)=>Promise<void>;capture?:import('./workbench-capture-contracts').BrowserCapture };

export async function openBrowser(runtime: string, profile: PrivateProfile, options: BrowserHelperOptions = {}): Promise<BrowserContext> {
  const browser = profile.browser; if (!browser) throw new ConnectorError('configuration_required', 'Настройте executable/channel и приватный профиль браузера');
  for (const candidate of [path.join(runtime, 'browser-profiles'), path.join(runtime, 'browser-profiles', browser.profileDirectory)]) {
    try { const entry = await lstat(candidate); if (entry.isSymbolicLink() || !entry.isDirectory()) throw new ConnectorError('configuration_required', 'Папка профиля браузера не должна быть ссылкой'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const folder = await browserProfilePath(runtime, profile); await mkdir(folder, { recursive: true });
  const needsProfileLease=!options.launcher||options.launcher.requiresProfileLease===true;
  if(needsProfileLease)await releaseStaleProfileLocks(folder).catch(()=>[]);
  let chromium: typeof import('playwright')['chromium'];
  try { ({ chromium } = await import('playwright')); } catch { throw new ConnectorError('configuration_required', 'Установите Playwright и Chromium либо укажите executablePath'); }
  const certs = await Promise.all((browser.clientCertificates ?? []).map(async c => ({ origin: checkedUrl(c.origin, profile).origin, cert: await readFile(c.certFile), key: await readFile(c.keyFile), ...(c.passphraseEnv ? { passphrase: process.env[c.passphraseEnv] } : {}) })));
  const downloads=await safeArtifactPath(runtime,`browser-downloads/${options.capture?.intent.captureId??randomUUID()}`);await mkdir(downloads,{recursive:true});
  // The recording reads the artifact straight from this directory: the engine names every file by GUID
  // and keeps it as `.crdownload` while no live connection is left to rename it.
  options.onDownloadsPath?.(downloads);
  await profileReleases.get(folder);
  const releaseProfile=!needsProfileLease?async()=>{}:await acquireBrowserProfileLease(folder).catch(()=>{throw new ConnectorError('browser_launch','Профиль занят; закройте собственные окна автоматизации',{reason:'PROFILE_LOCKED'});});
  let context: BrowserContext;
  const launchOptions: BrowserLaunchOptions = { executablePath: browser.executablePath, channel: browser.channel, headless: browser.headless, chromiumSandbox: true, downloadsPath:downloads, acceptDownloads: true, serviceWorkers: options.phase==='login'?'allow':'block', ignoreHTTPSErrors: false, clientCertificates: certs };
  try { context = options.launcher ? await options.launcher.launchPersistent(profile, folder, launchOptions) : await chromium.launchPersistentContext(folder, launchOptions); }
  catch (error) { await releaseProfile(); await rm(downloads,{recursive:true,force:true}).catch(()=>{});
    const environment = await browserEnvironment(browser), diagnosis = describeLaunchFailure(error, environment);
    throw new ConnectorError('browser_launch', `Не удалось запустить браузер с включённой защитой. ${launchHint(diagnosis.reason, environment)}`, { reason: diagnosis.reason, detail: diagnosis.detail });
  }
  context.once('close',()=>{const releasing=releaseProfile();profileReleases.set(folder,releasing);void releasing.finally(()=>{if(profileReleases.get(folder)===releasing)profileReleases.delete(folder);});});
  try{
  context.setDefaultTimeout(profile.timeoutMs); context.setDefaultNavigationTimeout(profile.timeoutMs);
  const policy: BrowserPolicy = { phase: options.phase ?? 'report', transitioning: false, guards: new Map(), downloads, capture: options.capture, activeDownloads: new Set(), limit: {} };
  browserPolicies.set(context, policy); browserLimits.set(context, policy.limit);
  const page = context.pages()[0] ?? await context.newPage();
  // Every page response (including popup/frame redirects) is checked before the
  // next hop. Additional CSP preserves the source's own policies and headers.
  const protectPage = (target: Page): Promise<CDPSession> => {
    let guarded = policy.guards.get(target);
    if (!guarded) {
      guarded = (async () => {
        const guard = await context.newCDPSession(target);
        guard.on('Fetch.requestPaused', event => { void (async () => {
          // Login requests can settle after the report transition has begun.
          // Their retirement is not a failure of the new report policy.
          const reportResponse = policy.phase === 'report' && !policy.transitioning;
          try {
            if (policy.transitioning) {
              await guard.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
              return;
            }
            const location = event.responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value;
            if (location && event.responseStatusCode && event.responseStatusCode >= 300 && event.responseStatusCode < 400) checkedBrowserUrl(new URL(location, event.request.url).href, profile, policy.phase);
            checkedBrowserUrl(event.request.url, profile, policy.phase);
            const headers = event.responseHeaders ?? [];
            const attachment = headers.some(header => header.name.toLowerCase() === 'content-disposition' && /^attachment\b/i.test(header.value));
            // A same-origin text/plain or JSON frame also exposes its Worker
            // constructor to its parent. MIME type cannot exempt that realm.
            const activeDocument = event.resourceType === 'Document' && !attachment;
            if (policy.phase === 'report' && activeDocument && event.responseStatusCode && (event.responseStatusCode >= 200 && event.responseStatusCode < 300 || event.responseStatusCode >= 400) && ![204, 205].includes(event.responseStatusCode)) {
              await protectReportDocument(guard, event);
            } else await guard.send('Fetch.continueRequest', { requestId: event.requestId });
          } catch (error) {
            await guard.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
            if (reportResponse && (!(error instanceof ConnectorError) || error.reason === 'REPORT_WORKER_POLICY_UNAVAILABLE')) { policy.limit.error = reportWorkerPolicyError(); void closeBrowserContext(context); }
          }
        })(); });
        await guard.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Response' }] });
        return guard;
      })();
      policy.guards.set(target, guarded);
      target.once('close', () => policy.guards.delete(target));
      // Chromium denies sandboxed popup creation before creating a Page. Keep
      // that native denial actionable without returning its URL-bearing text.
      target.on('console', message => {
        if (policy.phase === 'report' && message.type() === 'error' && /sandbox.*allow-popups|allow-popups.*sandbox/i.test(message.text())) rejectReportWindow(context, policy);
      });
    }
    return guarded;
  };
  await protectPage(page);
  context.on('page', popup => {
    if (policy.phase === 'report' && popup !== policy.retainedPage) { rejectReportWindow(context, policy); return; }
    void protectPage(popup).catch(() => { policy.limit.error = reportWorkerPolicyError(); void closeBrowserContext(context); });
  });
  await context.route('**/*', async route => {
    try {
      if (policy.transitioning) throw reportWorkerPolicyError();
      checkedBrowserUrl(route.request().url(), profile, policy.phase);
      // Routing pauses a popup's first request until its response guard exists.
      if (!route.request().serviceWorker()) {
        let target: Page | undefined;
        try { target = route.request().frame().page(); } catch { /* A popup's first navigation may precede its frame. */ }
        if (policy.phase === 'report' && target !== policy.retainedPage) {
          // Login popups can establish the retained authenticated tab. Once the
          // report starts, every navigation must belong to that one tab.
          rejectReportWindow(context, policy); throw policy.limit.error;
        }
        if (target) await protectPage(target);
      }
      else if (policy.phase === 'report') throw reportWorkerPolicyError();
      await route.continue();
    } catch { await route.abort('blockedbyclient').catch(() => {}); }
  });
  await context.routeWebSocket('**/*', route => {
    try { if (policy.transitioning) throw reportWorkerPolicyError(); checkedUrl(route.url(), profile, true); route.connectToServer(); }
    catch { route.close({ code: 1008, reason: 'Origin not allowed' }); }
  });
  if (policy.phase === 'report') await enterReportPolicy(context, policy, profile, page, options.signal);
  policy.transitioning = false;
  await bindBrowserDownloads(context, policy, profile, page);
  if (policy.phase === 'report') await context.setOffline(false);
  // Staging survives context loss and is removed only by verified capture cleanup.
  return context;
  }catch(error){await closeBrowserContext(context);await rm(downloads,{recursive:true,force:true}).catch(()=>{});throw error;}
}
async function assertSafeField(page: Page, selector: string) {
  const unsafe = await page.locator(selector).evaluate(el => {
    const node = el as HTMLInputElement; return node.type === 'password' || /password|token|secret|otp|saml|authorization|credential|one.time|current.password/i.test([node.name, node.id, node.autocomplete, node.getAttribute('aria-label')].join(' '));
  });
  if (unsafe) throw new ConnectorError('configuration_required', 'В сценарии запрещены поля паролей, кодов и токенов. Выполните вход вручную');
}
export async function readScenario(runtime: string, id: string): Promise<BrowserScenario> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new ConnectorError('configuration_required', 'Некорректный идентификатор сценария');
  try { return scenarioSchema.parse(JSON.parse(await readFile(await safeArtifactPath(runtime, `connector-scenarios/${id}.json`), 'utf8'))); }
  catch { throw new ConnectorError('configuration_required', 'Сценарий не найден или содержит неподдерживаемые действия'); }
}
/** Observe only the selected export's request/redirect chain, or a user-gesture
 * fetch when the report button has no declarative URL. Images, styles, scripts
 * and background requests cannot turn an otherwise valid export into auth loss. */
async function waitForBrowserExport(context: BrowserContext, page: Page, locator: Locator, profile: PrivateProfile, signal: AbortSignal, selector: string, sourceOrigin: string): Promise<Download> {
  // A prepared link may still carry a placeholder URL while hidden. Bind the
  // target after readiness; context cancellation and the profile timeout bound this wait.
  signal.throwIfAborted();
  await locator.waitFor({ state: 'visible', timeout: profile.timeoutMs });
  signal.throwIfAborted();
  const target = await locator.evaluate(element => {
    const link = element.closest('a[href]') as HTMLAnchorElement | null;
    if (link) return { url: link.href, kind: 'link' as const };
    const control = element as HTMLButtonElement | HTMLInputElement;
    return control.form && control.type === 'submit' ? { url: control.hasAttribute('formaction') ? control.formAction : control.form.action, kind: 'form' as const } : null;
  });
  const expected = target ? checkedUrl(target.url, profile) : null;
  if (expected) { expected.hash = ''; if (!expected.search) expected.search = ''; }
  const matchesTarget = (url: string) => { if (!expected) return false; const actual = new URL(url); actual.hash = ''; if (!actual.search) actual.search = ''; return target?.kind === 'form' ? actual.origin === expected.origin && actual.pathname === expected.pathname : actual.href === expected.href; };
  const observation = await context.newCDPSession(page);
  const requests = new Set<string>(),selectedUrls=new Set<string>();
  let settled = false, started = false, timer: NodeJS.Timeout | undefined;
  let resolve!: (file: Download) => void, reject!: (error: unknown) => void;
  const waiting = new Promise<Download>((yes, no) => { resolve = yes; reject = no; });
  const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
  const auth = () => fail(new ConnectorError('manual_login_required', 'Источник требует повторного входа перед выгрузкой'));
  const reportUrl = (url: string) => { try { return checkedUrl(url, profile).origin === sourceOrigin; } catch { return false; } };
  const authUrl = (url: string) => { try { return /login|sign.?in|sso|oauth|saml|authorize/i.test(new URL(url).pathname); } catch { return false; } };
  const response = (status: number, url: string) => {
    if (status === 401 || authUrl(url)) auth();
    else if (status === 403) fail(new ConnectorError('access_denied', 'Источник отказал в доступе к выгрузке'));
  };
  const onRequest = (event: { requestId: string; type?: string; hasUserGesture?: boolean; request: { url: string }; redirectResponse?: { status: number; url: string } }) => {
    if (!started || settled) return;
    if (requests.has(event.requestId) || reportUrl(event.request.url) && ['Document', 'XHR', 'Fetch'].includes(event.type ?? '') && (expected ? matchesTarget(event.request.url) : event.hasUserGesture === true)) {
      requests.add(event.requestId);selectedUrls.add(event.request.url); if (event.redirectResponse) response(event.redirectResponse.status, event.redirectResponse.url); if (authUrl(event.request.url)) auth();
    }
  };
  const onResponse = (event: { requestId: string; response: { status: number; url: string } }) => { if (requests.has(event.requestId) && !settled) response(event.response.status, event.response.url); };
  const onDownload = (file: Download) => { if(expected&&file.url()!==expected.href&&!selectedUrls.has(file.url()))return; if (!settled) { settled = true; resolve(file); } };
  const inspectBoundary = async () => {
    if (started && !settled && !await recordingReady(page, selector, sourceOrigin)) auth();
  };
  const onNavigated = (frame: Frame) => { if (started && !settled && frame === page.mainFrame() && authUrl(frame.url())) auth(); };
  const onReady = () => { void inspectBoundary().catch(() => {}); };
  const onAbort = () => fail(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
  const onClosed = () => fail(new ConnectorError('cancelled', 'Браузер закрыт до получения выгрузки'));
  try {
    await observation.send('Network.enable');
    observation.on('Network.requestWillBeSent', onRequest); observation.on('Network.responseReceived', onResponse);
    page.on('download', onDownload); page.on('framenavigated', onNavigated); page.on('domcontentloaded', onReady); page.on('close', onClosed);
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => fail(new ConnectorError('timeout', 'Источник не завершил действие выгрузки за отведённое время')), profile.timeoutMs);
    started = true; if (signal.aborted) onAbort();
    const [file] = await Promise.all([waiting, locator.click().then(onReady)]); return file;
  } finally {
    settled = true; if (timer) clearTimeout(timer); signal.removeEventListener('abort', onAbort);
    page.off('download', onDownload); page.off('framenavigated', onNavigated); page.off('domcontentloaded', onReady); page.off('close', onClosed);
    observation.off('Network.requestWillBeSent', onRequest); observation.off('Network.responseReceived', onResponse);
    // CDP detach may never acknowledge once cancellation closes its target. Native context close owns final teardown.
    if(!signal.aborted){let cleanupTimer:NodeJS.Timeout|undefined;await Promise.race([observation.detach().catch(()=>{}),new Promise<void>(resolve=>{cleanupTimer=setTimeout(resolve,1000);})]).finally(()=>{if(cleanupTimer)clearTimeout(cleanupTimer);});}
  }
}
export async function executeBrowser(runtime: string, profile: PrivateProfile, scenario: BrowserScenario, parameters: Record<string, string>, signal: AbortSignal, options: BrowserHelperOptions = {}): Promise<Downloaded> {
  return withProfileQueue(await browserProfilePath(runtime, profile), signal, async () => {
    // The directory is known only after the launch creates it; the replay reads the artifact from there.
    let directory = ''; const context = await openBrowser(runtime, profile, { ...options, signal, onDownloadsPath: value => { directory = value; } });
    return executeBrowserContext(context, profile, scenario, parameters, signal, options, directory);
  });
}
async function executeBrowserContext(context: BrowserContext, profile: PrivateProfile, scenario: BrowserScenario, parameters: Record<string, string>, signal: AbortSignal, options: BrowserHelperOptions, downloads = ''): Promise<Downloaded> {
    const startedAt = Date.now();
    let closing: Promise<void> | undefined;
    const close = () => closing ??= closeBrowserContext(context), abort = () => { void close(); }; signal.addEventListener('abort', abort, { once: true });

    try {
      signal.throwIfAborted(); const page = context.pages()[0] ?? await context.newPage();
      const navigate = async (url: string) => {
        const response = await page.goto(checkedUrl(url, profile).href);
        if (response?.status() === 401) throw new ConnectorError('manual_login_required', 'Источник требует повторного входа');
        if (response?.status() === 403) throw new ConnectorError('access_denied', 'Источник отказал в доступе к отчёту');
      };
      await navigate(scenario.startUrl);
      if(/login|sign.?in|sso|oauth|saml|authorize/i.test(new URL(page.url()).pathname))throw new ConnectorError('manual_login_required','Откройте профиль и завершите вход вручную');
      let downloaded: Downloaded | undefined;
      for (const step of options.workbenchSteps ?? scenario.steps) {
        signal.throwIfAborted(); checkedUrl(page.url(), profile);
        if (options.authenticatedSelector && !await (options.workbenchSteps ? recordingReady : recorderReady)(page, options.authenticatedSelector, new URL(scenario.startUrl).origin)) throw new ConnectorError('manual_login_required', 'Откройте профиль и завершите вход вручную');
        if (profile.browser?.loginUrlPattern && new RegExp(profile.browser.loginUrlPattern).test(page.url())) throw new ConnectorError('manual_login_required', 'Откройте профиль и завершите вход вручную');
        if (step.action === 'goto') { await navigate(step.url); continue; }
        const locator = 'locator' in step ? await resolveRecordedLocator(page, step.framePath, step.locator, profile) : page.locator(step.selector);
        if (step.action === 'fill' || step.action === 'select') {
          if ('locator' in step) await assertRecordedField(locator); else await assertSafeField(page, step.selector); const value = parameters[step.parameter];
          if (value === undefined || /password|token|secret|otp|saml|credential/i.test(step.parameter)) throw new ConnectorError('configuration_required', 'Не задан безопасный параметр сценария');
          if (step.action === 'fill') await locator.fill(value); else await locator.selectOption(value);
        } else if (step.action === 'click') await locator.click();
        else if (step.action === 'check') { if ('locator' in step) await assertRecordedField(locator); else await assertSafeField(page, step.selector); await locator.setChecked(step.checked); }
        else if (step.action === 'wait') await locator.waitFor({ state: 'visible' });
        else {
          const file = options.workbenchSteps && options.authenticatedSelector
            ? await waitForBrowserExport(context, page, locator, profile, signal, options.authenticatedSelector, new URL(scenario.startUrl).origin)
            : (await Promise.all([page.waitForEvent('download'), locator.click()]))[0];
          if (options.workbenchSteps) { downloaded = await completedBrowserDownload(file, profile, { directory: downloads, since: startedAt, signal,resolved:()=>options.capture?.sink.read?.()??null }); await options.onCaptured?.(downloaded);if(downloaded.formatStatus==='quarantined')throw new ConnectorError('format','Файл сохранён для проверки; содержимое не является подтверждённой выгрузкой отчёта'); await file.delete().catch(() => {}); continue; }
          if (await file.failure()) throw new ConnectorError('incomplete', 'Браузер не завершил выгрузку');
          const filePath = await file.path(); const fileSize = filePath ? (await stat(filePath)).size : 0; if (!filePath || fileSize === 0 || fileSize > profile.maxBytes) throw new ConnectorError('format', 'Выгрузка отсутствует, пуста или превышает ограничение размера');
          downloaded = { bytes: await readFile(filePath), name: file.suggestedFilename(), contentType: '' }; await file.delete();
        }
      }
      if (!downloaded) throw new ConnectorError('incomplete', 'Сценарий не получил файл. Добавьте действие download'); return downloaded;
    } catch(error){if(signal.aborted)signal.throwIfAborted();throw browserLimits.get(context)?.error??error;}
    finally { signal.removeEventListener('abort', abort); await close(); }
}

interface Recording { runtime:string; id: string; owner: string; context: BrowserContext; scenario: BrowserScenario; observing: boolean; release: () => void; expires: NodeJS.Timeout; expiresAt: number; parameters: Record<string, string>; screenshots: string[]; pendingDownload?:boolean }
const recordings = new Map<string, Recording>();
/** Process-local access to a login whose existing queue lease is still held. */
export function ownedBrowserLoginContext(owner: string, id: string, startUrl: string): BrowserContext {
  const record = recordings.get(id);
  if (!record || record.owner !== owner || record.observing || record.scenario.startUrl !== startUrl || record.expiresAt <= Date.now() || !record.context.pages().length) throw new ConnectorError('manual_login_required', 'Окно входа закрыто или истекло. Откройте личное окно и продолжите вход.');
  return record.context;
}
/** A selected marker gets its own bounded readiness interval; no auth is copied. */
export function retainBrowserLogin(owner: string, id: string, startUrl: string): number {
  ownedBrowserLoginContext(owner, id, startUrl);
  const record = recordings.get(id)!;
  clearTimeout(record.expires); record.expiresAt = Date.now() + 15 * 60_000;
  record.expires = setTimeout(record.release, 15 * 60_000); record.expires.unref();
  return record.expiresAt;
}
/** The login keeps its profile queue lease until this same native context closes.
 * Authentication never leaves the browser as cookies, storage state or recipe data. */
async function activateBrowserLogin(owner: string, id: string, profile: PrivateProfile, startUrl: string, signal: AbortSignal, options: BrowserHelperOptions) {
  const record = recordings.get(id);
  const context = ownedBrowserLoginContext(owner, id, startUrl), policy = browserPolicies.get(context);
  // Replay now owns cancellation/timeout; an almost-expired login must not
  // release the existing queue lease in the middle of a valid download.
  clearTimeout(record!.expires); record!.observing = true;
  const abort = () => { void closeBrowserContext(context); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted(); if (!policy) throw reportWorkerPolicyError();
    let page: Page | undefined;
    for (const candidate of context.pages()) {
      if (options.authenticatedSelector && await recordingReady(candidate, options.authenticatedSelector, checkedUrl(startUrl, profile).origin)) { page = candidate; break; }
    }
    if (!page) throw new ConnectorError('manual_login_required', 'Завершите вход в нужный отчёт в открытом окне');
    await enterReportPolicy(context, policy, profile, page, signal);
    const downloads = await safeArtifactPath(record!.runtime, `browser-downloads/${options.capture?.intent.captureId ?? randomUUID()}`);
    await mkdir(downloads, { recursive: true });
    policy.downloads = downloads; policy.capture = options.capture; delete policy.limit.error;
    await bindBrowserDownloads(context, policy, profile, page); options.onDownloadsPath?.(downloads);
    signal.throwIfAborted(); policy.transitioning = false; await context.setOffline(false);
    return { context, page, downloadsPath: downloads };
  } catch (error) { await closeBrowserContext(context); if (signal.aborted) signal.throwIfAborted(); throw policy?.limit.error ?? error; }
  finally { signal.removeEventListener('abort', abort); }
}
export async function replayBrowserLogin(owner: string, id: string, profile: PrivateProfile, scenario: BrowserScenario, parameters: Record<string, string>, signal: AbortSignal, options: BrowserHelperOptions): Promise<Downloaded> {
  const active = await activateBrowserLogin(owner, id, profile, scenario.startUrl, signal, options);
  return executeBrowserContext(active.context, profile, scenario, parameters, signal, { ...options, phase: 'report' }, active.downloadsPath);
}
/** First recording consumes an authenticated login exactly like replay does. */
export async function recordBrowserLogin(owner: string, id: string, profile: PrivateProfile, startUrl: string, selector: string, onClosed: (() => void) | undefined, options: BrowserHelperOptions) {
  const context = ownedBrowserLoginContext(owner, id, startUrl), record = recordings.get(id)!;
  try {
    const active = await activateBrowserLogin(owner, id, profile, startUrl, options.signal ?? new AbortController().signal, { ...options, authenticatedSelector: selector });
    return await startWorkbenchRecording(record.runtime, owner, profile, startUrl, selector, onClosed, options, openBrowser, active);
  } catch (error) { await closeBrowserContext(context); throw browserLimits.get(context)?.error ?? error; }
}
export async function observeBrowserLogin(owner: string, id: string, profile: PrivateProfile, selector: string, startUrl: string): Promise<boolean> {
  const record = recordings.get(id);
  if (!record || record.owner !== owner) throw new ConnectorError('access_denied', 'Browser session is unavailable');
  const origin = checkedUrl(startUrl, profile).origin;
  for (const page of record.context.pages()) {
    try { checkedUrl(page.url(), profile); if (await recordingReady(page, selector, origin)) return true; } catch { /* An unrelated tab cannot prove report authentication. */ }
  }
  return false;
}
async function recorderReady(page:Page,selector:string,origin:string){try{return new URL(page.url()).origin===origin&&!/login|sign.?in|sso|oauth|saml|authorize/i.test(new URL(page.url()).pathname)&&await page.locator(selector).isVisible()&&!await page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login],iframe[src*="sso"],iframe[src*="login"]').evaluateAll(elements=>elements.some(el=>el.getClientRects().length>0));}catch{return false;}}
export async function startRecording(runtime: string, owner: string, profile: PrivateProfile, startUrl: string, observe=true,authenticatedSelector?:string,onClosed?:()=>void, options: BrowserHelperOptions = {}) {
  if(observe&&!authenticatedSelector)throw new ConnectorError('configuration_required','Для записи задайте элемент, видимый только после успешного входа в источник');
  if (observe && options.workbenchRecording) return startWorkbenchRecording(runtime, owner, profile, startUrl, authenticatedSelector!, onClosed, options, openBrowser);
  checkedUrl(startUrl, profile); const id = randomUUID();
  let ready!: (record: Recording) => void, failed!: (error: unknown) => void;
  const started = new Promise<Recording>((resolve, reject) => { ready = resolve; failed = reject; });
  const waiting=new AbortController(),signal=options.signal ? AbortSignal.any([waiting.signal, options.signal]) : waiting.signal,queueTimer=setTimeout(()=>waiting.abort(),profile.timeoutMs);
  void withProfileQueue(await browserProfilePath(runtime, profile), signal, async () => {
    let context: BrowserContext | undefined;
    try {
      clearTimeout(queueTimer);
      context = await openBrowser(runtime, { ...profile, browser: { ...profile.browser!, headless: false } }, options);
      const ownedContext=context,abort=()=>{void closeBrowserContext(ownedContext);};signal.addEventListener('abort',abort,{once:true});
      context.once('close',()=>signal.removeEventListener('abort',abort));signal.throwIfAborted();
      let release!: () => void; const done = new Promise<void>(resolve => { release = resolve; });
      const record: Recording = { runtime, id, owner, context, scenario: { id: `scenario-${id}`, startUrl, steps: [] }, observing: observe, release, expires: setTimeout(() => release(), 15 * 60_000), expiresAt: Date.now() + 15 * 60_000, parameters: {}, screenshots: [] };
      const sourceOrigin = new URL(startUrl).origin;
      if(observe){
      await context.exposeBinding('__uorRecord', async ({ page, frame }, event: unknown) => {
        if(!await recorderReady(page,authenticatedSelector!,sourceOrigin))return;
        if (frame !== page.mainFrame() || new URL(frame.url()).origin !== sourceOrigin || /login|sign.?in|sso|oauth|saml|authorize/i.test(new URL(frame.url()).pathname) || record.scenario.steps.length >= 100) return;
        const parsed = stepSchema.safeParse(event); if (!parsed.success || parsed.data.action === 'goto' || parsed.data.action === 'download') return;
        if ('selector' in parsed.data) {
          if ((await page.locator(parsed.data.selector).count()) !== 1) return;
          await assertSafeField(page, parsed.data.selector);
        }
        if(parsed.data.action==='click'&&record.pendingDownload){record.scenario.steps.push({action:'download',selector:parsed.data.selector});record.pendingDownload=false;}
        else record.scenario.steps.push(parsed.data);
        const screenshotIndex=record.scenario.steps.length;
        // Mask all editable content and common secret-bearing containers; never capture SSO origins.
        const directory = await safeArtifactPath(runtime, `connector-recordings/${id}`); await mkdir(directory, { recursive: true });
        const screenshot = path.join(directory, `${screenshotIndex}.png`);
        if(await recorderReady(page,authenticatedSelector!,sourceOrigin))await page.screenshot({ path: screenshot, mask: [page.locator('input,textarea,select,[contenteditable],[data-sensitive],iframe')], timeout: 3000 }).then(() => record.screenshots.push(screenshot)).catch(() => {});
      });
      await context.addInitScript(() => {
        const safe = (el: Element) => !/login|sign.?in|sso|oauth|saml|authorize/i.test(location.pathname) && !el.closest('form')?.querySelector('input[type="password"]') && !/password|token|secret|otp|saml|authorization|credential|one.time/i.test([el.getAttribute('type'), el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('aria-label')].join(' '));
        const selector = (el: Element) => el.getAttribute('data-testid') ? `[data-testid="${CSS.escape(el.getAttribute('data-testid')!)}"]` : el.id ? `#${CSS.escape(el.id)}` : el.getAttribute('name') ? `${el.tagName.toLowerCase()}[name="${CSS.escape(el.getAttribute('name')!)}"]` : null;
        const send = (event: unknown) => { const fn = (window as unknown as { __uorRecord?: (v: unknown) => Promise<void> }).__uorRecord; void fn?.(event); };
        document.addEventListener('click', event => { const el = (event.target as Element)?.closest('button,a,[role="button"],input[type="checkbox"]'); if (!el || !safe(el)) return; const s = selector(el); if (!s) return; if ((el as HTMLInputElement).type === 'checkbox') send({ action: 'check', selector: s, checked: (el as HTMLInputElement).checked }); else send({ action: 'click', selector: s }); }, true);
        document.addEventListener('change', event => { const el = event.target as HTMLInputElement; if (!safe(el) || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || ['password','file','checkbox','radio','hidden'].includes(el.type)) return; const s = selector(el); if (!s) return; send({ action: el.tagName === 'SELECT' ? 'select' : 'fill', selector: s, parameter: `field_${el.id || el.name}` }); }, true);
      });
      const attach = (page: Page) => page.on('download', async file => {
        if (new URL(page.url()).origin !== sourceOrigin) { await file.cancel(); return; }
        const last = record.scenario.steps.at(-1); if (last?.action === 'click') {record.scenario.steps[record.scenario.steps.length - 1] = { action: 'download', selector: last.selector };record.pendingDownload=false;}else record.pendingDownload=true;
        await file.cancel();
      });
      context.pages().forEach(attach); context.on('page', attach);
      }
      context.on('close',()=>{clearTimeout(record.expires);release();onClosed?.();});
      const page = context.pages()[0] ?? await context.newPage();
      // The login window must survive a failed first navigation: the operator still needs it
      // to sign in by hand. A refused start shows an explanatory page inside the same window.
      await page.goto(startUrl).catch(async error => {
        const detail = safeErrorDetail(error instanceof Error ? error.message : String(error)).split('\n')[0];
        await page.setContent(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Вход в отчёт</title><h1>Не удалось открыть адрес отчёта</h1><p>Окно оставлено открытым. Проверьте адрес и сеть, затем повторите переход обычным способом.</p><p><code>${detail.replace(/[<>&]/g, '')}</code></p></html>`).catch(() => {});
      });
      recordings.set(id, record); ready(record);
      await done;
      clearTimeout(record.expires); recordings.delete(id);
    } catch (e) { failed(e); } finally { if (context) await closeBrowserContext(context); }
  }).catch(failed);
  let record:Recording;try{record=await started;}finally{clearTimeout(queueTimer);} return { recordingId: record.id, message: 'Войдите вручную. Запись действий действует только на origin источника; значения полей не записываются. Завершите запись в приложении.' };
}
export async function finishRecording(runtime: string, owner: string, id: string, save: boolean) {
  if (hasWorkbenchRecording(id)) return finishWorkbenchRecording(runtime, owner, id, save);
  const record = recordings.get(id); if (!record || record.owner !== owner) throw new ConnectorError('access_denied', 'Запись принадлежит другой сессии или завершена');
  try {
    const scenario = scenarioSchema.parse(record.scenario);
    if (save) { const directory = await safeArtifactPath(runtime, 'connector-scenarios'); await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, `${scenario.id}.json`), JSON.stringify(scenario, null, 2), { flag: 'wx' }); }
    const directory=await safeArtifactPath(runtime,`connector-recordings/${id}`);await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,'manifest.json'),JSON.stringify({ownerSessionId:owner,files:record.screenshots.map(file=>path.basename(file))}));
    return { scenario, parameters: [...new Set(scenario.steps.flatMap(s => s.action === 'fill' || s.action === 'select' ? [s.parameter] : []))], screenshotCount: record.screenshots.length,screenshots:record.screenshots.map(file=>({url:`/api/connectors/recordings/${id}/screenshots/${path.basename(file,'.png')}`,label:`Шаг ${path.basename(file,'.png')}`})), workbenchSteps: undefined, completedDownload: undefined };
  } finally { record.release(); await closeBrowserContext(record.context); }
}
export async function stopAllRecordings() { for (const record of recordings.values()) { record.release(); await closeBrowserContext(record.context); } }
