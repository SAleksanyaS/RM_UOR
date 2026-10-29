import path from 'node:path';
import { chmod, writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { draftFixture, draftCleanups, business } from '../../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeEntityGraph } from '../../../../tests/fixtures/workbench/factories';
import { createPackageArtifactStore } from './package-artifacts';
import { canonicalBytes, buildPackageManifest } from './package-manifest';
import { PublishingService, type PublishingDependencies } from './publishing-service';
import { registerPublishingCommands } from './register-commands';
import { packagePreviewResultSchema, type PackagePreviewResult, type VerifiedMain } from './contracts';
import { preparePackagePreview } from './package-preview';

afterEach(async () => { for (const cleanup of draftCleanups.splice(0)) await cleanup(); });
function fixture() {
  const f=draftFixture();
  let main:VerifiedMain={repositoryId:'synthetic-main',commit:'a'.repeat(40),files:new Map(makeEntityGraph(f.input).entries.map(({entityType,value})=>[`records/${entityType}/${value.id}/${value.revision}.json`,canonicalBytes(value)]))};
  let readHook:(()=>Promise<void>)|null=null; let serial=220000;
  const artifacts=createPackageArtifactStore({artifactRoot:path.join(f.root,'packages')});
  const deps:PublishingDependencies={repository:f.repository,clock:f.clock,drafts:f.service,artifacts,git:{async readMain(){ await readHook?.(); return main; }},accessPolicy:f.policy,jobs:f.jobs,jobSink:f.jobs,publication:{mode:'demo-only',classifyRecord:()=>true}};
  const service=new PublishingService(deps); registerPublishingCommands(f.registry,service);
  const command=async(commandId=fixtureId(serial++))=>{
    const accepted=await f.registry.execute({commandId,name:'package.preview',baseRevision:f.token(),payload:{packageId:f.packageId()}},{...f.context,commandId});
    if (!('jobId' in accepted)) throw Error('Expected async preview');
    await f.registry.idle(); return {accepted,job:f.jobs.get(accepted.jobId,f.context.installationId)!};
  };
  const preview=async()=>{const {job}=await command(); expect(job.error).toBeNull(); expect(job.status).toBe('succeeded'); return packagePreviewResultSchema.parse(job.result);};
  const editGoal=async(patch:Record<string,unknown>)=>{
    const opened=await f.open('core_goal_definition',{entityType:'core_goal_definition',id:f.input.goal.id});
    await f.execute('goal.draft.save',{draftId:opened.draftId,definition:{...business(f.input.goal),...patch}}); return opened;
  };
  const setGoalInMain=(patch:Record<string,unknown>)=>{
    const value={...f.input.goal,revision:2,...patch};
    main={...main,commit:'b'.repeat(40),files:new Map([...main.files,[`records/core_goal_definition/${value.id}/2.json`,canonicalBytes(value)]])};
  };
  const proposed=async(result:PackagePreviewResult)=>[...(await artifacts.readRevision(result.packageRevision))].filter(([name])=>name.startsWith(`records/core_goal_definition/${f.input.goal.id}/`)).map(([,bytes])=>JSON.parse(Buffer.from(bytes).toString())).sort((a,b)=>b.revision-a.revision)[0];
  return {...f,deps,publishing:service,artifacts,command,preview,editGoal,setGoalInMain,proposed,
    main:()=>main,setMain:(next:VerifiedMain)=>{main=next;},setReadHook:(hook:typeof readHook)=>{readHook=hook;}};
}
it.each([false,true])('blocks incompatible incoming assignment after merged goal/source mode change (population repaired: %s)',async repairPopulation=>{
  const f=fixture(); await f.editGoal({mode:'manual_status'});
  const source=makeEntityGraph(f.input).entries.find(e=>e.entityType==='source_definition')!.value;
  const opened=await f.open('source_definition',{entityType:'source_definition',id:source.id});
  await f.execute('source.draft.save',{draftId:opened.draftId,definition:{...business(source),kind:'manual_status',mappingRef:null}});
  if(repairPopulation) {
    const assignment={...f.input.assignment,revision:2,expectedPopulation:null};
    f.setMain({...f.main(),files:new Map([...f.main().files,[`records/goal_assignment/${assignment.id}/2.json`,canonicalBytes(assignment)]])});
  }
  const prepared=await preparePackagePreview(f.context,f.packageId(),f.main(),f.deps);
  expect(prepared.errors).toContainEqual(expect.objectContaining({code:repairPopulation?'METHOD_MODE_MISMATCH':'ASSIGNMENT_POPULATION_MISMATCH'}));
  expect(f.count('goal_assignment')).toBe(0);
});
it('preserves coherent numeric history while previewing commentary against current manual heads',async()=>{
  const f=fixture(); const comment=await f.open('commentary');
  await f.execute('comment.draft.save',{draftId:comment.draftId,targetRef:{entityType:'core_goal_definition',id:f.input.goal.id},text:'Согласованное уточнение'});
  const graph=makeEntityGraph(f.input); const source=graph.entries.find(e=>e.entityType==='source_definition')!.value;
  const {rules:_rules,formula:_formula,...methodHeader}=f.input.method as Extract<typeof f.input.method,{mode:'numeric'}>;
  const heads=[
    {type:'core_goal_definition',value:{...f.input.goal,revision:2,mode:'manual_status'}},
    {type:'source_definition',value:{...source,revision:2,kind:'manual_status',mappingRef:null}},
    {type:'method_version',value:{...methodHeader,revision:2,mode:'manual_status'}},
    {type:'goal_assignment',value:{...f.input.assignment,revision:2,expectedPopulation:null,methodBinding:{kind:'standalone',methodRef:{entityType:'method_version',id:f.input.method.id,revision:2}}}},
  ];
  const files=new Map(f.main().files);
  heads.forEach(({type,value})=>files.set(`records/${type}/${value.id}/2.json`,canonicalBytes(value)));
  f.setMain({...f.main(),files});
  const result=await f.preview(); expect(result.errors).toEqual([]);
  const stored=await f.artifacts.readRevision(result.packageRevision);
  expect([...stored.keys()].filter(name=>name.startsWith('records/commentary/'))).toHaveLength(1);
  // Exact old VersionRefs remain mandatory even when mutable EntityRef checks
  // cannot reconstruct a historical target from its current head.
  files.delete(`records/metric_definition/${f.input.metrics[0].id}/1.json`);
  f.setMain({...f.main(),files});
  const invalid=await f.command(); expect(invalid.job.error?.code).toBe('REFERENCE_NOT_FOUND');
});
it('rejects capsule records without their matching manifest',async()=>{
  const f=fixture(); await f.editGoal({description:'Проверка капсулы'});
  const files=new Map(f.main().files); const name=`records/core_goal_definition/${f.input.goal.id}/1.json`;
  files.delete(name); files.set(`published/workbench/packages/${fixtureId(229999)}/1/${name}`,canonicalBytes(f.input.goal));
  f.setMain({...f.main(),files});
  await expect(preparePackagePreview(f.context,f.packageId(),f.main(),f.deps)).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
});
it('previews through the actual async registry and reuses immutable revision bytes',async()=>{
  const f=fixture(); await f.editGoal({description:'Моё описание'});
  const first=await f.preview(); expect(first.errors).toEqual([]);
  const before=await f.artifacts.readRevision(first.packageRevision);
  f.setNow('2026-10-23T12:01:00Z'); const again=await f.preview();
  expect(again.packageRevision).toEqual(first.packageRevision); expect(await f.artifacts.readRevision(again.packageRevision)).toEqual(before);
  expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())?.state).toBe('preview_ready');
  expect(f.count('core_goal_definition')).toBe(0); expect(f.count('attestation')).toBe(0);
  expect(f.repository.readPublishedHead({entityType:'core_goal_definition',id:f.input.goal.id})).toEqual(f.input.goal);
});
it('combines independent fields and reports explicit same-field conflicts without altering a draft',async()=>{
  const f=fixture(); const opened=await f.editGoal({description:'Моё описание'}); f.setGoalInMain({title:'Название main'});
  const localRevision=f.service.readOwnEntry(f.context,opened.draftId).versionRef.revision;
  const merged=await f.preview(); expect(merged.errors).toEqual([]);
  expect(await f.proposed(merged)).toMatchObject({title:'Название main',description:'Моё описание',revision:Math.max(2,localRevision)+1});
  expect(f.service.readOwnEntry(f.context,opened.draftId).definition.title).toBe(f.input.goal.title);
  await f.execute('goal.draft.save',{draftId:opened.draftId,definition:{...business(f.input.goal),title:'Моё название'}});
  const conflict=await f.preview();
  expect(conflict.changes).toContainEqual(expect.objectContaining({field:'title',before:f.input.goal.title,main:'Название main',proposed:'Моё название',conflict:true}));
  expect(conflict.errors).toContainEqual(expect.objectContaining({code:'MERGE_CONFLICT'}));
  await expect(f.publishing.assertPreview(f.context,{packageId:f.packageId(),previewToken:conflict.previewToken})).rejects.toMatchObject({code:'PREVIEW_NOT_READY'});
});
it('invalidates old tokens after edits/main changes and keeps prior files intact',async()=>{
  const f=fixture(); const opened=await f.editGoal({description:'Первое'}); const first=await f.preview();
  await expect(f.publishing.assertPreview(f.context,{packageId:f.packageId(),previewToken:first.previewToken})).resolves.toMatchObject({packageRevision:first.packageRevision});
  const bytes=await f.artifacts.readRevision(first.packageRevision);
  await f.execute('goal.draft.save',{draftId:opened.draftId,definition:{...business(f.input.goal),description:'Второе'}});
  await expect(f.publishing.assertPreview(f.context,{packageId:f.packageId(),previewToken:first.previewToken})).rejects.toMatchObject({code:'PREVIEW_STALE'});
  const second=await f.preview(); expect(second.packageRevision.revision).toBe(first.packageRevision.revision+1);
  f.setGoalInMain({title:'Изменение main'});
  await expect(f.publishing.assertPreview(f.context,{packageId:f.packageId(),previewToken:second.previewToken})).rejects.toMatchObject({code:'PREVIEW_STALE'});
  expect(await f.artifacts.readRevision(first.packageRevision)).toEqual(bytes); expect(f.count('attestation')).toBe(0);
});
it('expires tokens at 30 minutes and never extends an issued token implicitly',async()=>{
  const f=fixture(); await f.editGoal({description:'Описание'}); const first=await f.preview();
  f.setNow('2026-10-23T12:29:59Z'); await expect(f.publishing.assertPreview(f.context,{packageId:f.packageId(),previewToken:first.previewToken})).resolves.toBeDefined();
  f.setNow('2026-10-23T12:30:00Z'); await expect(f.publishing.assertPreview(f.context,{packageId:f.packageId(),previewToken:first.previewToken})).rejects.toMatchObject({code:'PREVIEW_STALE'});
  const renewed=await f.preview(); expect(renewed.previewToken).not.toBe(first.previewToken); expect(renewed.packageRevision).toEqual(first.packageRevision);
  await expect(f.publishing.assertPreview(f.context,{packageId:f.packageId(),previewToken:first.previewToken})).rejects.toMatchObject({code:'PREVIEW_STALE'});
});
it('protects own packages and tokens from another person/installation and from viewers',async()=>{
  const f=fixture(); await f.editGoal({description:'Личное'}); const result=await f.preview();
  for(const foreign of [{...f.context,installationId:fixtureId(999)},{...f.context,ownAccess:{...f.context.ownAccess,personId:fixtureId(998)}}]) {
    expect(()=>f.publishing.readPort.readOwnPackage(foreign,f.packageId())).toThrow();
    await expect(f.publishing.assertPreview(foreign,{packageId:f.packageId(),previewToken:result.previewToken})).rejects.toMatchObject({statusCode:404});
  }
  f.context.ownAccess.role='viewer'; const commandId=fixtureId(220999);
  await expect(f.registry.execute({commandId,name:'package.preview',baseRevision:f.token(),payload:{packageId:f.packageId()}},{...f.context,commandId})).rejects.toMatchObject({statusCode:403});
});
it('rechecks draft revision and identity after awaiting main',async()=>{
  const f=fixture(); const opened=await f.editGoal({description:'До ожидания'}); let release!:()=>void; let entered!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;}); const waiting=new Promise<void>(r=>{release=r;});
  f.setReadHook(async()=>{entered(); await waiting;});
  const pending=f.command(); await ready;
  await f.execute('goal.draft.save',{draftId:opened.draftId,definition:{...business(f.input.goal),description:'После ожидания'}}); release();
  const {job}=await pending; expect(job.error?.code).toBe('PREVIEW_STALE');
  expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())).toBeNull();
});
it('does not commit after preparation access is revoked during main lookup',async()=>{
  const f=fixture(); await f.editGoal({description:'Описание'});
  f.setReadHook(async()=>{f.context.ownAccess.role='viewer';}); const {job}=await f.command();
  expect(job.status).toBe('failed'); expect(job.error?.code).toBe('COMMAND_FORBIDDEN');
  f.context.ownAccess.role='curator'; expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())).toBeNull();
});
it.each(['unknown-schema','secret-field','dangling-reference','registry-path'])('rejects unsafe main input %s without changing shared records',async kind=>{
  const f=fixture(); await f.editGoal({description:'Безопасно'}); const main=f.main(); const files=new Map(main.files);
  if(kind==='registry-path') files.set('config/registry.json',Buffer.from('{}'));
  else if(kind==='unknown-schema') files.set(`records/unknown/${fixtureId(900)}/1.json`,canonicalBytes({...f.input.goal,id:fixtureId(900)}));
  else { const value=kind==='secret-field'?{...f.input.goal,password:'never-export'}:{...f.input.goal,sourceId:fixtureId(901)}; files.set(`records/core_goal_definition/${value.id}/1.json`,canonicalBytes(value)); }
  f.setMain({...main,files}); const {job}=await f.command(); expect(job.status).toBe('failed');
  expect(f.count('core_goal_definition')).toBe(0); expect(f.service.readDraftPackage(f.packageId()).entries).toHaveLength(1);
});
it('keeps incomplete forms and returns blocking preview diagnostics',async()=>{
  const f=fixture(); const opened=await f.open('core_goal_definition'); await f.execute('goal.draft.save',{draftId:opened.draftId,definition:{title:'Незавершённая цель'}});
  const result=await f.preview(); expect(result.errors.length).toBeGreaterThan(0);
  expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())?.state).toBe('draft');
  expect(f.service.readOwnEntry(f.context,opened.draftId).definition).toEqual({title:'Незавершённая цель'});
});
it('recovers own package metadata and issued tokens from durable storage',async()=>{
  const f=fixture(); await f.editGoal({description:'Сохранённый пакет'}); const first=await f.preview();
  const reopened=new PublishingService(f.deps);
  expect(reopened.readPort.readOwnPackage(f.context,f.packageId())?.current).toEqual(first.packageRevision);
  await expect(reopened.assertPreview(f.context,{packageId:f.packageId(),previewToken:first.previewToken})).resolves.toMatchObject({packageRevision:first.packageRevision});
});
async function addEvidence(f:ReturnType<typeof fixture>) {
  const bytes=Buffer.from('Synthetic verified proof'); const draft=await f.open('evidence');
  const staged=await f.files.stage({installationId:f.context.installationId,profilePersonId:f.context.ownAccess.personId,purpose:'evidence',name:'proof.txt',mediaType:'text/plain',stream:(async function*(){yield bytes;})()});
  await f.execute('evidence.draft.save',{draftId:draft.draftId,kind:'file',fileHandle:staged.fileHandle});
  const file=f.store.getEntry(draft.draftId)!.definition.file as {artifactId:string;hash:string;bytes:number;mimeType:string};
  return {bytes,file};
}
it('allocates new immutable dependent versions when semantic merge remaps an exact reference',async()=>{
  const f=fixture();
  const method=await f.open('method_version',{entityType:'method_version',id:f.input.method.id});
  await f.execute('method.draft.save',{draftId:method.draftId,definition:{...business(f.input.method),formula:{kind:'weighted_mean_v1',scoreCondition:{op:'gte',target:'95'}}}});
  const methodRef=f.service.readOwnEntry(f.context,method.draftId).versionRef;
  const assignment=await f.open('goal_assignment',{entityType:'goal_assignment',id:f.input.assignment.id});
  await f.execute('assignment.draft.save',{draftId:assignment.draftId,definition:{...business(f.input.assignment),methodBinding:{kind:'standalone',methodRef}}});
  const original=structuredClone(f.service.readOwnEntry(f.context,assignment.draftId));
  const remote={...f.input.method,revision:2,rules:f.input.method.mode==='numeric'?f.input.method.rules.map(rule=>({...rule,originalWeight:'90'})):[]};
  f.setMain({...f.main(),commit:'b'.repeat(40),files:new Map([...f.main().files,[`records/method_version/${remote.id}/2.json`,canonicalBytes(remote)]])});
  const result=await f.preview(); expect(result.errors).toEqual([]);
  const values=[...(await f.artifacts.readRevision(result.packageRevision))].filter(([name])=>name.startsWith('records/')).map(([,bytes])=>JSON.parse(Buffer.from(bytes).toString()));
  const merged=values.find(value=>value.id===f.input.assignment.id);
  expect(merged.revision).toBeGreaterThan(original.versionRef.revision);
  expect(merged.methodBinding.methodRef.revision).toBeGreaterThan(methodRef.revision);
  expect(f.service.readOwnEntry(f.context,assignment.draftId)).toEqual(original);
});
it('rechecks the draft after an asynchronous artifact integrity read',async()=>{
  const f=fixture(); const opened=await f.editGoal({description:'До проверки'}); const first=await f.preview();
  let release!:()=>void; let entered!:()=>void; const ready=new Promise<void>(r=>{entered=r;}); const waiting=new Promise<void>(r=>{release=r;});
  f.deps.artifacts={...f.artifacts,async readRevision(ref){entered();await waiting;return f.artifacts.readRevision(ref);}};
  const pending=f.publishing.assertPreview(f.context,{packageId:f.packageId(),previewToken:first.previewToken}); await ready;
  await f.execute('goal.draft.save',{draftId:opened.draftId,definition:{...business(f.input.goal),description:'После проверки'}}); release();
  await expect(pending).rejects.toMatchObject({code:'PREVIEW_STALE'});
});
it('uses only selected, classified and verified evidence bytes',async()=>{
  const f=fixture(); const proof=await addEvidence(f);
  const blocked=await f.preview(); expect(blocked.errors).toContainEqual(expect.objectContaining({code:'EVIDENCE_CLASSIFICATION_REQUIRED'}));
  expect([...(await f.artifacts.readRevision(blocked.packageRevision)).keys()].some(name=>name.startsWith('artifacts/'))).toBe(false);
  f.deps.publication={mode:'internal',classifyRecord:()=>true,async classifyEvidence(_evidence,bytes){return Buffer.from(bytes).equals(proof.bytes);}};
  const allowed=await f.preview(); expect(allowed.errors).toEqual([]);
  const files=await f.artifacts.readRevision(allowed.packageRevision);
  expect(Buffer.from(files.get(`artifacts/${proof.file.hash.slice(7)}`)!)).toEqual(proof.bytes);
  expect([...files.keys()].some(name=>name.includes(proof.file.artifactId))).toBe(false);
});
it.each(['hash','size'])('rejects corrupted evidence %s before committing a usable preview',async kind=>{
  const f=fixture(); const proof=await addEvidence(f);
  f.deps.publication={mode:'internal',classifyRecord:()=>true,async classifyEvidence(){return true;}};
  const bytes=kind==='hash'?Buffer.alloc(proof.bytes.length,65):Buffer.from('Truncated');
  await chmod(path.join(f.store.artifactDirectory,proof.file.artifactId),0o600);
  await writeFile(path.join(f.store.artifactDirectory,proof.file.artifactId),bytes);
  const {job}=await f.command(); expect(job.error?.code).toBe('INTEGRITY_MISMATCH');
  expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())).toBeNull();
});
it('can read a verified main capsule containing selected binary evidence',async()=>{
  const f=fixture(); await addEvidence(f);
  f.deps.publication={mode:'internal',classifyRecord:()=>true,async classifyEvidence(){return true;}};
  const first=await f.preview(); const files=await f.artifacts.readRevision(first.packageRevision);
  const prefix=`published/workbench/packages/${first.packageRevision.packageId}/${first.packageRevision.revision}/`;
  const {contentHash,...base}=first.packageRevision; const manifest=buildPackageManifest({package:base,files});
  f.setMain({...f.main(),commit:'c'.repeat(40),files:new Map([...f.main().files,...[...files].map(([name,bytes])=>[prefix+name,bytes] as const),[prefix+'manifest.json',canonicalBytes(manifest)]])});
  const next=await f.preview(); expect(next.errors).toEqual([]);
});
it('does not bind an implicit reporting date when no saved calculation context exists',async()=>{
  const f=fixture(); await f.editGoal({description:'Определение без расчёта'}); const before=f.count('calculation_result');
  const result=await f.preview(); expect(result.errors).toEqual([]); expect(result.warnings).toContainEqual(expect.objectContaining({code:'NEEDS_CALCULATION'}));
  expect(f.count('calculation_result')).toBe(before);
});
it('keeps technical preview reservations outside the subject state revision',()=>{
  const f=fixture(); const sql=f.repository.sqlForModule('publishing',{trackStateRevision:false}); const before=f.repository.getStateRevision();
  sql.run('INSERT INTO wb_publishing_reservations(package_id,installation_id,person_id,revision,fingerprint,cycle_id,created_at) VALUES(?,?,?,?,?,?,?)',[fixtureId(221000),f.context.installationId,f.context.ownAccess.personId,1,'synthetic',fixtureId(221001),f.clock.now()]);
  expect(f.repository.getStateRevision()).toBe(before);
  expect(()=>sql.run('DELETE FROM wb_entity_versions')).toThrow();
});
it('binds tokens to actual fact revisions in saved calculation contexts without writing a new result',async()=>{
  const f=fixture(); const assignment=await f.open('goal_assignment',{entityType:'goal_assignment',id:f.input.assignment.id});
  const assignmentRef=f.service.readOwnEntry(f.context,assignment.draftId).versionRef;
  await f.execute('calculation.prepare',{assignmentRef,businessTime:f.input.context.businessTime});
  const first=await f.preview(); const saved=await f.artifacts.readRevision(first.packageRevision);
  const capture={...f.input.captures[0],id:fixtureId(222000),operationId:fixtureId(222001),actor:f.context.actor,publicationAnchorId:null,capturedAt:'2026-10-23T12:01:00Z',sourceUpdatedAt:'2026-10-23T12:01:00Z',payloadHash:`sha256:${'d'.repeat(64)}`,canonicalRows:f.input.captures[0].canonicalRows.map(row=>({...row,numbers:{demo_value:'93'}})),rawRows:f.input.captures[0].rawRows.map(row=>({...row,cells:{demo_value:{kind:'number' as const,original:'93'}}}))};
  const fact={...f.input.facts[0],revision:2,actor:f.context.actor,publicationAnchorId:null,recordedAt:'2026-10-23T12:01:00Z',captureId:capture.id,value:'93',sourceUpdatedAt:capture.sourceUpdatedAt,lineage:{...f.input.facts[0].lineage,captureId:capture.id}};
  f.repository.transaction(()=>{f.repository.append('capture',capture,null);f.repository.append('observed_fact',fact,1);}); f.setNow('2026-10-23T12:02:00Z');
  await expect(f.publishing.assertPreview(f.context,{packageId:f.packageId(),previewToken:first.previewToken})).rejects.toMatchObject({code:'PREVIEW_STALE'});
  const next=await f.preview(); expect(next.errors).toEqual([]); expect(next.packageRevision.revision).toBe(first.packageRevision.revision+1);
  expect(await f.artifacts.readRevision(first.packageRevision)).toEqual(saved);
  expect(f.service.readPackageBasisContexts(f.context,f.packageId())).toHaveLength(1); expect(f.count('attestation')).toBe(0); expect(f.count('observed_fact')).toBe(1);
});
it('exports the exact result and basis behind a digest-only attestation',async()=>{
  const f=fixture(); const ready=await f.prepare(); const draft=await f.open('attestation');
  await f.execute('result.confirm',{draftId:draft.draftId,resultRef:ready.resultRef,comment:'Synthetic review',evidenceIds:[]});
  const preview=await f.preview(); expect(preview.errors).toEqual([]);
  const files=await f.artifacts.readRevision(preview.packageRevision);
  expect(files.has(`records/evaluation_basis/${ready.basisRef.id}/${ready.basisRef.revision}.json`)).toBe(true);
  expect(files.has(`records/calculation_result/${ready.resultRef.id}/${ready.resultRef.revision}.json`)).toBe(true);
  expect(f.count('attestation')).toBe(0);
});
it('rejects a main capsule whose declared manifest no longer matches its bytes',async()=>{
  const f=fixture(); await f.editGoal({description:'Содержимое пакета'}); const first=await f.preview(); const files=await f.artifacts.readRevision(first.packageRevision);
  const prefix=`published/workbench/packages/${first.packageRevision.packageId}/${first.packageRevision.revision}/`; const {contentHash,...base}=first.packageRevision;
  const manifest=buildPackageManifest({package:base,files}); const changed=new Map([...files].map(([name,bytes])=>[prefix+name,bytes]));
  changed.set(prefix+'manifest.json',canonicalBytes({...manifest,files:manifest.files.map(file=>({...file,bytes:file.bytes+1}))}));
  f.setMain({...f.main(),commit:'d'.repeat(40),files:new Map([...f.main().files,...changed])});
  const {job}=await f.command(); expect(job.status).toBe('failed'); expect(job.error?.code).toBe('INTEGRITY_MISMATCH');
});
it('blocks an attestation when main changes its saved semantic basis and never replaces the saved result',async()=>{
  const f=fixture(); const ready=await f.prepare(); const draft=await f.open('attestation');
  await f.execute('result.confirm',{draftId:draft.draftId,resultRef:ready.resultRef,comment:'Exact basis review',evidenceIds:[]});
  const stored=structuredClone(f.repository.readVersion(ready.resultRef)); f.setGoalInMain({title:'Новая редакция определения'});
  const preview=await f.preview(); expect(preview.errors).toContainEqual(expect.objectContaining({code:'BASIS_MISMATCH'}));
  expect(f.repository.readVersion(ready.resultRef)).toEqual(stored); expect(f.count('attestation')).toBe(0);
});
it('cancels a waiting preview without replacing the previous ready package',async()=>{
  const f=fixture(); await f.editGoal({description:'Сохранённый предпросмотр'}); const first=await f.preview();
  let release!:()=>void; let entered!:()=>void; const ready=new Promise<void>(r=>{entered=r;}); const waiting=new Promise<void>(r=>{release=r;});
  f.setReadHook(async()=>{entered();await waiting;}); const commandId=fixtureId(222100);
  const accepted=await f.registry.execute({commandId,name:'package.preview',baseRevision:f.token(),payload:{packageId:f.packageId()}},{...f.context,commandId});
  if(!('jobId' in accepted)) throw Error('Expected async preview'); await ready;
  try {await f.execute('job.cancel',{jobId:accepted.jobId});} finally {release();} await f.registry.idle();
  expect(f.jobs.get(accepted.jobId,f.context.installationId)?.status).toBe('cancelled');
  expect(f.publishing.readPort.readOwnPackage(f.context,f.packageId())?.current).toEqual(first.packageRevision);
});
