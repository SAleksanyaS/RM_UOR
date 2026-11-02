import {it,expect} from 'vitest';
import { filterKnowledgeTree,mergeKnowledgePage } from './workbench-view';
import {loadMaturityMaterials} from '../maturity/workbench-materials';
import {materialDirectoryEntries} from './workbench-service';
import type {KnowledgeItem} from './workbench-contracts';
it('filters the complete tree by code and type while retaining only required ancestors',()=>{
 const b=loadMaturityMaterials(),entries=materialDirectoryEntries(b);
 const items=entries.filter(e=>e.entityType==='directory_entity').map(e=>({value:{id:e.id,...e.definition},parentId:entries.find(link=>link.entityType==='directory_link'&&link.definition.kind!=='leader'&&(link.definition.to as any)?.id===e.id)?.definition.from?((entries.find(link=>link.entityType==='directory_link'&&link.definition.kind!=='leader'&&(link.definition.to as any)?.id===e.id)!.definition.from as any).id):null})) as KnowledgeItem[];
 const tree=filterKnowledgeTree(items,{text:b.teams[0].code,kind:'team'});
 expect(tree.map(i=>i.value.id)).toContain(b.teams[0].id);expect(tree).toHaveLength(4);expect(tree.filter(i=>i.value.kind==='team')).toHaveLength(1);
 expect(filterKnowledgeTree(items,{text:'absent',kind:'all'})).toEqual([]);
 const first=items.slice(0,3),next=[items[2],items[3]];expect(mergeKnowledgePage(first,next)).toHaveLength(4);
});
