import { z } from 'zod';
import { uuidSchema } from '../../domain/workbench/primitives';
import { WorkbenchHttpError } from '../workbench/protocol';
import type { WorkbenchRepository } from './workbench-repository';
import type { Header } from '../../domain/workbench/primitives';

export const ownershipBindingSchema=z.strictObject({moduleId:z.string().regex(/^[a-z][a-z0-9_]*$/),key:z.string().min(1).max(1000),installationId:uuidSchema,personId:uuidSchema.nullable(),provenance:z.enum(['created','local-preview-adoption','restore'])});
export type WorkspaceOwnershipBinding=z.infer<typeof ownershipBindingSchema>;
export function createWorkspaceOwnership(repository:WorkbenchRepository){
 const sql=repository.sqlForModule('ownership');
 sql.execMigration('v1','CREATE TABLE IF NOT EXISTS wb_ownership_bindings(module_id TEXT NOT NULL,object_key TEXT NOT NULL,installation_id TEXT NOT NULL,person_id TEXT,provenance TEXT NOT NULL,PRIMARY KEY(module_id,object_key))');
 const read=(moduleId:string,key:string):Omit<WorkspaceOwnershipBinding,'moduleId'|'key'>|null=>{
  const row=sql.get<{installation_id:string;person_id:string|null;provenance:WorkspaceOwnershipBinding['provenance']}>('SELECT installation_id,person_id,provenance FROM wb_ownership_bindings WHERE module_id=? AND object_key=?',[moduleId,key]);
  return row?{installationId:row.installation_id,personId:row.person_id,provenance:row.provenance}:null;
 };
 return {read,bind(input:WorkspaceOwnershipBinding):void {
  const value=ownershipBindingSchema.parse(input);repository.transaction(()=>{
   const old=read(value.moduleId,value.key);
   if(old&&(old.personId!==value.personId||(old.personId===null&&old.installationId!==value.installationId)||(old.installationId!==value.installationId&&value.provenance!=='restore')))throw new WorkbenchHttpError(403,'ACCESS_DENIED','Subject ownership cannot be reassigned');
   if(old){if(old.installationId!==value.installationId)sql.run('UPDATE wb_ownership_bindings SET installation_id=?,provenance=? WHERE module_id=? AND object_key=?',[value.installationId,value.provenance,value.moduleId,value.key]);return;}
   sql.run('INSERT INTO wb_ownership_bindings VALUES(?,?,?,?,?)',[value.moduleId,value.key,value.installationId,value.personId,value.provenance]);
  });
 }};
}
/** Historical actors are immutable. Technical access follows the trusted restored binding. */
export function isOwnCoreVersion(repository:WorkbenchRepository,entityType:string,value:Header,owner:{installationId:string;personId:string|null}):boolean {
 let binding:{installation_id:string;person_id:string|null}|null=null;
 try {binding=repository.sqlForModule('ownership').get('SELECT installation_id,person_id FROM wb_ownership_bindings WHERE module_id=? AND object_key=?',['core',`${entityType}/${value.id}/${value.revision}`]);}
 catch(error){if(!(error instanceof Error&&/no such table: wb_ownership_bindings/.test(error.message)))throw error;}
 return binding?binding.installation_id===owner.installationId&&binding.person_id===owner.personId:value.actor.installationId===owner.installationId&&value.actor.profilePersonId===owner.personId;
}
