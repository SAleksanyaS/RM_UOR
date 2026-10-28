import { createHash, randomUUID } from 'node:crypto';
import type { Clock, Header } from '../../domain/workbench/primitives';
import type { SourceFieldMapping } from '../../domain/workbench/entities';
import { uuidSchema } from '../../domain/workbench/primitives';
import { defaultSourceParsingProfile } from '../../domain/workbench/schemas/sources';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext } from '../../server/workbench/command-registry';
import { commitCommandEffect } from '../../server/workbench/command-store';
import type { QueryContext } from '../../server/workbench/query-registry';
import type { JobStore } from '../../server/workbench/jobs';
import type { FileStore } from '../../server/workbench/files';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { canUseCapability } from '../identity/workbench-access-policy';
import { parseWorkbenchTable, type ParsedSourceTable } from '../tabular-import/workbench-parser';
import type { BrowserProfileService } from './workbench-browser-profile';
import type { BrowserWorkflowRuntimePort, BrowserOwner } from './workbench-browser-runtime';
import { checkedUrl, type Downloaded } from './transport';
import type { OkoWorkflowView, OkoWorkspaceView, OkoMapping, OkoDictionaryMapping } from './workbench-workflow-contracts';
import { createOkoWorkflowStore } from './workbench-workflow-store';
import { buildOkoPreviewDirectory, previewOkoTable, serializeOkoEnrichedCsv, type OkoPreviewDirectory } from './workbench-workflow-enrichment';
type Row = Record<string, string | null>;
type Draft = {
    view: OkoWorkflowView;
    revision: string;
    sample: ParsedSourceTable | null;
    dictionaryTable: ParsedSourceTable | null;
    dictionaryRows: Row[];
    format: 'csv' | 'xlsx' | null;
    localMapping?: { header: Header; metricIds: Record<string, string> };
    dictionaryGraph?: OkoPreviewDirectory;
    previousDirectoryGraph?: OkoPreviewDirectory;
    [key: string]: unknown;
};
type Artifact = {
    name: string;
    mimeType: string;
    base64: string;
    hash: string;
};
type StoredResult = {
    original: Artifact;
    enriched: Artifact;
};
export type OkoWorkflowDependencies = {
    repository: WorkbenchRepository;
    runtime: BrowserWorkflowRuntimePort;
    profiles: BrowserProfileService;
    files: FileStore;
    jobs: JobStore;
    clock: Clock;
    setup?: () => OkoWorkspaceView['setup'];
    recheckGuard?: (context: CommandContext) => Promise<void>;
    getDirectory?: (context: QueryContext, sourceId: string) => Promise<Row[]>;
};
const issue = (path: string, code: string, message: string) => ({ path, code, message, ref: null });
const fail = (code: string, message: string, status = 422): never => { throw new WorkbenchHttpError(status, code, message); };
const rawRows = (table: ParsedSourceTable): Row[] => table.rows.map(row => Object.fromEntries(table.columns.map(column => [column, row.cells[column]?.original ?? null])));
const artifact = (download: Downloaded): Artifact => ({ name: download.name, mimeType: download.contentType ?? 'application/octet-stream', base64: Buffer.from(download.bytes).toString('base64'), hash: createHash('sha256').update(download.bytes).digest('hex') });
export function createOkoWorkflowService(deps: OkoWorkflowDependencies) {
    const { repository, runtime, profiles, files, jobs, clock } = deps, store = createOkoWorkflowStore(repository);
    const live = new Set<string>(), logins = new Map<string, {
        owner: string;
        handleId: string;
    }>();
    const browserOwners = new Map<string, BrowserOwner>(), controllers = new Set<AbortController>();
    let shuttingDown = false;
    const owner = (context: QueryContext) => `${context.installationId}/${context.ownAccess.personId ?? 'unassigned'}`;
    const browserOwner = (context: QueryContext) => {
        if (shuttingDown) throw new DOMException('Workflow service is closing', 'AbortError');
        const value = { installationId: context.installationId, profilePersonId: context.ownAccess.personId };
        browserOwners.set(owner(context), value);
        return value;
    };
    const load = (context: QueryContext, id: string): Draft => store.get<Draft>(owner(context), id) ?? fail('WORKFLOW_NOT_FOUND', 'Own workflow not found', 404);
    const requirePrepare = (context: CommandContext) => { if (!canUseCapability(context.ownAccess, 'uor.prepare'))
        fail('COMMAND_FORBIDDEN', 'Preparation requires an active curator profile', 403); };
    const freshPrepare = async (context: CommandContext) => { if (shuttingDown) throw new DOMException('Workflow service is closing', 'AbortError'); requirePrepare(context); await deps.recheckGuard?.(context); };
    const mutationQueues = new Map<string, Promise<void>>();
    const serializeMutation = async <T>(context: CommandContext, input: { workflowId?: string }, action: () => Promise<T>): Promise<T> => {
        const key = owner(context) + '/' + (input.workflowId ?? 'new'); const previous = mutationQueues.get(key) ?? Promise.resolve();
        let release!: () => void; const ownSlot = new Promise<void>(resolve => { release = resolve; }); const tail = previous.then(() => ownSlot); mutationQueues.set(key, tail);
        await previous;
        try { if (shuttingDown) throw new DOMException('Workflow service is closing', 'AbortError'); return await action(); }
        finally { release(); if (mutationQueues.get(key) === tail) mutationQueues.delete(key); }
    };
    const cas = (draft: Draft, expected: string) => { if (draft.revision !== expected)
        fail('REVISION_CONFLICT', 'Workflow changed; reload your draft', 409); };
    const persist = (context: QueryContext, draft: Draft) => { const expected = draft.revision; draft.revision = randomUUID(); draft.view.revision = draft.revision; store.save(owner(context), draft.view.workflowId, expected, draft); };
    const privateHeader = (context: CommandContext): Header => ({ schemaVersion: 1, id: randomUUID(), revision: 1, recordedAt: clock.now(), actor: context.actor, publicationAnchorId: null });
    const localSourceMapping = (context: CommandContext, draft: Draft): SourceFieldMapping => {
        const input = draft.view.mapping!;
        draft.localMapping ??= { header: privateHeader(context), metricIds: {} };
        for (const field of Object.keys(input.numberColumns)) draft.localMapping.metricIds[field] ??= randomUUID();
        return { ...draft.localMapping.header, sourceId: draft.view.sourceId, rowKeyFields: input.rowKeyColumns, productKeyField: input.productKeyColumn, fixedScope: null, dimensionFields: input.dimensionColumns,
            metricFields: Object.entries(input.numberColumns).map(([field, column]) => ({ metricId: draft.localMapping!.metricIds[field], fields: { [field]: column } })), dateField: input.dateColumn, periodStartField: null, periodEndField: null, unitField: input.unitColumn, fixedUnitCode: input.fixedUnitCode, parsingProfile: draft.view.parsingProfile };
    };
    const view = async (context: QueryContext, draft: Draft): Promise<OkoWorkflowView> => {
        const result = structuredClone(draft.view);
        result.profile = await profiles.getOwn(context, result.sourceId);
        if (result.recording.state === 'recording' && result.recording.recordingId) {
            const key = owner(context) + '/' + result.workflowId;
            if (!live.has(key))
                result.recording = { ...result.recording, state: 'interrupted', problem: { code: 'RECORDING_INTERRUPTED', message: 'Application restarted; record the scenario again' } };
            else {
                const status = await runtime.readRecordingStatus({ owner: browserOwner(context), handleId: result.recording.recordingId });
                result.recording = { ...result.recording, ...status };
            }
        }
        return result;
    };
    const ownProfile = async (context: QueryContext, draft: Draft) => { const profile = await profiles.getOwn(context, draft.view.sourceId); if (!profile.configured || !profile.profile)
        fail('BROWSER_CONFIGURATION_REQUIRED', 'Save your browser profile first', 409); return profile; };
    const ensureColumns = (columns: string[], mapping: OkoMapping) => { const required = [...mapping.rowKeyColumns, ...Object.values(mapping.dimensionColumns), ...Object.values(mapping.numberColumns), mapping.productKeyColumn, mapping.dateColumn, mapping.unitColumn].filter((c): c is string => c !== null); if (required.some(column => !columns.includes(column)))
        fail('SOURCE_SCHEMA_CHANGED', 'A mapped column is absent'); };
    const cancelled = (context: CommandContext, signal: AbortSignal) => { signal.throwIfAborted(); const job = jobs.findByCommand(context.commandId, context.installationId); if (job?.status === 'cancelled')
        throw new DOMException('Cancelled', 'AbortError'); };
    const runControlled = async <T>(context: CommandContext, action: (signal: AbortSignal) => Promise<T>) => { if(shuttingDown)throw new DOMException('Workflow service is closing','AbortError');const controller = new AbortController(), job = jobs.findByCommand(context.commandId, context.installationId); controllers.add(controller);if (job) {
        jobs.registerControl(job.jobId, { cancel: async () => { controller.abort(); } });
        jobs.update(job.jobId, { cancelAvailable: true });
    } try{return await action(controller.signal);}finally{controllers.delete(controller);} };
    const service = {
        async shutdown():Promise<void>{shuttingDown=true;for(const controller of controllers)controller.abort();await Promise.all([...browserOwners.values()].map(value=>runtime.closeOwned(value)));live.clear();logins.clear();},
        async workspace(context: QueryContext, workflowId?: string): Promise<OkoWorkspaceView> { const drafts = store.list<Draft>(owner(context)); return { workflows: drafts.map(d => ({ workflowId: d.view.workflowId, title: d.view.title, revision: d.revision })), current: workflowId ? await view(context, load(context, workflowId)) : drafts.length ? await view(context, drafts[0]) : null, setup: deps.setup?.() ?? { hostname: '', registryConfigured: false, message: 'Hostname registry setup is unavailable' } }; },
        async open(context: CommandContext, input: {
            workflowId?: string;
            title?: string;
        }) { requirePrepare(context); if (input.workflowId)
            return view(context, load(context, input.workflowId)); const workflowId = randomUUID(), sourceId = randomUUID(), revision = randomUUID(); const draft: Draft = { revision, sample: null, dictionaryTable: null, dictionaryRows: [], format: null, view: { workflowId, sourceId, revision, title: input.title ?? 'Новый сценарий ОКО', reportUrl: '', marker: null, parsingProfile: { ...defaultSourceParsingProfile }, profile: { sourceId, profileId: null, profile: null, revision: null, configured: false, sessionState: 'closed' }, recording: { recordingId: null, state: 'idle', steps: [], parameterNames: [], problem: null }, columns: [], sampleRows: [], parameters: {}, mapping: null, dictionary: { columns: [], sampleRows: [], mapping: null, origin: 'none', issues: [] }, result: null, warnings: ['Личный предварительный просмотр: факты и общий источник не создаются.'] } }; store.save(owner(context), workflowId, null, draft); return view(context, draft); },
        async setProfile(context: CommandContext, input: {
            workflowId: string;
            expectedRevision: string;
            reportUrl: string;
            profile: Parameters<BrowserProfileService['set']>[1]['profile'];
        }) { const draft = load(context, input.workflowId); cas(draft, input.expectedRevision); checkedUrl(input.reportUrl, input.profile); const current = await profiles.getOwn(context, draft.view.sourceId); await profiles.set(context, { sourceId: draft.view.sourceId, profileId: 'oko-' + draft.view.workflowId, profile: input.profile, expectedRevision: current.revision }); draft.view.reportUrl = input.reportUrl; persist(context, draft); return view(context, draft); },
        async loginOpen(context: CommandContext, input: {
            workflowId: string;
        }) { const draft = load(context, input.workflowId), profile = await ownProfile(context, draft); const startUrl = draft.view.reportUrl || profile.profile!.allowedOrigins[0]; const handle = await runtime.openLogin({ owner: browserOwner(context), profile: profile.profile!, startUrl, authenticatedSelector: draft.view.marker?.selector ?? 'html' }, new AbortController().signal); const loginId = randomUUID(); logins.set(loginId, { owner: owner(context), handleId: handle.handleId }); return { loginId, windowOpened: true as const }; },
        async loginFinish(context: CommandContext, input: {
            workflowId: string;
            loginId: string;
        }) { load(context, input.workflowId); if (logins.get(input.loginId)?.owner !== owner(context))
            fail('BROWSER_HANDLE_NOT_FOUND', 'Own login window not found', 404); await runtime.closeOwned(browserOwner(context)); logins.delete(input.loginId); return { closed: true as const }; },
        async marker(context: CommandContext, input: {
            workflowId: string;
            reportUrl: string;
        }) { requirePrepare(context); const draft = load(context, input.workflowId), profile = await ownProfile(context, draft); return runControlled(context, async (signal) => { const marker = await runtime.selectMarker({ owner: browserOwner(context), profile: profile.profile!, startUrl: input.reportUrl }, signal); cancelled(context, signal); await deps.recheckGuard?.(context); cancelled(context, signal); draft.view.reportUrl = input.reportUrl; draft.view.marker = marker; persist(context, draft); return view(context, draft); }); },
        async start(context: CommandContext, input: {
            workflowId: string;
            expectedRevision: string;
            reportUrl: string;
            parsingProfile: OkoWorkflowView['parsingProfile'];
        }) { requirePrepare(context); const draft = load(context, input.workflowId); cas(draft, input.expectedRevision); if (!draft.view.marker || draft.view.reportUrl !== input.reportUrl)
            fail('MARKER_REQUIRED', 'Select the report marker for this URL first', 409); const profile = await ownProfile(context, draft), runOwner = browserOwner(context), handle = await runtime.startRecording({ owner: runOwner, profile: profile.profile!, startUrl: input.reportUrl, authenticatedSelector: draft.view.marker!.selector }, new AbortController().signal); try { await freshPrepare(context); } catch (error) { await runtime.closeOwned(runOwner); throw error; } draft.view.parsingProfile = input.parsingProfile; draft.view.recording = { recordingId: handle.handleId, state: 'recording', steps: [], parameterNames: [], problem: null }; live.add(owner(context) + '/' + input.workflowId); persist(context, draft); return view(context, draft); },
        async finish(context: CommandContext, input: {
            workflowId: string;
            recordingId: string;
        }) { requirePrepare(context); const draft = load(context, input.workflowId); if (draft.view.recording.recordingId !== input.recordingId)
            fail('RECORDING_NOT_FOUND', 'Own recording not found', 404); if (draft.view.recording.state === 'completed')
            return view(context, draft); try {
            const recorded = await runtime.finish({ owner: browserOwner(context), handleId: input.recordingId, save: false });
            if (!recorded.hasDownload)
                fail('EXPORT_REQUIRED', 'Finish by downloading a report');
            const download = await runtime.readRecordingDownload({ owner: browserOwner(context), handleId: input.recordingId });
            const table = await parseWorkbenchTable({ bytes: download.bytes, name: download.name, parsingProfile: draft.view.parsingProfile });
            await freshPrepare(context);
            draft.sample = table;
            draft.format = table.format;
            draft.view.columns = table.columns;
            draft.view.sampleRows = rawRows(table).slice(0, 50);
            draft.view.recording = { recordingId: input.recordingId, state: 'completed', steps: recorded.steps, parameterNames: recorded.parameterNames, problem: null };
            draft.view.parameters = Object.fromEntries(recorded.parameterNames.map(name => [name, draft.view.parameters[name] ?? '']));
            persist(context, draft);
            return view(context, draft);
        }
        catch (error) {
            await freshPrepare(context);
            draft.view.recording.state = 'failed';
            draft.view.recording.problem = { code: error instanceof WorkbenchHttpError ? error.code : 'RECORDING_FAILED', message: 'Запись или выгрузка не завершена. Повторите запись.' };
            persist(context, draft);
            throw error;
        } },
        async cancel(context: CommandContext, input: {
            workflowId: string;
        }) { const draft = load(context, input.workflowId); await runtime.closeOwned(browserOwner(context)); live.delete(owner(context) + '/' + input.workflowId); draft.view.recording = { ...draft.view.recording, state: 'idle', problem: null }; persist(context, draft); return view(context, draft); },
        async saveMapping(context: CommandContext, input: {
            workflowId: string;
            expectedRevision: string;
            mapping: OkoMapping;
            parameters: Record<string, string>;
            parsingProfile: OkoWorkflowView['parsingProfile'];
        }) { requirePrepare(context); const draft = load(context, input.workflowId); cas(draft, input.expectedRevision); ensureColumns(draft.view.columns, input.mapping); if (draft.view.recording.parameterNames.some(name => !Object.hasOwn(input.parameters, name)) || Object.keys(input.parameters).some(name => !draft.view.recording.parameterNames.includes(name)))
            fail('PARAMETERS_REQUIRED', 'Confirm exactly the recorded safe parameters'); draft.view.mapping = input.mapping; draft.view.parameters = input.parameters; draft.view.parsingProfile = input.parsingProfile; localSourceMapping(context, draft); persist(context, draft); return view(context, draft); },
        async directoryPreview(context: CommandContext, input: {
            workflowId: string;
            fileHandle: string;
            parsingProfile: OkoWorkflowView['parsingProfile'];
        }) { requirePrepare(context); const draft = load(context, input.workflowId), file = await files.read(input.fileHandle, context.installationId, 'goal-import', context.ownAccess.personId); if (!/\.csv$/i.test(file.name))
            fail('DIRECTORY_CSV_REQUIRED', 'Choose a directory CSV'); const table = await parseWorkbenchTable({ bytes: file.bytesValue, name: file.name, parsingProfile: input.parsingProfile }); await freshPrepare(context); draft.dictionaryTable = table; draft.dictionaryRows = []; draft.previousDirectoryGraph = draft.dictionaryGraph; draft.dictionaryGraph = undefined; draft.view.dictionary = { columns: table.columns, sampleRows: rawRows(table).slice(0, 50), mapping: null, origin: 'local-preview', issues: [] }; persist(context, draft); return view(context, draft); },
        async directoryApply(context: CommandContext, input: {
            workflowId: string;
            expectedRevision: string;
            mapping: OkoDictionaryMapping;
        }) { requirePrepare(context); const draft = load(context, input.workflowId); cas(draft, input.expectedRevision); if (!draft.dictionaryTable)
            fail('DIRECTORY_REQUIRED', 'Load your directory CSV first'); const table = draft.dictionaryTable!; if (Object.values(input.mapping).some(column => column !== null && !table.columns.includes(column)))
            fail('SOURCE_SCHEMA_CHANGED', 'A dictionary column is absent'); const rows = rawRows(table).map(row => Object.fromEntries(Object.entries(input.mapping).map(([field, column]) => [field, column === null ? null : row[column]])));
            const graph = buildOkoPreviewDirectory({ rows, sourceId: draft.view.sourceId, header: privateHeader(context), newId: randomUUID, previousLinks: draft.previousDirectoryGraph?.links ?? draft.dictionaryGraph?.links ?? [] });
            draft.dictionaryGraph = graph; const issues = graph.issues; draft.dictionaryRows = rows; draft.view.dictionary.mapping = input.mapping; draft.view.dictionary.issues = issues; persist(context, draft); return view(context, draft); },
        async test(context: CommandContext, input: {
            workflowId: string;
            expectedRevision: string;
        }) {
            requirePrepare(context);
            const draft = load(context, input.workflowId);
            cas(draft, input.expectedRevision);
            if (!draft.view.mapping || !draft.view.marker || !draft.format || draft.view.recording.state !== 'completed')
                fail('SCENARIO_REVIEW_REQUIRED', 'Complete the recording and mapping first', 409);
            const profile = await ownProfile(context, draft);
            return runControlled(context, async (signal) => {
                // This private runtime DTO is never appended as a shared/published entity.
                const scenario = { schemaVersion: 1 as const, id: draft.view.workflowId, revision: 1, recordedAt: clock.now(), actor: context.actor, publicationAnchorId: null, sourceId: draft.view.sourceId, startUrl: draft.view.reportUrl, authenticatedSelector: draft.view.marker!.selector, steps: draft.view.recording.steps, parameters: draft.view.parameters, expectedExport: { format: draft.format!, requiredColumns: draft.view.columns } };
                const download = await runtime.replay({ owner: browserOwner(context), profile: profile.profile!, scenario }, signal);
                cancelled(context, signal);
                const table = await parseWorkbenchTable({ bytes: download.bytes, name: download.name, parsingProfile: draft.view.parsingProfile });
                if (table.format !== draft.format || draft.view.columns.some(column => !table.columns.includes(column)))
                    fail('SOURCE_SCHEMA_CHANGED', 'Downloaded columns or format changed');
                const mapping = draft.view.mapping!;
                ensureColumns(table.columns, mapping);
                const directory = draft.dictionaryGraph ?? buildOkoPreviewDirectory({ rows: draft.dictionaryRows.length ? draft.dictionaryRows : await deps.getDirectory?.(context, draft.view.sourceId) ?? [], sourceId: draft.view.sourceId, header: privateHeader(context), newId: randomUUID });
                const preview = previewOkoTable({ table, mapping: localSourceMapping(context, draft), directory });
                const { rows, issues, unresolvedRows } = preview;
                const resultId = randomUUID(), columns = [...new Set([...table.columns, ...rows.flatMap(row => Object.keys(row))])], enriched = artifact({ name: 'oko-enriched.csv', bytes: serializeOkoEnrichedCsv(rows, columns), contentType: 'text/csv; charset=utf-8' }), original = artifact(download);
                cancelled(context, signal);
                const current = load(context, input.workflowId);
                cas(current, input.expectedRevision);
                const result: NonNullable<OkoWorkflowView['result']> = { resultId, rowCount: rows.length, unresolvedRows, issues, previewRows: rows.slice(0, 50), originalDownload: `/api/v1/browser/results/${resultId}/original`, enrichedDownload: `/api/v1/browser/results/${resultId}/enriched`, capturedAt: clock.now(), sourceDate: preview.sourceDate };
                const safeProfile = await profiles.getOwn(context, draft.view.sourceId);
                await deps.recheckGuard?.(context);
                cancelled(context, signal);
                return commitCommandEffect(context, () => { cancelled(context, signal); store.putResult(owner(context), resultId, { original, enriched }); draft.view.result = result; persist(context, draft); return { result: { ...structuredClone(draft.view), profile: safeProfile }, changedRefs: [], editToken: null }; }).result;
            });
        },
        async readResult(context: QueryContext, resultId: string, kind: 'original' | 'enriched') { uuidSchema.parse(resultId); const stored = store.getResult<StoredResult>(owner(context), resultId); if (!stored || !['original', 'enriched'].includes(kind))
            fail('RESULT_NOT_FOUND', 'Own result not found', 404); const value = stored![kind], bytes = Buffer.from(value.base64, 'base64'); if (createHash('sha256').update(bytes).digest('hex') !== value.hash)
            fail('INTEGRITY_MISMATCH', 'Stored result failed integrity verification'); return { bytes, name: value.name, mimeType: value.mimeType, hash: value.hash, sha256: value.hash }; },
    };
    // All workflow writes share one owner/workflow slot across awaited private I/O.
    // Cancellation first closes owned browser work without waiting for a human-held slot.
    const prepareMethods = new Set<string>(['open', 'marker', 'start', 'finish', 'saveMapping', 'directoryPreview', 'directoryApply', 'test']);
    for (const name of ['open', 'setProfile', 'loginOpen', 'loginFinish', 'marker', 'start', 'finish', 'saveMapping', 'directoryPreview', 'directoryApply', 'test'] as const) {
        const original = service[name] as (context: CommandContext, input: { workflowId?: string }) => Promise<unknown>;
        (service as unknown as Record<string, unknown>)[name] = (context: CommandContext, input: { workflowId?: string }) => serializeMutation(context, input, async () => { if (prepareMethods.has(name)) await freshPrepare(context); return original(context, input); });
    }
    const cancel = service.cancel;
    service.cancel = async (context, input) => { load(context, input.workflowId); await runtime.closeOwned(browserOwner(context)); return serializeMutation(context, input, () => cancel(context, input)); };
    return service;
}
export type OkoWorkflowService = ReturnType<typeof createOkoWorkflowService>;
