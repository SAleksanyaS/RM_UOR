import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { Capture, DirectoryEntity, DirectoryLink, GoalAssignment, ManualCorrection, ObservedFact, SourceDefinition, SourceFieldMapping } from '../../domain/workbench/entities';
import { compare } from '../../domain/workbench/exact-number';
import { fixtureId, makeEntityGraph, makeHeader, makeNumericFixture, versionRef } from '../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../tests/fixtures/workbench/repository';
import { createWorkbenchRepository } from '../../server/storage/workbench-repository';
import { createFileStore, defaultFileLimits } from '../../server/workbench/files';
import { createCommandStore, withCommandExecution } from '../../server/workbench/command-store';
import { createCommandRegistry, type CommandContext } from '../../server/workbench/command-registry';
import { canUseCapability } from '../identity/workbench-access-policy';
import { createJobStore } from '../../server/workbench/jobs';
import { WorkbenchHttpError } from '../../server/workbench/protocol';
import { createSourceStore } from '../connectors/workbench-source-store';
import { installHistoryIndex } from '../history/workbench-history-index';
import { resolveEvaluationInput } from '../evaluation/workbench/resolve-input';
import { selectEvaluationFacts } from '../evaluation/workbench/select-facts';
import { createImportStore } from './workbench-import-store';
import { createImportService, importApplyResultSchema, importPreviewResultSchema, registerImportCommands } from './workbench-import';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'uor-file-import-'));
  const repository = createWorkbenchRepository({ filename: path.join(root, 'db.sqlite'), artifactRoot: path.join(root, 'artifacts') });
  installHistoryIndex(repository);
  cleanups.push(() => { repository.close(); if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('uor-file-import-')) throw Error('Unexpected cleanup root'); rmSync(root, { recursive: true, force: true }); });
  const time = { kind: 'period' as const, startInclusive: '2026-10-01', endExclusive: '2026-11-01' };
  const scopes = [101, 102, 103, 104].map(n => ({ kind: 'product' as const, id: fixtureId(n) }));
  const f = makeNumericFixture({ scope: { kind: 'dit', id: fixtureId(100) }, expectedPopulation: scopes, context: { businessTime: time, evaluatedAt: '2026-10-29T09:00:00Z' } });
  const graph = makeEntityGraph(f); graph.entries = graph.entries.filter(e => !['capture', 'observed_fact'].includes(e.entityType));
  const source = graph.entries.find(e => e.entityType === 'source_definition')!.value as SourceDefinition;
  source.kind = 'file'; source.publicLocator = null;
  const mapping = graph.entries.find(e => e.entityType === 'source_field_mapping')!.value as SourceFieldMapping;
  Object.assign(mapping, { rowKeyFields: ['ID'], dimensionFields: {}, productKeyField: 'ID', dateField: null, periodStartField: 'Start', periodEndField: 'End', metricFields: [{ metricId: f.metrics[0].id, fields: { demo_value: 'Value' } }], parsingProfile: { sheetName: null, csvDelimiter: ';', csvEncoding: 'utf8', dateFormat: 'iso', decimalSeparator: '.', groupSeparator: 'none' } });
  const directory = graph.entries.filter(e => e.entityType === 'directory_entity').map(e => e.value as DirectoryEntity);
  directory.filter(e => e.kind === 'product').forEach((e, i) => { e.externalKeys = [{ sourceId: source.id, key: ['A', 'B', 'C', 'D'][i] }]; });
  const cluster: DirectoryEntity = { ...makeHeader(110, { publicationAnchorId: fixtureId(2) }), kind: 'cluster', name: 'Test cluster', externalKeys: [] };
  directory.push(cluster); graph.entries.push({ entityType: 'directory_entity', value: cluster });
  const links: DirectoryLink[] = [
    { ...makeHeader(120, { publicationAnchorId: fixtureId(2) }), kind: 'dit_cluster', from: { entityType: 'directory_entity', id: fixtureId(100) }, to: { entityType: 'directory_entity', id: cluster.id } },
    ...scopes.map((s, i) => ({ ...makeHeader(121 + i, { publicationAnchorId: fixtureId(2) }), kind: 'cluster_product' as const, from: { entityType: 'directory_entity', id: cluster.id }, to: { entityType: 'directory_entity', id: s.id } })),
    ...[{ kind: 'cluster' as const, id: cluster.id }, ...scopes].map((scope, i) => ({ ...makeHeader(130 + i, { publicationAnchorId: fixtureId(2) }), kind: 'leader' as const, scope, personId: f.goal.primaryCuratorPersonId })),
  ];
  links.forEach(value => graph.entries.push({ entityType: 'directory_link', value })); seedGraph(repository, graph);
  const ref = (entityType: string, value: { id: string; revision: number }) => ({ entityType, id: value.id, revision: value.revision });
  const sources = createSourceStore({ repository });
  sources.installPublished([{ goalRef: ref('core_goal_definition', f.goal), sourceRef: ref('source_definition', source), mappingRef: ref('source_field_mapping', mapping), assignmentRef: ref('goal_assignment', f.assignment), templateRef: null, methodRef: ref('method_version', f.method), metricRefs: f.metrics.map(m => ref('metric_definition', m)), directoryEntityRefs: directory.map(e => ref('directory_entity', e)), directoryLinkRefs: links.map(e => ref('directory_link', e)), directoryRevision: 'directory-1' }]);
  sources.bindAdapter({ sourceId: source.id, adapterKey: 'file', profileRef: null, revision: 'file-1' });
  const saved = { installationId: fixtureId(1), goalId: f.goal.id, revision: 'context-1', context: { scopePath: { ditId: fixtureId(100), clusterId: null, productId: null, teamId: null }, goalId: f.goal.id, time, resultMode: 'current' as const, snapshotId: null } };
  sources.saveAllowedContext(saved, null);
  const clock = { now: () => '2026-10-29T09:00:00Z' };
  const context: CommandContext = { repository, clock, installationId: fixtureId(1), requestId: fixtureId(400), commandId: fixtureId(401), ownAccess: { role: 'curator', displayName: 'Test curator', personId: fixtureId(17), policyState: 'verified', checkedAt: clock.now() }, actor: { ...makeHeader(1).actor, profilePersonId: fixtureId(17) } };
  const files = createFileStore({ directory: path.join(root, 'files'), limits: defaultFileLimits });
  const jobs = createJobStore({ repository, clock }), store = createImportStore({ repository });
  let guard: () => Promise<void> = async () => {};
  const service = createImportService({ repository, store, sources, files, jobs, clock, recheckGuard: async () => guard() });
  let serial = 500;
  const execute = async (name: 'import.preview' | 'import.apply', payload: Record<string, unknown>, own = context) => {
    const ctx = { ...own, commandId: fixtureId(serial++) };
    createCommandStore(repository).begin({ commandId: ctx.commandId, name, payload, baseRevision: null }, ctx.installationId, { scope: 'person', personId: ctx.ownAccess.personId });
    const job = jobs.create(ctx.commandId, ctx.installationId, name); jobs.update(job.jobId, { status: 'running' });
    try { const result=await withCommandExecution(ctx, name === 'import.preview' ? importPreviewResultSchema : importApplyResultSchema, () => name === 'import.preview' ? service.preview(ctx, payload as never) : service.apply(ctx, payload as never)); jobs.complete(job.jobId,result,[]); return result; }
    catch (error) { if(jobs.get(job.jobId,ctx.installationId)?.status==='running')jobs.fail(job.jobId,{code:'TEST_OPERATION_FAILED',message:'Synthetic operation failure',retryable:false,details:[],operationId:job.jobId,provider:null});throw error; }
  };
  const upload = async (bytes: Uint8Array, name = 'data.csv', own = context) => files.stage({ installationId: own.installationId, profilePersonId: own.ownAccess.personId, purpose: 'goal-import', name, mediaType: name.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', stream: (async function* () { yield bytes; })() });
  const preview = async (rows: string, own = context) => { const file = await upload(Buffer.from('ID;Value;Start;End\n' + rows), 'data.csv', own); return servicePreview(file.fileHandle, own); };
  const servicePreview = (fileHandle: string, own = context) => execute('import.preview', { goalId: f.goal.id, fileHandle }, own) as ReturnType<typeof service.preview>;
  const apply = (p: Awaited<ReturnType<typeof service.preview>>, rows = p.rows.filter(r => r.acceptable && !p.corrections.some(c => c.afterFact.id === r.proposedFact?.id)).map(r => r.id), corrections: string[] = [], own = context) => execute('import.apply', { previewToken: p.previewToken, acceptedRowIds: rows, acceptedCorrectionIds: corrections }, own) as ReturnType<typeof service.apply>;
  const facts = () => repository.readImportFactState({ sourceId: source.id, metricIds: f.metrics.map(m => m.id), scopes, businessTime: time, factKeys: [] }).facts;
  const csvRow = (key: string, value: string) => `${key};${value};2026-10-01;2026-11-01`;
  return { repository, root, files, jobs, store, sources, service, source, mapping, saved, f, context, graph, clock, execute, preview, upload, servicePreview, apply, facts, csvRow, setGuard: (next: typeof guard) => { guard = next; } };
}

it('accepts_three_rows_and_keeps_one_rejection_without_preview_fact_writes_or_duplicate_apply', async () => {
  const f = fixture(), p = await f.preview(['A;65','B;70','C;80','D;bad'].map(s => s + ';2026-10-01;2026-11-01').join('\n'));
  expect(f.facts()).toHaveLength(0); expect(p.rows.filter(r => r.acceptable)).toHaveLength(3); expect(p.complete).toBe(false);
  const a = await f.apply(p); expect(a.complete).toBe(false); expect(a.acceptedRowIds).toHaveLength(3); expect(a.rejectedRowIds).toHaveLength(1); expect(f.facts()).toHaveLength(3);
  const raw = f.repository.readVersion<Capture>(a.captureRef)!; expect(raw.rawRows[0].cells.Value.original).toBe('65'); expect(raw.result).toBe('partial');
  expect(await f.apply(p)).toEqual(a); expect(f.facts()).toHaveLength(3);
  expect(f.repository.sqlForModule('history').all('SELECT id FROM wb_history_observations')).toHaveLength(3);
  expect(f.sources.readLatestAttempt({ installationId: f.context.installationId, goalId: f.f.goal.id })).toMatchObject({ complete: false });
});

it('supplements_same_period_and_requires_selected_source_correction_without_erasing_old_rows', async () => {
  const f = fixture(), first = await f.preview(['A;65','B;70','C;80','D;bad'].map(s => s + ';2026-10-01;2026-11-01').join('\n'));
  await f.apply(first);
  const next = await f.preview([f.csvRow('A','75'),f.csvRow('D','90')].join('\n'));
  expect(next.corrections).toHaveLength(1); expect(next.corrections[0].kind).toBe('file_fact_revision');
  await f.apply(next); expect(f.facts().map(x => x.value).sort()).toEqual(['65','70','80','90']);
  const third = await f.preview(f.csvRow('A','75')), c = third.corrections[0];
  const a = await f.apply(third, [], [c.id]); expect(a.acceptedCorrectionIds).toEqual([c.id]);
  expect(f.repository.readVersion<ObservedFact>(c.beforeFactRef)!.value).toBe('65');
  expect(f.repository.getHead<ObservedFact>({ entityType: 'observed_fact', id: c.afterFact.id })).toMatchObject({ revision: 2, value: '75' });
  expect(f.repository.sqlForModule('history').all('SELECT id FROM wb_history_observations')).toHaveLength(5);
  expect(f.facts()).toHaveLength(4);
});

it('preserves_published_manual_override_and_reports_discrepancy', async () => {
  const f = fixture(), first = await f.preview(f.csvRow('A','65')); await f.apply(first);
  const original = f.facts()[0];
  f.repository.append('goal_assignment',{...f.f.assignment,revision:2,expectedPopulation:[original.scope]},1);
  const correction: ManualCorrection = { ...makeHeader(700, { publicationAnchorId: fixtureId(2) }), factKey: original.factKey, originalFactRefs: [{ entityType: 'observed_fact', id: original.id, revision: original.revision }], replacement: '72', reason: 'Synthetic official correction' };
  f.repository.append('manual_correction', correction, null);
  const p = await f.preview(f.csvRow('A','70')); expect(p.issues.some(i => i.code === 'MANUAL_CORRECTION_DISCREPANCY')).toBe(true);
  await f.apply(p, [], p.corrections.map(c => c.id));
  expect(f.repository.readPublishedHead<ManualCorrection>({ entityType: 'manual_correction', id: correction.id })).toEqual(correction);
  expect(f.facts()[0].value).toBe('70');
  const resolved=resolveEvaluationInput({assignmentRef:{entityType:'goal_assignment',id:f.f.assignment.id,revision:2},businessTime:f.saved.context.time},f.repository,f.clock,f.context.actor);
  const selected=selectEvaluationFacts(resolved); expect(selected.metrics[0].value).toBe('72'); expect(selected.qualityFlags).toContain('correction_source_discrepancy');
});

it('keeps_exact_values_unknown_dates_and_rejects_formula_files', async () => {
  const f = fixture(), p = await f.preview('A;12345678901234567890.001;;');
  expect(p.rows[0].proposedFact).toMatchObject({ value: '12345678901234567890.001', businessTime: { kind: 'unknown' } }); expect(p.complete).toBe(false);
  const book = new ExcelJS.Workbook(); book.addWorksheet('Data').addRows([['ID','Value','Start','End'],['A',{formula:'1+1'},'2026-10-01','2026-11-01']]);
  await expect(f.upload(Buffer.from(await book.xlsx.writeBuffer()),'formula.xlsx')).rejects.toMatchObject({ code: 'INVALID_FILE' });
});

it('rejects_empty_duplicate_foreign_or_unapproved_correction_selections', async () => {
  const f = fixture(), p = await f.preview(f.csvRow('A','65'));
  await expect(f.apply(p, [])).rejects.toMatchObject({ code: 'IMPORT_SELECTION_REQUIRED' });
  await expect(f.apply(p, [p.rows[0].id,p.rows[0].id])).rejects.toMatchObject({ name: 'ZodError' });
  await expect(f.apply(p, [fixtureId(999)])).rejects.toMatchObject({ code: 'IMPORT_SELECTION_INVALID' });
  await f.apply(p);
  const correction = await f.preview(f.csvRow('A','70'));
  await expect(f.apply(correction, [correction.rows[0].id])).rejects.toMatchObject({ code: 'IMPORT_CORRECTION_SELECTION_REQUIRED' });
  expect(f.facts()[0].value).toBe('65');
});

it('rejects_stale_mapping_context_fact_and_directory_basis_before_any_commit', async () => {
  const f = fixture(), p = await f.preview(f.csvRow('A','65'));
  f.sources.saveAllowedContext({ ...f.saved, revision: 'context-2' }, 'context-1');
  await expect(f.apply(p)).rejects.toMatchObject({ code: 'PREVIEW_STALE' }); expect(f.facts()).toHaveLength(0);
  const q = await f.preview(f.csvRow('A','65')); const other = await f.preview(f.csvRow('A','70')); await f.apply(other);
  await expect(f.apply(q)).rejects.toMatchObject({ code: 'PREVIEW_STALE' }); expect(f.facts()[0].value).toBe('70');
});

it('fresh_owner_role_and_source_guards_reject_without_mutating_facts', async () => {
  const f = fixture(), p = await f.preview(f.csvRow('A','65'));
  const foreign = { ...f.context, ownAccess: { ...f.context.ownAccess, personId: fixtureId(18) }, actor: { ...f.context.actor, profilePersonId: fixtureId(18) } };
  await expect(f.apply(p, [p.rows[0].id], [], foreign)).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_NOT_FOUND' });
  await expect(f.apply(p, [p.rows[0].id], [], { ...f.context, ownAccess: { ...f.context.ownAccess, role: 'viewer' } })).rejects.toMatchObject({ statusCode: 403 });
  f.setGuard(async () => { throw new WorkbenchHttpError(403,'ACCESS_DENIED','Revoked'); });
  await expect(f.apply(p)).rejects.toMatchObject({ code: 'ACCESS_DENIED' }); expect(f.facts()).toHaveLength(0);
  f.source.kind = 'qlik'; f.source.revision = 2; f.repository.append('source_definition',f.source,1);
  await expect(f.preview(f.csvRow('A','65'))).rejects.toMatchObject({ code: 'IMPORT_SOURCE_REQUIRED' });
});

it('rolls_back_capture_fact_history_pointer_result_and_receipt_together', async () => {
  const f = fixture(), p = await f.preview(f.csvRow('A','65'));
  let fail = true; f.repository.registerProjection('import-failure', type => { if (type === 'observed_fact' && fail) throw Error('Synthetic projection failure'); });
  await expect(f.apply(p)).rejects.toThrow('Synthetic projection failure'); expect(f.facts()).toHaveLength(0);
  expect(f.repository.sqlForModule('history').all('SELECT id FROM wb_history_observations')).toHaveLength(0);
  expect(f.sources.readLatestAttempt({ installationId: f.context.installationId, goalId: f.f.goal.id })).toBeNull();
  fail = false; const result = await f.apply(p); expect(f.facts()).toHaveLength(1); expect(await f.apply(p)).toEqual(result);
});

it('concurrent_retries_with_new_command_ids_return_one_committed_result', async () => {
  const f=fixture(),p=await f.preview(f.csvRow('A','65'));
  let calls=0,release!:()=>void;
  const held=new Promise<void>(resolve=>{ release=resolve; });
  f.setGuard(async()=>{ if(++calls===2) release(); await held; });
  const outcomes=await Promise.all([f.apply(p),f.apply(p)]);
  expect(outcomes[1]).toEqual(outcomes[0]); expect(f.facts()).toHaveLength(1);
  expect(f.repository.sqlForModule('history').all('SELECT id FROM wb_history_observations')).toHaveLength(1);
});

it('unchanged_fact_with_new_raw_row_identity_retains_valid_capture_counts_and_original_lineage',async()=>{
  const f=fixture();
  f.mapping.rowKeyFields=['RowID']; f.mapping.revision=2; f.repository.append('source_field_mapping',f.mapping,1);
  f.source.mappingRef={entityType:'source_field_mapping',id:f.mapping.id,revision:2}; f.source.revision=2; f.repository.append('source_definition',f.source,1);
  const preview=async(row:string)=>{const file=await f.upload(Buffer.from('RowID;ID;Value;Start;End\n'+row));return f.servicePreview(file.fileHandle);};
  const p=await preview('old-id;A;65;2026-10-01;2026-11-01'); const first=await f.apply(p);
  const q=await preview('new-id;A;65;2026-10-01;2026-11-01\nold-id;B;70;2026-10-01;2026-11-01'); const next=await f.apply(q);
  expect(q.corrections).toHaveLength(0); expect(f.facts()).toHaveLength(2);
  const capture=f.repository.readVersion<Capture>(next.captureRef)!;
  const knownKeys=new Set(capture.rawRows.map(r=>r.rowKey));
  expect(capture).toMatchObject({acceptedRows:2,rejectedRows:0});
  expect(f.sources.readCapture(next.captureRef,f.context.installationId)!.issues.some(i=>i.code==='IMPORT_SOURCE_ROW_MISSING')).toBe(false);
  expect(capture.canonicalRows.every(r=>knownKeys.has(r.rowKey))).toBe(true);
  expect(f.facts().find(fact=>fact.scope.id===fixtureId(101))!.captureId).toBe(first.captureRef.id);
});

it('fully_valid_population_moves_success_pointer_and_same_handle_preview_is_idempotent',async()=>{
  const f=fixture(), file=await f.upload(Buffer.from('ID;Value;Start;End\n'+['A','B','C','D'].map(k=>f.csvRow(k,'95')).join('\n')));
  const p=await f.servicePreview(file.fileHandle); expect(p.complete).toBe(true);
  const a=await f.apply(p); expect(a.complete).toBe(true);
  expect(f.sources.readFallback({installationId:f.context.installationId,goalId:f.f.goal.id})).toMatchObject({obtainedVia:'local-cache',captureRef:a.captureRef});
  const again=await f.servicePreview(file.fileHandle); expect(again).toEqual(p); expect(await f.apply(again)).toEqual(a); expect(f.facts()).toHaveLength(4);
  const rejected=await f.preview(f.csvRow('A','bad'));
  expect(rejected.rows[0].acceptable).toBe(false);
  expect(f.sources.readFallback({installationId:f.context.installationId,goalId:f.f.goal.id}).captureRef).toEqual(a.captureRef);
});

it('durable_preview_and_applied_result_survive_a_new_sqlite_connection',async()=>{
  const f=fixture(),p=await f.preview(f.csvRow('A','65')),a=await f.apply(p);
  const repository=createWorkbenchRepository({filename:path.join(f.root,'db.sqlite'),artifactRoot:path.join(f.root,'artifacts')}); cleanups.push(()=>repository.close()); installHistoryIndex(repository);
  const sources=createSourceStore({repository}),store=createImportStore({repository}),jobs=createJobStore({repository,clock:f.clock});
  const service=createImportService({repository,sources,store,files:f.files,jobs,clock:f.clock,recheckGuard:async()=>{}});
  const ctx={...f.context,repository,commandId:fixtureId(9000)},payload={previewToken:p.previewToken,acceptedRowIds:p.rows.filter(r=>r.acceptable).map(r=>r.id),acceptedCorrectionIds:[]};
  createCommandStore(repository).begin({commandId:ctx.commandId,name:'import.apply',payload,baseRevision:null},ctx.installationId,{scope:'person',personId:ctx.ownAccess.personId});
  const job=jobs.create(ctx.commandId,ctx.installationId,'import.apply'); jobs.update(job.jobId,{status:'running'});
  expect(await withCommandExecution(ctx,importApplyResultSchema,()=>service.apply(ctx,payload))).toEqual(a);
  expect(repository.readVersion<Capture>(a.captureRef)).not.toBeNull();
});

it('registered_async_commands_validate_selection_and_deny_reader_or_foreign_receipt',async()=>{
  const f=fixture(); let own={...f.context.ownAccess};
  const registry=createCommandRegistry({repository:f.repository,jobs:f.jobs,accessPolicy:{resolveOwnAccess:async()=>own,assertCommandAllowed:async name=>{ const cap=registry.getCapability(name);if(!cap||!canUseCapability(own,cap))throw new WorkbenchHttpError(403,'ACCESS_DENIED','Denied');return own;},assertFreshPublishAllowed:async()=>{throw Error('Import must not publish');}}});
  registerImportCommands(registry,f.service);
  const invoke=(request:Parameters<typeof registry.execute>[0])=>registry.execute(request,{...f.context,commandId:request.commandId,ownAccess:own,actor:{...f.context.actor,profilePersonId:own.personId}});
  const file=await f.upload(Buffer.from('ID;Value;Start;End\n'+f.csvRow('A','65'))),request={commandId:fixtureId(9100),name:'import.preview',payload:{goalId:f.f.goal.id,fileHandle:file.fileHandle},baseRevision:null};
  const accepted=await invoke(request); expect(accepted).toHaveProperty('jobId'); await registry.idle();
  if(!('jobId'in accepted))throw Error('Expected accepted job');
  const p=importPreviewResultSchema.parse(f.jobs.get(accepted.jobId,f.context.installationId)!.result);
  const bad={commandId:fixtureId(9101),name:'import.apply',payload:{previewToken:p.previewToken,acceptedRowIds:[p.rows[0].id,p.rows[0].id],acceptedCorrectionIds:[]},baseRevision:null};
  await expect(invoke(bad)).rejects.toMatchObject({statusCode:422});
  own={...own,role:'viewer'}; await expect(invoke({...request,commandId:fixtureId(9102)})).rejects.toMatchObject({statusCode:403});
  own={...f.context.ownAccess,personId:fixtureId(18)}; await expect(invoke(request)).rejects.toMatchObject({statusCode:404});
  expect(f.facts()).toHaveLength(0);
});

it('invalid_or_revoked_policy_cannot_use_direct_import_even_with_a_curator_role',async()=>{
  const f=fixture();
  const own={...f.context,ownAccess:{...f.context.ownAccess,policyState:'revoked' as const}};
  await expect(f.preview(f.csvRow('A','65'),own)).rejects.toMatchObject({statusCode:403}); expect(f.facts()).toHaveLength(0);
});

it('xlsx_preview_retains_exact_strings_and_original_business_period',async()=>{
  const f=fixture(), book=new ExcelJS.Workbook(); book.addWorksheet('Data').addRows([['ID','Value','Start','End'],['A','12345678901234567890.001','2026-10-01','2026-11-01']]);
  const file=await f.upload(Buffer.from(await book.xlsx.writeBuffer()),'valid.xlsx'),p=await f.servicePreview(file.fileHandle);
  expect(p.rows[0]).toMatchObject({coordinate:{sheet:'Data',row:2},acceptable:true,proposedFact:{value:'12345678901234567890.001',businessTime:f.saved.context.time}});
  const result=await f.apply(p); expect(f.repository.readVersion<Capture>(result.captureRef)!.rawRows[0].cells.Value.original).toBe('12345678901234567890.001');
});

it('published_mapping_directory_and_anchor_updates_stale_preview_and_cancel_leaves_no_effect',async()=>{
  const f=fixture(),p=await f.preview(f.csvRow('A','65'));
  f.mapping.revision=2; f.mapping.dimensionFields={product:'ID'}; f.repository.append('source_field_mapping',f.mapping,1);
  f.source.mappingRef={entityType:'source_field_mapping',id:f.mapping.id,revision:2};f.source.revision=2;f.repository.append('source_definition',f.source,1);
  await expect(f.apply(p)).rejects.toMatchObject({code:'PREVIEW_STALE'});
  const q=await f.preview(f.csvRow('A','65')),dit=f.repository.readPublishedHead<DirectoryEntity>({entityType:'directory_entity',id:fixtureId(100)})!;
  f.repository.append('directory_entity',{...dit,revision:2,name:'Changed published directory'},1);
  await expect(f.apply(q)).rejects.toMatchObject({code:'PREVIEW_STALE'});
  const r=await f.preview(f.csvRow('A','65'));
  f.setGuard(async()=>{const candidates=f.jobs.recoveryCandidates(f.context.installationId);const job=candidates.find(c=>c.name==='import.apply'&&c.snapshot.status==='running');if(job)await f.jobs.cancel(job.snapshot.jobId,f.context.installationId);});
  await expect(f.apply(r)).rejects.toMatchObject({code:'IMPORT_CANCELLED'});expect(f.facts()).toHaveLength(0);
});

function groupedFixture(population=[101], domain:'nonnegative_decimal'|'nonnegative_integer'='nonnegative_decimal') {
  const f=fixture();
  f.mapping.rowKeyFields=['RowID'];f.mapping.revision=2;f.repository.append('source_field_mapping',f.mapping,1);
  f.source.mappingRef={entityType:'source_field_mapping',id:f.mapping.id,revision:2};f.source.revision=2;f.repository.append('source_definition',f.source,1);
  if(f.f.method.mode!=='numeric')throw Error('Expected numeric method');
  if(domain!=='nonnegative_decimal'){f.f.metrics[0].revision=2;f.f.metrics[0].domain=domain;f.repository.append('metric_definition',f.f.metrics[0],1);f.f.method.rules[0].metricRef.revision=2;}
  f.f.method.revision=2;f.f.method.rules[0].reducer={kind:'sum',valueField:'demo_value'};f.repository.append('method_version',f.f.method,1);
  f.f.assignment.revision=2;f.f.assignment.expectedPopulation=population.map(n=>({kind:'product',id:fixtureId(n)}));f.f.assignment.methodBinding={kind:'standalone',methodRef:{entityType:'method_version',id:f.f.method.id,revision:2}};f.repository.append('goal_assignment',f.f.assignment,1);
  const preview=async(rows:string[])=>{const file=await f.upload(Buffer.from('RowID;ID;Value;Start;End\n'+rows.map(row=>row+';2026-10-01;2026-11-01').join('\n')));return f.servicePreview(file.fileHandle);};
  const selection=()=>selectEvaluationFacts(resolveEvaluationInput({assignmentRef:{entityType:'goal_assignment',id:f.f.assignment.id,revision:f.repository.getHead<GoalAssignment>({entityType:'goal_assignment',id:f.f.assignment.id})!.revision},businessTime:f.saved.context.time},f.repository,f.clock,f.context.actor));
  return {...f,groupPreview:preview,selection};
}

it('invalid_reducer_member_blocks_its_entire_group_and_a_fragment_cannot_clear_partial_coverage',async()=>{
  const f=groupedFixture([101,102]),p=await f.groupPreview(['r1;A;10','r2;A;bad','r3;B;5']);
  expect(p.rows.filter(r=>r.acceptable)).toHaveLength(1);
  await f.apply(p);expect(f.facts().map(x=>x.value)).toHaveLength(1);
  const fragment=await f.groupPreview(['r2;A;20']);
  expect(fragment.rows[0].acceptable).toBe(false);expect(fragment.issues.some(i=>i.code==='IMPORT_GROUP_INCOMPLETE')).toBe(true);
  const whole=await f.groupPreview(['r1;A;10','r2;A;20']);const accepted=await f.apply(whole);
  expect(accepted.complete).toBe(true);expect(compare(f.selection().metrics[0].value!,'35')).toBe(0);
});

it('existing_reducer_contributions_cannot_be_removed_by_a_corrected_only_fragment',async()=>{
  const f=groupedFixture(),p=await f.groupPreview(['r1;A;10']);await f.apply(p);
  const fragment=await f.groupPreview(['r2;A;20']);expect(fragment.rows[0].acceptable).toBe(false);expect(fragment.complete).toBe(false);
  const full=await f.groupPreview(['r1;A;10','r2;A;20']);const a=await f.apply(full,[],full.corrections.map(c=>c.id));
  expect(a.complete).toBe(true);expect(compare(f.selection().metrics[0].value!,'30')).toBe(0);
});

it('retained_file_local_row_keys_remain_distinct_across_captures_in_the_real_sum',async()=>{
  const f=groupedFixture([101,102]),p=await f.groupPreview(['old-id;A;10']);await f.apply(p);
  const next=await f.groupPreview(['new-id;A;10','old-id;B;20']);const result=await f.apply(next);
  expect(result.complete).toBe(true);const selected=f.selection();expect(selected.qualityFlags).not.toContain('conflicting_row_key');expect(compare(selected.metrics[0].value!,'30')).toBe(0);
});

it.each([[101],[101,102]])('published_override_replaces_grouped_sum_once_with_population_%j',async(...members:number[])=>{
  const f=groupedFixture(members),p=await f.groupPreview(['r1;A;10','r2;A;55',...(members.length===2?['r3;B;5']:[])]);await f.apply(p);
  const original=f.facts().find(fact=>fact.scope.id===fixtureId(101))!;
  f.repository.append('manual_correction',{...makeHeader(701,{publicationAnchorId:fixtureId(2)}),factKey:original.factKey,originalFactRefs:[{entityType:'observed_fact',id:original.id,revision:original.revision}],replacement:'72',reason:'Synthetic aggregate correction'},null);
  const next=await f.groupPreview(['r1;A;20','r2;A;50']);await f.apply(next,[],next.corrections.map(c=>c.id));
  const selected=f.selection();expect(selected.qualityFlags).not.toContain('unsupported_correction_reduction');expect(compare(selected.metrics[0].value!,members.length===2?'77':'72')).toBe(0);expect(selected.qualityFlags).toContain('correction_source_discrepancy');
});

it.each([['nonnegative_decimal','-1'],['nonnegative_integer','0.5']] as const)('invalid_%s_value_is_not_an_acceptable_successful_import',async(domain,value)=>{
  const f=groupedFixture([101],domain),p=await f.groupPreview(['r1;A;65']);const first=await f.apply(p);
  const invalid=await f.groupPreview([`r1;A;${value}`]);expect(invalid.rows[0].acceptable).toBe(false);expect(invalid.rows[0].problems.some(p=>p.code==='INVALID_METRIC_DOMAIN')).toBe(true);
  expect(invalid.complete).toBe(false);expect(f.sources.readFallback({installationId:f.context.installationId,goalId:f.f.goal.id}).captureRef).toEqual(first.captureRef);
});

it('equal_ratio_value_with_changed_components_updates_lineage_and_the_cross_product_ratio',async()=>{
  const f=groupedFixture([101,102]);
  f.mapping.revision=3;f.mapping.metricFields=[{metricId:f.f.metrics[0].id,fields:{numerator:'N',denominator:'D'}}];f.repository.append('source_field_mapping',f.mapping,2);
  f.source.revision=3;f.source.mappingRef={entityType:'source_field_mapping',id:f.mapping.id,revision:3};f.repository.append('source_definition',f.source,2);
  if(f.f.method.mode!=='numeric')throw Error('Expected numeric');f.f.method.revision=3;f.f.method.rules[0].reducer={kind:'ratio',numeratorField:'numerator',denominatorField:'denominator',multiplier:'1'};f.repository.append('method_version',f.f.method,2);
  f.f.assignment.revision=3;f.f.assignment.methodBinding={kind:'standalone',methodRef:{entityType:'method_version',id:f.f.method.id,revision:3}};f.repository.append('goal_assignment',f.f.assignment,2);
  const preview=async(rows:string[])=>{const file=await f.upload(Buffer.from('RowID;ID;N;D;Start;End\n'+rows.map(r=>r+';2026-10-01;2026-11-01').join('\n')));return f.servicePreview(file.fileHandle);};
  const first=await preview(['r1;A;10;20','r2;B;1;10']);await f.apply(first);
  const second=await preview(['r1;A;20;40','r2;B;1;10']);expect(second.corrections).toHaveLength(1);
  await f.apply(second,second.rows.filter(r=>r.proposedFact?.scope.id===fixtureId(102)).map(r=>r.id),second.corrections.map(c=>c.id));
  expect(compare(f.selection().metrics[0].value!,{numerator:'21',denominator:'50'})).toBe(0);
});

it.each([50,2001])('bulk_%i_rows_reuses_capture_reads_instead_of_loading_the_entire_capture_per_fact',async(count)=>{
  const f=groupedFixture(); f.mapping.revision=3;f.mapping.dimensionFields={row:'RowID'};f.repository.append('source_field_mapping',f.mapping,2);
  f.source.revision=3;f.source.mappingRef={entityType:'source_field_mapping',id:f.mapping.id,revision:3};f.repository.append('source_definition',f.source,2);
  const rows=Array.from({length:count},(_,i)=>`row-${i};A;1`),first=await f.groupPreview(rows);expect(first.rows).toHaveLength(count);await f.apply(first);
  let sourceReads=0,captureReads=0; const read=f.sources.readCapture,get=f.repository.getHead;
  f.sources.readCapture=(...args)=>{sourceReads++;return read(...args);};
  f.repository.getHead=(ref)=>{if(ref.entityType==='capture')captureReads++;return get(ref);};
  const next=await f.groupPreview(rows);expect(next.rows).toHaveLength(count);expect(next.corrections).toHaveLength(0);
  expect(sourceReads).toBeLessThanOrEqual(10);expect(captureReads).toBeLessThanOrEqual(10);
},60000);
