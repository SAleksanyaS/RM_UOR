import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { versionRefSchema, utcInstantSchema, uuidSchema, type Clock, type Header, type VersionRef } from '../../domain/workbench/primitives';
import { browserScenarioDefinitionSchema } from '../../domain/workbench/browser-scenario';
import { sourceDefinitionSchema, sourceFieldMappingSchema, goalAssignmentSchema, coreGoalDefinitionSchema, directoryEntitySchema, directoryLinkSchema } from '../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { QueryContext } from '../../server/workbench/query-registry';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { stableJson } from '../../server/workbench/command-store';
import type { BrowserProfileService } from './workbench-browser-profile';
import type { BrowserRuntimePort, BrowserOwner } from './workbench-browser-runtime';
import type { BrowserExportBinding, BrowserExportEvidence } from './workbench-source-contracts';
import { privateProfileSchema } from './contracts';
import { checkedUrl } from './transport';
import { validateBrowserExport } from './workbench-browser-export';
import { normalizeParsedWorkbenchTable } from './workbench-source-normalizer';
import { enrichSourceRows } from '../catalog/workbench-directory';
import { canUseCapability } from '../identity/workbench-access-policy';

const typedRef = (kind: string) => versionRefSchema.refine(value => value.entityType === kind);
export const okoBrowserProbeConfigSchema = z.strictObject({ profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/), sourceRef: typedRef('source_definition'), scenarioRef: typedRef('browser_scenario'), mode: z.enum(['check', 'record-replay']) });
const inputSchema = okoBrowserProbeConfigSchema.extend({ runtimeRoot: z.string().min(1).refine(value => path.isAbsolute(value)) });
export type OkoBrowserProbeInput = z.infer<typeof inputSchema>;
type Status = 'passed' | 'blocked' | 'failed';
export type OkoBrowserProbeResult = { status: Status; checkedAt: string; browser: { name: string; version: string | null }; runtime: { node: string; npm: string }; checks: { code: string; status: Status; message: string }[]; acceptedSourceBinding: boolean; privateEvidencePath: string | null };
export const okoBankRequiredChecks = ['BANK_BROWSER', 'BANK_MANUAL_AUTH', 'BANK_CANCEL_REOPEN', 'BANK_EXPIRED_REENTRY_RETRY', 'BANK_REVOKED_ACCESS', 'BANK_OFFLINE_CACHE', 'BANK_SELECTOR_CHANGE', 'BANK_FULL_EXPORT'] as const;
type TargetCheck = typeof okoBankRequiredChecks[number];
export type OkoTargetBinding = BrowserExportBinding & { runId: string; profileRevision: string | null; assignmentRef: VersionRef; assignmentHash: string; enrichedHash: string; rowCount: number };
/** Trusted reviewed target adapter only. Never create this port from JSON, HTTP, archives or env.
 * It must independently inspect actual target/operator evidence for this exact fresh run.
 * Browser names, caller bankVerified and successful local replay cannot implement it. */
export interface OkoTargetEvidenceVerifier {
  verify(binding: OkoTargetBinding, signal: AbortSignal): Promise<{ binding: OkoTargetBinding; observedAt: string; expiresAt: string; checks: { code: TargetCheck; status: Status }[] } | null>;
}
export interface OkoProbeTrustedPorts {
  /** Bootstrap's live current access and immutable installation identity, never entity.actor. */
  currentContext(): Promise<QueryContext>;
  profiles: Pick<BrowserProfileService, 'getOwn'>;
  operator?: { login(input: { handleId: string; signal: AbortSignal }): Promise<void>; record(input: { handleId: string; signal: AbortSignal }): Promise<void> };
  /** Native launch observation; public report only permits known names and numeric versions. */
  browser?(): { name: string; version: string | null };
  inspectExport?(binding: BrowserExportBinding, signal: AbortSignal): Promise<BrowserExportEvidence | null>;
  targetEvidence?: OkoTargetEvidenceVerifier;
}
type Deps = { runtime: BrowserRuntimePort; repository: WorkbenchRepository; clock: Clock; trusted?: OkoProbeTrustedPorts; signal?: AbortSignal };
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const hash = (value: unknown) => 'sha256:' + createHash('sha256').update(stableJson(value)).digest('hex');
const messages: Record<string, string> = {
  BLOCKED_BANK_INPUT: 'Install the reviewed target evidence adapter and provide authorized bank browser, report and operator evidence.',
  INPUT_REQUIRED: 'Provide a strict private configuration with an own profile and exact published references.',
  TRUSTED_CONTEXT_REQUIRED: 'Use the trusted local runtime composition to resolve current ownership and access.',
  CURRENT_ACCESS_REQUIRED: 'Recheck the current own access before using the personal browser profile.',
  RECORDING_FORBIDDEN: 'The current own access does not permit scenario recording; use an authorized curator profile.',
  RECOVERY_REQUIRED: 'The managed active database is missing or invalid; restore it through the normal recovery procedure.',
  PROFILE_REQUIRED: 'Configure this source in the current user’s own browser profile.',
  PUBLISHED_BINDING_REQUIRED: 'Select the exact current confirmed source, scenario, mapping and goal.',
  PROFILE_CHANGED: 'The profile, access or published configuration changed; start a new probe.',
  CONFIGURATION_READY: 'The current own profile and exact published configuration are valid.',
  OPERATOR_REQUIRED: 'Provide explicit local operator login and recording completion actions.',
  AUTH_REQUIRED: 'Complete manual sign-in and verify the configured live report marker.',
  LOGIN_OBSERVED: 'The runtime observed the configured live report marker after manual sign-in.',
  RECORDING_COMPLETE: 'The owned recorder completed an actual download event.',
  RECORDING_REQUIRED: 'Complete the owned recording with a download event.',
  EXPORT_SCHEMA: 'The downloaded file matches the published format, columns, keys, dates and numeric mapping.',
  EXPORT_INVALID: 'The download failed the published file, row, date or numeric contract.',
  EXPORT_COMPLETE: 'Full export selection, row count and expected population verification.',
  EXPORT_COVERAGE_REQUIRED: 'Provide fresh trusted export selection and all-pages evidence for this exact download.',
  TARGET_EVIDENCE_INVALID: 'Target evidence is absent, expired or does not match this run and all required checks.',
  WORKSPACE_BUSY: 'Another runtime owns this workspace; close it normally before the standalone probe.',
  CANCELLED: 'The probe was cancelled; previous accepted facts and the personal profile are preserved.',
  RUNTIME_FAILED: 'The owned browser operation did not complete; inspect the private local setup and retry.',
  CLEANUP_FAILED: 'An owned probe context did not close; close that probe window normally before retrying.',
};
class Stop extends Error { constructor(readonly code: string, readonly status: Status = 'blocked') { super(code); } }
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(new Stop('CANCELLED')); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); });
  try { return await Promise.race([pending, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
export async function createBlockedOkoBrowserProbe(code = 'INPUT_REQUIRED'): Promise<OkoBrowserProbeResult> {
  let npm = 'unobserved';
  try { const value = JSON.parse(await readFile(path.join(path.dirname(process.execPath), 'node_modules/npm/package.json'), 'utf8')).version; if (typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)) npm = value; } catch { /* No version guessing from environment strings. */ }
  return { status: 'blocked', checkedAt: new Date().toISOString(), browser: { name: 'unobserved', version: null }, runtime: { node: process.version, npm }, checks: [{ code: messages[code] ? code : 'INPUT_REQUIRED', status: 'blocked', message: messages[code] ?? messages.INPUT_REQUIRED }], acceptedSourceBinding: false, privateEvidencePath: null };
}
/** The only public view: no profile, path, source bytes, free-text exception or provider messages. */
export function publicOkoBrowserProbeReport(result: OkoBrowserProbeResult): Omit<OkoBrowserProbeResult, 'privateEvidencePath'> {
  const { privateEvidencePath: _private, ...view } = result;
  return { ...view, checks: view.checks.map(check => ({ ...check, message: messages[check.code] ?? 'Required target check has not been independently verified.' })) };
}
export async function probeOkoBrowser(unparsed: OkoBrowserProbeInput, deps: Deps): Promise<OkoBrowserProbeResult> {
  const report = await createBlockedOkoBrowserProbe(); report.checks = [];
  const add = (code: string, status: Status = 'passed') => report.checks.push({ code, status, message: messages[code] ?? 'Required target check has not been independently verified.' });
  let owner: BrowserOwner | undefined, launched = false;
  const ownedHandles = new Set<string>();
  const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000);
  try {
    const parsed = inputSchema.safeParse(unparsed); if (!parsed.success) throw new Stop('INPUT_REQUIRED');
    const input = parsed.data, trusted = deps.trusted; if (!trusted) throw new Stop('TRUSTED_CONTEXT_REQUIRED');
    report.checkedAt = utcInstantSchema.parse(deps.clock.now());
    const context = await trusted.currentContext();
    if (context.repository !== deps.repository || !uuidSchema.safeParse(context.installationId).success || !uuidSchema.safeParse(context.ownAccess.personId).success || !['verified', 'offline_cached', 'local_preview'].includes(context.ownAccess.policyState)) throw new Stop('CURRENT_ACCESS_REQUIRED');
    if (input.mode === 'record-replay' && !canUseCapability(context.ownAccess, 'uor.prepare')) throw new Stop('RECORDING_FORBIDDEN');
    owner = { installationId: context.installationId, profilePersonId: context.ownAccess.personId };
    const published = <T extends Header>(ref: VersionRef, schema: z.ZodType<T>): T => {
      const value = deps.repository.readPublishedHead<T>({ entityType: ref.entityType, id: ref.id });
      if (!value || !same({ entityType: ref.entityType, id: value.id, revision: value.revision }, ref) || !value.publicationAnchorId || deps.repository.readPublicationAnchor({ entityType: 'publication_anchor', id: value.publicationAnchorId })?.publicationState !== 'confirmed') throw new Stop('PUBLISHED_BINDING_REQUIRED');
      const valid = schema.safeParse(value); if (!valid.success) throw new Stop('PUBLISHED_BINDING_REQUIRED'); return valid.data;
    };
    const source = published(input.sourceRef, sourceDefinitionSchema), scenario = published(input.scenarioRef, browserScenarioDefinitionSchema);
    if (source.kind !== 'qlik' || !same(source.browserScenarioRef, input.scenarioRef) || scenario.sourceId !== source.id || !source.mappingRef) throw new Stop('PUBLISHED_BINDING_REQUIRED');
    const mappingRef = source.mappingRef, mapping = published(mappingRef, sourceFieldMappingSchema);
    const goalValue = deps.repository.readPublishedHead<Header>({ entityType: 'core_goal_definition', id: source.goalId });
    if (!goalValue) throw new Stop('PUBLISHED_BINDING_REQUIRED');
    const goalRef = { entityType: 'core_goal_definition', id: goalValue.id, revision: goalValue.revision }, goal = published(goalRef, coreGoalDefinitionSchema);
    if (goal.sourceId !== source.id || mapping.sourceId !== source.id || !mapping.parsingProfile) throw new Stop('PUBLISHED_BINDING_REQUIRED');
    const own = await trusted.profiles.getOwn(context, source.id);
    if (!own.configured || !own.profile || own.profileId !== input.profileId) throw new Stop('PROFILE_REQUIRED');
    const parsedProfile = privateProfileSchema.safeParse(own.profile); if (!parsedProfile.success) throw new Stop('PROFILE_REQUIRED');
    const profile = parsedProfile.data; try { checkedUrl(scenario.startUrl, profile); } catch { throw new Stop('PROFILE_REQUIRED'); }
    const ensureCurrent = async (requireVerified = false) => {
      signal.throwIfAborted(); const fresh = await trusted.currentContext();
      const validateFresh = () => {
        if (fresh.repository !== deps.repository || fresh.installationId !== owner!.installationId || fresh.ownAccess.personId !== owner!.profilePersonId || !['verified', 'offline_cached', 'local_preview'].includes(fresh.ownAccess.policyState)) throw new Stop('PROFILE_CHANGED');
        if (input.mode === 'record-replay' && !canUseCapability(fresh.ownAccess, 'uor.prepare')) throw new Stop('RECORDING_FORBIDDEN');
        if (requireVerified && fresh.ownAccess.policyState !== 'verified') throw new Stop('TARGET_EVIDENCE_INVALID');
      };
      validateFresh();
      const current = await trusted.profiles.getOwn(fresh, source.id);
      validateFresh();
      if (!current.configured || current.profileId !== input.profileId || current.revision !== own.revision || !same(current.profile, profile) || !same(published(input.sourceRef, sourceDefinitionSchema), source) || !same(published(input.scenarioRef, browserScenarioDefinitionSchema), scenario) || !same(published(mappingRef, sourceFieldMappingSchema), mapping) || !same(published(goalRef, coreGoalDefinitionSchema), goal)) throw new Stop('PROFILE_CHANGED');
    };
    await ensureCurrent(); add('CONFIGURATION_READY');
    if (input.mode === 'check') { add('OPERATOR_REQUIRED', 'blocked'); throw new Stop('BLOCKED_BANK_INPUT'); }
    if (!trusted.operator || !deps.runtime.observeLogin) throw new Stop('OPERATOR_REQUIRED');
    const loginInput = { owner, profile, startUrl: scenario.startUrl, authenticatedSelector: scenario.authenticatedSelector };
    launched = true;
    const login = await deps.runtime.openLogin(loginInput, signal); ownedHandles.add(login.handleId);
    await abortable(trusted.operator.login({ handleId: login.handleId, signal }), signal); await ensureCurrent();
    if (!await deps.runtime.observeLogin({ owner, handleId: login.handleId })) throw new Stop('AUTH_REQUIRED');
    await deps.runtime.finish({ owner, handleId: login.handleId, save: false }); ownedHandles.delete(login.handleId); add('LOGIN_OBSERVED');
    // A recording is private and reviewable. Never save a scenario/draft or accept a capture here.
    await ensureCurrent(); const recording = await deps.runtime.startRecording(loginInput, signal); ownedHandles.add(recording.handleId);
    await abortable(trusted.operator.record({ handleId: recording.handleId, signal }), signal);
    await ensureCurrent();
    const recorded = await abortable(deps.runtime.waitForCompletion({ owner, handleId: recording.handleId }), signal); ownedHandles.delete(recording.handleId); await ensureCurrent();
    if (!recorded.hasDownload || recorded.steps.at(-1)?.action !== 'download') throw new Stop('RECORDING_REQUIRED', 'failed'); add('RECORDING_COMPLETE');
    const started = deps.clock.now(); await ensureCurrent();
    const download = await deps.runtime.replay({ owner, profile, scenario }, signal); await ensureCurrent();
    let validated: Awaited<ReturnType<typeof validateBrowserExport>>, normalized: ReturnType<typeof normalizeParsedWorkbenchTable>;
    try {
      if (download.bytes.length > profile.maxBytes) throw Error();
      validated = await validateBrowserExport({ download, scenario, parsingProfile: mapping.parsingProfile });
      normalized = normalizeParsedWorkbenchTable({ table: validated.table, mapping });
      if (!normalized.canonicalRows.length || normalized.issues.length || normalized.canonicalRows.some(row => row.businessTime.kind === 'unknown' || row.unitCode === null || Object.values(row.numbers).some(value => value === null))) throw Error();
    } catch { throw new Stop('EXPORT_INVALID', 'failed'); } add('EXPORT_SCHEMA');
    const binding: BrowserExportBinding = { owner, sourceRef: input.sourceRef, mappingRef, scenarioHash: hash(scenario), payloadHash: 'sha256:' + validated.payloadHash };
    const evidence = await trusted.inspectExport?.(structuredClone(binding), signal); await ensureCurrent();
    if (!evidence) throw new Stop('EXPORT_COVERAGE_REQUIRED');
    const { publishedAssignment, observedAt, expiresAt, selectionVerified, allPagesExported, reportedRows, ...received } = evidence;
    const freshTimes = (observed: string, expires: string) => utcInstantSchema.safeParse(observed).success && utcInstantSchema.safeParse(expires).success && Date.parse(observed) >= Date.parse(started) && Date.parse(observed) <= Date.parse(deps.clock.now()) && Date.parse(expires) > Date.parse(deps.clock.now()) && Date.parse(expires) <= Date.parse(observed) + 600000;
    if (!same(binding, received) || !freshTimes(observedAt, expiresAt) || selectionVerified !== true || allPagesExported !== true || !Number.isSafeInteger(reportedRows) || reportedRows !== validated.table.rows.length || publishedAssignment.entityType !== 'goal_assignment') { add('EXPORT_COMPLETE', 'failed'); throw new Stop('EXPORT_COVERAGE_REQUIRED', 'failed'); }
    const assignment = published(publishedAssignment, goalAssignmentSchema);
    if (assignment.goalId !== goal.id || !assignment.expectedPopulation?.length) throw new Stop('PUBLISHED_BINDING_REQUIRED');
    const catalog = deps.repository.readPublishedCatalog(), entities = catalog.filter(row => row.entityType === 'directory_entity').map(row => published({ entityType: row.entityType, id: row.value.id, revision: row.value.revision }, directoryEntitySchema)), links = catalog.filter(row => row.entityType === 'directory_link').map(row => published({ entityType: row.entityType, id: row.value.id, revision: row.value.revision }, directoryLinkSchema));
    const enriched = enrichSourceRows({ capture: { sourceId: source.id, mappingRef, rawRows: normalized.rawRows, canonicalRows: normalized.canonicalRows }, mapping, directoryEntities: entities, directoryLinks: links });
    if (enriched.issues.length || enriched.rows.length !== reportedRows || enriched.rows.some(row => !row.scope || !assignment.expectedPopulation!.some(expected => same(expected, row.scope))) || assignment.expectedPopulation.some(expected => !enriched.rows.some(row => same(expected, row.scope)))) { add('EXPORT_COMPLETE', 'failed'); throw new Stop('EXPORT_COVERAGE_REQUIRED', 'failed'); }
    add('EXPORT_COMPLETE');
    if (!trusted.targetEvidence) { for (const code of okoBankRequiredChecks) add(code, 'blocked'); throw new Stop('BLOCKED_BANK_INPUT'); }
    const targetBinding: OkoTargetBinding = { ...binding, runId: randomUUID(), profileRevision: own.revision, assignmentRef: publishedAssignment, assignmentHash: hash(assignment), enrichedHash: hash(enriched), rowCount: reportedRows };
    const target = await trusted.targetEvidence.verify(structuredClone(targetBinding), signal); await ensureCurrent();
    if (!target || !same(target.binding, targetBinding) || !freshTimes(target.observedAt, target.expiresAt) || target.checks.length !== okoBankRequiredChecks.length || !okoBankRequiredChecks.every(code => target.checks.filter(check => check.code === code && check.status === 'passed').length === 1)) throw new Stop('TARGET_EVIDENCE_INVALID');
    // Native metadata is only a necessary check; it is never the bank proof itself.
    if (trusted.browser?.().name !== 'SberBrowser') throw new Stop('BLOCKED_BANK_INPUT');
    // One authoritative sample supplies identity, capability and verified state; the
    // same gate validates its own profile/configuration. Both proofs are rechecked
    // after that gate's last await, immediately before the acceptance assignment.
    await ensureCurrent(true);
    if (!same(published(publishedAssignment, goalAssignmentSchema), assignment) || !freshTimes(observedAt, expiresAt) || !freshTimes(target.observedAt, target.expiresAt)) throw new Stop('TARGET_EVIDENCE_INVALID');
    for (const code of okoBankRequiredChecks) add(code);
    report.status = 'passed'; report.acceptedSourceBinding = true;
  } catch (error) {
    const stop = error instanceof Stop ? error : signal.aborted ? new Stop('CANCELLED') : error instanceof WorkbenchHttpError && error.code === 'WORKSPACE_BUSY' ? new Stop('WORKSPACE_BUSY') : new Stop('RUNTIME_FAILED', 'failed');
    add(stop.code, stop.status); report.status = stop.status;
  } finally {
    if (launched && owner) {
      try { const observed = deps.trusted?.browser?.(); if (observed) report.browser = { name: ['Edge', 'Chrome', 'Chromium', 'SberBrowser'].includes(observed.name) ? observed.name : 'unobserved', version: observed.version && /^\d+(?:\.\d+){1,3}$/.test(observed.version) ? observed.version : null }; } catch { /* Metadata never propagates exceptions. */ }
      for (const handleId of ownedHandles) try {
        if (deps.runtime.cancelRecording) await deps.runtime.cancelRecording({ owner, handleId }); else await deps.runtime.finish({ owner, handleId, save: false });
      } catch { add('CLEANUP_FAILED', 'failed'); report.status = 'failed'; report.acceptedSourceBinding = false; }
    }
  }
  if (!deps.trusted?.targetEvidence) {
    for (const code of okoBankRequiredChecks) if (!report.checks.some(check => check.code === code)) add(code, 'blocked');
    if (!report.checks.some(check => check.code === 'BLOCKED_BANK_INPUT')) add('BLOCKED_BANK_INPUT', 'blocked');
  }
  return report;
}
