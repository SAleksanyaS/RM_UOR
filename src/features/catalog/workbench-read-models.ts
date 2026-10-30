import { z } from 'zod';
import type { AgreedSnapshot, CalculationResult, Capture, CoreGoalDefinition, EvaluationBasis, EvaluationInput, GoalAssignment, NumericEvaluation, ObservedFact, WorkbenchEntityMap, WorkbenchEntityType } from '../../domain/workbench/entities';
import type { EntityRef, Header, VersionRef } from '../../domain/workbench/primitives';
import { entityRefSchema, versionRefSchema, utcInstantSchema, uuidSchema, businessTimeSchema, exactNumberSchema } from '../../domain/workbench/primitives';
import * as schemas from '../../domain/workbench/schemas';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { QueryContext } from '../../server/workbench/query-registry';
import { pageResultSchema, nextActionSchema, jobSnapshotSchema, WorkbenchHttpError, type GlobalContext, type QueryRequest } from '../../server/workbench/protocol';
import type { DraftService } from './workbench-drafts';
import type { PublicationReadPort } from '../publishing/workbench/package-store';
import { publicationPackageRecordSchema } from '../publishing/workbench/contracts';
import type { SourceStore, SourceCaptureView } from '../connectors/workbench-source-store';
import { sourceIssueSchema } from '../connectors/workbench-source-contracts';
import type { NotificationService } from '../execution/workbench-notifications';
import { notificationCauseSchema } from '../execution/workbench-reminders';
import type { JobStore } from '../../server/workbench/jobs';
import { resolveEvaluationInput } from '../evaluation/workbench/resolve-input';
import { canonicalBasis, digestBasis } from '../evaluation/workbench/basis';
import { projectEvaluationQuality } from '../evaluation/workbench/quality';
import { describeWorkbenchForm } from '../knowledge/workbench-fields';
import { validateDashboard, validateDashboardSettings, goalColumns, executionColumns } from '../knowledge/workbench-dashboards';
import { buildDashboardBlocks } from './workbench-dashboard-read';
import { queryHistorySeries } from '../history/workbench-history';
import { addMoscowDays } from '../../domain/workbench/time';
import { compare } from '../../domain/workbench/exact-number';
import { assertContextGraph, contextForScope, searchWorkbench, searchReadModelSchema } from './workbench-search';
import type { WorkbenchReadIndex } from './workbench-read-index';
import type { PreferencesService } from '../system/workbench-preferences';
import { workbenchRequestSchema } from './workbench-query-contracts';
import { canUseCapability } from '../identity/workbench-access-policy';

export type WorkbenchReadPorts={repository:WorkbenchRepository;index:WorkbenchReadIndex;drafts:DraftService;publishing:PublicationReadPort;sources:SourceStore;notifications:NotificationService;jobs:JobStore;preferences?:PreferencesService};
const pageOf=<T extends z.ZodType>(item:T)=>z.strictObject({items:z.array(item),page:pageResultSchema});
export const goalReadRowSchema=z.strictObject({
  ref:versionRefSchema,goal:schemas.coreGoalDefinitionSchema,assignment:schemas.goalAssignmentSchema,
  scopeName:z.string().nullable(),leader:schemas.directoryEntitySchema.nullable(),
  basisRef:versionRefSchema.nullable(),resultRef:versionRefSchema.nullable(),numericResult:schemas.numericEvaluationSchema.nullable(),manualStatus:schemas.manualStatusEventSchema.nullable(),
  needs_calculation:z.boolean(),unavailableReason:z.string().nullable(),displayValue:z.string().nullable(),unit:z.string().nullable(),
  publication:schemas.publicationAnchorSchema.nullable(),warnings:z.array(z.string()),
  attestation:schemas.attestationSchema.nullable(),snapshot:schemas.agreedSnapshotSchema.nullable(),nextActions:z.array(nextActionSchema),
});
export type GoalReadRow=z.infer<typeof goalReadRowSchema>;
const captureItemSchema=z.strictObject({ref:versionRefSchema,capture:schemas.captureSchema,obtainedVia:z.enum(['local-cache','git']),issues:z.array(sourceIssueSchema),latestAttemptIncomplete:z.boolean()});
export const executionReadItemSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('work'),ref:entityRefSchema,title:z.string(),value:schemas.workSchema}),
  z.strictObject({kind:z.literal('decision'),ref:entityRefSchema,title:z.string(),value:schemas.decisionSchema}),
]);
export type ExecutionReadItem=z.infer<typeof executionReadItemSchema>;
export const historyReadModelSchema=z.strictObject({mode:z.enum(['current','agreed']),basisRef:versionRefSchema.nullable(),points:z.array(z.union([
  z.strictObject({assignmentId:uuidSchema,metricId:uuidSchema,date:z.string(),value:exactNumberSchema.nullable(),sourceFactRef:versionRefSchema.nullable(),sourceBusinessTime:businessTimeSchema.nullable(),sourceCapturedAt:utcInstantSchema.nullable()}),
  schemas.weeklyPointSchema,
  z.strictObject({assignmentId:uuidSchema,metricId:uuidSchema,businessTime:businessTimeSchema,value:exactNumberSchema.nullable(),sourceFactRef:versionRefSchema,sourceCapturedAt:utcInstantSchema}),
])),nextCursor:z.string().nullable(),qualityFlags:z.array(z.string())});
const dashboardBase={id:uuidSchema,layout:z.strictObject({w:z.union([z.literal(3),z.literal(6),z.literal(12)]),h:z.union([z.literal(1),z.literal(2),z.literal(3)])})};
const metricBlock={...dashboardBase,assignmentRef:versionRefSchema.nullable(),metricRef:versionRefSchema,basisRef:versionRefSchema.nullable(),value:exactNumberSchema.nullable(),unit:z.string().nullable(),trend:historyReadModelSchema.nullable(),unavailableReason:z.string().nullable(),freshness:z.enum(['fresh','stale','unknown']).nullable(),qualityFlags:z.array(z.string())};
export const dashboardIssueSchema=z.strictObject({kind:z.enum(['stale','incomplete','missing','unmapped','error']),code:z.string(),message:z.string(),ref:entityRefSchema});
export type DashboardIssue=z.infer<typeof dashboardIssueSchema>;
export const dashboardBlockReadSchema=z.discriminatedUnion('type',[
  z.strictObject({...metricBlock,type:z.literal('metric-card')}),z.strictObject({...metricBlock,type:z.literal('metric-trend')}),
  z.strictObject({...dashboardBase,type:z.literal('goal-table'),columns:z.array(z.enum(goalColumns)),items:z.array(goalReadRowSchema)}),
  z.strictObject({...dashboardBase,type:z.literal('execution-table'),columns:z.array(z.enum(executionColumns)),items:z.array(executionReadItemSchema)}),
  z.strictObject({...dashboardBase,type:z.literal('data-issues'),items:z.array(dashboardIssueSchema)}),
]);
export type DashboardBlockRead=z.infer<typeof dashboardBlockReadSchema>;
const rawItem=z.strictObject({layer:z.literal('raw'),row:schemas.rawSourceRowSchema,issues:z.array(sourceIssueSchema)});
const enrichedItem=z.strictObject({layer:z.literal('enriched'),row:schemas.canonicalSourceRowSchema,factRefs:z.array(versionRefSchema),issues:z.array(sourceIssueSchema)});
const packageSummarySchema=z.strictObject({packageRef:entityRefSchema,revision:z.number().int(),editToken:z.string(),incomplete:z.number().int(),publication:publicationPackageRecordSchema.nullable(),activeJob:jobSnapshotSchema.nullable(),previewCurrent:z.null()});
const formSchema=z.strictObject({formKind:z.string(),ref:entityRefSchema.nullable(),schema:z.record(z.string(),z.unknown()),registeredSchemas:z.array(z.strictObject({schemaId:z.string(),schemaVersion:z.number(),schema:z.record(z.string(),z.unknown())})),values:z.record(z.string(),z.unknown()).nullable(),problems:z.array(z.strictObject({path:z.string(),code:z.string(),message:z.string(),ref:entityRefSchema.nullable()})),help:z.string(),actions:z.array(nextActionSchema),editToken:z.string().nullable()});
export const workbenchOutputSchemas={
  'context.options':z.strictObject({entities:z.array(schemas.directoryEntitySchema),links:z.array(schemas.directoryLinkSchema),goals:z.array(schemas.coreGoalDefinitionSchema)}),
  overview:z.strictObject({goals:z.array(goalReadRowSchema),execution:z.array(executionReadItemSchema),counts:z.strictObject({goals:z.number().int(),works:z.number().int(),decisions:z.number().int(),data:z.number().int()})}),
  'goals.list':pageOf(goalReadRowSchema),
  'goals.detail':z.strictObject({goal:schemas.coreGoalDefinitionSchema,rows:z.array(goalReadRowSchema),tabs:z.strictObject({state:z.array(goalReadRowSchema),work:z.array(executionReadItemSchema),method:z.array(schemas.methodVersionSchema),calculation:z.array(schemas.evaluationBasisSchema),enriched:z.array(captureItemSchema),raw:z.array(captureItemSchema),history:z.array(schemas.agreedSnapshotSchema)})}),
  'execution.list':pageOf(executionReadItemSchema),
  'execution.detail':z.strictObject({item:executionReadItemSchema,dependencies:z.array(schemas.workDependencySchema),decisions:z.array(schemas.decisionSchema)}),
  'data.captures':pageOf(captureItemSchema),'data.rows':pageOf(z.discriminatedUnion('layer',[rawItem,enrichedItem])),
  'data.lineage':z.strictObject({basis:schemas.evaluationBasisSchema.nullable(),method:schemas.methodVersionSchema.nullable(),facts:z.array(schemas.observedFactSchema),captures:z.array(schemas.captureSchema),mappings:z.array(schemas.sourceFieldMappingSchema),directoryLinks:z.array(schemas.directoryLinkSchema)}),
  'history.series':historyReadModelSchema,
  'snapshots.list':pageOf(z.strictObject({ref:versionRefSchema,snapshot:schemas.agreedSnapshotSchema,basis:schemas.evaluationBasisSchema,publication:schemas.publicationAnchorSchema})),
  'uor.queue':pageOf(packageSummarySchema),
  'uor.package':z.strictObject({summary:packageSummarySchema,entries:z.array(z.strictObject({draftId:uuidSchema,entityRef:entityRefSchema,versionRef:versionRefSchema,baseRef:versionRefSchema.nullable(),definition:z.record(z.string(),z.unknown()),complete:z.boolean(),problems:z.array(z.strictObject({path:z.string(),code:z.string(),message:z.string(),ref:entityRefSchema.nullable()}))}))}),
  search:searchReadModelSchema,
  'notifications.list':pageOf(z.strictObject({id:uuidSchema,cause:notificationCauseSchema,category:z.enum(['new','reminder','error']),createdAt:utcInstantSchema,emittedAt:utcInstantSchema,readAt:utcInstantSchema.nullable()})),
  'dashboards.view':z.strictObject({definition:schemas.dashboardDefSchema,blocks:z.array(dashboardBlockReadSchema),unavailableReason:z.string().nullable()}),
  'forms.describe':formSchema,
};
export type WorkbenchQueryName=keyof typeof workbenchOutputSchemas;
export type WorkbenchReadModels={ [K in WorkbenchQueryName]:z.infer<typeof workbenchOutputSchemas[K]> };
export type WorkbenchReadModel=WorkbenchReadModels[WorkbenchQueryName];
const fail=(code:string,status=422):never=>{throw new WorkbenchHttpError(status,code,code);};
const ref=(entityType:string,value:Header):VersionRef=>({entityType,id:value.id,revision:value.revision});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function visible(value:Header,context:QueryContext):boolean {
  const anchor=value.publicationAnchorId?context.repository.readPublicationAnchor({entityType:'publication_anchor',id:value.publicationAnchorId}):null;
  return anchor?.publicationState==='confirmed' || value.actor.installationId===context.installationId && value.actor.profilePersonId===context.ownAccess.personId;
}
function exact<T extends Header>(reference:VersionRef,context:QueryContext):T {
  const value=context.repository.readVersion<T>(reference); if(!value || !visible(value,context)) return fail('REFERENCE_NOT_FOUND',404); return value;
}
function inScope(assignment:GoalAssignment,context:GlobalContext,index:WorkbenchReadIndex):boolean {
  const target=contextForScope(assignment.scope,index,context); if(!target) return false;
  return Object.entries(context.scopePath).every(([key,value])=>value===null || target.scopePath[key as keyof typeof target.scopePath]===value);
}
function assignmentsFor(request:QueryRequest,ports:WorkbenchReadPorts):GoalAssignment[] {
  if(request.context.resultMode==='agreed' && request.context.snapshotId) {
    const snapshot=ports.index.read({entityType:'agreed_snapshot',id:request.context.snapshotId}) as AgreedSnapshot|null;
    const basis=snapshot?ports.repository.readVersion<EvaluationBasis>(snapshot.basisRef):null;
    const assignment=basis?ports.repository.readVersion<GoalAssignment>(basis.assignmentRef):null;
    if(!basis || !assignment || !same(basis.businessTime,request.context.time) || request.context.goalId && assignment.goalId!==request.context.goalId) return [];
    return inSavedScope(assignment,basis,request.context,ports)?[assignment]:[];
  }
  return ports.index.list('goal_assignment').filter(a=>(!request.context.goalId || a.goalId===request.context.goalId) && inScope(a,request.context,ports.index));
}
function inSavedScope(assignment:GoalAssignment,basis:EvaluationBasis,context:GlobalContext,ports:WorkbenchReadPorts):boolean {
  const selected=context.scopePath.teamId??context.scopePath.productId??context.scopePath.clusterId??context.scopePath.ditId;
  const links=basis.directoryLinkRefs.flatMap(reference=>{const link=ports.repository.readVersion<z.infer<typeof schemas.directoryLinkSchema>>(reference);return link&&link.kind!=='leader'?[link]:[];});
  const pending=[selected],seen=new Set<string>();
  while(pending.length) {const current=pending.pop()!;if(current===assignment.scope.id) return true;if(seen.has(current)) continue;seen.add(current);for(const link of links) if(link.from.id===current) pending.push(link.to.id);}
  return false;
}
function snapshotsInContext(request:QueryRequest,context:QueryContext,ports:WorkbenchReadPorts) {
  return ports.index.list('agreed_snapshot').flatMap(snapshot=>{
    const basis=exact<EvaluationBasis>(snapshot.basisRef,context),assignment=exact<GoalAssignment>(basis.assignmentRef,context);
    if(request.context.goalId && assignment.goalId!==request.context.goalId || !same(basis.businessTime,request.context.time) || !inSavedScope(assignment,basis,request.context,ports)) return [];
    const publication=snapshot.publicationAnchorId?context.repository.readPublicationAnchor({entityType:'publication_anchor',id:snapshot.publicationAnchorId}):null;
    return publication?[{ref:ref('agreed_snapshot',snapshot),snapshot,basis,publication}]:[];
  });
}
function savedEvaluationInput(row:GoalReadRow,request:QueryRequest,context:QueryContext):EvaluationInput|null {
  if(!row.basisRef) return null;
  const basis=exact<EvaluationBasis>(row.basisRef,context);if(request.context.resultMode==='agreed' && !basis.evaluatedAt) return null;
  const assignment=exact<GoalAssignment>(basis.assignmentRef,context),goal=exact<CoreGoalDefinition>(basis.goalRef,context);
  const method=exact<z.infer<typeof schemas.methodVersionSchema>>(basis.methodRef,context);
  const metrics=method.mode==='numeric'?method.rules.map(rule=>exact<z.infer<typeof schemas.metricDefinitionSchema>>(rule.metricRef,context)):[];
  const facts=basis.factRefs.map(reference=>exact<ObservedFact>(reference,context));
  const captures=[...new Set(facts.map(fact=>fact.captureId))].map(id=>exact<Capture>({entityType:'capture',id,revision:1},context));
  const applicability=basis.applicabilityRefs.map(reference=>exact<z.infer<typeof schemas.applicabilitySchema>>(reference,context));
  const corrections=basis.correctionRefs.map(reference=>exact<z.infer<typeof schemas.manualCorrectionSchema>>(reference,context));
  const anchors=new Map<string,z.infer<typeof schemas.publicationAnchorSchema>>();
  for(const value of [assignment,goal,method,...metrics,...facts,...captures,...applicability,...corrections]) if(value.publicationAnchorId && !anchors.has(value.publicationAnchorId)) {
    const anchor=context.repository.readPublicationAnchor({entityType:'publication_anchor',id:value.publicationAnchorId});if(anchor) anchors.set(anchor.id,anchor);
  }
  return {assignment,goal,method,metrics,facts,captures,applicability,corrections,context:{businessTime:basis.businessTime,evaluatedAt:request.context.resultMode==='agreed'?basis.evaluatedAt!:context.clock.now()},resolution:{basisRef:row.basisRef,templateRef:basis.templateRef,directoryLinkRefs:basis.directoryLinkRefs,publicationAnchors:[...anchors.values()],actor:basis.actor}};
}
function goalRows(request:QueryRequest,context:QueryContext,ports:WorkbenchReadPorts):GoalReadRow[] {
  const rows:GoalReadRow[]=[];
  for(const assignment of assignmentsFor(request,ports)) {
    let displayedAssignment=assignment;
    let goal=ports.index.read({entityType:'core_goal_definition',id:assignment.goalId}) as CoreGoalDefinition|null; if(!goal) continue;
    let snapshot:AgreedSnapshot|null=null,basis:EvaluationBasis|null=null,resultRef:VersionRef|null=null,numericResult:NumericEvaluation|null=null,manualStatus:null|z.infer<typeof schemas.manualStatusEventSchema>=null,unavailableReason:string|null=null;
    if(request.context.resultMode==='agreed') {
      snapshot=request.context.snapshotId?ports.index.read({entityType:'agreed_snapshot',id:request.context.snapshotId}) as AgreedSnapshot|null:null;
      if(snapshot) {
        basis=exact<EvaluationBasis>(snapshot.basisRef,context);
        if(basis.assignmentRef.id!==assignment.id || !same(basis.businessTime,request.context.time)) {snapshot=null;basis=null;}
      }
      if(!snapshot || !basis) unavailableReason='AGREED_SNAPSHOT_UNAVAILABLE';
      else {
        goal=exact<CoreGoalDefinition>(basis.goalRef,context); displayedAssignment=exact<GoalAssignment>(basis.assignmentRef,context);numericResult=snapshot.numericResult;
        manualStatus=snapshot.manualStatusRef?exact<z.infer<typeof schemas.manualStatusEventSchema>>(snapshot.manualStatusRef,context):null;
      }
    } else if(goal.measurementMode!==request.context.time.kind) {unavailableReason='MEASUREMENT_MODE_MISMATCH';}
    else if(goal.mode==='manual_status') manualStatus=context.repository.readLatestManualStatus(assignment.id);
    else {
      try {
        // Current quality is a pure projection. Candidate rows are filtered to
        // this installation/person or confirmed shared data before selection.
        const confirmations=new Map<string,boolean>();
        const accessible=(value:Header)=>{
          if(value.actor.installationId===context.installationId && value.actor.profilePersonId===context.ownAccess.personId) return true;
          const id=value.publicationAnchorId;if(!id) return false;
          if(!confirmations.has(id)) confirmations.set(id,context.repository.readPublicationAnchor({entityType:'publication_anchor',id})?.publicationState==='confirmed');
          return confirmations.get(id)===true;
        };
        const repository:WorkbenchRepository={...context.repository,readEvaluationCandidates(query){const all=context.repository.readEvaluationCandidates(query);return {facts:all.facts.filter(accessible),captures:all.captures.filter(accessible),applicability:all.applicability.filter(accessible),corrections:all.corrections.filter(accessible)};}};
        const input=resolveEvaluationInput({assignmentRef:ref('goal_assignment',assignment),businessTime:request.context.time},repository,context.clock,{hostname:'read-model',installationId:context.installationId,profilePersonId:context.ownAccess.personId});
        const digest=digestBasis(canonicalBasis(input)); const saved=context.repository.findEvaluationByDigest(digest);
        if(saved?.resultRef) {
          const stored=exact<CalculationResult>(saved.resultRef,context); basis=exact<EvaluationBasis>(stored.basisRef,context); resultRef=saved.resultRef;
          const {schemaVersion:_schema,id:_id,revision:_revision,recordedAt:_at,actor:_actor,publicationAnchorId:_anchor,...result}=stored;
          const selected=new Set(basis.factRefs.map(reference=>`${reference.id}/${reference.revision}`));
          numericResult=projectEvaluationQuality(result,{...input,facts:input.facts.filter(fact=>selected.has(`${fact.id}/${fact.revision}`))});
        }
      } catch(error) {unavailableReason=(error as {code?:string}).code??'BASIS_UNAVAILABLE';}
    }
    const attestation=snapshot?.attestationRef?exact<z.infer<typeof schemas.attestationSchema>>(snapshot.attestationRef,context):basis?ports.index.list('attestation').find(a=>a.basisDigest===basis!.digest)??null:null;
    const frozen=request.context.resultMode==='agreed';
    const leader=frozen?null:ports.index.list('directory_link').find(l=>l.kind==='leader' && l.scope.id===assignment.scope.id);
    const scopeName=frozen?null:(ports.index.read({entityType:'directory_entity',id:assignment.scope.id}) as {name:string}|null)?.name??null;
    const publication=goal.publicationAnchorId?context.repository.readPublicationAnchor({entityType:'publication_anchor',id:goal.publicationAnchorId}):null;
    const warnings=[...(frozen?['HISTORICAL_DIRECTORY_LABELS_UNAVAILABLE']:[]),...(publication?.timeVerification==='unknown'?['PUBLICATION_TIME_UNVERIFIED']:[])];
    rows.push({ref:ref('goal_assignment',displayedAssignment),goal,assignment:displayedAssignment,scopeName,leader:leader?.kind==='leader'?ports.index.read({entityType:'directory_entity',id:leader.personId}) as z.infer<typeof schemas.directoryEntitySchema>:null,basisRef:basis?ref('evaluation_basis',basis):null,resultRef,numericResult,manualStatus,needs_calculation:!frozen && goal.mode==='numeric' && !numericResult,unavailableReason,displayValue:numericResult?.scorePercent?`${numericResult.scorePercent.numerator}/${numericResult.scorePercent.denominator}`:null,unit:numericResult?'%':null,publication,warnings,attestation,snapshot,nextActions:[{commandName:null,payload:null,route:'/goals/'+goal.id,label:'Открыть цель',enabled:true,disabledReason:null}]});
  }
  return rows;
}
function execution(request:QueryRequest,ports:WorkbenchReadPorts) {
  const works=ports.index.list('work').filter(w=>(!request.context.goalId || w.goalIds.includes(request.context.goalId)) &&
    (w.responsibility.some(r=>inScope({scope:r.scope} as GoalAssignment,request.context,ports.index)) || !w.responsibility.length && !request.context.scopePath.clusterId));
  const ids=new Set(works.map(w=>w.id));
  return [...works.map(value=>({kind:'work' as const,ref:{entityType:'work',id:value.id},title:value.title,value})),...ports.index.list('decision').filter(d=>ids.has(d.workId)).map(value=>({kind:'decision' as const,ref:{entityType:'decision',id:value.id},title:value.request,value}))];
}
type CaptureRead={capture:Capture;view:SourceCaptureView|null;obtainedVia:'local-cache'|'git';facts?:ObservedFact[]};
function captures(request:QueryRequest,context:QueryContext,ports:WorkbenchReadPorts):CaptureRead[] {
  if(request.context.resultMode==='agreed') {
    const snapshot=request.context.snapshotId?ports.index.read({entityType:'agreed_snapshot',id:request.context.snapshotId}) as AgreedSnapshot|null:null;
    if(!snapshot || !assignmentsFor(request,ports).length) return [];
    const basis=exact<EvaluationBasis>(snapshot.basisRef,context);
    const selected=basis.factRefs.map(reference=>exact<ObservedFact>(reference,context));
    return [...new Set(selected.map(fact=>fact.captureId))].map(id=>({capture:exact<Capture>({entityType:'capture',id,revision:1},context),view:null,obtainedVia:'git',facts:selected.filter(fact=>fact.captureId===id)}));
  }
  const sourceIds=new Set(assignmentsFor(request,ports).flatMap(a=>{const goal=ports.index.read({entityType:'core_goal_definition',id:a.goalId}) as CoreGoalDefinition|null;return goal?[goal.sourceId]:[];}));
  const local=ports.sources.listOwnCaptures({installationId:context.installationId,profilePersonId:context.ownAccess.personId});
  const byId=new Map<string,{capture:Capture;view:SourceCaptureView|null;obtainedVia:'local-cache'|'git'}>();
  ports.index.list('capture').forEach(c=>byId.set(c.id,{capture:c,view:null,obtainedVia:'git'}));
  local.forEach(view=>byId.set(view.capture.id,{capture:view.capture,view,obtainedVia:'local-cache'}));
  return [...byId.values()].filter(v=>sourceIds.has(v.capture.sourceId)).sort((a,b)=>b.capture.capturedAt.localeCompare(a.capture.capturedAt)||a.capture.id.localeCompare(b.capture.id));
}
export function queryWorkbench<K extends WorkbenchQueryName>(name:K,request:QueryRequest,context:QueryContext,ports:WorkbenchReadPorts):Promise<WorkbenchReadModels[K]>;
export async function queryWorkbench(name:WorkbenchQueryName,request:QueryRequest,context:QueryContext,ports:WorkbenchReadPorts):Promise<unknown> {
  if(context.repository!==ports.repository) return fail('COMMAND_CONTEXT_MISMATCH',409);
  const parsed=workbenchRequestSchema(name).safeParse(request);if(!parsed.success) return fail('VALIDATION_FAILED');request=parsed.data;
  // Joins in one synchronous query share the same decoded current inventory.
  // This cache lives only for this request; time/visibility/revision cannot leak
  // into a later request or be reused after an asynchronous source operation.
  const index=ports.index;const lists=new Map<WorkbenchEntityType,Header[]>();
  ports={...ports,index:{...index,list<K extends WorkbenchEntityType>(type:K):WorkbenchEntityMap[K][] {
    if(!lists.has(type)) lists.set(type,index.list(type));
    return lists.get(type)! as WorkbenchEntityMap[K][];
  }}};
  if(request.context.resultMode==='agreed' && request.context.snapshotId && name!=='search') {
    const snapshot=ports.index.read({entityType:'agreed_snapshot',id:request.context.snapshotId}) as AgreedSnapshot|null;
    if(!snapshot) return fail('REFERENCE_NOT_FOUND',404);
    const basis=exact<EvaluationBasis>(snapshot.basisRef,context);
    if(!same(basis.businessTime,request.context.time) || request.context.goalId && basis.goalRef.id!==request.context.goalId || !assignmentsFor(request,ports).length) return fail('SNAPSHOT_CONTEXT_MISMATCH');
  } else assertContextGraph(request.context,ports.index);
  if(name.startsWith('uor.') && !canUseCapability(context.ownAccess,'uor.prepare')) return fail('ACCESS_DENIED',403);
  const filter=request.filter;
  const sortValue=(item:any,field:string):unknown=>{
    const value=item.value??item;const goal=item.goal;
    switch(field) {
      case 'title':return goal?.title??item.title??item.snapshot?.recordedAt??item.packageRef?.id??value.id??item.row?.rowKey;
      case 'scope':return item.scopeName??JSON.stringify(item.assignment?.scope??item.row?.dimensions??null);
      case 'owner':return item.leader?.name??value.responsibility?.map((r:any)=>r.personId).join(',')??value.requestedFromPersonId??null;
      case 'requirement':return item.assignment?.officialDueOn??null;
      case 'current':case 'agreed':return item.numericResult?.scorePercent??null;
      case 'freshness':return item.numericResult?.freshness??null;
      case 'coverage':return item.numericResult?.coveragePercent??null;
      case 'confirmation':return item.attestation?.recordedAt??null;
      case 'nextAction':return value.nextAction??item.nextActions?.[0]?.label??null;
      case 'kind':return item.kind??null;
      case 'state':return item.publication?.state??value.state??null;
      case 'dueOn':case 'forecastOn':return value[field]??null;
      case 'risk':return value.risk?.reason??null;
      case 'capturedAt':return item.capture?.capturedAt??null;
      case 'source':return item.capture?.sourceId??null;
      case 'status':return item.capture?.result??null;
      case 'factKey':return item.row?.rowKey??null;
      case 'metric':return item.factRefs?.[0]?.id??null;
      case 'value':return item.row?.numbers?JSON.stringify(item.row.numbers):JSON.stringify(item.row?.cells??null);
      case 'recordedAt':return item.snapshot?.recordedAt??item.publication?.recordedAt??null;
      default:return null;
    }
  };
  const paged=<T>(items:T[])=>{
    const stable=(item:any)=>JSON.stringify(item.ref??item.packageRef??item.row?.rowKey??item.id??item);
    const sorted=[...items].sort((left,right)=>{
      for(const sort of request.sort) {
        if(sort.field==='value') {
          const numbers=(item:unknown)=>(item as {row?:{numbers?:Record<string,string|null>}}).row?.numbers;
          const a=numbers(left),b=numbers(right);
          if(a && b) {
            let difference=0;
            for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()) {
              const x=a[key]??null,y=b[key]??null;
              if(x===null || y===null) {if(x!==y) return x===null?1:-1;continue;}
              difference=compare(x,y);if(difference) break;
            }
            if(difference) return sort.direction==='asc'?difference:-difference;
            continue;
          }
        }
        const a=sortValue(left,sort.field),b=sortValue(right,sort.field);
        const textA=String(a),textB=String(b);
        const diff=a===b?0:a===null?1:b===null?-1:['current','agreed','coverage'].includes(sort.field)?compare(a as never,b as never):textA<textB?-1:textA>textB?1:0;
        if(diff) return sort.direction==='asc'?diff:-diff;
      }
      return request.sort.length?stable(left).localeCompare(stable(right)):0;
    });
    return ports.index.page(sorted,request.page,{name,context:request.context,filter,sort:request.sort},context);
  };
  if(name==='search') return searchWorkbench(request,context,ports.index);
  if(name==='context.options') {const search=String(filter.search??'').toLocaleLowerCase('ru');return {entities:ports.index.list('directory_entity').filter(e=>e.name.toLocaleLowerCase('ru').includes(search)),links:ports.index.list('directory_link'),goals:ports.index.list('core_goal_definition').filter(g=>g.title.toLocaleLowerCase('ru').includes(search))};}
  if(name==='notifications.list') return ports.index.pageRead((offset,limit)=>ports.notifications.readPage(context,{offset,limit,unreadOnly:filter.unreadOnly===true,sort:request.sort}),request.page,{name,filter,sort:request.sort,context:request.context},context);
  if(name==='forms.describe') {
    const own=filter.packageRef?{drafts:ports.drafts,packageId:(filter.packageRef as EntityRef).id}:undefined;
    return describeWorkbenchForm({formKind:filter.formKind as string,ref:filter.ref as EntityRef??null},context,own);
  }
  if(name==='uor.queue' || name==='uor.package') {
    const packages=name==='uor.package'?[ports.drafts.readOwnPackage(context,(filter.packageRef as EntityRef).id)]:ports.drafts.listOwnPackages(context);
    const running=ports.jobs.recoveryCandidates(context.installationId);
    const summaries=packages.map(pkg=>{
      const publication=ports.publishing.readOwnPackage(context,pkg.packageId);
      const activeJob=running.find(job=>job.resourceKey==='package:'+pkg.packageId)?.snapshot??null;
      // Metadata state alone never enables submission. A new preview command
      // followed by assertPreview remains the authoritative drift/TTL gate.
      return {packageRef:{entityType:'publication_package',id:pkg.packageId},revision:pkg.revision,editToken:`draft:${pkg.packageId}:${pkg.revision}`,incomplete:pkg.entries.filter(e=>!e.complete).length,publication,activeJob,previewCurrent:null};
    });
    if(name==='uor.queue') return paged(summaries);
    return {summary:summaries[0],entries:packages[0].entries.map(({draftId,entityRef,versionRef,baseRef,definition,complete,problems})=>({draftId,entityRef,versionRef,baseRef,definition,complete,problems}))};
  }
  if(name==='execution.list') return paged(execution(request,ports).filter(item=>!filter.kind || filter.kind==='all' || item.kind===filter.kind));
  if(name==='execution.detail') {const reference=filter.ref as EntityRef;const item=execution(request,ports).find(item=>item.ref.entityType===reference.entityType && item.ref.id===reference.id);if(!item) return fail('REFERENCE_NOT_FOUND',404);const workId=item.kind==='work'?item.value.id:item.value.workId;return {item,dependencies:ports.index.list('work_dependency').filter(d=>d.predecessorWorkId===workId||d.successorWorkId===workId),decisions:ports.index.list('decision').filter(d=>d.workId===workId)};}
  if(name==='snapshots.list') return paged(snapshotsInContext(request,context,ports));
  const available=captures(request,context,ports);
  const captureItems=()=>available.map(item=>({ref:ref('capture',item.capture),capture:item.capture,obtainedVia:item.obtainedVia,issues:item.view?.issues??[],latestAttemptIncomplete:item.capture.result==='partial'}));
  if(name==='data.captures') return paged(captureItems());
  if(name==='data.rows') {
    const reference=filter.captureRef as VersionRef; const selected=available.find(c=>c.capture.id===reference.id && c.capture.revision===reference.revision); if(!selected) return fail('REFERENCE_NOT_FOUND',404);
    const issues=selected.view?.issues??[];
    if(filter.layer==='raw') return paged(selected.capture.rawRows.map(row=>({layer:'raw' as const,row,issues:issues.filter(issue=>issue.rowKeys.includes(row.rowKey))})).filter(row=>!filter.issuesOnly||row.issues.length));
    const facts=selected.facts??selected.view?.facts??ports.index.list('observed_fact').filter(f=>f.captureId===selected.capture.id);
    return paged(selected.capture.canonicalRows.map(row=>({layer:'enriched' as const,row,factRefs:facts.filter(f=>f.lineage.sourceRowKeys.includes(row.rowKey)).map(f=>ref('observed_fact',f)),issues:issues.filter(issue=>issue.rowKeys.includes(row.rowKey))})).filter(row=>!filter.issuesOnly||row.issues.length));
  }
  if(name==='data.lineage') {
    const result=filter.resultRef?exact<CalculationResult>(filter.resultRef as VersionRef,context):null;
    const basis=result?exact<EvaluationBasis>(result.basisRef,context):null;
    const pending=basis?[...basis.factRefs]:[filter.factRef as VersionRef];const facts:ObservedFact[]=[];const seen=new Set<string>();
    while(pending.length) {const reference=pending.pop()!;const key=JSON.stringify(reference);if(seen.has(key)) continue;seen.add(key);const fact=exact<ObservedFact>(reference,context);facts.push(fact);pending.push(...fact.lineage.inputFactRefs);}
    const unique=<T extends Header>(values:T[])=>[...new Map(values.map(v=>[`${v.id}/${v.revision}`,v])).values()];
    return {basis,method:basis?exact(basis.methodRef,context):null,facts,captures:unique(facts.map(f=>exact<Capture>({entityType:'capture',id:f.captureId,revision:1},context))),mappings:unique(facts.map(f=>exact<z.infer<typeof schemas.sourceFieldMappingSchema>>(f.lineage.mappingRef,context))),directoryLinks:unique(facts.flatMap(f=>f.lineage.directoryLinkRefs.map(r=>exact<z.infer<typeof schemas.directoryLinkSchema>>(r,context))))};
  }
  if(name==='history.series') {
    const assignments=assignmentsFor(request,ports);if(assignments.length!==1) return fail('ASSIGNMENT_SELECTION_REQUIRED');
    const time=request.context.time;
    const snapshot=request.context.resultMode==='agreed' && request.context.snapshotId?ports.index.read({entityType:'agreed_snapshot',id:request.context.snapshotId}):null;
    if(request.context.resultMode==='agreed' && !snapshot) return {mode:'agreed',basisRef:null,points:[],nextCursor:null,qualityFlags:['AGREED_SNAPSHOT_UNAVAILABLE']};
    const repository:WorkbenchRepository={...context.repository,readHistoryRecords(query){return context.repository.readHistoryRecords({...query,visibility:{installationId:context.installationId,profilePersonId:context.ownAccess.personId}});}};
    const binding={name,context:request.context,filter,sort:request.sort,limit:request.page.limit};
    const position=request.page.cursor?ports.index.openCursor(request.page.cursor,binding,context):null;
    if(position!==null && typeof position!=='string') return fail('CURSOR_STALE',409);
    const result=queryHistorySeries({assignmentRef:ref('goal_assignment',assignments[0]),metricRef:filter.metricRef as VersionRef,mode:request.context.resultMode,snapshotRef:snapshot?ref('agreed_snapshot',snapshot):null,granularity:filter.granularity as 'day'|'friday',fromInclusive:filter.fromInclusive as string??(time.kind==='as_of'?time.date:time.startInclusive),toExclusive:filter.toExclusive as string??(time.kind==='as_of'?addMoscowDays(time.date,1):time.endExclusive),evaluatedAt:context.clock.now(),effectiveAt:null,cursor:position,limit:request.page.limit},repository);
    return {...result,nextCursor:result.nextCursor?ports.index.sealCursor(result.nextCursor,binding,context):null};
  }
  const rows=goalRows(request,context,ports);
  if(name==='goals.list') return paged(rows);
  if(name==='goals.detail') {
    if(!request.context.goalId) return fail('GOAL_SELECTION_REQUIRED');
    const method=rows.map(row=>{
      if(row.basisRef) return exact(exact<EvaluationBasis>(row.basisRef,context).methodRef,context);
      const binding=row.assignment.methodBinding;
      if(binding.kind==='standalone') return exact(binding.methodRef,context);
      const template=ports.index.read({entityType:'template',id:binding.templateId}) as z.infer<typeof schemas.templateSchema>|null;
      if(!template) return fail('REFERENCE_NOT_FOUND',404);return exact(template.methodRef,context);
    });
    return {goal:rows[0]?.goal??ports.index.read({entityType:'core_goal_definition',id:request.context.goalId}),rows,tabs:{state:rows,work:execution(request,ports),method,calculation:rows.flatMap(row=>row.basisRef?[exact(row.basisRef,context)]:[]),enriched:captureItems(),raw:captureItems(),history:snapshotsInContext(request,context,ports).map(item=>item.snapshot)}};
  }
  if(name==='overview') {const active=rows.filter(row=>row.goal.lifecycle==='active');const work=execution(request,ports);return {goals:filter.kind && filter.kind!=='goal'?[]:active,execution:filter.kind==='goal'||filter.kind==='data'?[]:work.filter(item=>!filter.kind||item.kind===filter.kind),counts:{goals:active.length,works:work.filter(v=>v.kind==='work').length,decisions:work.filter(v=>v.kind==='decision').length,data:available.filter(v=>v.capture.result==='partial').length}};}
  if(name==='dashboards.view') {
    const definition=ports.index.read(filter.ref as EntityRef) as z.infer<typeof schemas.dashboardDefSchema>|null;if(!definition) return fail('REFERENCE_NOT_FOUND',404);
    const agreed=request.context.resultMode==='agreed';
    const agreedBasis=agreed&&rows[0]?.basisRef?exact<EvaluationBasis>(rows[0].basisRef,context):undefined;
    const resolver={read:(reference:EntityRef|VersionRef)=>'revision' in reference?exact(reference,context):ports.index.read(reference),agreedBasis};
    validateDashboardSettings(definition);
    if(!agreed) validateDashboard(definition,resolver);
    else if(agreedBasis) validateDashboard({...definition,blocks:definition.blocks.filter(block=>!['uor.dashboard.metric-card.v1','uor.dashboard.metric-trend.v1'].includes(block.typeId)||(block.settings.value.assignmentRef as EntityRef).id===agreedBasis.assignmentRef.id)},resolver);
    const unavailableReason=agreed&&!agreedBasis?'AGREED_SNAPSHOT_UNAVAILABLE':null;
    const issues:DashboardIssue[]=[];
    const addIssue=(kind:DashboardIssue['kind'],code:string,reference:EntityRef,message=code)=>issues.push({kind,code,ref:{entityType:reference.entityType,id:reference.id},message});
    for(const row of rows) {
      if(row.numericResult?.freshness==='stale') addIssue('stale','STALE_DATA',row.ref);
      if(row.numericResult && !row.numericResult.complete) addIssue('incomplete','INCOMPLETE_COVERAGE',row.ref);
      if(row.numericResult?.calculation==='no_data' || row.needs_calculation) addIssue('missing',row.needs_calculation?'NEEDS_CALCULATION':'NO_DATA',row.ref);
      if(row.unavailableReason) addIssue('error',row.unavailableReason,row.ref);
      for(const flag of row.numericResult?.qualityFlags??[]) if(flag.includes('lineage_')) addIssue('unmapped',flag,row.ref);
    }
    for(const item of available) {
      if(item.capture.result==='partial') addIssue('incomplete','PARTIAL_CAPTURE',ref('capture',item.capture));
      for(const issue of item.view?.issues??[]) addIssue(/unmapped|mapping|directory|scope/i.test(issue.code)?'unmapped':'error',issue.code,ref('capture',item.capture),issue.message);
    }
    const executionItems=execution(request,ports);
    const blocks=buildDashboardBlocks({definition,goals:rows,execution:executionItems,issues,resolver,unavailableReason,today:new Date(Date.parse(context.clock.now())+3*60*60*1000).toISOString().slice(0,10),inputFor:row=>savedEvaluationInput(row,request,context),trendFor:(row,metricRef,granularity)=>{
      const time=request.context.time;
      const repository:WorkbenchRepository={...context.repository,readHistoryRecords(query){return context.repository.readHistoryRecords({...query,visibility:{installationId:context.installationId,profilePersonId:context.ownAccess.personId}});}};
      return queryHistorySeries({assignmentRef:row.ref,metricRef,mode:request.context.resultMode,snapshotRef:row.snapshot?ref('agreed_snapshot',row.snapshot):null,granularity,fromInclusive:time.kind==='as_of'?time.date:time.startInclusive,toExclusive:time.kind==='as_of'?addMoscowDays(time.date,1):time.endExclusive,evaluatedAt:context.clock.now(),effectiveAt:null,cursor:null,limit:200},repository);
    }});
    return {definition,blocks,unavailableReason};
  }
  return fail('QUERY_NOT_FOUND',404);
}
