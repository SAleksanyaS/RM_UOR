import { afterEach, expect, it } from 'vitest';
import { createPreferencesService } from './workbench-preferences';
import { registerConfigurationCommands } from '../knowledge/workbench-fields';
import { draftFixture, draftCleanups } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';

afterEach(async () => { for (const cleanup of draftCleanups.splice(0)) await cleanup(); });
function fixture() { const f = draftFixture(); const preferences = createPreferencesService({repository:f.repository,installationId:f.context.installationId,clock:f.clock}); registerConfigurationCommands(f.registry,{drafts:f.service,preferences}); return {...f,preferences}; }
it('lets viewers persist only personal preferences with CAS and durable receipts', async () => {
  const f = fixture(); f.context.ownAccess.role = 'viewer';
  const values = {...f.preferences.get(f.context.installationId),visual:{theme:'dark',density:'compact'},sorts:{'goals.list':[{field:'title',direction:'asc'}]}};
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
  const values = {...f.preferences.get(f.context.installationId),visual:{theme:'dark',density:'compact'},context:{scopePath:{ditId:fixtureId(930),clusterId:null,productId:null,teamId:null},goalId:null,time:{kind:'as_of',date:'2026-10-29'},resultMode:'agreed',snapshotId:null}};
  await f.execute('preferences.set',{values},{baseRevision:null});
  expect(f.preferences.get(f.context.installationId)).toEqual(values);
});
