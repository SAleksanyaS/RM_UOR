import { expect,it,afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMaintenanceUiFixture } from './maintenance-ui-fixture';
import type { JobAccepted } from '../../../server/workbench/protocol';
const cleanups:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
it('reconciles the committed restore to the exact persisted job before startup recovery without replacing again',async()=>{
 const h=await createMaintenanceUiFixture();cleanups.push(h.close);await h.client.session();
 const backup=await h.maintenance.createBackup(h.context,{label:null,includeOriginals:true}),upload=await h.upload(await h.archiveBytes(backup.backupId)),preview=await h.maintenance.previewRestore(h.context,{fileHandle:upload.fileHandle});
 const commandId=randomUUID(),accepted=(await h.client.command<JobAccepted>({commandId,name:'backup.restore.apply',baseRevision:null,payload:{restoreToken:preview.restoreToken,confirmReplacement:true}})).data as JobAccepted;await h.commands.idle();const result=h.jobs.get(accepted.jobId,h.context.installationId)!.result;expect(result).toHaveProperty('rescue');
 const journalName=(await readdir(path.join(h.deps.artifactRoot,'journals')))[0],journal=JSON.parse(await readFile(path.join(h.deps.artifactRoot,'journals',journalName),'utf8'));expect(journal).toMatchObject({version:2,commandId,installationId:h.context.installationId,personId:null});
 // Simulate process death after durable restore commit, before local receipt/job completion.
 h.deps.repository.transaction(()=>{h.deps.repository.sqlForModule('commands').run('UPDATE wb_commands_intents SET receipt_json=NULL,phase=? WHERE command_id=?',['accepted',commandId]);const job=h.jobs.get(accepted.jobId,h.context.installationId)!;h.deps.repository.sqlForModule('jobs').run('UPDATE wb_jobs_heads SET snapshot_json=? WHERE job_id=?',[JSON.stringify({...job,status:'running',stage:'running',result:null,finishedAt:null}),accepted.jobId]);});
 h.put('Данные, принятые после commitpoint');await h.restart();expect(h.jobs.get(accepted.jobId,h.context.installationId)).toMatchObject({commandId,status:'succeeded',result});expect(h.activations()).toBe(1);expect(h.get()).toEqual([{value:'Данные, принятые после commitpoint'}]);
});
it('returns the exact accepted job receipt to an installation-only reader after a lost response',async()=>{
 const h=await createMaintenanceUiFixture();cleanups.push(h.close);await h.client.session();const commandId=randomUUID();const accepted=(await h.client.command<JobAccepted>({commandId,name:'backup.create',baseRevision:null,payload:{label:null,includeOriginals:true}})).data as JobAccepted;await h.commands.idle();
 const response=await h.client.reconcileCommand(commandId);expect(response.data).toMatchObject({commandId,status:'completed',job:{jobId:accepted.jobId}});
});
it('warns about intentionally omitted originals before replacement',async()=>{
 const h=await createMaintenanceUiFixture();cleanups.push(h.close);await h.addFile('original',Buffer.from('synthetic-original'));const backup=await h.maintenance.createBackup(h.context,{label:null,includeOriginals:false}),upload=await h.upload(await h.archiveBytes(backup.backupId));const preview=await h.maintenance.previewRestore(h.context,{fileHandle:upload.fileHandle});expect(preview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({code:'ORIGINALS_OMITTED'})]));
});
it.each(['commandId','installationId','personId','token'] as const)('fails closed on a forged committed journal %s binding',async field=>{
 const h=await createMaintenanceUiFixture();cleanups.push(h.close);await h.client.session();const backup=await h.maintenance.createBackup(h.context,{label:null,includeOriginals:true}),upload=await h.upload(await h.archiveBytes(backup.backupId)),preview=await h.maintenance.previewRestore(h.context,{fileHandle:upload.fileHandle});
 await h.client.command({commandId:randomUUID(),name:'backup.restore.apply',baseRevision:null,payload:{restoreToken:preview.restoreToken,confirmReplacement:true}});await h.commands.idle();const name=(await readdir(path.join(h.deps.artifactRoot,'journals')))[0],file=path.join(h.deps.artifactRoot,'journals',name),journal=JSON.parse(await readFile(file,'utf8'));journal[field]=field==='token'?'f'.repeat(64):randomUUID();await writeFile(file,JSON.stringify(journal));
 await expect(h.restart()).rejects.toMatchObject({code:'RECOVERY_REQUIRED'});expect(h.frozen()).toBe(true);expect(h.activations()).toBe(1);
});
it('does not expose installation receipts to a newly identified different person',async()=>{
 const h=await createMaintenanceUiFixture();cleanups.push(h.close);await h.client.session();const commandId=randomUUID();await h.client.command({commandId,name:'backup.create',baseRevision:null,payload:{label:null,includeOriginals:true}});await h.commands.idle();h.context.ownAccess.personId=randomUUID();await expect(h.client.reconcileCommand(commandId)).rejects.toMatchObject({status:404});
});
