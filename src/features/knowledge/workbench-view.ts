import type { KnowledgeItem } from './workbench-contracts';

/** Search matches objects; their ancestors remain visible so the result keeps its real context. */
export function filterKnowledgeTree(items:KnowledgeItem[],filter:{text:string;kind:string}):KnowledgeItem[]{
 const needle=filter.text.trim().toLocaleLowerCase('ru');
 const byId=new Map(items.map(item=>[item.value.id,item]));
 const included=new Set<string>();
 for(const item of items){
  const matchesKind=filter.kind==='all'||item.value.kind===filter.kind;
  const matchesText=!needle||(item.value.name+' '+(item.value.sourceMetadata?.externalCode??'')).toLocaleLowerCase('ru').includes(needle);
  if(!matchesKind||!matchesText)continue;
  let current:KnowledgeItem|undefined=item;
  while(current&&!included.has(current.value.id)){
   included.add(current.value.id);
   current=current.parentId?byId.get(current.parentId):undefined;
  }
 }
 return items.filter(item=>included.has(item.value.id));
}

export function mergeKnowledgePage(previous:KnowledgeItem[],next:KnowledgeItem[]):KnowledgeItem[]{
 const byId=new Map(previous.map(item=>[item.value.id,item]));
 for(const item of next)byId.set(item.value.id,item);
 return [...byId.values()];
}
