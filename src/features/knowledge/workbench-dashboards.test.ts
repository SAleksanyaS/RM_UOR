import { afterEach, expect, it } from 'vitest';
import { dashboardSchemaDescriptors, validateDashboard, validateDashboardSettings, resolveDashboardMetric } from './workbench-dashboards';
import { registerConfigurationCommands } from './workbench-fields';
import { createPreferencesService } from '../system/workbench-preferences';
import { draftFixture, draftCleanups } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeHeader, makeNumericFixture } from '../../../tests/fixtures/workbench/factories';
import type { DashboardDef } from '../../domain/workbench/entities';

afterEach(async () => { for (const cleanup of draftCleanups.splice(0)) await cleanup(); });
const numeric = makeNumericFixture();
const assignmentRef = { entityType: 'goal_assignment', id: numeric.assignment.id };
const metricRef = { entityType: 'metric_definition', id: numeric.metrics[0].id, revision: 1 };
const refs = { read: (ref: any) => ref.entityType === 'goal_assignment' ? numeric.assignment : ref.entityType === 'method_version' ? numeric.method : ref.entityType === 'metric_definition' && ref.id === metricRef.id ? numeric.metrics[0] : null };
const layout = { w: 6, h: 2 };
const values = [
  ['metric-card',{layout,assignmentRef,metricRef,showTrend:true}],
  ['goal-table',{layout,columns:['title','nextAction'],limit:20,attentionOnly:false}],
  ['metric-trend',{layout,assignmentRef,metricRef,granularity:'friday'}],
  ['execution-table',{layout,kind:'all',columns:['title','state'],limit:20,attentionOnly:true}],
  ['data-issues',{layout,kinds:['stale','missing'],limit:20}],
] as const;
function dashboard(kind: string, value: Record<string,unknown>): DashboardDef { const typeId = `uor.dashboard.${kind}.v1`; return { ...makeHeader(901), title:'Обзор', blocks:[{id:fixtureId(902),typeId,settings:{schemaId:typeId,schemaVersion:1,value}}],filters:[] }; }
it.each(values)('accepts exact catalog %s', (kind, value) => { expect(() => validateDashboard(dashboard(kind,value),refs)).not.toThrow(); });
it('registers six schemas with the uor owner', () => {
  expect(dashboardSchemaDescriptors).toHaveLength(6);
  expect(dashboardSchemaDescriptors.every(s => s.ownerModuleId === 'uor' && s.schemaVersion === 1)).toBe(true);
});
it.each([
  ['goal-table',{layout,columns:['owner'],limit:20,attentionOnly:false}],
  ['goal-table',{layout,columns:['title','title'],limit:20,attentionOnly:false}],
  ['goal-table',{layout,columns:['title'],limit:201,attentionOnly:false}],
  ['data-issues',{layout,kinds:[],limit:20}],
  ['metric-card',{layout,assignmentRef,metricRef,showTrend:true,sql:'select *'}],
  ['metric-card',{layout,assignmentRef,metricRef,showTrend:true,time:{kind:'as_of',date:'2026-10-29'}}],
  ['metric-card',{layout:{w:5,h:2},assignmentRef,metricRef,showTrend:true}],
] as const)('rejects malformed %s', (kind,value) => { expect(() => validateDashboard(dashboard(kind,value),refs)).toThrow(); });
it('rejects unknown schemas, duplicates and misplaced filters', () => {
  const d = dashboard('goal-table',values[1][1]);
  expect(() => validateDashboard({...d,blocks:[...d.blocks,...d.blocks]},refs)).toThrow();
  expect(() => validateDashboard(dashboard('unknown',{}),refs)).toThrow();
  expect(() => validateDashboard({...d,blocks:[{...d.blocks[0],settings:{...d.blocks[0].settings,schemaVersion:2}}]},refs)).toThrow();
  const filter = {schemaId:'uor.dashboard.scope-filter.v1',schemaVersion:1,value:{levels:['cluster','product','team'],showGoal:true}};
  expect(() => validateDashboard({...d,filters:[filter]},refs)).not.toThrow();
  expect(() => validateDashboard({...d,filters:[filter,filter]},refs)).toThrow();
  expect(() => validateDashboard({...d,filters:[{...filter,value:{levels:['team'],showGoal:true}}]},refs)).toThrow();
  expect(() => validateDashboard(dashboard('scope-filter',filter.value),refs)).toThrow();
});
it('resolves saved metrics from the agreed basis and rejects other assignments', () => {
  expect(() => validateDashboard(dashboard('metric-card',{layout,assignmentRef,metricRef:{...metricRef,id:fixtureId(999)},showTrend:false}),refs)).toThrow();
  const oldMethod = {...numeric.method,revision:1};
  const basis = { assignmentRef:{...assignmentRef,revision:1}, methodRef:{entityType:'method_version',id:oldMethod.id,revision:1} };
  const resolved = resolveDashboardMetric(assignmentRef,{...metricRef,revision:2},{...refs, agreedBasis:basis as any});
  expect(resolved.metricRef).toEqual(metricRef);
  expect(basis.methodRef.revision).toBe(1);
});
it('keeps incomplete settings editable without freezing invalid history', async () => {
  const f = draftFixture();
  registerConfigurationCommands(f.registry,{drafts:f.service,preferences:createPreferencesService({repository:f.repository,installationId:f.context.installationId,clock:f.clock})});
  const d = await f.open('dashboard_def');
  const envelope = await f.execute('dashboard.draft.save',{draftId:d.draftId,definition:{title:'Обзор',blocks:[{id:fixtureId(903),typeId:'uor.dashboard.goal-table.v1',settings:{schemaId:'uor.dashboard.goal-table.v1'}}],filters:[]}});
  expect((envelope.result as any).complete).toBe(false);
  const body = {title:'Обзор',blocks:dashboard('goal-table',{layout}).blocks,filters:[]};
  const partial = await f.execute('dashboard.draft.save',{draftId:d.draftId,definition:body});
  expect((partial.result as any).complete).toBe(false);
  expect(f.service.readDraftVersions(f.packageId())).toHaveLength(0);
  await expect(f.execute('dashboard.draft.save',{draftId:d.draftId,definition:{...body,blocks:dashboard('goal-table',{layout,sql:'oops'}).blocks}})).rejects.toMatchObject({statusCode:422});
  await f.execute('dashboard.draft.save',{draftId:d.draftId,definition:{...body,blocks:dashboard('goal-table',values[1][1]).blocks}});
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(true);
  expect(f.service.readDraftVersions(f.packageId())).toHaveLength(1);
});
it('validates metric ownership on save and freezes its own referenced closure', async () => {
  const f = draftFixture();
  registerConfigurationCommands(f.registry,{drafts:f.service,preferences:createPreferencesService({repository:f.repository,installationId:f.context.installationId,clock:f.clock})});
  const d = await f.open('dashboard_def');
  const body = (metric:typeof metricRef) => { const {schemaVersion,id,revision,recordedAt,actor,publicationAnchorId,...value} = dashboard('metric-card',{layout,assignmentRef,metricRef:metric,showTrend:false}); return value; };
  await expect(f.execute('dashboard.draft.save',{draftId:d.draftId,definition:body({...metricRef,id:fixtureId(999)})})).rejects.toMatchObject({code:'DASHBOARD_METRIC_MISMATCH'});
  expect(f.service.readDraftVersions(f.packageId())).toHaveLength(0);
  await f.execute('dashboard.draft.save',{draftId:d.draftId,definition:body(metricRef)});
  expect(f.service.validateDraftPackage(f.packageId()).complete).toBe(true);
});
it('retains missing enum and union fields as incomplete drafts', async () => {
  const f = draftFixture();
  registerConfigurationCommands(f.registry,{drafts:f.service,preferences:createPreferencesService({repository:f.repository,installationId:f.context.installationId,clock:f.clock})});
  const d = await f.open('dashboard_def');
  for (const [kind,value] of [['goal-table',{...values[1][1],layout:{w:6}}],['metric-trend',{layout,assignmentRef,metricRef}],['execution-table',{layout,columns:['title'],limit:20,attentionOnly:false}]] as const) {
    const full = dashboard(kind,value); const {schemaVersion,id,revision,recordedAt,actor,publicationAnchorId,...definition} = full;
    const saved = await f.execute('dashboard.draft.save',{draftId:d.draftId,definition});
    expect((saved.result as any).complete).toBe(false);
    expect((saved.result as any).problems.length).toBeGreaterThan(0);
  }
  expect(f.service.readDraftVersions(f.packageId())).toHaveLength(0);
  expect(() => validateDashboardSettings({blocks:dashboard('metric-trend',{layout,assignmentRef,metricRef,granularity:'month'}).blocks,filters:[]},true)).toThrow();
});
it('identifies the precise block and filter in all nested validation problems', () => {
  const blocks = [dashboard('goal-table',{layout,limit:20,attentionOnly:false}).blocks[0],{...dashboard('goal-table',{layout,limit:20,attentionOnly:false}).blocks[0],id:fixtureId(904)}];
  const filter = {schemaId:'uor.dashboard.scope-filter.v1',schemaVersion:1,value:{levels:['cluster']}};
  const problems = validateDashboardSettings({blocks,filters:[filter]},true);
  expect(problems.map(p=>p.path)).toEqual(['/blocks/0/settings/value/columns','/blocks/1/settings/value/columns','/filters/0/value/showGoal']);
  try { validateDashboardSettings({blocks:dashboard('goal-table',{...values[1][1],limit:201}).blocks,filters:[]},true); throw Error('Expected invalid limit'); }
  catch (error) { expect((error as any).details).toEqual(expect.arrayContaining([expect.objectContaining({path:'/blocks/0/settings/value/limit'})])); }
});
