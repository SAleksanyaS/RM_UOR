import { afterEach, expect, it } from 'vitest';
import { createPreferencesService } from './workbench-preferences';
import { registerConfigurationCommands } from '../knowledge/workbench-fields';
import { draftFixture, draftCleanups } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';

afterEach(async () => { for (const cleanup of draftCleanups.splice(0)) await cleanup(); });
function fixture() { const f = draftFixture(); const preferences = createPreferencesService({repository:f.repository,installationId:f.context.installationId,clock:f.clock}); registerConfigurationCommands(f.registry,{drafts:f.service,preferences}); return {...f,preferences}; }
it('lets viewers persist only personal preferences with CAS and durable receipts', async () => {
  const f = fixture(); f.context.ownAccess.role = 'viewer';
  const values = {...f.preferences.get(f.context.installationId),visual:{theme:'dark',density:'compact',sidebar:'expanded'},sorts:{'goals.list':[{field:'title',direction:'asc'}]}};
  const id = fixtureId(99001);
  const saved = await f.execute('preferences.set',{values},{commandId:id,baseRevision:null});
  expect(f.preferences.get(f.context.installationId)).toEqual(values);
  expect(f.context.ownAccess.role).toBe('viewer'); expect(saved.changedRefs).toEqual([]);
  await expect(f.execute('preferences.set',{values},{commandId:fixtureId(99002),baseRevision:null})).rejects.toMatchObject({statusCode:409});
  expect(await f.execute('preferences.set',{values},{commandId:id,baseRevision:null})).toEqual(saved);
  expect(createPreferencesService({repository:f.repository,installationId:f.context.installationId,clock:f.clock}).get(f.context.installationId)).toEqual(values);
  expect(f.repository.readPublishedHead({entityType:'method_version',id:f.input.method.id})).toEqual(f.input.method);
  f.repository.append('metric_definition',{...f.input.metrics[0],revision:2,name:'Обновлённое название'},1);
  expect(f.preferences.get(f.context.installationId)).toEqual(values);
  expect(() => f.preferences.get(fixtureId(999))).toThrow();
});
it('does not expose one person preferences or edit token to another person on the same installation',async()=>{
 const f=fixture(),values=f.preferences.get(f.context.installationId);await f.execute('preferences.set',{values},{baseRevision:null});
 expect(()=>f.preferences.get(f.context.installationId,fixtureId(777))).toThrow();expect(()=>f.preferences.editToken(f.context.installationId,fixtureId(777))).toThrow();expect(f.preferences.get(f.context.installationId,f.context.ownAccess.personId)).toEqual(values);
});
it.each([{role:'chief'},{registry:{role:'chief'}},{sorts:{'goals.list':[{field:'sql',direction:'asc'}]}},{notificationPersonId:fixtureId(101)}])('rejects policy keys, unknown sorts or a non-person recipient %j', async patch => {
  const f = fixture(); await expect(f.execute('preferences.set',{values:{...f.preferences.get(f.context.installationId),...patch}},{baseRevision:null})).rejects.toMatchObject({statusCode:422});
});
it('rejects a structurally plausible scope path with a wrong entity kind', async () => {
  const f = fixture(); const values = {...f.preferences.get(f.context.installationId),context:{scopePath:{ditId:fixtureId(101),clusterId:null,productId:null,teamId:null},goalId:null,time:{kind:'as_of',date:'2026-10-29'},resultMode:'current',snapshotId:null}};
  await expect(f.execute('preferences.set',{values},{baseRevision:null})).rejects.toMatchObject({statusCode:422});
});
it('backs up preferences without registry or identity state', async () => {
  const f = fixture(); const values = f.preferences.get(f.context.installationId);
  await f.execute('preferences.set',{values},{baseRevision:null});
  const backup = f.preferences.backup.exportSnapshot();
  expect(JSON.stringify(backup)).not.toMatch(/hostname|policyState|registry|csrf/i);
  expect(() => f.preferences.backup.validateRestore({...backup,role:'chief'})).toThrow();
  expect(f.preferences.backup.describeOwnedData()).toEqual({namespaces:['preferences.personal']});
  f.preferences.backup.restore(backup);
  expect(f.preferences.get(f.context.installationId)).toEqual(values);
});
it('validates published topology rather than accepting unrelated valid scope IDs', async () => {
  const f = fixture(); const h = (seed:number) => makeHeader(seed,{publicationAnchorId:fixtureId(2)});
  const ref = (seed:number) => ({entityType:'directory_entity',id:fixtureId(seed)});
  f.repository.transaction(() => {
    f.repository.append('directory_entity',{...h(920),kind:'dit',name:'ДИТ',externalKeys:[]},null);
    f.repository.append('directory_entity',{...h(921),kind:'cluster',name:'Кластер',externalKeys:[]},null);
    f.repository.append('directory_entity',{...h(922),kind:'cluster',name:'Другой кластер',externalKeys:[]},null);
    f.repository.append('directory_link',{...h(923),kind:'dit_cluster',from:ref(920),to:ref(921)},null);
    f.repository.append('directory_link',{...h(924),kind:'cluster_product',from:ref(921),to:ref(101)},null);
  });
  const values = {...f.preferences.get(f.context.installationId),notificationPersonId:fixtureId(17),context:{scopePath:{ditId:fixtureId(920),clusterId:fixtureId(921),productId:fixtureId(101),teamId:null},goalId:f.input.goal.id,time:{kind:'as_of',date:'2026-10-29'},resultMode:'current',snapshotId:null}};
  await f.execute('preferences.set',{values},{baseRevision:null});
  expect(f.preferences.get(f.context.installationId)).toEqual(values);
  await expect(f.execute('preferences.set',{values:{...values,context:{...values.context,scopePath:{...values.context.scopePath,clusterId:fixtureId(922)}}}})).rejects.toMatchObject({code:'PREFERENCES_CONTEXT_INVALID'});
});
it('preserves agreed selection without a chosen snapshot while saving visual choices', async () => {
  const f = fixture();
  f.repository.append('directory_entity',{...makeHeader(930,{publicationAnchorId:fixtureId(2)}),kind:'dit',name:'ДИТ',externalKeys:[]},null);
  const values = {...f.preferences.get(f.context.installationId),visual:{theme:'dark',density:'compact',sidebar:'expanded'},context:{scopePath:{ditId:fixtureId(930),clusterId:null,productId:null,teamId:null},goalId:null,time:{kind:'as_of',date:'2026-10-29'},resultMode:'agreed',snapshotId:null}};
  await f.execute('preferences.set',{values},{baseRevision:null});
  expect(f.preferences.get(f.context.installationId)).toEqual(values);
});
it('restores old appearance archives with expanded sidebar and persists a compact sidebar',async()=>{
 const f=fixture();
 const old={context:null,sorts:{},visual:{theme:'dark',density:'compact'},notificationPersonId:null};
 f.preferences.backup.restore({schemaVersion:1,values:old});
 expect(f.preferences.get(f.context.installationId).visual).toEqual({...old.visual,sidebar:'expanded'});
 const values={...f.preferences.get(f.context.installationId),visual:{...old.visual,sidebar:'compact'}};
 await f.execute('preferences.set',{values},{baseRevision:f.preferences.editToken(f.context.installationId)});
 expect(createPreferencesService({repository:f.repository,installationId:f.context.installationId,clock:f.clock}).get(f.context.installationId).visual.sidebar).toBe('compact');
});
it('persists a real block and direct cluster-team context without a fictitious DIT or product',async()=>{
 const f=fixture(),h=(n:number)=>makeHeader(n,{publicationAnchorId:fixtureId(2)}),ref=(n:number)=>({entityType:'directory_entity',id:fixtureId(n)});
 f.repository.transaction(()=>{
  for(const [n,kind] of [[940,'block'],[941,'tribe'],[942,'cluster'],[943,'team']] as const)f.repository.append('directory_entity',{...h(n),kind,name:kind,externalKeys:[]},null);
  for(const [n,kind,from,to] of [[944,'block_tribe',940,941],[945,'tribe_cluster',941,942],[946,'cluster_team',942,943]] as const)f.repository.append('directory_link',{...h(n),kind,from:ref(from),to:ref(to)},null);
 });
 const values={...f.preferences.get(f.context.installationId),context:{scopePath:{rootKind:'block',ditId:fixtureId(940),clusterId:fixtureId(942),productId:null,teamId:fixtureId(943)},goalId:null,time:{kind:'as_of',date:'2026-10-29'},resultMode:'current',snapshotId:null}};
 await f.execute('preferences.set',{values},{baseRevision:null});expect(f.preferences.get(f.context.installationId).context?.scopePath).toEqual(values.context.scopePath);
});

it('persists allowlisted personal navigation and restores legacy backups with safe defaults',async()=>{
 const f=fixture();const legacy={context:null,sorts:{},visual:{theme:'light',density:'comfortable'}};
 f.preferences.backup.restore({schemaVersion:1,values:legacy});
 expect(f.preferences.get(f.context.installationId).navigation).toEqual({favorites:[],recent:[],startPage:'/overview'});
 const values={...f.preferences.get(f.context.installationId),navigation:{favorites:['/data','/knowledge'],recent:['/reports'],startPage:'/data'}};
 await f.execute('preferences.set',{values},{baseRevision:f.preferences.editToken(f.context.installationId)});
 expect(createPreferencesService({repository:f.repository,installationId:f.context.installationId,clock:f.clock}).get(f.context.installationId).navigation).toEqual(values.navigation);
 for(const route of ['https://example.com','//example.com','/data?file=private','/unknown'])await expect(f.execute('preferences.set',{values:{...values,navigation:{...values.navigation,startPage:route}}},{baseRevision:f.preferences.editToken(f.context.installationId)})).rejects.toMatchObject({statusCode:422});
});
it('saves bounded per-content raw column arrangements with CAS, owner isolation and archive roundtrip',async()=>{
 const f=fixture(),key='a'.repeat(64),values={...f.preferences.get(f.context.installationId),rawTableColumns:{[key]:['col_2','col_1']}};
 const saved=await f.execute('preferences.set',{values},{baseRevision:null});expect(f.preferences.get(f.context.installationId).rawTableColumns).toEqual(values.rawTableColumns);
 await expect(f.execute('preferences.set',{values},{baseRevision:null})).rejects.toMatchObject({statusCode:409});
 for(const invalid of [{[key]:['col_1','col_1']},{[key]:['../../file']},{unknown:['col_1']}])await expect(f.execute('preferences.set',{values:{...values,rawTableColumns:invalid}},{baseRevision:saved.editToken})).rejects.toMatchObject({statusCode:422});
 const backup=f.preferences.backup.exportSnapshot();f.preferences.backup.restore(backup);expect(f.preferences.get(f.context.installationId).rawTableColumns).toEqual(values.rawTableColumns);
 expect(()=>f.preferences.get(f.context.installationId,fixtureId(999))).toThrow();
});

it('persists typed object favorites beside legacy sections and keeps unavailable targets removable after restore',async()=>{
 const f=fixture();
 const favorites=['/data',{kind:'goal',id:f.input.goal.id},{kind:'team',id:fixtureId(104)},{kind:'report',id:fixtureId(99301),revision:2}];
 const values={...f.preferences.get(f.context.installationId),navigation:{favorites,recent:['/reports'],startPage:'/data',showFavorites:false}};
 const saved=await f.execute('preferences.set',{values},{baseRevision:null});
 expect(f.preferences.get(f.context.installationId).navigation).toEqual(values.navigation);
 const backup=f.preferences.backup.exportSnapshot();f.preferences.backup.restore(backup);
 expect(createPreferencesService({repository:f.repository,installationId:f.context.installationId,clock:f.clock}).get(f.context.installationId).navigation).toEqual(values.navigation);
 await expect(f.execute('preferences.set',{values},{baseRevision:saved.editToken})).rejects.toMatchObject({statusCode:409});
 await f.execute('preferences.set',{values:{...values,navigation:{...values.navigation,favorites:['/data']}}},{baseRevision:f.preferences.editToken(f.context.installationId)});
 expect(f.preferences.get(f.context.installationId).navigation?.favorites).toEqual(['/data']);
 expect(f.repository.readPublishedHead({entityType:'core_goal_definition',id:f.input.goal.id})).toEqual(f.input.goal);
});
it.each([
 [{kind:'goal',id:'../../private'}], [{kind:'account',id:fixtureId(99301)}],
 [{kind:'report',id:fixtureId(99301),revision:0}], [{kind:'report',id:fixtureId(99301),revision:Number.MAX_SAFE_INTEGER+1}],
 [{kind:'team',id:fixtureId(104),label:'Untrusted title'}], [{kind:'goal',id:fixtureId(99301),url:'https://example.com'}],
 [{kind:'goal',id:fixtureId(99301)},{kind:'goal',id:fixtureId(99301)}],
 Array.from({length:101},(_,n)=>({kind:'goal',id:fixtureId(99400+n)})),
].map(favorites=>({favorites})))('rejects unsafe, ambiguous, duplicate or unbounded favorites %j',async ({favorites})=>{
 const f=fixture();const values={...f.preferences.get(f.context.installationId),navigation:{favorites,recent:[],startPage:'/overview'}};
 await expect(f.execute('preferences.set',{values},{baseRevision:null})).rejects.toMatchObject({statusCode:422});
 expect(f.preferences.editToken(f.context.installationId)).toBeNull();
});
