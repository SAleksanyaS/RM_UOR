import { it,expect } from 'vitest';
import { makeHeader } from '../../../tests/fixtures/workbench/factories';
import { directoryEntitySchema,directoryLinkSchema } from '../../domain/workbench/schemas';
import { validateDirectoryChanges } from './workbench-directory';
it('accepts source block/tribe cluster hierarchy without inventing cluster leaders',()=>{
 const block={...makeHeader(901),kind:'block',name:'Технологии',externalKeys:[]};const tribe={...makeHeader(902),kind:'tribe',name:'Operations',externalKeys:[]};const cluster={...makeHeader(903),kind:'cluster',name:'Source cluster',externalKeys:[]};
 expect(directoryEntitySchema.safeParse(block).success).toBe(true);
 const links=[{...makeHeader(910),kind:'block_tribe',from:{entityType:'directory_entity',id:block.id},to:{entityType:'directory_entity',id:tribe.id}},{...makeHeader(911),kind:'tribe_cluster',from:{entityType:'directory_entity',id:tribe.id},to:{entityType:'directory_entity',id:cluster.id}}];
 expect(links.every(l=>directoryLinkSchema.safeParse(l).success)).toBe(true);
 expect(validateDirectoryChanges({entities:[block,tribe,cluster] as never,links:links as never})).toEqual([]);
});
it('maps exact team codes explicitly and never guesses from product or name',async()=>{
 const { makeNumericFixture,makeEntityGraph,fixtureId }=await import('../../../tests/fixtures/workbench/factories');
 const { enrichSourceRows }=await import('./workbench-directory');const f=makeNumericFixture(),g=makeEntityGraph(f);
 const mapping=g.entries.find(e=>e.entityType==='source_field_mapping')!.value as any;
 const capture=structuredClone(f.captures[0]);mapping.productKeyField=null;mapping.teamKeyField='Code';mapping.fixedScope=null;capture.mappingRef={entityType:'source_field_mapping',id:mapping.id,revision:mapping.revision};
 capture.rawRows=[{rowKey:'t',cells:{Code:{kind:'text',original:'00HH0060'}}}];capture.canonicalRows=[{rowKey:'t',dimensions:{},numbers:{},unitCode:'percent',businessTime:{kind:'as_of',date:'2026-10-30'}}];
 const block={...makeHeader(921),kind:'block',name:'Block',externalKeys:[]},tribe={...makeHeader(922),kind:'tribe',name:'Tribe',externalKeys:[]},cluster={...makeHeader(923),kind:'cluster',name:'Cluster',externalKeys:[]},team={...makeHeader(924),kind:'team',name:'Actual team',externalKeys:[{sourceId:capture.sourceId,key:'00HH0060'}]};
 const links=[['block_tribe',block,tribe],['tribe_cluster',tribe,cluster],['cluster_team',cluster,team]].map(([kind,from,to],i)=>({...makeHeader(930+i),kind,from:{entityType:'directory_entity',id:(from as any).id},to:{entityType:'directory_entity',id:(to as any).id}}));
 const input={capture,mapping,directoryEntities:[block,tribe,cluster,team],directoryLinks:links} as any;
 expect(enrichSourceRows(input).rows[0].scope).toEqual({kind:'team',id:team.id});
 capture.rawRows[0].cells.Code.original='00HH006';expect(enrichSourceRows(input).issues.map(i=>i.code)).toContain('UNMAPPED_TEAM');
});
