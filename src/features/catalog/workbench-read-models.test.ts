import { afterEach, expect, it } from 'vitest';
import { draftFixture, draftCleanups } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makePublicationAnchor, makeNumericFixture, makeEntityGraph } from '../../../tests/fixtures/workbench/factories';
import { createWorkbenchReadIndex } from './workbench-read-index';
import { registerWorkbenchQueries, workbenchQueryNames } from './workbench-query-registration';
import { QueryRegistry } from '../../server/workbench/query-registry';
import { createSourceStore } from '../connectors/workbench-source-store';
import { createNotificationService } from '../execution/workbench-notifications';
import { PublishingService } from '../publishing/workbench/publishing-service';
import { createPackageArtifactStore } from '../publishing/workbench/package-artifacts';
import type { QueryRequest } from '../../server/workbench/protocol';
import type { EvaluationBasis, CalculationResult, EvaluationInput } from '../../domain/workbench/entities';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { normalizeParsedWorkbenchTable } from '../connectors/workbench-source-normalizer';
import type { ParsedSourceTable } from '../tabular-import/workbench-parser';
import { evaluateAssignment } from '../evaluation/workbench/evaluate';
import type { DashboardDef, Work, Decision } from '../../domain/workbench/entities';
import { createNotificationStore } from '../execution/workbench-notification-store';
import { createWorkbenchApplication } from '../../server/workbench/application';
import { createLocalSessionStore } from '../../server/workbench/session';

afterEach(async()=>{for(const cleanup of draftCleanups.splice(0)) await cleanup();});
it('bootstraps confirmed current heads and maintains them on entity/anchor commit without query writes',()=>{
  const f=draftFixture(); const index=createWorkbenchReadIndex(f.repository);
  const ref={entityType:'core_goal_definition',id:f.input.goal.id};
  const initial=f.repository.getStateRevision();
  expect(index.list('core_goal_definition')).toEqual([f.input.goal]);
  expect(index.list('core_goal_definition')).toEqual([f.input.goal]);
  expect(f.repository.getStateRevision()).toBe(initial);
  const anchor=makePublicationAnchor({id:fixtureId(280001),packageId:fixtureId(280002),publicationState:'unconfirmed',mainCommit:null,verifiedAt:null,timeVerification:'unknown',mergedAt:null});
  const next={...f.input.goal,revision:2,title:'Новая цель',publicationAnchorId:anchor.id};
  f.repository.transaction(()=>{f.repository.appendPublicationAnchor(anchor,null); f.repository.append('core_goal_definition',next,1);});
  expect(index.list('core_goal_definition')).toEqual([f.input.goal]);
  f.repository.appendPublicationAnchor({...anchor,publicationState:'confirmed',mainCommit:'b'.repeat(40),verifiedAt:f.clock.now()},1);
  expect(index.list('core_goal_definition')).toEqual([next]);
  index.rebuild(); expect(index.list('core_goal_definition')).toEqual([next]);
  expect(index.explain('core_goal_definition').join(' ')).toContain('wb_read_type');
});
it('rolls back read projection together with a failed source transaction',()=>{
  const f=draftFixture(); const index=createWorkbenchReadIndex(f.repository);
  expect(()=>f.repository.transaction(()=>{
    f.repository.append('core_goal_definition',{...f.input.goal,revision:2,title:'Не сохранять'},1);
    throw Error('synthetic failure');
  })).toThrow('synthetic failure');
  expect(index.list('core_goal_definition')).toEqual([f.input.goal]);
});
function queryFixture(input?:EvaluationInput) {
  const f=draftFixture({history:true,input});
  const clean={schemaVersion:1 as const,revision:1,recordedAt:f.clock.now(),actor:f.input.goal.actor,publicationAnchorId:f.input.goal.publicationAnchorId};
  const ditId=fixtureId(282001),clusterId=fixtureId(282002);
  f.repository.transaction(()=>{
    f.repository.append('directory_entity',{...clean,id:ditId,kind:'dit',name:'ДИТ',externalKeys:[]},null);
    if(!f.repository.getHead({entityType:'directory_entity',id:clusterId})) f.repository.append('directory_entity',{...clean,id:clusterId,kind:'cluster',name:'Кластер',externalKeys:[]},null);
    f.repository.append('directory_link',{...clean,id:fixtureId(282003),kind:'dit_cluster',from:{entityType:'directory_entity',id:ditId},to:{entityType:'directory_entity',id:clusterId}},null);
    const products=[...new Set([f.input.assignment.scope,...f.input.assignment.expectedPopulation??[]].filter(scope=>scope.kind==='product').map(scope=>scope.id))];
    products.forEach((id,n)=>f.repository.append('directory_link',{...clean,id:fixtureId(500000+n),kind:'cluster_product',from:{entityType:'directory_entity',id:clusterId},to:{entityType:'directory_entity',id}},null));
  });
  const index=createWorkbenchReadIndex(f.repository),registry=new QueryRegistry();
  const publishing=new PublishingService({repository:f.repository,clock:f.clock,drafts:f.service,artifacts:createPackageArtifactStore({artifactRoot:f.root+'/packages'}),git:{async readMain(){throw Error('query must not read Git');}},accessPolicy:f.policy,jobs:f.jobs,jobSink:f.jobs});
  const notifications=createNotificationService({repository:f.repository,provider:{async current(){throw Error('query must not poll');}},preferences:()=>({notificationPersonId:null})});
  const sources=createSourceStore({repository:f.repository});
  const ports={repository:f.repository,index,drafts:f.service,publishing:publishing.readPort,sources,notifications,jobs:f.jobs};
  registerWorkbenchQueries(registry,ports);
  const request:QueryRequest={context:{scopePath:{ditId,clusterId,productId:f.input.assignment.scope.kind==='product'?f.input.assignment.scope.id:null,teamId:null},goalId:f.input.goal.id,time:f.input.context.businessTime,resultMode:'current',snapshotId:null},filter:{},sort:[],page:{limit:50,cursor:null}};
  return {...f,commands:f.registry,index,registry,request,notifications,sources,ports,query:(name:string,filter:Record<string,unknown>={},context=f.context)=>registry.execute(name,{...request,filter},context)};
}
it('registers all 17 actual typed read-only query names and never captures, calculates or polls',async()=>{
  const f=queryFixture(); const before=f.repository.getStateRevision();
  expect(f.registry.listNames().sort()).toEqual([...workbenchQueryNames].sort());
  const filters:Record<string,Record<string,unknown>>={
    'execution.detail':{ref:{entityType:'work',id:fixtureId(282999)}},
    'data.rows':{captureRef:{entityType:'capture',id:f.input.captures[0].id,revision:1},layer:'raw',issuesOnly:false},
    'data.lineage':{factRef:{entityType:'observed_fact',id:f.input.facts[0].id,revision:1}},
    'history.series':{metricRef:{entityType:'metric_definition',id:f.input.metrics[0].id,revision:1},granularity:'day'},
    'uor.package':{packageRef:{entityType:'publication_package',id:fixtureId(282998)}},
    search:{text:'demo'},'notifications.list':{unreadOnly:false},
    'dashboards.view':{ref:{entityType:'dashboard_def',id:fixtureId(282997)}},'forms.describe':{formKind:'core_goal_definition'},
  };
  for(const name of workbenchQueryNames) {
    const result=f.query(name,filters[name]??{});
    if(['execution.detail','uor.package','dashboards.view'].includes(name)) await expect(result).rejects.toMatchObject({statusCode:404});
    else expect(await result).toBeDefined();
  }
  expect(f.repository.getStateRevision()).toBe(before);
  const goal=await f.query('goals.detail') as any;
  expect(goal.rows[0]).toMatchObject({needs_calculation:true,resultRef:null,numericResult:null});
  expect(Object.keys(goal.tabs).sort()).toEqual(['calculation','enriched','history','method','raw','state','work'].sort());
  await expect(f.query('uor.queue',{}, {...f.context,ownAccess:{...f.context.ownAccess,role:'viewer'}})).rejects.toMatchObject({statusCode:403});
  await expect(f.query('uor.queue',{}, {...f.context,ownAccess:{...f.context.ownAccess,policyState:'revoked'}})).rejects.toMatchObject({statusCode:403});
  await expect(f.query('goals.list',{anything:true})).rejects.toMatchObject({statusCode:422});
});
it('projects current freshness from the saved result without materializing a replacement',async()=>{
  const f=queryFixture(); const saved=await f.prepare();
  const before=await f.query('goals.list') as any;
  expect(before.items[0]).toMatchObject({needs_calculation:false,resultRef:saved.resultRef,numericResult:{freshness:'fresh',canConfirm:true}});
  const stored=f.repository.readVersion(saved.resultRef!); const revision=f.repository.getStateRevision();
  f.setNow('2026-11-02T12:00:00Z');
  const stale=await f.query('goals.list') as any;
  expect(stale.items[0]).toMatchObject({needs_calculation:false,resultRef:saved.resultRef,numericResult:{freshness:'stale',canConfirm:false}});
  expect(f.repository.readVersion(saved.resultRef!)).toEqual(stored);expect(f.repository.getStateRevision()).toBe(revision);
});
it('returns explicit unavailable agreed selection and protects own packages from foreign reads',async()=>{
  const f=queryFixture(); const opened=await f.open('core_goal_definition',{entityType:'core_goal_definition',id:f.input.goal.id});
  const queue=await f.query('uor.queue') as any;expect(queue.items[0].packageRef.id).toBe(f.packageId());
  const agreed=await f.registry.execute('goals.list',{...f.request,context:{...f.request.context,resultMode:'agreed',snapshotId:null}},f.context) as any;
  expect(agreed.items[0]).toMatchObject({numericResult:null,resultRef:null,unavailableReason:'AGREED_SNAPSHOT_UNAVAILABLE'});
  const other={...f.context,ownAccess:{...f.context.ownAccess,personId:fixtureId(282999)}};
  expect((await f.query('uor.queue',{},other) as any).items).toEqual([]);
  await expect(f.query('uor.package',{packageRef:{entityType:'publication_package',id:f.packageId()}},other)).rejects.toMatchObject({statusCode:404});
  const form=await f.query('forms.describe',{formKind:'core_goal_definition',ref:{entityType:'core_goal_definition',id:f.input.goal.id},packageRef:{entityType:'publication_package',id:f.packageId()}}) as any;
  expect(form.editToken).toBe(f.token());expect(opened.draftId).toBeTruthy();
});
it('keeps frozen agreed goal, assignment, result and labels independent of current edits',async()=>{
  const f=queryFixture(); const saved=await f.prepare();
  const basis=f.repository.readVersion<EvaluationBasis>(saved.basisRef)!;
  const result=f.repository.readVersion<CalculationResult>(saved.resultRef!)!;
  const frozenBasis={...basis,id:fixtureId(283001),publicationAnchorId:f.input.goal.publicationAnchorId};
  const basisRef={entityType:'evaluation_basis',id:frozenBasis.id,revision:1};
  const {schemaVersion:_schema,id:_id,revision:_rev,recordedAt:_at,actor:_actor,publicationAnchorId:_anchor,...numericResult}=result;
  const snapshot={schemaVersion:1 as const,id:fixtureId(283002),revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,basisRef,numericResult:{...numericResult,basisRef},manualStatusRef:null,attestationRef:null};
  f.repository.transaction(()=>{f.repository.append('evaluation_basis',frozenBasis,null);f.repository.append('agreed_snapshot',snapshot,null);});
  f.repository.transaction(()=>{
    f.repository.append('core_goal_definition',{...f.input.goal,revision:2,title:'Сегодняшнее название',measurementMode:'period'},1);
    const scope={kind:'product' as const,id:fixtureId(283003)};
    f.repository.append('directory_entity',{schemaVersion:1,id:scope.id,revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,kind:'product',name:'Другая область',externalKeys:[]},null);
    f.repository.append('goal_assignment',{...f.input.assignment,revision:2,scope,officialDueOn:'2026-12-01'},1);
    f.repository.append('observed_fact',{...f.input.facts[0],revision:2,value:'91'},1);
  });
  f.setNow('2026-11-20T12:00:00Z');const revision=f.repository.getStateRevision();
  const agreed=await f.registry.execute('goals.list',{...f.request,context:{...f.request.context,resultMode:'agreed',snapshotId:snapshot.id}},f.context) as any;
  expect(agreed.items[0]).toMatchObject({goal:{title:f.input.goal.title,revision:1},assignment:{revision:1,officialDueOn:null},numericResult:snapshot.numericResult,scopeName:null,leader:null});
  const frozenRows=await f.registry.execute('data.rows',{...f.request,context:{...f.request.context,resultMode:'agreed',snapshotId:snapshot.id},filter:{captureRef:{entityType:'capture',id:f.input.captures[0].id,revision:1},layer:'enriched',issuesOnly:false}},f.context) as any;
  expect(frozenRows.items[0].factRefs).toEqual([{entityType:'observed_fact',id:f.input.facts[0].id,revision:1}]);
  expect(f.repository.getStateRevision()).toBe(revision);
});
it('exposes the actual method for a template assignment without requiring a prior calculation',async()=>{
  const f=queryFixture();const header={schemaVersion:1 as const,id:fixtureId(286301),revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId};
  f.repository.transaction(()=>{f.repository.append('template',{...header,name:'Шаблон',methodRef:{entityType:'method_version',id:f.input.method.id,revision:1}},null);f.repository.append('goal_assignment',{...f.input.assignment,revision:2,methodBinding:{kind:'template',templateId:header.id}},1);});
  const detail=await f.query('goals.detail') as any;expect(detail.tabs.method[0].id).toBe(f.input.method.id);expect(detail.rows[0].needs_calculation).toBe(true);
});
it('sorts manual/numeric goal rows stably and never invents a numeric manual result',async()=>{
  const f=queryFixture(); const goal={...f.input.goal,id:fixtureId(283101),title:'Я ручная',mode:'manual_status',sourceId:fixtureId(283102)};
  const header={schemaVersion:1 as const,revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId};
  f.repository.transaction(()=>{
    f.repository.append('core_goal_definition',goal,null);
    f.repository.append('source_definition',{...header,id:goal.sourceId,kind:'manual_status',goalId:goal.id,mappingRef:null,publicLocator:null},null);
    f.repository.append('method_version',{...header,id:fixtureId(283103),mode:'manual_status'},null);
    f.repository.append('goal_assignment',{...f.input.assignment,id:fixtureId(283104),goalId:goal.id,expectedPopulation:null,methodBinding:{kind:'standalone',methodRef:{entityType:'method_version',id:fixtureId(283103),revision:1}}},null);
  });
  const sorted=await f.registry.execute('goals.list',{...f.request,context:{...f.request.context,goalId:null},sort:[{field:'title',direction:'desc'}]},f.context) as any;
  expect(sorted.items[0]).toMatchObject({goal:{title:'Я ручная'},numericResult:null,needs_calculation:false});
});
it('pages the actual own notification history past 200 entries without pumping',async()=>{
  const f=queryFixture();const store=createNotificationStore({repository:f.repository});
  for(let n=0;n<205;n++) store.record({installationId:f.context.installationId,profilePersonId:f.context.ownAccess.personId},`synthetic-${n}`,{provider:'test',objectRef:{entityType:'core_goal_definition',id:f.input.goal.id},sourceVersion:String(n),kind:'changed',recipientPersonIds:[],route:'/goals/'+f.input.goal.id},'new',f.clock.now());
  const before=f.repository.getStateRevision();
  const first=await f.registry.execute('notifications.list',{...f.request,filter:{unreadOnly:true},page:{limit:200,cursor:null}},f.context) as any;
  const second=await f.registry.execute('notifications.list',{...f.request,filter:{unreadOnly:true},page:{limit:200,cursor:first.page.nextCursor}},f.context) as any;
  expect(first.items).toHaveLength(200);expect(second.items).toHaveLength(5);expect(second.page.hasMore).toBe(false);
  const foreign=await f.query('notifications.list',{unreadOnly:false},{...f.context,ownAccess:{...f.context.ownAccess,personId:fixtureId(283999)}}) as any;
  expect(foreign.items).toEqual([]);expect(f.repository.getStateRevision()).toBe(before);
});
it('does not expose another installation fact revision through current history',async()=>{
  const f=queryFixture();const fact=f.input.facts[0];
  f.repository.append('observed_fact',{...fact,revision:2,publicationAnchorId:null,actor:{...fact.actor,installationId:fixtureId(284001),profilePersonId:fixtureId(284002)},value:'999'},1);
  const history=await f.query('history.series',{metricRef:{entityType:'metric_definition',id:f.input.metrics[0].id,revision:1},granularity:'day'}) as any;
  expect(history.points).toHaveLength(1);expect(history.points[0].value).toBe('92');
});
it('mounts real queries in the application with a catalog default context and page metadata',async()=>{
  const f=queryFixture();const queries=new QueryRegistry();const sessions=createLocalSessionStore({clock:f.clock});const session=sessions.issue();
  const app=createWorkbenchApplication({repository:f.repository,clock:f.clock,commands:f.commands,queries,jobs:f.jobs,modules:[],sessions,files:f.files,hostname:()=>f.context.actor.hostname,installationId:f.context.installationId,allowedOrigins:['http://127.0.0.1:4173'],accessPolicy:f.policy,queryPorts:f.ports});
  const local={requestId:fixtureId(285001),sessionId:session.id};const view=await app.session(local);
  expect(view.defaultContext?.scopePath.ditId).toBe(f.request.context.scopePath.ditId);
  const result=await app.query('goals.list',f.request,local);
  expect((result.data as any).items[0].goal.id).toBe(f.input.goal.id);expect(result.meta.page).toEqual({hasMore:false,nextCursor:null});
});
it('binds history cursors to owner, revision and selected filters',async()=>{
  const f=queryFixture();const filter={metricRef:{entityType:'metric_definition',id:f.input.metrics[0].id,revision:1},granularity:'day',fromInclusive:'2026-10-01',toExclusive:'2026-11-01'};
  const request={...f.request,filter,page:{limit:2,cursor:null as string|null}};
  const first=await f.registry.execute('history.series',request,f.context) as any;expect(first.nextCursor).toBeTruthy();
  const next={...request,page:{...request.page,cursor:first.nextCursor}};
  expect((await f.registry.execute('history.series',next,f.context) as any).points[0].date).toBe('2026-10-03');
  await expect(f.registry.execute('history.series',next,{...f.context,installationId:fixtureId(286001)})).rejects.toMatchObject({statusCode:409,code:'CURSOR_STALE'});
  await expect(f.registry.execute('history.series',{...next,filter:{...filter,granularity:'friday'}},f.context)).rejects.toMatchObject({code:'CURSOR_STALE'});
  f.repository.append('core_goal_definition',{...f.input.goal,revision:2,title:'Новая редакция'},1);
  await expect(f.registry.execute('history.series',next,f.context)).rejects.toMatchObject({code:'CURSOR_STALE'});
});
it('keeps a confirmed unknown-date publication current and rejects a private foreign capture',async()=>{
  const f=queryFixture();const anchor=makePublicationAnchor({id:fixtureId(286101),packageId:fixtureId(286102),mergedAt:null,timeVerification:'unknown'});
  const goal={...f.input.goal,revision:2,publicationAnchorId:anchor.id};
  const capture={...f.input.captures[0],id:fixtureId(286103),publicationAnchorId:null,actor:{...f.context.actor,profilePersonId:fixtureId(286104)}};
  f.repository.transaction(()=>{f.repository.appendPublicationAnchor(anchor,null);f.repository.append('core_goal_definition',goal,1);f.repository.append('capture',capture,null);});
  const current=await f.query('goals.list') as any;expect(current.items[0].goal.revision).toBe(2);expect(current.items[0].warnings).toContain('PUBLICATION_TIME_UNVERIFIED');
  expect(()=>f.repository.readPublishedAt({entityType:'core_goal_definition',id:goal.id},f.clock.now())).toThrow('EFFECTIVE_TIME_UNVERIFIED');
  await expect(f.query('data.rows',{captureRef:{entityType:'capture',id:capture.id,revision:1},layer:'raw',issuesOnly:false})).rejects.toMatchObject({statusCode:404});
});
async function publishedSnapshot(f:ReturnType<typeof queryFixture>) {
  const saved=await f.prepare();const basis=f.repository.readVersion<EvaluationBasis>(saved.basisRef)!;
  const result=f.repository.readVersion<CalculationResult>(saved.resultRef!)!;
  const frozen={...basis,id:fixtureId(287001),publicationAnchorId:f.input.goal.publicationAnchorId};
  const basisRef={entityType:'evaluation_basis',id:frozen.id,revision:1};
  const {schemaVersion:_schema,id:_id,revision:_revision,recordedAt:_at,actor:_actor,publicationAnchorId:_anchor,...numericResult}=result;
  const snapshot={schemaVersion:1 as const,id:fixtureId(287002),revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,basisRef,numericResult:{...numericResult,basisRef},manualStatusRef:null,attestationRef:null};
  f.repository.transaction(()=>{f.repository.append('evaluation_basis',frozen,null);f.repository.append('agreed_snapshot',snapshot,null);});
  return {snapshot,basis:frozen};
}
function publishedDashboard(f:ReturnType<typeof queryFixture>,settings:Array<[string,Record<string,unknown>]>):DashboardDef {
  const definition:DashboardDef={schemaVersion:1,id:fixtureId(287101),revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,title:'Рабочий дашборд',filters:[],blocks:settings.map(([kind,value],n)=>({id:fixtureId(287110+n),typeId:`uor.dashboard.${kind}.v1`,settings:{schemaId:`uor.dashboard.${kind}.v1`,schemaVersion:1,value}}))};
  f.repository.append('dashboard_def',definition,null);return definition;
}
function publishedWork(f:ReturnType<typeof queryFixture>,scope=f.input.assignment.scope):Work {
  const value:Work={schemaVersion:1,id:fixtureId(287201),revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,title:'Работа',goalIds:[f.input.goal.id],responsibility:[{scope,personId:f.input.goal.primaryCuratorPersonId}],state:'in_progress',dueOn:'2026-10-20',forecastOn:null,nextAction:'Проверить результат',reason:null,resultDescription:null,evidenceIds:[],risk:{reason:'Задержка',helpNeeded:'Нужно решение'},blocker:null};
  f.repository.append('work',value,null);return value;
}
it('review: supplies typed metric, trend, filtered tables and data issue block data',async()=>{
  const f=queryFixture();await f.prepare();const work=publishedWork(f);
  f.repository.append('work',{...work,id:fixtureId(287202),title:'Завершённая работа',state:'completed',resultDescription:'Готово',risk:null},null);
  f.repository.append('decision',{schemaVersion:1,id:fixtureId(287203),revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,workId:work.id,request:'Нужно решение',requestedFromPersonId:f.input.goal.primaryCuratorPersonId,dueOn:'2026-10-23',answer:null,answeredAt:null},null);
  f.setNow('2026-11-20T12:00:00Z');const layout={w:6,h:2};const assignmentRef={entityType:'goal_assignment',id:f.input.assignment.id},metricRef={entityType:'metric_definition',id:f.input.metrics[0].id,revision:1};
  const dashboard=publishedDashboard(f,[['metric-card',{layout,assignmentRef,metricRef,showTrend:true}],['metric-trend',{layout,assignmentRef,metricRef,granularity:'friday'}],['goal-table',{layout,columns:['title'],limit:1,attentionOnly:true}],['execution-table',{layout,kind:'work',columns:['title'],limit:1,attentionOnly:true}],['data-issues',{layout,kinds:['stale'],limit:1}],['execution-table',{layout,kind:'decision',columns:['title'],limit:1,attentionOnly:true}]]);
  const before=f.repository.getStateRevision();const model=await f.query('dashboards.view',{ref:{entityType:'dashboard_def',id:dashboard.id}}) as any;
  expect(model.blocks).toHaveLength(6);
  expect(model.blocks[0]).toMatchObject({type:'metric-card',value:'92',unit:'demo_unit',metricRef,unavailableReason:null});
  expect(model.blocks[0].trend.points[0].sourceFactRef.id).toBe(f.input.facts[0].id);
  expect(model.blocks[1].trend.points).toHaveLength(1);expect(model.blocks[2].items).toHaveLength(1);
  expect(model.blocks[3].items[0].ref.id).toBe(work.id);expect(model.blocks[4].items[0].kind).toBe('stale');
  expect(model.blocks[5].items[0].kind).toBe('decision');expect(model.blocks[5].items).toHaveLength(1);
  const unavailable=await f.registry.execute('dashboards.view',{...f.request,context:{...f.request.context,resultMode:'agreed',snapshotId:null},filter:{ref:{entityType:'dashboard_def',id:dashboard.id}}},f.context) as any;
  expect(unavailable.blocks[0]).toMatchObject({value:null,trend:null,unavailableReason:'AGREED_SNAPSHOT_UNAVAILABLE'});
  expect(f.repository.getStateRevision()).toBe(before);
});
it('review: agreed dashboard follows saved method and metric after current method changes',async()=>{
  const f=queryFixture();const {snapshot}=await publishedSnapshot(f);
  const dashboard=publishedDashboard(f,[['metric-card',{layout:{w:6,h:2},assignmentRef:{entityType:'goal_assignment',id:f.input.assignment.id},metricRef:{entityType:'metric_definition',id:f.input.metrics[0].id,revision:1},showTrend:true}]]);
  const request={...f.request,context:{...f.request.context,resultMode:'agreed' as const,snapshotId:snapshot.id},filter:{ref:{entityType:'dashboard_def',id:dashboard.id}}};
  await expect(f.registry.execute('dashboards.view',request,f.context)).resolves.toBeDefined();
  f.repository.transaction(()=>{
    f.repository.append('metric_definition',{...f.input.metrics[0],revision:2,name:'Новая метрика'},1);
    if(f.input.method.mode!=='numeric') throw Error('numeric fixture');
    f.repository.append('method_version',{...f.input.method,revision:2,rules:f.input.method.rules.map(rule=>({...rule,metricRef:{...rule.metricRef,revision:2}}))},1);
    f.repository.append('goal_assignment',{...f.input.assignment,revision:2,methodBinding:{kind:'standalone',methodRef:{entityType:'method_version',id:f.input.method.id,revision:2}}},1);
  });
  const model=await f.registry.execute('dashboards.view',request,f.context) as any;
  expect(model.blocks[0]).toMatchObject({value:'92',metricRef:{revision:1},basisRef:snapshot.basisRef});
});
it('review: discovers old-scope snapshots after the current assignment moves',async()=>{
  const f=queryFixture();const {snapshot}=await publishedSnapshot(f);
  const request={...f.request,context:{...f.request.context,resultMode:'agreed' as const,snapshotId:null}};
  expect((await f.registry.execute('snapshots.list',request,f.context) as any).items[0].ref.id).toBe(snapshot.id);
  const otherScope={kind:'product' as const,id:fixtureId(287301)};
  f.repository.transaction(()=>{
    f.repository.append('directory_entity',{schemaVersion:1,id:otherScope.id,revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,kind:'product',name:'Другой продукт',externalKeys:[]},null);
    f.repository.append('goal_assignment',{...f.input.assignment,revision:2,scope:otherScope},1);
  });
  expect((await f.registry.execute('snapshots.list',request,f.context) as any).items.map((v:any)=>v.ref.id)).toEqual([snapshot.id]);
});
it('review: finds a decision by its request and returns its actual scoped route',async()=>{
  const f=queryFixture();const work=publishedWork(f);
  const decision:Decision={schemaVersion:1,id:fixtureId(287401),revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,workId:work.id,request:'Утвердить закупку сервера',requestedFromPersonId:f.input.goal.primaryCuratorPersonId,dueOn:'2026-10-23',answer:null,answeredAt:null};
  f.repository.append('decision',decision,null);
  const result=await f.query('search',{text:'закупку'}) as any;
  expect(result.items[0]).toMatchObject({name:decision.request,ref:{entityType:'decision',id:decision.id}});expect(result.items[0].route).toContain('decision/');
});
it('review: selected goal does not bypass work responsibility scope; explicitly shared work remains visible',async()=>{
  const f=queryFixture();const otherScope={kind:'product' as const,id:fixtureId(287501)};
  f.repository.transaction(()=>{
    f.repository.append('directory_entity',{schemaVersion:1,id:otherScope.id,revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,kind:'product',name:'Продукт B',externalKeys:[]},null);
    f.repository.append('directory_link',{schemaVersion:1,id:fixtureId(287502),revision:1,recordedAt:f.clock.now(),actor:f.context.actor,publicationAnchorId:f.input.goal.publicationAnchorId,kind:'cluster_product',from:{entityType:'directory_entity',id:f.request.context.scopePath.clusterId!},to:{entityType:'directory_entity',id:otherScope.id}},null);
    f.repository.append('goal_assignment',{...f.input.assignment,id:fixtureId(287503),scope:otherScope},null);
  });
  const work=publishedWork(f,otherScope);expect((await f.query('execution.list') as any).items).toEqual([]);
  f.repository.append('work',{...work,revision:2,responsibility:[...work.responsibility,{scope:f.input.assignment.scope,personId:f.input.goal.primaryCuratorPersonId}]},1);
  expect((await f.query('execution.list') as any).items[0].ref.id).toBe(work.id);
});
it('review: sorts canonical numeric row values exactly instead of lexically',async()=>{
  const f=queryFixture();const original=f.input.captures[0];const capture={...original,id:fixtureId(287601),rawRows:[{rowKey:'two',cells:{value:{kind:'number' as const,original:'2'}}},{rowKey:'ten',cells:{value:{kind:'number' as const,original:'10'}}},{rowKey:'missing',cells:{value:{kind:'blank' as const,original:null}}}],canonicalRows:[{...original.canonicalRows[0],rowKey:'two',numbers:{value:'2',weight:'10'}},{...original.canonicalRows[0],rowKey:'ten',numbers:{value:'10',weight:'2'}},{...original.canonicalRows[0],rowKey:'missing',numbers:{value:null,weight:'0'}}],acceptedRows:3};
  f.repository.append('capture',capture,null);
  const result=await f.registry.execute('data.rows',{...f.request,filter:{captureRef:{entityType:'capture',id:capture.id,revision:1},layer:'enriched',issuesOnly:false},sort:[{field:'value',direction:'asc'}]},f.context) as any;
  expect(result.items.map((item:any)=>item.row.numbers.value)).toEqual(['2','10',null]);
  const descending=await f.registry.execute('data.rows',{...f.request,filter:{captureRef:{entityType:'capture',id:capture.id,revision:1},layer:'enriched',issuesOnly:false},sort:[{field:'value',direction:'desc'}]},f.context) as any;
  expect(descending.items.map((item:any)=>item.row.numbers.value)).toEqual(['10','2',null]);
});
it('measures 20 repetitions for 2000 rows and larger immutable history without hardware-sensitive assertions',async()=>{
  const population=Array.from({length:2000},(_,n)=>({kind:'product' as const,id:fixtureId(300000+n)}));
  const input=makeNumericFixture({values:['92'],targets:['90'],scope:{kind:'cluster',id:fixtureId(282002)},expectedPopulation:population});
  const f=queryFixture(input);
  f.repository.transaction(()=>{for(const fact of input.facts) {f.repository.append('observed_fact',{...fact,revision:2},1);f.repository.append('observed_fact',{...fact,revision:3},2);}});
  await f.prepare();
  const mapping=makeEntityGraph(input).entries.find(e=>e.entityType==='source_field_mapping')!.value as import('../../domain/workbench/entities').SourceFieldMapping;
  const columns=['demo_row_key','demo_scope_id','demo_metric_id','demo_value','demo_date'];
  const table:ParsedSourceTable={format:'csv',sheet:null,dateSystem:null,columns,rows:input.captures[0].canonicalRows.map((row,n)=>({coordinate:{sheet:null,row:n+2},cells:{demo_row_key:{kind:'text',original:String(n)},demo_scope_id:{kind:'text',original:row.dimensions.demo_scope_id!},demo_metric_id:{kind:'text',original:row.dimensions.demo_metric_id!},demo_value:{kind:'number',original:'92'},demo_date:{kind:'text',original:'2026-10-23'}}}))};
  const samples:Record<string,number[]>={list:[],search:[],normalize:[],evaluate:[]};
  for(let n=0;n<20;n++) {
    let start=performance.now();await f.query('goals.list');samples.list.push(performance.now()-start);
    start=performance.now();await f.query('search',{text:'demo_product'});samples.search.push(performance.now()-start);
    start=performance.now();expect(normalizeParsedWorkbenchTable({table,mapping}).canonicalRows.length).toBe(2000);samples.normalize.push(performance.now()-start);
    start=performance.now();evaluateAssignment(input);samples.evaluate.push(performance.now()-start);
    // Yield between repetitions so a long, synchronous SQLite benchmark does
    // not starve Vitest's worker heartbeat or cancellation/timeout delivery.
    await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
  const percentile=(values:number[],p:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
  console.info('T21_PERFORMANCE '+JSON.stringify({runtime:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemory:os.totalmem(),rss:process.memoryUsage().rss,rows:2000,factVersions:6000,repeats:20,timings:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,{p50:percentile(values,.5),p95:percentile(values,.95)}]))}));
  f.index.rebuild();const history=await f.query('history.series',{metricRef:{entityType:'metric_definition',id:input.metrics[0].id,revision:1},granularity:'day'}) as any;
  expect(history.points).toHaveLength(1);expect(f.index.explain('goal_assignment').join(' ')).toContain('wb_read_type');
},180000);
