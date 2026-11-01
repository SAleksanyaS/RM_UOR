import type { GitOid } from '../../../domain/workbench/publication';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
import { gitOidSchema } from './contracts';
import { terminalCapabilityBinding,matchesTerminalRuntime,type TerminalCapabilityProfile } from './terminal-capability-profile';
export type TerminalRunResult={status:'confirmed';exitCode:0;remoteCommit:GitOid}|{status:'cancelled';exitCode:number|null}|{status:'unknown';exitCode:number|null;reason:string}|{status:'auth_required';provider:'git'|'bitbucket'};
export type PreTransferGate=()=>Promise<void>;
export interface TerminalRunner {
  runGitPush(input:{cwd:string;args:readonly string[];preparedCommit:GitOid;preTransferGate:PreTransferGate;signal:AbortSignal;onWaiting?:()=>void}):Promise<TerminalRunResult>;
  openAuth?(input:{cwd:string;signal:AbortSignal}):Promise<void>;
}
const unknown=(reason:string,exitCode:number|null=null):TerminalRunResult=>({status:'unknown',exitCode,reason});
const safeGateError=(error:unknown):never=>{
  const code=(error as {code?:unknown})?.code;
  const safe=typeof code==='string'&&['ACCESS_DENIED','ACCESS_RECHECK_REQUIRED','LOCAL_PREVIEW_ONLY','PREVIEW_STALE','INTEGRITY_MISMATCH','COMMAND_FORBIDDEN','COMMAND_CONTEXT_MISMATCH','OPERATION_CANCELLED'].includes(code)?code:'PRE_TRANSFER_GATE_REJECTED';
  throw new WorkbenchHttpError(safe==='ACCESS_DENIED'?403:409,safe,safe);
};
export function createTerminalRunner(profile:TerminalCapabilityProfile):TerminalRunner {
  const binding=terminalCapabilityBinding(profile);
  return {
    ...(binding?.native.openAuth?{openAuth:async(input:{cwd:string;signal:AbortSignal})=>{if(!matchesTerminalRuntime(binding,await binding.native.inspect(input.cwd))) throw new WorkbenchHttpError(503,'TERMINAL_PROFILE_UNVERIFIED','TERMINAL_PROFILE_UNVERIFIED');await binding.native.openAuth!(input);}}:{}),
    async runGitPush(input) {
      if(!binding) return unknown('TERMINAL_PROFILE_UNVERIFIED');
      const args=[...input.args],match=/^([a-f0-9]{40}|[a-f0-9]{64}):refs\/heads\/(uor\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(args[2]??'');
      if(args.length!==3||args[0]!=='push'||args[1]!=='origin'||!match||match[1]!==input.preparedCommit||!gitOidSchema.safeParse(input.preparedCommit).success) return unknown('INVALID_PUSH_INPUT');
      if(input.signal.aborted) return {status:'cancelled',exitCode:null};
      let approved=false,requested=false,gateFailure:unknown=null;
      const cancelled=()=>{if(input.signal.aborted) throw Error('NATIVE_CANCELLED');};
      try {
        if(!matchesTerminalRuntime(binding,await binding.native.inspect(input.cwd))) return unknown('TERMINAL_PROFILE_UNVERIFIED');cancelled();
        if(binding.native.authenticationStatus&&await binding.native.authenticationStatus(input.cwd)==='auth_required') return {status:'auth_required',provider:'git'};cancelled();
        try {await input.preTransferGate();}catch(error){return safeGateError(error);}cancelled();
        const result=await binding.native.push({...input,args,requestTransfer:async()=>{
          try {
            if(requested) throw new WorkbenchHttpError(409,'PRE_TRANSFER_GATE_REJECTED','Repeated transfer request');requested=true;cancelled();
            if(!matchesTerminalRuntime(binding,await binding.native.inspect(input.cwd))) throw new WorkbenchHttpError(409,'PRE_TRANSFER_GATE_REJECTED','Changed runtime');cancelled();
            await input.preTransferGate();cancelled();approved=true;
          }catch(error){gateFailure=error;throw error;}
        }});
        if(gateFailure&&!input.signal.aborted) return safeGateError(gateFailure);
        let remote:string|null;try {remote=await binding.native.inspectRemote(input.cwd,match[2]);}catch{return input.signal.aborted&&!approved?{status:'cancelled',exitCode:result.exitCode}:unknown('REMOTE_STATE_UNKNOWN',result.exitCode);}
        if(input.signal.aborted||result.cancelled) return !approved&&remote!==input.preparedCommit?{status:'cancelled',exitCode:result.exitCode}:unknown('CANCELLED_AFTER_POSSIBLE_TRANSFER',result.exitCode);
        if(!approved) return unknown('TRANSFER_GATE_NOT_OBSERVED',result.exitCode);
        return result.exitCode===0&&remote===input.preparedCommit?{status:'confirmed',exitCode:0,remoteCommit:input.preparedCommit}:unknown('REMOTE_STATE_UNKNOWN',result.exitCode);
      } catch(error) {
        if(gateFailure&&!input.signal.aborted) return safeGateError(gateFailure);
        if(error instanceof WorkbenchHttpError) throw error;
        if(input.signal.aborted&&!approved) return {status:'cancelled',exitCode:null};
        return unknown('NATIVE_TERMINAL_FAILED');
      }
    },
  };
}
