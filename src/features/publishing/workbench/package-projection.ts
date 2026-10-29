import type { WorkbenchEntity, WorkbenchEntityType, GoalAssignment, CoreGoalDefinition, MethodVersion, Template, EvaluationBasis, CalculationResult, DirectoryEntity, DirectoryLink, Work, WorkDependency, Decision, Evidence, EvaluationInput } from '../../../domain/workbench/entities';
import type { EntityRef, Header, VersionRef } from '../../../domain/workbench/primitives';
import { entityReferences, schemaForEntity, validateReferences } from '../../../domain/workbench/schemas';
import { WorkbenchError } from '../../../domain/workbench/errors';
import type { CommandContext } from '../../../server/workbench/command-registry';
import { WorkbenchHttpError, type Problem } from '../../../server/workbench/protocol';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import type { DraftService } from '../../catalog/workbench-drafts';
import { businessDefinition } from '../../catalog/workbench-drafts';
import { inspectMerge } from '../merge-object';
import { validateGraph, validateWorkChange } from '../../execution/workbench-execution';
import { validateDirectoryChanges } from '../../catalog/workbench-directory';
import { resolveEvaluationInput } from '../../evaluation/workbench/resolve-input';
import { canonicalBasis, digestBasis } from '../../evaluation/workbench/basis';
import { evaluateAssignment } from '../../evaluation/workbench/evaluate';
import { buildPackageManifest, canonicalBytes, hashBytes, integrity, validatePortablePaths } from './package-manifest';
import { gitOidSchema, packageManifestSchema, type PackageChange, type VerifiedMain } from './contracts';

export const objectKey=(ref:EntityRef)=>`${ref.entityType}/${ref.id}`;
export const versionKey=(ref:VersionRef)=>`${objectKey(ref)}/${ref.revision}`;
export const problem=(code:string,details:Problem['details']=[]):Problem=>({code,message:code,retryable:false,details,operationId:null,provider:null});
export const fail=(code:string,status=422):never=>{throw new WorkbenchHttpError(status,code,code);};
type TypedValue={type:string;value:WorkbenchEntity};
const headerRef=(type:string,value:Header):VersionRef=>({entityType:type,id:value.id,revision:value.revision});
export function readMainProjection(main:VerifiedMain) {
  gitOidSchema.parse(main.commit); if(!main.repositoryId.trim()) return integrity();
  validatePortablePaths([...main.files.keys()]);
  // A capsule is an integrity boundary even when its manifest is missing.
  // Direct records remain the explicit synthetic/provider input format.
  for(const name of main.files.keys()) {
    const prefix=/^(published\/workbench\/packages\/[a-f0-9-]{36}\/[1-9][0-9]*\/)/.exec(name)?.[1];
    if(prefix && !main.files.has(prefix+'manifest.json')) return integrity();
  }
  const versions=new Map<string,TypedValue>(); const heads=new Map<string,TypedValue>();
  const artifacts:Array<{prefix:string;hash:string;bytes:Uint8Array}>=[];
  for(const [name,bytes] of main.files) {
    const capsule=/^(published\/workbench\/packages\/([a-f0-9-]{36})\/([1-9][0-9]*)\/)manifest\.json$/.exec(name);
    if(capsule) {
      const manifest=packageManifestSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
      if(manifest.packageRevision.packageId!==capsule[2] || manifest.packageRevision.revision!==Number(capsule[3])) return integrity();
      const files=new Map([...main.files].filter(([file])=>file.startsWith(capsule[1]) && file!==name).map(([file,data])=>[file.slice(capsule[1].length),data]));
      const {contentHash,...base}=manifest.packageRevision; const actual=buildPackageManifest({package:base,files});
      if(actual.packageRevision.contentHash!==contentHash || hashBytes(canonicalBytes(actual.files))!==hashBytes(canonicalBytes(manifest.files))) return integrity();
      continue;
    }
    const binary=/^(published\/workbench\/packages\/[a-f0-9-]{36}\/[1-9][0-9]*\/)?artifacts\/([a-f0-9]{64})$/.exec(name);
    if(binary) {if(hashBytes(bytes)!==binary[2] || bytes.length>32*1024*1024) return integrity();artifacts.push({prefix:binary[1]??'',hash:binary[2],bytes});continue;}
    const match=/^(?:published\/workbench\/packages\/[a-f0-9-]{36}\/[1-9][0-9]*\/)?records\/([a-z][a-z0-9_]*)\/([a-f0-9-]{36})\/([1-9][0-9]*)\.json$/.exec(name);
    if(!match) return integrity();
    const [,type,id,revision]=match;
    let value:WorkbenchEntity;
    try { value=schemaForEntity(type).parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))) as WorkbenchEntity; }
    catch(error) { if(error instanceof WorkbenchError && error.code==='UNKNOWN_ENTITY_TYPE') return fail('SCHEMA_UNSUPPORTED'); return integrity(); }
    if(value.id!==id || value.revision!==Number(revision)) return integrity();
    const key=versionKey(headerRef(type,value)); const old=versions.get(key);
    if(old && hashBytes(canonicalBytes(old.value))!==hashBytes(canonicalBytes(value))) return integrity();
    versions.set(key,{type,value});
    if((heads.get(objectKey({entityType:type,id}))?.value.revision??0)<value.revision) heads.set(objectKey({entityType:type,id}),{type,value});
  }
  for(const artifact of artifacts) {
    const paired=[...main.files].filter(([name])=>name.startsWith(artifact.prefix+'records/evidence/')).some(([,bytes])=>{
      const evidence=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Evidence;
      return evidence.kind==='file' && evidence.file.hash==='sha256:'+artifact.hash && evidence.file.bytes===artifact.bytes.length && ['text/plain','application/pdf','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(evidence.file.mimeType);
    });
    if(!paired) return integrity();
  }
  return {versions,heads};
}
export type PackageProjection=ReturnType<typeof buildPackageProjection>;
/** Pure, in-memory semantic merge and reference closure. It never rewrites a draft. */
export function buildPackageProjection(context:CommandContext,packageId:string,drafts:DraftService,main:VerifiedMain) {
  const pkg=drafts.readOwnPackage(context,packageId); const mainData=readMainProjection(main);
  const errors=drafts.validateDraftPackage(packageId,{allowRebase:true}).problems.map(p=>problem(p.code,[p]));
  const frozen=drafts.readDraftVersions(packageId); const ownVersions=new Map(frozen.map(v=>[versionKey(headerRef(v.entityRef.entityType,v.value)),{type:v.entityRef.entityType,value:v.value as WorkbenchEntity}]));
  const roots=new Map<string,TypedValue>(); const changes:PackageChange[]=[];
  const remap=new Map<string,VersionRef>();
  const originalRefs=new Map<string,VersionRef>(); const promoted=new Set<string>();
  for(const entry of pkg.entries) {
    const type=entry.entityRef.entityType; const parsed=schemaForEntity(type).safeParse({...entry.header,...entry.definition});
    if(!parsed.success) continue;
    const proposed=parsed.data as WorkbenchEntity; const current=mainData.heads.get(objectKey(entry.entityRef))?.value??null;
    const before=entry.baseRef?context.repository.readVersion<WorkbenchEntity>(entry.baseRef):null;
    if(entry.baseRef && !before) {errors.push(problem('PREVIEW_BASE_MISSING'));continue;}
    const original=businessDefinition(before??{}); const mine=businessDefinition(proposed); const theirs=businessDefinition(current??{});
    const merged=inspectMerge(original,mine,current?theirs:original);
    for(const field of new Set([...Object.keys(original),...Object.keys(mine),...Object.keys(theirs)])) {
      const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
      if(equal(original[field],mine[field]) && equal(original[field],theirs[field])) continue;
      changes.push({objectRef:entry.entityRef,field,before:original[field]??null,main:theirs[field]??null,proposed:mine[field]??null,conflict:merged.conflicts.some(c=>c.path===`/${field}` || c.path.startsWith(`/${field}/`))});
    }
    if(merged.conflicts.length) errors.push(problem('MERGE_CONFLICT',merged.conflicts.map(c=>({path:c.path==='$'?'':c.path,code:'MERGE_CONFLICT',message:'Выберите значение поля явно',ref:entry.entityRef}))));
    const changed=hashBytes(canonicalBytes(merged.value))!==hashBytes(canonicalBytes(mine));
    const revision=current && (changed || current.revision>=proposed.revision)?Math.max(current.revision,proposed.revision)+1:proposed.revision;
    const value={...proposed,...merged.value,revision} as WorkbenchEntity;
    if(revision!==proposed.revision) remap.set(versionKey(headerRef(type,proposed)),headerRef(type,value));
    const key=objectKey(entry.entityRef); originalRefs.set(key,headerRef(type,proposed)); if(revision!==proposed.revision) promoted.add(key);
    roots.set(key,{type,value});
  }
  // Repoint only live definition references. Historical basis/result records retain
  // exact saved versions and must pass their own basis compatibility checks.
  const rewrite=(value:unknown):unknown=>{
    if(Array.isArray(value)) return value.map(rewrite);
    if(value && typeof value==='object') {
      const record=value as Record<string,unknown>;
      if(Object.keys(record).length===3 && typeof record.entityType==='string' && typeof record.id==='string' && typeof record.revision==='number') return remap.get(versionKey(record as VersionRef))??record;
      return Object.fromEntries(Object.entries(record).map(([key,item])=>[key,rewrite(item)]));
    }
    return value;
  };
  const originalRoots=new Map(roots);
  for(let pass=0;pass<=roots.size;pass++) {
    let allocated=false;
    for(const [key,entry] of originalRoots) if(!['evaluation_basis','calculation_result','agreed_snapshot','attestation'].includes(entry.type)) {
      const rewritten=rewrite(entry.value) as WorkbenchEntity; let revision=roots.get(key)!.value.revision;
      if(hashBytes(canonicalBytes(rewritten))!==hashBytes(canonicalBytes(entry.value)) && !promoted.has(key)) {
        revision=Math.max(revision,mainData.heads.get(key)?.value.revision??0)+1; promoted.add(key); allocated=true;
        remap.set(versionKey(originalRefs.get(key)!),{entityType:entry.type,id:entry.value.id,revision});
      }
      roots.set(key,{...entry,value:{...rewritten,revision} as WorkbenchEntity});
    }
    if(!allocated) break;
    if(pass===roots.size) return fail('REFERENCE_CYCLE');
  }
  const ownCore=(ref:EntityRef|VersionRef):WorkbenchEntity|null=>{
    const value='revision' in ref?context.repository.readVersion<WorkbenchEntity>(ref):context.repository.readPublishedHead<WorkbenchEntity>(ref);
    if(!value) return null;
    const published=value.publicationAnchorId && context.repository.readPublicationAnchor({entityType:'publication_anchor',id:value.publicationAnchorId})?.publicationState==='confirmed';
    return published || value.actor.installationId===context.installationId && value.actor.profilePersonId===context.ownAccess.personId ? value:null;
  };
  const read=(ref:EntityRef|VersionRef):WorkbenchEntity|null=>{
    const current=roots.get(objectKey(ref)); if(current && (!('revision' in ref)||current.value.revision===ref.revision)) return current.value;
    if('revision' in ref) {
      const privateVersion=ownVersions.get(versionKey(ref)); const publishedVersion=mainData.versions.get(versionKey(ref));
      if(privateVersion && publishedVersion && hashBytes(canonicalBytes(businessDefinition(privateVersion.value)))!==hashBytes(canonicalBytes(businessDefinition(publishedVersion.value)))) return fail('REFERENCE_VERSION_COLLISION');
      if(publishedVersion) return publishedVersion.value;
      if(privateVersion) return privateVersion.value;
      try { return drafts.readPreparedForPackage(packageId,ref) as WorkbenchEntity; } catch(error) { if(!(error instanceof WorkbenchHttpError) || error.code!=='REFERENCE_NOT_FOUND') throw error; }
    } else { const publicHead=mainData.heads.get(objectKey(ref)); if(publicHead) return publicHead.value; }
    return ownCore(ref);
  };
  // Historical EntityRefs do not contain a target revision. Check their identity,
  // type and existence without applying today's mutable target semantics to old
  // bytes. Exact VersionRefs still validate their precise historical target.
  const requirements=(entry:TypedValue,current:boolean)=>entityReferences(entry.type as WorkbenchEntityType,entry.value)
    .filter(r=>r.ref.entityType!=='publication_anchor')
    .map(r=>current || 'revision' in r.ref?r:{...r,validateTarget:undefined});
  for(const entry of mainData.versions.values()) validateReferences(requirements(entry,false),ref=>'revision' in ref?mainData.versions.get(versionKey(ref))?.value??null:mainData.heads.get(objectKey(ref))?.value??null);
  const combined=new Map([...mainData.heads,...roots]);
  const exported=new Map<string,TypedValue>(); const checked=new Set<string>();
  const visit=(ref:EntityRef|VersionRef):WorkbenchEntity=>{
    const value=read(ref); if(!value) return fail('REFERENCE_NOT_FOUND');
    if(value.id!==ref.id || 'revision' in ref && value.revision!==ref.revision) return fail('REFERENCE_VERSION_MISMATCH');
    const key=versionKey(headerRef(ref.entityType,value)); if(checked.has(key)) return value; checked.add(key);
    const root=roots.get(objectKey(ref)); const isOwn=root?.value===value || !mainData.versions.has(key) && (ownVersions.has(key) || value.publicationAnchorId===null);
    if(isOwn) exported.set(key,{type:ref.entityType,value});
    const current=combined.get(objectKey(ref))?.value.revision===value.revision;
    validateReferences(requirements({type:ref.entityType,value},current),visit);
    if(isOwn && current) drafts.validateMaterializedForPackage(context,packageId,ref.entityType,value,visit,mainData.heads.get(objectKey(ref))?.value??null);
    return value;
  };
  for(const entry of roots.values()) {try{visit(headerRef(entry.type,entry.value));}catch(error){errors.push(problem((error as {code?:string}).code??'VALIDATION_FAILED'));}}
  for(const ref of drafts.readPackageProofReferences(context,packageId)) {try{visit(ref);}catch(error){errors.push(problem((error as {code?:string}).code??'VALIDATION_FAILED'));}}
  // Incoming references can become incompatible without their owners being in
  // the draft. Validate the complete current graph before any calculation exists.
  try {
    const values=<T>(type:string)=>[...combined.values()].filter(v=>v.type===type).map(v=>v.value as T);
    for(const entry of combined.values()) validateReferences(requirements(entry,true),read);
    for(const assignment of values<GoalAssignment>('goal_assignment')) {
      const goal=read({entityType:'core_goal_definition',id:assignment.goalId}) as CoreGoalDefinition;
      const binding=assignment.methodBinding;
      const methodRef=binding.kind==='standalone'?binding.methodRef:(read({entityType:'template',id:binding.templateId}) as Template).methodRef;
      if((read(methodRef) as MethodVersion).mode!==goal.mode) fail('METHOD_MODE_MISMATCH');
    }
    validateGraph({works:values<Work>('work'),dependencies:values<WorkDependency>('work_dependency'),decisions:values<Decision>('decision')});
    for(const entry of roots.values()) if(entry.type==='work') validateWorkChange(mainData.heads.get(objectKey(headerRef(entry.type,entry.value)))?.value as Work|null??null,entry.value as Work);
    if([...roots.values()].some(v=>['directory_entity','directory_link'].includes(v.type))) errors.push(...validateDirectoryChanges({entities:values<DirectoryEntity>('directory_entity'),links:values<DirectoryLink>('directory_link')}).map(p=>problem(p.code,[p])));
  } catch(error) {errors.push(problem((error as {code?:string}).code??'VALIDATION_FAILED'));}
  // Re-evaluate without persisting/materializing a new basis/result. The chosen
  // input refs also invalidate tokens after facts change with an unchanged form.
  const basisDigests:string[]=[];
  const evaluationRepository:WorkbenchRepository={...context.repository,
    readPublishedHead:ref=>read(ref) as never,readVersion:ref=>read(ref) as never,
    readEvaluationCandidates(query) {
      const existing=context.repository.readEvaluationCandidates(query);
      const merged=<T extends Header>(type:string,prior:T[]):T[]=>{
        const values=new Map(prior.map(v=>[v.id,v]));
        for(const item of [...mainData.heads.values(),...roots.values()]) if(item.type===type && (values.get(item.value.id)?.revision??0)<=item.value.revision) values.set(item.value.id,schemaForEntity(type).parse(item.value) as T);
        return [...values.values()];
      };
      return {facts:merged('observed_fact',existing.facts),captures:merged('capture',existing.captures),applicability:merged('applicability',existing.applicability),corrections:merged('manual_correction',existing.corrections)};
    },
  };
  const contexts=new Map<string,EvaluationBasis>();
  for(const basis of [...drafts.readPackageBasisContexts(context,packageId),...[...exported.values()].filter(v=>v.type==='evaluation_basis').map(v=>v.value as EvaluationBasis)]) contexts.set(JSON.stringify([basis.assignmentRef.id,basis.businessTime]),basis);
  // The package command carries no business-time selection. Reuse explicit saved
  // calculation contexts; never invent a reporting period or calculate "today".
  for(const basis of contexts.values()) {
    try {
      const assignment=read({entityType:'goal_assignment',id:basis.assignmentRef.id}) as GoalAssignment|null;
      if(!assignment) return fail('REFERENCE_NOT_FOUND');
      const input=resolveEvaluationInput({assignmentRef:headerRef('goal_assignment',assignment),businessTime:basis.businessTime},evaluationRepository,context.clock,context.actor,{read,accepts:()=>true});
      const digest=digestBasis(canonicalBasis(input)); basisDigests.push(digest);
      if(input.goal.mode==='numeric') {const result=evaluateAssignment(input); if(result.calculation==='blocked') errors.push(problem('EVALUATION_BLOCKED'));}
    } catch(error) {errors.push(problem((error as {code?:string}).code??'EVALUATION_BLOCKED'));}
  }
  for(const item of exported.values()) if(item.type==='evaluation_basis') {
    const basis=item.value as EvaluationBasis;
    try {
      const input=resolveEvaluationInput({assignmentRef:basis.assignmentRef,businessTime:basis.businessTime},evaluationRepository,context.clock,context.actor,{read,accepts:()=>true});
      if(digestBasis(canonicalBasis(input))!==basis.digest) errors.push(problem('BASIS_MISMATCH'));
      // Pure recomputation is a check, never a replacement of saved result bytes.
      for(const result of exported.values()) if(result.type==='calculation_result' && (result.value as CalculationResult).basisRef.id===basis.id) {
        const actual=evaluateAssignment({...input,resolution:{...input.resolution,basisRef:(result.value as CalculationResult).basisRef}});
        if(hashBytes(canonicalBytes(businessDefinition(result.value)))!==hashBytes(canonicalBytes(actual))) errors.push(problem('RESULT_MISMATCH'));
      }
    } catch(error) {errors.push(problem((error as {code?:string}).code??'BASIS_MISMATCH'));}
  }
  return {draftRevision:pkg.revision,roots,exported,changes,errors,basisDigests:basisDigests.sort(),read,mainData};
}
