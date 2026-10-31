import {lstatSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ActionError} from '../identity/role-service';

/** Inspect only application-owned locations; never follow an active pointer or a user path. */
export function legacyMaintenanceUnavailable(runtimeRoot:string):boolean{
 try{
  if(lstatSync(runtimeRoot).isSymbolicLink())return true;
  // Presence also covers incomplete/unknown workbench layouts and active.json during activation.
  for(const relative of ['workbench','workbench.sqlite']){
   try{lstatSync(path.join(runtimeRoot,relative));return true;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return true;}
  }
  const filename=path.join(runtimeRoot,'app.db');
  try{const info=lstatSync(filename);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;return true;}
  const database=new DatabaseSync(filename,{readOnly:true});
  try{
   if(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wb_meta'").get())return true;
   const columns=database.prepare('PRAGMA table_info(records)').all();
   return columns.length!==3||!['namespace','id','value'].every((name,index)=>columns[index].name===name&&columns[index].type==='TEXT'&&columns[index].notnull===1&&columns[index].pk===(index<2?index+1:0));
  }finally{database.close();}
 }catch{return true;}
}

export function assertLegacyMaintenanceAllowed(runtimeRoot:string):void{
 if(legacyMaintenanceUnavailable(runtimeRoot))throw new ActionError('Прежнее обслуживание недоступно для новой или неизвестной схемы рабочего места. Используйте типизированное восстановление с сохранением истории.',410);
}

export function assertLegacyRecoveryAllowed(runtimeRoot:string):void{
 if(legacyMaintenanceUnavailable(runtimeRoot))throw Object.assign(new Error('RECOVERY_REQUIRED: незавершённый журнал прежнего обслуживания требует проверки владельца схемы. Рабочие данные и копии восстановления сохранены.'),{code:'RECOVERY_REQUIRED'});
}
