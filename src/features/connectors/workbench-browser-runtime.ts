import { disposeWorkbenchRecording, readWorkbenchRecordingStatus, readWorkbenchRecordingDownload } from './workbench-browser-recorder';
import { selectBrowserReportMarker } from './workbench-browser-picker';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BrowserScenarioDefinition, RecordedBrowserStep, UUIDv4 } from '../../domain/workbench';
import { browserScenarioDefinitionSchema, uuidSchema } from '../../domain/workbench';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { safeArtifactPath } from '../../server/workspace/paths';
import { cancelRecording, executeBrowser, replayBrowserLogin, finishRecording, observeBrowserLogin, readRecordingScreenshot, startRecording, waitForRecordingComplete, type BrowserLauncherPort } from './browser';
import { type BrowserStep, type PrivateProfile } from './contracts';
import type { Downloaded } from './transport';
export type { BrowserLauncherPort } from './browser';
export type BrowserOwner = { installationId: UUIDv4; profilePersonId: UUIDv4 | null };
export type BrowserLoginInput = { owner: BrowserOwner; profile: PrivateProfile; startUrl: string; authenticatedSelector: string };
export type BrowserRecordInput = BrowserLoginInput;
export type BrowserReplayInput = { owner: BrowserOwner; profile: PrivateProfile; scenario: BrowserScenarioDefinition; loginHandleId?: UUIDv4 };
export type BrowserSessionHandle = { handleId: UUIDv4; state: 'open'; mode: 'login' | 'record' };
export type RecordedBrowserScenario = { recordingId: UUIDv4; startUrl: string; authenticatedSelector: string; steps: RecordedBrowserStep[]; parameterNames: string[]; screenshotHandles: UUIDv4[]; hasDownload: boolean };
export interface BrowserRuntimePort {
  readRecordingStatus?(input: { owner: BrowserOwner; handleId: UUIDv4 }): Promise<BrowserRecordingStatus>;
  selectMarker?(input: { owner: BrowserOwner; profile: PrivateProfile; startUrl: string }, signal: AbortSignal): Promise<{ selector: string; label: string }>;
  cancelRecording?(input: { owner: BrowserOwner; handleId: UUIDv4 }): Promise<void>;
  /** A live owned report-boundary observation, never cookie/window-close evidence. */
  observeLogin?(input: { handleId: UUIDv4; owner: BrowserOwner }): Promise<boolean>;
  openLogin(input: BrowserLoginInput, signal: AbortSignal): Promise<BrowserSessionHandle>;
  startRecording(input: BrowserRecordInput, signal: AbortSignal): Promise<BrowserSessionHandle>;
  finish(input: { handleId: UUIDv4; owner: BrowserOwner; save: boolean }): Promise<RecordedBrowserScenario>;
  replay(input: BrowserReplayInput, signal: AbortSignal): Promise<Downloaded>;
  screenshot(input: { recordingId: UUIDv4; owner: BrowserOwner; handleId: UUIDv4 }): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }>;
  waitForCompletion(input: { handleId: UUIDv4; owner: BrowserOwner }): Promise<RecordedBrowserScenario>;
  closeOwned(owner: BrowserOwner): Promise<void>;
}
export type BrowserRecordingStatus = { state: 'idle' | 'recording' | 'completed' | 'failed' | 'interrupted'; problem: { code: string; message: string } | null };
export interface BrowserWorkflowRuntimePort extends BrowserRuntimePort {
  cancelRecording(input: { owner: BrowserOwner; handleId: UUIDv4 }): Promise<void>;
  readRecordingStatus(input: { owner: BrowserOwner; handleId: UUIDv4 }): Promise<BrowserRecordingStatus>;
  readRecordingDownload(input: { owner: BrowserOwner; handleId: UUIDv4 }): Promise<Downloaded>;
  selectMarker(input: { owner: BrowserOwner; profile: PrivateProfile; startUrl: string }, signal: AbortSignal): Promise<{ selector: string; label: string }>;
}
const ownerSchema = z.strictObject({ installationId: uuidSchema, profilePersonId: uuidSchema.nullable() });
export function browserOwnerKey(owner: BrowserOwner): string { const valid = ownerSchema.parse(owner); return `${valid.installationId}/${valid.profilePersonId ?? 'unassigned'}`; }
export async function browserOwnerRoot(runtimeRoot: string, owner: BrowserOwner): Promise<string> {
  const relative = `workbench-browser/${browserOwnerKey(owner)}`;
  let checked = runtimeRoot;
  for (const part of relative.split('/')) {
    checked = path.join(checked, part);
    try { const entry = await lstat(checked); if (entry.isSymbolicLink() || !entry.isDirectory()) throw new WorkbenchHttpError(422, 'BROWSER_CONFIGURATION_INVALID', 'Browser owner directory must not be a link'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const root = await safeArtifactPath(runtimeRoot, relative); await mkdir(root, { recursive: true }); return root;
}
function fromLegacy(step: BrowserStep): RecordedBrowserStep {
  if (step.action === 'goto') return step;
  const { selector, ...rest } = step;
  return { ...rest, locator: { kind: 'css', selector } };
}
export type BrowserRuntimeLifecycle={pause():Promise<void>;resume():void;shutdown():Promise<void>};
export function createBrowserRuntime({ runtimeRoot, launcher }: { runtimeRoot: string; launcher?: BrowserLauncherPort }): BrowserWorkflowRuntimePort & BrowserRuntimeLifecycle {
  const handles = new Map<string, { owner: string; root: string; recorderId: string; input: BrowserLoginInput; mode: 'login' | 'record' }>();
  const recordingsToDispose=new Map<string,{root:string;owner:string}>();
  const finished = new Map<string, { owner: string; root: string; recorderId: string; result: RecordedBrowserScenario; timer: NodeJS.Timeout }>();
  const pending = new Set<{ owner: string; controller: AbortController; settled: Promise<void> }>();
  const closing = new Set<string>();
  const retentionTimers=new Set<NodeJS.Timeout>();
  const nativeContexts=new Set<import('playwright').BrowserContext>();
  let accepting=true,disposed=false;
  const assertAccepting=()=>{if(!accepting||disposed)throw new DOMException('Browser runtime is stopping','AbortError');};
  const trackedLauncher:BrowserLauncherPort={async launchPersistent(profile,folder,options){
    assertAccepting();
    const context=launcher?await launcher.launchPersistent(profile,folder,options):await (await import('playwright')).chromium.launchPersistentContext(folder,options);
    nativeContexts.add(context);context.once('close',()=>nativeContexts.delete(context));
    if(!accepting||disposed){await context.close();throw new DOMException('Browser runtime is stopping','AbortError');}
    return context;
  }};
  const open = async (input: BrowserLoginInput, signal: AbortSignal, mode: 'login' | 'record'): Promise<BrowserSessionHandle> => {
    assertAccepting(); signal.throwIfAborted(); const owner = browserOwnerKey(input.owner);
    if (closing.has(owner)) throw new DOMException('Owner browser sessions are closing', 'AbortError');
    const controller = new AbortController(); let settled!: () => void;
    const request = { owner, controller, settled: new Promise<void>(resolve => { settled = resolve; }) }; pending.add(request);
    const ownedSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const root = await browserOwnerRoot(runtimeRoot, input.owner), handleId = randomUUID(); ownedSignal.throwIfAborted();
      const result = await startRecording(root, owner, input.profile, input.startUrl, mode === 'record', input.authenticatedSelector,
        () => { if (mode === 'login') handles.delete(handleId); else { const timer = setTimeout(() => {const handle=handles.get(handleId);handles.delete(handleId);retentionTimers.delete(timer);if(handle){recordingsToDispose.delete(handle.recorderId);void disposeWorkbenchRecording(handle.root,handle.owner,handle.recorderId).catch(()=>{});}}, 15 * 60_000); retentionTimers.add(timer);timer.unref(); } }, { launcher:trackedLauncher, signal: ownedSignal, workbenchRecording: mode === 'record' });
      recordingsToDispose.set(result.recordingId,{root,owner});
      ownedSignal.throwIfAborted(); handles.set(handleId, { owner, root, recorderId: result.recordingId, input: structuredClone(input), mode });
      return { handleId, state: 'open', mode };
    } finally { pending.delete(request); settled(); }
  };
  const runtime: BrowserWorkflowRuntimePort & BrowserRuntimeLifecycle = {
    async pause(){
      accepting=false;
      const requests=[...pending];for(const request of requests)request.controller.abort();
      await Promise.all([...nativeContexts].map(context=>context.close()));
      await Promise.all(requests.map(request=>request.settled));
      for(const timer of retentionTimers)clearTimeout(timer);retentionTimers.clear();
      for(const [id,handle] of [...handles]){
        await cancelRecording(handle.root,handle.owner,handle.recorderId).catch(()=>false);
        await disposeWorkbenchRecording(handle.root,handle.owner,handle.recorderId);handles.delete(id);
      }
      for(const [id,handle] of [...finished]){clearTimeout(handle.timer);finished.delete(id);}
      for(const [id,record] of recordingsToDispose)await disposeWorkbenchRecording(record.root,record.owner,id);
      recordingsToDispose.clear();
    },
    resume(){if(!disposed)accepting=true;},
    async shutdown(){disposed=true;await runtime.pause();},
    async cancelRecording({ handleId, owner }) {
      const handle = handles.get(handleId);
      if (!handle || handle.owner !== browserOwnerKey(owner)) throw new WorkbenchHttpError(404, 'BROWSER_HANDLE_NOT_FOUND', 'Browser session not found');
      await cancelRecording(handle.root, handle.owner, handle.recorderId); await disposeWorkbenchRecording(handle.root,handle.owner,handle.recorderId);recordingsToDispose.delete(handle.recorderId);handles.delete(handleId);
    },
    async observeLogin({ handleId, owner }) {
      const handle = handles.get(handleId);
      if (!handle || handle.owner !== browserOwnerKey(owner)) throw new WorkbenchHttpError(404, 'BROWSER_HANDLE_NOT_FOUND', 'Browser session not found');
      return observeBrowserLogin(handle.owner, handle.recorderId, handle.input.profile, handle.input.authenticatedSelector, handle.input.startUrl);
    },
    async readRecordingStatus({ handleId, owner }) {
      const key = browserOwnerKey(owner), cached = finished.get(handleId);
      if (cached?.owner === key) return { state: cached.result.hasDownload ? 'completed' : 'idle', problem: null };
      const handle = handles.get(handleId);
      if (!handle || handle.owner !== key) return { state: 'interrupted', problem: { code: 'BROWSER_HANDLE_NOT_FOUND', message: 'Сессия браузера отсутствует или прервана' } };
      return readWorkbenchRecordingStatus(handle.root, handle.owner, handle.recorderId);
    },
    async readRecordingDownload({ handleId, owner }) {
      const key = browserOwnerKey(owner), handle = handles.get(handleId) ?? finished.get(handleId);
      if (!handle || handle.owner !== key) throw new WorkbenchHttpError(404, 'BROWSER_HANDLE_NOT_FOUND', 'Browser session not found');
      return readWorkbenchRecordingDownload(handle.root, key, handle.recorderId);
    },
    async selectMarker(input, signal) {
      assertAccepting(); const owner = browserOwnerKey(input.owner);
      if (closing.has(owner)) throw new DOMException('Owner browser sessions are closing', 'AbortError');
      const controller = new AbortController(); let settled!: () => void;
      const request = { owner, controller, settled: new Promise<void>(resolve => { settled = resolve; }) }; pending.add(request);
      try { return await selectBrowserReportMarker({ ...input, runtimeRoot, signal: AbortSignal.any([signal, controller.signal]), launcher:trackedLauncher }); }
      finally { pending.delete(request); settled(); }
    },
    openLogin: (input, signal) => open(input, signal, 'login'), startRecording: (input, signal) => open(input, signal, 'record'),
    async finish({ handleId, owner, save }) {
      if (save) throw new WorkbenchHttpError(422, 'SCENARIO_REVIEW_REQUIRED', 'Review and save through the scenario draft service');
      const cached = finished.get(handleId);
      if (cached?.owner === browserOwnerKey(owner)) return structuredClone(cached.result);
      const handle = handles.get(handleId);
      if (!handle || handle.owner !== browserOwnerKey(owner)) throw new WorkbenchHttpError(404, 'BROWSER_HANDLE_NOT_FOUND', 'Browser session not found');
      // Shared acceptance belongs to the scenario draft service, never the runtime.
      try { const result = await finishRecording(handle.root, handle.owner, handle.recorderId, false); const steps = result.workbenchSteps ?? result.scenario.steps.map(fromLegacy);
        const recorded: RecordedBrowserScenario = { recordingId: handleId, startUrl: handle.input.startUrl, authenticatedSelector: handle.input.authenticatedSelector, steps,
          parameterNames: result.parameters, screenshotHandles: Array.from({ length: result.screenshotCount }, () => randomUUID()), hasDownload: result.completedDownload === true };
        const timer = setTimeout(() => {finished.delete(handleId);recordingsToDispose.delete(handle.recorderId);void disposeWorkbenchRecording(handle.root,handle.owner,handle.recorderId).catch(()=>{});}, 15 * 60_000); timer.unref();
        finished.set(handleId, { owner: handle.owner, root: handle.root, recorderId: handle.recorderId, result: recorded, timer }); return structuredClone(recorded);
      } finally { handles.delete(handleId); }
    },
    async replay(input, signal) {
      assertAccepting(); const scenario = browserScenarioDefinitionSchema.parse(input.scenario),owner=browserOwnerKey(input.owner);
      if (closing.has(owner)) throw new DOMException('Owner browser sessions are closing', 'AbortError');
      const controller=new AbortController();let settled!:()=>void;
      const request={owner,controller,settled:new Promise<void>(resolve=>{settled=resolve;})};pending.add(request);
      try {
        const ownedSignal=AbortSignal.any([signal,controller.signal]);ownedSignal.throwIfAborted();
        const recipe={id:scenario.id,startUrl:scenario.startUrl,steps:[]},options={launcher:trackedLauncher,authenticatedSelector:scenario.authenticatedSelector,workbenchSteps:scenario.steps};
        if(input.loginHandleId!==undefined){
          const handle=handles.get(input.loginHandleId);
          if(!handle||handle.owner!==owner||handle.mode!=='login')throw new WorkbenchHttpError(404,'BROWSER_HANDLE_NOT_FOUND','Own login context not found');
          if(handle.input.startUrl!==scenario.startUrl||handle.input.authenticatedSelector!==scenario.authenticatedSelector||JSON.stringify(handle.input.profile)!==JSON.stringify(input.profile))throw new WorkbenchHttpError(409,'BROWSER_CONTEXT_MISMATCH','Login context belongs to different report or profile settings');
          // Consume the capability once, without releasing its existing native queue lease.
          handles.delete(input.loginHandleId);
          try{return await replayBrowserLogin(owner,handle.recorderId,input.profile,recipe,scenario.parameters,ownedSignal,options);}
          finally{recordingsToDispose.delete(handle.recorderId);await disposeWorkbenchRecording(handle.root,owner,handle.recorderId);}
        }
        return await executeBrowser(await browserOwnerRoot(runtimeRoot,input.owner),input.profile,recipe,scenario.parameters,ownedSignal,options);
      }
      finally {pending.delete(request);settled();}
    },
    async screenshot({ recordingId, owner, handleId }) {
      const record = finished.get(recordingId), index = record?.result.screenshotHandles.indexOf(handleId) ?? -1;
      if (!record || record.owner !== browserOwnerKey(owner) || index < 0) throw new WorkbenchHttpError(404, 'SCREENSHOT_NOT_FOUND', 'Screenshot not found');
      return { bytes: await readRecordingScreenshot(record.root, record.owner, record.recorderId, index), mediaType: 'image/png' };
    },
    async waitForCompletion({ handleId, owner }) {
      const record = handles.get(handleId);
      if (!record || record.owner !== browserOwnerKey(owner)) {
        const cached = finished.get(handleId); if (cached?.owner === browserOwnerKey(owner)) return structuredClone(cached.result);
        throw new WorkbenchHttpError(404, 'BROWSER_HANDLE_NOT_FOUND', 'Browser session not found');
      }
      await waitForRecordingComplete(record.root, record.owner, record.recorderId); return runtime.finish({ handleId, owner, save: false });
    },
    async closeOwned(owner) {
      const key = browserOwnerKey(owner); closing.add(key);
      try {
        const requests = [...pending].filter(request => request.owner === key); for (const request of requests) request.controller.abort();
        await Promise.all(requests.map(request => request.settled));
        for (const [handleId, handle] of [...handles]) if (handle.owner === key) {
          const completed = await cancelRecording(handle.root, handle.owner, handle.recorderId).catch(() => false);
          if (completed) await runtime.finish({ handleId, owner, save: false }).catch(() => {}); else {await disposeWorkbenchRecording(handle.root,handle.owner,handle.recorderId);recordingsToDispose.delete(handle.recorderId);handles.delete(handleId);}
        }
      } finally { closing.delete(key); }
    },
  };
  return runtime;
}
