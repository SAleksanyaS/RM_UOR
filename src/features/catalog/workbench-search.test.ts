import { afterEach, expect, it } from 'vitest';
import { draftFixture, draftCleanups } from '../../../tests/fixtures/workbench/drafts';
import { fixtureId, makeHeader } from '../../../tests/fixtures/workbench/factories';
import { createWorkbenchReadIndex } from './workbench-read-index';
import { searchWorkbench } from './workbench-search';
import type { QueryRequest } from '../../server/workbench/protocol';
import type { DirectoryEntity, DirectoryLink } from '../../domain/workbench/entities';

afterEach(async()=>{for(const cleanup of draftCleanups.splice(0)) await cleanup();});
function fixture() {
  const f=draftFixture(); const entities:DirectoryEntity[]=[]; const links:DirectoryLink[]=[];
  const header=(n:number)=>makeHeader(n,{actor:f.input.goal.actor,publicationAnchorId:f.input.goal.publicationAnchorId});
  for(const [n,kind] of [[281001,'dit'],[281002,'cluster'],[281003,'product'],[281004,'cluster'],[281005,'product']] as const) entities.push({...header(n),kind,name:`Область ${n}`,externalKeys:[]});
  for(const [n,kind,from,to] of [[281011,'dit_cluster',281001,281002],[281012,'cluster_product',281002,281003],[281013,'dit_cluster',281001,281004],[281014,'cluster_product',281004,281005]] as const) links.push({...header(n),kind,from:{entityType:'directory_entity',id:fixtureId(from)},to:{entityType:'directory_entity',id:fixtureId(to)}});
  const goals=[0,1,2].map(n=>({...f.input.goal,id:fixtureId(281100+n),title:`Архив ${n}`,lifecycle:'archived' as const,archiveReason:'Закрыта'}));
  f.repository.transaction(()=>{
    entities.forEach(v=>f.repository.append('directory_entity',v,null)); links.forEach(v=>f.repository.append('directory_link',v,null));
    goals.forEach((v,n)=>{
      const source={...header(281200+n),goalId:v.id,kind:'manual_status' as const,mappingRef:null,publicLocator:null};
      f.repository.append('source_definition',source,null); f.repository.append('core_goal_definition',{...v,mode:'manual_status',sourceId:source.id},null);
      f.repository.append('method_version',{...header(281300+n),mode:'manual_status'},null);
      f.repository.append('goal_assignment',{...f.input.assignment,id:fixtureId(281400+n),goalId:v.id,scope:{kind:'product',id:fixtureId(281005)},expectedPopulation:null,methodBinding:{kind:'standalone',methodRef:{entityType:'method_version',id:fixtureId(281300+n),revision:1}}},null);
    });
  });
  const index=createWorkbenchReadIndex(f.repository);
  const request:QueryRequest={context:{scopePath:{ditId:fixtureId(281001),clusterId:fixtureId(281002),productId:fixtureId(281003),teamId:null},goalId:null,time:f.input.context.businessTime,resultMode:'current',snapshotId:null},filter:{text:'аРхИв'},sort:[],page:{limit:2,cursor:null}};
  return {...f,index,request};
}
it('searches archived goals globally and returns their target context with stable pages',async()=>{
  const f=fixture(); const before=f.repository.getStateRevision();
  const page=await searchWorkbench(f.request,f.context,f.index);
  expect(page.items.map(v=>v.name)).toEqual(['Архив 0','Архив 1']);
  expect(page.items[0].context.scopePath.clusterId).toBe(fixtureId(281004));
  expect(page.items[0].route).toContain('/goals/');
  const second=await searchWorkbench({...f.request,page:{limit:2,cursor:page.page.nextCursor}},f.context,f.index);
  expect(second.items.map(v=>v.name)).toEqual(['Архив 2']); expect(second.page.hasMore).toBe(false);
  expect(f.repository.getStateRevision()).toBe(before);
});
it('binds cursors to revision, filters, scope and personal visibility',async()=>{
  const f=fixture(); const first=await searchWorkbench(f.request,f.context,f.index);
  const request={...f.request,page:{limit:2,cursor:first.page.nextCursor}};
  for(const [changed,context] of [
    [{...request,filter:{text:'Архив 1'}},f.context],
    [{...request,context:{...request.context,goalId:f.input.goal.id}},f.context],
    [request,{...f.context,installationId:fixtureId(289999)}],
  ] as const) await expect(searchWorkbench(changed,context,f.index)).rejects.toMatchObject({statusCode:409,code:'CURSOR_STALE'});
  f.repository.append('core_goal_definition',{...f.input.goal,revision:2,title:'Изменённое имя'},1);
  await expect(searchWorkbench(request,f.context,f.index)).rejects.toMatchObject({code:'CURSOR_STALE'});
});
