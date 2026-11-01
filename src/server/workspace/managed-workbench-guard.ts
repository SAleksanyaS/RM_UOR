import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchHttpError } from '../workbench/protocol';

/** Presence is enough to reserve the managed namespace, including interrupted
 * initialization and dangling/malformed markers. Never follow pointer contents. */
export async function assertNoManagedWorkbenchLayout(projectRoot:string,code='WORKBENCH_COMBINED_ENTRY_REQUIRED',options:{rejectLease?:boolean}={}):Promise<void> {
 const fail=():never=>{throw new WorkbenchHttpError(409,code,`${code}: эта папка использует единое рабочее место. Запустите основной вход приложения; отдельный ОКО и прежние инструменты здесь недоступны.`);};
 const root=path.resolve(projectRoot);
 for(const relative of ['.runtime','.runtime/workbench']){
  try{const info=await lstat(path.join(root,relative));if(info.isSymbolicLink()||!info.isDirectory())fail();}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 }
 for(const name of ['active.json','subject',...(options.rejectLease?['runtime.lock']:[])]){
  try{await lstat(path.join(root,'.runtime/workbench',name));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  fail();
 }
}
