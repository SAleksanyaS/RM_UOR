import { z } from 'zod';
import { headerSchema,uuidSchema } from '../../../domain/workbench/primitives';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { createWorkspaceOwnership } from '../../../server/storage/workbench-ownership';
import type { WorkbenchRepository } from '../../../server/storage/workbench-repository';
import { createCoreWorkspaceArchiveCodec } from './core-codec';
import type { ProductionArchiveOwner } from './production-archive-contracts';
import type { WorkspaceArchiveRecord } from './contracts';
const denied=():never=>{throw new WorkbenchHttpError(403,'ACCESS_DENIED','Unknown or foreign private core ownership');};
const invalid=():never=>{throw new WorkbenchHttpError(422,'INVALID_ARCHIVE','Invalid core ownership closure');};
const accessSchema=z.strictObject({recordKey:z.string().regex(/^[a-z][a-z0-9_]*\/[a-f0-9-]{36}\/[1-9][0-9]*$/),personId:uuidSchema.nullable(),installationId:uuidSchema.optional()}).refine(v=>v.personId?!v.installationId:!!v.installationId);
export function createSubjectCoreArchiveOwner():ProductionArchiveOwner{
 const base=createCoreWorkspaceArchiveCodec();
 const validate=(r:WorkspaceArchiveRecord)=>{if(r.schemaId==='core.ownership'){if(r.moduleId!=='core'||r.schemaVersion!==1||accessSchema.parse(r.value).recordKey!==r.key)invalid();}else base.validate(r);};
 const closure=(records:readonly WorkspaceArchiveRecord[])=>{
  records.forEach(validate);
  const confirmed=new Set(records.filter(r=>r.schemaId==='core.publication_anchor'&&(r.value as any).publicationState==='confirmed').map(r=>(r.value as any).id));
  const accesses=new Map<string,z.infer<typeof accessSchema>>();
  for(const r of records.filter(r=>r.schemaId==='core.ownership')){if(accesses.has(r.key))invalid();accesses.set(r.key,accessSchema.parse(r.value));}
  const required=new Set<string>();
  for(const r of records){if(r.schemaId==='core.ownership')continue;if(r.schemaId==='core.publication_anchor'){if(confirmed.has((r.value as any).id))continue;required.add(r.key);if(!accesses.has(r.key))denied();continue;}const h=headerSchema.passthrough().parse(r.value);if(h.publicationAnchorId&&confirmed.has(h.publicationAnchorId))continue;required.add(r.key);if(!accesses.has(r.key))denied();}
  if([...accesses.keys()].some(k=>!required.has(k)))invalid();return accesses;
 };
 return{...base,validate,exportRecords(repository){const records=base.exportRecords(repository),anchors=new Set(records.filter(r=>r.schemaId==='core.publication_anchor'&&(r.value as any).publicationState==='confirmed').map(r=>(r.value as any).id)),ledger=createWorkspaceOwnership(repository);for(const r of [...records]){if(r.schemaId==='core.publication_anchor'&&anchors.has((r.value as any).id))continue;if(r.schemaId!=='core.publication_anchor'){const h=headerSchema.passthrough().parse(r.value);if(h.publicationAnchorId&&anchors.has(h.publicationAnchorId))continue;}const b=ledger.read('core',r.key)??denied();records.push({moduleId:'core',schemaId:'core.ownership',schemaVersion:1,key:r.key,value:{recordKey:r.key,personId:b.personId,...(b.personId?{}:{installationId:b.installationId})}});}closure(records);return records.sort((a,b)=>a.schemaId.localeCompare(b.schemaId)||a.key.localeCompare(b.key));},restoreRecords(repository,records,context){const accesses=closure(records);if(accesses.size&&!context)invalid();for(const v of accesses.values())if(v.personId?v.personId!==context!.personId:context!.personId!==null||v.installationId!==context!.installationId)denied();repository.transaction(()=>{base.restoreRecords(repository,records.filter(r=>r.schemaId!=='core.ownership'));const ledger=createWorkspaceOwnership(repository);for(const [key,v]of accesses)ledger.bind({moduleId:'core',key,personId:v.personId,installationId:context!.installationId,provenance:'restore'});});},fileReferences:()=>[],files:async()=>[],authorize(records,personId,installationId){for(const v of closure(records).values())if(v.personId?v.personId!==personId:personId!==null||v.installationId!==installationId)denied();},validateArchive(archive){closure(archive.records.filter(r=>r.moduleId==='core'));}};
}
