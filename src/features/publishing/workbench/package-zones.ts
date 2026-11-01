import { scopeRefSchema, uuidSchema, type EntityRef } from '../../../domain/workbench/primitives';
import type { WorkbenchReadIndex } from '../../catalog/workbench-read-index';
/** Explicit published/private links describe viewing scope only; never publication membership. */
export function packageZones(entries:Array<{entityRef:EntityRef;definition:Record<string,unknown>}>,index:WorkbenchReadIndex){
 const goals=new Set<string>(),scopeIds=new Set<string>();
 const scope=(value:unknown)=>{const parsed=scopeRefSchema.safeParse(value);if(parsed.success)scopeIds.add(parsed.data.id);};
 const goal=(value:unknown)=>{const parsed=uuidSchema.safeParse(value);if(parsed.success)goals.add(parsed.data);};
 const inspect=(definition:Record<string,unknown>)=>{
  goal(definition.goalId);if(Array.isArray(definition.goalIds))definition.goalIds.forEach(goal);
  scope(definition.scope);if(Array.isArray(definition.responsibility))for(const entry of definition.responsibility)if(entry&&typeof entry==='object')scope((entry as Record<string,unknown>).scope);
  const target=definition.targetRef;if(target&&typeof target==='object'&&(target as EntityRef).entityType==='core_goal_definition')goal((target as EntityRef).id);
 };
 for(const entry of entries){if(entry.entityRef.entityType==='core_goal_definition')goal(entry.entityRef.id);inspect(entry.definition);
  if(typeof entry.definition.workId==='string'){const privateWork=entries.find(value=>value.entityRef.entityType==='work'&&value.entityRef.id===entry.definition.workId);const work=privateWork?.definition??index.list('work').find(value=>value.id===entry.definition.workId);if(work)inspect(work as unknown as Record<string,unknown>);}
 }
 const privateAssignments=new Set(entries.filter(entry=>entry.entityRef.entityType==='goal_assignment').map(entry=>entry.entityRef.id));
 for(const assignment of index.list('goal_assignment'))if(!privateAssignments.has(assignment.id)&&goals.has(assignment.goalId))scope(assignment.scope);
 for(const entry of entries)if(entry.entityRef.entityType==='goal_assignment'&&goals.has(String(entry.definition.goalId)))scope(entry.definition.scope);
 // A DIT filter includes explicitly linked descendant scopes, not name-based guesses.
 const links=index.list('directory_link');let changed=true;while(changed){changed=false;for(const link of links)if('from' in link&&'to' in link&&scopeIds.has(link.to.id)&&!scopeIds.has(link.from.id)){scopeIds.add(link.from.id);changed=true;}}
 const directory=index.list('directory_entity');return [...scopeIds].sort().map(id=>({id,name:directory.find(entity=>entity.id===id)?.name??null}));
}
