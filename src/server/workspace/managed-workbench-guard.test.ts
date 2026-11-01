import { afterEach,expect,it } from 'vitest';
import { mkdtemp,mkdir,readdir,rm,symlink,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createContext } from './context';
import { assertLegacyCliAllowed } from '../../../scripts/local-history';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('refuses legacy context on a managed subject namespace before opening app.db or recovery files',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'uor-managed-guard-'));roots.push(root);await mkdir(path.join(root,'.runtime/workbench/subject'),{recursive:true});
 await expect(createContext({projectRoot:root,startupCheck:false})).rejects.toMatchObject({code:'WORKBENCH_COMBINED_ENTRY_REQUIRED'});expect(await readdir(path.join(root,'.runtime'))).toEqual(['workbench']);
});
it('refuses a dangling managed pointer without following its target',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'uor-managed-guard-'));roots.push(root);await mkdir(path.join(root,'.runtime/workbench'),{recursive:true});await symlink(path.join(root,'missing-pointer-target'),path.join(root,'.runtime/workbench/active.json'),process.platform==='win32'?'junction':'dir');
 await expect(createContext({projectRoot:root,startupCheck:false})).rejects.toMatchObject({code:'WORKBENCH_COMBINED_ENTRY_REQUIRED'});expect(await readdir(path.join(root,'.runtime/workbench'))).toEqual(['active.json']);
});
it('refuses legacy context and import before managed initialization finishes publishing its pointer',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'uor-managed-guard-'));roots.push(root);await mkdir(path.join(root,'.runtime/workbench'),{recursive:true});await writeFile(path.join(root,'.runtime/workbench/runtime.lock'),'owned process initialization in progress');
 await expect(createContext({projectRoot:root,startupCheck:false})).rejects.toMatchObject({code:'WORKBENCH_COMBINED_ENTRY_REQUIRED'});await expect(assertLegacyCliAllowed(root)).rejects.toThrow('WORKBENCH_MIGRATION_REQUIRED');expect(await readdir(path.join(root,'.runtime'))).toEqual(['workbench']);
});
