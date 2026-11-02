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
import { cancelRecording, executeBrowser, replayBrowserLogin, recordBrowserLogin, ownedBrowserLoginContext, retainBrowserLogin, finishRecording, observeBrowserLogin, readRecordingScreenshot, startRecording, waitForRecordingComplete, type BrowserLauncherPort } from './browser';
import { ConnectorError, type BrowserStep, type PrivateProfile } from './contracts';
import type { Downloaded } from './transport';
export type { BrowserLauncherPort } from './browser';
export type BrowserOwner = { installationId: UUIDv4; profilePersonId: UUIDv4 | null };
export type BrowserLoginInput = { owner: BrowserOwner; profile: PrivateProfile; startUrl: string; authenticatedSelector: string };
type PreparationBinding = { preparationId?: UUIDv4; preparationRevision?: string; loginHandleId?: UUIDv4; allowFreshContext?: boolean };
export type BrowserMarkerInput = { owner: BrowserOwner; profile: PrivateProfile; startUrl: string } & PreparationBinding;
export type BrowserRecordInput = BrowserLoginInput & PreparationBinding & { capture?: import('./workbench-capture-contracts').BrowserCapture };
export type BrowserReplayInput = { owner: BrowserOwner; profile: PrivateProfile; scenario: BrowserScenarioDefinition; capture?: import('./workbench-capture-contracts').BrowserCapture; /** Trusted source-service job id; never accepted from a public command payload. */ operationId?: UUIDv4 } & PreparationBinding;
export type BrowserPreparationStatus = { state: 'missing' | 'ready'; expiresAt: string | null };
export type BrowserSessionHandle = { handleId: UUIDv4; state: 'open'; mode: 'login' | 'record' };
export type RecordedBrowserScenario = { recordingId: UUIDv4; startUrl: string; authenticatedSelector: string; steps: RecordedBrowserStep[]; parameterNames: string[]; screenshotHandles: UUIDv4[]; hasDownload: boolean };
export interface BrowserRuntimePort {
  readRecordingStatus?(input: { owner: BrowserOwner; handleId: UUIDv4 }): Promise<BrowserRecordingStatus>;
  selectMarker?(input: BrowserMarkerInput, signal: AbortSignal): Promise<{ selector: string; label: string }>;
  readPreparation?(input: BrowserLoginInput & { preparationId: UUIDv4; preparationRevision?: string }): Promise<BrowserPreparationStatus>;
  discardPreparation?(input: { owner: BrowserOwner; preparationId: UUIDv4 }): Promise<void>;
  prepareLogin?(input: BrowserLoginInput & { preparationId: UUIDv4; preparationRevision?: string; loginHandleId: UUIDv4 }): Promise<BrowserPreparationStatus>;
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
  selectMarker(input: BrowserMarkerInput, signal: AbortSignal): Promise<{ selector: string; label: string }>;
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
export type BrowserRuntimeLifecycle={assertIdle():void;pause():Promise<void>;resume():void;shutdown():Promise<void>};
export function createBrowserRuntime({ runtimeRoot, launcher }: { runtimeRoot: string; launcher?: BrowserLauncherPort }): BrowserWorkflowRuntimePort & BrowserRuntimeLifecycle {
  const handles = new Map<string, { owner: string; root: string; recorderId: string; input: BrowserLoginInput; mode: 'login' | 'record' }>();
  // Capabilities never enter a workflow DTO, storage row, job payload or archive.
  const prepared = new Map<string, { handleId: UUIDv4; expiresAt: number; revision?: string }>();
  // A never-prepared legacy source may use its existing persistent profile.
  // Closed, expired and deliberately discarded preparations require an explicit
  // new login. A successful replay can separately permit a NEW server operation
  // to check the same persistent profile; it never revives a consumed capability.
  const knownPreparations = new Set<string>();
  type ReplayHistory = { consumedOperations: Set<UUIDv4>; generation: number; completed?: { input: BrowserLoginInput; revision?: string } };
  const replayHistory = new Map<string, ReplayHistory>();
  const invalidateReplayPermission = (key: string) => { const history = replayHistory.get(key); if (history) { history.generation++; delete history.completed; } };
  const preparationKey = (owner: BrowserOwner, id: UUIDv4) => `${browserOwnerKey(owner)}/${uuidSchema.parse(id)}`;
  const continuesLogin = (input: { owner: BrowserOwner } & PreparationBinding) => input.loginHandleId !== undefined || input.preparationId !== undefined && (!input.allowFreshContext || knownPreparations.has(preparationKey(input.owner, input.preparationId)));
  const forgetHandle = (id: string) => { handles.delete(id); for (const [key, value] of prepared) if (value.handleId === id) { prepared.delete(key); invalidateReplayPermission(key); } };
  const requireLogin = () => new ConnectorError('manual_login_required', 'Подготовленное окно закрыто или истекло. Выполните вход в личном окне браузера и продолжите запись.');
  const compatible = (handle: { input: BrowserLoginInput }, input: BrowserLoginInput) => handle.input.startUrl === input.startUrl && handle.input.authenticatedSelector === input.authenticatedSelector && JSON.stringify(handle.input.profile) === JSON.stringify(input.profile);
  const consumeLogin = (input: BrowserLoginInput & PreparationBinding) => {
    const entry = input.preparationId ? prepared.get(preparationKey(input.owner, input.preparationId)) : undefined;
    const handleId = input.loginHandleId ?? entry?.handleId;
    if (!handleId || !input.loginHandleId && entry!.expiresAt <= Date.now()) throw requireLogin();
    const handle = handles.get(handleId);
    if (!handle || handle.owner !== browserOwnerKey(input.owner) || handle.mode !== 'login') {
      if (!input.loginHandleId) throw requireLogin();
      throw new WorkbenchHttpError(404, 'BROWSER_HANDLE_NOT_FOUND', 'Own login context not found');
    }
    if (!compatible(handle, input)) throw new WorkbenchHttpError(409, 'BROWSER_CONTEXT_MISMATCH', 'Login context belongs to different report, marker or profile settings');
    if (!input.loginHandleId && entry?.revision !== input.preparationRevision) throw new WorkbenchHttpError(409, 'BROWSER_CONTEXT_MISMATCH', 'Prepared source revision changed');
    // Exact owner/settings validation precedes consumption. A foreign or stale
    // handle cannot retire another user's live preparation or active recording.
    forgetHandle(handleId); return handle;
  };
  const recordingsToDispose=new Map<string,{root:string;owner:string}>();
  const finished = new Map<string, { owner: string; root: string; recorderId: string; result: RecordedBrowserScenario; timer: NodeJS.Timeout }>();
  const pending = new Set<{ owner: string; controller: AbortController; settled: Promise<void> }>();
  const closing = new Set<string>();
  const retentionTimers=new Set<NodeJS.Timeout>();
  const nativeContexts=new Set<import('playwright').BrowserContext>();
  let accepting=true,disposed=false;
  const assertAccepting=()=>{if(!accepting||disposed)throw new DOMException('Browser runtime is stopping','AbortError');};
  const trackedLauncher:BrowserLauncherPort={requiresProfileLease:launcher?.requiresProfileLease??!launcher,async launchPersistent(profile,folder,options){
    assertAccepting();
    const context=launcher?await launcher.launchPersistent(profile,folder,options):await (await import('playwright')).chromium.launchPersistentContext(folder,options);
    nativeContexts.add(context);context.once('close',()=>nativeContexts.delete(context));
    if(!accepting||disposed){await context.close();throw new DOMException('Browser runtime is stopping','AbortError');}
    return context;
  }};
  const open = async (input: BrowserRecordInput, signal: AbortSignal, mode: 'login' | 'record'): Promise<BrowserSessionHandle> => {
    assertAccepting(); signal.throwIfAborted(); const owner = browserOwnerKey(input.owner);
    if (closing.has(owner)) throw new DOMException('Owner browser sessions are closing', 'AbortError');
    const controller = new AbortController(); let settled!: () => void;
    const request = { owner, controller, settled: new Promise<void>(resolve => { settled = resolve; }) }; pending.add(request);
    const ownedSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const root = await browserOwnerRoot(runtimeRoot, input.owner), handleId = randomUUID(); ownedSignal.throwIfAborted();
      const onClosed = () => { if (mode === 'login') forgetHandle(handleId); else { const timer = setTimeout(() => {const handle=handles.get(handleId);forgetHandle(handleId);retentionTimers.delete(timer);if(handle){recordingsToDispose.delete(handle.recorderId);void disposeWorkbenchRecording(handle.root,handle.owner,handle.recorderId).catch(()=>{});}}, 15 * 60_000); retentionTimers.add(timer);timer.unref(); } };
      const options = { launcher:trackedLauncher, signal: ownedSignal, workbenchRecording: mode === 'record', phase:mode==='login'?'login' as const:'report' as const,capture:input.capture, onCaptured:input.capture?async (download: Downloaded)=>{download.captureReceipt=await input.capture!.sink.commit(download);}:undefined };
      let result;
      if (mode === 'record' && continuesLogin(input)) {
        const login = consumeLogin(input);
        try { result = await recordBrowserLogin(owner, login.recorderId, input.profile, input.startUrl, input.authenticatedSelector, onClosed, options); }
        finally { recordingsToDispose.delete(login.recorderId); }
      } else result = await startRecording(root, owner, input.profile, input.startUrl, mode === 'record', input.authenticatedSelector, onClosed, options);
      recordingsToDispose.set(result.recordingId,{root,owner});
      ownedSignal.throwIfAborted(); handles.set(handleId, { owner, root, recorderId: result.recordingId, input: structuredClone({owner:input.owner,profile:input.profile,startUrl:input.startUrl,authenticatedSelector:input.authenticatedSelector}), mode });
      return { handleId, state: 'open', mode };
    } finally { pending.delete(request); settled(); }
  };
  const runtime: BrowserWorkflowRuntimePort & BrowserRuntimeLifecycle = {
    assertIdle(){if(pending.size||nativeContexts.size||handles.size)throw new WorkbenchHttpError(409,'BROWSER_ACTIVE','BROWSER_ACTIVE: завершите открытый браузер или запись перед обновлением');},
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
      recordingsToDispose.clear();prepared.clear();for(const key of replayHistory.keys())invalidateReplayPermission(key);
    },
    resume(){if(!disposed)accepting=true;},
    async shutdown(){disposed=true;await runtime.pause();},
    async cancelRecording({ handleId, owner }) {
      const handle = handles.get(handleId);
      if (!handle || handle.owner !== browserOwnerKey(owner)) throw new WorkbenchHttpError(404, 'BROWSER_HANDLE_NOT_FOUND', 'Browser session not found');
      await cancelRecording(handle.root, handle.owner, handle.recorderId); await disposeWorkbenchRecording(handle.root,handle.owner,handle.recorderId);recordingsToDispose.delete(handle.recorderId);forgetHandle(handleId);
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
      let retained: string | undefined;
      try {
        const ownedSignal = AbortSignal.any([signal, controller.signal]); ownedSignal.throwIfAborted();
        if (!input.preparationId) return await selectBrowserReportMarker({ ...input, runtimeRoot, signal: ownedSignal, launcher:trackedLauncher });
        const key = preparationKey(input.owner, input.preparationId), prior = prepared.get(key);
        if (input.loginHandleId) {
          const login = handles.get(input.loginHandleId);
          if (!login || login.owner !== owner || login.mode !== 'login') throw new WorkbenchHttpError(404, 'BROWSER_HANDLE_NOT_FOUND', 'Own login context not found');
          if (login.input.startUrl !== input.startUrl || JSON.stringify(login.input.profile) !== JSON.stringify(input.profile)) throw new WorkbenchHttpError(409, 'BROWSER_CONTEXT_MISMATCH', 'Login context belongs to different report or profile settings');
          retained = input.loginHandleId;
        }
        if (!retained && prior && prior.expiresAt > Date.now() && prior.revision === input.preparationRevision) {
          const login = handles.get(prior.handleId);
          if (login?.owner === owner && login.mode === 'login' && login.input.startUrl === input.startUrl && JSON.stringify(login.input.profile) === JSON.stringify(input.profile)) retained = prior.handleId;
        }
        if (retained === prior?.handleId) prepared.delete(key);
        else await runtime.discardPreparation!({ owner: input.owner, preparationId: input.preparationId });
        if (!retained) retained = (await open({ ...input, authenticatedSelector: 'html' }, ownedSignal, 'login')).handleId;
        const handle = handles.get(retained)!;
        const context = ownedBrowserLoginContext(owner, handle.recorderId, input.startUrl);
        knownPreparations.add(key);
        const marker = await selectBrowserReportMarker({ ...input, runtimeRoot, signal: ownedSignal, launcher: trackedLauncher, existingContext: context });
        ownedSignal.throwIfAborted();
        const expiresAt = retainBrowserLogin(owner, handle.recorderId, input.startUrl);
        handle.input.authenticatedSelector = marker.selector;
        // The previous login capability is consumed by marker selection too.
        // Workflow retry cleanup may retire that old id without closing this
        // newly prepared, exclusively process-local capability.
        forgetHandle(retained); retained = randomUUID(); handles.set(retained, handle);
        const preparedHandleId = retained; context.once('close', () => forgetHandle(preparedHandleId));
        prepared.set(key, { handleId: retained, expiresAt, revision: input.preparationRevision });
        return marker;
      } catch (error) { if (retained && handles.get(retained)?.owner === owner) await runtime.cancelRecording({ owner: input.owner, handleId: retained }).catch(() => {}); throw error; }
      finally { pending.delete(request); settled(); }
    },
    async discardPreparation({ owner, preparationId }) {
      const key = preparationKey(owner, preparationId), value = prepared.get(key); knownPreparations.add(key); prepared.delete(key); invalidateReplayPermission(key);
      if (value && handles.get(value.handleId)?.owner === browserOwnerKey(owner)) await runtime.cancelRecording({ owner, handleId: value.handleId });
    },
    async prepareLogin(input) {
      assertAccepting();
      const owner = browserOwnerKey(input.owner), handle = handles.get(input.loginHandleId);
      if (!handle || handle.owner !== owner || handle.mode !== 'login') throw new WorkbenchHttpError(404, 'BROWSER_HANDLE_NOT_FOUND', 'Own login context not found');
      if (!compatible(handle, input)) throw new WorkbenchHttpError(409, 'BROWSER_CONTEXT_MISMATCH', 'Login context belongs to different report, marker or profile settings');
      const context = ownedBrowserLoginContext(owner, handle.recorderId, input.startUrl);
      if (!await observeBrowserLogin(owner, handle.recorderId, input.profile, input.authenticatedSelector, input.startUrl)) throw requireLogin();
      const expiresAt = retainBrowserLogin(owner, handle.recorderId, input.startUrl);
      await runtime.discardPreparation!({ owner: input.owner, preparationId: input.preparationId });
      assertAccepting();
      if (closing.has(owner) || handles.get(input.loginHandleId) !== handle) throw new DOMException('Browser login is closing', 'AbortError');
      ownedBrowserLoginContext(owner, handle.recorderId, input.startUrl);
      forgetHandle(input.loginHandleId);
      const handleId = randomUUID(); handles.set(handleId, handle); context.once('close', () => forgetHandle(handleId));
      prepared.set(preparationKey(input.owner, input.preparationId), { handleId, expiresAt, revision: input.preparationRevision });
      return { state: 'ready', expiresAt: new Date(expiresAt).toISOString() };
    },
    async readPreparation(input) {
      const value = prepared.get(preparationKey(input.owner, input.preparationId)), handle = value ? handles.get(value.handleId) : undefined;
      if (!value || !handle || handle.owner !== browserOwnerKey(input.owner) || !compatible(handle, input) || value.revision !== input.preparationRevision || value.expiresAt <= Date.now()) return { state: 'missing', expiresAt: null };
      try { ownedBrowserLoginContext(handle.owner, handle.recorderId, input.startUrl); if (!await observeBrowserLogin(handle.owner, handle.recorderId, input.profile, input.authenticatedSelector, input.startUrl)) return { state: 'missing', expiresAt: null }; }
      catch { return { state: 'missing', expiresAt: null }; }
      return { state: 'ready', expiresAt: new Date(value.expiresAt).toISOString() };
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
      const operationId = input.operationId === undefined ? undefined : uuidSchema.parse(input.operationId);
      if (closing.has(owner)) throw new DOMException('Owner browser sessions are closing', 'AbortError');
      const controller=new AbortController();let settled!:()=>void;
      const request={owner,controller,settled:new Promise<void>(resolve=>{settled=resolve;})};pending.add(request);
      try {
        const ownedSignal=AbortSignal.any([signal,controller.signal]);ownedSignal.throwIfAborted();
        const recipe={id:scenario.id,startUrl:scenario.startUrl,steps:[]},options={launcher:trackedLauncher,authenticatedSelector:scenario.authenticatedSelector,workbenchSteps:scenario.steps,phase:'report' as const,capture:input.capture,onCaptured:input.capture?async (download:Downloaded)=>{download.captureReceipt=await input.capture!.sink.commit(download);}:undefined};
        if(continuesLogin(input)){
          const loginInput = { owner: input.owner, profile: input.profile, startUrl: scenario.startUrl, authenticatedSelector: scenario.authenticatedSelector };
          const key = input.preparationId && operationId && input.allowFreshContext ? preparationKey(input.owner, input.preparationId) : undefined;
          const previous = key ? replayHistory.get(key) : undefined;
          // A new operation verifies auth afresh in the persistent profile. A
          // live/expired preparation takes priority, and every old operation id
          // remains consumed even after subsequent successful operations.
          if (key && operationId && !input.loginHandleId && !prepared.has(key) && previous?.completed && !previous.consumedOperations.has(operationId) && previous.completed.revision === input.preparationRevision && compatible({ input: previous.completed.input }, loginInput)) {
            previous.consumedOperations.add(operationId);
            return await executeBrowser(await browserOwnerRoot(runtimeRoot,input.owner),input.profile,recipe,scenario.parameters,ownedSignal,options);
          }
          const handle=consumeLogin({...input,...loginInput});
          const history: ReplayHistory | undefined = key ? replayHistory.get(key) ?? { consumedOperations: new Set<UUIDv4>(), generation: 0 } : undefined;
          if (key && history && operationId) { replayHistory.set(key, history); history.consumedOperations.add(operationId); delete history.completed; }
          const generation = history?.generation;
          try {
            const download = await replayBrowserLogin(owner,handle.recorderId,input.profile,recipe,scenario.parameters,ownedSignal,options);
            // A cancellation/new preparation while export was running cannot be
            // overwritten by the completion of that earlier operation.
            if (history && history.generation === generation && !ownedSignal.aborted && accepting && !closing.has(owner)) history.completed = { input: structuredClone(loginInput), revision: input.preparationRevision };
            return download;
          }
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
      for (const scope of replayHistory.keys()) if (scope.startsWith(key + '/')) invalidateReplayPermission(scope);
      try {
        const requests = [...pending].filter(request => request.owner === key); for (const request of requests) request.controller.abort();
        await Promise.all(requests.map(request => request.settled));
        for (const [handleId, handle] of [...handles]) if (handle.owner === key) {
          const completed = await cancelRecording(handle.root, handle.owner, handle.recorderId).catch(() => false);
          if (completed) await runtime.finish({ handleId, owner, save: false }).catch(() => {}); else {await disposeWorkbenchRecording(handle.root,handle.owner,handle.recorderId);recordingsToDispose.delete(handle.recorderId);forgetHandle(handleId);}
        }
      } finally { closing.delete(key); }
    },
  };
  return runtime;
}
