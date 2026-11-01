import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { business, draftCleanups, draftFixture } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeHeader, makeNumericFixture } from '../../../tests/fixtures/workbench/factories';
import type { SourceDefinition, SourceFieldMapping, DirectoryEntity, DirectoryLink, Template, MethodVersion, RawSourceRow } from '../../domain/workbench/entities';
import type { Header } from '../../domain/workbench/primitives';
import { browserScenarioDefinitionSchema } from '../../domain/workbench/browser-scenario';
import { createBrowserScenarioService } from './workbench-browser-scenarios';
import { registerBrowserCommands, registerBrowserQueries } from './workbench-browser-commands';
import { createBrowserProfileService } from './workbench-browser-profile';
import { createBrowserRecorderService } from './workbench-browser-recorder';
import { privateProfileSchema, ConnectorError } from './contracts';
import type { BrowserScenarioRuntimePort, BrowserExportEvidence } from './workbench-source-contracts';
import { parseWorkbenchTable } from '../tabular-import/workbench-parser';
import { enrichSourceRows } from '../catalog/workbench-directory';
import { QueryRegistry } from '../../server/workbench/query-registry';
import { PublishingService } from '../publishing/workbench/publishing-service';
import { createPackageArtifactStore } from '../publishing/workbench/package-artifacts';
import { canonicalBytes } from '../publishing/workbench/package-manifest';
import { registerPublishingCommands } from '../publishing/workbench/register-commands';
import { WorkbenchHttpError } from '../../server/workbench/protocol';

afterEach(async () => { while (draftCleanups.length) await draftCleanups.pop()!(); });
const ref = (entityType: string, value: { id: string; revision: number }) => ({ entityType, id: value.id, revision: value.revision });
async function fixture(linkSource = true, product = false) {
  const f = draftFixture({ input: makeNumericFixture({ scope: { kind: product ? 'product' : 'dit', id: fixtureId(101) } }) });
  const source = f.repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: f.input.goal.sourceId })!;
  const oldMapping = f.repository.readVersion<SourceFieldMapping>(source.mappingRef!)!;
  const mapping = { ...oldMapping, revision: 2, fixedScope: product ? null : f.input.assignment.scope, productKeyField: product ? 'demo_scope_id' : null };
  f.repository.transaction(() => { f.repository.append('source_field_mapping', mapping, 1); f.repository.append('source_definition', { ...source, revision: 2, mappingRef: ref('source_field_mapping', mapping) }, 1); });
  if (product) f.repository.transaction(() => {
    const header = (seed: number) => makeHeader(seed, { publicationAnchorId: f.input.goal.publicationAnchorId });
    f.repository.append('directory_entity', { ...header(990001), kind: 'dit', name: 'DIT', externalKeys: [] }, null);
    f.repository.append('directory_entity', { ...header(990002), kind: 'cluster', name: 'Cluster', externalKeys: [] }, null);
    const old = f.repository.readPublishedHead<DirectoryEntity>({ entityType: 'directory_entity', id: fixtureId(101) })!;
    f.repository.append('directory_entity', { ...old, revision: 2, externalKeys: [{ sourceId: source.id, key: 'dit' }] }, 1);
    f.repository.append('directory_link', { ...header(990003), kind: 'dit_cluster', from: { entityType: 'directory_entity', id: fixtureId(990001) }, to: { entityType: 'directory_entity', id: fixtureId(990002) } }, null);
    f.repository.append('directory_link', { ...header(990004), kind: 'cluster_product', from: { entityType: 'directory_entity', id: fixtureId(990002) }, to: { entityType: 'directory_entity', id: fixtureId(101) } }, null);
    f.repository.append('directory_link', { ...header(990005), kind: 'leader', scope: { kind: 'cluster', id: fixtureId(990002) }, personId: f.input.goal.primaryCuratorPersonId }, null);
    f.repository.append('directory_link', { ...header(990006), kind: 'leader', scope: f.input.assignment.scope, personId: f.input.goal.primaryCuratorPersonId }, null);
  });
  let bytes = Buffer.from('demo_row_key,demo_scope_id,demo_metric_id,demo_value,demo_date\nr1,dit,m1,92,2026-10-23\n');
  let proof = false, overrides: Partial<BrowserExportEvidence> = {}, replayHook: (() => Promise<void>) | null = null;
  const unavailable = async (): Promise<never> => { throw new WorkbenchHttpError(409, 'BROWSER_CONFIGURATION_REQUIRED', 'No live browser fixture'); };
  const runtime: BrowserScenarioRuntimePort = {
    openLogin: unavailable, startRecording: unavailable, finish: unavailable, screenshot: unavailable, waitForCompletion: unavailable, closeOwned: async () => {},
    async replay() { await replayHook?.(); return { name: 'synthetic.csv', bytes, contentType: 'text/csv' }; },
    async inspectExport(input) { return proof ? { ...input, publishedAssignment: ref('goal_assignment', f.input.assignment), observedAt: f.clock.now(), expiresAt: '2026-10-23T12:10:00Z', selectionVerified: true, allPagesExported: true, reportedRows: 1, ...overrides } : null; },
  };
  const profiles = createBrowserProfileService({ runtimeRoot: f.root, repository: f.repository, clock: f.clock });
  const enricher = { enrich: ({ rows }: { rows: import('../../domain/workbench/entities').CanonicalSourceRow[] }) => enrichSourceRows({ capture: { sourceId: source.id, mappingRef: ref('source_field_mapping', mapping), rawRows: rows.map(row => ({ rowKey: row.rowKey, cells: (product ? { demo_scope_id: { kind: 'text' as const, original: row.dimensions.demo_scope_id } } : {}) as RawSourceRow['cells'] })), canonicalRows: rows }, mapping, directoryEntities: f.repository.readPublishedCatalog().filter(v => v.entityType === 'directory_entity').map(v => v.value as DirectoryEntity), directoryLinks: f.repository.readPublishedDirectoryLinks() }) };
  const scenarios = createBrowserScenarioService({ repository: f.repository, drafts: f.service, runtime, profiles, parser: parseWorkbenchTable, enricher, clock: f.clock });
  const recorder = createBrowserRecorderService({ repository: f.repository, profiles, runtime, jobs: f.jobs, clock: f.clock });
  registerBrowserCommands(f.registry, { profiles, recorder, scenarios, login: { open: unavailable, finish: unavailable } });
  const queries = new QueryRegistry(); registerBrowserQueries(queries, { profiles });
  await f.execute('source.browser.profile.set', { sourceId: source.id, profileId: 'synthetic', profile: privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { executablePath: process.execPath, profileDirectory: 'synthetic' } }), expectedRevision: null });
  const draft = await f.open('browser_scenario');
  const sourceDraft = linkSource ? await f.open('source_definition', { entityType: 'source_definition', id: source.id }) : null;
  if (sourceDraft) await f.execute('source.draft.save', { draftId: sourceDraft.draftId, definition: { ...business(source), mappingRef: ref('source_field_mapping', mapping), browserScenarioRef: { ...draft.entityRef, revision: 1 } } });
  const definition = { sourceId: source.id, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#report', steps: [{ action: 'fill', locator: { kind: 'label', text: 'Period', exact: true }, parameter: 'period' }, { action: 'download', locator: { kind: 'role', role: 'button', name: 'Export all', exact: true } }], parameters: { period: '2026-10' }, expectedExport: { format: 'csv', requiredColumns: ['demo_value'] } };
  const save = async (value: unknown = definition) => {
    const result = (await f.execute('source.browserScenario.draft.save', { draftId: draft.draftId, definition: value })).result as { complete: boolean; problems: { code: string }[]; versionRef: import('../../domain/workbench/primitives').VersionRef };
    if (sourceDraft) { const current = f.service.readOwnEntry(f.context, sourceDraft.draftId); if (JSON.stringify(current.definition.browserScenarioRef) !== JSON.stringify(result.versionRef)) await f.execute('source.draft.save', { draftId: sourceDraft.draftId, definition: { ...current.definition, browserScenarioRef: result.versionRef } }); }
    return result;
  };
  const test = async () => {
    const commandId = fixtureId(550000 + f.store.history(draft.draftId).length + testSerial++);
    const accepted = await f.registry.execute({ commandId, name: 'source.browser.record.test', payload: { draftId: draft.draftId }, baseRevision: f.token() }, { ...f.context, commandId });
    if (!('jobId' in accepted)) throw Error('Expected async test'); await f.registry.idle();
    return f.jobs.get(accepted.jobId, f.context.installationId)!;
  };
  let testSerial = 0;
  const packageProblems = () => f.service.validateDraftPackage(f.packageId()).problems;
  return { ...f, scenarios, profiles, queries, runtime, source, sourceDraft, mapping, draft, definition, save, test, packageProblems,
    proof: (value = true, patch: Partial<BrowserExportEvidence> = {}) => { proof = value; overrides = patch; }, bytes: (value: string) => { bytes = Buffer.from(value); }, hook: (value: () => Promise<void>) => { replayHook = value; } };
}

it('scenario_draft_save_requires_safe_parameters_and_download', async () => {
  const f = await fixture(); expect((await f.save({ startUrl: f.definition.startUrl })).complete).toBe(false);
  expect((await f.save({ ...f.definition, steps: [{ action: 'wait', locator: { kind: 'css', selector: '#report' } }] })).complete).toBe(false);
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'DOWNLOAD_REQUIRED' }));
  for (const definition of [{ ...f.definition, parameters: { password: 'x' } }, { ...f.definition, actor: f.context.actor }, { ...f.definition, profile: {} }, { ...f.definition, startUrl: 'https://user:pass@report.example.invalid' }, { ...f.definition, startUrl: 'https://report.example.invalid/?token=x' }, { ...f.definition, steps: [{ action: 'eval', script: '1' }] }]) await expect(f.save(definition)).rejects.toMatchObject({ statusCode: 422 });
  expect((await f.save({ ...f.definition, parameters: {} })).problems).toContainEqual(expect.objectContaining({ code: 'PARAMETER_REQUIRED' }));
});
it('native recording authentication errors remain actionable job diagnostics', async () => {
  const f = await fixture(); f.runtime.startRecording = async () => { throw new ConnectorError('manual_login_required', 'Private native details'); };
  const commandId = fixtureId(912000); const accepted = await f.registry.execute({ commandId, name: 'source.browser.record.start', payload: { sourceRef: { entityType: 'source_definition', id: f.source.id, revision: 2 }, startUrl: f.definition.startUrl, authenticatedSelector: '#report' }, baseRevision: null }, { ...f.context, commandId });
  if (!('jobId' in accepted)) throw Error('Expected recording job'); await f.registry.idle();
  expect(f.jobs.get(accepted.jobId, f.context.installationId)).toMatchObject({ status: 'failed', error: { code: 'AUTH_REQUIRED' } });
});
it('review_I1_changed_profile_allows_incomplete_candidate_then_requires_new_proof', async () => {
  const f = await fixture(); await f.save(); f.proof();
  expect((await f.test()).result).toMatchObject({ complete: true });
  expect((await f.save()).complete).toBe(true);
  const own = await f.profiles.getOwn(f.context, f.source.id);
  await f.profiles.set(f.context, { sourceId: f.source.id, profileId: own.profileId!, profile: { ...own.profile!, timeoutMs: 9000 }, expectedRevision: own.revision });
  const candidate = { ...f.definition, parameters: { period: '2026-11' } };
  expect(await f.save(candidate)).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'SCENARIO_TEST_REQUIRED' })]) });
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'SCENARIO_TEST_REQUIRED' }));
  expect((await f.save(f.definition)).complete).toBe(false);
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'SCENARIO_TEST_REQUIRED' }));
  expect((await f.save(candidate)).complete).toBe(false);
  expect((await f.test()).result).toMatchObject({ complete: true });
  expect((await f.save(candidate)).complete).toBe(true);
  expect(f.packageProblems()).toEqual([]);
});

it('a brand new goal source and own assignment can prove their exact private closure before first publication', async () => {
  const f = await fixture(false);
  const goal = await f.open('core_goal_definition'), source = await f.open('source_definition'), mapping = await f.open('source_field_mapping'), assignment = await f.open('goal_assignment'), metric = await f.open('metric_definition'), method = await f.open('method_version');
  const metricSaved = await f.execute('metric.draft.save', { draftId: metric.draftId, definition: business(f.input.metrics[0]) });
  const metricRef = (metricSaved.result as { versionRef: import('../../domain/workbench/primitives').VersionRef }).versionRef;
  if (f.input.method.mode !== 'numeric') throw Error('Numeric fixture');
  const methodSaved = await f.execute('method.draft.save', { draftId: method.draftId, definition: { ...business(f.input.method), rules: f.input.method.rules.map(rule => ({ ...rule, metricRef })) } });
  const goalSaved = await f.execute('goal.draft.save', { draftId: goal.draftId, definition: { ...business(f.input.goal), title: 'Новая цель ОКО', sourceId: source.objectId } });
  const mappingSaved = await f.execute('fieldMapping.draft.save', { draftId: mapping.draftId, definition: { ...business(f.mapping), sourceId: source.objectId, metricFields: f.mapping.metricFields.map(field => ({ ...field, metricId: metric.objectId })) } });
  const assignmentSaved = await f.execute('assignment.draft.save', { draftId: assignment.draftId, definition: { ...business(f.input.assignment), goalId: goal.objectId, methodBinding: { kind: 'standalone', methodRef: (methodSaved.result as { versionRef: unknown }).versionRef } } });
  const definition = { ...f.definition, sourceId: source.objectId };
  const scenarioSaved = await f.execute('source.browserScenario.draft.save', { draftId: f.draft.draftId, definition });
  await f.execute('source.draft.save', { draftId: source.draftId, definition: { ...business(f.source), goalId: goal.objectId, mappingRef: (mappingSaved.result as { versionRef: unknown }).versionRef, browserScenarioRef: (scenarioSaved.result as { versionRef: unknown }).versionRef } });
  const profile = await f.profiles.getOwn(f.context, f.source.id);
  await f.profiles.set(f.context, { sourceId: source.objectId, profileId: 'synthetic', profile: profile.profile!, expectedRevision: profile.revision });
  const assignmentRef = (assignmentSaved.result as { versionRef: import('../../domain/workbench/primitives').VersionRef }).versionRef;
  let serial = 911000;
  const testPrivate = async (target = assignmentRef, baseRevision = f.token()) => {
    const commandId = fixtureId(serial++); const accepted = await f.registry.execute({ commandId, name: 'source.browser.record.test', payload: { draftId: f.draft.draftId, assignmentRef: target }, baseRevision }, { ...f.context, commandId });
    if (!('jobId' in accepted)) throw Error('Expected test job'); await f.registry.idle(); return f.jobs.get(accepted.jobId, f.context.installationId)!;
  };
  expect((await testPrivate()).result).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'EXPORT_COVERAGE_UNVERIFIED' })]) });
  expect((await testPrivate(assignmentRef, 'stale')).error?.code).toBe('REVISION_CONFLICT');
  expect((await testPrivate(ref('goal_assignment', f.input.assignment))).error?.code).toBe('DRAFT_REFERENCE_MISMATCH');
  const observed = (input: Record<string, unknown>) => ({ ...input, observedAt: f.clock.now(), expiresAt: '2026-10-23T12:10:00Z', selectionVerified: true, allPagesExported: true, reportedRows: 1 });
  Object.assign(f.runtime, { inspectPreviewExport: async (input: Record<string, unknown>) => ({ ...observed(input), assignment: { ...(input.assignment as object), packageId: fixtureId(919999) } }) });
  expect((await testPrivate()).result).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'EXPORT_COVERAGE_UNVERIFIED' })]) });
  Object.assign(f.runtime, { inspectPreviewExport: async (input: Record<string, unknown>) => observed(input) });
  const person = f.context.ownAccess.personId; f.context.ownAccess.personId = fixtureId(919998); f.context.actor.profilePersonId = fixtureId(919998);
  expect((await testPrivate()).error?.code).toBe('DRAFT_NOT_FOUND'); f.context.ownAccess.personId = person; f.context.actor.profilePersonId = person;
  const commandId = fixtureId(910001);
  const accepted = await f.registry.execute({ commandId, name: 'source.browser.record.test', payload: { draftId: f.draft.draftId, assignmentRef }, baseRevision: f.token() }, { ...f.context, commandId });
  if (!('jobId' in accepted)) throw Error('Expected test job'); await f.registry.idle();
  expect(f.jobs.get(accepted.jobId, f.context.installationId)).toMatchObject({ status: 'succeeded', result: { complete: true, acceptedPreviewRows: 1 } });
  expect(f.repository.readPublishedHead({ entityType: 'core_goal_definition', id: goal.objectId })).toBeNull();
  expect(f.repository.readPublishedHead({ entityType: 'goal_assignment', id: assignment.objectId })).toBeNull();
  expect(f.repository.readPublishedHead({ entityType: 'method_version', id: method.objectId })).toBeNull();
  expect(f.repository.readPublishedHead({ entityType: 'metric_definition', id: metric.objectId })).toBeNull();
  expect((await f.execute('source.browserScenario.draft.save', { draftId: f.draft.draftId, definition })).result).toMatchObject({ complete: true });
  const artifacts = createPackageArtifactStore({ artifactRoot: path.join(f.root, 'new-goal-packages') });
  const main = { repositoryId: 'synthetic', commit: 'a'.repeat(40), files: new Map(f.repository.exportWorkspaceCore().filter(v => v.entityType !== 'publication_anchor').map(({ entityType, value }) => [`records/${entityType}/${value.id}/${value.revision}.json`, canonicalBytes(value)])) };
  const publisher = new PublishingService({ repository: f.repository, clock: f.clock, drafts: f.service, artifacts, git: { async readMain() { return main; } }, accessPolicy: f.policy, jobs: f.jobs, jobSink: f.jobs, publication: { mode: 'demo-only', classifyRecord: () => true } }); registerPublishingCommands(f.registry, publisher);
  const previewId = fixtureId(910002); const preview = await f.registry.execute({ commandId: previewId, name: 'package.preview', baseRevision: f.token(), payload: { packageId: f.packageId() } }, { ...f.context, commandId: previewId });
  if (!('jobId' in preview)) throw Error('Expected package job'); await f.registry.idle();
  expect(f.jobs.get(preview.jobId, f.context.installationId)).toMatchObject({ status: 'succeeded', result: { errors: [] } });
  const own = f.service.readOwnEntry(f.context, assignment.draftId);
  await f.execute('assignment.draft.save', { draftId: assignment.draftId, definition: { ...own.definition, expectedPopulation: [{ kind: 'dit', id: fixtureId(999) }] } });
  expect((await f.execute('source.browserScenario.draft.save', { draftId: f.draft.draftId, definition })).result).toMatchObject({ complete: false });
  expect(f.repository.readPublishedHead({ entityType: 'source_definition', id: source.objectId })).toBeNull();
  expect((goalSaved.result as { versionRef: unknown }).versionRef).toBeTruthy();
});

it('preview_requires_export_coverage_evidence_and_never_changes_accepted_state', async () => {
  const f = await fixture(); await f.save(); const before = f.repository.exportWorkspaceCore();
  const job = await f.test(); expect(job.status).toBe('succeeded');
  expect(job.result).toMatchObject({ downloadedBytes: expect.any(Number), acceptedPreviewRows: 1, rejectedPreviewRows: 0, complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'EXPORT_COVERAGE_UNVERIFIED' })]) });
  expect(f.repository.exportWorkspaceCore()).toEqual(before); expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'EXPORT_COVERAGE_UNVERIFIED' }));
  f.proof(); expect((await f.test()).result).toMatchObject({ complete: true }); expect(f.packageProblems()).toEqual([]);
  expect(f.repository.exportWorkspaceCore()).toEqual(before);
});

it.each(['allPagesExported', 'payloadHash', 'scenarioHash', 'sourceRef', 'mappingRef', 'publishedAssignment', 'reportedRows'])('rejects mismatched or truncated export evidence: %s', async field => {
  const f = await fixture(); await f.save();
  const patch = { [field]: field === 'allPagesExported' ? false : field === 'reportedRows' ? 2000 : field.endsWith('Hash') ? 'sha256:' + 'a'.repeat(64) : { entityType: field === 'publishedAssignment' ? 'goal_assignment' : field === 'mappingRef' ? 'source_field_mapping' : 'source_definition', id: fixtureId(999), revision: 1 } };
  f.proof(true, patch); expect((await f.test()).result).toMatchObject({ complete: false });
  expect(f.packageProblems().length).toBeGreaterThan(0);
});

it('fresh_receipt_is_bound_to_revision_mapping_source_and_expiry', async () => {
  const f = await fixture(); await f.save(); f.proof(); await f.test(); expect(f.packageProblems()).toEqual([]);
  await f.save({ ...f.definition, parameters: { period: '2026-09' } }); expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'SCENARIO_TEST_REQUIRED' }));
  await f.test(); f.setNow('2026-10-23T12:11:00Z'); expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'SCENARIO_TEST_EXPIRED' }));
});

it('reader_resolves_only_published_revision', async () => {
  const f = await fixture(); await f.save();
  expect(() => f.scenarios.resolvePublished(ref('source_definition', { ...f.source, revision: 2 }))).toThrow();
  const published = browserScenarioDefinitionSchema.parse({ ...makeHeader(880000, { publicationAnchorId: f.input.goal.publicationAnchorId }), ...f.definition });
  f.repository.transaction(() => { f.repository.append('browser_scenario', published, null); f.repository.append('source_definition', { ...f.source, revision: 3, mappingRef: ref('source_field_mapping', f.mapping), browserScenarioRef: ref('browser_scenario', published) }, 2); });
  expect(f.scenarios.resolvePublished(ref('source_definition', { ...f.source, revision: 3 }))).toEqual(published);
  await f.save({ ...f.definition, parameters: { period: '2026-09' } });
  expect(f.scenarios.resolvePublished(ref('source_definition', { ...f.source, revision: 3 }))).toEqual(published);
  expect(() => f.scenarios.resolvePublished({ entityType: 'browser_scenario', id: published.id, revision: 1 })).toThrow();
});

it('foreign_draft_and_reader_cannot_test_or_save_shared_scenario', async () => {
  const f = await fixture(); await f.save(); f.context.ownAccess.personId = fixtureId(999); f.context.actor.profilePersonId = fixtureId(999);
  await expect(f.scenarios.test(f.context, { draftId: f.draft.draftId })).rejects.toMatchObject({ statusCode: 404 });
  f.context.ownAccess.role = 'viewer'; await expect(f.save()).rejects.toMatchObject({ statusCode: 403 });
});

it('mapped_and_declared_columns_and_real_parser_errors_block_readiness', async () => {
  const f = await fixture(); await f.save(); f.proof(); f.bytes('demo_value\n92\n');
  expect((await f.test()).result).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_SCHEMA_CHANGED' })]) });
  f.bytes('<html>login</html>'); expect((await f.test()).result).toMatchObject({ complete: false });
});

it('serializes_only_declarative_scenario_with_real_T22_owner_validation', async () => {
  const f = await fixture(); await f.save(); f.proof(); await f.test();
  const artifacts = createPackageArtifactStore({ artifactRoot: path.join(f.root, 'packages') });
  const main = { repositoryId: 'synthetic', commit: 'a'.repeat(40), files: new Map(f.repository.exportWorkspaceCore().filter(v => v.entityType !== 'publication_anchor').map(({ entityType, value }) => [`records/${entityType}/${value.id}/${value.revision}.json`, canonicalBytes(value)])) };
  const publisher = new PublishingService({ repository: f.repository, clock: f.clock, drafts: f.service, artifacts, git: { async readMain() { return main; } }, accessPolicy: f.policy, jobs: f.jobs, jobSink: f.jobs, publication: { mode: 'demo-only', classifyRecord: () => true } }); registerPublishingCommands(f.registry, publisher);
  const commandId = fixtureId(888000); const accepted = await f.registry.execute({ commandId, name: 'package.preview', baseRevision: f.token(), payload: { packageId: f.packageId() } }, { ...f.context, commandId });
  if (!('jobId' in accepted)) throw Error('Expected preview job'); await f.registry.idle(); const job = f.jobs.get(accepted.jobId, f.context.installationId)!;
  expect(job.error).toBeNull(); expect(job.result).toMatchObject({ errors: [] });
  const result = job.result as { packageRevision: import('../publishing/workbench/contracts').PackageRevision }; const files = await artifacts.readRevision(result.packageRevision);
  const scenarioFile = [...files].find(([name]) => name.includes('/browser_scenario/')); expect(scenarioFile).toBeDefined();
  const text = Buffer.from(scenarioFile![1]).toString(); expect(JSON.parse(text)).toMatchObject(f.definition); expect(text).not.toMatch(/executablePath|screenshot|cookies|payloadHash|profileDirectory/);
});

it('own_profile_query_uses_real_owner_projection_and_profile_commands_preserve_CAS', async () => {
  const f = await fixture();
  const request = { context: null, filter: { sourceRef: ref('source_definition', { ...f.source, revision: 2 }) }, sort: [], page: { limit: 50, cursor: null } };
  const own = await f.queries.execute('source.browser.own', request, f.context) as { profile: unknown; revision: string };
  expect(own).toMatchObject({ configured: true, profileId: 'synthetic' });
  const foreign = { ...f.context, ownAccess: { ...f.context.ownAccess, role: 'viewer' as const, personId: fixtureId(888) } };
  expect(await f.queries.execute('source.browser.own', request, foreign)).toMatchObject({ configured: false, profile: null });
  await expect(f.execute('source.browser.profile.set', { sourceId: f.source.id, profileId: 'synthetic', profile: own.profile, expectedRevision: null })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  await expect(f.queries.execute('source.browser.own', { ...request, filter: { ...request.filter, ownerPersonId: f.context.ownAccess.personId } }, f.context)).rejects.toMatchObject({ statusCode: 422 });
  expect(f.registry.listNames()).toEqual(expect.arrayContaining(['source.browser.profile.set', 'source.browser.login.open', 'source.browser.login.finish', 'source.browser.record.start', 'source.browser.record.finish', 'source.browserScenario.draft.save', 'source.browser.record.test']));
  expect(f.registry.getCapability('source.browser.login.open')).toBe('capture.local'); expect(f.registry.getCapability('source.browser.record.start')).toBe('uor.prepare');
  f.context.ownAccess.role = 'viewer';
  const commandId = fixtureId(889000); const login = await f.registry.execute({ commandId, name: 'source.browser.login.open', payload: request.filter, baseRevision: null }, { ...f.context, commandId });
  if (!('jobId' in login)) throw Error('Expected async login'); await f.registry.idle(); expect(f.jobs.get(login.jobId, f.context.installationId)).toMatchObject({ status: 'failed', error: { code: 'BROWSER_CONFIGURATION_REQUIRED' } });
});

it('missing_download_never_reuses_prior_success', async () => {
  const f = await fixture(); await f.save(); f.proof(); expect((await f.test()).result).toMatchObject({ complete: true });
  f.bytes(''); expect((await f.test()).result).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'DOWNLOAD_REQUIRED' })]) });
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'DOWNLOAD_REQUIRED' }));
});

it('edits_while_replaying_cannot_commit_a_fresh_receipt', async () => {
  const f = await fixture(); await f.save(); f.proof();
  f.hook(async () => { await f.save({ ...f.definition, parameters: { period: '2026-09' } }); });
  const job = await f.test(); expect(job.status).toBe('failed'); expect(job.error?.code).toBe('SCENARIO_TEST_STALE');
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'SCENARIO_TEST_REQUIRED' }));
});

it('changed_mapping_and_goal_incoming_references_invalidate_test_before_serialization', async () => {
  const f = await fixture(); await f.save(); f.proof(); await f.test();
  const mapping = { ...f.mapping, revision: 3, fixedUnitCode: 'changed_unit' };
  f.repository.transaction(() => { f.repository.append('source_field_mapping', mapping, 2); f.repository.append('source_definition', { ...f.source, revision: 3, mappingRef: ref('source_field_mapping', mapping) }, 2); });
  const entry = f.service.readOwnEntry(f.context, f.sourceDraft!.draftId); await f.execute('source.draft.save', { draftId: entry.draftId, definition: { ...entry.definition, mappingRef: ref('source_field_mapping', mapping) } });
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'SCENARIO_TEST_REQUIRED' }));
  const scenario = browserScenarioDefinitionSchema.parse({ ...makeHeader(889001), ...f.definition });
  expect(() => f.repository.append('browser_scenario', { ...scenario, sourceId: fixtureId(9999) }, null)).toThrow();
  expect(() => f.repository.append('source_definition', { ...f.source, revision: 4, goalId: fixtureId(9999), browserScenarioRef: ref('browser_scenario', scenario) }, 3)).toThrow();
});

it('owner_package_revalidates_published_assignment_against_incoming_main', async () => {
  const f = await fixture(); await f.save(); f.proof(); await f.test();
  const entry = f.service.readOwnEntry(f.context, f.draft.draftId); const value = browserScenarioDefinitionSchema.parse({ ...entry.header, ...entry.definition });
  const read = (target: import('../../domain/workbench/primitives').EntityRef | import('../../domain/workbench/primitives').VersionRef) => target.entityType === 'goal_assignment' ? { ...f.input.assignment, revision: 2, expectedPopulation: [] } : f.service.resolveOwnReference(f.context, f.packageId(), target);
  expect(() => f.service.validateMaterializedForPackage(f.context, f.packageId(), 'browser_scenario', value, read, null)).toThrowError(expect.objectContaining({ code: 'SCENARIO_TEST_REQUIRED' }));
});

it('registered_full_scenario_schema_rejects_missing_parameter_values', async () => {
  const f = await fixture();
  expect(browserScenarioDefinitionSchema.safeParse({ ...makeHeader(889002), ...f.definition, parameters: {} }).success).toBe(false);
});

it('publication_requires_reciprocal_source_scenario_link_in_the_own_package', async () => {
  const f = await fixture(false); await f.save(); f.proof(); await f.test();
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'SOURCE_SCENARIO_REQUIRED' }));
});

it('failed_replay_invalidates_previous_receipt_and_keeps_private_errors_out_of_diagnostics', async () => {
  const f = await fixture(); await f.save(); f.proof(); await f.test(); expect(f.packageProblems()).toEqual([]);
  f.hook(async () => { throw new ConnectorError('manual_login_required', 'https://private.example.invalid/?token=private-token'); });
  const job = await f.test(); expect(job.result).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'AUTH_REQUIRED' })]) });
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
  const receipts = f.repository.sqlForModule('browser_scenarios').all<{ receipt_json: string }>('SELECT receipt_json FROM wb_browser_scenarios_tests');
  expect(JSON.stringify(receipts)).not.toContain('private-token'); expect(receipts).toHaveLength(2);
});

it('missing_mapping_and_declared_columns_block_owner_package_validation', async () => {
  const f = await fixture(); await f.save({ ...f.definition, expectedExport: { format: 'csv', requiredColumns: ['Absent'] } }); f.proof();
  expect((await f.test()).result).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_SCHEMA_CHANGED' })]) });
  const source = f.service.readOwnEntry(f.context, f.sourceDraft!.draftId); await f.execute('source.draft.save', { draftId: source.draftId, definition: { ...source.definition, mappingRef: null } });
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'SOURCE_MAPPING_REQUIRED' }));
});

it('population_is_only_the_current_published_assignment_not_the_received_row_count', async () => {
  const f = await fixture(); await f.save();
  const extra = { ...makeHeader(889500, { publicationAnchorId: f.input.goal.publicationAnchorId }), kind: 'dit' as const, name: 'Missing expected DIT', externalKeys: [] };
  const assignment = { ...f.input.assignment, revision: 2, expectedPopulation: [...f.input.assignment.expectedPopulation!, { kind: 'dit' as const, id: extra.id }] };
  f.repository.transaction(() => { f.repository.append('directory_entity', extra, null); f.repository.append('goal_assignment', assignment, 1); });
  f.proof(true, { publishedAssignment: ref('goal_assignment', assignment) });
  const job = await f.test(); expect(job.result).toMatchObject({ acceptedPreviewRows: 1, complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'EXPECTED_POPULATION_INCOMPLETE' })]) });
  expect(f.packageProblems()).toContainEqual(expect.objectContaining({ code: 'EXPECTED_POPULATION_INCOMPLETE' }));
});

function publicationHarness(f: Awaited<ReturnType<typeof fixture>>) {
  const artifacts = createPackageArtifactStore({ artifactRoot: path.join(f.root, 'review-packages') });
  const main = { repositoryId: 'synthetic', commit: 'a'.repeat(40), files: new Map(f.repository.exportWorkspaceCore().filter(v => v.entityType !== 'publication_anchor').map(({ entityType, value }) => [`records/${entityType}/${value.id}/${value.revision}.json`, canonicalBytes(value)])) };
  const publisher = new PublishingService({ repository: f.repository, clock: f.clock, drafts: f.service, artifacts, git: { async readMain() { return main; } }, accessPolicy: f.policy, jobs: f.jobs, jobSink: f.jobs, publication: { mode: 'demo-only', classifyRecord: () => true } }); registerPublishingCommands(f.registry, publisher);
  let serial = 995000;
  return {
    set<T extends Header>(type: string, value: T) { main.commit = 'b'.repeat(40); main.files.set(`records/${type}/${value.id}/${value.revision}.json`, canonicalBytes(value)); },
    remove(type: string, id: string) { main.commit = 'c'.repeat(40); for (const name of main.files.keys()) if (name.startsWith(`records/${type}/${id}/`)) main.files.delete(name); },
    async preview() {
      const commandId = fixtureId(serial++); const accepted = await f.registry.execute({ commandId, name: 'package.preview', baseRevision: f.token(), payload: { packageId: f.packageId() } }, { ...f.context, commandId });
      if (!('jobId' in accepted)) throw Error('Expected actual preview job'); await f.registry.idle(); const job = f.jobs.get(accepted.jobId, f.context.installationId)!;
      expect(job.error).toBeNull(); return job.result as { errors: Array<{ code: string }> };
    },
  };
}

it.each(['metric', 'reducer'])('review_I1_missing_%s_mapping_cannot_pass_test_or_real_package_preview', async missing => {
  const f = await fixture(); await f.save();
  const mapping = await f.open('source_field_mapping', { entityType: 'source_field_mapping', id: f.mapping.id });
  await f.execute('fieldMapping.draft.save', { draftId: mapping.draftId, definition: { ...business(f.mapping), metricFields: missing === 'metric' ? [] : [{ metricId: f.input.metrics[0].id, fields: {} }] } });
  const source = f.service.readOwnEntry(f.context, f.sourceDraft!.draftId);
  await f.execute('source.draft.save', { draftId: source.draftId, definition: { ...source.definition, mappingRef: f.service.readOwnEntry(f.context, mapping.draftId).versionRef } });
  f.proof(); const job = await f.test();
  expect(job.result).toMatchObject({ complete: false, problems: expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_INVALID_CONFIGURATION' })]) });
  expect((await publicationHarness(f).preview()).errors).toContainEqual(expect.objectContaining({ code: 'SOURCE_INVALID_CONFIGURATION' }));
});

it.each(['own', 'main'])('review_I1_%s_template_method_change_with_unchanged_assignment_invalidates_receipt', async where => {
  const f = await fixture(); await f.save();
  const template: Template = { ...makeHeader(990100, { publicationAnchorId: f.input.goal.publicationAnchorId }), name: 'Template', methodRef: ref('method_version', f.input.method) };
  const assignment = { ...f.input.assignment, revision: 2, methodBinding: { kind: 'template' as const, templateId: template.id } };
  const nextMethod: MethodVersion = { ...f.input.method, id: fixtureId(990101) };
  f.repository.transaction(() => { f.repository.append('template', template, null); f.repository.append('goal_assignment', assignment, 1); f.repository.append('method_version', nextMethod, null); });
  f.proof(true, { publishedAssignment: ref('goal_assignment', assignment) }); expect((await f.test()).result).toMatchObject({ complete: true });
  const publishing = publicationHarness(f); expect((await publishing.preview()).errors).toEqual([]);
  const changed = { ...template, revision: 2, methodRef: ref('method_version', nextMethod) };
  if (where === 'main') publishing.set('template', changed);
  else { const opened = await f.open('template', { entityType: 'template', id: template.id }); await f.execute('template.draft.save', { draftId: opened.draftId, definition: business(changed) }); }
  expect((await publishing.preview()).errors).toContainEqual(expect.objectContaining({ code: 'SCENARIO_TEST_REQUIRED' }));
  if (where === 'own') { expect((await f.test()).result).toMatchObject({ complete: true }); expect((await publishing.preview()).errors).toEqual([]); }
});

it.each(['own-key', 'main-key', 'main-add', 'main-remove', 'main-move'])('review_I2_%s_projected_directory_invalidates_product_export_receipt', async change => {
  const f = await fixture(true, true); await f.save(); f.proof();
  const unused: DirectoryEntity = { ...makeHeader(990200, { publicationAnchorId: f.input.goal.publicationAnchorId }), kind: 'dit', name: 'Second DIT', externalKeys: [] };
  f.repository.append('directory_entity', unused, null);
  const catalog = f.repository.readPublishedCatalog(); f.setInventories({ entityRefs: catalog.filter(v => v.entityType === 'directory_entity').map(v => ref(v.entityType, v.value)), linkRefs: catalog.filter(v => v.entityType === 'directory_link').map(v => ref(v.entityType, v.value)) }, [f.input.assignment], []);
  expect((await f.test()).result).toMatchObject({ complete: true });
  const publishing = publicationHarness(f); expect((await publishing.preview()).errors).toEqual([]);
  const product = f.repository.readPublishedHead<DirectoryEntity>({ entityType: 'directory_entity', id: f.input.assignment.scope.id })!;
  if (change === 'own-key') { const draft = await f.open('directory_entity', { entityType: 'directory_entity', id: product.id }); await f.execute('organization.draft.save', { draftId: draft.draftId, definition: { ...business(product), externalKeys: [] } }); }
  else if (change === 'main-key') publishing.set('directory_entity', { ...product, revision: 3, externalKeys: [] });
  else if (change === 'main-add') publishing.set('directory_entity', { ...unused, id: fixtureId(990201) });
  else if (change === 'main-remove') publishing.remove('directory_entity', unused.id);
  else { const link = f.repository.readPublishedHead<DirectoryLink>({ entityType: 'directory_link', id: fixtureId(990003) })!; if (link.kind === 'leader') throw Error('Expected parent link'); publishing.set('directory_link', { ...link, revision: 2, from: { entityType: 'directory_entity', id: unused.id } }); }
  expect((await publishing.preview()).errors).toContainEqual(expect.objectContaining({ code: 'SCENARIO_TEST_REQUIRED' }));
});
