import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Clock, VersionRef } from '../../domain/workbench/primitives';
import { newUuid, versionRefSchema, utcInstantSchema } from '../../domain/workbench/primitives';
import type { SourceDefinition } from '../../domain/workbench/entities';
import type { CommandContext } from '../../server/workbench/command-registry';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import { stableJson } from '../../server/workbench/command-store';
import { createJobStore } from '../../server/workbench/jobs';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { assertFileName, defaultFileLimits } from '../../server/workbench/files';
import { canUseCapability } from '../identity/workbench-access-policy';
import { parseWorkbenchTable, WorkbenchParserError, type ParsedSourceTable } from '../tabular-import/workbench-parser';
import { ConnectorError, connectorError } from './contracts';
import { checkedUrl } from './transport';
import type { BrowserProfileService } from './workbench-browser-profile';
import type { BrowserScenarioService } from './workbench-browser-scenarios';
import type { BrowserLoginService } from './workbench-browser-commands';
import type { BrowserOwner, BrowserRuntimePort } from './workbench-browser-runtime';
import type { BrowserScenarioRuntimePort, CaptureRequest, NormalizerPort, SourceAdapter, SourceIssue } from './workbench-source-contracts';
import type { ResolvedCaptureBinding, SourceStore } from './workbench-source-store';
import { normalizeParsedWorkbenchTable } from './workbench-source-normalizer';

const fail = (code: string, status = 422): never => { throw new WorkbenchHttpError(status, code, code); };
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const hash = (value: unknown) => 'sha256:' + createHash('sha256').update(stableJson(value)).digest('hex');
const ownerOf = (context: CommandContext): BrowserOwner => ({ installationId: context.installationId, profilePersonId: context.ownAccess.personId });
function assertContext(context: CommandContext, repository = context.repository) {
  if (context.repository !== repository || context.actor.installationId !== context.installationId || context.actor.profilePersonId !== context.ownAccess.personId) return fail('COMMAND_CONTEXT_MISMATCH', 409);
  if (!canUseCapability(context.ownAccess, 'capture.local')) return fail('ACCESS_DENIED', 403);
}
function mappedError(error: unknown): WorkbenchHttpError {
  if (error instanceof WorkbenchHttpError) return error;
  if (error instanceof ConnectorError && 'diagnosticCode' in error && (error.diagnosticCode === 'SELECTOR_NOT_FOUND' || error.diagnosticCode === 'SELECTOR_NOT_UNIQUE')) return new WorkbenchHttpError(422, error.diagnosticCode, 'Record the changed report element again');
  if (error instanceof WorkbenchParserError || error instanceof z.ZodError) return new WorkbenchHttpError(422, 'SOURCE_SCHEMA_CHANGED', 'The export format differs from the published mapping');
  const code = error instanceof ConnectorError ? error.code : connectorError(error).code;
  return new WorkbenchHttpError(422, ({ configuration_required: 'BROWSER_CONFIGURATION_REQUIRED', manual_required: 'AUTH_REQUIRED', manual_login_required: 'AUTH_REQUIRED', access_denied: 'SOURCE_ACCESS_DENIED', network: 'SOURCE_UNAVAILABLE', certificate: 'SOURCE_CERTIFICATE_REQUIRED', timeout: 'SOURCE_TIMEOUT', format: 'SOURCE_SCHEMA_CHANGED', incomplete: 'DOWNLOAD_REQUIRED', cancelled: 'SOURCE_CANCELLED' } as const)[code], 'Browser collection did not complete');
}
export interface BrowserSourceAdapter extends SourceAdapter, NormalizerPort {
  /** Trusted server binding, never part of the command payload. State is scoped to the job. */
  prepare(context: CommandContext, request: CaptureRequest, binding: ResolvedCaptureBinding, store: SourceStore): void;
  verify(request: CaptureRequest): Promise<void>;
  release(request: CaptureRequest): void;
}
export function createBrowserSourceAdapter({ runtime, profiles, scenarios, clock }: { runtime: BrowserScenarioRuntimePort; profiles: BrowserProfileService; scenarios: BrowserScenarioService; clock: Clock }): BrowserSourceAdapter {
  type Prepared = { context: CommandContext; request: CaptureRequest; binding: ResolvedCaptureBinding; store: SourceStore; scenario: ReturnType<BrowserScenarioService['resolvePublished']>; profileRevision?: string | null; table?: ParsedSourceTable; evidenceExpiresAt?: string };
  const pending = new Map<string, Prepared>();
  const get = (request: CaptureRequest) => { const value = pending.get(request.operationId); if (!value || !same(value.request, request)) return fail('SOURCE_BATCH_MISMATCH', 409); return value; };
  const profileFor = async (value: Prepared) => {
    assertContext(value.context); const profile = await profiles.getOwn(value.context, value.binding.source.id);
    if (!profile.configured || !profile.profile) return fail('BROWSER_CONFIGURATION_REQUIRED', 409);
    checkedUrl(value.scenario.startUrl, profile.profile);
    if (value.profileRevision !== undefined && value.profileRevision !== profile.revision) return fail('SOURCE_CONFIGURATION_CHANGED', 409);
    value.profileRevision = profile.revision; return profile.profile;
  };
  const adapter: BrowserSourceAdapter = {
    prepare(context, request, binding, store) {
      assertContext(context);
      if (pending.has(request.operationId)) return fail('SOURCE_OPERATION_BUSY', 409);
      const scenario = scenarios.resolvePublished(request.sourceRef);
      if (!same(binding.sourceRef, request.sourceRef) || !same(binding.mappingRef, request.mappingRef) || binding.goal.id !== request.goalRef.id || scenario.sourceId !== binding.source.id) return fail('SOURCE_BATCH_MISMATCH', 409);
      pending.set(request.operationId, { context: { ...context, actor: structuredClone(context.actor), ownAccess: structuredClone(context.ownAccess) }, request: structuredClone(request), binding: structuredClone(binding), store, scenario: structuredClone(scenario) });
    },
    async check(request) {
      try { await profileFor(get(request)); return { status: 'ready', issues: [] }; }
      catch (error) { const problem = mappedError(error); const issue: SourceIssue = { code: problem.code, stage: problem.code === 'AUTH_REQUIRED' ? 'browser.auth' : 'browser.check', retryable: problem.code === 'AUTH_REQUIRED', message: problem.message, rowKeys: [], refs: [{ entityType: 'source_definition', id: request.sourceRef.id }] }; return { status: problem.code === 'AUTH_REQUIRED' ? 'auth_required' : 'invalid_configuration', issues: [issue] }; }
    },
    async collect(request, signal) {
      try {
        const prepared = get(request), profile = await profileFor(prepared), owner = ownerOf(prepared.context), started = clock.now(); signal.throwIfAborted();
        const download = await runtime.replay({ owner, profile, scenario: structuredClone(prepared.scenario) }, signal); signal.throwIfAborted();
        if (!(download?.bytes instanceof Uint8Array) || !download.bytes.length) return fail('DOWNLOAD_REQUIRED');
        const bytes = Buffer.from(download.bytes);
        if (bytes.length > Math.min(profile.maxBytes, defaultFileLimits.goalImportBytes)) return fail('SOURCE_SCHEMA_CHANGED');
        try { assertFileName(download.name); } catch { return fail('SOURCE_SCHEMA_CHANGED'); }
        if (!download.name.toLowerCase().endsWith('.' + prepared.scenario.expectedExport.format)) return fail('SOURCE_SCHEMA_CHANGED');
        if (!prepared.binding.mapping.parsingProfile) return fail('SOURCE_INVALID_CONFIGURATION');
        const table = await parseWorkbenchTable({ bytes, name: download.name, parsingProfile: prepared.binding.mapping.parsingProfile }); signal.throwIfAborted();
        if (prepared.scenario.expectedExport.requiredColumns.some(column => !table.columns.includes(column))) return fail('SOURCE_SCHEMA_CHANGED');
        const normalized = normalizeParsedWorkbenchTable({ table, mapping: prepared.binding.mapping });
        const payloadHash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
        const binding = { owner, sourceRef: request.sourceRef, mappingRef: request.mappingRef, scenarioHash: hash(prepared.scenario), payloadHash };
        const evidence = await runtime.inspectExport?.(binding, signal); signal.throwIfAborted();
        if (!evidence) return fail('EXPORT_COVERAGE_UNVERIFIED');
        const { publishedAssignment, observedAt, expiresAt, selectionVerified, allPagesExported, reportedRows, ...received } = evidence;
        if (!same(binding, received) || !versionRefSchema.safeParse(publishedAssignment).success || !same(publishedAssignment, prepared.binding.assignmentRef) || !utcInstantSchema.safeParse(observedAt).success || !utcInstantSchema.safeParse(expiresAt).success || selectionVerified !== true || allPagesExported !== true || reportedRows !== table.rows.length || Date.parse(observedAt) < Date.parse(started) || Date.parse(observedAt) > Date.parse(clock.now()) || Date.parse(expiresAt) <= Date.parse(clock.now()) || Date.parse(expiresAt) > Date.parse(observedAt) + 600000) return fail('EXPORT_COVERAGE_UNVERIFIED');
        prepared.evidenceExpiresAt = expiresAt;
        await adapter.verify(request); signal.throwIfAborted();
        const artifact = prepared.store.saveArtifact({ installationId: prepared.context.installationId, personId:prepared.context.ownAccess.personId, artifactId: newUuid(), mimeType: table.format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytesValue: bytes });
        prepared.table = table;
        return { operationId: request.operationId, sourceRef: request.sourceRef, mappingRef: request.mappingRef, capturedAt: clock.now(), sourceUpdatedAt: null, rawRows: normalized.rawRows, artifact, payloadHash, coverage: { complete: true, expectedRows: reportedRows, receivedRows: table.rows.length, evidence: [stableJson(evidence)] }, issues: [] };
      } catch (error) { throw mappedError(error); }
    },
    normalize({ raw, mapping }) {
      const prepared = pending.get(raw.operationId); if (!prepared?.table || !same(mapping, prepared.binding.mapping)) return fail('SOURCE_BATCH_MISMATCH');
      const normalized = normalizeParsedWorkbenchTable({ table: prepared.table, mapping });
      if (!same(raw.rawRows, normalized.rawRows)) return fail('SOURCE_BATCH_MISMATCH');
      return { rows: normalized.canonicalRows, issues: normalized.issues };
    },
    async verify(request) { const prepared = get(request); await profileFor(prepared); prepared.store.assertUnchanged(prepared.binding, prepared.context.installationId); if (prepared.evidenceExpiresAt && Date.parse(prepared.evidenceExpiresAt) <= Date.parse(clock.now())) return fail('EXPORT_COVERAGE_UNVERIFIED'); if (!same(scenarios.resolvePublished(request.sourceRef), prepared.scenario)) return fail('SOURCE_CONFIGURATION_CHANGED', 409); },
    release(request) { pending.delete(request.operationId); },
  };
  return adapter;
}

export function createBrowserLoginService({ runtime, profiles, scenarios, repository }: { runtime: BrowserRuntimePort; profiles: BrowserProfileService; scenarios: BrowserScenarioService; repository: WorkbenchRepository }): BrowserLoginService & {dispose():void} {
  const handles = new Map<string, { owner: BrowserOwner; sourceRef: VersionRef; scenario: ReturnType<BrowserScenarioService['resolvePublished']>; profileRevision: string | null }>();
  const current = (sourceRef: VersionRef) => { const source = repository.readPublishedHead<SourceDefinition>({ entityType: sourceRef.entityType, id: sourceRef.id }); if (!source || !same({ entityType: 'source_definition', id: source.id, revision: source.revision }, sourceRef)) return fail('SOURCE_CONFIGURATION_CHANGED', 409); return scenarios.resolvePublished(sourceRef); };
  return {
    dispose(){handles.clear();},
    async open(context, { sourceRef }) {
      assertContext(context, repository); const scenario = current(sourceRef), owner = ownerOf(context);
      const profile = await profiles.getOwn(context, scenario.sourceId); if (!profile.profile || !profile.configured) return fail('BROWSER_CONFIGURATION_REQUIRED', 409);
      checkedUrl(scenario.startUrl, profile.profile);
      const opened = await runtime.openLogin({ owner, profile: profile.profile, startUrl: scenario.startUrl, authenticatedSelector: scenario.authenticatedSelector }, AbortSignal.timeout(120000));
      try { if (!same(current(sourceRef), scenario) || (await profiles.getOwn(context, scenario.sourceId)).revision !== profile.revision) return fail('SOURCE_CONFIGURATION_CHANGED', 409); }
      catch (error) { await runtime.finish({ handleId: opened.handleId, owner, save: false }).catch(() => {}); throw error; }
      handles.set(opened.handleId, { owner, sourceRef: structuredClone(sourceRef), scenario, profileRevision: profile.revision });
      return { loginId: opened.handleId, windowOpened: true };
    },
    async finish(context, { loginId }) {
      assertContext(context, repository); const handle = handles.get(loginId); if (!handle || !same(handle.owner, ownerOf(context))) return fail('BROWSER_HANDLE_NOT_FOUND', 404);
      const verify = async () => { if (!same(current(handle.sourceRef), handle.scenario) || (await profiles.getOwn(context, handle.scenario.sourceId)).revision !== handle.profileRevision) return fail('SOURCE_CONFIGURATION_CHANGED', 409); };
      try {
      await verify(); const authenticated = await runtime.observeLogin?.({ owner: handle.owner, handleId: loginId }) ?? false;
      await verify();
      if (authenticated) {
        await runtime.finish({ owner: handle.owner, handleId: loginId, save: false }); handles.delete(loginId); await verify();
        // Only the original private capture checkpoints can receive the retry action.
        // This facade shares the existing SQLite job journal; it creates no new job.
        const jobs = createJobStore({ repository, clock: context.clock });
        for (const { snapshot, name } of jobs.recoveryCandidates(context.installationId)) {
          if (name !== 'source.capture' || snapshot.status !== 'waiting_user' || snapshot.stage !== 'browser.auth') continue;
          const prepared = jobs.checkpoints(snapshot.jobId, context.installationId).find(value => value.kind === 'browser.capture');
          if (!prepared || !same(prepared.owner, handle.owner) || !same((prepared.request as CaptureRequest | undefined)?.sourceRef, handle.sourceRef)) continue;
          jobs.update(snapshot.jobId, { warnings: [], nextAction: { commandName: 'job.retry', payload: { jobId: snapshot.jobId }, route: null, label: 'Повторить получение', enabled: snapshot.retryAvailable, disabledReason: snapshot.retryAvailable ? null : 'RETRY_NOT_AVAILABLE' } });
        }
      }
      return { loginId, authenticated };
      } catch (error) { handles.delete(loginId); await runtime.finish({ owner: handle.owner, handleId: loginId, save: false }).catch(() => {}); throw error; }
    },
  };
}
