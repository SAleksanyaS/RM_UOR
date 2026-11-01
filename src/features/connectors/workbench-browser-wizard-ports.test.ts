import { afterEach, expect, it } from 'vitest';
import { draftFixture, draftCleanups } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId } from '../../../tests/fixtures/workbench/factories';
import { createBrowserRecorderService } from './workbench-browser-recorder';
import { createBrowserProfileService } from './workbench-browser-profile';
import { registerBrowserQueries } from './workbench-browser-commands';
import { QueryRegistry } from '../../server/workbench/query-registry';
import type { BrowserWorkflowRuntimePort } from './workbench-browser-runtime';
import { privateProfileSchema } from './contracts';

afterEach(async () => { while (draftCleanups.length) await draftCleanups.pop()!(); });
async function fixture() {
  const f = draftFixture();
  const source = await f.open('source_definition');
  const saved = await f.execute('source.draft.save', { draftId: source.draftId, definition: { kind: 'qlik', goalId: f.input.goal.id, publicLocator: 'https://report.example.invalid/report', mappingRef: null } });
  const sourceRef = (saved.result as { versionRef: { entityType: string; id: string; revision: number } }).versionRef;
  const ownDraft = { packageId: f.packageId(), sourceDraftId: source.draftId, editToken: f.token()! };
  const profiles = createBrowserProfileService({ runtimeRoot: f.root, repository: f.repository, clock: f.clock });
  await profiles.set(f.context, { sourceId: source.objectId, profileId: 'own', expectedRevision: null, profile: privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { executablePath: process.execPath, profileDirectory: 'own' } }) });
  let finishCalls = 0;
  const runtime = { startRecording: async () => ({ handleId: fixtureId(600), state: 'open', mode: 'record' }), selectMarker: async () => ({ selector: '#report', label: 'Отчёт' }), readRecordingStatus: async () => ({ state: 'recording', problem: null }), finish: async () => { finishCalls++; return { recordingId: fixtureId(600), startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#report', steps: [], parameterNames: [], screenshotHandles: [], hasDownload: false }; } } as unknown as BrowserWorkflowRuntimePort;
  const recorder = createBrowserRecorderService({ repository: f.repository, runtime, profiles, jobs: f.jobs, clock: f.clock, drafts: f.service });
  const queries = new QueryRegistry(); registerBrowserQueries(queries, { profiles, recorder, drafts: f.service });
  const input = { sourceRef, ownDraft, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#report' };
  return { ...f, profiles, recorder, queries, input, finishCalls: () => finishCalls };
}
it('reads and records only an exact own unpublished source binding without publishing it', async () => {
  const f = await fixture();
  const own = await f.queries.execute('source.browser.own', { context: null, filter: { sourceRef: f.input.sourceRef, ownDraft: f.input.ownDraft }, sort: [], page: { limit: 50, cursor: null } }, f.context);
  expect(own).toMatchObject({ configured: true });
  expect(await f.recorder.selectMarker(f.context, f.input)).toEqual({ selector: '#report', label: 'Отчёт' });
  const started = await f.recorder.start(f.context, f.input);
  expect(await f.recorder.status(f.context, started.recordingId)).toEqual({ state: 'recording', problem: null });
  expect(f.finishCalls()).toBe(0);
  expect(f.repository.readPublishedHead({ entityType: 'source_definition', id: f.input.sourceRef.id })).toBeNull();
});
it('rejects foreign package, stale source/version/CAS and readers before browser access', async () => {
  const f = await fixture();
  for (const patch of [{ ownDraft: { ...f.input.ownDraft, packageId: fixtureId(991) } }, { ownDraft: { ...f.input.ownDraft, editToken: 'stale' } }, { sourceRef: { ...f.input.sourceRef, revision: 99 } }]) await expect(f.recorder.start(f.context, { ...f.input, ...patch })).rejects.toBeDefined();
  await expect(f.recorder.start({ ...f.context, ownAccess: { ...f.context.ownAccess, role: 'viewer' } }, f.input)).rejects.toMatchObject({ statusCode: 403 });
  const started = await f.recorder.start(f.context, f.input);
  await f.open('metric_definition');
  await expect(f.recorder.finish(f.context, { recordingId: started.recordingId, save: false })).resolves.toMatchObject({ bindingProblem: 'REVISION_CONFLICT' });
  expect(f.finishCalls()).toBe(1);
});
it('rechecks personal profile revision and access at finish and denies foreign status', async () => {
  const f = await fixture(); const started = await f.recorder.start(f.context, f.input);
  await expect(f.recorder.status({ ...f.context, ownAccess: { ...f.context.ownAccess, personId: fixtureId(994) } }, started.recordingId)).rejects.toMatchObject({ statusCode: 404 });
  const own = await f.profiles.getOwn(f.context, f.input.sourceRef.id);
  await f.profiles.set(f.context, { sourceId: f.input.sourceRef.id, profileId: 'own', profile: { ...own.profile!, timeoutMs: 10000 }, expectedRevision: own.revision });
  await expect(f.recorder.finish(f.context, { recordingId: started.recordingId, save: false })).resolves.toMatchObject({ bindingProblem: 'SOURCE_CONFIGURATION_CHANGED' });
  expect(f.finishCalls()).toBe(1);
});
it('revocation preserves own status and private review while marking the recording ineligible for shared attachment', async () => {
  const f = await fixture(); const started = await f.recorder.start(f.context, f.input);
  f.context.ownAccess.role = 'viewer'; f.context.ownAccess.policyState = 'revoked';
  expect(await f.recorder.status(f.context, started.recordingId)).toMatchObject({ state: 'recording' });
  expect(await f.recorder.finish(f.context, { recordingId: started.recordingId, save: false })).toMatchObject({ recordingId: started.recordingId, bindingProblem: 'COMMAND_FORBIDDEN' });
  await expect(f.recorder.start(f.context, f.input)).rejects.toMatchObject({ statusCode: 403 });
});
