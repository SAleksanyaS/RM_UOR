// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createWorkbenchApp } from '../../../server/workbench/app';
import { createCommandRegistry } from '../../../server/workbench/command-registry';
import { createJobStore } from '../../../server/workbench/jobs';
import { QueryRegistry } from '../../../server/workbench/query-registry';
import { createFileStore, defaultFileLimits } from '../../../server/workbench/files';
import { createLocalSessionStore } from '../../../server/workbench/session';
import { createBrowserProfileService } from '../workbench-browser-profile';
import { createOkoWorkflowService } from '../workbench-workflow-service';
import { createOkoWorkflowModule } from '../workbench-workflow-module';
import type { BrowserWorkflowRuntimePort } from '../workbench-browser-runtime';
import type { AccessPolicyService } from '../../identity/workbench-access-policy';
import { OkoClient } from './client';
import { WorkbenchProvider, useWorkbench } from './WorkbenchProvider';
import { WorkbenchBrowserScenarioWizard } from './BrowserScenarioWizard';

afterEach(() => { cleanup(); sessionStorage.clear(); });
function Probe({ capture }: { capture(value: ReturnType<typeof useWorkbench>): void }) { const state = useWorkbench(); capture(state); return <p>{state.current?.title ?? 'empty'}</p>; }

for (const recovery of ['retry', 'reload'] as const) it(`recovers the real SQLite command receipt after accepted response loss by ${recovery}`, async () => {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'uor-oko-recovery-'));
  const repository = createWorkbenchRepository({ filename: path.join(root, 'state.sqlite'), artifactRoot: root });
  const clock = { now: () => '2026-10-28T10:00:00Z' }, installationId = randomUUID();
  let own = { role: 'curator' as const, personId: randomUUID(), displayName: 'Test owner', policyState: 'verified' as const, checkedAt: clock.now() };
  const accessPolicy: AccessPolicyService = { resolveOwnAccess: async () => own, assertCommandAllowed: async () => own, assertFreshPublishAllowed: async () => { throw Error('No external writes'); } };
  const jobs = createJobStore({ repository, clock }), commands = createCommandRegistry({ repository, jobs, accessPolicy });
  const files = createFileStore({ directory: path.join(root, 'files'), limits: defaultFileLimits });
  const profiles = createBrowserProfileService({ runtimeRoot: root, repository, clock });
  let selections = 0, jobReads = 0; let jobRead!: () => void; const firstJobRead = new Promise<void>(resolve => { jobRead = resolve; }); let finishSelection!: () => void; const selectionReady = new Promise<void>(resolve => { finishSelection = resolve; });
  const runtime = { selectMarker: async () => { selections++; await selectionReady; return { selector: '#report', label: 'Report ready' }; } } as unknown as BrowserWorkflowRuntimePort;
  const service = createOkoWorkflowService({ repository, files, profiles, jobs, clock, runtime });
  const app = await createWorkbenchApp({ repository, clock, hostname: () => 'test-host', installationId, accessPolicy, jobs, commands, files, queries: new QueryRegistry(), modules: [createOkoWorkflowModule({ service })], sessions: createLocalSessionStore({ clock }), allowedOrigins: ['http://127.0.0.1:5173'] });
  let cookie = '', lose = '', lostCommand = '', commandRequests = 0;
  const fetcher = (async (url, init) => {
    if (String(url).includes('/jobs/')) { jobReads++; jobRead(); }
    const response = await app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url: String(url), headers: { host: '127.0.0.1:4174', origin: 'http://127.0.0.1:5173', ...Object.fromEntries(new Headers(init?.headers).entries()), ...(cookie ? { cookie } : {}) }, ...(init?.body ? { payload: String(init.body) } : {}), remoteAddress: '127.0.0.1' });
    const setCookie = response.headers['set-cookie']; if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    if (String(url) === '/api/v1/commands') {
      commandRequests++; const request = JSON.parse(String(init?.body));
      if (request.name === lose && response.statusCode < 400) { lostCommand = request.commandId; lose = ''; throw new TypeError('Accepted response lost'); }
    }
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  let state!: ReturnType<typeof useWorkbench>;
  const mount = () => render(<WorkbenchProvider client={new OkoClient(fetcher)}><Probe capture={value => { state = value; }}/></WorkbenchProvider>);
  let mounted = mount();
  try {
    await waitFor(() => expect(state.loading).toBe(false));
    lose = 'source.browser.workflow.open';
    await act(async () => { await expect(state.open(undefined, 'Recovered own report')).rejects.toMatchObject({ code: 'NETWORK_ERROR' }); });
    expect((await state.client.workspace()).workflows).toHaveLength(1);
    expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toContain(lostCommand);
    const requestsBeforeRecovery = commandRequests;
    if (recovery === 'reload') { mounted.unmount(); mounted = mount(); await waitFor(() => expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toBeNull()); }
    else await act(async () => { await expect(state.open(undefined, 'Recovered own report')).rejects.toMatchObject({ code: 'COMMAND_RECOVERED' }); });
    expect(state.current?.title).toBe('Recovered own report');
    expect((await state.client.workspace()).workflows).toHaveLength(1);
    expect(commandRequests).toBe(requestsBeforeRecovery);
    expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toBeNull();

    const w = state.current!;
    await act(async () => { await state.run('source.browser.profile.set', { workflowId: w.workflowId, expectedRevision: w.revision, reportUrl: 'https://report.example/', profile: { allowedOrigins: ['https://report.example'], timeoutMs: 5000, maxBytes: 100000, retries: 0, browser: { channel: 'msedge', profileDirectory: 'synthetic', headless: false } } }); });
    lose = 'source.browser.marker.select';
    await act(async () => { await expect(state.run('source.browser.marker.select', { workflowId: w.workflowId, reportUrl: 'https://report.example/' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' }); });
    await waitFor(() => expect(selections).toBe(1));
    const markerCommand = lostCommand, acceptedJob = jobs.findByCommand(markerCommand, installationId);
    expect(acceptedJob).not.toBeNull(); expect(selections).toBe(1);
    if (recovery === 'reload') { mounted.unmount(); mounted = mount(); await waitFor(() => expect(jobReads).toBeGreaterThan(0)); await act(async () => { finishSelection(); await commands.idle(); }); await waitFor(() => expect(state.current?.marker?.selector).toBe('#report'), { timeout: 4000 }); }
    else await act(async () => { const recovered = expect(state.run('source.browser.marker.select', { workflowId: w.workflowId, reportUrl: 'https://report.example/' })).rejects.toMatchObject({ code: 'COMMAND_RECOVERED' }); await firstJobRead; finishSelection(); await recovered; });
    expect(state.current?.marker?.selector).toBe('#report'); expect(selections).toBe(1);
    expect(jobs.findByCommand(markerCommand, installationId)?.jobId).toBe(acceptedJob?.jobId);
    expect(sessionStorage.getItem('uor.oko.pending-command.v1')).toBeNull();

    own = { ...own, personId: randomUUID() };
    await act(async () => { await state.refresh(); });
    expect(state.current).toBeNull();
    await expect(state.client.reconcileCommand(markerCommand)).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' });
  } finally { mounted.unmount(); await app.close(); repository.close(); const target = path.resolve(root); if (!target.startsWith(path.resolve(realpathSync.native(tmpdir())) + path.sep) || !path.basename(target).startsWith('uor-oko-recovery-')) throw Error('Invalid cleanup'); rmSync(target, { recursive: true, force: true }); }
});

it.each(['profile-read', 'native-start'] as const)('visible release reaches the actual API during held %s and preserves the completed result', async phase => {
  const root = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'uor-oko-release-'));
  const repository = createWorkbenchRepository({ filename: path.join(root, 'state.sqlite'), artifactRoot: root });
  const clock = { now: () => '2026-10-29T10:00:00Z' }, installationId = randomUUID();
  const own = { role: 'curator' as const, personId: randomUUID(), displayName: 'Test owner', policyState: 'verified' as const, checkedAt: clock.now() };
  const accessPolicy: AccessPolicyService = { resolveOwnAccess: async () => own, assertCommandAllowed: async () => own, assertFreshPublishAllowed: async () => { throw Error('No external writes'); } };
  const jobs = createJobStore({ repository, clock }), commands = createCommandRegistry({ repository, jobs, accessPolicy });
  const files = createFileStore({ directory: path.join(root, 'files'), limits: defaultFileLimits });
  const profiles = createBrowserProfileService({ runtimeRoot: root, repository, clock });
  let hold = false, enter!: () => void, unblock!: () => void, closed = 0, starts = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { unblock = resolve; });
  const gate = async () => { if (hold) { hold = false; enter(); await held; } };
  const getOwn = profiles.getOwn;
  if (phase === 'profile-read') profiles.getOwn = async (...args) => { await gate(); return getOwn(...args); };
  const handle = randomUUID(), bytes = Uint8Array.from(Buffer.from('ID,Value\r\nA,12.34'));
  const runtime = {
    selectMarker: async () => ({ selector: '#report', label: 'Report ready' }),
    startRecording: async () => { starts++; if (phase === 'native-start') await gate(); return { handleId: handle, state: 'open', mode: 'record' }; },
    readRecordingStatus: async () => ({ state: 'recording', problem: null }),
    finish: async () => ({ recordingId: handle, startUrl: 'https://report.example/', authenticatedSelector: '#report', steps: [{ action: 'download', locator: { kind: 'css', selector: '#download' } }], parameterNames: [], screenshotHandles: [], hasDownload: true }),
    readRecordingDownload: async () => ({ bytes, name: 'report.csv', contentType: 'text/csv' }),
    replay: async () => ({ bytes, name: 'report.csv', contentType: 'text/csv' }),
    closeOwned: async () => { closed++; },
  } as unknown as BrowserWorkflowRuntimePort;
  const service = createOkoWorkflowService({ repository, files, profiles, jobs, clock, runtime });
  const app = await createWorkbenchApp({ repository, clock, hostname: () => 'test-host', installationId, accessPolicy, jobs, commands, files, queries: new QueryRegistry(), modules: [createOkoWorkflowModule({ service })], sessions: createLocalSessionStore({ clock }), allowedOrigins: ['http://127.0.0.1:5173'] });

  let cookie = '', loseRelease = false;
  const sent: Array<{ name: string; commandId: string }> = [];
  const fetcher = (async (url, init) => {
    const request = String(url) === '/api/v1/commands' ? JSON.parse(String(init?.body)) : null;
    if (request) sent.push(request);
    const response = await app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url: String(url), headers: { host: '127.0.0.1:4174', origin: 'http://127.0.0.1:5173', ...Object.fromEntries(new Headers(init?.headers).entries()), ...(cookie ? { cookie } : {}) }, ...(init?.body ? { payload: String(init.body) } : {}), remoteAddress: '127.0.0.1' });
    const setCookie = response.headers['set-cookie']; if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    if (loseRelease && request?.name === 'source.browser.record.cancel' && response.statusCode < 400) { loseRelease = false; throw new TypeError('Release response lost'); }
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  let state!: ReturnType<typeof useWorkbench>;
  const mounted = render(<WorkbenchProvider client={new OkoClient(fetcher)}><Probe capture={value => { state = value; }}/><WorkbenchBrowserScenarioWizard/></WorkbenchProvider>);
  try {
    await waitFor(() => expect(state.loading).toBe(false));
    await act(async () => { await state.open(undefined, 'Release regression'); });
    await act(async () => { await state.run('source.browser.profile.set', { workflowId: state.current!.workflowId, expectedRevision: state.current!.revision, reportUrl: 'https://report.example/', profile: { allowedOrigins: ['https://report.example'], timeoutMs: 5000, maxBytes: 100000, retries: 0, browser: { channel: 'chrome', profileDirectory: 'synthetic', headless: false } } }); });
    await act(async () => { await state.run('source.browser.marker.select', { workflowId: state.current!.workflowId, reportUrl: 'https://report.example/' }); });
    const start = () => state.run('source.browser.record.start', { workflowId: state.current!.workflowId, expectedRevision: state.current!.revision, reportUrl: 'https://report.example/', parsingProfile: state.current!.parsingProfile });
    await act(async () => { await start(); });
    await act(async () => { await state.run('source.browser.record.finish', { workflowId: state.current!.workflowId, recordingId: handle }); });
    await waitFor(() => expect(state.busy).toBe(false));
    await act(async () => { await state.run('source.browser.mapping.save', { workflowId: state.current!.workflowId, expectedRevision: state.current!.revision, parameters: {}, parsingProfile: state.current!.parsingProfile, mapping: { rowKeyColumns: ['ID'], productKeyColumn: null, numberColumns: { value: 'Value' }, dimensionColumns: {}, dateColumn: null, unitColumn: null, fixedUnitCode: 'units' } }); });
    await act(async () => { await state.run('source.browser.record.test', { workflowId: state.current!.workflowId, expectedRevision: state.current!.revision }); });
    const before = state.current!; expect(before.result?.rowCount).toBe(1); const closedBefore = closed, startsBefore = starts;
    fireEvent.change(screen.getByLabelText('Адрес отчёта'), { target: { value: 'https://report.example/unsaved' } });
    hold = true; loseRelease = true;
    let running!: Promise<unknown>;
    await act(async () => { running = start().catch(error => error); await entered; });
    const originalId = sent.at(-1)!.commandId;
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть окна браузера и освободить профиль' }));
    await waitFor(() => expect(closed).toBeGreaterThan(closedBefore));
    expect(state.busy).toBe(true);
    const releaseRequest = sent.at(-1)!; expect(releaseRequest.name).toBe('source.browser.record.cancel');
    expect(Object.values(sessionStorage).join('')).toContain(originalId); expect(Object.values(sessionStorage).join('')).toContain(releaseRequest.commandId);
    await act(async () => { unblock(); await running; });
    await waitFor(() => expect(state.busy).toBe(false));
    expect(Object.values(sessionStorage).join('')).toContain(releaseRequest.commandId);
    const releasesBeforeRecovery = sent.filter(item => item.name === 'source.browser.record.cancel').length;
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть окна браузера и освободить профиль' }));
    await screen.findByText('Собственные окна автоматизации закрыты. Профиль освобождён.');
    expect(sent.filter(item => item.name === 'source.browser.record.cancel')).toHaveLength(releasesBeforeRecovery);
    expect(starts).toBe(startsBefore + (phase === 'native-start' ? 1 : 0));
    expect(state.current!.recording).toEqual(before.recording); expect(state.current!.result).toEqual(before.result); expect(state.current!.mapping).toEqual(before.mapping);
    expect((screen.getByLabelText('Адрес отчёта') as HTMLInputElement).value).toBe('https://report.example/unsaved');
    expect(Object.values(sessionStorage).join('')).not.toContain(releaseRequest.commandId);
  } finally {
    unblock(); mounted.unmount(); await commands.idle(); await app.close(); repository.close();
    const target = path.resolve(root); if (!target.startsWith(path.resolve(realpathSync.native(tmpdir())) + path.sep) || !path.basename(target).startsWith('uor-oko-release-')) throw Error('Invalid cleanup'); rmSync(target, { recursive: true, force: true });
  }
});
