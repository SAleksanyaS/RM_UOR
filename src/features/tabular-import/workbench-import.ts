import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Capture, CanonicalSourceRow, MetricRule, ObservedFact } from '../../domain/workbench/entities';
import type { Clock, Header, VersionRef } from '../../domain/workbench/primitives';
import { newUuid, uuidSchema, versionRefSchema } from '../../domain/workbench/primitives';
import { defaultSourceParsingProfile, observedFactSchema } from '../../domain/workbench/schemas';
import { compare } from '../../domain/workbench/exact-number';
import type { WorkbenchRepository } from '../../server/storage/workbench-repository';
import type { CommandContext, CommandRegistry } from '../../server/workbench/command-registry';
import { commitCommandEffect, stableJson } from '../../server/workbench/command-store';
import type { FileStore, StagedFile } from '../../server/workbench/files';
import type { JobStore } from '../../server/workbench/jobs';
import { fieldProblemSchema, WorkbenchHttpError, type FieldProblem } from '../../server/workbench/protocol';
import { enrichSourceRows } from '../catalog/workbench-directory';
import { normalizeParsedWorkbenchTable } from '../connectors/workbench-source-normalizer';
import { sourceScopeReachable, type ResolvedCaptureBinding, type SourceStore } from '../connectors/workbench-source-store';
import type { SourceIssue } from '../connectors/workbench-source-contracts';
import { reduceRows } from '../evaluation/workbench/reducers';
import { normalizeMetric } from '../evaluation/workbench/conditions';
import { canUseCapability } from '../identity/workbench-access-policy';
import { parseWorkbenchTable } from './workbench-parser';
import type { ImportPreviewRecord, ImportStore } from './workbench-import-store';

const refSchema = (type: string) => versionRefSchema.refine(ref => ref.entityType === type);
export const importPreviewInputSchema = z.strictObject({ goalId: uuidSchema, fileHandle: uuidSchema });
export const importApplyInputSchema = z.strictObject({ previewToken: z.string().min(1), acceptedRowIds: z.array(uuidSchema).refine(ids => new Set(ids).size === ids.length), acceptedCorrectionIds: z.array(uuidSchema).refine(ids => new Set(ids).size === ids.length) });
export const importPreviewRowSchema = z.strictObject({ id: uuidSchema, rowKey: z.string().min(1), coordinate: z.strictObject({ sheet: z.string().nullable(), row: z.number().int().positive() }), acceptable: z.boolean(), proposedFact: observedFactSchema.nullable(), problems: z.array(fieldProblemSchema) });
export const fileFactCorrectionCandidateSchema = z.strictObject({ id: uuidSchema, kind: z.literal('file_fact_revision'), beforeFactRef: refSchema('observed_fact'), afterFact: observedFactSchema });
export const importPreviewResultSchema = z.strictObject({ previewToken: z.string().min(1), rows: z.array(importPreviewRowSchema), corrections: z.array(fileFactCorrectionCandidateSchema), issues: z.array(fieldProblemSchema), complete: z.boolean() });
export const importApplyResultSchema = z.strictObject({ captureRef: refSchema('capture'), acceptedRowIds: z.array(uuidSchema), acceptedCorrectionIds: z.array(uuidSchema), rejectedRowIds: z.array(uuidSchema), complete: z.boolean() });
export type ImportPreviewRow = z.infer<typeof importPreviewRowSchema>;
export type FileFactCorrectionCandidate = z.infer<typeof fileFactCorrectionCandidateSchema>;
export type ImportPreviewResult = z.infer<typeof importPreviewResultSchema>;
export type ImportApplyResult = z.infer<typeof importApplyResultSchema>;
export interface ImportService {
  preview(context: CommandContext, input: z.infer<typeof importPreviewInputSchema>): Promise<ImportPreviewResult>;
  apply(context: CommandContext, input: z.infer<typeof importApplyInputSchema>): Promise<ImportApplyResult>;
}
const fail = (code: string, message: string, status = 422): never => { throw new WorkbenchHttpError(status,code,message); };
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const ref = (entityType: string, value: Header): VersionRef => ({ entityType,id:value.id,revision:value.revision });
const field = (code: string, path = ''): FieldProblem => ({ code,path,message:code,ref:null });
const scopeKey = (scope: { kind: string; id: string }) => `${scope.kind}/${scope.id}`;
const sameFact = (a: ObservedFact, b: ObservedFact) => a.origin === b.origin && a.state === b.state && a.unitCode === b.unitCode && a.missingReason === b.missingReason && (a.value === null || b.value === null ? a.value === b.value : compare(a.value,b.value) === 0);

export function createImportService({ repository, store, sources, files, jobs, clock, recheckGuard }: {
  repository: WorkbenchRepository; store: ImportStore; sources: SourceStore; files: FileStore; jobs: Pick<JobStore,'findByCommand'|'get'|'registerControl'|'registerStage'|'stage'>; clock: Clock; recheckGuard(context: CommandContext): Promise<void>;
}): ImportService {
  for (const stage of ['import.read','import.parse','import.preview','import.commit']) jobs.registerStage(stage);
  const assertOwner = (context: CommandContext) => {
    if (context.repository !== repository || context.actor.installationId !== context.installationId || context.actor.profilePersonId !== context.ownAccess.personId) return fail('COMMAND_CONTEXT_MISMATCH','Import context does not match its owner',409);
    if (!context.ownAccess.personId || !canUseCapability(context.ownAccess,'uor.prepare')) return fail('COMMAND_FORBIDDEN','Import requires a curator identity',403);
    return context.ownAccess.personId;
  };
  const operation = (context: CommandContext) => {
    const job = jobs.findByCommand(context.commandId,context.installationId);
    if (!job || job.status !== 'running') return fail('IMPORT_JOB_REQUIRED','Import requires its running job',409);
    const controller = new AbortController(); jobs.registerControl(job.jobId,{ cancel: async () => { controller.abort(); } });
    const check = () => { if (controller.signal.aborted || jobs.get(job.jobId,context.installationId)?.status !== 'running') return fail('IMPORT_CANCELLED','Import cancelled before commit',409); };
    return { job,check,stage: (stage: string) => { check(); jobs.stage(job.jobId,stage,{completed:0,total:null,unit:'rows'}); },close: () => jobs.registerControl(job.jobId,{cancel:undefined}) };
  };
  const resolve = (context: CommandContext, goalId: string) => {
    const binding = sources.resolveCapture({ installationId: context.installationId,goalId });
    if (binding.source.kind !== 'file' || binding.goal.mode !== 'numeric' || binding.method.mode !== 'numeric') return fail('IMPORT_SOURCE_REQUIRED','File import is available only for an explicitly configured numeric file source');
    if (!binding.assignment.expectedPopulation?.length || !binding.method.rules.length) return fail('SOURCE_INVALID_CONFIGURATION','Import requires published metrics and expected population');
    return binding;
  };
  const state = (context: CommandContext, binding: ResolvedCaptureBinding, factKeys: string[]) => {
    const current = repository.readImportFactState({ sourceId:binding.source.id,metricIds:binding.metrics.map(m=>m.id),scopes:binding.assignment.expectedPopulation!,businessTime:binding.businessTime,factKeys });
    const captureOwnership=new Map<string,boolean>();
    const facts = current.facts.filter(fact => {
      if (!captureOwnership.has(fact.captureId)) captureOwnership.set(fact.captureId,sources.readCapture({entityType:'capture',id:fact.captureId,revision:1},context.installationId)!==null);
      if (captureOwnership.get(fact.captureId)) return true;
      return fact.publicationAnchorId !== null && repository.readPublicationAnchor({entityType:'publication_anchor',id:fact.publicationAnchorId})?.publicationState === 'confirmed';
    });
    return { facts,corrections:current.corrections };
  };
  const basis = (context: CommandContext, binding: ResolvedCaptureBinding, factKeys: string[]) => digest({ configurationRevision:binding.configurationRevision,...state(context,binding,factKeys),groupRows:store.groupRows(context.installationId,binding.source.id,binding.mappingRef,factKeys) });
  const captureReader = () => {
    const values=new Map<string,Capture|null>();
    return (id:string) => { if(!values.has(id))values.set(id,repository.getHead<Capture>({entityType:'capture',id}));return values.get(id)!; };
  };
  const sameContributions = (before: ObservedFact, rows: CanonicalSourceRow[], rule: MetricRule, readCapture: ReturnType<typeof captureReader>) => {
    const capture=readCapture(before.captureId);
    const previous=capture?.canonicalRows.filter(row=>before.lineage.sourceRowKeys.includes(row.rowKey))??[];
    const reducer=rule.reducer,fields=reducer.kind==='count'?[]:reducer.kind==='ratio'?[reducer.numeratorField,reducer.denominatorField]:[reducer.valueField];
    const signatures=(values:CanonicalSourceRow[])=>values.map(row=>stableJson({numbers:Object.fromEntries(fields.map(field=>[field,row.numbers[field]??null])),dimensions:row.dimensions,businessTime:row.businessTime,unitCode:row.unitCode})).sort();
    return previous.length===before.lineage.sourceRowKeys.length&&stableJson(signatures(previous))===stableJson(signatures(rows));
  };
  const currentByKey = (facts: ObservedFact[], readCapture = captureReader()) => {
    const result = new Map<string,ObservedFact>();
    const date = (f: ObservedFact) => readCapture(f.captureId)?.capturedAt ?? '';
    for (const fact of facts) { const before=result.get(fact.factKey); if (!before || date(fact)>date(before) || date(fact)===date(before) && (fact.recordedAt>before.recordedAt || fact.recordedAt===before.recordedAt && (fact.revision>before.revision || fact.revision===before.revision && fact.id>before.id))) result.set(fact.factKey,fact); }
    return result;
  };
  const completePopulation = (binding: ResolvedCaptureBinding, facts: ObservedFact[]) => binding.metrics.every(metric => binding.assignment.expectedPopulation!.every(scope => facts.filter(f=>f.metricId===metric.id && scopeKey(f.scope)===scopeKey(scope) && stableJson(f.businessTime)===stableJson(binding.businessTime) && f.state==='known').length===1));
  const assertUnchanged = (context: CommandContext, record: ImportPreviewRecord) => {
    let current: ResolvedCaptureBinding;
    try { current=resolve(context,record.goalId); } catch { return fail('PREVIEW_STALE','Published import configuration changed',409); }
    const keys=Object.keys(record.groupMembership);
    if (basis(context,current,keys)!==record.basisDigest) return fail('PREVIEW_STALE','Import preview changed; review the file again',409);
    return current;
  };
  const checkedFile = async (context: CommandContext, handle: string) => files.read(handle,context.installationId,'goal-import',assertOwner(context));
  const service: ImportService = {
    async preview(context,unparsed) {
      const input=importPreviewInputSchema.parse(unparsed), personId=assertOwner(context), op=operation(context);
      try {
        const binding=resolve(context,input.goalId),readCapture=captureReader(); op.stage('import.read'); const file=await checkedFile(context,input.fileHandle); op.check();
        const applied=store.findAppliedFile(context.installationId,personId,input.goalId,input.fileHandle,binding.configurationRevision);
        if (applied) { await recheckGuard(context); op.check(); sources.assertUnchanged(binding,context.installationId); return commitCommandEffect(context,()=>({result:applied.view,changedRefs:[],editToken:null})).result; }
        op.stage('import.parse'); const table=await parseWorkbenchTable({bytes:file.bytesValue,name:file.name,parsingProfile:binding.mapping.parsingProfile??defaultSourceParsingProfile}); op.check();
        const normalized=normalizeParsedWorkbenchTable({table,mapping:binding.mapping});
        const enriched=enrichSourceRows({capture:{sourceId:binding.source.id,mappingRef:binding.mappingRef,...normalized},mapping:binding.mapping,directoryEntities:binding.directoryEntities,directoryLinks:binding.directoryLinks});
        const header=():Header=>({schemaVersion:1,id:newUuid(),revision:1,recordedAt:clock.now(),actor:context.actor,publicationAnchorId:null});
        const capture: Capture={...header(),sourceId:binding.source.id,operationId:op.job.jobId,obtainedVia:'file_import',capturedAt:clock.now(),sourceUpdatedAt:null,payloadHash:'sha256:'+file.sha256,rawArtifactId:file.fileHandle,mappingRef:binding.mappingRef,result:'partial',acceptedRows:0,rejectedRows:normalized.rawRows.length,rawRows:normalized.rawRows,canonicalRows:normalized.canonicalRows};
        const rows:ImportPreviewRow[]=[],issues:FieldProblem[]=[],groups=new Map<string,{fact:ObservedFact;rows:CanonicalSourceRow[];problems:FieldProblem[];coordinate:ImportPreviewRow['coordinate']}>();
        if (binding.method.mode!=='numeric') return fail('IMPORT_SOURCE_REQUIRED','A numeric method is required');
        for (const [index,row] of enriched.rows.entries()) {
          const problems=[...normalized.issues.filter(i=>i.rowKeys.includes(row.rowKey)).map(i=>field(i.code,`/rows/${index}`)),...enriched.issues.filter(i=>i.path===`/canonicalRows/${index}`)];
          if (!row.scope || !binding.assignment.expectedPopulation!.some(scope=>scopeKey(scope)===scopeKey(row.scope!)) || !sourceScopeReachable(binding.assignment.scope,row.scope,binding.directoryLinks)) problems.push(field('REQUIRED_SCOPE_UNRESOLVED',`/rows/${index}`));
          if (!row.scope || problems.some(p=>p.code==='REQUIRED_SCOPE_UNRESOLVED')) { rows.push({id:newUuid(),rowKey:row.rowKey,coordinate:table.rows[index].coordinate,acceptable:false,proposedFact:null,problems}); issues.push(...problems); continue; }
          if (row.businessTime.kind==='unknown') issues.push(field('UNKNOWN_BUSINESS_DATE',`/rows/${index}`));
          for (const rule of binding.method.rules) {
            const metric=binding.metrics.find(m=>m.id===rule.metricRef.id)!;
            const factKey=stableJson({sourceId:binding.source.id,metricId:metric.id,scope:row.scope,businessTime:row.businessTime,dimensions:row.dimensions});
            let group=groups.get(factKey);
            if (!group) { const fact:ObservedFact={...header(),sourceId:binding.source.id,captureId:capture.id,metricId:metric.id,scope:row.scope,businessTime:row.businessTime,sourceUpdatedAt:null,origin:rule.reducer.kind==='source_provided_value'?'source_value':'reducer',state:'missing',value:null,missingReason:'pending_reduction',unitCode:metric.unit.code,factKey,lineage:{captureId:capture.id,sourceRowKeys:[],mappingRef:binding.mappingRef,directoryLinkRefs:enriched.directoryLinkRefs,inputFactRefs:[],reducerMethodRef:rule.reducer.kind==='source_provided_value'?null:binding.methodRef}}; group={fact,rows:[],problems:[],coordinate:table.rows[index].coordinate}; groups.set(factKey,group); }
            const {scope:_,directoryEntityRefs:__,...canonical}=row; group.rows.push(canonical); group.problems.push(...problems);
          }
        }
        const snapshot=state(context,binding,[...groups.keys()]),existing=currentByKey(snapshot.facts,readCapture),knownMembers=store.groupRows(context.installationId,binding.source.id,binding.mappingRef,[...groups.keys()]);
        const groupMembership=Object.fromEntries([...groups].map(([key,group])=>[key,group.rows.map(row=>row.rowKey).sort()]));
        for (const group of groups.values()) {
          const rule=binding.method.rules.find(r=>r.metricRef.id===group.fact.metricId)!;
          const reduced=reduceRows({reducer:rule.reducer,rows:group.rows,unitCode:group.fact.unitCode,assignmentRef:binding.assignmentRef,methodRef:binding.methodRef,metricRef:rule.metricRef});
          group.problems.push(...reduced.qualityFlags.map(code=>field(code))); group.fact.lineage.sourceRowKeys=reduced.sourceRowKeys;
          if (reduced.value!==null) { group.fact.value=reduced.value; group.fact.state='known'; group.fact.missingReason=null; }
          const before=existing.get(group.fact.factKey);
          if (rule.reducer.kind!=='source_provided_value') {
            const required=new Set([...(knownMembers[group.fact.factKey]??[]),...(before&&stableJson(before.lineage.mappingRef)===stableJson(binding.mappingRef)?before.lineage.sourceRowKeys:[])]);
            const present=new Set(group.rows.map(row=>row.rowKey));
            const unchangedWholeGroup=before&&sameFact(before,group.fact)&&present.size===required.size&&sameContributions(before,group.rows,rule,readCapture);
            if ([...required].some(key=>!present.has(key))&&!unchangedWholeGroup) group.problems.push(field('IMPORT_GROUP_INCOMPLETE'));
          }
          if (reduced.value!==null) try { normalizeMetric(reduced.value,rule,binding.metrics.find(m=>m.id===group.fact.metricId)!); } catch(error) { group.problems.push(field(typeof(error as {code?:unknown}).code==='string'?(error as {code:string}).code:'INVALID_METRIC_DOMAIN')); }
          rows.push({id:newUuid(),rowKey:group.rows[0].rowKey,coordinate:group.coordinate,acceptable:group.problems.length===0,proposedFact:group.problems.length?null:group.fact,problems:group.problems}); issues.push(...group.problems);
        }
        const selectedRowKeys=Object.fromEntries(rows.map(row=>[row.id,row.proposedFact?.lineage.sourceRowKeys??[row.rowKey]]));
        const corrections:FileFactCorrectionCandidate[]=[],unchangedRowIds:string[]=[];
        for (const row of rows) if (row.proposedFact) {
          const before=existing.get(row.proposedFact.factKey);
          const rule=binding.method.rules.find(r=>r.metricRef.id===row.proposedFact!.metricId)!;
          if (before) { if (sameFact(before,row.proposedFact)&&(rule.reducer.kind==='source_provided_value'||sameContributions(before,groups.get(row.proposedFact.factKey)!.rows,rule,readCapture))) { row.proposedFact=before; unchangedRowIds.push(row.id); } else { row.proposedFact={...row.proposedFact,id:before.id,revision:before.revision+1}; corrections.push({id:newUuid(),kind:'file_fact_revision',beforeFactRef:ref('observed_fact',before),afterFact:row.proposedFact}); } }
          if (snapshot.corrections.some(c=>c.factKey===row.proposedFact!.factKey && row.proposedFact!.value!==null && compare(c.replacement,row.proposedFact!.value)!==0)) issues.push(field('MANUAL_CORRECTION_DISCREPANCY',`/rows/${rows.indexOf(row)}`));
        }
        const view=importPreviewResultSchema.parse({previewToken:newUuid(),rows,corrections,issues,complete:issues.length===0 && rows.every(r=>r.acceptable) && completePopulation(binding,[...existing.values()].filter(f=>!rows.some(r=>r.proposedFact?.factKey===f.factKey)).concat(rows.flatMap(r=>r.proposedFact?[r.proposedFact]:[])))});
        const {bytesValue:_,purpose:__,installationId:___,profilePersonId:____,...fileView}=file;
        const record:ImportPreviewRecord={installationId:context.installationId,personId,goalId:input.goalId,file:fileView,binding,basisDigest:basis(context,binding,[...groups.keys()]),view,capture,rawRows:normalized.rawRows,canonicalRows:normalized.canonicalRows,unchangedRowIds,selectedRowKeys,groupMembership,validGroupKeys:rows.flatMap(row=>row.acceptable&&row.proposedFact?[row.proposedFact.factKey]:[])};
        await recheckGuard(context); op.check(); assertUnchanged(context,record); op.stage('import.preview');
        return commitCommandEffect(context,()=>{ op.check(); assertUnchanged(context,record); store.save(record); return {result:view,changedRefs:[],editToken:null}; }).result;
      } finally { op.close(); }
    },
    async apply(context,unparsed) {
      const input=importApplyInputSchema.parse(unparsed),personId=assertOwner(context),op=operation(context);
      try {
        const record=store.read(input.previewToken,context.installationId,personId); if (!record) return fail('IMPORT_PREVIEW_NOT_FOUND','Own import preview not found',404);
        const selectedDigest=digest({rows:[...input.acceptedRowIds].sort(),corrections:[...input.acceptedCorrectionIds].sort()});
        if (!input.acceptedRowIds.length&&!input.acceptedCorrectionIds.length) return fail('IMPORT_SELECTION_REQUIRED','Select at least one valid row or correction');
        const applied=store.readApplied(input.previewToken,context.installationId,personId);
        if (applied) { if (applied.selectionDigest!==selectedDigest) return fail('IDEMPOTENCY_CONFLICT','This preview was already applied with another selection',409); await recheckGuard(context); op.check(); return commitCommandEffect(context,()=>({result:importApplyResultSchema.parse(applied.result),changedRefs:[],editToken:null})).result; }
        const rows=new Map(record.view.rows.map(r=>[r.id,r])),corrections=new Map(record.view.corrections.map(c=>[c.id,c]));
        for (const id of input.acceptedRowIds) { const row=rows.get(id); if (!row?.acceptable||!row.proposedFact) return fail('IMPORT_SELECTION_INVALID','Selected row does not belong to this valid preview'); if (record.view.corrections.some(c=>c.afterFact.id===row.proposedFact!.id)) return fail('IMPORT_CORRECTION_SELECTION_REQUIRED','Select the proposed correction explicitly'); }
        for (const id of input.acceptedCorrectionIds) if (!corrections.has(id)) return fail('IMPORT_SELECTION_INVALID','Selected correction does not belong to this preview');
        assertUnchanged(context,record); op.stage('import.read'); const file=await checkedFile(context,record.file.fileHandle); op.check();
        if (file.sha256!==record.file.sha256||file.bytes!==record.file.bytes) return fail('PREVIEW_STALE','File changed after preview',409);
        await recheckGuard(context); op.check();
        return commitCommandEffect(context,()=>{
          op.check();
          const duplicate=store.readApplied(input.previewToken,context.installationId,personId);
          if (duplicate) { if (duplicate.selectionDigest!==selectedDigest) return fail('IDEMPOTENCY_CONFLICT','Preview selection already committed',409); return {result:duplicate.result,changedRefs:[],editToken:null}; }
          const binding=assertUnchanged(context,record);
          const selectedCorrections=input.acceptedCorrectionIds.map(id=>corrections.get(id)!);
          const selectedRows=[...input.acceptedRowIds.map(id=>rows.get(id)!),...record.view.rows.filter(r=>r.proposedFact&&selectedCorrections.some(c=>c.afterFact.id===r.proposedFact!.id))];
          const proposed=selectedRows.flatMap(r=>r.proposedFact?[r.proposedFact]:[]),facts=selectedRows.filter(r=>!record.unchangedRowIds.includes(r.id)).flatMap(r=>r.proposedFact?[{...r.proposedFact,recordedAt:clock.now(),actor:context.actor}]:[]);
          const previous=currentByKey(state(context,binding,proposed.map(f=>f.factKey)).facts);
          facts.forEach(f=>previous.delete(f.factKey));
          const selectedIds=new Set(selectedRows.map(r=>r.id)),rejectedRowIds=record.view.rows.filter(r=>!selectedIds.has(r.id)).map(r=>r.id);
          const complete=rejectedRowIds.length===0&&record.view.issues.length===0&&completePopulation(binding,[...previous.values(),...facts]);
          const acceptedKeys=new Set(selectedRows.flatMap(row=>record.selectedRowKeys[row.id]));
          const capture:Capture={...record.capture,operationId:op.job.jobId,result:complete?'accepted':'partial',acceptedRows:acceptedKeys.size,rejectedRows:record.rawRows.length-acceptedKeys.size};
          const artifact=sources.saveArtifact({installationId:context.installationId,artifactId:file.fileHandle,mimeType:file.mediaType,bytesValue:file.bytesValue});
          const issues:SourceIssue[]=[...record.view.issues,...(rejectedRowIds.length?[field('IMPORT_ROWS_NOT_ACCEPTED')]:[])].map(i=>({code:i.code,stage:'import',retryable:false,message:i.message||i.code,rowKeys:[],refs:i.ref?[i.ref]:[]}));
          op.stage('import.commit');
          const saved=sources.commitCapture({installationId:context.installationId,binding,request:{operationId:op.job.jobId,goalRef:binding.goalRef,sourceRef:binding.sourceRef,mappingRef:binding.mappingRef,businessTime:binding.businessTime,context:binding.context,configurationRevision:binding.configurationRevision,profileRef:null},raw:{operationId:op.job.jobId,sourceRef:binding.sourceRef,mappingRef:binding.mappingRef,capturedAt:capture.capturedAt,sourceUpdatedAt:null,rawRows:record.rawRows,artifact,payloadHash:capture.payloadHash,coverage:{complete,expectedRows:record.rawRows.length,receivedRows:record.rawRows.length,evidence:['selected-import-preview:'+record.view.previewToken,'sha256:'+file.sha256]},issues},capture,facts,retainedFactRefs:[...previous.values()].map(f=>ref('observed_fact',f)),issues});
          const result=importApplyResultSchema.parse({captureRef:saved.captureRef,acceptedRowIds:input.acceptedRowIds,acceptedCorrectionIds:input.acceptedCorrectionIds,rejectedRowIds,complete});
          store.rememberGroups(record,proposed.map(fact=>fact.factKey));
          store.complete(input.previewToken,selectedDigest,result);
          return {result,changedRefs:[{entityType:'capture',id:capture.id},...facts.map(f=>({entityType:'observed_fact',id:f.id}))],editToken:null};
        }).result;
      } finally { op.close(); }
    },
  };
  return service;
}
export function registerImportCommands(registry:CommandRegistry,service:ImportService):void {
  registry.register({name:'import.preview',inputSchema:importPreviewInputSchema,outputSchema:importPreviewResultSchema,capability:'uor.prepare',effect:'local',execution:'async',ownership:'person',resourceKey:input=>'file-import:'+input.goalId,handler:async(context,input)=>({result:await service.preview(context,input),changedRefs:[],editToken:null})});
  registry.register({name:'import.apply',inputSchema:importApplyInputSchema,outputSchema:importApplyResultSchema,capability:'uor.prepare',effect:'local',execution:'async',ownership:'person',resourceKey:input=>'file-preview:'+input.previewToken,handler:async(context,input)=>({result:await service.apply(context,input),changedRefs:[],editToken:null})});
}
