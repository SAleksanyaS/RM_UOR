import type { Clock, VersionRef } from '../../../domain/workbench/primitives';
import type { SourceDefinition, SourceFieldMapping, DirectoryEntity, DirectoryLink } from '../../../domain/workbench/entities';
import { makeHeader, fixtureId } from '../../../../tests/fixtures/workbench/factories';
import type { WorkbenchRepository } from '../../storage/workbench-repository';
import type { CommandContext, CommandRegistry } from '../command-registry';
import type { QueryRegistry } from '../query-registry';
import type { JobStore } from '../jobs';
import type { AccessPolicyService, OwnAccessProfile } from '../../../features/identity/workbench-access-policy';
import type { DraftService } from '../../../features/catalog/workbench-drafts';
import { createBrowserScenarioService } from '../../../features/connectors/workbench-browser-scenarios';
import { createBrowserProfileService } from '../../../features/connectors/workbench-browser-profile';
import { createBrowserRecorderService } from '../../../features/connectors/workbench-browser-recorder';
import { createBrowserLoginService, createBrowserSourceAdapter } from '../../../features/connectors/workbench-browser-source';
import { registerBrowserCommands, registerBrowserQueries } from '../../../features/connectors/workbench-browser-commands';
import { parseWorkbenchTable } from '../../../features/tabular-import/workbench-parser';
import { enrichSourceRows } from '../../../features/catalog/workbench-directory';
import type { BrowserScenarioRuntimePort } from '../../../features/connectors/workbench-source-contracts';
import type { BrowserWorkflowRuntimePort } from '../../../features/connectors/workbench-browser-runtime';
import { privateProfileSchema } from '../../../features/connectors/contracts';
import { createSourceService, registerSourceCommands } from '../../../features/connectors/workbench-source-service';
import type { SourceStore } from '../../../features/connectors/workbench-source-store';
import { WorkbenchHttpError, type GlobalContext } from '../protocol';

export type BrowserFixtureOptions = { unconfigured?: boolean; partial?: boolean };
export type BrowserTesting = { completeRecording(): void; holdReplay(): () => void; revoke(): void; failStart(code: string | null): void };
/** Only the native browser boundary is synthetic. Commands, jobs, parser, profiles and draft CAS are real. */
export async function composeBrowserFixture(args: { options: BrowserFixtureOptions; root: string; repository: WorkbenchRepository; drafts: DraftService; commands: CommandRegistry; queries: QueryRegistry; clock: Clock; jobs: JobStore; accessPolicy: AccessPolicyService; own: OwnAccessProfile; refs: Record<string, VersionRef>; sources: SourceStore; context: GlobalContext | null }): Promise<BrowserTesting> {
  const { repository, drafts, commands, queries, clock, jobs, accessPolicy, own, refs, sources } = args;
  let completed = false, replayGate: Promise<void> | null = null, startError: string | null = null;
  let recordingSerial = 0, recordedUrl = '', recordedMarker = '', liveRecording = false;
  const source = refs.source && repository.readVersion<SourceDefinition>(refs.source);
  if (!source || !source.mappingRef || !args.context) throw Error('Browser fixture requires a published numeric goal');
  const previousMapping = repository.readVersion<SourceFieldMapping>(source.mappingRef)!;
  const mapping = { ...previousMapping, revision: previousMapping.revision + 1, fixedScope: { kind: 'dit' as const, id: fixtureId(100) }, productKeyField: null };
  const scenario = { ...makeHeader(880001, { publicationAnchorId: source.publicationAnchorId }), sourceId: source.id, startUrl: 'https://report.example.invalid/report', authenticatedSelector: '#report', steps: [{ action: 'fill' as const, locator: { kind: 'label' as const, text: 'Период', exact: true as const }, parameter: 'period' }, { action: 'download' as const, locator: { kind: 'role' as const, role: 'button' as const, name: 'Выгрузить', exact: true as const } }], parameters: { period: '2026-10' }, expectedExport: { format: 'csv' as const, requiredColumns: ['demo_value'] } };
  const ref = (entityType: string, v: { id: string; revision: number }) => ({ entityType, id: v.id, revision: v.revision });
  const next = { ...source, revision: source.revision + 1, kind: 'qlik' as const, publicLocator: scenario.startUrl, mappingRef: ref('source_field_mapping', mapping), browserScenarioRef: ref('browser_scenario', scenario) };
  repository.transaction(() => { repository.append('source_field_mapping', mapping, previousMapping.revision); repository.append('browser_scenario', scenario, null); repository.append('source_definition', next, source.revision); }); refs.source = ref('source_definition', next);
  const runtime: BrowserWorkflowRuntimePort & BrowserScenarioRuntimePort = {
    async selectMarker() { return { selector: '#report', label: 'Отчёт' }; },
    async startRecording(input) { if (startError) throw new WorkbenchHttpError(409, startError, startError); completed = false; liveRecording = true; recordedUrl = input.startUrl; recordedMarker = input.authenticatedSelector; return { handleId: fixtureId(881000 + ++recordingSerial), state: 'open', mode: 'record' }; },
    async readRecordingStatus() { return { state: completed ? 'completed' : 'recording', problem: null }; },
    async cancelRecording() { if (!liveRecording) throw new WorkbenchHttpError(404, 'RECORDING_NOT_FOUND', 'Recording ended'); completed = false; liveRecording = false; },
    async readRecordingDownload() { return runtime.replay({} as never, new AbortController().signal); },
    async finish() { liveRecording = false; return { recordingId: fixtureId(881000 + recordingSerial), startUrl: recordedUrl, authenticatedSelector: recordedMarker, steps: [{ action: 'goto' as const, url: recordedUrl }, ...scenario.steps], parameterNames: ['period'], screenshotHandles: [], hasDownload: completed }; },
    async waitForCompletion() { return runtime.finish({} as never); },
    async openLogin() { return { handleId: fixtureId(880003), state: 'open', mode: 'login' }; }, async observeLogin() { return true; },
    async replay() { await replayGate; return { name: 'synthetic.csv', bytes: Uint8Array.from(Buffer.from('demo_row_key,demo_scope_id,demo_metric_id,demo_value,demo_date\nr1,dit,m1,92,2026-10-28\n')) as Buffer, contentType: 'text/csv' }; },
    async inspectExport(input) { return { ...input, publishedAssignment: refs.assignment, observedAt: clock.now(), expiresAt: new Date(Date.parse(clock.now()) + 60000).toISOString(), selectionVerified: true, allPagesExported: !args.options.partial, reportedRows: 1 }; },
    async closeOwned() {}, async screenshot() { throw Error('No synthetic screenshot'); },
  };
  const directory = repository.readPublishedCatalog().filter(v => v.entityType === 'directory_entity').map(v => v.value as DirectoryEntity), links = repository.readPublishedDirectoryLinks() as DirectoryLink[];
  const enricher = { enrich: ({ rows }: { rows: import('../../../domain/workbench/entities').CanonicalSourceRow[] }) => enrichSourceRows({ capture: { sourceId: source.id, mappingRef: ref('source_field_mapping', mapping), rawRows: rows.map(row => ({ rowKey: row.rowKey, cells: {} })), canonicalRows: rows }, mapping, directoryEntities: directory, directoryLinks: links }) };
  const profiles = createBrowserProfileService({ repository, clock, runtimeRoot: args.root });
  const scenarios = createBrowserScenarioService({ repository, drafts, runtime, profiles, parser: parseWorkbenchTable, enricher, clock, accessPolicy });
  const recorder = createBrowserRecorderService({ repository, drafts, accessPolicy, runtime, profiles, jobs, clock });
  const login = createBrowserLoginService({ repository, profiles, scenarios, runtime });
  registerBrowserCommands(commands, { profiles, recorder, scenarios, login }); registerBrowserQueries(queries, { profiles, recorder, drafts });
  sources.installPublished([{ goalRef: refs.goal, sourceRef: refs.source, mappingRef: next.mappingRef, assignmentRef: refs.assignment, templateRef: null, methodRef: refs.method, metricRefs: [refs.metric], directoryEntityRefs: directory.map(d => ref('directory_entity', d)), directoryLinkRefs: links.map(d => ref('directory_link', d)), directoryRevision: 'browser-fixture' }]);
  sources.bindAdapter({ sourceId: source.id, adapterKey: 'browser', profileRef: null, revision: 'browser-fixture' });
  sources.saveAllowedContext({ installationId: fixtureId(1), goalId: refs.goal.id, revision: 'browser-context', context: { ...args.context, goalId: refs.goal.id } }, null);
  const browserAdapter = createBrowserSourceAdapter({ runtime, profiles, scenarios, clock });
  registerSourceCommands(commands, createSourceService({ repository, store: sources, adapters: new Map(), browserAdapter, normalizer: browserAdapter, enricher, jobs, clock, recheckGuard: async () => { await accessPolicy.assertCommandAllowed('source.capture'); } }));
  if (!args.options.unconfigured) await profiles.set({ repository, clock, ownAccess: own, installationId: fixtureId(1), actor: { hostname: 'test-workbench-host', installationId: fixtureId(1), profilePersonId: own.personId }, commandId: fixtureId(880004), requestId: fixtureId(880005) } as CommandContext, { sourceId: source.id, profileId: 'own', expectedRevision: null, profile: privateProfileSchema.parse({ allowedOrigins: ['https://report.example.invalid'], browser: { executablePath: process.execPath, profileDirectory: 'own' } }) });
  return { completeRecording() { completed = true; }, holdReplay() { let release!: () => void; replayGate = new Promise<void>(resolve => { release = resolve; }); return release; }, revoke() { own.role = 'viewer'; own.policyState = 'revoked'; }, failStart(code) { startError = code; } };
}
