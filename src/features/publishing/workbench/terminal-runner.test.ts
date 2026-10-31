import { expect,it } from 'vitest';
import { createTerminalRunner } from './terminal-runner';
import { bindTerminalCapabilityProfile,type TerminalCapabilityProfile,type TerminalNativePort } from './terminal-capability-profile';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';

function fixture() {
  const profile:TerminalCapabilityProfile={id:'synthetic-only',platform:process.platform,gitVersion:'git version synthetic',transport:'ssh',helperDescription:'synthetic native console',corporateHookFingerprint:'a'.repeat(64),postWaitGateVerified:true,evidenceId:'synthetic-P06'};
  const trace:string[]=[],commits:string[]=[];let revoked=false,waitHook:(()=>void)|null=null,exitCode=0,remote:string|null=null,throwSecret=false;
  const native:TerminalNativePort={async inspect(){return {platform:profile.platform,gitVersion:profile.gitVersion,transport:profile.transport,corporateHookFingerprint:profile.corporateHookFingerprint,runtimeFingerprint:'c'.repeat(64)};},async push(input){
    trace.push('auth_wait');waitHook?.();trace.push('auth_resumed','corporate_hook');if(throwSecret) throw Error('SENTINEL_PASSWORD SENTINEL_COOKIE');
    await input.requestTransfer();trace.push('transfer');if(!input.signal.aborted){commits.push(input.preparedCommit);remote=input.preparedCommit;}return {exitCode,cancelled:input.signal.aborted};
  },async inspectRemote(){return remote;}};
  const binding=bindTerminalCapabilityProfile(profile,{native,evidence:{...profile,runtimeFingerprint:'c'.repeat(64),verifiedAt:'2026-10-30T08:00:00Z',scope:'synthetic'}});
  const signal=new AbortController();let initial=true;const input={cwd:'C:/synthetic-only/private',args:['push','origin','b'.repeat(40)+':refs/heads/uor/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002'],preparedCommit:'b'.repeat(40),signal:signal.signal,async preTransferGate(){if(!initial) trace.push('fresh_gate');initial=false;if(revoked){trace.push('denied');throw new WorkbenchHttpError(403,'ACCESS_DENIED','Revoked');}}};
  return {profile,binding,native,input,trace,commits,signal,wait:(fn:()=>void)=>{waitHook=fn;},revoke:()=>{revoked=true;},wrongRemote:()=>{native.inspectRemote=async()=>null;},secretFailure:()=>{throwSecret=true;}};
}
it('stops a revoked user after native auth and corporate hooks, before transfer',async()=>{
  const f=fixture();f.wait(f.revoke);await expect(createTerminalRunner(f.binding).runGitPush(f.input)).rejects.toMatchObject({code:'ACCESS_DENIED'});
  expect(f.trace).toEqual(['auth_wait','auth_resumed','corporate_hook','fresh_gate','denied']);expect(f.commits).toEqual([]);
});
it('requires verified private binding instead of accepting a copied profile boolean',async()=>{
  const f=fixture();const result=await createTerminalRunner({...f.binding}).runGitPush(f.input);expect(result).toMatchObject({status:'unknown',reason:'TERMINAL_PROFILE_UNVERIFIED'});expect(f.trace).toEqual([]);
  const unverified=createTerminalRunner({...f.profile,postWaitGateVerified:false});expect(await unverified.runGitPush(f.input)).toMatchObject({status:'unknown',reason:'TERMINAL_PROFILE_UNVERIFIED'});
});
it('confirms only the exact remote commit after a gated native exit zero',async()=>{
  const f=fixture();expect(await createTerminalRunner(f.binding).runGitPush(f.input)).toEqual({status:'confirmed',exitCode:0,remoteCommit:'b'.repeat(40)});
  const other=fixture();other.wrongRemote();expect(await createTerminalRunner(other.binding).runGitPush(other.input)).toMatchObject({status:'unknown',reason:'REMOTE_STATE_UNKNOWN'});
});
it('cancels before transfer and never returns native secret text in any result',async()=>{
  const f=fixture();f.wait(()=>f.signal.abort());expect(await createTerminalRunner(f.binding).runGitPush(f.input)).toMatchObject({status:'cancelled'});expect(f.commits).toEqual([]);
  const failure=fixture();failure.secretFailure();const result=await createTerminalRunner(failure.binding).runGitPush(failure.input);expect(result.status).toBe('unknown');expect(JSON.stringify(result)).not.toContain('SENTINEL');
});
it('rejects extra push options or a different commit before opening a terminal',async()=>{
  const f=fixture();for(const args of [['push','--no-verify','origin',f.input.args[2]],['push','origin','c'.repeat(40)+':refs/heads/main']]) expect(await createTerminalRunner(f.binding).runGitPush({...f.input,args})).toMatchObject({status:'unknown',reason:'INVALID_PUSH_INPUT'});
  expect(f.trace).toEqual([]);
});
it('uses a typed native read-only auth state before dispatching a push',async()=>{
  const f=fixture();f.native.authenticationStatus=async()=> 'auth_required';
  expect(await createTerminalRunner(f.binding).runGitPush(f.input)).toEqual({status:'auth_required',provider:'git'});expect(f.trace).toEqual([]);expect(f.commits).toEqual([]);
});
