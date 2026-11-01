import { z } from 'zod';
import { utcInstantSchema } from '../../../domain/workbench/primitives';
import { canonicalBytes,hashBytes } from './package-manifest';
import type { PreTransferGate } from './terminal-runner';

export const terminalCapabilityProfileSchema=z.strictObject({id:z.string().min(1),platform:z.string().min(1),gitVersion:z.string().min(1),transport:z.enum(['https','ssh']),helperDescription:z.string().min(1),corporateHookFingerprint:z.string().regex(/^[a-f0-9]{64}$/),postWaitGateVerified:z.boolean(),evidenceId:z.string().min(1)});
export type TerminalCapabilityProfile=z.infer<typeof terminalCapabilityProfileSchema>;
export type TerminalRuntime={platform:string;gitVersion:string;transport:'https'|'ssh'|'local';corporateHookFingerprint:string;runtimeFingerprint:string};
export interface TerminalNativePort {
  authenticationStatus?(cwd:string):Promise<'ready'|'auth_required'>;
  inspect(cwd:string):Promise<TerminalRuntime>;
  push(input:{cwd:string;args:readonly string[];preparedCommit:string;signal:AbortSignal;requestTransfer:PreTransferGate;onWaiting?:()=>void}):Promise<{exitCode:number|null;cancelled:boolean}>;
  inspectRemote(cwd:string,branch:string):Promise<string|null>;
  openAuth?(input:{cwd:string;signal:AbortSignal}):Promise<void>;
}
const evidenceSchema=terminalCapabilityProfileSchema.extend({runtimeFingerprint:z.string().regex(/^[a-f0-9]{64}$/),verifiedAt:utcInstantSchema,scope:z.enum(['synthetic','bank'])});
export type TerminalCapabilityEvidence=z.infer<typeof evidenceSchema>;
type Binding={profile:TerminalCapabilityProfile;evidence:TerminalCapabilityEvidence;native:TerminalNativePort};
const bindings=new WeakMap<object,Binding>();
/** Trusted server composition only, after P-06 evidence review. Never bind browser JSON. */
export function bindTerminalCapabilityProfile(unparsed:TerminalCapabilityProfile,input:{evidence:TerminalCapabilityEvidence;native:TerminalNativePort}):TerminalCapabilityProfile {
  const profile=terminalCapabilityProfileSchema.parse(unparsed),evidence=evidenceSchema.parse(input.evidence);
  const {runtimeFingerprint:_runtime,verifiedAt:_at,scope:_scope,...observed}=evidence;
  if(!profile.postWaitGateVerified||!evidence.postWaitGateVerified||hashBytes(canonicalBytes(profile))!==hashBytes(canonicalBytes(observed))) throw Error('TERMINAL_PROFILE_UNVERIFIED');
  const bound=Object.freeze(profile);bindings.set(bound,{profile:bound,evidence:Object.freeze(evidence),native:input.native});return bound;
}
/** Internal lookup; an object reconstructed from serialized metadata has no authority. */
export const terminalCapabilityBinding=(profile:TerminalCapabilityProfile)=>bindings.get(profile)??null;
export function matchesTerminalRuntime(binding:Binding,runtime:TerminalRuntime):boolean {
  return runtime.platform===binding.profile.platform&&runtime.gitVersion===binding.profile.gitVersion&&runtime.transport===binding.profile.transport&&runtime.corporateHookFingerprint===binding.profile.corporateHookFingerprint&&runtime.runtimeFingerprint===binding.evidence.runtimeFingerprint;
}
