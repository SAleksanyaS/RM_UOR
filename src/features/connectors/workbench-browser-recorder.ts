import { inspectBrowserArtifact } from './workbench-artifact-policy';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Download, Frame, Locator, Page } from 'playwright';
import { recordedBrowserStepSchema, type RecordedBrowserStep, type StableBrowserLocator } from '../../domain/workbench/browser-scenario';
import { safeArtifactPath } from '../../server/workspace/paths';
import { ConnectorError, type BrowserStep, type PrivateProfile } from './contracts';
import type { BrowserHelperOptions } from './browser';
import { browserProfilePath, checkedUrl, withProfileQueue, type Downloaded } from './transport';
import { resolveRecordedLocator } from './workbench-browser-locators';
import type { Clock } from '../../domain/workbench/primitives';
import type { DraftService } from '../catalog/workbench-drafts';
import type { AccessPolicyService } from '../identity/workbench-access-policy';
import { browserPreparationRevision, resolveBrowserSource, type BrowserSourceBinding } from './workbench-browser-binding';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext } from '../../server/workbench/command-registry';
import type { QueryContext } from '../../server/workbench/query-registry';
import type { JobStore } from '../../server/workbench/jobs';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { canUseCapability } from '../identity/workbench-access-policy';
import type { BrowserProfileService } from './workbench-browser-profile';
import type { BrowserRuntimePort, BrowserRecordingStatus, RecordedBrowserScenario } from './workbench-browser-runtime';

type RecordState = { id: string; runtime: string; owner: string; context: BrowserContext; startUrl: string; selector: string;
  steps: RecordedBrowserStep[]; screenshots: string[]; queue: Promise<void>; downloads: Set<Promise<void>>; completed: boolean;
  requestSequence:number;navigationRequests:Array<{page:Page;frame:Frame;url:string;rootUrl:string;sequence:number}>;exportAction?:{page:Page;frame:Frame;url:string;index:number;boundary:number};replayGap?:boolean; sample?: Downloaded; exportSample?: Downloaded; cancellation: AbortController; downloadsPath?: string; startedAt: number; profile: PrivateProfile; exportUrls: string[];
  closed: boolean; problem?: ConnectorError; release(): void; terminal: Promise<void>; end(): void; timer: NodeJS.Timeout; retention?: NodeJS.Timeout };
const records = new Map<string, RecordState>();
const authPath = /login|sign.?in|sso|oauth|saml|authorize/i;
/** Report the navigation failure but keep the window: the user may still enter or retry in it. */
function navigationProblem(error: unknown): ConnectorError {
  const text = `${(error as { name?: string } | null)?.name ?? ''} ${(error as Error | null)?.message ?? ''}`;
  if (/net::ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED/i.test(text)) return new ConnectorError('configuration_required', 'Браузер заблокировал переход: адрес отчёта или входа вне разрешённых источников. Добавьте точный адрес SSO в личный профиль.', { reason: 'BROWSER_URL_BLOCKED', detail: 'navigation blocked by origin allow-list' });
  if (/Timeout|timed out/i.test(text)) return new ConnectorError('timeout', 'Отчёт не открылся за отведённое время. Проверьте сеть и адрес; окно осталось открытым.', { reason: 'NAVIGATION_TIMEOUT' });
  return new ConnectorError('network', 'Не удалось открыть отчёт. Проверьте сеть и адрес; окно осталось открытым — войдите вручную и продолжите.', { reason: 'NAVIGATION_FAILED', detail: 'navigation failed' });
}
export async function recordingReady(page: Page, selector: string, origin: string): Promise<boolean> {
  try { const url = new URL(page.url()); const marker = page.locator(selector);
    for (const frame of page.frames?.() ?? []) {
      if (frame === page.mainFrame() || !await (await frame.frameElement()).isVisible()) continue;
      const frameUrl = new URL(frame.url());
      if (authPath.test(frameUrl.pathname) || frameUrl.origin === origin && await frame.locator('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login]').evaluateAll(elements => elements.some(el => el.getClientRects().length > 0))) return false;
    }
    return url.origin === origin && !authPath.test(url.pathname) && await marker.count() === 1 && await marker.isVisible()
      && !await page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login],iframe[src*="sso"],iframe[src*="login"]').evaluateAll(elements => elements.some(el => el.getClientRects().length > 0));
  } catch { return false; }
}
export async function assertRecordedField(locator: Locator): Promise<void> {
  const unsafe = await locator.evaluate(el => {
    const node = el as HTMLInputElement;
    return ['password', 'hidden', 'file'].includes(node.type) || node.getClientRects().length === 0
      || /password|token|secret|otp|saml|authorization|credential|one.time|current.password/i.test([node.name, node.id, node.autocomplete, node.getAttribute('aria-label')].join(' '))
      || !!node.closest('[data-authentication],[data-login]')
      || !!node.closest('form')?.querySelector('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login]');
  });
  if (unsafe) throw new ConnectorError('configuration_required', 'Поля входа, скрытые поля и файлы не записываются');
}
/** Diagnostics use fixed event names and bounded numeric/boolean fields only. */
const trace=(_event:string,_detail:Record<string,unknown>={})=>{};
export interface DownloadProbe {resolved?():Downloaded|null;directory:string;since:number;signal?:AbortSignal;idleMs?:number;acquire?():Promise<{path:string;size:number}|null>;fetchExport?(url:string):Promise<Downloaded|null>;exportUrls?():string[];exportSample?():Downloaded|null}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function raceAbort<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>{
 let listener:()=>void;const aborted=new Promise<never>((_,reject)=>{listener=()=>reject(new ConnectorError('cancelled','Выгрузка отменена'));signal?.addEventListener('abort',listener,{once:true});if(signal?.aborted)listener();});return Promise.race([work,aborted]).finally(()=>signal?.removeEventListener('abort',listener));
}
/** A completed Playwright path or engine final rename is proof; a paused .crdownload is never proof. */
export async function completedBrowserDownload(file:Download,profile:PrivateProfile,probe:DownloadProbe):Promise<Downloaded>{
 const name=path.basename(file.suggestedFilename().replace(/\\/g,'/')).slice(0,255)||'download';
 let enginePath:string|null=null,engineFailure=false,pathSettled=false;
 void file.path().then(value=>{enginePath=value;pathSettled=true;},()=>{engineFailure=true;pathSettled=true;});
 const idleMs=probe.idleMs??Math.max(30000,profile.timeoutMs),seen=new Map<string,string>();let progress=Date.now();
 for(;;){
  probe.signal?.throwIfAborted();const committed=probe.resolved?.();if(committed)return committed;let candidates:Array<{file:string;size:number;partial:boolean}>=[];
  for(const entry of await readdir(probe.directory,{withFileTypes:true}).catch(()=>[])){
   if(!entry.isFile()||/\.tmp$/i.test(entry.name))continue;const candidate=path.join(probe.directory,entry.name),info=await stat(candidate).catch(()=>null);if(!info||info.mtimeMs<probe.since-1000)continue;
   if(info.size>profile.maxBytes)throw new ConnectorError('format','Выгрузка превышает ограничение размера');
   const stamp=`${info.size}/${info.mtimeMs}/${info.ino}`;if(seen.get(candidate)!==stamp){seen.set(candidate,stamp);progress=Date.now();}
   candidates.push({file:candidate,size:info.size,partial:/\.crdownload$/i.test(entry.name)});
  }
  let target:string|null=enginePath;const finals=candidates.filter(c=>!c.partial);
  // CDP can move a live context to capture-owned staging while Playwright keeps
  // its launch-time downloadsPath. Rebase only that native Download's exact GUID
  // onto a completed file in this operation's directory, never a latest file.
  if(enginePath&&!await stat(enginePath).catch(()=>null)){
   const guid=path.basename(enginePath);target=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(guid)?finals.find(candidate=>candidate.file===path.join(probe.directory,guid))?.file??null:null;
  }
  if(!enginePath&&candidates.length===1&&finals.length===1)target=finals[0].file;
  if(target){
   const before=await stat(target).catch(()=>null);if(before){if(before.size<1)throw new ConnectorError('incomplete','Пустая выгрузка');if(before.size>profile.maxBytes)throw new ConnectorError('format','Слишком большая выгрузка');
    const bytes=await readFile(target),after=await stat(target);if(before.size===after.size&&before.mtimeMs===after.mtimeMs&&bytes.length===after.size){const policy=await inspectBrowserArtifact(bytes,name,profile.maxBytes);return{bytes,name,contentType:policy.mimeType,formatStatus:policy.status};}
   }
  }
  if(pathSettled&&!enginePath&&!candidates.length)throw new ConnectorError('incomplete','Завершённый файл отсутствует',{reason:'DOWNLOAD_NOT_AVAILABLE'});
  if(Date.now()-progress>=idleMs)throw new ConnectorError('incomplete',engineFailure?'Окно закрылось; завершение файла не подтверждено':'Нет продвижения выгрузки; повторите или отмените',{reason:'DOWNLOAD_NO_PROGRESS'});
  await raceAbort(pause(100),probe.signal);
 }
}
// Without a correlated Download identity a directory entry is retained for recovery, never declared success.
async function diskFinished(_record:RecordState):Promise<boolean>{return false;}
function watchExportUrls(_context:BrowserContext,_record:RecordState):void { /* No speculative authenticated requests. */ }
function own(runtime: string, owner: string, id: string): RecordState {
  const record = records.get(id);
  if (!record || record.runtime !== runtime || record.owner !== owner) throw new ConnectorError('access_denied', 'Запись не найдена');
  return record;
}
export function hasWorkbenchRecording(id: string): boolean { return records.has(id); }
export function readWorkbenchRecordingStatus(runtime: string, owner: string, id: string) {
  const record = own(runtime, owner, id);
  return { state: record.problem ? 'failed' as const : record.completed ? 'completed' as const : record.closed ? 'interrupted' as const : 'recording' as const,
    problem: record.problem ? { code: record.problem.code, message: record.problem.message } : null };
}
export function readWorkbenchRecordingDownload(runtime: string, owner: string, id: string): Downloaded {
  const record = own(runtime, owner, id);
  if (!record.completed || !record.sample) throw new ConnectorError('incomplete', 'Завершённая выгрузка записи недоступна');
  return { ...record.sample, bytes: Buffer.from(record.sample.bytes) };
}
export async function cancelWorkbenchRecording(runtime: string, owner: string, id: string): Promise<boolean> {
  const record = own(runtime, owner, id);
  if (record.completed) return true;
  record.problem ??= new ConnectorError('cancelled', 'Запись отменена'); record.cancellation.abort(); clearTimeout(record.timer);
  if (!record.closed) { record.closed = true; await record.context.close().catch(() => {}); }
  record.release(); record.end(); return false;
}
export async function disposeWorkbenchRecording(runtime:string,owner:string,id:string):Promise<void>{
  const record=records.get(id);if(!record||record.runtime!==runtime||record.owner!==owner)return;
  await cancelWorkbenchRecording(runtime,owner,id);
  await record.queue.catch(()=>{});await Promise.all([...record.downloads]);
  clearTimeout(record.timer);if(record.retention)clearTimeout(record.retention);records.delete(id);
}
export async function waitForWorkbenchRecordingComplete(runtime: string, owner: string, id: string): Promise<void> {
  const record = own(runtime, owner, id); await record.terminal; if (record.problem) throw record.problem;
  if (!record.completed) throw new ConnectorError('incomplete', 'Запись завершена без выгрузки');
}
export async function readWorkbenchRecordingScreenshot(runtime: string, owner: string, id: string, index: number): Promise<Buffer> {
  const record = own(runtime, owner, id);
  if (!Number.isSafeInteger(index) || index < 0 || index >= record.screenshots.length) throw new ConnectorError('access_denied', 'Снимок не найден');
  return readFile(await safeArtifactPath(runtime, `connector-recordings/${id}/${path.basename(record.screenshots[index])}`));
}
async function framePath(page: Page, frame: Frame, origin: string, profile: PrivateProfile): Promise<StableBrowserLocator[] | undefined> {
  if (frame === page.mainFrame()) return undefined;
  const result: StableBrowserLocator[] = [];
  for (let current: Frame | null = frame; current && current !== page.mainFrame(); current = current.parentFrame()) {
    const url = checkedUrl(current.url(), profile);
    if (url.origin !== origin || authPath.test(url.pathname)) throw new ConnectorError('configuration_required', 'Фрейм входа или другого origin не поддерживается записью');
    const selector = await (await current.frameElement()).evaluate(node => { const el = node as Element; return el.getAttribute('data-testid') ? `[data-testid="${CSS.escape(el.getAttribute('data-testid')!)}"]` : el.id ? `#${CSS.escape(el.id)}` : null; });
    if (!selector || result.length === 8) throw new ConnectorError('configuration_required', 'Фрейму отчёта нужен однозначный устойчивый locator');
    result.unshift({ kind: 'css', selector });
  }
  return result;
}
export async function startWorkbenchRecording(runtime: string, owner: string, profile: PrivateProfile, startUrl: string, selector: string,
  onClosed: (() => void) | undefined, options: BrowserHelperOptions,
  launch: (runtime: string, profile: PrivateProfile, options: BrowserHelperOptions) => Promise<BrowserContext>,
  existing?: { context: BrowserContext; page: Page; downloadsPath: string }) {
  const origin = checkedUrl(startUrl, profile).origin, id = randomUUID(), signal = options.signal ?? new AbortController().signal;
  let ready!: (record: RecordState) => void, failed!: (error: unknown) => void;
  const started = new Promise<RecordState>((resolve, reject) => { ready = resolve; failed = reject; });
  const begin = async () => {
    let context: BrowserContext | undefined, downloadsPath = existing?.downloadsPath ?? '';
    // The launch reports its download directory before the window exists; every artifact of this export is
    // written there under an engine-chosen name rather than the suggested one.
    const launching: BrowserHelperOptions = { ...options, onDownloadsPath: directory => { downloadsPath = directory; trace('downloads-dir', { directory }); } };
    try {
      signal.throwIfAborted(); context = existing?.context ?? await launch(runtime, { ...profile, browser: { ...profile.browser!, headless: false } }, launching);
      let release!: () => void, end!: () => void; const done = new Promise<void>(resolve => { release = resolve; }); let ended = false;
      const terminal = new Promise<void>(resolve => { end = () => { if (ended) return; ended = true; resolve(); }; });
      const record: RecordState = { id, runtime, owner, context, startUrl, selector, steps: [], screenshots: [], queue: Promise.resolve(), downloads: new Set(), completed: false, closed: false, cancellation: new AbortController(), release, end, terminal, downloadsPath: downloadsPath || undefined, startedAt: Date.now(), profile, exportUrls: [],requestSequence:0,navigationRequests:[],
        timer: undefined as unknown as NodeJS.Timeout };
      // The window stays open as long as it is needed: there is no session deadline and no cap on the
      // download. It is closed only after the artifact is read from disk, or by the user himself.
      let closing = false;
      const close = async () => { trace('close-called', { closing, closed: record.closed, completed: record.completed, from: new Error().stack?.split('\n')[2]?.trim().slice(0, 160) }); if (closing) return; closing = true; clearTimeout(record.timer); record.closed = true; if (context!.pages().length) await context!.close().catch(() => {}); release(); end(); };
      const abort = () => { record.cancellation.abort(); trace('signal-abort', { completed: record.completed }); record.problem = new ConnectorError('cancelled', 'Запись отменена'); void close(); };
      signal.addEventListener('abort', abort, { once: true });
      // `end()` waits for the in-flight download read, otherwise `finish` reports «Запись завершена
      // без выгрузки» for a file that is still being copied.
      context.once('close', () => { trace('window-closed', { completed: record.completed, downloads: record.downloads.size, title: context!.pages().length ? 'pages' : 'none' }); clearTimeout(record.timer); signal.removeEventListener('abort', abort); onClosed?.();
        void (async () => {
          // A window the report closed by itself is not an interruption while the artifact is still being
          // written: the file on disk is proof that the export succeeded, and reading it needs no browser.
          await Promise.all([...record.downloads]);
          if (record.completed) return;
          if (await diskFinished(record)) { trace('window-closed-with-file'); return; }
          record.problem ??= new ConnectorError('incomplete', 'Окно записи закрылось до появления файла выгрузки. Откройте отчёт и повторите выгрузку', { reason: 'WINDOW_CLOSED_BEFORE_DOWNLOAD' });
          record.cancellation.abort();
        })().catch(() => {}).finally(() => { release(); end(); });
        record.retention = setTimeout(() => { records.delete(id); }, 15 * 60_000); record.retention.unref(); });
      signal.throwIfAborted();
      const enqueue = (run: () => Promise<void>) => { record.queue = record.queue.then(run).catch(error => { record.problem = error instanceof ConnectorError ? error : new ConnectorError('configuration_required', 'Действие не поддерживается. Повторите запись'); }); return record.queue; };
      await context.exposeBinding('__uorRecord', ({ page, frame }, event: unknown) => {const requestBoundary=record.requestSequence;return enqueue(async () => {
        if (record.closed || record.completed || !await recordingReady(page, selector, origin)) return;
        if (record.problem) return;
        // The page script reports an unaddressable element as `unsupported`: it is a gap in the
        // recording, not a failure. Leaving the state untouched keeps the window open and the
        // following download working, so the gap must be handled before anything clears `problem`.
        if ((event as { action?: unknown } | null)?.action === 'unsupported') {record.replayGap=true;return;}
        // Navigation problems are advisory: a successful manual action in the window clears them.
        record.problem = undefined;
        if (record.steps.length >= 100) throw new ConnectorError('configuration_required', 'Запись ограничена 100 действиями');
        const parsed = recordedBrowserStepSchema.safeParse(event);
        if (!parsed.success || parsed.data.action === 'goto' || parsed.data.action === 'download') throw new ConnectorError('configuration_required', 'Не удалось записать шаг: элемент или действие не поддерживается записью. Нажмите на кнопку или поле с подписью и повторите.');
        const frames = await framePath(page, frame, origin, profile), step = { ...parsed.data, ...(frames ? { framePath: frames } : {}) };
        const target = await resolveRecordedLocator(page, step.framePath, step.locator, profile); await assertRecordedField(target);
        const previous = record.steps.at(-1);
        // Browsers can emit change once from an explicit filter event and once
        // again on blur. A safe parameter has one confirmed value after review.
        if ((step.action === 'fill' || step.action === 'select') && JSON.stringify(previous) === JSON.stringify(step)) return;
        record.exportAction=undefined;
        record.steps.push(step);
        if(step.action==='click'){
          const exportUrl=await target.evaluate(el=>{
            const anchor=el.closest('a[href]') as HTMLAnchorElement|null;if(anchor)return anchor.href;
            const control=el as HTMLInputElement|HTMLButtonElement,form=control.form;
            if(!form||control.type!=='submit')return null;
            try{
              // Successful controls named action or method can shadow the form's properties.
              // Native getters preserve URL resolution and the browser's default values.
              const method=control.hasAttribute('formmethod')?control.formMethod:Object.getOwnPropertyDescriptor(HTMLFormElement.prototype,'method')!.get!.call(form);
              if((method||'get').toLowerCase()!=='get')return null;
              // GET replaces the action's query with successful controls and the submitter.
              // HTML normalizes entry names, string values and filenames to CRLF before encoding.
              const url=new URL(control.hasAttribute('formaction')?control.formAction:Object.getOwnPropertyDescriptor(HTMLFormElement.prototype,'action')!.get!.call(form));
              const query=new URLSearchParams();
              for(const [name,value] of new FormData(form,control))query.append(name.replace(/\r\n|\r|\n/g,'\r\n'),(typeof value==='string'?value:value.name).replace(/\r\n|\r|\n/g,'\r\n'));
              // Even an empty entry list produces a query component: /export?.
              url.search='';url.hash='';return url.href+'?'+query.toString();
            }catch{return null;} // Missing URL proof must not discard a completed manual capture.
          });
          if(typeof exportUrl==='string'){try{checkedUrl(exportUrl,profile);record.exportAction={page,frame,url:exportUrl,index:record.steps.length-1,boundary:requestBoundary};}catch{/* Non-report targets cannot prove export replayability. */}}
        }
        trace('step', { n: record.steps.length, action: step.action, locator: step.locator });
        const directory = await safeArtifactPath(runtime, `connector-recordings/${id}`); await mkdir(directory, { recursive: true });
        const screenshot = path.join(directory, `${record.steps.length}.png`);
        if (await recordingReady(page, selector, origin)) await page.screenshot({ path: screenshot, mask: [page.locator('input,textarea,select,[contenteditable],[data-sensitive],iframe')], timeout: 3000 }).then(() => record.screenshots.push(screenshot)).catch(() => {});
      });});
      await context.addInitScript(({ authenticatedSelector }) => {
        const pending = new Set<Promise<void>>();
        // Object methods avoid free esbuild name helpers in the serialized browser callback.
        const recorder = { send(event: unknown) { const task = (window as unknown as { __uorRecord: (event: unknown) => Promise<void> }).__uorRecord(event).catch(() => {}); pending.add(task); void task.finally(() => pending.delete(task)); },

        authenticated() { try { const doc = window.top!.document, markers = doc.querySelectorAll(authenticatedSelector); return markers.length === 1 && markers[0].getClientRects().length > 0 && ![...doc.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login]')].some(node => node.getClientRects().length > 0); } catch { return false; } },
        safe(el: Element) { return recorder.authenticated() && el.getClientRects().length > 0 && !/login|sign.?in|sso|oauth|saml|authorize/i.test(location.pathname) && !el.closest('[data-authentication],[data-login]') && !el.closest('form')?.querySelector('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login]') && !/password|token|secret|otp|saml|authorization|credential|one.time/i.test([el.getAttribute('type'), el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('aria-label')].join(' ')); },
        locator(el: Element) {
          const name = el.getAttribute('aria-label'); const role = el.getAttribute('role') ?? (el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link' : null);
          if (name && role) return { kind: 'role', role, name, exact: true };
          const labels = (el as HTMLInputElement).labels; if (labels?.length === 1 && labels[0].textContent?.trim()) return { kind: 'label', text: labels[0].textContent.trim(), exact: true };
          const selector = el.getAttribute('data-testid') ? `[data-testid="${CSS.escape(el.getAttribute('data-testid')!)}"]` : el.id ? `#${CSS.escape(el.id)}` : el.getAttribute('name') ? `${el.tagName.toLowerCase()}[name="${CSS.escape(el.getAttribute('name')!)}"]` : null;
          if (selector) return { kind: 'css', selector };
          const text = (el as HTMLElement).innerText?.trim().replace(/\s+/g, ' ');
          return role && text ? { kind: 'role', role, name: text, exact: true } : null;
        } };
        (window as unknown as { __uorRecorderDrain: () => Promise<void> }).__uorRecorderDrain = async () => { await Promise.all([...pending]); };
        document.addEventListener('click', event => { if(!event.isTrusted)return;const el = (event.target as Element)?.closest('button,a,[role="button"],input[type="checkbox"]'); if (!el || !recorder.safe(el)) return;
          const target = recorder.locator(el); if (!target) { recorder.send({ action: 'unsupported' }); return; }
          recorder.send((el as HTMLInputElement).type === 'checkbox' ? { action: 'check', locator: target, checked: (el as HTMLInputElement).checked } : { action: 'click', locator: target }); }, true);
        document.addEventListener('change', event => { const el = event.target as HTMLInputElement; if (!recorder.safe(el) || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || ['password', 'file', 'checkbox', 'radio', 'hidden'].includes(el.type)) return;
          const target = recorder.locator(el); if (!target) { recorder.send({ action: 'unsupported' }); return; }
          recorder.send({ action: el.tagName === 'SELECT' ? 'select' : 'fill', locator: target, parameter: `field_${el.id || el.name}` }); }, true);
      }, { authenticatedSelector: selector });
      const attach = (page: Page) => {page.on('request',request=>{try{if(!request.isNavigationRequest()||request.method()!=='GET')return;const frame=request.frame();let root=request;while(root.redirectedFrom())root=root.redirectedFrom()!;record.navigationRequests.push({page,frame,url:request.url(),rootUrl:root.url(),sequence:++record.requestSequence});if(record.navigationRequests.length>200)record.navigationRequests.shift();}catch{/* Worker/unknown request provenance never certifies a recorded click. */}});page.on('download', file => {
        const task = (async () => {
          try {
            // No `recordingReady` check here: the report may already have torn its page down, and the
            // artifact on disk is the only thing that proves the export succeeded.
            // The signal aborts only on an explicit cancellation of the whole recording (the user asks
            // to close the windows). A window the report closes by itself never reaches this signal,
            // so a file that is still being written is not discarded.
            // The page is deliberately left alone: a report commonly closes or navigates on export,
            // so any call into it may fail. The bytes are read from disk, which survives that close.
            const sample = await completedBrowserDownload(file, profile, { directory: record.downloadsPath ?? '', since: record.startedAt,
              signal: record.cancellation.signal,resolved:()=>options.capture?.sink.read?.()??null });
            // The page is deliberately left alone: a report commonly closes or navigates on export,
            // so any call into it may fail. Waiting keeps the context alive until the file landed.
            await options.onCaptured?.(sample);
            record.sample=sample;
            await record.queue;
            if(sample.formatStatus==='quarantined')throw new ConnectorError('format','Файл сохранён, но содержимое выгрузки требует проверки');
            if (record.problem) throw record.problem;
            // A download that follows a recorded click reuses that locator as the final step. When the
            // click was not addressable (or was swallowed by the page) the file itself is the step.
            const last = record.steps.at(-1);
            const action=record.exportAction,downloadUrl=file.url();
            const correlated=action&&action.page===page&&action.index===record.steps.length-1&&record.navigationRequests.some(request=>request.sequence>action.boundary&&request.page===page&&request.frame===action.frame&&request.rootUrl===action.url&&request.url===downloadUrl);
            if (last?.action === 'click' && !record.replayGap&&correlated) record.steps[record.steps.length - 1] = { ...last, action: 'download' };
            // A raw artifact without an addressable export action cannot prove a replay recipe.
            else record.problem=undefined;
            // The file is verified on disk before this point, so the window is closed only now.
            record.sample = sample; record.completed = true; await file.delete().catch(() => {}); await close();
          } catch (error) { record.problem = error instanceof ConnectorError ? error : new ConnectorError('incomplete', 'Выгрузка не завершена'); await close(); }
        })();
        record.downloads.add(task); void task.finally(() => record.downloads.delete(task)); return task;
      });};
      context.pages().forEach(attach); context.on('page', attach); records.set(id, record);
      watchExportUrls(context, record);
      const page = existing?.page ?? context.pages()[0] ?? await context.newPage();
      // A failed first navigation must not close the recording window: the user may still
      // finish a manual SSO step or correct the address while the window stays open.
      if (existing) {
        // The workflow has explicitly consumed an authenticated capability. A
        // lost session must enter its manual-login/retry flow, never return a
        // successful start command containing an already-failed recorder.
        const loginRequired = () => new ConnectorError('manual_login_required', 'Окно больше не подтверждает вход в отчёт. Войдите в личном окне и продолжите запись.');
        let response;
        try { response = await page.goto(startUrl); }
        catch { signal.throwIfAborted(); throw loginRequired(); }
        if (response?.status() === 403) throw new ConnectorError('access_denied', 'Источник отказал в доступе к отчёту');
        if (response?.status() === 401) throw loginRequired();
        await page.locator(selector).waitFor({ state: 'visible', timeout: profile.timeoutMs }).catch(() => { throw loginRequired(); });
        if (!await recordingReady(page, selector, origin)) throw loginRequired();
      } else await page.goto(startUrl).catch(error => { trace('navigation-failed', { error: String((error as Error)?.message ?? error).slice(0, 200) }); record.problem = navigationProblem(error); });
      trace('window-opened', { url: startUrl, marker: selector });
      ready(record); await done;
    } catch (error) { await disposeWorkbenchRecording(runtime,owner,id); failed(error); } finally { await context?.close().catch(() => {}); }
  };
  // A continued login retains its original queue lease until native close.
  // Re-entering this same profile queue would wait forever behind ourselves.
  if (existing) void begin().catch(failed);
  else void withProfileQueue(await browserProfilePath(runtime, profile), signal, begin).catch(failed);
  const record = await started; return { recordingId: record.id, message: 'Выполните действия в отчёте. Запись закончится после завершённой выгрузки CSV/XLSX.' };
}
export async function finishWorkbenchRecording(runtime: string, owner: string, id: string, save: boolean) {
  const record = own(runtime, owner, id);
  if (save) throw new ConnectorError('configuration_required', 'Проверьте сценарий перед сохранением общего черновика');
  await record.queue;
  // `finish` must not overtake a download that is still being written: the window is closed below,
  // and closing it first is exactly what lost the file.
  await Promise.all([...record.downloads]);
  try {
    if (record.problem) throw record.problem;
    const steps = record.steps.flatMap<BrowserStep>(step => { if (step.action === 'goto') return [step]; if (step.locator.kind !== 'css' || step.framePath) return []; const { locator, framePath: _frames, ...rest } = step; return [{ ...rest, selector: locator.selector }]; });
    return { scenario: { id: `scenario-${id}`, startUrl: record.startUrl, steps }, parameters: [...new Set(record.steps.flatMap(step => step.action === 'fill' || step.action === 'select' ? [step.parameter] : []))],
      screenshotCount: record.screenshots.length, screenshots: [] as Array<{ url: string; label: string }>, workbenchSteps: structuredClone(record.steps), completedDownload: record.completed };
  } finally { clearTimeout(record.timer); if (!record.closed) { record.closed = true; await record.context.close().catch(() => {}); record.release(); record.end(); } }
}

export type BrowserRecordingReview = RecordedBrowserScenario & { bindingProblem?: string | null };
export interface BrowserRecorderService {
  dispose():void;
  start(context: CommandContext, input: BrowserSourceBinding & { startUrl: string; authenticatedSelector: string }): Promise<{ recordingId: string; state: 'recording' }>;
  selectMarker(context: CommandContext, input: BrowserSourceBinding & { startUrl: string }): Promise<{ selector: string; label: string }>;
  status(context: QueryContext, recordingId: string): Promise<BrowserRecordingStatus>;
  cancel(context: CommandContext, recordingId: string): Promise<{ recordingId: string; cancelled: true }>;
  finish(context: CommandContext, input: { recordingId: string; save: boolean }): Promise<BrowserRecordingReview>;
  screenshot(context: QueryContext, recordingId: string, handleId: string): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }>;
}
/** Profiles are an explicit private dependency; portable repository rows cannot resolve personal browser settings. */
export function createBrowserRecorderService({ runtime, repository, profiles, drafts, accessPolicy }: { runtime: BrowserRuntimePort; repository: WorkbenchRepository; jobs: JobStore; clock: Clock; profiles: BrowserProfileService; drafts?: DraftService; accessPolicy?: AccessPolicyService }): BrowserRecorderService {
  const sessions = new Map<string, { owner: string; input: BrowserSourceBinding; profileRevision: string | null; result?: RecordedBrowserScenario; timer: NodeJS.Timeout }>();
  const owner = (context: QueryContext) => ({ installationId: context.installationId, profilePersonId: context.ownAccess.personId });
  const key = (context: QueryContext) => `${context.installationId}/${context.ownAccess.personId ?? 'unassigned'}`;
  const find = (context: QueryContext, id: string) => { const session = sessions.get(id); if (!session || session.owner !== key(context)) throw new WorkbenchHttpError(404, 'RECORDING_NOT_FOUND', 'Recording not found'); return session; };
  const checked = async (context: QueryContext, input: BrowserSourceBinding, expectedProfile?: string | null) => {
    const access = accessPolicy ? await accessPolicy.resolveOwnAccess() : context.ownAccess;
    if (access.personId !== context.ownAccess.personId || !canUseCapability(access, 'uor.prepare')) throw new WorkbenchHttpError(403, 'COMMAND_FORBIDDEN', 'Recording requires preparation capability');
    const source = resolveBrowserSource({ ...context, repository, ownAccess: access }, input, drafts);
    const profile = await profiles.getOwn(context, source.id);
    if (!profile.configured || !profile.profile) throw new WorkbenchHttpError(409, 'BROWSER_CONFIGURATION_REQUIRED', 'Configure your own browser profile');
    if (expectedProfile !== undefined && profile.revision !== expectedProfile) throw new WorkbenchHttpError(409, 'SOURCE_CONFIGURATION_CHANGED', 'Personal browser settings changed');
    return profile;
  };
  return {
    dispose(){for(const session of sessions.values())clearTimeout(session.timer);sessions.clear();},
    async selectMarker(context, input) {
      const profile = await checked(context, input); checkedUrl(input.startUrl, profile.profile!);
      if (!runtime.selectMarker) throw new WorkbenchHttpError(409, 'BROWSER_CONFIGURATION_REQUIRED', 'Marker selection is unavailable');
      const result = await runtime.selectMarker({ owner: owner(context), profile: profile.profile!, startUrl: input.startUrl, preparationId: input.sourceRef.id, preparationRevision: browserPreparationRevision(input, profile.revision) }, new AbortController().signal);
      try { await checked(context, input, profile.revision); }
      catch (error) { await runtime.discardPreparation?.({ owner: owner(context), preparationId: input.sourceRef.id }); throw error; }
      return result;
    },
    async start(context, input) {
      const profile = await checked(context, input); checkedUrl(input.startUrl, profile.profile!);
      const handle = await runtime.startRecording({ owner: owner(context), profile: profile.profile!, startUrl: input.startUrl, authenticatedSelector: input.authenticatedSelector, preparationId: input.sourceRef.id, preparationRevision: browserPreparationRevision(input, profile.revision), allowFreshContext: true }, new AbortController().signal);
      try { await checked(context, input, profile.revision); }
      catch (error) { await runtime.cancelRecording?.({ handleId: handle.handleId, owner: owner(context) }); throw error; }
      const timer = setTimeout(() => sessions.delete(handle.handleId), 30 * 60_000); timer.unref();
      sessions.set(handle.handleId, { owner: key(context), input: structuredClone(input), profileRevision: profile.revision, timer }); return { recordingId: handle.handleId, state: 'recording' };
    },
    async status(context, recordingId) {
      const session = find(context, recordingId);
      if (session.result) return { state: session.result.hasDownload ? 'completed' : 'idle', problem: null };
      if (!runtime.readRecordingStatus) throw new WorkbenchHttpError(409, 'RECORDING_STATUS_UNAVAILABLE', 'Recording status is unavailable');
      return runtime.readRecordingStatus({ handleId: recordingId, owner: owner(context) });
    },
    async cancel(context, recordingId) {
      find(context, recordingId);
      if (!runtime.cancelRecording) throw new WorkbenchHttpError(409, 'RECORDING_CANCEL_UNAVAILABLE', 'Recording cancellation is unavailable');
      await runtime.cancelRecording({ handleId: recordingId, owner: owner(context) });
      return { recordingId, cancelled: true };
    },
    async finish(context, input) {
      const session = find(context, input.recordingId);
      if (input.save) throw new WorkbenchHttpError(422, 'SCENARIO_REVIEW_REQUIRED', 'Review parameters and export before saving a shared draft');
      let bindingProblem: string | null = null;
      const verify = async () => { try { await checked(context, session.input, session.profileRevision); } catch (error) { if (error instanceof WorkbenchHttpError) bindingProblem = error.code; else throw error; } };
      await verify(); session.result ??= await runtime.finish({ handleId: input.recordingId, owner: owner(context), save: false }); await verify();
      return { ...structuredClone(session.result), ...(bindingProblem ? { bindingProblem } : {}) };
    },
    async screenshot(context, recordingId, handleId) {
      const session = find(context, recordingId);
      if (!session.result?.screenshotHandles.includes(handleId)) throw new WorkbenchHttpError(404, 'SCREENSHOT_NOT_FOUND', 'Screenshot not found');
      return runtime.screenshot({ recordingId, owner: owner(context), handleId });
    },
  };
}
