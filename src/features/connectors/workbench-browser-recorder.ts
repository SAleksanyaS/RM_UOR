import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Download, Frame, Locator, Page } from 'playwright';
import { recordedBrowserStepSchema, type RecordedBrowserStep, type StableBrowserLocator } from '../../domain/workbench/browser-scenario';
import { safeArtifactPath } from '../../server/workspace/paths';
import { ConnectorError, type BrowserStep, type PrivateProfile } from './contracts';
import type { BrowserHelperOptions } from './browser';
import { browserProfilePath, checkedUrl, withProfileQueue, type Downloaded } from './transport';
import { resolveRecordedLocator } from './workbench-browser-locators';
import type { Clock, VersionRef } from '../../domain/workbench/primitives';
import type { SourceDefinition } from '../../domain/workbench/entities';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext } from '../../server/workbench/command-registry';
import type { QueryContext } from '../../server/workbench/query-registry';
import type { JobStore } from '../../server/workbench/jobs';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { canUseCapability } from '../identity/workbench-access-policy';
import type { BrowserProfileService } from './workbench-browser-profile';
import type { BrowserRuntimePort, RecordedBrowserScenario } from './workbench-browser-runtime';

type RecordState = { id: string; runtime: string; owner: string; context: BrowserContext; startUrl: string; selector: string;
  steps: RecordedBrowserStep[]; screenshots: string[]; queue: Promise<void>; downloads: Set<Promise<void>>; completed: boolean;
  sample?: Downloaded; cancellation: AbortController;
  closed: boolean; problem?: ConnectorError; release(): void; terminal: Promise<void>; end(): void; timer: NodeJS.Timeout; retention?: NodeJS.Timeout };
const records = new Map<string, RecordState>();
const authPath = /login|sign.?in|sso|oauth|saml|authorize/i;
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
export async function completedBrowserDownload(file: Download, profile: PrivateProfile, signal?: AbortSignal): Promise<Downloaded> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    const failure = await Promise.race([file.failure(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConnectorError('timeout', 'Файл не завершил загрузку за отведённое время')), profile.timeoutMs);
      abort = () => reject(new ConnectorError('cancelled', 'Выгрузка отменена')); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    })]);
    if (failure) throw new ConnectorError('incomplete', 'Браузер не завершил выгрузку');
    const filename = await file.path(), size = filename ? (await stat(filename)).size : 0;
    if (!filename || !size || size > profile.maxBytes) throw new ConnectorError('format', 'Выгрузка отсутствует, пуста или превышает ограничение размера');
    const bytes = await readFile(filename), name = path.basename(file.suggestedFilename());
    if (bytes.length !== size || !/\.(csv|xlsx)$/i.test(name) || /^\s*(?:<!doctype\s+html|<html|<form|<\?xml[^>]*>\s*<html)/i.test(bytes.subarray(0, 2048).toString('utf8').replace(/^\uFEFF/, ''))
      || /\.xlsx$/i.test(name) && !(bytes[0] === 0x50 && bytes[1] === 0x4b) || /\.csv$/i.test(name) && bytes.includes(0))
      throw new ConnectorError('format', 'Ожидалась непустая CSV/XLSX выгрузка отчёта');
    return { bytes, name, contentType: /\.xlsx$/i.test(name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv' };
  } catch (error) { await file.cancel().catch(() => {}); throw error; }
  finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
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
  launch: (runtime: string, profile: PrivateProfile, options: BrowserHelperOptions) => Promise<BrowserContext>) {
  const origin = checkedUrl(startUrl, profile).origin, id = randomUUID(), signal = options.signal ?? new AbortController().signal;
  let ready!: (record: RecordState) => void, failed!: (error: unknown) => void;
  const started = new Promise<RecordState>((resolve, reject) => { ready = resolve; failed = reject; });
  void withProfileQueue(await browserProfilePath(runtime, profile), signal, async () => {
    let context: BrowserContext | undefined;
    try {
      signal.throwIfAborted(); context = await launch(runtime, { ...profile, browser: { ...profile.browser!, headless: false } }, options);
      let release!: () => void, end!: () => void; const done = new Promise<void>(resolve => { release = resolve; }), terminal = new Promise<void>(resolve => { end = resolve; });
      const record: RecordState = { id, runtime, owner, context, startUrl, selector, steps: [], screenshots: [], queue: Promise.resolve(), downloads: new Set(), completed: false, closed: false, cancellation: new AbortController(), release, end, terminal,
        timer: setTimeout(() => { record.problem = new ConnectorError('timeout', 'Запись ограничена 15 минутами'); void close(); }, 15 * 60_000) };
      const close = async () => { if (record.closed) return; record.closed = true; if (!record.completed) record.cancellation.abort(); clearTimeout(record.timer); await context!.close().catch(() => {}); release(); end(); };
      const abort = () => { record.problem = new ConnectorError('cancelled', 'Запись отменена'); void close(); };
      signal.addEventListener('abort', abort, { once: true });
      context.once('close', () => { record.closed = true; if (!record.completed) record.cancellation.abort(); clearTimeout(record.timer); signal.removeEventListener('abort', abort); release(); end(); onClosed?.();
        record.retention = setTimeout(() => { records.delete(id); }, 15 * 60_000); record.retention.unref(); });
      signal.throwIfAborted();
      const enqueue = (run: () => Promise<void>) => { record.queue = record.queue.then(run).catch(error => { record.problem = error instanceof ConnectorError ? error : new ConnectorError('configuration_required', 'Действие не поддерживается. Повторите запись'); }); return record.queue; };
      await context.exposeBinding('__uorRecord', ({ page, frame }, event: unknown) => enqueue(async () => {
        if (record.closed || record.completed || !await recordingReady(page, selector, origin)) return;
        if (record.problem) return;
        if (record.steps.length >= 100) throw new ConnectorError('configuration_required', 'Запись ограничена 100 действиями');
        const parsed = recordedBrowserStepSchema.safeParse(event);
        if (!parsed.success || parsed.data.action === 'goto' || parsed.data.action === 'download') throw new ConnectorError('configuration_required', 'Действие или locator не поддерживается записью');
        const frames = await framePath(page, frame, origin, profile), step = { ...parsed.data, ...(frames ? { framePath: frames } : {}) };
        const target = await resolveRecordedLocator(page, step.framePath, step.locator, profile); await assertRecordedField(target);
        const previous = record.steps.at(-1);
        // Browsers can emit change once from an explicit filter event and once
        // again on blur. A safe parameter has one confirmed value after review.
        if ((step.action === 'fill' || step.action === 'select') && JSON.stringify(previous) === JSON.stringify(step)) return;
        record.steps.push(step);
        const directory = await safeArtifactPath(runtime, `connector-recordings/${id}`); await mkdir(directory, { recursive: true });
        const screenshot = path.join(directory, `${record.steps.length}.png`);
        if (await recordingReady(page, selector, origin)) await page.screenshot({ path: screenshot, mask: [page.locator('input,textarea,select,[contenteditable],[data-sensitive],iframe')], timeout: 3000 }).then(() => record.screenshots.push(screenshot)).catch(() => {});
      }));
      await context.addInitScript(({ authenticatedSelector }) => {
        const pending = new Set<Promise<void>>();
        const send = (event: unknown) => { const task = (window as unknown as { __uorRecord: (event: unknown) => Promise<void> }).__uorRecord(event).catch(() => {}); pending.add(task); void task.finally(() => pending.delete(task)); };
        (window as unknown as { __uorRecorderDrain: () => Promise<void> }).__uorRecorderDrain = async () => { await Promise.all([...pending]); };
        const authenticated = () => { try { const doc = window.top!.document, markers = doc.querySelectorAll(authenticatedSelector); return markers.length === 1 && markers[0].getClientRects().length > 0 && ![...doc.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login]')].some(node => node.getClientRects().length > 0); } catch { return false; } };
        const safe = (el: Element) => authenticated() && el.getClientRects().length > 0 && !/login|sign.?in|sso|oauth|saml|authorize/i.test(location.pathname) && !el.closest('[data-authentication],[data-login]') && !el.closest('form')?.querySelector('input[type="password"],input[autocomplete="one-time-code"],[data-authentication],[data-login]') && !/password|token|secret|otp|saml|authorization|credential|one.time/i.test([el.getAttribute('type'), el.id, el.getAttribute('name'), el.getAttribute('autocomplete'), el.getAttribute('aria-label')].join(' '));
        const locator = (el: Element) => {
          const name = el.getAttribute('aria-label'); const role = el.getAttribute('role') ?? (el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link' : null);
          if (name && role) return { kind: 'role', role, name, exact: true };
          const labels = (el as HTMLInputElement).labels; if (labels?.length === 1 && labels[0].textContent?.trim()) return { kind: 'label', text: labels[0].textContent.trim(), exact: true };
          const selector = el.getAttribute('data-testid') ? `[data-testid="${CSS.escape(el.getAttribute('data-testid')!)}"]` : el.id ? `#${CSS.escape(el.id)}` : el.getAttribute('name') ? `${el.tagName.toLowerCase()}[name="${CSS.escape(el.getAttribute('name')!)}"]` : null;
          return selector ? { kind: 'css', selector } : null;
        };
        document.addEventListener('click', event => { const el = (event.target as Element)?.closest('button,a,[role="button"],input[type="checkbox"]'); if (!el || !safe(el)) return;
          const target = locator(el); if (!target) { send({ action: 'unsupported' }); return; }
          send((el as HTMLInputElement).type === 'checkbox' ? { action: 'check', locator: target, checked: (el as HTMLInputElement).checked } : { action: 'click', locator: target }); }, true);
        document.addEventListener('change', event => { const el = event.target as HTMLInputElement; if (!safe(el) || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || ['password', 'file', 'checkbox', 'radio', 'hidden'].includes(el.type)) return;
          const target = locator(el); if (!target) { send({ action: 'unsupported' }); return; }
          send({ action: el.tagName === 'SELECT' ? 'select' : 'fill', locator: target, parameter: `field_${el.id || el.name}` }); }, true);
      }, { authenticatedSelector: selector });
      const attach = (page: Page) => page.on('download', file => {
        const task = (async () => {
          try {
            if (!await recordingReady(page, selector, origin)) { await file.cancel(); return; }
            const sample = await completedBrowserDownload(file, profile, record.cancellation.signal);
            await page.evaluate(async () => { await (window as unknown as { __uorRecorderDrain?: () => Promise<void> }).__uorRecorderDrain?.(); }).catch(() => {});
            await record.queue;
            if (record.problem) throw record.problem;
            const last = record.steps.at(-1);
            if (last?.action !== 'click') throw new ConnectorError('configuration_required', 'Выгрузка не связана с записанным нажатием. Повторите запись');
            if (!await recordingReady(page, selector, origin)) throw new ConnectorError('manual_login_required', 'Сессия отчёта требует входа');
            record.steps[record.steps.length - 1] = { ...last, action: 'download' }; record.sample = sample; record.completed = true; await file.delete(); await close();
          } catch (error) { record.problem = error instanceof ConnectorError ? error : new ConnectorError('incomplete', 'Выгрузка не завершена'); await close(); }
        })();
        record.downloads.add(task); void task.finally(() => record.downloads.delete(task)); return task;
      });
      context.pages().forEach(attach); context.on('page', attach); records.set(id, record);
      const page = context.pages()[0] ?? await context.newPage(); await page.goto(startUrl).catch(error => { if (!record.completed) throw error; }); ready(record); await done;
    } catch (error) { failed(error); } finally { await context?.close().catch(() => {}); }
  }).catch(failed);
  const record = await started; return { recordingId: record.id, message: 'Выполните действия в отчёте. Запись закончится после завершённой выгрузки CSV/XLSX.' };
}
export async function finishWorkbenchRecording(runtime: string, owner: string, id: string, save: boolean) {
  const record = own(runtime, owner, id);
  if (save) throw new ConnectorError('configuration_required', 'Проверьте сценарий перед сохранением общего черновика');
  await record.queue; await Promise.all([...record.downloads]);
  try {
    if (record.problem) throw record.problem;
    const steps = record.steps.flatMap<BrowserStep>(step => { if (step.action === 'goto') return [step]; if (step.locator.kind !== 'css' || step.framePath) return []; const { locator, framePath: _frames, ...rest } = step; return [{ ...rest, selector: locator.selector }]; });
    return { scenario: { id: `scenario-${id}`, startUrl: record.startUrl, steps }, parameters: [...new Set(record.steps.flatMap(step => step.action === 'fill' || step.action === 'select' ? [step.parameter] : []))],
      screenshotCount: record.screenshots.length, screenshots: [] as Array<{ url: string; label: string }>, workbenchSteps: structuredClone(record.steps), completedDownload: record.completed };
  } finally { clearTimeout(record.timer); if (!record.closed) { record.closed = true; await record.context.close().catch(() => {}); record.release(); record.end(); } }
}

export interface BrowserRecorderService {
  start(context: CommandContext, input: { sourceRef: VersionRef; startUrl: string; authenticatedSelector: string }): Promise<{ recordingId: string; state: 'recording' }>;
  finish(context: CommandContext, input: { recordingId: string; save: boolean }): Promise<RecordedBrowserScenario>;
  screenshot(context: QueryContext, recordingId: string, handleId: string): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }>;
}
/** Profiles are an explicit private dependency; portable repository rows cannot resolve personal browser settings. */
export function createBrowserRecorderService({ runtime, repository, profiles }: { runtime: BrowserRuntimePort; repository: WorkbenchRepository; jobs: JobStore; clock: Clock; profiles: BrowserProfileService }): BrowserRecorderService {
  const sessions = new Map<string, { owner: string; result?: RecordedBrowserScenario; timer: NodeJS.Timeout }>();
  const owner = (context: QueryContext) => ({ installationId: context.installationId, profilePersonId: context.ownAccess.personId });
  const key = (context: QueryContext) => `${context.installationId}/${context.ownAccess.personId ?? 'unassigned'}`;
  const find = (context: QueryContext, id: string) => { const session = sessions.get(id); if (!session || session.owner !== key(context)) throw new WorkbenchHttpError(404, 'RECORDING_NOT_FOUND', 'Recording not found'); return session; };
  return {
    async start(context, input) {
      if (!canUseCapability(context.ownAccess, 'uor.prepare')) throw new WorkbenchHttpError(403, 'COMMAND_FORBIDDEN', 'Recording requires preparation capability');
      const source = input.sourceRef.entityType === 'source_definition' ? repository.readPublishedHead<SourceDefinition>({ entityType: input.sourceRef.entityType, id: input.sourceRef.id }) : null;
      if (!source || source.revision !== input.sourceRef.revision || source.kind !== 'qlik') throw new WorkbenchHttpError(409, 'SOURCE_CHANGED', 'Choose the current published OKO source');
      const profile = await profiles.getOwn(context, source.id);
      if (!profile.configured || !profile.profile) throw new WorkbenchHttpError(409, 'BROWSER_CONFIGURATION_REQUIRED', 'Configure your own browser profile');
      const handle = await runtime.startRecording({ owner: owner(context), profile: profile.profile, startUrl: input.startUrl, authenticatedSelector: input.authenticatedSelector }, new AbortController().signal);
      const timer = setTimeout(() => sessions.delete(handle.handleId), 30 * 60_000); timer.unref();
      sessions.set(handle.handleId, { owner: key(context), timer }); return { recordingId: handle.handleId, state: 'recording' };
    },
    async finish(context, input) {
      const session = find(context, input.recordingId);
      if (input.save) throw new WorkbenchHttpError(422, 'SCENARIO_REVIEW_REQUIRED', 'Review parameters and export before saving a shared draft');
      session.result ??= await runtime.finish({ handleId: input.recordingId, owner: owner(context), save: false }); return structuredClone(session.result);
    },
    async screenshot(context, recordingId, handleId) {
      const session = find(context, recordingId);
      if (!session.result?.screenshotHandles.includes(handleId)) throw new WorkbenchHttpError(404, 'SCREENSHOT_NOT_FOUND', 'Screenshot not found');
      return runtime.screenshot({ recordingId, owner: owner(context), handleId });
    },
  };
}
