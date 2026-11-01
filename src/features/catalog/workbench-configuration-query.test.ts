import { afterEach, expect, it } from 'vitest';
import { createWorkbenchApiHarness } from '../../app/workbench/testing/api-harness';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';
import type { CustomFieldDef } from '../../domain/workbench/entities';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
it('projects_only_published_configuration_and_exact_versioned_values_for_viewer',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'scope-split'});closes.push(h.close);await h.client.session();
 const anchor=h.repository.readPublishedHead<any>({entityType:h.refs.goal.entityType,id:h.refs.goal.id})!.publicationAnchorId;
 const field:CustomFieldDef={...makeHeader(900,{publicationAnchorId:anchor}),name:'Затраты',entityTypes:['core_goal_definition'],valueType:'decimal',enumValues:null};h.repository.append('custom_field_def',field,null);
 h.repository.append('custom_field_def',{...field,revision:2,valueType:'date'},1);
 h.repository.append('custom_field_def',{...field,id:fixtureId(901),publicationAnchorId:null},null);
 h.repository.append('custom_field_value',{...makeHeader(902,{publicationAnchorId:anchor}),objectRef:{entityType:'core_goal_definition',id:h.refs.goal.id},fieldRef:{entityType:'custom_field_def',id:field.id,revision:1},value:'12.5'},null);
 const session=await h.client.session();const request={context:session.data.defaultContext!,filter:{kind:'field'},sort:[],page:{limit:1,cursor:null}};
 const options=await h.client.query<any>('configuration.options',request);expect(options.data.items).toHaveLength(1);expect(options.data.items[0]).toMatchObject({ref:{id:field.id,revision:2},definition:{valueType:'date'}});expect(options.data.page.hasMore).toBe(false);
 const values=await h.client.query<any>('customFields.values',{...request,filter:{objectRef:{entityType:'core_goal_definition',id:h.refs.goal.id}}});expect(values.data.items[0]).toMatchObject({definition:{revision:1,valueType:'decimal'},value:{value:'12.5',fieldRef:{revision:1}}});
 await expect(h.client.query('customFields.values',{...request,filter:{objectRef:{entityType:'core_goal_definition',id:fixtureId(999)}}})).rejects.toMatchObject({status:404});
 await expect(h.client.query('configuration.options',{...request,filter:{kind:'field',sql:'select'}})).rejects.toMatchObject({status:422});
});


it('does_not_expose_unpublished_historical_field_definition_and_stales_cursors',async()=>{
 const h=await createWorkbenchApiHarness({role:'viewer',scenario:'scope-split'});closes.push(h.close);const session=await h.client.session(),anchor=h.repository.readPublishedHead<any>({entityType:h.refs.goal.entityType,id:h.refs.goal.id})!.publicationAnchorId;
 const header=makeHeader(950,{publicationAnchorId:anchor}),definition:CustomFieldDef={...header,name:'A',entityTypes:['core_goal_definition'],valueType:'text',enumValues:null};h.repository.append('custom_field_def',definition,null);h.repository.append('custom_field_def',{...definition,id:fixtureId(951),name:'B'},null);
 const request={context:session.data.defaultContext!,filter:{kind:'field'},sort:[],page:{limit:1,cursor:null}};const revision=h.repository.getStateRevision();const first=await h.client.query<any>('configuration.options',request);expect(first.data.page.hasMore).toBe(true);expect(h.repository.getStateRevision()).toBe(revision);h.repository.append('custom_field_def',{...definition,id:fixtureId(952),name:'C'},null);await expect(h.client.query('configuration.options',{...request,page:{limit:1,cursor:first.data.page.nextCursor}})).rejects.toMatchObject({status:409});
 h.repository.append('custom_field_def',{...definition,id:fixtureId(953),publicationAnchorId:null,name:'Приватное имя'},null);h.repository.append('custom_field_def',{...definition,id:fixtureId(953),revision:2,name:'Общее имя'},1);h.repository.append('custom_field_value',{...makeHeader(954,{publicationAnchorId:anchor}),objectRef:{entityType:'core_goal_definition',id:h.refs.goal.id},fieldRef:{entityType:'custom_field_def',id:fixtureId(953),revision:1},value:'private'},null);
 await expect(h.client.query('customFields.values',{...request,filter:{objectRef:{entityType:'core_goal_definition',id:h.refs.goal.id}}})).rejects.toMatchObject({status:404});
});
