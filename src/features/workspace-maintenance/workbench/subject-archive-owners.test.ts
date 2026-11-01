import { randomUUID } from 'node:crypto';
import { afterEach,expect,it } from 'vitest';
import { createWorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createDraftStore } from '../../catalog/workbench-draft-store';
import { createNotificationStore } from '../../execution/workbench-notification-store';
import { createSubjectArchiveOwners } from './subject-archive-owners';
import { makeEntityGraph } from '../../../../tests/fixtures/workbench/factories';
import { seedGraph } from '../../../../tests/fixtures/workbench/repository';
import { createWorkspaceOwnership } from '../../../server/storage/workbench-ownership';
import { isOwnCoreVersion } from '../../../server/storage/workbench-ownership';
import { draftFixture,draftCleanups,business } from '../../../../tests/fixtures/workbench/drafts';
import { archiveManifestSchema,type WorkspaceArchiveRecord } from './contracts';
const cleanup:Array<()=>void>=[];afterEach(async()=>{cleanup.splice(0).forEach(f=>f());for(const close of draftCleanups.splice(0))await close();});
function setup(personId:string=randomUUID(),installationId:string=randomUUID()) {const repository=createWorkbenchRepository({filename:':memory:',artifactRoot:process.env.TEMP!});cleanup.push(()=>repository.close());const environment={installationId,personId:()=>personId,localPreview:true,subjectRoot:()=>process.env.TEMP!};return{repository,environment,personId,installationId};}
it('has every subject owner and preserves noncurrent draft revisions and incomplete definitions on same-person transfer',()=>{
 const a=setup(),store=createDraftStore({repository:a.repository,artifactDirectory:process.env.TEMP!}),packageId=randomUUID(),draftId=randomUUID(),id=randomUUID(),actor={installationId:a.installationId,profilePersonId:a.personId,hostname:'synthetic'};
 store.createPackage({packageId,installationId:a.installationId,ownerPersonId:a.personId,baseCommit:null});
 store.add({draftId,packageId,entityRef:{entityType:'core_goal_definition',id},baseRef:null,definition:{},complete:false,problems:[],header:{schemaVersion:1,id,revision:1,recordedAt:'2026-10-28T10:00:00Z',actor,publicationAnchorId:null}});
 store.save(draftId,{title:'second'},false,[],actor,'2026-10-28T11:00:00Z');
 const owners=createSubjectArchiveOwners(a.repository,a.environment);expect(owners.map(o=>o.moduleId)).toEqual(['core','evaluation','drafts','execution','notifications','preferences','publishing','legacy_migration','ownership']);
 const codec=owners.find(o=>o.moduleId==='drafts')!,records=codec.exportRecords(a.repository);expect(records.filter(r=>r.schemaId==='drafts.revision')).toHaveLength(2);codec.authorize(records,a.personId,a.installationId);
 const b=setup(a.personId),target=createSubjectArchiveOwners(b.repository,b.environment).find(o=>o.moduleId==='drafts')!;target.restoreRecords(b.repository,records);expect(target.exportRecords(b.repository)).toEqual(records);
 const restored=createDraftStore({repository:b.repository,artifactDirectory:process.env.TEMP!});expect(restored.getPackage(packageId)?.installationId).toBe(b.installationId);expect(restored.history(draftId)[0].header.actor).toEqual(actor);
 expect(()=>codec.authorize(records,randomUUID(),a.installationId)).toThrow();
});
it('exports every notification event, occurrence and subscription and rematerializes technical owner keys',()=>{
 const a=setup(),store=createNotificationStore({repository:a.repository}),owner={installationId:a.installationId,profilePersonId:a.personId},goalId=randomUUID();
 for(let n=0;n<205;n++)store.record(owner,'event-'+n,{provider:'synthetic',objectRef:{entityType:'core_goal_definition',id:goalId},sourceVersion:'1',kind:'changed',recipientPersonIds:[a.personId],route:'/goals'},'new','2026-10-28T10:00:00Z');
 store.subscribe(owner,goalId,true);const readId=store.find(owner,'event-0')!.id;store.markRead(owner,[readId],'2026-10-28T11:00:00Z');store.record(owner,'event-1',{provider:'synthetic',objectRef:{entityType:'core_goal_definition',id:goalId},sourceVersion:'1',kind:'changed',recipientPersonIds:[a.personId],route:'/goals'},'reminder','2026-10-28T12:00:00Z');const codec=createSubjectArchiveOwners(a.repository,a.environment).find(o=>o.moduleId==='notifications')!,records=codec.exportRecords(a.repository);expect(records.filter(r=>r.schemaId==='notifications.event')).toHaveLength(205);expect(records.filter(r=>r.schemaId==='notifications.occurrence')).toHaveLength(206);expect((records.find(r=>r.schemaId==='notifications.event'&&(r.value as any).id===readId)!.value as any).readAt).toBe('2026-10-28T11:00:00Z');
 const b=setup(a.personId),target=createSubjectArchiveOwners(b.repository,b.environment).find(o=>o.moduleId==='notifications')!;target.restoreRecords(b.repository,records);expect(target.exportRecords(b.repository)).toEqual(records);expect(createNotificationStore({repository:b.repository}).isSubscribed({installationId:b.installationId,profilePersonId:b.personId},goalId)).toBe(true);
});
it('rejects unknown proofs and preferences with no trusted binding instead of omitting rows',()=>{
 const a=setup(),owners=createSubjectArchiveOwners(a.repository,a.environment),proof=owners.find(o=>o.moduleId==='drafts')!;
 expect(()=>proof.validate({moduleId:'drafts',schemaId:'drafts.proof',schemaVersion:1,key:'bad',value:{draftId:randomUUID(),kind:'unknown',value:{}}})).toThrow();
 a.repository.sqlForModule('preferences').run('INSERT INTO wb_preferences_personal VALUES(?,1,?,?)',[randomUUID(),JSON.stringify({context:null,sorts:{},visual:{theme:'system',density:'comfortable'}}),'2026-10-28T10:00:00Z']);
 expect(()=>owners.find(o=>o.moduleId==='preferences')!.exportRecords(a.repository)).toThrow();
});
it('authorizes incoming private core from complete portable bindings and preserves immutable actors after transfer',()=>{
 const a=setup(),graph=makeEntityGraph();seedGraph(a.repository,graph);const fact=graph.input.facts[0];
 a.repository.append('observed_fact',{...fact,revision:2,publicationAnchorId:null},1);
 const key=`observed_fact/${fact.id}/2`;createWorkspaceOwnership(a.repository).bind({moduleId:'core',key,installationId:a.installationId,personId:a.personId,provenance:'created'});
 const codec=createSubjectArchiveOwners(a.repository,a.environment).find(o=>o.moduleId==='core')!,records=codec.exportRecords(a.repository),b=setup(a.personId),target=createSubjectArchiveOwners(b.repository,b.environment).find(o=>o.moduleId==='core')!;
 target.authorize(records,b.personId,b.installationId);target.restoreRecords(b.repository,records,{installationId:b.installationId,personId:b.personId,stagedRoot:process.env.TEMP!,files:new Map(),subjectPath:()=>{throw Error('No files');}});
 expect(target.exportRecords(b.repository)).toEqual(records);expect(b.repository.readVersion({entityType:'observed_fact',id:fact.id,revision:2})?.actor).toEqual(fact.actor);
 expect(isOwnCoreVersion(b.repository,'observed_fact',b.repository.readVersion({entityType:'observed_fact',id:fact.id,revision:2})!,{installationId:b.installationId,personId:b.personId})).toBe(true);
 expect(()=>target.authorize(records.filter(r=>r.schemaId!=='core.ownership'),b.personId,b.installationId)).toThrow();
 expect(()=>target.authorize(records,randomUUID(),b.installationId)).toThrow();
});
it('roundtrips actual numeric example, confirmation/snapshot proof and frozen closure without recomputation',async()=>{
 const f=draftFixture(),environment={installationId:f.context.installationId,personId:()=>f.context.ownAccess.personId,localPreview:true,subjectRoot:()=>f.root},owners=createSubjectArchiveOwners(f.repository,environment);
 const ready=await f.prepare(),attestation=await f.open('attestation');await f.execute('result.confirm',{draftId:attestation.draftId,resultRef:ready.resultRef,comment:'Synthetic reviewed',evidenceIds:[]});
 const snapshot=await f.open('agreed_snapshot');await f.execute('snapshot.save',{draftId:snapshot.draftId,...ready,manualStatusRef:null,attestationRef:f.store.getEntry(attestation.draftId)!.versionRef});
 const records=owners.flatMap(o=>o.exportRecords(f.repository));expect(records.some(r=>r.schemaId==='evaluation.digest')).toBe(true);expect(records.filter(r=>r.schemaId==='drafts.proof').map(r=>(r.value as any).kind).sort()).toEqual(['result-confirmation','snapshot']);
 validateOwners(owners,records);const b=setup(f.context.ownAccess.personId!),target=createSubjectArchiveOwners(b.repository,b.environment),context={installationId:b.installationId,personId:b.personId,files:new Map(),stagedRoot:process.env.TEMP!,subjectPath:()=>{throw Error('No bytes');}};
 for(const o of target){const own=records.filter(r=>r.moduleId===o.moduleId);o.authorize(own,b.personId,b.installationId);o.restoreRecords(b.repository,own,context);}
 expect(target.flatMap(o=>o.exportRecords(b.repository))).toEqual(records);expect(b.repository.readVersion(ready.resultRef)).toEqual(f.repository.readVersion(ready.resultRef));
 const broken=records.filter(r=>!(r.moduleId==='core'&&r.key===`${ready.resultRef.entityType}/${ready.resultRef.id}/${ready.resultRef.revision}`));expect(()=>validateOwners(target,broken)).toThrow();
});
it('retains complete and pending manual transitions plus historical standalone association',async()=>{
 const f=draftFixture(),environment={installationId:f.context.installationId,personId:()=>f.context.ownAccess.personId,localPreview:true,subjectRoot:()=>f.root},owners=createSubjectArchiveOwners(f.repository,environment);
 const goal=await f.open('core_goal_definition'),source=await f.open('source_definition'),method=await f.open('method_version'),assignment=await f.open('goal_assignment');
 await f.execute('goal.draft.save',{draftId:goal.draftId,definition:{...business(f.input.goal),mode:'manual_status',sourceId:source.objectId}});await f.execute('source.draft.save',{draftId:source.draftId,definition:{goalId:goal.objectId,kind:'manual_status',mappingRef:null,publicLocator:null}});await f.execute('method.draft.save',{draftId:method.draftId,definition:{mode:'manual_status'}});await f.execute('assignment.draft.save',{draftId:assignment.draftId,definition:{goalId:goal.objectId,scope:f.input.assignment.scope,methodBinding:{kind:'standalone',methodRef:{...method.entityRef,revision:1}},officialDueOn:null,expectedPopulation:null}});
 await f.execute('calculation.prepare',{assignmentRef:{...assignment.entityRef,revision:1},businessTime:f.input.context.businessTime});
 const complete=await f.open('manual_status_event'),result=await f.execute('manualGoal.transition',{draftId:complete.draftId,ref:{...assignment.entityRef,revision:1},targetState:'completed',reason:null,resultDescription:'Synthetic complete'});
 await f.execute('manualGoal.prepareTransition',{packageId:f.packageId(),draftId:null,ref:(result.result as any).versionRef,targetState:'in_progress',reason:'Synthetic followup',resultDescription:null});
 const records=owners.flatMap(o=>o.exportRecords(f.repository));validateOwners(owners,records);const proofKinds=records.filter(r=>r.schemaId==='drafts.proof').map(r=>(r.value as any).kind);expect(proofKinds).toContain('pending-transition');expect(proofKinds).toContain('manual-transition:1');
 const b=setup(f.context.ownAccess.personId!),target=createSubjectArchiveOwners(b.repository,b.environment),context={installationId:b.installationId,personId:b.personId,files:new Map(),stagedRoot:process.env.TEMP!,subjectPath:()=>{throw Error('No bytes');}};for(const o of target)o.restoreRecords(b.repository,records.filter(r=>r.moduleId===o.moduleId),context);expect(target.flatMap(o=>o.exportRecords(b.repository))).toEqual(records);expect(createDraftStore({repository:b.repository,artifactDirectory:process.env.TEMP!}).history(assignment.draftId)).toEqual(f.store.history(assignment.draftId));
});
function validateOwners(owners:ReturnType<typeof createSubjectArchiveOwners>,records:WorkspaceArchiveRecord[]){const archive={records,files:new Map(),manifest:archiveManifestSchema.parse({format:'uor-workspace-v1',version:1,applicationVersion:'0.5.0',storageSchemaVersion:1,createdAt:'2026-10-28T10:00:00Z',actor:{hostname:'synthetic',installationId:randomUUID(),profilePersonId:null},recordsSha256:'a'.repeat(64),files:[],exclusions:[]})};for(const o of owners)o.validateArchive?.(archive);}
