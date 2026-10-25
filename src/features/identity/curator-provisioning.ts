import {randomBytes,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {z} from 'zod';
import {safeArtifactPath} from '../../server/workspace/paths';
import type {CuratorRecord} from './role-service';
const profilesSchema=z.array(z.object({name:z.string().trim().min(2).max(200).refine(value=>!/[\x00-\x1f\x7f]/.test(value)),code:z.string().min(6).max(256)}).strict()).min(1).max(100);
const registrySchema=z.array(z.object({id:z.string().min(1).max(300),name:z.string().min(1).max(200),salt:z.string().min(1).max(200),hash:z.string().regex(/^[a-f0-9]{128}$/)}).strict());
const normalized=(name:string)=>name.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru');
/** Local provisioning only. The file contains salted hashes; input codes are never persisted or returned. */
export async function provisionLocalCurators(runtimeRoot:string,raw:unknown){
 const input=profilesSchema.parse(raw);if(new Set(input.map(record=>normalized(record.name))).size!==input.length||new Set(input.map(record=>record.code)).size!==input.length)throw new Error('В списке повторяется имя или пароль куратора');
 const directory=await safeArtifactPath(runtimeRoot,'local-config');await mkdir(directory,{recursive:true});const file=await safeArtifactPath(runtimeRoot,'local-config/curators.json'),lock=await safeArtifactPath(runtimeRoot,'local-config/curators.lock');
 try{await writeFile(lock,'provisioning',{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Другой процесс изменяет учётные записи. Повторите после его завершения');throw error;}
 let temporary:string|undefined;
 try{
  let existing:CuratorRecord[]=[];try{existing=registrySchema.parse(JSON.parse(await readFile(file,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(new Set(existing.map(record=>record.id)).size!==existing.length||new Set(existing.map(record=>normalized(record.name))).size!==existing.length)throw new Error('В локальном реестре повторяются профили. Исправьте реестр до добавления новых записей');
  const records=[...existing];let added=0,updated=0;
  for(const profile of input){
   const previous=records.find(record=>normalized(record.name)===normalized(profile.name));
   for(const other of records.filter(record=>record.id!==previous?.id))if(timingSafeEqual(scryptSync(profile.code,other.salt,64),Buffer.from(other.hash,'hex')))throw new Error('Этот пароль уже используется другим куратором');
   const salt=randomBytes(24).toString('hex'),record:CuratorRecord={id:previous?.id??randomUUID(),name:profile.name.trim().replace(/\s+/g,' '),salt,hash:scryptSync(profile.code,salt,64).toString('hex')};
   const index=records.findIndex(item=>item.id===record.id);if(index<0){records.push(record);added++;}else{records[index]=record;updated++;}
  }
  temporary=await safeArtifactPath(runtimeRoot,`local-config/curators.${randomUUID()}.tmp`);await writeFile(temporary,JSON.stringify(records,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,file);temporary=undefined;
  return{added,updated,accounts:records.map(({id,name})=>({id,name}))};
 }finally{if(temporary)await unlink(temporary).catch(()=>{});await unlink(lock).catch(()=>{});}
}
