import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BrowserScenarioDefinition, RecordedBrowserStep, UUIDv4 } from '../../domain/workbench';
import { browserScenarioDefinitionSchema, uuidSchema } from '../../domain/workbench';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { safeArtifactPath } from '../../server/workspace/paths';
import { cancelRecording, executeBrowser, finishRecording, readRecordingScreenshot, startRecording, waitForRecordingComplete, type BrowserLauncherPort } from './browser';
import { type BrowserStep, type PrivateProfile } from './contracts';
import type { Downloaded } from './transport';
export type { BrowserLauncherPort } from './browser';
export type BrowserOwner = { installationId: UUIDv4; profilePersonId: UUIDv4 | null };
export type BrowserLoginInput = { owner: BrowserOwner; profile: PrivateProfile; startUrl: string; authenticatedSelector: string };
export type BrowserRecordInput = BrowserLoginInput;
export type BrowserReplayInput = { owner: BrowserOwner; profile: PrivateProfile; scenario: BrowserScenarioDefinition };
export type BrowserSessionHandle = { handleId: UUIDv4; state: 'open'; mode: 'login' | 'record' };
export type RecordedBrowserScenario = { recordingId: UUIDv4; startUrl: string; authenticatedSelector: string; steps: RecordedBrowserStep[]; parameterNames: string[]; screenshotHandles: UUIDv4[]; hasDownload: boolean };
export interface BrowserRuntimePort {
  openLogin(input: BrowserLoginInput, signal: AbortSignal): Promise<BrowserSessionHandle>;
  startRecording(input: BrowserRecordInput, signal: AbortSignal): Promise<BrowserSessionHandle>;
  finish(input: { handleId: UUIDv4; owner: BrowserOwner; save: boolean }): Promise<RecordedBrowserScenario>;
  replay(input: BrowserReplayInput, signal: AbortSignal): Promise<Downloaded>;
  screenshot(input: { recordingId: UUIDv4; owner: BrowserOwner; handleId: UUIDv4 }): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }>;
  waitForCompletion(input: { handleId: UUIDv4; owner: BrowserOwner }): Promise<RecordedBrowserScenario>;
  closeOwned(owner: BrowserOwner): Promise<void>;
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
export function createBrowserRuntime({ runtimeRoot, launcher }: { runtimeRoot: string; launcher?: BrowserLauncherPort }): BrowserRuntimePort {
  const handles = new Map<string, { owner: string; root: string; recorderId: string; input: BrowserLoginInput }>();
  const finished = new Map<string, { owner: string; root: string; recorderId: string; result: RecordedBrowserScenario; timer: NodeJS.Timeout }>();
  const pending = new Set<{ owner: string; controller: AbortController; settled: Promise<void> }>();
  const closing = new Set<string>();
  const open = async (input: BrowserLoginInput, signal: AbortSignal, mode: 'login' | 'record'): Promise<BrowserSessionHandle> => {
    signal.throwIfAborted(); const owner = browserOwnerKey(input.owner);
    if (closing.has(owner)) throw new DOMException('Owner browser sessions are closing', 'AbortError');
    const controller = new AbortController(); let settled!: () => void;
    const request = { owner, controller, settled: new Promise<void>(resolve => { settled = resolve; }) }; pending.add(request);
    const ownedSignal = AbortSignal.any([signal, controller.signal]);
    try {
      const root = await browserOwnerRoot(runtimeRoot, input.owner), handleId = randomUUID(); ownedSignal.throwIfAborted();
      const result = await startRecording(root, owner, input.profile, input.startUrl, mode === 'record', input.authenticatedSelector,
        () => { if (mode === 'login') handles.delete(handleId); else { const timer = setTimeout(() => handles.delete(handleId), 15 * 60_000); timer.unref(); } }, { launcher, signal: ownedSignal, workbenchRecording: mode === 'record' });
      ownedSignal.throwIfAborted(); handles.set(handleId, { owner, root, recorderId: result.recordingId, input });
      return { handleId, state: 'open', mode };
    } finally { pending.delete(request); settled(); }
  };
  const runtime: BrowserRuntimePort = {
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
        const timer = setTimeout(() => finished.delete(handleId), 15 * 60_000); timer.unref();
        finished.set(handleId, { owner: handle.owner, root: handle.root, recorderId: handle.recorderId, result: recorded, timer }); return structuredClone(recorded);
      } finally { handles.delete(handleId); }
    },
    async replay(input, signal) {
      const scenario = browserScenarioDefinitionSchema.parse(input.scenario);
      return executeBrowser(await browserOwnerRoot(runtimeRoot, input.owner), input.profile, { id: scenario.id, startUrl: scenario.startUrl, steps: [] }, scenario.parameters, signal, { launcher, authenticatedSelector: scenario.authenticatedSelector, workbenchSteps: scenario.steps });
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
          if (completed) await runtime.finish({ handleId, owner, save: false }).catch(() => {}); else handles.delete(handleId);
        }
      } finally { closing.delete(key); }
    },
  };
  return runtime;
}
