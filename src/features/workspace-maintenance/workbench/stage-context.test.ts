import { expect, it } from 'vitest';
import { fixture } from './test-fixture';

it('passes only this validated archive and trusted staged root to the owner restore', async () => {
  const f=await fixture('portable');
  try {
    const codec=f.deps.modules.get('personal')!; const original=codec.restoreRecords;
    let received:unknown;
    Object.assign(f.deps.workspace!, {restoreContext:(stagedRoot:string,archive:{files:ReadonlyMap<string,Uint8Array>})=>({installationId:f.context.installationId,personId:null,stagedRoot,files:archive.files,subjectPath:()=>{throw Error('unused');}})});
    codec.restoreRecords=(repository,records,context)=>{received=context;original(repository,records);};
    const backup=await f.service.createBackup(f.context,{label:null,includeOriginals:true});
    const upload=await f.upload(await f.archiveBytes(backup.backupId));
    const preview=await f.service.previewRestore(f.context,{fileHandle:upload.fileHandle});
    await f.service.applyRestore(f.context,{restoreToken:preview.restoreToken,confirmReplacement:true});
    expect(received).toMatchObject({installationId:f.context.installationId,personId:null});
    expect((received as {stagedRoot:string}).stagedRoot).toContain('restore-');
    expect((received as {files:Map<string,Uint8Array>}).files.size).toBe(0);
  } finally {await f.dispose();}
});
