import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID,randomBytes,timingSafeEqual } from 'node:crypto';
import { createServer,type Socket } from 'node:net';
import { mkdir,writeFile,unlink,rmdir,realpath,lstat } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { assertPhysicalPackagePath,readPhysicalPackageFile,canonicalBytes,hashBytes } from './package-manifest';
import type { TerminalNativePort,TerminalRuntime } from './terminal-capability-profile';

const execute=promisify(execFile);
export interface NativeTerminalLauncher {launch(input:{nodeExecutable:string;helperPath:string;manifestPath:string;cwd:string;env:NodeJS.ProcessEnv}):Promise<number|null>}
type Options={gitExecutable:string;nodeExecutable:string;helperPath:string;privateRoot:string;launcher:NativeTerminalLauncher;timeoutMs?:number};
const fail=(code='TERMINAL_PROFILE_UNVERIFIED'):never=>{throw new WorkbenchHttpError(503,code,code);};
async function physicalExecutable(filename:string) {
  await assertPhysicalPackagePath(path.dirname(filename));const executable=await lstat(filename);
  if(!executable.isFile()||executable.isSymbolicLink()||(await realpath(filename)).toLowerCase()!==path.resolve(filename).toLowerCase()) return fail();
}
const branchPattern=/^uor\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function environment():NodeJS.ProcessEnv {
  const env={...process.env};for(const key of Object.keys(env)) if(['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_CEILING_DIRECTORIES','GIT_DISCOVERY_ACROSS_FILESYSTEM','GIT_SHALLOW_FILE','GIT_REPLACE_REF_BASE','GIT_QUARANTINE_PATH','GIT_PREFIX','GIT_IMPLICIT_WORK_TREE','GIT_CONFIG'].includes(key.toUpperCase())) delete env[key];return env;
}
/** Existing reviewed pre-push chain must invoke native-git-terminal.mjs --gate.
 * This adapter never writes hooks or changes helpers. Local transport is exposed
 * solely for native fixture inspection; it cannot match a production profile. */
export function createNativeTerminalPort(options:Options):TerminalNativePort {
  for(const filename of [options.gitExecutable,options.nodeExecutable,options.helperPath,options.privateRoot]) if(!path.isAbsolute(filename)) return fail();
  const authenticated=new Map<string,string>();
  const checkoutKey=(cwd:string)=>process.platform==='win32'?path.resolve(cwd).toLowerCase():path.resolve(cwd);
  const readGit=async(cwd:string,args:string[],network=false)=>{
    await assertPhysicalPackagePath(cwd);await physicalExecutable(options.gitExecutable);
    try{return String((await execute(options.gitExecutable,args,{cwd,shell:false,windowsHide:true,env:network?{...environment(),GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}:environment(),timeout:30000,maxBuffer:2*1024*1024})).stdout).trim();}
    catch(error){if((error as {code?:number}).code===1&&args[0]==='config') return '';return fail('GIT_PROVIDER_FAILED');}
  };
  const inspect=async(cwd:string):Promise<TerminalRuntime>=>{
    await assertPhysicalPackagePath(cwd);await assertPhysicalPackagePath(options.nodeExecutable);await assertPhysicalPackagePath(options.helperPath);
    const top=await readGit(cwd,['rev-parse','--show-toplevel']);if(path.resolve(top).toLowerCase()!==path.resolve(cwd).toLowerCase()) return fail();
    const remote=await readGit(cwd,['remote','get-url','origin']);
    const pushUrls=(await readGit(cwd,['remote','get-url','--push','--all','origin'])).split(/\r?\n/);
    if(pushUrls.length!==1||pushUrls[0]!==remote){authenticated.delete(checkoutKey(cwd));return fail();}
    let transport:TerminalRuntime['transport'];
    if(path.isAbsolute(remote)) transport='local';else {
      try {const url=new URL(remote);if(url.password||url.search||url.hash||url.protocol==='https:'&&url.username) return fail();transport=url.protocol==='https:'?'https':url.protocol==='ssh:'?'ssh':fail();}
      catch(error){if(error instanceof WorkbenchHttpError) throw error;if(!/^(?:[\w.-]+@)?[\w.-]+:[a-zA-Z0-9_./-]+$/.test(remote)) return fail();transport='ssh';}
    }
    const hooks=path.resolve(cwd,await readGit(cwd,['rev-parse','--git-path','hooks']));const hook=await readPhysicalPackageFile(path.join(hooks,'pre-push'));if(!hook.length) return fail();
    const config=await readGit(cwd,['config','--show-origin','--get-regexp','^(credential\\.|core\\.(askpass|sshcommand|hookspath)|http\\.|url\\.|remote\\.origin\\.)']);
    const env=environment(),relevant=Object.fromEntries(Object.entries(env).filter(([key])=>/^(?:GIT_|GCM_|SSH_|HOME$|USERPROFILE$|PATH$|SYSTEMROOT$)/i.test(key)&&!key.startsWith('GIT_TRACE2_EVENT')).sort(([a],[b])=>a.localeCompare(b)));
    const gitVersion=await readGit(cwd,['--version']);
    const corporateHookFingerprint=hashBytes(hook);
    const runtime={platform:process.platform,gitVersion,transport,corporateHookFingerprint,runtimeFingerprint:hashBytes(canonicalBytes({gitExecutable:await realpath(options.gitExecutable),nodeExecutable:await realpath(options.nodeExecutable),helperHash:hashBytes(await readPhysicalPackageFile(options.helperPath)),corporateHookFingerprint,remote,pushUrls,config,env:relevant}))};
    if(authenticated.get(checkoutKey(cwd))!==runtime.runtimeFingerprint) authenticated.delete(checkoutKey(cwd));
    return runtime;
  };
  const inspectRemote=async(cwd:string,branch:string)=>{
    if(!branchPattern.test(branch)) return fail('INVALID_PUSH_INPUT');const value=await readGit(cwd,['ls-remote','--heads','origin','refs/heads/'+branch],true);if(!value) return null;
    const match=/^([a-f0-9]{40}|[a-f0-9]{64})\s+(.+)$/.exec(value);if(!match||match[2]!=='refs/heads/'+branch) return fail('REMOTE_STATE_UNKNOWN');return match[1];
  };
  const run=async(input:{cwd:string;args:readonly string[];preparedCommit?:string;signal:AbortSignal;requestTransfer?:()=>Promise<void>;onWaiting?:()=>void},mode:'push'|'auth')=>{
    if(input.signal.aborted) return {exitCode:null,cancelled:true};await inspect(input.cwd);
    const match=/^([a-f0-9]{40}|[a-f0-9]{64}):refs\/heads\/(.+)$/.exec(input.args[2]??'');
    if(mode==='push'&&(input.args.length!==3||input.args[0]!=='push'||input.args[1]!=='origin'||!match||!branchPattern.test(match[2])||match[1]!==input.preparedCommit)) return fail('INVALID_PUSH_INPUT');
    const root=path.resolve(options.privateRoot),cwd=path.resolve(input.cwd);if(root===cwd||root.startsWith(cwd+path.sep)||cwd.startsWith(root+path.sep)) return fail();
    await assertPhysicalPackagePath(root,true);await mkdir(root,{recursive:true});await assertPhysicalPackagePath(root);
    const directory=path.join(root,'native-'+randomUUID());await mkdir(directory);const manifestPath=path.join(directory,'manifest.json'),nonce=randomBytes(32).toString('hex');
    const pipeName=process.platform==='win32'?'\\\\.\\pipe\\uor-native-'+randomUUID():path.join(directory,'control.sock');
    if(process.platform!=='win32'&&Buffer.byteLength(pipeName)>100) return fail();
    const sockets=new Set<Socket>();let session:Socket|null=null,gateCalled=false,gateApproved=false,gateError:unknown=null,finished=false,cancelled=false;
    let finish!:(result:{exitCode:number|null;cancelled:boolean})=>void;const completion=new Promise<{exitCode:number|null;cancelled:boolean}>(resolve=>{finish=result=>{if(!finished){finished=true;resolve(result);}};});
    const server=createServer(socket=>{
      if(sockets.size>=8){socket.destroy();return;}socket.setTimeout(5000,()=>socket.destroy());
      sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>undefined);let buffer='',handled=false;
      socket.on('data',chunk=>{
        buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)>4096){socket.destroy();return;}const end=buffer.indexOf('\n');if(end<0)return;
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let frame:{nonce?:string;type?:string;exitCode?:number|null;cancelled?:boolean};
        try{frame=JSON.parse(line);}catch{socket.destroy();return;}
        if(!frame||typeof frame!=='object'||typeof frame.nonce!=='string'||typeof frame.type!=='string'){socket.destroy();return;}
        const token=Buffer.from(frame.nonce);if(token.length!==64||!timingSafeEqual(token,Buffer.from(nonce))){socket.destroy();return;}socket.setTimeout(0);
        if(frame.type==='session'&&!handled&&!session){handled=true;session=socket;if(input.signal.aborted){socket.end('{"ok":false}\n');return;}socket.write('{"ok":true}\n');input.onWaiting?.();return;}
        if(frame.type==='finished'&&socket===session){finish({exitCode:Number.isInteger(frame.exitCode)&&frame.exitCode!>=0&&frame.exitCode!<=255?frame.exitCode!:null,cancelled:cancelled||frame.cancelled===true});return;}
        if(frame.type!=='gate'||handled||gateCalled||mode!=='push'||input.signal.aborted){socket.end('{"allow":false}\n');return;}
        handled=true;gateCalled=true;
        void (async()=>{try{await input.requestTransfer!();if(input.signal.aborted) throw Error('Cancelled');gateApproved=true;socket.end('{"allow":true}\n');}catch(error){gateError=error;socket.end('{"allow":false}\n');}})();
      });
    });
    const abort=()=>{cancelled=true;session?.write('{"type":"cancel"}\n');};
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try {
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(pipeName,()=>resolve());});
      await writeFile(manifestPath,canonicalBytes({schemaVersion:1,mode,cwd,gitExecutable:options.gitExecutable,args:[...input.args],pipeName,nonce}),{flag:'wx',mode:0o600});
      input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted) abort();
      const launched=options.launcher.launch({nodeExecutable:options.nodeExecutable,helperPath:options.helperPath,manifestPath,cwd,env:{...environment(),UOR_NATIVE_MANIFEST:manifestPath,UOR_NATIVE_NODE:options.nodeExecutable,UOR_NATIVE_HELPER:options.helperPath}});
      void launched.then(()=>finish({exitCode:null,cancelled}),()=>finish({exitCode:null,cancelled}));
      timeout=setTimeout(()=>{abort();finish({exitCode:null,cancelled:true});},options.timeoutMs??15*60*1000);
      const result=await completion;
      if(gateError&&!input.signal.aborted) throw gateError;return result;
    } finally {
      if(mode==='push'&&!gateApproved) authenticated.delete(checkoutKey(cwd));
      if(timeout)clearTimeout(timeout);input.signal.removeEventListener('abort',abort);for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));
      await assertPhysicalPackagePath(directory);await unlink(manifestPath).catch(error=>{if(error.code!=='ENOENT') throw error;});
      if(process.platform!=='win32')await unlink(pipeName).catch(error=>{if(error.code!=='ENOENT') throw error;});await rmdir(directory);
    }
  };
  return {inspect,inspectRemote,push:input=>run(input,'push'),async authenticationStatus(cwd){
    const runtime=await inspect(cwd);return authenticated.get(checkoutKey(cwd))===runtime.runtimeFingerprint?'ready':'auth_required';
  },async openAuth(input){
    const key=checkoutKey(input.cwd);authenticated.delete(key);const before=await inspect(input.cwd);
    const result=await run({...input,args:['ls-remote','--heads','origin']},'auth');
    if(result.cancelled||input.signal.aborted) return fail('OPERATION_CANCELLED');
    if(result.exitCode!==0) return fail('GIT_PROVIDER_FAILED');
    const after=await inspect(input.cwd);if(after.runtimeFingerprint!==before.runtimeFingerprint) return fail();
    authenticated.set(key,after.runtimeFingerprint);
  }};
}

/** Detach only the launcher from any inherited hidden console, then allocate a
 * visible Windows console. Fixed native API source; paths are environment values.
 * No execution policy changes, headless fallback or credential pipes. */
export function createWindowsTerminalLauncher():NativeTerminalLauncher {
  return {async launch(input){
    if(process.platform!=='win32') return fail();await physicalExecutable(input.nodeExecutable);await assertPhysicalPackagePath(input.helperPath);
    const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');await physicalExecutable(powershell);
    const command='Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class UorNativeConsole { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AllocConsole(); }\' -ErrorAction Stop; [void][UorNativeConsole]::FreeConsole(); if (-not [UorNativeConsole]::AllocConsole()) { exit 1 }; $arguments = \'"\' + $env:UOR_NATIVE_HELPER + \'" --manifest "\' + $env:UOR_NATIVE_MANIFEST + \'"\'; $native = Start-Process -FilePath $env:UOR_NATIVE_NODE -ArgumentList $arguments -WorkingDirectory $env:UOR_NATIVE_CWD -NoNewWindow -PassThru -Wait -ErrorAction Stop; exit $native.ExitCode';
    return new Promise(resolve=>{const child=spawn(powershell,['-NoProfile','-NonInteractive','-Command',command],{cwd:input.cwd,shell:false,windowsHide:true,stdio:'ignore',env:{...input.env,UOR_NATIVE_NODE:input.nodeExecutable,UOR_NATIVE_HELPER:input.helperPath,UOR_NATIVE_MANIFEST:input.manifestPath,UOR_NATIVE_CWD:input.cwd}});child.once('error',()=>resolve(null));child.once('exit',code=>resolve(code));});
  }};
}
