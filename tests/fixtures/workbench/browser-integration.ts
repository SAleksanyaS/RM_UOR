import path from 'node:path';
import { createHash } from 'node:crypto';
import { createNativeBrowserFixture } from './native-browser';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture } from './factories';
import { seedGraph } from './repository';
import { business } from './drafts';
import type { Capture, DirectoryEntity, DirectoryLink, SourceDefinition, SourceFieldMapping } from '../../../src/domain/workbench/entities';
import type { VersionRef } from '../../../src/domain/workbench/primitives';
import type { BrowserScenarioRuntimePort, BrowserExportBinding } from '../../../src/features/connectors/workbench-source-contracts';
import type { BrowserReplayInput, RecordedBrowserScenario } from '../../../src/features/connectors/workbench-browser-runtime';
import { createBrowserScenarioService } from '../../../src/features/connectors/workbench-browser-scenarios';
import { createBrowserProfileService } from '../../../src/features/connectors/workbench-browser-profile';
import { createBrowserRecorderService } from '../../../src/features/connectors/workbench-browser-recorder';
import { createBrowserSourceAdapter, createBrowserLoginService } from '../../../src/features/connectors/workbench-browser-source';
import { createSharedBrowserResultReader } from '../../../src/features/connectors/workbench-browser-results';
import { registerBrowserCommands, registerBrowserQueries } from '../../../src/features/connectors/workbench-browser-commands';
import { createSourceStore } from '../../../src/features/connectors/workbench-source-store';
import { createSourceService, registerSourceCommands } from '../../../src/features/connectors/workbench-source-service';
import { parseWorkbenchTable } from '../../../src/features/tabular-import/workbench-parser';
import { enrichSourceRows } from '../../../src/features/catalog/workbench-directory';
import { createWorkbenchRepository } from '../../../src/server/storage/workbench-repository';
import { createJobStore } from '../../../src/server/workbench/jobs';
import { createCommandRegistry } from '../../../src/server/workbench/command-registry';
import { QueryRegistry } from '../../../src/server/workbench/query-registry';
import { createWorkbenchApp } from '../../../src/server/workbench/app';
import { createLocalSessionStore } from '../../../src/server/workbench/session';
import { createFileStore, defaultFileLimits } from '../../../src/server/workbench/files';
import { createDraftStore } from '../../../src/features/catalog/workbench-draft-store';
import { createDraftService } from '../../../src/features/catalog/workbench-drafts';
import { createDirectoryStore } from '../../../src/features/catalog/workbench-directory-store';
import { createEvidenceService } from '../../../src/features/evidence/workbench-evidence';
import { registerDraftCommands } from '../../../src/features/catalog/workbench-draft-commands';
import { canUseCapability, type OwnAccessProfile } from '../../../src/features/identity/workbench-access-policy';
import { WorkbenchHttpError } from '../../../src/server/workbench/protocol';
import { stableJson } from '../../../src/server/workbench/command-store';
import { PublishingService } from '../../../src/features/publishing/workbench/publishing-service';
import { registerPublishingCommands } from '../../../src/features/publishing/workbench/register-commands';
import { createPackageArtifactStore } from '../../../src/features/publishing/workbench/package-artifacts';
import { buildPackageManifest, canonicalBytes } from '../../../src/features/publishing/workbench/package-manifest';
import type { VerifiedMain } from '../../../src/features/publishing/workbench/contracts';
import { createWorkbenchReadIndex } from '../../../src/features/catalog/workbench-read-index';
import { createPreferencesService } from '../../../src/features/system/workbench-preferences';
import { registerPreferencesQueries } from '../../../src/features/system/workbench-preferences-query';
import { registerConfigurationCommands } from '../../../src/features/knowledge/workbench-fields';
import { createNotificationService } from '../../../src/features/execution/workbench-notifications';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { privateDevServerDeny } from '../../../scripts/vite-private-files';

const ref = (entityType: string, v: { id: string; revision: number }): VersionRef => ({ entityType, id: v.id, revision: v.revision });
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(stableJson(value)).digest('hex');
/** Entirely synthetic publication authority; all browser/API/domain/storage operations are real. */
export async function createBrowserIntegrationHarness() {
  const native = await createNativeBrowserFixture(), report = native.report;
  const clock = { now: () => '2026-11-01T08:00:00Z' };
  const dit = { kind: 'dit' as const, id: fixtureId(100) }, cluster = fixtureId(103);
  const products = [101, 102].map(seed => ({ kind: 'product' as const, id: fixtureId(seed) }));
  const input = makeNumericFixture({ scope: dit, expectedPopulation: products });
  if (input.method.mode !== 'numeric') throw Error('Expected numeric fixture');
  input.method.rules[0].reducer = { kind: 'sum', valueField: 'demo_value' };
  const graph = makeEntityGraph(input); graph.entries = graph.entries.filter(row => !['capture', 'observed_fact'].includes(row.entityType));
  const source = graph.entries.find(row => row.entityType === 'source_definition')!.value as SourceDefinition;
  const mapping = graph.entries.find(row => row.entityType === 'source_field_mapping')!.value as SourceFieldMapping;
  Object.assign(source, { publicLocator: report.origin + '/report' });
  Object.assign(mapping, { rowKeyFields: ['Key'], dimensionFields: { product: 'Product' }, productKeyField: 'Product', fixedScope: null, dateField: 'Date', metricFields: [{ metricId: input.metrics[0].id, fields: { demo_value: 'Amount' } }], parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'dd.mm.yyyy', decimalSeparator: ',', groupSeparator: 'none' } });
  for (const [i, product] of products.entries()) { const entity = graph.entries.find(row => row.entityType === 'directory_entity' && row.value.id === product.id)!.value as DirectoryEntity; entity.name = `Продукт ${i ? 'Б' : 'А'}`; entity.externalKeys = [{ sourceId: source.id, key: entity.name }]; }
  const header = (seed: number) => makeHeader(seed, { publicationAnchorId: input.goal.publicationAnchorId });
  graph.entries.push({ entityType: 'directory_entity', value: { ...header(103), kind: 'cluster', name: 'Синтетический кластер', externalKeys: [] } });
  graph.entries.push({ entityType: 'directory_link', value: { ...header(104), kind: 'dit_cluster', from: { entityType: 'directory_entity', id: dit.id }, to: { entityType: 'directory_entity', id: cluster } } });
  graph.entries.push({ entityType: 'directory_link', value: { ...header(109), kind: 'leader', scope: { kind: 'cluster', id: cluster }, personId: input.goal.primaryCuratorPersonId } });
  products.forEach((product, i) => graph.entries.push({ entityType: 'directory_link', value: { ...header(105 + i), kind: 'cluster_product', from: { entityType: 'directory_entity', id: cluster }, to: { entityType: 'directory_entity', id: product.id } } }, { entityType: 'directory_link', value: { ...header(107 + i), kind: 'leader', scope: product, personId: input.goal.primaryCuratorPersonId } }));
  let main: VerifiedMain = { repositoryId: 'T47-SYNTHETIC-LOCAL-ONLY', commit: 'a'.repeat(40), files: new Map(graph.entries.map(row => [`records/${row.entityType}/${row.value.id}/${row.value.revision}.json`, canonicalBytes(row.value)])) };
  let externalWrites = 0, serial = 960000, packageText = '', closed = false;
  const apps: Array<Awaited<ReturnType<typeof installation>>> = [];
  const installationClosers: Array<() => Promise<void>> = [];
  async function installation(role: 'curator' | 'viewer', seed: number, initial: boolean) {
    const root = path.join(native.root, String(seed));
    const repository = createWorkbenchRepository({ filename: path.join(root, 'data.sqlite'), artifactRoot: path.join(root, 'artifacts') });
    let ownedApp: Awaited<ReturnType<typeof createWorkbenchApp>> | undefined, installationClosed = false;
    const uiClosers: Array<() => Promise<unknown>> = [];
    let commands: ReturnType<typeof createCommandRegistry>;
    const close = async () => { if (installationClosed) return; installationClosed = true; for (const closeUi of uiClosers.reverse()) await closeUi(); await native.runtime.closeOwned({ installationId: fixtureId(seed), profilePersonId: role === 'curator' ? fixtureId(17) : null }); await commands?.idle(); await ownedApp?.close(); repository.close(); };
    installationClosers.push(close);
    if (initial) seedGraph(repository, graph);
    const installationId = fixtureId(seed), own: OwnAccessProfile = { role, personId: role === 'curator' ? fixtureId(17) : null, displayName: role === 'curator' ? 'Синтетический куратор' : null, policyState: role === 'curator' ? 'verified' : 'unavailable', checkedAt: clock.now() };
    const jobs = createJobStore({ repository, clock });
    const accessPolicy = { async resolveOwnAccess() { return { ...own }; }, async assertCommandAllowed(name: string) { const capability = commands.getCapability(name); if (!capability || !canUseCapability(own, capability)) throw new WorkbenchHttpError(403, 'ACCESS_DENIED', 'Denied'); return { ...own }; }, async assertFreshPublishAllowed() { return { ...own }; } };
    commands = createCommandRegistry({ repository, jobs, accessPolicy });
    const files = createFileStore({ directory: path.join(root, 'files'), limits: defaultFileLimits });
    const draftStore = createDraftStore({ repository, artifactDirectory: path.join(root, 'drafts') });
    const sources = createSourceStore({ repository });
    const drafts = createDraftService({ repository, store: draftStore, files, clock, directory: createDirectoryStore({ repository }), evidence: createEvidenceService({ repository, store: draftStore, files, clock }), sourceState: sources });
    registerDraftCommands(commands, drafts);
    const profiles = createBrowserProfileService({ repository, clock, runtimeRoot: root });
    const owner = { installationId, profilePersonId: own.personId };
    let observed: { input: BrowserReplayInput; payloadHash: string; beforeDelivery: number } | null = null;
    const inspectObservation = (binding: BrowserExportBinding) => {
        const delivery = report.deliveries().slice(observed?.beforeDelivery ?? Infinity).find(item => item.payloadHash === binding.payloadHash);
        const scenario = observed?.input.scenario;
        if (!observed || !scenario || !delivery || stableJson(observed.input.owner) !== stableJson(binding.owner) || observed.payloadHash !== binding.payloadHash || scenario.sourceId !== binding.sourceRef.id || scenario.startUrl !== source.publicLocator) return null;
        const ownEntries = own.personId ? draftStore.listOwnPackages(installationId, own.personId).flatMap(pkg => pkg.entries) : [];
        const draftScenario = ownEntries.find(entry => stableJson(entry.versionRef) === stableJson(ref('browser_scenario', scenario)) && stableJson(entry.definition) === stableJson(business(scenario)));
        const exactSource = ownEntries.find(entry => stableJson(entry.versionRef) === stableJson(binding.sourceRef));
        const publishedSource = repository.readVersion<SourceDefinition>(binding.sourceRef);
        const resolvedSource = exactSource ? { ...exactSource.header, ...exactSource.definition } as SourceDefinition : publishedSource;
        const expectedHash = draftScenario ? digest({ scenarioRef: draftScenario.versionRef, definition: draftScenario.definition }) : digest(scenario);
        const ownMapping = ownEntries.find(entry => stableJson(entry.versionRef) === stableJson(binding.mappingRef));
        const resolvedMapping = ownMapping ? { ...ownMapping.header, ...ownMapping.definition } as SourceFieldMapping : repository.readVersion<SourceFieldMapping>(binding.mappingRef);
        if (expectedHash !== binding.scenarioHash || !resolvedSource || stableJson(resolvedSource.mappingRef) !== stableJson(binding.mappingRef) || stableJson(resolvedSource.browserScenarioRef) !== stableJson(ref('browser_scenario', scenario)) || resolvedMapping?.sourceId !== scenario.sourceId) return null;
        const expectedPeriod = scenario.parameters.field_period, expectedScope = scenario.parameters.field_scope;
        return { ...binding, observedAt: clock.now(), expiresAt: '2026-11-01T08:05:00Z', selectionVerified: delivery.period === expectedPeriod && delivery.scope === expectedScope && expectedPeriod === '2026-10' && expectedScope === 'all', allPagesExported: delivery.complete && delivery.declaredRows === delivery.deliveredRows, reportedRows: delivery.declaredRows };
    };
    const runtime: BrowserScenarioRuntimePort = { ...native.runtime,
      async replay(request, signal) {
        const beforeDelivery = report.deliveries().length;
        const bytes = await native.runtime.replay(request, signal);
        observed = { input: structuredClone(request), payloadHash: 'sha256:' + createHash('sha256').update(bytes.bytes).digest('hex'), beforeDelivery };
        return bytes;
      },
      async inspectExport(binding) {
        const observation = inspectObservation(binding);
        if (!observation || binding.sourceRef.id !== source.id || !repository.readPublishedHead({ entityType: 'goal_assignment', id: input.assignment.id })) return null;
        return { ...observation, publishedAssignment: ref('goal_assignment', input.assignment) };
      },
      async inspectPreviewExport(binding) {
        const { assignment, ...exportBinding } = binding;
        const observation = inspectObservation(exportBinding);
        const pkg = own.personId ? draftStore.listOwnPackages(installationId, own.personId).find(value => value.packageId === assignment.packageId) : null;
        const entry = pkg?.entries.find(value => stableJson(value.versionRef) === stableJson(assignment.assignmentRef));
        const ownSource = pkg?.entries.find(value => stableJson(value.versionRef) === stableJson(binding.sourceRef));
        if (!observation || !pkg || !entry || assignment.kind !== 'own-draft' || assignment.editToken !== `draft:${pkg.packageId}:${pkg.revision}` || entry.entityRef.entityType !== 'goal_assignment' || entry.definition.goalId !== ownSource?.definition.goalId) return null;
        return { ...observation, assignment };
      },
    };
    const directory = () => repository.readPublishedCatalog().filter(row => row.entityType === 'directory_entity').map(row => row.value as DirectoryEntity);
    const links = () => repository.readPublishedDirectoryLinks() as DirectoryLink[];
    const enricher = { enrich: ({ rows }: { rows: Capture['canonicalRows'] }) => {
      const ownEntries = own.personId ? draftStore.listOwnPackages(installationId, own.personId).flatMap(pkg => pkg.entries) : [];
      const sourceId = observed?.input.scenario.sourceId ?? source.id;
      const ownSource = ownEntries.find(entry => entry.entityRef.entityType === 'source_definition' && entry.entityRef.id === sourceId);
      const ownMapping = ownSource && ownEntries.find(entry => stableJson(entry.versionRef) === stableJson(ownSource.definition.mappingRef));
      const currentMapping = ownMapping ? { ...ownMapping.header, ...ownMapping.definition } as SourceFieldMapping : mapping;
      return enrichSourceRows({ capture: { sourceId, mappingRef: ref('source_field_mapping', currentMapping), rawRows: rows.map(row => ({ rowKey: row.rowKey, cells: Object.fromEntries(Object.entries(currentMapping.dimensionFields).map(([key, raw]) => [raw, { kind: 'text' as const, original: row.dimensions[key] }])) })), canonicalRows: rows }, mapping: currentMapping, directoryEntities: directory(), directoryLinks: links() });
    } };
    const scenarios = createBrowserScenarioService({ repository, drafts, runtime, profiles, parser: parseWorkbenchTable, enricher, clock, accessPolicy });
    const recorder = createBrowserRecorderService({ repository, drafts, runtime, profiles, jobs, clock, accessPolicy });
    registerBrowserCommands(commands, { profiles, scenarios, recorder, login: createBrowserLoginService({ repository, runtime, profiles, scenarios }) });
    const queries = new QueryRegistry(); registerBrowserQueries(queries, { profiles, recorder, drafts });
    const adapter = createBrowserSourceAdapter({ runtime, profiles, scenarios, clock });
    registerSourceCommands(commands, createSourceService({ repository, store: sources, adapters: new Map(), browserAdapter: adapter, normalizer: adapter, enricher, jobs, clock, recheckGuard: async () => { await accessPolicy.assertCommandAllowed('source.capture'); } }));
    const artifacts = createPackageArtifactStore({ artifactRoot: path.join(root, 'packages') });
    const unexpectedWrite = async (): Promise<never> => { externalWrites++; throw Error('No external writes authorized for synthetic main fixture'); };
    const git = { readMain: async () => main, prepare: unexpectedWrite, inspectRemote: unexpectedWrite, verifyPrepared: unexpectedWrite };
    const publishing = new PublishingService({ repository, drafts, clock, accessPolicy, jobs, jobSink: jobs, artifacts, publication: { mode: 'demo-only', classifyRecord: () => true }, git }); registerPublishingCommands(commands, publishing);
    const preferences = createPreferencesService({ repository, installationId, clock }); registerPreferencesQueries(queries, preferences); registerConfigurationCommands(commands, { drafts, preferences });
    const notifications = createNotificationService({ repository, provider: { async current() { throw Error('Native fixture does not poll outside services'); } }, preferences: id => ({ notificationPersonId: preferences.get(id).notificationPersonId ?? null }) });
    const allowedOrigins = ['http://127.0.0.1:5173'];
    const app = await createWorkbenchApp({ repository, clock, hostname: () => 't47-synthetic-host', installationId, accessPolicy, commands, queries, jobs, modules: [], sessions: createLocalSessionStore({ clock }), allowedOrigins, files, browserResults: createSharedBrowserResultReader({ sources }), browserRecordings: recorder, queryPorts: { repository, index: createWorkbenchReadIndex(repository), drafts, publishing: publishing.readPort, sources, notifications, jobs, preferences }, readState: { publishedCommit: () => main.commit, defaultContext: async () => ({ scopePath: { ditId: dit.id, clusterId: null, productId: null, teamId: null }, goalId: input.goal.id, time: { kind: 'as_of', date: '2026-10-31' }, resultMode: 'current', snapshotId: null }) } });
    ownedApp = app;
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const session = await fetch(origin + '/api/v1/session'); const cookie = session.headers.get('set-cookie')!.split(';')[0]; const sessionData = (await session.json()).data, csrf = sessionData.csrfToken;
    let token: string | null = null, packageId: string | null = null;
    const headers = { cookie, origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', 'x-csrf-token': csrf };
    async function send(name: string, payload: Record<string, unknown>, commandId = fixtureId(serial++)) {
      const response = await fetch(origin + '/api/v1/commands', { method: 'POST', headers, body: JSON.stringify({ name, payload, commandId, baseRevision: token }) });
      const envelope = await response.json(); if (!response.ok) throw Error(name + ': ' + JSON.stringify(envelope));
      const accepted = envelope.data; if (accepted.editToken) token = accepted.editToken; return accepted;
    }
    async function settled(accepted: { jobId?: string }) { await commands.idle(); if (!accepted.jobId) throw Error('Expected real asynchronous job'); const response = await fetch(origin + '/api/v1/jobs/' + accepted.jobId, { headers: { cookie } }); if (!response.ok) throw Error('Job read failed'); return (await response.json()).data; }
    async function open(entityType: string, entityRef: { entityType: string; id: string } | null = null) { const response = await send('draft.open', { entityType, ref: entityRef, packageId }); const result = response.result; packageId = draftStore.getEntry(result.draftId)!.packageId; return result; }
    async function query(name: string, filter: Record<string, unknown>) { const response = await fetch(origin + '/api/v1/queries/' + name, { method: 'POST', headers, body: JSON.stringify({ context: name.startsWith('source.browser.') ? null : sessionData.defaultContext, filter, sort: [], page: { limit: 50, cursor: null } }) }); if (!response.ok) throw Error(await response.text()); return (await response.json()).data; }
    async function refreshPackage() { const queue = await query('uor.queue', {}); if (queue.items.length !== 1) throw Error('Expected one actual own package'); packageId = queue.items[0].packageRef.id; token = queue.items[0].editToken; }
    async function configure() { return send('source.browser.profile.set', { sourceId: source.id, profileId: 'synthetic-own', profile: native.profile, expectedRevision: null }); }
    async function openUi() {
      const vite = await createViteServer({ configFile: false, root: process.cwd(), plugins: [react(), { name: 't47-native-ui', configureServer(server) { server.middlewares.use((req, res, next) => { if (!req.url?.startsWith('/data') && req.url !== '/') return next(); void server.transformIndexHtml(req.url, `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script id="t47-props" type="application/json">${JSON.stringify({ sourceRef: sourceRef() })}</script><script type="module" src="/tests/fixtures/workbench/browser-ui.tsx"></script></html>`).then(html => { res.setHeader('content-type', 'text/html'); res.end(html); }).catch(next); }); } }], server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { strict: true, deny: [...privateDevServerDeny] }, proxy: { '/api': { target: origin } } } });
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      uiClosers.push(async () => { await browser?.close(); await vite.close(); });
      await vite.listen(); const address = vite.httpServer!.address() as { port: number }; const uiOrigin = 'http://127.0.0.1:' + address.port; allowedOrigins.push(uiOrigin);
      browser = await chromium.launch({ executablePath: native.executablePath, headless: true, chromiumSandbox: true }); const page = await browser.newPage(); await page.goto(uiOrigin + '/data');
      return { page, origin: uiOrigin };
    }
    const sourceRef = () => ref('source_definition', repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: source.id })!);
    function installCaptureBinding() {
      const current = repository.readPublishedHead<SourceDefinition>({ entityType: 'source_definition', id: source.id })!;
      sources.installPublished([{ goalRef: ref('core_goal_definition', input.goal), sourceRef: ref('source_definition', current), mappingRef: current.mappingRef!, assignmentRef: ref('goal_assignment', input.assignment), templateRef: null, methodRef: ref('method_version', input.method), metricRefs: input.metrics.map(metric => ref('metric_definition', metric)), directoryEntityRefs: directory().map(entity => ref('directory_entity', entity)), directoryLinkRefs: links().map(link => ref('directory_link', link)), directoryRevision: 't47-synthetic-published-directory' }]);
      sources.bindAdapter({ sourceId: source.id, adapterKey: 'browser', profileRef: null, revision: 't47-browser' });
      sources.saveAllowedContext({ installationId, goalId: input.goal.id, revision: 't47-context', context: { scopePath: { ditId: dit.id, clusterId: null, productId: null, teamId: null }, goalId: input.goal.id, time: { kind: 'as_of', date: '2026-10-31' }, resultMode: 'current', snapshotId: null } }, null);
    }
    return { repository, jobs, commands, drafts, draftStore, sources, artifacts, origin, cookie, send, settled, open, configure, query, openUi, refreshPackage, sourceRef, owner, recorder, token: () => token, packageId: () => packageId, setPerson: (id: string | null) => { own.personId = id; }, installCaptureBinding, close };
  }
  const closeAll = async () => { if (closed) return; closed = true; await report.close(); await native.closeContexts(); for (const close of installationClosers.reverse()) await close(); await native.close(); };
  try {
  const curator = await installation('curator', 950101, true); apps.push(curator); await curator.configure();
  let reader: Awaited<ReturnType<typeof installation>> | undefined;
  let lastCapture: VersionRef | undefined;
  async function gated<T>(operation: () => Promise<T>) { const pending = operation(); await Promise.race([report.waitForEvent('export-requested'), pending.then(() => { throw Error('Operation completed without requesting actual export'); })]); report.release('download'); return pending; }
  return { report, native, curator,
    async screenshot(review: RecordedBrowserScenario) { return fetch(curator.origin + `/api/v1/browser/recordings/${review.recordingId}/screenshots/${review.screenshotHandles[0]}`, { headers: { cookie: curator.cookie } }); },
    async curatorRecordAndFinish() {
      const accepted = await curator.send('source.browser.record.start', { sourceRef: curator.sourceRef(), startUrl: native.input.startUrl, authenticatedSelector: native.input.authenticatedSelector });
      const started = await curator.settled(accepted); if (started.status !== 'succeeded') throw Error(JSON.stringify(started));
      const recordingId = started.result.recordingId;
      await native.login(); await native.page().getByLabel('Период', { exact: true }).fill('2026-10'); await native.page().getByLabel('Период', { exact: true }).press('Tab');
      await native.page().getByLabel('Состав', { exact: true }).selectOption('all');
      await native.page().getByRole('button', { name: 'Выгрузить CSV' }).click({ noWaitAfter: true });
      await report.waitForEvent('export-requested'); report.release('download');
      await native.runtime.waitForCompletion({ owner: curator.owner, handleId: recordingId });
      return (await curator.send('source.browser.record.finish', { recordingId, save: false })).result as RecordedBrowserScenario;
    },
    async testAndSaveDraft(review: RecordedBrowserScenario) {
      const scenarioDraft = await curator.open('browser_scenario'), sourceDraft = await curator.open('source_definition', { entityType: 'source_definition', id: source.id });
      const definition = { sourceId: source.id, startUrl: review.startUrl, authenticatedSelector: review.authenticatedSelector, steps: review.steps, parameters: { field_period: '2026-10', field_scope: 'all' }, expectedExport: { format: 'csv', requiredColumns: ['Key', 'Product', 'Leader', 'Amount', 'Date'] } };
      const saved = await curator.send('source.browserScenario.draft.save', { draftId: scenarioDraft.draftId, definition });
      await curator.send('source.draft.save', { draftId: sourceDraft.draftId, definition: { ...business(source), browserScenarioRef: saved.result.versionRef } });
      const tested = await gated(async () => curator.settled(await curator.send('source.browser.record.test', { draftId: scenarioDraft.draftId })));
      if (tested.status !== 'succeeded') throw Error(JSON.stringify(tested));
      const finalSave = await curator.send('source.browserScenario.draft.save', { draftId: scenarioDraft.draftId, definition });
      if (!finalSave.result.complete) throw Error(JSON.stringify(finalSave));
      const current = curator.draftStore.getEntry(sourceDraft.draftId)!;
      if (stableJson(current.definition.browserScenarioRef) !== stableJson(finalSave.result.versionRef)) await curator.send('source.draft.save', { draftId: sourceDraft.draftId, definition: { ...current.definition, browserScenarioRef: finalSave.result.versionRef } });
      return tested.result;
    },
    async testNewPrivateGoal(review: RecordedBrowserScenario) {
      const goal = await curator.open('core_goal_definition'), newSource = await curator.open('source_definition'), newMapping = await curator.open('source_field_mapping'), assignment = await curator.open('goal_assignment'), metric = await curator.open('metric_definition'), method = await curator.open('method_version'), scenario = await curator.open('browser_scenario');
      const metricSaved = await curator.send('metric.draft.save', { draftId: metric.draftId, definition: business(input.metrics[0]) });
      if (input.method.mode !== 'numeric') throw Error('Expected numeric method');
      const methodSaved = await curator.send('method.draft.save', { draftId: method.draftId, definition: { ...business(input.method), rules: input.method.rules.map(rule => ({ ...rule, metricRef: metricSaved.result.versionRef })) } });
      await curator.send('goal.draft.save', { draftId: goal.draftId, definition: { ...business(input.goal), title: 'Новая синтетическая цель ОКО', sourceId: newSource.objectId } });
      const mappingSaved = await curator.send('fieldMapping.draft.save', { draftId: newMapping.draftId, definition: { ...business(mapping), sourceId: newSource.objectId, fixedScope: dit, productKeyField: null, dimensionFields: {}, metricFields: [{ metricId: metric.objectId, fields: { demo_value: 'Amount' } }] } });
      const assignmentSaved = await curator.send('assignment.draft.save', { draftId: assignment.draftId, definition: { ...business(input.assignment), goalId: goal.objectId, expectedPopulation: [dit], methodBinding: { kind: 'standalone', methodRef: methodSaved.result.versionRef } } });
      const definition = { sourceId: newSource.objectId, startUrl: review.startUrl, authenticatedSelector: review.authenticatedSelector, steps: review.steps, parameters: { field_period: '2026-10', field_scope: 'all' }, expectedExport: { format: 'csv', requiredColumns: ['Key', 'Product', 'Leader', 'Amount', 'Date'] } };
      const scenarioSaved = await curator.send('source.browserScenario.draft.save', { draftId: scenario.draftId, definition });
      await curator.send('source.draft.save', { draftId: newSource.draftId, definition: { ...business(source), goalId: goal.objectId, mappingRef: mappingSaved.result.versionRef, browserScenarioRef: scenarioSaved.result.versionRef } });
      const profile = await curator.query('source.browser.own', { sourceRef: curator.sourceRef() });
      await curator.send('source.browser.profile.set', { sourceId: newSource.objectId, profileId: 'synthetic-own', profile: native.profile, expectedRevision: profile.revision });
      const tested = await gated(async () => curator.settled(await curator.send('source.browser.record.test', { draftId: scenario.draftId, assignmentRef: assignmentSaved.result.versionRef })));
      const saved = await curator.send('source.browserScenario.draft.save', { draftId: scenario.draftId, definition });
      const preview = await curator.settled(await curator.send('package.preview', { packageId: curator.packageId() }));
      return { tested, saved: saved.result, preview, unpublishedRefs: [goal, newSource, newMapping, assignment, method, metric].map(value => value.entityRef as { entityType: string; id: string }) };
    },
    async applyVerifiedSyntheticMain() {
      await curator.refreshPackage();
      const preview = await curator.settled(await curator.send('package.preview', { packageId: curator.packageId() }));
      if (preview.status !== 'succeeded' || preview.result.errors.length) throw Error(JSON.stringify(preview));
      const packageFiles = await curator.artifacts.readRevision(preview.result.packageRevision);
      const packageId = preview.result.packageRevision.packageId;
      const entries = new Map(graph.entries.map(entry => [entry.entityType + '/' + entry.value.id, { entityType: entry.entityType, value: entry.value }]));
      for (const [name, bytes] of packageFiles) { const match = /^records\/([^/]+)\//.exec(name); if (match) { const value = JSON.parse(Buffer.from(bytes).toString('utf8')); entries.set(match[1] + '/' + value.id, { entityType: match[1] as never, value }); } }
      const files = new Map([...entries.values()].map(entry => [`records/${entry.entityType}/${entry.value.id}/${entry.value.revision}.json`, canonicalBytes({ ...entry.value, publicationAnchorId: packageId })]));
      const { contentHash: _contentHash, ...packageBase } = preview.result.packageRevision;
      const manifest = buildPackageManifest({ package: packageBase, files });
      const prefix = `published/workbench/packages/${packageId}/${manifest.packageRevision.revision}/`;
      main = { repositoryId: 'T47-SYNTHETIC-LOCAL-ONLY', commit: 'b'.repeat(40), files: new Map([...files].map(([name, bytes]) => [prefix + name, bytes])) }; (main.files as Map<string, Uint8Array>).set(prefix + 'manifest.json', canonicalBytes(manifest));
      packageText = [...main.files.values()].map(bytes => Buffer.from(bytes).toString('utf8')).join('\n');
      reader = await installation('viewer', 950102, false); apps.push(reader);
      const applied = await reader.settled(await reader.send('publication.apply', { mainCommit: main.commit })); if (applied.status !== 'succeeded') throw Error(JSON.stringify(applied));
      reader.installCaptureBinding(); await reader.configure();
    },
    async readerCapture(release = false) { if (!reader) throw Error('Reader not created'); const operation = async () => reader!.settled(await reader!.send('source.capture', { goalId: input.goal.id })); const job = await (release ? gated(operation) : operation()); if (job.status === 'succeeded') lastCapture = job.result.captureRef; return job; },
    async readerLogin() { if (!reader) throw Error('Reader not created'); const job = await reader.settled(await reader.send('source.browser.login.open', { sourceRef: reader.sourceRef() })); if (job.status !== 'succeeded') throw Error(JSON.stringify(job)); const hadCookie = (await native.page().context().cookies()).some(cookie => cookie.name === 'oko_fixture'); await native.login(); const finished = await reader.send('source.browser.login.finish', { loginId: job.result.loginId }); if (!finished.result.authenticated) throw Error('Expected actual authenticated report marker'); return { hadCookie }; },
    async download(kind: 'original' | 'enriched') { if (!reader || !lastCapture) throw Error('No accepted capture'); return fetch(reader.origin + `/api/v1/browser/results/${lastCapture.id}/${kind}`, { headers: { cookie: reader.cookie } }); },
    reader: () => { if (!reader) throw Error('No reader'); return reader; },
    async captureDuringDelivery(change: 'cancel' | 'profile') {
      if (!reader) throw Error('No reader');
      const accepted = await reader.send('source.capture', { goalId: input.goal.id }); await report.waitForEvent('export-requested');
      if (change === 'cancel') await reader.send('job.cancel', { jobId: accepted.jobId });
      else { const profile = await reader.query('source.browser.own', { sourceRef: reader.sourceRef() }); await reader.send('source.browser.profile.set', { sourceId: source.id, profileId: profile.profileId, profile: { ...profile.profile, timeoutMs: 9000 }, expectedRevision: profile.revision }); }
      report.release('download'); return reader.settled(accepted);
    },
    async repeatCaptureCommand() {
      if (!reader) throw Error('No reader');
      const commandId = fixtureId(serial++), payload = { goalId: input.goal.id };
      const first = await reader.send('source.capture', payload, commandId); await report.waitForEvent('export-requested');
      const second = await reader.send('source.capture', payload, commandId); report.release('download');
      return { first, second, completed: await reader.settled(first) };
    },
    captureView() { if (!reader || !lastCapture) throw Error('No accepted reader capture'); return reader.sources.readCapture(lastCapture, reader.owner.installationId)!; },
    acceptedCaptures: () => apps.flatMap(app => app.sources.listOwnCaptures(app.owner)),
    count: (type: string) => apps.flatMap(app => app.repository.exportWorkspaceCore()).filter(row => row.entityType === type).length,
    externalWriteCalls: () => externalWrites, packageText: () => packageText, openContexts: native.openContexts,
    close: closeAll,
  };
  } catch (error) { await closeAll(); throw error; }
}
