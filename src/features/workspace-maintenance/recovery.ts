import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,readdir,rename,unlink,lstat} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import type {LocalDatabase} from '../../server/storage/database';
import {physicalArtifactPath} from './safe-path';
import {sha256} from './zip';
const namespace='workspace-maintenance-commits',folder='workspace-maintenance-journals';
const relative=z.string().min(1).max(2000),hash=z.string().regex(/^[a-f0-9]{64}$/);
const actionSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('move'),from:relative,to:relative}).strict(),
 z.object({kind:z.literal('replace'),path:relative,previousPath:relative.nullable(),previousSha256:hash.nullable(),nextSha256:hash}).strict(),
]);
const journalSchema=z.object({version:z.literal(1),id:z.string().uuid(),kind:z.enum(['quarantine','quarantine_restore','bundle_restore']),at:z.iso.datetime({offset:true}),database:z.object({path:relative,sha256:hash}).strict().optional(),actions:z.array(actionSchema).max(4096)}).strict();
export type MaintenanceJournal=z.infer<typeof journalSchema>;
const uuid='[a-f0-9-]{36}',quarantined=new RegExp(`^workspace-quarantine/${uuid}/${uuid}$`),movable=/^(?:source-artifacts|evidence|exports|workspace-staging)\/.+$|^git-workspaces\/[a-f0-9-]{36}$/;
async function optional(root:string,relative:string){try{return await readFile(await physicalArtifactPath(root,relative));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function durableWrite(root:string,relative:string,bytes:Buffer){const target=await physicalArtifactPath(root,relative);await mkdir(path.dirname(target),{recursive:true});const temporary=await physicalArtifactPath(root,`${relative}.new-${randomUUID()}`),handle=await open(temporary,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}try{await rename(temporary,target);}finally{await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}}
function validatePaths(journal:MaintenanceJournal){
 for(const action of journal.actions){if(action.kind==='move'){if(!((movable.test(action.from)&&quarantined.test(action.to))||(quarantined.test(action.from)&&movable.test(action.to))))throw new Error('Журнал содержит недопустимый перенос');}
 else{if(!/^(?:imports\/(?:catalog|snapshots)\.json|(?:evidence|source-artifacts)\/portable\/[a-f0-9]{64})$/.test(action.path))throw new Error('Журнал содержит недопустимую замену');if(action.previousPath!==null&&(!action.previousPath.startsWith(`${folder}/${journal.id}/files/`)||!/^\d+$/.test(action.previousPath.split('/').at(-1)!)))throw new Error('Копия файла находится вне журнала');if((action.previousPath===null)!==(action.previousSha256===null))throw new Error('Не указан хеш предыдущего файла');}}
 if(journal.database&&!new RegExp(`^backups/${uuid}/database\\.sqlite$`).test(journal.database.path))throw new Error('Копия базы находится вне служебного каталога');
}
export async function beginMaintenanceJournal(root:string,kind:MaintenanceJournal['kind'],databasePath?:string){const journal:MaintenanceJournal={version:1,id:randomUUID(),kind,at:new Date().toISOString(),actions:[]};if(databasePath)journal.database={path:databasePath,sha256:sha256((await optional(root,databasePath))??Buffer.alloc(0))};await saveMaintenanceJournal(root,journal);return journal;}
export async function saveMaintenanceJournal(root:string,journal:MaintenanceJournal){journalSchema.parse(journal);validatePaths(journal);await durableWrite(root,`${folder}/${journal.id}/journal.json`,Buffer.from(JSON.stringify(journal)));}
export async function journalMove(root:string,journal:MaintenanceJournal,from:string,to:string){journal.actions.push({kind:'move',from,to});await saveMaintenanceJournal(root,journal);}
export async function journalReplace(root:string,journal:MaintenanceJournal,relative:string,next:Buffer){const previous=await optional(root,relative),previousPath=previous?`${folder}/${journal.id}/files/${journal.actions.length}`:null;if(previous&&previousPath)await durableWrite(root,previousPath,previous);journal.actions.push({kind:'replace',path:relative,previousPath,previousSha256:previous?sha256(previous):null,nextSha256:sha256(next)});await saveMaintenanceJournal(root,journal);}
async function cleanJournal(root:string,db:LocalDatabase,journal:MaintenanceJournal){for(const action of journal.actions)if(action.kind==='replace'&&action.previousPath)await unlink(await physicalArtifactPath(root,action.previousPath)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});await unlink(await physicalArtifactPath(root,`${folder}/${journal.id}/journal.json`)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});db.remove(namespace,journal.id);}
export function commitMaintenanceJournal(db:LocalDatabase,journal:MaintenanceJournal){db.set(namespace,journal.id,{at:new Date().toISOString(),kind:journal.kind});}
export async function finishMaintenanceJournal(root:string,db:LocalDatabase,journal:MaintenanceJournal){await cleanJournal(root,db,journal);}
export async function rollbackMaintenanceJournal(root:string,db:LocalDatabase,journal:MaintenanceJournal){
 validatePaths(journal);
 // Repeated recovery is safe: every action recognizes both its before and after state.
 for(const action of [...journal.actions].reverse()){
  if(action.kind==='move'){const from=await physicalArtifactPath(root,action.from),to=await physicalArtifactPath(root,action.to);let source=false,target=false;try{await lstat(from);source=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}try{await lstat(to);target=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(source&&target)throw new Error('Оба пути аварийного переноса заняты; автоматическая перезапись запрещена');if(!source&&!target)throw new Error('Оба пути аварийного переноса отсутствуют');if(target){await mkdir(path.dirname(from),{recursive:true});await rename(to,from);}}
  else{const current=await optional(root,action.path),currentHash=current?sha256(current):null;if(currentHash===action.previousSha256)continue;if(currentHash!==null&&currentHash!==action.nextSha256)throw new Error('Изменённый после сбоя файл защищён от перезаписи');if(action.previousPath){const previous=await optional(root,action.previousPath);if(!previous||sha256(previous)!==action.previousSha256)throw new Error('Повреждена предыдущая копия файла в журнале');await durableWrite(root,action.path,previous);}else if(current)await unlink(await physicalArtifactPath(root,action.path));}
 }
 if(journal.database){const bytes=await optional(root,journal.database.path);if(!bytes||sha256(bytes)!==journal.database.sha256)throw new Error('Повреждена база аварийного отката');db.replaceFrom(await physicalArtifactPath(root,journal.database.path));}
 await cleanJournal(root,db,journal);
}
/** Must run before startup imports and before accepting requests. Failure leaves every recovery copy intact. */
export async function recoverWorkspaceMaintenance(root:string,db:LocalDatabase){let directories:string[]=[];try{directories=await readdir(await physicalArtifactPath(root,folder));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}for(const id of directories.filter(name=>z.string().uuid().safeParse(name).success)){const bytes=await optional(root,`${folder}/${id}/journal.json`);if(!bytes)continue;try{if(bytes.length>2000000)throw new Error('Слишком большой журнал');const journal=journalSchema.parse(JSON.parse(bytes.toString('utf8')));if(journal.id!==id)throw new Error('ID журнала не совпадает с папкой');validatePaths(journal);if(db.get(namespace,id))await cleanJournal(root,db,journal);else await rollbackMaintenanceJournal(root,db,journal);}catch(error){throw new Error(`Не завершён безопасный откат обслуживания ${id}. Рабочие данные сохранены; проверьте ${folder}/${id}/journal.json перед запуском.`,{cause:error});}}}
