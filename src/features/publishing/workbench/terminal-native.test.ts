import path from 'node:path';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile,writeFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach,expect,it,vi } from 'vitest';
import { gitStagingFixture,stagingCleanups } from '../../../../tests/fixtures/workbench/git-staging';
import { createGitStagingProvider } from './git-staging-provider';
import { createNativeTerminalPort,createWindowsTerminalLauncher,type NativeTerminalLauncher } from './terminal-native';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';

afterEach(async()=>{vi.unstubAllEnvs();for(const cleanup of stagingCleanups.splice(0).reverse()) await cleanup();});
const launcher:NativeTerminalLauncher=process.platform==='win32'?createWindowsTerminalLauncher():{async launch(input){return new Promise(resolve=>{const child=spawn(input.nodeExecutable,[input.helperPath,'--manifest',input.manifestPath],{cwd:input.cwd,shell:false,windowsHide:true,env:input.env,stdio:'ignore'});child.once('error',()=>resolve(null));child.once('exit',code=>resolve(code));});}};
async function fixture(nativeLauncher=launcher) {
  const f=await gitStagingFixture(),provider=createGitStagingProvider(f.options),prepared=await provider.prepare(f.makePackage());
  const hook=path.resolve(f.projectRoot,await f.git(f.projectRoot,['rev-parse','--git-path','hooks']),'pre-push'),trace=path.join(f.root,'native-order.txt');
  const quoted="'"+trace.replaceAll('\\','/').replaceAll("'","'\\''")+"'";
  await writeFile(hook,'#!/bin/sh\nprintf "corporate_hook\\n" >> '+quoted+'\n"$UOR_NATIVE_NODE" "$UOR_NATIVE_HELPER" --gate\n',{mode:0o755});
  const original=await readFile(hook,'utf8');
  const native=createNativeTerminalPort({gitExecutable:f.gitExecutable,nodeExecutable:process.execPath,helperPath:path.resolve('scripts/native-git-terminal.mjs'),privateRoot:path.join(f.root,'native-private'),launcher:nativeLauncher});
  return {...f,provider,prepared,native,hook,original,trace,input:{cwd:prepared.checkout,args:['push','origin',prepared.commit+':refs/heads/'+prepared.branch],preparedCommit:prepared.commit,signal:new AbortController().signal}};
}
it('runs real native Git through the existing corporate hook then the IPC gate, without modifying that hook',async()=>{
  const f=await fixture();const result=await f.native.push({...f.input,async requestTransfer(){await writeFile(f.trace,(await readFile(f.trace,'utf8'))+'fresh_gate\n');}});
  expect(result.exitCode).toBe(0);expect(await f.native.inspectRemote(f.prepared.checkout,f.prepared.branch)).toBe(f.prepared.commit);
  expect(await readFile(f.trace,'utf8')).toBe('corporate_hook\nfresh_gate\n');expect(await readFile(f.hook,'utf8')).toBe(f.original);
  expect((await f.native.inspect(f.prepared.checkout)).transport).toBe('local');
},45000);
it('an actual native pre-push refusal transfers nothing and keeps the prepared commit',async()=>{
  const f=await fixture();await expect(f.native.push({...f.input,async requestTransfer(){throw new WorkbenchHttpError(403,'ACCESS_DENIED','Synthetic revocation');}})).rejects.toMatchObject({code:'ACCESS_DENIED'});
  expect(await f.provider.inspectRemote(f.prepared.branch)).toBeNull();expect(await f.git(f.prepared.checkout,['rev-parse','HEAD'])).toBe(f.prepared.commit);expect(await readFile(f.hook,'utf8')).toBe(f.original);
},45000);
it('the native gate helper fails closed promptly when its parent disconnects without approval',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'uor-native-helper-'));
  stagingCleanups.push(async()=>{const resolved=path.resolve(root);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(resolved).startsWith('uor-native-helper-'))throw Error('Unsafe fixture cleanup');await rm(resolved,{recursive:true,force:true});});
  const pipe='\\\\.\\pipe\\uor-native-test-'+randomUUID(),server=createServer(socket=>{socket.on('data',()=>socket.end());});await new Promise<void>(resolve=>server.listen(pipe,resolve));
  const manifest=path.join(root,'manifest.json');await writeFile(manifest,JSON.stringify({schemaVersion:1,mode:'push',cwd:root,gitExecutable:process.execPath,args:['push','origin','b'.repeat(40)+':refs/heads/uor/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002'],pipeName:pipe,nonce:'a'.repeat(64)}));
  let exit:unknown;try{await promisify(execFile)(process.execPath,[path.resolve('scripts/native-git-terminal.mjs'),'--gate'],{env:{...process.env,UOR_NATIVE_MANIFEST:manifest},windowsHide:true,timeout:3000});exit=0;}catch(error){exit=(error as {code?:unknown}).code;}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  expect(exit).toBe(1);
});
it('preserves native helper settings and existing hooks without suppressing interactive auth',async()=>{
  vi.stubEnv('GIT_ASKPASS','synthetic-corporate-askpass');vi.stubEnv('GCM_INTERACTIVE','Auto');vi.stubEnv('GIT_TERMINAL_PROMPT','1');
  let captured:Parameters<NativeTerminalLauncher['launch']>[0]|undefined;
  const f=await fixture({async launch(input){captured=input;return launcher.launch(input);}});
  expect((await f.native.push({...f.input,async requestTransfer(){}})).exitCode).toBe(0);
  expect(captured?.env).toMatchObject({GIT_ASKPASS:'synthetic-corporate-askpass',GCM_INTERACTIVE:'Auto',GIT_TERMINAL_PROMPT:'1'});
  expect(f.input.args).not.toContain('--no-verify');expect(await readFile(f.hook,'utf8')).toBe(f.original);
},45000);
it('cancels an actual native session before its transfer gate and keeps the prepared branch',async()=>{
  const f=await fixture(),control=new AbortController();let gates=0;
  const result=await f.native.push({...f.input,signal:control.signal,onWaiting:()=>control.abort(),async requestTransfer(){gates++;}});
  expect(result.cancelled).toBe(true);expect(gates).toBe(0);expect(await f.provider.inspectRemote(f.prepared.branch)).toBeNull();
  expect(await f.git(f.prepared.checkout,['rev-parse','HEAD'])).toBe(f.prepared.commit);expect(await readFile(f.hook,'utf8')).toBe(f.original);
},45000);
it.skipIf(process.platform!=='win32')('uses the literal Windows native console launcher with the pinned Node executable',async()=>{
  const f=await fixture(createWindowsTerminalLauncher());
  const result=await f.native.push({...f.input,async requestTransfer(){}});
  expect(result.exitCode).toBe(0);expect(await f.provider.inspectRemote(f.prepared.branch)).toBe(f.prepared.commit);expect(await readFile(f.hook,'utf8')).toBe(f.original);
},45000);
it.skipIf(process.platform!=='win32')('attaches native Git output to the actual console instead of null app stdio',async()=>{
  const f=await fixture(createWindowsTerminalLauncher()),probe=path.join(f.root,'native-console.json');
  const quoted="'"+probe.replaceAll('\\','/').replaceAll("'","'\\''")+"'";
  const script='const fs=require("node:fs"),tty=require("node:tty");fs.writeFileSync(process.argv[1],JSON.stringify({stdout:tty.isatty(1),stderr:tty.isatty(2)}));';
  const hook=f.original+'\n';await writeFile(f.hook,hook.replace('"$UOR_NATIVE_NODE" "$UOR_NATIVE_HELPER" --gate','"$UOR_NATIVE_NODE" -e \''+script+'\' '+quoted+'\n"$UOR_NATIVE_NODE" "$UOR_NATIVE_HELPER" --gate'));
  const result=await f.native.push({...f.input,async requestTransfer(){}});
  expect(result.exitCode).toBe(0);expect(JSON.parse(await readFile(probe,'utf8'))).toEqual({stdout:true,stderr:true});
},45000);
it('requires a separate read-only native auth check and never treats it as a push',async()=>{
  const f=await fixture();expect(typeof f.native.authenticationStatus).toBe('function');
  expect(await f.native.authenticationStatus!(f.prepared.checkout)).toBe('auth_required');
  await f.native.openAuth!({cwd:f.prepared.checkout,signal:new AbortController().signal});
  expect(await f.native.authenticationStatus!(f.prepared.checkout)).toBe('ready');expect(await f.provider.inspectRemote(f.prepared.branch)).toBeNull();
  await writeFile(f.hook,f.original+'# changed after native login\n');expect(await f.native.authenticationStatus!(f.prepared.checkout)).toBe('auth_required');
},45000);
it('refuses different, rewritten or multiple push destinations before any transfer',async()=>{
  const f=await fixture(),other=path.join(f.root,'other-remote.git');
  await f.git(f.prepared.checkout,['config','remote.origin.pushurl',other]);
  await expect(f.native.inspect(f.prepared.checkout)).rejects.toMatchObject({code:'TERMINAL_PROFILE_UNVERIFIED'});
  await f.git(f.prepared.checkout,['config','--unset-all','remote.origin.pushurl']);
  const rewrite='url.'+other.replaceAll('\\','/')+'.pushInsteadOf';await f.git(f.prepared.checkout,['config',rewrite,f.remoteUrl]);
  await expect(f.native.inspect(f.prepared.checkout)).rejects.toMatchObject({code:'TERMINAL_PROFILE_UNVERIFIED'});
  await f.git(f.prepared.checkout,['config','--unset-all',rewrite]);await f.git(f.prepared.checkout,['config','--add','remote.origin.pushurl',f.remoteUrl]);await f.git(f.prepared.checkout,['config','--add','remote.origin.pushurl',f.remoteUrl]);
  await expect(f.native.inspect(f.prepared.checkout)).rejects.toMatchObject({code:'TERMINAL_PROFILE_UNVERIFIED'});expect(await f.provider.inspectRemote(f.prepared.branch)).toBeNull();
},45000);
it('invalidates native auth readiness after a push exits without the transfer gate',async()=>{
  const f=await fixture();await writeFile(f.hook,'#!/bin/sh\nexit 1\n');
  await f.native.openAuth!({cwd:f.prepared.checkout,signal:new AbortController().signal});
  expect(await f.native.authenticationStatus!(f.prepared.checkout)).toBe('ready');
  const result=await f.native.push({...f.input,async requestTransfer(){throw Error('Unexpected transfer');}});
  expect(result.exitCode).not.toBe(0);expect(await f.native.authenticationStatus!(f.prepared.checkout)).toBe('auth_required');
  expect(await f.provider.inspectRemote(f.prepared.branch)).toBeNull();
},45000);
it('does not classify a nonzero native auth command as credential failure or mark it ready',async()=>{
  const f=await fixture({async launch(){return 1;}});
  await expect(f.native.openAuth!({cwd:f.prepared.checkout,signal:new AbortController().signal})).rejects.toMatchObject({code:'GIT_PROVIDER_FAILED'});
  expect(await f.native.authenticationStatus!(f.prepared.checkout)).toBe('auth_required');expect(await f.provider.inspectRemote(f.prepared.branch)).toBeNull();
},45000);
